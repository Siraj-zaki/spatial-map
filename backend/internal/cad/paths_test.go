package cad

import (
	"errors"
	"math"
	"slices"
	"testing"
)

func pathLength(p Path) float64 {
	var total float64
	n := len(p.Points) / 2
	stop := n - 1
	if p.Closed {
		stop = n
	}
	for i := range stop {
		j := (i + 1) % n
		total += math.Hypot(p.Points[2*j]-p.Points[2*i], p.Points[2*j+1]-p.Points[2*i+1])
	}
	return total
}

// The sagitta is the only promise tessellation makes, and it is a
// promise about the points that are *not* emitted: the true curve
// between two chords. Counting segments proves nothing — a curve can be
// cut into a hundred pieces and still bulge away from every one of them
// if the angles are computed wrongly.
func TestTessellationStaysWithinSagitta(t *testing.T) {
	const r = 4.0
	for _, sag := range []float64{0.5, 0.05, 0.005} {
		paths, _ := Paths([]Entity{&Circle{Center: Vec3{10, 10, 0}, Radius: r}},
			PathOptions{Sagitta: sag, MaxSegments: 4096})
		if len(paths) != 1 {
			t.Fatalf("sagitta %v: got %d paths", sag, len(paths))
		}
		p := paths[0]
		if !p.Closed {
			t.Errorf("sagitta %v: circle is not closed", sag)
		}

		n := len(p.Points) / 2
		var worst float64
		for i := range n {
			j := (i + 1) % n
			mx := (p.Points[2*i] + p.Points[2*j]) / 2
			my := (p.Points[2*i+1] + p.Points[2*j+1]) / 2
			// Distance from the chord's midpoint back out to the circle.
			gap := r - math.Hypot(mx-10, my-10)
			worst = math.Max(worst, gap)
		}
		if worst > sag {
			t.Errorf("sagitta %v: chords deviate by %.5f, %d segments", sag, worst, n)
		}
	}
}

// A closed ring must not repeat its first point at the end. The
// duplicate is invisible in a stroked outline and produces a degenerate
// zero-length edge in a filled one, which is exactly the kind of thing
// that survives every visual check and then fails a triangulator.
func TestClosedCurvesDoNotRepeatTheFirstPoint(t *testing.T) {
	// A closed spline is stated by wrapping its control net, so its last
	// evaluated point genuinely lands on its first — the duplicate is the
	// default here rather than something that has to go wrong.
	closedSpline := &Spline{
		Degree:        2,
		Closed:        true,
		ControlPoints: []Vec3{{0, 0, 0}, {4, 0, 0}, {4, 4, 0}, {0, 4, 0}, {0, 0, 0}},
		Knots:         []float64{0, 0, 0, 1, 2, 3, 3, 3},
	}
	for _, e := range []Entity{&Circle{Radius: 2}, closedSpline} {
		paths, _ := Paths([]Entity{e}, PathOptions{})
		p := paths[0]
		n := len(p.Points) / 2
		if !p.Closed || n < 4 {
			t.Fatalf("%T: closed=%v, %d points", e, p.Closed, n)
		}
		if p.Points[0] == p.Points[2*(n-1)] && p.Points[1] == p.Points[2*(n-1)+1] {
			t.Errorf("%T: closed ring repeats its first point", e)
		}
	}
}

// The tolerance is stated in metres, so the scale factor has to reach
// the segment count. A drawing in millimetres and the same drawing in
// metres describe the same building, and must tessellate identically —
// otherwise a curve that looks smooth in one file looks faceted in the
// next, for no reason the user can see.
func TestSegmentCountFollowsRealWorldSizeNotUnitCount(t *testing.T) {
	inMeters, _ := Paths([]Entity{&Circle{Radius: 5}}, PathOptions{MetersPerUnit: 1})
	inMillimeters, _ := Paths([]Entity{&Circle{Radius: 5000}}, PathOptions{MetersPerUnit: 0.001})

	if got, want := len(inMillimeters[0].Points), len(inMeters[0].Points); got != want {
		t.Errorf("same 5 m circle tessellated to %d points in mm and %d in m", got, want)
	}
	if got := PathBounds(inMillimeters).Size().X; math.Abs(got-10) > 0.05 {
		t.Errorf("5 m radius circle in mm measures %.3f m across", got)
	}
}

// A bulge is stored as an arc that may run the other way round, and the
// interior points have to be walked in whichever direction keeps them
// between the endpoints. Reversed, they still land on the true curve and
// still number correctly — every per-point check passes — but the path
// zig-zags across the arc, so its total length is the thing that gives
// it away.
func TestBulgedSegmentsAreTraversedInOrder(t *testing.T) {
	const chord = 6.0
	// tan(θ/4) = 1 is a half turn, so each of these is a semicircle of
	// radius 3 standing on the same chord, on opposite sides.
	for _, bulge := range []float64{1, -1} {
		paths, _ := Paths([]Entity{&Polyline{
			Vertices: []Vertex{
				{Point: Vec3{0, 0, 0}, Bulge: bulge},
				{Point: Vec3{chord, 0, 0}},
			},
		}}, PathOptions{Sagitta: 0.001})
		if len(paths) != 1 {
			t.Fatalf("bulge %v: got %d paths", bulge, len(paths))
		}
		want := math.Pi * chord / 2
		if got := pathLength(paths[0]); math.Abs(got-want) > want*0.01 {
			t.Errorf("bulge %v: semicircle traced as %.3f long, want %.3f", bulge, got, want)
		}
	}
}

// A drawing's coordinates are wherever its author put them — often
// hundreds of kilometres from the origin, on a survey grid. Anchoring it
// on a map means measuring from a corner of its own extents, not from
// zero.
func TestOriginMovesTheDrawingToTheFirstQuadrant(t *testing.T) {
	line := &Line{Start: Vec3{4000, -2000, 0}, End: Vec3{9000, 3000, 0}}
	paths, _ := Paths([]Entity{line}, PathOptions{
		MetersPerUnit: 0.001,
		Origin:        Vec3{4000, -2000, 0},
	})
	box := PathBounds(paths)
	if box.Min.X != 0 || box.Min.Y != 0 {
		t.Errorf("origin corner sits at (%.3f, %.3f), want (0, 0)", box.Min.X, box.Min.Y)
	}
	if math.Abs(box.Max.X-5) > 1e-9 || math.Abs(box.Max.Y-5) > 1e-9 {
		t.Errorf("5 m diagonal measures %.3f x %.3f m", box.Max.X, box.Max.Y)
	}
}

// Filled entities are the poché in a plan — the black of a cut wall. A
// SOLID that arrives as a hairline outline loses the visual weight that
// is most of what makes a floor plan readable at a glance.
func TestSolidsAreClosedAndFilled(t *testing.T) {
	paths, _ := Paths([]Entity{&Solid{Corners: []Vec3{{0, 0, 0}, {1, 0, 0}, {1, 1, 0}, {0, 1, 0}}}},
		PathOptions{})
	if len(paths) != 1 {
		t.Fatalf("got %d paths", len(paths))
	}
	if !paths[0].Closed || !paths[0].Filled {
		t.Errorf("solid is closed=%v filled=%v", paths[0].Closed, paths[0].Filled)
	}
	if got := len(paths[0].Points); got != 8 {
		t.Errorf("quad emitted %d coordinates, want 8", got)
	}
}

// Nothing in a drawing states what a spline's points *should* be, with
// one exception: a rational quadratic over these three control points
// with these three weights is exactly the unit quarter circle. It is the
// only case where a NURBS evaluator can be checked against an answer
// rather than against itself, so it is the one worth writing — a
// plausible-but-wrong evaluator (weights ignored, knots off by one, the
// hull walked instead of the curve) misses the circle immediately.
func TestRationalSplineDrawsTheCircleItDefines(t *testing.T) {
	quarter := &Spline{
		Degree:        2,
		ControlPoints: []Vec3{{1, 0, 0}, {1, 1, 0}, {0, 1, 0}},
		Weights:       []float64{1, math.Sqrt2 / 2, 1},
		Knots:         []float64{0, 0, 0, 1, 1, 1},
	}
	paths, _ := Paths([]Entity{quarter}, PathOptions{})
	if len(paths) != 1 {
		t.Fatalf("got %d paths", len(paths))
	}
	p := paths[0]
	if n := len(p.Points) / 2; n < 4 {
		t.Fatalf("quarter circle tessellated to %d points", n)
	}
	for i := 0; i+1 < len(p.Points); i += 2 {
		if r := math.Hypot(p.Points[i], p.Points[i+1]); math.Abs(r-1) > 1e-9 {
			t.Errorf("point %d sits at radius %.12f, want 1", i/2, r)
		}
	}
	// Both ends belong to the curve. The last one is emitted separately —
	// every span contributes its own start and nothing else — so it is the
	// one an off-by-one drops without changing anything else.
	if x, y := p.Points[0], p.Points[1]; math.Abs(x-1) > 1e-9 || math.Abs(y) > 1e-9 {
		t.Errorf("curve starts at (%.9f, %.9f), want (1, 0)", x, y)
	}
	n := len(p.Points)
	if x, y := p.Points[n-2], p.Points[n-1]; math.Abs(x) > 1e-9 || math.Abs(y-1) > 1e-9 {
		t.Errorf("curve ends at (%.9f, %.9f), want (0, 1)", x, y)
	}
}

// A degree-1 spline is its own control polygon, so it must come back
// unchanged — no smoothing, no dropped corner, no extra sample. CAD
// applications write these when a user converts a polyline, and a
// building drawn that way loses its corners if the evaluator rounds them.
func TestLinearSplineReproducesItsControlPoints(t *testing.T) {
	paths, _ := Paths([]Entity{&Spline{
		Degree:        1,
		ControlPoints: []Vec3{{0, 0, 0}, {10, 0, 0}, {10, 5, 0}},
		Knots:         []float64{0, 0, 1, 2, 2},
	}}, PathOptions{})
	want := []float64{0, 0, 10, 0, 10, 5}
	if got := paths[0].Points; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// A spline that stated only fit points has to draw as something. The
// curve through them is not recoverable without recomputing a control
// net, but the points are on it, so joining them is an approximation —
// whereas skipping the entity is a wall the user drew and cannot find.
func TestFitOnlySplineStillDraws(t *testing.T) {
	paths, _ := Paths([]Entity{&Spline{
		Degree:    3,
		FitPoints: []Vec3{{0, 0, 0}, {1, 2, 0}, {3, 2, 0}, {4, 0, 0}},
	}}, PathOptions{})
	if len(paths) != 1 || len(paths[0].Points) != 8 {
		t.Fatalf("fit-only spline produced %d paths", len(paths))
	}
}

// Knots come from the file, and deBoor divides by the differences between
// them. A vector that is not non-decreasing makes those differences zero
// or negative, and the arithmetic answers with infinities that reach the
// client as coordinates. The fallback draws the net instead of nothing.
func TestNonMonotonicKnotsDoNotProduceInfinities(t *testing.T) {
	paths, _ := Paths([]Entity{&Spline{
		Degree:        2,
		ControlPoints: []Vec3{{0, 0, 0}, {1, 1, 0}, {2, 0, 0}},
		Knots:         []float64{0, 0, 0, 1, 0, 1},
	}}, PathOptions{})
	if len(paths) != 1 {
		t.Fatalf("got %d paths", len(paths))
	}
	for i, v := range paths[0].Points {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			t.Fatalf("coordinate %d is %v", i, v)
		}
	}
}

// An unbounded radius is a number read from the file, so the cap is a
// bound on what a hostile drawing can make the server allocate rather
// than a quality setting.
func TestCurveTessellationIsCapped(t *testing.T) {
	paths, _ := Paths([]Entity{&Circle{Radius: 1e12}},
		PathOptions{Sagitta: 1e-6, MaxSegments: 64})
	if got := len(paths[0].Points) / 2; got > 64 {
		t.Errorf("circle produced %d points against a 64-segment cap", got)
	}
}

// Hitting the total cap has to be reported, not just obeyed. A drawing
// that stops halfway and says nothing is the failure mode the whole
// reader is written to avoid — the user sees an import that worked and
// half a building.
func TestPointCapIsReportedNotSwallowed(t *testing.T) {
	entities := make([]Entity, 100)
	for i := range entities {
		entities[i] = &Circle{Radius: 1}
	}
	paths, err := Paths(entities, PathOptions{MaxPoints: 200})
	if !errors.Is(err, ErrTooManyPoints) {
		t.Fatalf("truncated at %d paths with err %v", len(paths), err)
	}
	if len(paths) == 0 || len(paths) == len(entities) {
		t.Errorf("expected a partial result, got %d of %d paths", len(paths), len(entities))
	}
}
