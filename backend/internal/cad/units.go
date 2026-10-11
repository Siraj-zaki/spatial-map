package cad

import (
	"math"
	"sort"
)

// This file is why a DWG or DXF is worth more than a PDF of the same
// drawing.
//
// A PDF records a sheet of paper. To get real-world size out of one you
// must know the plot scale, which the file does not store, so
// internal/pdfconv/scale.go can only rank guesses and ask the user to
// check them against a title block.
//
// A CAD file stores model space at 1:1. The coordinates already ARE the
// building. All that is missing is which unit one step represents, and
// $INSUNITS usually says. When it does, the real-world size is known
// exactly and the user is asked nothing.
//
// When it does not — $INSUNITS is 0 in a large minority of files,
// because AutoCAD's default template was unitless for years — we are
// back to guessing. But it is a much better-conditioned guess than the
// PDF one: the candidates are five orders of magnitude apart, so a
// building-sized answer is unambiguous rather than one of several
// plausible readings.

// Units is $INSUNITS: the real-world length one drawing unit represents.
type Units int

// $INSUNITS codes. The list is longer than anything a building drawing
// needs, but the codes are fixed by the format and a reader that maps
// only the plausible ones would silently mistranslate the rest.
const (
	UnitsUnitless     Units = 0
	UnitsInches       Units = 1
	UnitsFeet         Units = 2
	UnitsMiles        Units = 3
	UnitsMillimeters  Units = 4
	UnitsCentimeters  Units = 5
	UnitsMeters       Units = 6
	UnitsKilometers   Units = 7
	UnitsMicroinches  Units = 8
	UnitsMils         Units = 9
	UnitsYards        Units = 10
	UnitsAngstroms    Units = 11
	UnitsNanometers   Units = 12
	UnitsMicrons      Units = 13
	UnitsDecimeters   Units = 14
	UnitsDecameters   Units = 15
	UnitsHectometers  Units = 16
	UnitsGigameters   Units = 17
	UnitsAstronomical Units = 18
	UnitsLightYears   Units = 19
	UnitsParsecs      Units = 20
)

var unitMeters = map[Units]float64{
	UnitsInches:       0.0254,
	UnitsFeet:         0.3048,
	UnitsMiles:        1609.344,
	UnitsMillimeters:  0.001,
	UnitsCentimeters:  0.01,
	UnitsMeters:       1,
	UnitsKilometers:   1000,
	UnitsMicroinches:  0.0254e-6,
	UnitsMils:         0.0254e-3,
	UnitsYards:        0.9144,
	UnitsAngstroms:    1e-10,
	UnitsNanometers:   1e-9,
	UnitsMicrons:      1e-6,
	UnitsDecimeters:   0.1,
	UnitsDecameters:   10,
	UnitsHectometers:  100,
	UnitsGigameters:   1e9,
	UnitsAstronomical: 1.495978707e11,
	UnitsLightYears:   9.4607304725808e15,
	UnitsParsecs:      3.0856775814913673e16,
}

var unitNames = map[Units]string{
	UnitsUnitless:     "unitless",
	UnitsInches:       "inches",
	UnitsFeet:         "feet",
	UnitsMiles:        "miles",
	UnitsMillimeters:  "millimeters",
	UnitsCentimeters:  "centimeters",
	UnitsMeters:       "meters",
	UnitsKilometers:   "kilometers",
	UnitsMicroinches:  "microinches",
	UnitsMils:         "mils",
	UnitsYards:        "yards",
	UnitsAngstroms:    "angstroms",
	UnitsNanometers:   "nanometers",
	UnitsMicrons:      "microns",
	UnitsDecimeters:   "decimeters",
	UnitsDecameters:   "decameters",
	UnitsHectometers:  "hectometers",
	UnitsGigameters:   "gigameters",
	UnitsAstronomical: "astronomical units",
	UnitsLightYears:   "light years",
	UnitsParsecs:      "parsecs",
}

// MetersPerUnit converts a drawing unit to metres, reporting false for
// Unitless and for codes outside the defined range.
func (u Units) MetersPerUnit() (float64, bool) {
	m, ok := unitMeters[u]
	return m, ok
}

// String names the unit for display and logs.
func (u Units) String() string {
	if n, ok := unitNames[u]; ok {
		return n
	}
	return "unknown"
}

// Imperial reports whether the unit belongs to the imperial system,
// which is what lets a guess prefer the system $MEASUREMENT implies.
func (u Units) Imperial() bool {
	switch u {
	case UnitsInches, UnitsFeet, UnitsMiles, UnitsMicroinches, UnitsMils, UnitsYards:
		return true
	}
	return false
}

// Measurement is $MEASUREMENT. It selects a hatch and linetype library
// rather than a unit, so it is only a hint — but it is a hint that
// survives in files where $INSUNITS was never set, which is exactly when
// a hint is needed.
type Measurement int

const (
	MeasurementImperial Measurement = 0
	MeasurementMetric   Measurement = 1
)

// UnitGuess is a ranked candidate for a drawing's units.
type UnitGuess struct {
	Units Units  `json:"units"`
	Name  string `json:"name"`
	// WidthMeters is the drawing's width if this candidate is right. It
	// is the number that makes a guess obviously right or obviously
	// absurd to a human, so the UI shows it rather than the unit alone.
	WidthMeters float64 `json:"widthMeters"`
	// Plausible is false for candidates that imply a building smaller
	// than a desk or larger than a town.
	Plausible bool `json:"plausible"`
}

// guessCandidates are the units a drawing that declares none is
// realistically in. Deliberately short: a drawing is not going to be
// authored in parsecs, and offering twenty candidates would bury the
// four that matter.
var guessCandidates = []Units{
	UnitsMillimeters,
	UnitsMeters,
	UnitsInches,
	UnitsFeet,
	UnitsCentimeters,
}

// Plausible building extents in metres. Below the lower bound the
// "drawing" is a single component; above the upper it is a site plan or
// a mis-scaled import.
const (
	minPlausibleM = 3.0
	maxPlausibleM = 500.0
	idealWidthM   = 60.0

	// confidenceMargin is how much better the leading candidate must be
	// than its nearest plausible rival, measured in log space — a factor
	// of e in implied building size.
	confidenceMargin = 1.0
)

// GuessUnits ranks candidate units by how plausible a building the
// drawing's extents would describe under each.
//
// The reasoning mirrors pdfconv.SuggestScales — log-space distance from
// a typical footprint, with a penalty for the implausible band — but the
// answer here is far more decisive. The candidates differ by factors of
// 25 to 1000, so a 42 000-unit drawing is millimetres and nothing else,
// whereas a PDF sheet is genuinely ambiguous between 1:50 and 1:100.
//
// Returns the ranked list; the caller decides whether to accept the top
// entry silently or to confirm it. Confident() answers that.
func GuessUnits(size Vec3, measurement Measurement) []UnitGuess {
	extent := math.Max(math.Abs(size.X), math.Abs(size.Y))
	if extent <= 0 || math.IsNaN(extent) || math.IsInf(extent, 0) {
		return nil
	}

	type scored struct {
		guess UnitGuess
		rank  float64
	}
	ranked := make([]scored, 0, len(guessCandidates))
	for _, u := range guessCandidates {
		mpu, ok := u.MetersPerUnit()
		if !ok {
			continue
		}
		w := extent * mpu
		rank := math.Abs(math.Log(w / idealWidthM))
		plausible := plausibleExtent(w)
		if !plausible {
			rank += 10
		}
		if (measurement == MeasurementImperial) != u.Imperial() {
			rank += 0.5
		}
		ranked = append(ranked, scored{
			guess: UnitGuess{Units: u, Name: u.String(), WidthMeters: w, Plausible: plausible},
			rank:  rank,
		})
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].rank < ranked[j].rank })

	out := make([]UnitGuess, len(ranked))
	for i, r := range ranked {
		out[i] = r.guess
	}
	return out
}

// Confident reports whether a ranked guess is safe to apply without
// asking.
//
// The bar is that the leading candidate is plausible AND clearly better
// than the next plausible one. A single plausible candidate is decisive
// on its own; two that are close are not, because the drawing could
// honestly be either — a 500-unit drawing is 152 m in feet and 12.7 m in
// inches, both buildings — and silently picking one produces geometry
// wrong by a factor of twelve with no visible symptom until someone
// measures it. Asking is cheap; a silently mis-scaled floor plan is not.
//
// A wide margin is what makes the common case ask nothing: a
// 42 000-unit drawing is 42 m in millimetres and 420 m in centimetres,
// and only the first is a building anyone draws at that unit count.
func Confident(guesses []UnitGuess) bool {
	best := math.Inf(1)
	runnerUp := math.Inf(1)
	for _, g := range guesses {
		if !g.Plausible {
			continue
		}
		d := math.Abs(math.Log(g.WidthMeters / idealWidthM))
		switch {
		case d < best:
			best, runnerUp = d, best
		case d < runnerUp:
			runnerUp = d
		}
	}
	if math.IsInf(best, 1) {
		return false
	}
	return runnerUp-best >= confidenceMargin
}

func plausibleExtent(widthM float64) bool {
	return widthM >= minPlausibleM && widthM <= maxPlausibleM
}

// ResolveUnits determines the metres-per-unit factor for a drawing,
// preferring what the file declares and falling back to the extents.
//
// The bool reports whether the answer is known rather than inferred, so
// callers can decide whether to confirm with the user.
//
// A declaration is preferred but not obeyed. $INSUNITS is metadata a
// template carries and an author rarely revisits, so a drawing that says
// millimetres and measures 38 units across is stating something the
// geometry falsifies — and obeying it imports a flat as a 38 mm object
// with no visible symptom beyond a building nobody can find on the map.
// One of the reader's own fixtures is exactly that file. So when the
// declared unit implies an extent no building has and some candidate
// implies one that does, the extents win and the answer is offered as a
// guess rather than a fact.
//
// The falsification is one-sided on purpose. An implausible declaration
// with no plausible alternative is left alone: that is a drawing of a
// bracket, or a file whose extents we misread, and neither is improved by
// substituting a unit we cannot justify either.
func ResolveUnits(h Header, size Vec3) (Units, float64, bool) {
	guesses := GuessUnits(size, h.Measurement)
	if mpu, ok := h.Units.MetersPerUnit(); ok {
		extent := math.Max(math.Abs(size.X), math.Abs(size.Y))
		contradicted := extent > 0 && !plausibleExtent(extent*mpu)
		if !contradicted || len(guesses) == 0 || !guesses[0].Plausible {
			return h.Units, mpu, true
		}
	}
	if len(guesses) == 0 {
		return UnitsUnitless, 0, false
	}
	top := guesses[0]
	mpu, _ := top.Units.MetersPerUnit()
	return top.Units, mpu, Confident(guesses)
}
