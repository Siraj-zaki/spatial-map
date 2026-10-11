package cad_test

import (
	"math"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// block returns n×n short line entities filling [x0,x1]×[y0,y1], standing
// in for a building: enough of them that it is unmistakably the drawing.
func block(x0, y0, x1, y1 float64, n int) []cad.Entity {
	var out []cad.Entity
	step := (x1 - x0) / float64(n)
	for i := range n {
		for j := range n {
			x := x0 + step*float64(i)
			y := y0 + (y1-y0)*float64(j)/float64(n-1)
			out = append(out, &cad.Line{
				Start: cad.Vec3{X: x, Y: y},
				End:   cad.Vec3{X: x + step, Y: y},
			})
		}
	}
	return out
}

func speck(x, y float64) cad.Entity { return &cad.Point{Position: cad.Vec3{X: x, Y: y}} }

func near(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1 {
		t.Errorf("%s = %.2f, want %.2f", label, got, want)
	}
}

// The case from the field: a 122 m building, plus a handful of entities
// scattered hundreds of metres out on unrelated layers. They are 0.007%
// of the drawing and they set 88% of its width.
func TestTrimOutliersDiscardsDebrisTheDrawingDoesNotDraw(t *testing.T) {
	ents := append(block(853, 0, 975, 100, 100),
		speck(0, 40), speck(8.8, 41), speck(11.2, 39), speck(59.6, 42))

	if w := cad.Bounds(ents).Size().X; w < 900 {
		t.Fatalf("test setup: raw width %.1f, expected the debris to inflate it", w)
	}

	kept, dropped := cad.TrimOutliers(ents)
	if dropped != 4 {
		t.Errorf("dropped %d entities, want the 4 specks", dropped)
	}
	got := cad.Bounds(kept)
	near(t, "min X", got.Min.X, 853)
	near(t, "max X", got.Max.X, 975)
	near(t, "min Y", got.Min.Y, 0)
	near(t, "max Y", got.Max.Y, 100)
}

// A second building is detached and far away too. It is not debris, and
// the mass test is what tells them apart — cropping it would silently
// halve a site plan.
func TestTrimOutliersKeepsADetachedSecondBuilding(t *testing.T) {
	ents := append(block(0, 0, 100, 80, 60), block(600, 0, 700, 80, 60)...)
	_, dropped := cad.TrimOutliers(ents)
	if dropped != 0 {
		t.Fatalf("dropped %d entities of a two-building site plan", dropped)
	}
	got := cad.PlanBounds(ents)
	near(t, "min X", got.Min.X, 0)
	near(t, "max X", got.Max.X, 700)
}

// A courtyard is a gap inside the plan. Nothing on either side of it is
// negligible, and the growth step re-admits across it regardless: a
// plan's own voids are smaller than the plan.
func TestTrimOutliersKeepsGeometryAcrossACourtyard(t *testing.T) {
	ents := append(block(0, 0, 40, 90, 60), block(60, 0, 100, 90, 60)...)
	got := cad.PlanBounds(ents)
	near(t, "min X", got.Min.X, 0)
	near(t, "max X", got.Max.X, 100)
}

// Debris on both axes at once, and each axis must be judged on the
// entities the other one kept.
func TestTrimOutliersTrimsBothAxes(t *testing.T) {
	ents := append(block(500, 500, 600, 580, 100), speck(0, 0), speck(1200, 1400))
	got := cad.PlanBounds(ents)
	near(t, "min X", got.Min.X, 500)
	near(t, "max X", got.Max.X, 600)
	near(t, "min Y", got.Min.Y, 500)
	near(t, "max Y", got.Max.Y, 580)
}

// A wall running out past the edge of the core keeps its full length: the
// window picks which entities belong, never where they stop.
func TestTrimOutliersNeverClipsAnEntityItKeeps(t *testing.T) {
	ents := append(block(0, 0, 100, 80, 60),
		&cad.Line{Start: cad.Vec3{X: 50, Y: 40}, End: cad.Vec3{X: 130, Y: 40}})
	got := cad.PlanBounds(ents)
	near(t, "max X", got.Max.X, 130)
}

// A clean drawing must come back untouched — the trim is a repair, and a
// repair that fires on a healthy file is a bug with a wide blast radius.
func TestTrimOutliersLeavesACleanDrawingAlone(t *testing.T) {
	ents := block(10, 20, 110, 100, 80)
	kept, dropped := cad.TrimOutliers(ents)
	if dropped != 0 || len(kept) != len(ents) {
		t.Errorf("dropped %d of %d entities from a clean drawing", dropped, len(ents))
	}
}

// Degenerate inputs reach this from real files: an empty layer filter, or
// a drawing that is one line.
func TestTrimOutliersHandlesDegenerateInput(t *testing.T) {
	if b := cad.PlanBounds(nil); b.Valid {
		t.Errorf("empty input produced a valid box: %+v", b)
	}
	one := []cad.Entity{speck(5, 7)}
	if _, dropped := cad.TrimOutliers(one); dropped != 0 {
		t.Errorf("dropped the only entity in the drawing")
	}
	vertical := []cad.Entity{&cad.Line{Start: cad.Vec3{X: 3}, End: cad.Vec3{X: 3, Y: 50}}}
	got := cad.PlanBounds(vertical)
	near(t, "min X", got.Min.X, 3)
	near(t, "max Y", got.Max.Y, 50)
}
