package cad

// Kind names an entity type. Strings rather than an enum: these end up
// in API responses and log lines, where "lwpolyline" is worth more than
// a number nobody can decode without the source.
type Kind string

const (
	KindLine     Kind = "line"
	KindPolyline Kind = "polyline"
	KindArc      Kind = "arc"
	KindCircle   Kind = "circle"
	KindEllipse  Kind = "ellipse"
	KindSpline   Kind = "spline"
	KindPoint    Kind = "point"
	KindText     Kind = "text"
	KindInsert   Kind = "insert"
	KindSolid    Kind = "solid"
)

// Entity is one drawable object.
//
// The set is deliberately small. A DWG can hold hundreds of object
// types, but a floor plan reduced to what a map needs is lines, arcs,
// polylines and labels — the rest either decomposes into those
// (dimensions, hatches, leaders) or is annotation we drop. Adding a type
// here means committing to render it everywhere, so the bar is that a
// real drawing loses meaning without it.
type Entity interface {
	Kind() Kind
	// Base exposes the shared attributes for reading and rewriting. It
	// returns a pointer because Flatten resolves ByLayer/ByBlock
	// inheritance in place on cloned entities.
	Base() *Common
}

// Common is the attribute set every entity carries.
type Common struct {
	// Handle is the file's own identifier. Preserved so an import can be
	// traced back to a specific object in the source drawing when a user
	// reports that one thing came through wrong.
	Handle uint64

	// Layer is the layer name. Empty means the default layer "0".
	Layer string

	Color        Color
	Linetype     string
	LineWeightMM float64

	// Extrusion is the entity's OCS normal. ZAxis for anything authored
	// flat, which is nearly everything; see ArbitraryAxis for why the
	// exceptions matter.
	Extrusion Vec3

	// Invisible is set for entities the file explicitly hides. Distinct
	// from a hidden layer — this is per-object.
	Invisible bool
}

// Base satisfies the shared half of Entity for every embedder.
func (c *Common) Base() *Common { return c }

// Line is a straight segment. The most common entity in any plan, and
// the one walls are usually made of.
type Line struct {
	Common
	Start, End Vec3
}

func (*Line) Kind() Kind { return KindLine }

// Vertex is one node of a polyline.
type Vertex struct {
	Point Vec3

	// Bulge encodes a circular arc from this vertex to the next as
	// tan(θ/4). Zero is a straight segment. See ArcFromBulge.
	Bulge float64

	// StartWidth/EndWidth are per-segment widths in drawing units. Rare
	// in plans but load-bearing where they appear: a polyline with width
	// is how some authors draw walls instead of drawing two lines.
	StartWidth, EndWidth float64
}

// Polyline covers both LWPOLYLINE and the older 2D POLYLINE. They differ
// only in storage — the same geometry either way — so the model keeps
// one type and the readers normalise into it.
type Polyline struct {
	Common
	Vertices []Vertex
	Closed   bool

	// ConstWidth applies to every segment when the vertices carry no
	// widths of their own.
	ConstWidth float64

	// Elevation is the polyline's Z in its OCS. LWPOLYLINE stores 2D
	// vertices plus this single elevation rather than a Z per vertex.
	Elevation float64
}

func (*Polyline) Kind() Kind { return KindPolyline }

// ArcEntity is a circular arc, swept counter-clockwise from StartAngle
// to EndAngle.
//
// Named to leave the bare Arc for the geometry helper in geom.go, which
// is what everything that consumes curves actually works with — the
// helper is the shared form that bulges, ellipses and this all reduce
// to.
type ArcEntity struct {
	Common
	Center               Vec3
	Radius               float64
	StartAngle, EndAngle float64
}

func (*ArcEntity) Kind() Kind { return KindArc }

// Geometry returns the arc in the shared curve form.
func (a *ArcEntity) Geometry() Arc {
	return Arc{Center: a.Center, Radius: a.Radius, StartAngle: a.StartAngle, EndAngle: a.EndAngle}
}

// Circle is a full circle. Columns, bollards, pipe penetrations.
type Circle struct {
	Common
	Center Vec3
	Radius float64
}

func (*Circle) Kind() Kind { return KindCircle }

// Ellipse is a full or partial ellipse.
//
// MajorAxis is a vector from the centre to the end of the major axis, so
// it carries the ellipse's rotation as well as its size — there is no
// separate rotation field. Ratio is the minor axis as a fraction of the
// major, in (0,1].
type Ellipse struct {
	Common
	Center    Vec3
	MajorAxis Vec3
	Ratio     float64

	// StartParam/EndParam bound the swept portion in the ellipse's
	// parametric space, 0 to 2π for a full ellipse.
	StartParam, EndParam float64
}

func (*Ellipse) Kind() Kind { return KindEllipse }

// Spline is a NURBS curve. Kerbs, landscaping, ducting runs and the
// sweeping walls of anything that is not a rectangle.
//
// A drawing states one of two ways, and they are not interchangeable.
// The control form (ControlPoints + Knots, optionally Weights) defines
// the curve exactly and is what an evaluator wants. The fit form
// (FitPoints) names points the curve passes through and leaves the
// control net to be recomputed — a statement of intent rather than of
// geometry. A file may carry both, in which case the control form is
// authoritative because it is what the application last drew.
//
// Nothing here is in a plane: a spline is the one curve in this package
// that can genuinely leave one, so there is no Extrusion-relative form
// to undo.
type Spline struct {
	Common
	Degree int

	Closed   bool
	Periodic bool

	ControlPoints []Vec3
	// Weights is empty for a non-rational spline, which is the ordinary
	// case; when present it is one per control point.
	Weights []float64
	Knots   []float64

	FitPoints []Vec3
}

func (*Spline) Kind() Kind { return KindSpline }

// Point is a single node. Usually a survey point or a snap target.
type Point struct {
	Common
	Position Vec3
}

func (*Point) Kind() Kind { return KindPoint }

// Horizontal and vertical text justification, matching the DXF codes 72
// and 73 that both formats share.
type (
	HAlign uint8
	VAlign uint8
)

const (
	HAlignLeft HAlign = iota
	HAlignCenter
	HAlignRight
	HAlignAligned
	HAlignMiddle
	HAlignFit
)

const (
	VAlignBaseline VAlign = iota
	VAlignBottom
	VAlignMiddle
	VAlignTop
)

// Text covers both TEXT and MTEXT.
//
// One type rather than two because every consumer treats them the same —
// a string at a place, at a size, at an angle — and the fields MTEXT
// adds are additive rather than contradictory. The Multiline flag says
// which the file held, because MTEXT's Value carries inline formatting
// codes that a renderer has to strip.
type Text struct {
	Common
	Position Vec3
	Value    string
	Height   float64

	// Rotation is counter-clockwise in radians.
	Rotation float64

	// WidthFactor horizontally stretches glyphs; Oblique slants them.
	WidthFactor float64
	Oblique     float64

	Style  string
	HAlign HAlign
	VAlign VAlign

	// AlignPoint is the secondary point used by the aligned/fit/centred
	// justifications, where Position alone does not locate the text.
	AlignPoint Vec3
	HasAlign   bool

	Multiline bool
	// RectWidth is MTEXT's wrap width, zero when unbounded.
	RectWidth float64
}

func (*Text) Kind() Kind { return KindText }

// Insert places a Block.
//
// Ignoring these is the classic way to write an importer that opens
// every file and shows almost nothing: a plan's doors, windows,
// fixtures and often its entire grid are block references, and model
// space holds only the inserts. See Flatten.
type Insert struct {
	Common
	BlockName string
	Position  Vec3
	Scale     Vec3
	Rotation  float64

	// Column/Row describe a rectangular array (MINSERT), a compact way to
	// place a repeated fixture. One for a plain insert.
	ColumnCount, RowCount     int
	ColumnSpacing, RowSpacing float64
}

func (*Insert) Kind() Kind { return KindInsert }

// Solid is a filled triangle or quad — SOLID, TRACE and 3DFACE all
// reduce to this. Poché-filled walls and hatched columns arrive as
// these, so dropping them loses the visual weight that makes a plan
// readable.
//
// Corners is 3 or 4 points in drawing order. Note that SOLID's native
// vertex order is a bow tie (0,1,3,2); readers untangle it so this is
// always a simple polygon.
type Solid struct {
	Common
	Corners []Vec3
}

func (*Solid) Kind() Kind { return KindSolid }
