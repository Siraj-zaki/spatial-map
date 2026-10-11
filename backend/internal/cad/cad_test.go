package cad

import (
	"math"
	"testing"
)

func nearly(t *testing.T, got, want float64, what string) {
	t.Helper()
	if math.Abs(got-want) > 1e-6 {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

func nearlyPoint(t *testing.T, got, want Vec3, what string) {
	t.Helper()
	if math.Abs(got.X-want.X) > 1e-6 || math.Abs(got.Y-want.Y) > 1e-6 || math.Abs(got.Z-want.Z) > 1e-6 {
		t.Errorf("%s = %+v, want %+v", what, got, want)
	}
}

// A bulge that reconstructs to the wrong arc is the worst kind of import
// bug: the drawing still looks like a drawing, so nobody checks it until
// a measurement comes out wrong.
func TestArcFromBulge(t *testing.T) {
	start, end := Vec3{0, 0, 0}, Vec3{1, 0, 0}

	t.Run("semicircle", func(t *testing.T) {
		arc, ok := ArcFromBulge(start, end, 1)
		if !ok {
			t.Fatal("expected an arc")
		}
		nearlyPoint(t, arc.Center, Vec3{0.5, 0, 0}, "center")
		nearly(t, arc.Radius, 0.5, "radius")
		nearly(t, arc.Sweep(), math.Pi, "sweep")
		// Positive bulge sweeps counter-clockwise, which for a
		// left-to-right chord passes below it.
		nearlyPoint(t, arc.PointAt(0.5), Vec3{0.5, -0.5, 0}, "midpoint")
	})

	t.Run("quarter turn", func(t *testing.T) {
		arc, ok := ArcFromBulge(start, end, math.Tan(math.Pi/8))
		if !ok {
			t.Fatal("expected an arc")
		}
		nearlyPoint(t, arc.Center, Vec3{0.5, 0.5, 0}, "center")
		nearly(t, arc.Radius, math.Sqrt2/2, "radius")
		nearly(t, arc.Sweep(), math.Pi/2, "sweep")
	})

	t.Run("major arc puts the centre on the other side", func(t *testing.T) {
		// Three quarters of a turn: cos(θ/2) goes negative and the
		// centre has to cross the chord.
		arc, ok := ArcFromBulge(start, end, math.Tan(3*math.Pi/8))
		if !ok {
			t.Fatal("expected an arc")
		}
		nearlyPoint(t, arc.Center, Vec3{0.5, -0.5, 0}, "center")
		nearly(t, arc.Sweep(), 3*math.Pi/2, "sweep")
	})

	t.Run("negative bulge mirrors the sweep", func(t *testing.T) {
		arc, ok := ArcFromBulge(start, end, -math.Tan(math.Pi/8))
		if !ok {
			t.Fatal("expected an arc")
		}
		nearlyPoint(t, arc.Center, Vec3{0.5, -0.5, 0}, "center")
		nearly(t, arc.Sweep(), math.Pi/2, "sweep")
	})

	t.Run("zero bulge is a straight segment", func(t *testing.T) {
		if _, ok := ArcFromBulge(start, end, 0); ok {
			t.Error("a zero bulge must not produce an arc")
		}
	})
}

// Extents drive the real-world size the drawing is placed at, so an arc
// measured as its whole circle inflates the building.
func TestArcBoundsAreTight(t *testing.T) {
	// Upper-right quadrant of a unit circle at the origin.
	arc := Arc{Center: Vec3{}, Radius: 1, StartAngle: 0, EndAngle: math.Pi / 2}
	b := arc.Bounds()
	nearlyPoint(t, b.Min, Vec3{0, 0, 0}, "min")
	nearlyPoint(t, b.Max, Vec3{1, 1, 0}, "max")

	// A sweep that crosses +X must pick that extreme up.
	crossing := Arc{Center: Vec3{}, Radius: 1, StartAngle: 3 * math.Pi / 2, EndAngle: math.Pi / 2}
	cb := crossing.Bounds()
	nearly(t, cb.Max.X, 1, "max.X across the +X axis")
	nearly(t, cb.Min.X, 0, "min.X")
}

func TestSVD2x2RoundTrips(t *testing.T) {
	cases := [][4]float64{
		{2, 0, 0, 3},         // anisotropic scale
		{0, -1, 1, 0},        // rotation
		{-1, 0, 0, 1},        // reflection
		{1.5, 0.5, -0.25, 2}, // general
		{3, 0, 0, 3},         // uniform
	}
	for _, c := range cases {
		a, b, cc, d := c[0], c[1], c[2], c[3]
		phi, sx, sy, theta := svd2x2(a, b, cc, d)

		// Reassemble rot(phi)·diag(sx,sy)·rot(theta) and compare.
		cp, sp := math.Cos(phi), math.Sin(phi)
		ct, st := math.Cos(theta), math.Sin(theta)
		// rot(theta)
		v00, v01 := ct, -st
		v10, v11 := st, ct
		got := [4]float64{
			cp*sx*v00 - sp*sy*v10, cp*sx*v01 - sp*sy*v11,
			sp*sx*v00 + cp*sy*v10, sp*sx*v01 + cp*sy*v11,
		}
		for i, want := range [4]float64{a, b, cc, d} {
			if math.Abs(got[i]-want) > 1e-9 {
				t.Errorf("svd2x2%v reassembled[%d] = %v, want %v", c, i, got[i], want)
			}
		}
	}
}

// A door block stretched to a wider opening is the everyday non-uniform
// scale. Its swing arc has to become elliptical or it stops meeting the
// wall.
func TestNonUniformScaleTurnsCircleIntoEllipse(t *testing.T) {
	c := &Circle{Center: Vec3{0, 0, 0}, Radius: 1}
	out := transform(c, Scaling(Vec3{2, 1, 1}))

	e, ok := out.(*Ellipse)
	if !ok {
		t.Fatalf("expected an ellipse, got %T", out)
	}
	nearly(t, e.MajorAxis.Length(), 2, "major axis length")
	nearly(t, e.Ratio, 0.5, "ratio")

	// The major axis must lie along X, the axis that was stretched.
	nearly(t, math.Abs(e.MajorAxis.X), 2, "major axis X")
	nearly(t, e.MajorAxis.Y, 0, "major axis Y")
}

func TestUniformScaleKeepsCircleCircular(t *testing.T) {
	c := &Circle{Center: Vec3{1, 2, 0}, Radius: 3}
	out := transform(c, Translation(Vec3{10, 0, 0}).Mul(Scaling(Vec3{2, 2, 1})))

	got, ok := out.(*Circle)
	if !ok {
		t.Fatalf("expected a circle, got %T", out)
	}
	nearly(t, got.Radius, 6, "radius")
	nearlyPoint(t, got.Center, Vec3{12, 4, 0}, "center")
}

// Mirroring reverses the direction of a sweep. Arcs are stored
// counter-clockwise, so the ends have to swap or a door swings the wrong
// way.
func TestMirrorReversesArc(t *testing.T) {
	a := &ArcEntity{Center: Vec3{}, Radius: 1, StartAngle: 0, EndAngle: math.Pi / 2}
	out := transform(a, Scaling(Vec3{-1, 1, 1}))

	got, ok := out.(*ArcEntity)
	if !ok {
		t.Fatalf("expected an arc, got %T", out)
	}
	nearly(t, got.Radius, 1, "radius")
	// The quadrant [0°,90°] mirrored about X is [90°,180°].
	nearly(t, got.StartAngle, math.Pi/2, "start angle")
	nearly(t, got.EndAngle, math.Pi, "end angle")

	// Whatever the angles, the swept region must be the mirror image.
	b := got.Geometry().Bounds()
	nearly(t, b.Min.X, -1, "min.X")
	nearly(t, b.Max.X, 0, "max.X")
	nearly(t, b.Max.Y, 1, "max.Y")
}

func blockDoc() *Document {
	d := NewDocument()
	d.AddLayer(&Layer{Name: "0"})
	d.AddLayer(&Layer{Name: "WALLS"})
	d.AddLayer(&Layer{Name: "NOTES", Off: true})
	d.AddBlock(&Block{
		Name: "DESK",
		Entities: []Entity{
			// Authored on layer "0" so it inherits from the reference.
			&Line{Common: Common{Layer: "0", Extrusion: ZAxis}, Start: Vec3{}, End: Vec3{1, 0, 0}},
		},
	})
	return d
}

// An importer that renders only what model space literally holds shows a
// nearly empty drawing, because a plan's content is block references.
func TestFlattenExpandsInserts(t *testing.T) {
	d := blockDoc()
	d.Entities = []Entity{
		&Insert{
			Common:    Common{Layer: "WALLS", Extrusion: ZAxis},
			BlockName: "DESK",
			Position:  Vec3{10, 5, 0},
			Scale:     Vec3{2, 2, 1},
		},
	}

	res, err := d.Flatten(DefaultFlattenOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Entities) != 1 {
		t.Fatalf("got %d entities, want 1", len(res.Entities))
	}
	line, ok := res.Entities[0].(*Line)
	if !ok {
		t.Fatalf("expected a line, got %T", res.Entities[0])
	}
	nearlyPoint(t, line.Start, Vec3{10, 5, 0}, "start")
	nearlyPoint(t, line.End, Vec3{12, 5, 0}, "end")

	// Geometry on layer "0" inside a block takes the layer of whatever
	// inserted it. Without this every symbol collapses onto "0" and layer
	// filtering stops being useful.
	if line.Layer != "WALLS" {
		t.Errorf("layer = %q, want WALLS — layer 0 must inherit from the insert", line.Layer)
	}
}

func TestFlattenSkipsHiddenLayers(t *testing.T) {
	d := blockDoc()
	d.Entities = []Entity{
		&Line{Common: Common{Layer: "NOTES", Extrusion: ZAxis}},
		&Line{Common: Common{Layer: "WALLS", Extrusion: ZAxis}, End: Vec3{1, 0, 0}},
	}
	res, err := d.Flatten(DefaultFlattenOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Entities) != 1 {
		t.Fatalf("got %d entities, want 1 (the off layer must be dropped)", len(res.Entities))
	}
	if res.Entities[0].Base().Layer != "WALLS" {
		t.Errorf("kept the wrong layer: %q", res.Entities[0].Base().Layer)
	}
}

// Files are uploaded by users and nothing in the format stops a block
// from inserting itself.
func TestFlattenCutsBlockCycles(t *testing.T) {
	d := NewDocument()
	d.AddLayer(&Layer{Name: "0"})
	d.AddBlock(&Block{
		Name: "LOOP",
		Entities: []Entity{
			&Line{Common: Common{Layer: "0", Extrusion: ZAxis}, End: Vec3{1, 0, 0}},
			&Insert{Common: Common{Layer: "0", Extrusion: ZAxis}, BlockName: "LOOP", Scale: Vec3{1, 1, 1}},
		},
	})
	d.Entities = []Entity{
		&Insert{Common: Common{Layer: "0", Extrusion: ZAxis}, BlockName: "LOOP", Scale: Vec3{1, 1, 1}},
	}

	res, err := d.Flatten(DefaultFlattenOptions())
	if err != nil {
		t.Fatalf("a cycle must be cut, not fail the import: %v", err)
	}
	if len(res.Entities) != 1 {
		t.Errorf("got %d entities, want 1", len(res.Entities))
	}
	if res.SkippedCycles == 0 {
		t.Error("the cycle should have been reported")
	}
}

// A hostile MINSERT header can claim a 65535×65535 array. The cap has to
// bite before the expansion is attempted, not after.
func TestFlattenCapsArrayExpansion(t *testing.T) {
	d := blockDoc()
	d.Entities = []Entity{
		&Insert{
			Common:        Common{Layer: "WALLS", Extrusion: ZAxis},
			BlockName:     "DESK",
			Scale:         Vec3{1, 1, 1},
			ColumnCount:   65535,
			RowCount:      65535,
			ColumnSpacing: 1,
			RowSpacing:    1,
		},
	}
	opts := DefaultFlattenOptions()
	opts.MaxEntities = 1000

	res, err := d.Flatten(opts)
	if err == nil {
		t.Fatal("expected a truncation error")
	}
	if !res.Truncated {
		t.Error("result should be marked truncated")
	}
	if len(res.Entities) > opts.MaxEntities {
		t.Errorf("emitted %d entities, cap was %d", len(res.Entities), opts.MaxEntities)
	}
}

func TestFlattenReportsMissingBlocksAndXrefs(t *testing.T) {
	d := blockDoc()
	d.AddBlock(&Block{Name: "SITE", External: true, ExternalPath: "../site-plan.dwg"})
	d.Entities = []Entity{
		&Insert{Common: Common{Layer: "WALLS", Extrusion: ZAxis}, BlockName: "GONE", Scale: Vec3{1, 1, 1}},
		&Insert{Common: Common{Layer: "WALLS", Extrusion: ZAxis}, BlockName: "SITE", Scale: Vec3{1, 1, 1}},
	}

	res, err := d.Flatten(DefaultFlattenOptions())
	if err != nil {
		t.Fatal(err)
	}
	// "Things are missing" is the only complaint a CAD import gets, so
	// the reason has to survive to the UI.
	if len(res.MissingBlocks) != 1 || res.MissingBlocks[0] != "GONE" {
		t.Errorf("missing blocks = %v, want [GONE]", res.MissingBlocks)
	}
	if len(res.MissingXrefs) != 1 || res.MissingXrefs[0] != "../site-plan.dwg" {
		t.Errorf("missing xrefs = %v, want [../site-plan.dwg]", res.MissingXrefs)
	}
}

func TestUnitsResolveFromHeader(t *testing.T) {
	h := Header{Units: UnitsMillimeters}
	u, mpu, known := ResolveUnits(h, Vec3{42000, 30000, 0})
	if !known {
		t.Error("a declared unit is known, not guessed")
	}
	if u != UnitsMillimeters {
		t.Errorf("units = %v, want millimeters", u)
	}
	nearly(t, mpu, 0.001, "metres per unit")
}

// $INSUNITS is template metadata, and a template outlives the decision
// it recorded. One of the DWG reader's fixtures is a flat that declares
// millimetres and measures 38 units across — 38 mm, which is not a
// building, and which the drawing's own geometry says is wrong.
//
// The declaration has to lose that argument. Obeyed, it imports the flat
// at a thousandth of its size, and the only symptom is a building nobody
// can find on the map: no error, no warning, nothing to search for.
func TestUnitsDeclarationLosesToContradictingGeometry(t *testing.T) {
	h := Header{Units: UnitsMillimeters, Measurement: MeasurementMetric}
	u, mpu, known := ResolveUnits(h, Vec3{37.7, 21.2, 0})
	if u != UnitsMeters {
		t.Errorf("units = %v, want meters — 37.7 mm is not a flat", u)
	}
	nearly(t, mpu, 1, "metres per unit")
	// Metres is the only candidate here within a factor of e of a
	// building, so the substitution is safe to make without asking.
	if !known {
		t.Error("metres is the sole plausible reading, so this is not a coin toss")
	}
}

// The falsification only fires when there is something better to say.
// A drawing of a bracket really is 40 mm across, and a unit we cannot
// justify is not an improvement on one the file at least asserted.
func TestUnitsDeclarationSurvivesWhenNoCandidateIsPlausible(t *testing.T) {
	h := Header{Units: UnitsMillimeters, Measurement: MeasurementMetric}
	// 0.04 units is 40 microns in millimetres and smaller in everything
	// else, so no candidate describes a building and the file's own
	// answer is the only one on offer.
	u, mpu, known := ResolveUnits(h, Vec3{0.04, 0.03, 0})
	if u != UnitsMillimeters || !known {
		t.Errorf("units = %v known = %v, want millimeters known", u, known)
	}
	nearly(t, mpu, 0.001, "metres per unit")
}

// Overriding a declaration does not license guessing. 500 units is a
// building in feet, in inches and in metres alike, so replacing the
// contradicted millimetres with any one of them is a coin toss — and the
// caller has to be told to ask rather than handed a number three
// readings deep in ambiguity.
func TestUnitsContradictedDeclarationStillDefersWhenAmbiguous(t *testing.T) {
	h := Header{Units: UnitsMillimeters, Measurement: MeasurementMetric}
	u, _, known := ResolveUnits(h, Vec3{500, 400, 0})
	if u == UnitsMillimeters {
		t.Error("0.5 m is not a building; the declaration should have been set aside")
	}
	if known {
		t.Error("three plausible readings is not confidence")
	}
}

func TestUnitsGuessedFromExtents(t *testing.T) {
	// 42 000 units across. Millimetres gives 42 m — a building.
	// Metres would give 42 km, inches 1 km, feet 12 km: all absurd.
	guesses := GuessUnits(Vec3{42000, 30000, 0}, MeasurementMetric)
	if len(guesses) == 0 {
		t.Fatal("expected candidates")
	}
	if guesses[0].Units != UnitsMillimeters {
		t.Errorf("top guess = %v, want millimeters", guesses[0].Units)
	}
	if !Confident(guesses) {
		t.Error("only one candidate is plausible here, so this should be confident")
	}
}

func TestUnitsGuessIsNotConfidentWhenAmbiguous(t *testing.T) {
	// 500 units is 0.5 m in mm, 500 m in metres, 12.7 m in inches and
	// 152 m in feet. Several are buildings, so silently picking one
	// would be wrong by a factor of 30 with no visible symptom.
	guesses := GuessUnits(Vec3{500, 400, 0}, MeasurementMetric)
	if Confident(guesses) {
		t.Error("multiple plausible candidates must not be treated as confident")
	}
}

func TestBoundsUsesArcsNotChords(t *testing.T) {
	// A closed polyline whose single segment bulges into a semicircle.
	p := &Polyline{
		Vertices: []Vertex{
			{Point: Vec3{0, 0, 0}, Bulge: 1},
			{Point: Vec3{2, 0, 0}},
		},
		Closed: false,
	}
	b := Bounds([]Entity{p})
	// The chord alone would give a zero-height box.
	nearly(t, b.Min.Y, -1, "min.Y — the bulge must contribute")
	nearly(t, b.Max.Y, 0, "max.Y")
	nearly(t, b.Min.X, 0, "min.X")
	nearly(t, b.Max.X, 2, "max.X")
}

func TestEllipseBoundsRotated(t *testing.T) {
	// A 2×1 ellipse rotated 90°: the major axis now runs along Y.
	e := &Ellipse{
		Center:     Vec3{},
		MajorAxis:  Vec3{0, 2, 0},
		Ratio:      0.5,
		StartParam: 0,
		EndParam:   2 * math.Pi,
	}
	b := ellipseBounds(e)
	nearly(t, b.Max.Y, 2, "max.Y")
	nearly(t, b.Min.Y, -2, "min.Y")
	nearly(t, b.Max.X, 1, "max.X")
	nearly(t, b.Min.X, -1, "min.X")
}

// A mirrored block flips its extrusion to (0,0,-1) and stores its
// coordinates in that plane. Skipping the change of basis lands the
// geometry reflected about the wrong axis, which looks plausible until
// you compare it with the original.
func TestArbitraryAxisHandlesFlippedExtrusion(t *testing.T) {
	m := ArbitraryAxis(Vec3{0, 0, -1})
	got := m.Point(Vec3{1, 0, 0})
	// The algorithm's own choice of reference axis decides where X
	// lands; what must hold is that the basis is orthonormal and
	// right-handed about the given normal.
	nearly(t, got.Length(), 1, "transformed unit vector stays unit length")
	nearly(t, determinant2D(m)*m[10], 1, "basis is orthonormal")
	nearly(t, m[10], -1, "normal maps to -Z")
}
