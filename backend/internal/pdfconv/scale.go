package pdfconv

import (
	"math"
	"sort"
)

// This file is the reason importing a PDF is more useful than importing
// a screenshot of one.
//
// A PDF page is a physical sheet of paper with exact dimensions. A CAD
// drawing plotted onto that sheet was reduced by a known plot scale. So
// once you know the sheet size (which the PDF tells you) and the plot
// scale (which the user tells you, or which we infer from the sheet),
// the real-world size of the drawing follows arithmetically:
//
//	real-world metres = sheet millimetres / 1000 × scale denominator
//
// That converts "drag a rectangle until it looks about right" into
// "place this at its true 87.8 m width", which is the difference between
// a decorative backdrop and a survey-accurate base layer.
//
// What a PDF does NOT carry is georeferencing — no CRS, no origin, no
// north. So position and rotation on the map remain a human judgement
// call and the existing drag-to-place interaction stays necessary. Scale
// is the part we can make exact, and scale is the part users get wrong.

const mmPerInch = 25.4

func pointsToMM(pts float64) float64 { return pts / pointsPerInch * mmPerInch }

// Sheet is a standard drawing sheet size.
type Sheet struct {
	Name     string
	WidthMM  float64
	HeightMM float64
}

// standardSheets covers the three series that architectural and
// engineering drawings are actually plotted on. Dimensions are the
// portrait orientation; MatchSheet compares both ways round.
var standardSheets = []Sheet{
	// ISO A series — the international default.
	{"A4", 210, 297},
	{"A3", 297, 420},
	{"A2", 420, 594},
	{"A1", 594, 841},
	{"A0", 841, 1189},
	// ANSI — US engineering.
	{"ANSI A", 215.9, 279.4},
	{"ANSI B", 279.4, 431.8},
	{"ANSI C", 431.8, 558.8},
	{"ANSI D", 558.8, 863.6},
	{"ANSI E", 863.6, 1117.6},
	// ARCH — US architectural. These are the ones floor plans usually
	// arrive on, and ARCH D (24×36") is overwhelmingly the most common.
	{"ARCH A", 228.6, 304.8},
	{"ARCH B", 304.8, 457.2},
	{"ARCH C", 457.2, 609.6},
	{"ARCH D", 609.6, 914.4},
	{"ARCH E", 914.4, 1219.2},
	{"ARCH E1", 762, 1066.8},
}

// sheetToleranceMM absorbs the rounding that survives a CAD plot →
// PDF round trip. Real exports miss nominal sizes by a fraction of a
// millimetre; 2 mm is loose enough to catch those without letting
// adjacent sizes collide (the closest standard pair differs by ~13 mm).
const sheetToleranceMM = 2.0

// MatchSheet names the standard sheet a page corresponds to, in either
// orientation, or returns "" when it matches none.
func MatchSheet(widthMM, heightMM float64) string {
	for _, s := range standardSheets {
		if closeEnough(widthMM, s.WidthMM) && closeEnough(heightMM, s.HeightMM) {
			return s.Name
		}
		if closeEnough(widthMM, s.HeightMM) && closeEnough(heightMM, s.WidthMM) {
			return s.Name
		}
	}
	return ""
}

func closeEnough(a, b float64) bool { return math.Abs(a-b) <= sheetToleranceMM }

// PlotScale is a named drawing scale expressed as a 1:N ratio.
//
// Imperial scales are stored as their exact ratio equivalent — 1/8" =
// 1'-0" really is 1:96, because one foot is 12 inches and 12 ÷ (1/8) =
// 96. Storing the ratio rather than the label means all the arithmetic
// downstream is unit-agnostic.
type PlotScale struct {
	// Label is what the drawing's title block would call it.
	Label string `json:"label"`
	// Denominator is N in 1:N.
	Denominator float64 `json:"denominator"`
	// System is "metric" or "imperial", used to order suggestions
	// sensibly for the user's region.
	System string `json:"system"`
}

// CommonScales are the plot scales that building drawings actually use.
// Anything outside this list is possible, which is why the API accepts
// an arbitrary denominator too — this list only drives the picker.
var CommonScales = []PlotScale{
	// Metric architectural.
	{"1:20", 20, "metric"},
	{"1:50", 50, "metric"},
	{"1:100", 100, "metric"},
	{"1:200", 200, "metric"},
	{"1:250", 250, "metric"},
	{"1:500", 500, "metric"},
	{"1:1000", 1000, "metric"},
	// Imperial architectural, as ratios.
	{`1/2" = 1'-0"`, 24, "imperial"},
	{`1/4" = 1'-0"`, 48, "imperial"},
	{`1/8" = 1'-0"`, 96, "imperial"},
	{`3/16" = 1'-0"`, 64, "imperial"},
	{`3/32" = 1'-0"`, 128, "imperial"},
	{`1/16" = 1'-0"`, 192, "imperial"},
	// Imperial civil / site.
	{`1" = 20'`, 240, "imperial"},
	{`1" = 30'`, 360, "imperial"},
	{`1" = 40'`, 480, "imperial"},
	{`1" = 50'`, 600, "imperial"},
	{`1" = 100'`, 1200, "imperial"},
}

// RealWorldSize converts a page's sheet dimensions into the real-world
// extent the drawing represents at the given plot scale.
//
// This is the whole point of the sheet metadata: it produces the width
// in metres to place the raster at, so the user never has to eyeball it.
func RealWorldSize(page PageInfo, denominator float64) (widthM, heightM float64) {
	if denominator <= 0 {
		return 0, 0
	}
	return page.WidthMM / 1000 * denominator, page.HeightMM / 1000 * denominator
}

// ScaleForRealWorldWidth is the inverse: given a page and a known
// real-world width (a user measuring a facade they already have survey
// data for), report the plot scale that must have produced it.
//
// This backs the two-point calibration workflow — the user says "this
// wall is 45 m", and we solve for the scale instead of asking them to
// read it off a title block they may not have.
func ScaleForRealWorldWidth(page PageInfo, widthM float64) float64 {
	if page.WidthMM <= 0 || widthM <= 0 {
		return 0
	}
	return widthM * 1000 / page.WidthMM
}

// SuggestScales ranks plot scales for a page by how plausible the
// resulting building footprint is.
//
// The heuristic: a floor plan drawn on a standard sheet almost always
// depicts something between 5 m and 500 m across. Scales that imply a
// 2 m building or a 4 km one are arithmetically valid but never right,
// so they sort last. Within the plausible band we prefer the mid-range,
// because both extremes are comparatively rare.
func SuggestScales(page PageInfo, system string) []PlotScale {
	type scored struct {
		scale PlotScale
		rank  float64
	}
	const idealWidthM = 60.0

	ranked := make([]scored, 0, len(CommonScales))
	for _, s := range CommonScales {
		w, _ := RealWorldSize(page, s.Denominator)
		if w <= 0 {
			continue
		}
		// Distance in log space, so 1/2× and 2× off are penalised
		// equally rather than the smaller side dominating.
		rank := math.Abs(math.Log(w / idealWidthM))
		if w < 5 || w > 500 {
			rank += 10
		}
		if system != "" && s.System != system {
			rank += 0.5
		}
		ranked = append(ranked, scored{s, rank})
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].rank < ranked[j].rank })

	out := make([]PlotScale, len(ranked))
	for i, r := range ranked {
		out[i] = r.scale
	}
	return out
}
