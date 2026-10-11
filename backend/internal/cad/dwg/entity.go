package dwg

import (
	"fmt"
	"math"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// Every drawable object opens with the same block of attributes — who
// owns it, what colour it is, whether it is visible — and only then the
// fields particular to its type. The shared part is not a fixed-size
// header: nearly every field in it is variable-length, and several are
// present only for certain releases, so it has to be decoded rather than
// skipped.
//
// Implemented from the Open Design Alliance's specification §2.4.5.

// entityHeader is the shared attribute block, decoded.
//
// It carries more than the attributes an entity ends up with, because
// the handle stream that follows the data is not self-describing: which
// handles are present, and how many, is stated only here. Reading the
// references therefore requires having read the data first, and the
// flags below are the part of the data that says so.
type entityHeader struct {
	color         cad.Color
	linetypeScale float64
	invisible     bool
	lineWeight    byte

	entMode      uint64
	numReactors  uint32
	xdicMissing  bool
	colorBook    bool
	linetypeFlag uint64
	plotStyle    uint64
	material     uint64
	shadow       uint64
	visualStyle  [3]bool
}

// readEntityHeader consumes the common block, leaving the reader on the
// first type-specific field.
func readEntityHeader(b *bitReader, v Version) entityHeader {
	readEED(b)

	// A saved preview bitmap. Rare, but when present it is bulky, and
	// skipping it by its declared length is the only way past.
	if b.bit() == 1 {
		var n uint64
		if v.AtLeast(R2010) {
			n = b.bll()
		} else {
			n = uint64(b.rl())
		}
		b.rawBytes(int(n))
	}

	var h entityHeader
	h.entMode = b.bb()     // whether the owner handle is stated or implied
	h.numReactors = b.bl() // how many reactor handles follow the data
	h.xdicMissing = true   // the default for the releases with no flag
	if v.AtLeast(R2004) {
		h.xdicMissing = b.bit() == 1
	}
	if v.AtLeast(R2013) {
		b.bit() // data store data present
	}

	h.color, h.colorBook = readEntityColor(b, v)
	h.linetypeScale = b.bd()

	if v.AtLeast(R2000) {
		// 3 means a handle follows in the handle stream; the other values
		// name ByLayer, ByBlock or continuous outright.
		h.linetypeFlag = b.bb()
		h.plotStyle = b.bb()
	}
	if v.AtLeast(R2007) {
		h.material = b.bb()  // same encoding
		h.shadow = b.bits(8) // shadow casting and receiving
	}
	if v.AtLeast(R2010) {
		h.visualStyle[0] = b.bit() == 1 // full
		h.visualStyle[1] = b.bit() == 1 // face
		h.visualStyle[2] = b.bit() == 1 // edge
	}

	h.invisible = b.bs() == 1
	if v.AtLeast(R2000) {
		h.lineWeight = byte(b.bits(8))
	}
	return h
}

// readEED skips extended entity data: per-application blobs an add-on
// attached to the entity. The content is the add-on's business, but the
// framing is ours — the block has to be stepped over exactly or every
// field after it is misread.
func readEED(b *bitReader) {
	// The list ends at a zero length. A cap as well, because a corrupt
	// length that happens to be non-zero would otherwise spin until the
	// reader ran out of object.
	for range 1024 {
		size := b.bs()
		if size == 0 || b.Err() != nil {
			return
		}
		b.h() // the application that wrote this block
		b.rawBytes(int(size))
	}
	b.fail(fmt.Errorf("%w: extended entity data does not terminate", ErrMalformed))
}

// readEntityColor reads the entity colour. R2004 replaced the plain
// index with a form that can also carry a true colour, flagged in the
// high byte of the same short. It reports whether the colour is a
// colour-book entry, because that costs a handle in the other stream.
func readEntityColor(b *bitReader, v Version) (cad.Color, bool) {
	if !v.AtLeast(R2004) {
		return b.cmc(v), false
	}
	raw := b.bs()
	c := cad.Color{Index: int16(raw & 0x1FF)}
	flags := raw >> 8

	// Flag 0x40 names a colour-book entry, which is a separate object
	// named from the handle stream. It also suppresses the inline value
	// that 0x80 would otherwise introduce: the entry the handle points at
	// is the whole definition, so there is nothing left to say here.
	// Reading the notional true colour anyway — which is what the flags
	// taken independently would suggest — consumes 10 bits that are not
	// there and lands the decoder in the middle of the first coordinate.
	if flags&0x40 != 0 {
		return c, true
	}
	if flags&0x80 != 0 {
		c.RGB = b.bl() & 0xFFFFFF
		c.HasRGB = true
	}
	if flags&0x20 != 0 {
		b.bl() // transparency
	}
	return c, false
}

// common fills the parts of cad.Common the shared block supplies.
func (h entityHeader) common(o *object) cad.Common {
	return cad.Common{
		Handle:    o.Handle,
		Color:     h.color,
		Invisible: h.invisible,
		Extrusion: cad.Vec3{Z: 1},
	}
}

// part is what one object contributed to the drawing.
//
// Most objects contribute nothing: a drawing is mostly bookkeeping.
// A drawable object contributes itself. A VERTEX contributes a fragment
// that is not drawable on its own and means something only inside the
// polyline that names it, which is why it arrives separately rather than
// as an Entity — the model has no place for a loose vertex, and emitting
// one would put 90,000 stray points into a drawing of lockers.
type part struct {
	Entity cad.Entity
	Vertex *cad.Vertex
	Refs   entityRefs

	// Skipped marks an object abandoned mid-record rather than decoded.
	// The drawing is still returned without it; see the landing check.
	Skipped bool
}

// readEntity decodes one object into the drawing model. It returns an
// empty part for objects that are not drawable geometry — the table
// records, the dictionaries, the types not handled yet — which is a
// routine outcome rather than an error: a drawing is mostly bookkeeping,
// and refusing to open a file because it contains a LAYOUT would be
// absurd.
func readEntity(o *object) (part, error) {
	// The type is checked before anything is read, because the shared
	// block above belongs to entities alone. A table record or a
	// dictionary opens differently, and running an entity's layout over
	// one produces an error that looks like a corrupt file rather than
	// what it is.
	switch o.Type {
	case typeArc, typeCircle, typeLine, typePoint, typeLWPolyline,
		typePolyline2D, typePolyline3D, typeVertex2D, typeVertex3D, typeSeqend,
		typeInsert, typeMinsert, typeBlock, typeEndblk, typeText, typeMText,
		typeEllipse, typeSpline, typeAttrib, typeAttdef, typeSolid:
	default:
		return part{}, nil
	}

	b := o.data
	h := readEntityHeader(b, o.Version)
	if err := b.Err(); err != nil {
		return part{}, fmt.Errorf("%s %#x common data: %w", typeName(o.Type), o.Handle, err)
	}

	var p part
	var owned int
	var hasAttribs, hasAppID bool
	var err error
	switch o.Type {
	case typeLine:
		p.Entity = readLine(b, o.Version, h.common(o))
	case typePoint:
		p.Entity = readPoint(b, h.common(o))
	case typeCircle:
		p.Entity = readCircle(b, h.common(o))
	case typeArc:
		p.Entity = readArc(b, h.common(o))
	case typeEllipse:
		p.Entity = readEllipse(b, h.common(o))
	case typeSolid:
		p.Entity = readSolid(b, h.common(o))
	case typeSpline:
		p.Entity, err = readSpline(b, o.Version, h.common(o))
	case typeText:
		p.Entity = readText(objectStreams(o), o.Version, h.common(o))
	case typeAttrib, typeAttdef:
		p.Entity = readAttribute(objectStreams(o), o.Version, h.common(o), o.Type == typeAttdef)
	case typeMText:
		p.Entity, hasAppID = readMText(objectStreams(o), o.Version, h.common(o))
	case typeLWPolyline:
		p.Entity, err = readLWPolyline(b, o.Version, h.common(o))
	case typePolyline2D:
		p.Entity, owned = readPolyline2D(b, o.Version, h.common(o))
	case typePolyline3D:
		p.Entity, owned = readPolyline3D(b, o.Version, h.common(o))
	case typeVertex2D:
		p.Vertex = readVertex2D(b, o.Version)
	case typeVertex3D:
		p.Vertex = readVertex3D(b)
	case typeInsert:
		p.Entity, owned, hasAttribs = readInsert(b, o.Version, h.common(o), false)
	case typeMinsert:
		p.Entity, owned, hasAttribs = readInsert(b, o.Version, h.common(o), true)
	case typeBlock:
		readBlockName(o)
	case typeSeqend, typeEndblk:
		// These carry nothing but the shared block: SEQEND closes a chain of
		// vertices or attributes, ENDBLK closes a block definition. They are
		// decoded rather than skipped so that the two assertions below cover
		// them, which is the cheapest possible check that the shared block is
		// still being read correctly.
	}
	if err == nil {
		err = b.Err()
	}
	if err != nil {
		return part{}, fmt.Errorf("%s %#x: %w", typeName(o.Type), o.Handle, err)
	}

	// The data region has a known end, so a decoder that read the right
	// number of fields lands on it exactly. Checking here rather than
	// only in the tests is what keeps a misread entity from reaching the
	// model as plausible-looking geometry: every field of this type
	// decodes to *some* number, and nothing else downstream can tell
	// that the numbers came from the wrong bits.
	if got, want := b.bitPos(), o.dataStop(); got != want {
		// An attribute is the one place this is survivable. R2010 added a
		// multiline form that embeds a whole MTEXT inside the record, no
		// fixture here contains one, and nothing in the single-line layout
		// announces it — so the first drawing that has one would otherwise
		// fail whole over a label. Geometry gets no such latitude: a plan
		// silently missing a wall is worse than one that will not open.
		//
		// The escape is narrow enough to stay honest, because every
		// attribute in every fixture lands exactly, and the entity test
		// asserts that none of them takes this path.
		if o.Type == typeAttrib || o.Type == typeAttdef {
			return part{Skipped: true}, nil
		}
		return part{}, fmt.Errorf("%w: %s %#x ends at bit %d, data ends at %d (off by %d)",
			ErrMalformed, typeName(o.Type), o.Handle, got, want, got-want)
	}

	p.Refs, err = readEntityRefs(o, h)
	if err != nil {
		return part{}, fmt.Errorf("%s %#x references: %w", typeName(o.Type), o.Handle, err)
	}
	switch o.Type {
	case typeText, typeAttrib, typeAttdef:
		b.h() // the STYLE the text is drawn in
		if err := b.Err(); err != nil {
			return part{}, fmt.Errorf("%s %#x style: %w", typeName(o.Type), o.Handle, err)
		}
	case typeMText:
		b.h() // the STYLE the text is drawn in
		if hasAppID {
			b.h() // the application that wrote the R2018 block
		}
		if err := b.Err(); err != nil {
			return part{}, fmt.Errorf("MTEXT %#x style: %w", o.Handle, err)
		}
	case typePolyline2D, typePolyline3D:
		p.Refs.Children, err = readPolylineRefs(b, o.Version, owned)
		if err != nil {
			return part{}, fmt.Errorf("%s %#x vertices: %w", typeName(o.Type), o.Handle, err)
		}
	case typeInsert, typeMinsert:
		p.Refs.Block, err = readInsertRefs(b, o.Version, owned, hasAttribs)
		if err != nil {
			return part{}, fmt.Errorf("%s %#x block reference: %w", typeName(o.Type), o.Handle, err)
		}
		p.Refs.HasBlock = true
	}

	// The handle stream has no length of its own — it simply runs to the
	// end of the object — but the object is padded to a byte, so a
	// decoder that read the right handles finishes within seven bits of
	// the end. It cannot finish that close having read one handle too
	// few, because the shortest handle is a byte. That makes this as
	// exact a check as the one on the data above.
	//
	// It belongs to the entity rather than to the shared block, because
	// only the type knows whether it has references of its own: the five
	// single-object geometries have none, but POLYLINE names every one of
	// its vertices here, and INSERT will name its block. Those have to be
	// read before this holds — which makes the check strongest exactly
	// where it is needed most, since a polyline's handle list is the one
	// place a miscount is otherwise invisible.
	if slack := o.totalBits - b.bitPos(); slack >= 8 {
		return part{}, fmt.Errorf("%w: %s %#x leaves %d bits of handle stream unread",
			ErrMalformed, typeName(o.Type), o.Handle, slack)
	}
	return p, nil
}

// The types decoded so far. Named rather than inline so the switch above
// reads as geometry rather than as arithmetic.
const (
	typeText       = 0x01
	typeAttrib     = 0x02
	typeAttdef     = 0x03
	typeSeqend     = 0x06
	typeMText      = 0x2C
	typeVertex2D   = 0x0A
	typeVertex3D   = 0x0B
	typePolyline2D = 0x0F
	typePolyline3D = 0x10
	typeArc        = 0x11
	typeCircle     = 0x12
	typeLine       = 0x13
	typePoint      = 0x1B
	typeSolid      = 0x1F
	typeEllipse    = 0x23
	typeSpline     = 0x24
	typeLWPolyline = 0x4D
)

// readLine decodes a LINE. R2000 changed the encoding to exploit the
// fact that a line's two ends usually share most of their bits: the
// start arrives whole and the end as a delta, and a flag collapses the Z
// pair entirely for the flat lines that make up a plan.
func readLine(b *bitReader, v Version, c cad.Common) *cad.Line {
	l := &cad.Line{Common: c}
	if !v.AtLeast(R2000) {
		l.Start.X, l.Start.Y, l.Start.Z = b.bd3()
		l.End.X, l.End.Y, l.End.Z = b.bd3()
	} else {
		flat := b.bit() == 1
		l.Start.X = b.rd()
		l.End.X = b.dd(l.Start.X)
		l.Start.Y = b.rd()
		l.End.Y = b.dd(l.Start.Y)
		if !flat {
			l.Start.Z = b.rd()
			l.End.Z = b.dd(l.Start.Z)
		}
	}
	b.bt() // thickness
	l.Extrusion.X, l.Extrusion.Y, l.Extrusion.Z = b.be()
	return l
}

func readPoint(b *bitReader, c cad.Common) *cad.Point {
	p := &cad.Point{Common: c}
	p.Position.X, p.Position.Y, p.Position.Z = b.bd3()
	b.bt() // thickness
	p.Extrusion.X, p.Extrusion.Y, p.Extrusion.Z = b.be()
	b.bd() // rotation of the point's display marker, not of any geometry
	return p
}

// readSolid decodes a SOLID: the filled triangle or quad a plan uses for
// poché — the blacked-in core of a wall, a hatched column, the solid
// head of a leader. Dropping them costs a plan the visual weight that
// distinguishes structure from furniture, which is most of what makes
// one readable at a glance.
//
// The corners arrive as a bow tie. The file stores them in the order a
// pair of triangles wants — 0 and 1 along one edge, 2 and 3 along the
// opposite one — so joining them in file order draws a figure that
// crosses itself. Reordering to 0,1,3,2 gives the simple polygon
// everything downstream assumes, and is why cad.Solid documents an order
// of its own.
//
// The corners are 2D: all four share the one elevation, in the entity's
// own coordinate system. That is the whole reason SOLID is not a
// polygon with a fill flag — it cannot leave its plane.
func readSolid(b *bitReader, c cad.Common) *cad.Solid {
	s := &cad.Solid{Common: c}
	b.bt() // thickness
	z := b.bd()
	var corner [4]cad.Vec3
	for i := range corner {
		corner[i] = cad.Vec3{X: b.rd(), Y: b.rd(), Z: z}
	}
	s.Extrusion.X, s.Extrusion.Y, s.Extrusion.Z = b.be()
	s.Corners = solidRing(corner)
	return s
}

// solidRing untangles a SOLID's four stored corners into a ring.
//
// Separated from the decode because it is the one part of readSolid the
// bits cannot arbitrate: the reorder happens after every field has been
// consumed, so a decoder that skipped it would land exactly the same and
// pass the landing assertion in full. Every solid in this corpus is a
// triangle, for which the two orders coincide — so the quad case is
// proved by TestSolidRingUntanglesABowTie against a constructed one
// rather than by any fixture, and pulling the arithmetic out is what
// makes that possible.
func solidRing(corner [4]cad.Vec3) []cad.Vec3 {
	// A triangle is written as a quad whose last two corners coincide,
	// which is how the format avoids needing a second type. Keeping the
	// duplicate would hand the polygon a zero-length edge, and nothing
	// downstream has a reason to expect one.
	if corner[2] == corner[3] {
		return []cad.Vec3{corner[0], corner[1], corner[2]}
	}
	return []cad.Vec3{corner[0], corner[1], corner[3], corner[2]}
}

func readCircle(b *bitReader, c cad.Common) *cad.Circle {
	e := &cad.Circle{Common: c}
	e.Center.X, e.Center.Y, e.Center.Z = b.bd3()
	e.Radius = b.bd()
	b.bt() // thickness
	e.Extrusion.X, e.Extrusion.Y, e.Extrusion.Z = b.be()
	return e
}

// readEllipse decodes an ELLIPSE.
//
// Nothing here is compressed or optional, which makes it the plainest
// decoder in the file — but note the extrusion is a full 3BD rather than
// the one-bit BE almost every other entity spends, the same exception
// INSERT makes. There is no rotation field: the major axis is a vector
// from the centre, so it states the orientation and the size together.
func readEllipse(b *bitReader, c cad.Common) *cad.Ellipse {
	e := &cad.Ellipse{Common: c}
	e.Center.X, e.Center.Y, e.Center.Z = b.bd3()
	e.MajorAxis.X, e.MajorAxis.Y, e.MajorAxis.Z = b.bd3()
	e.Extrusion.X, e.Extrusion.Y, e.Extrusion.Z = b.bd3()
	e.Ratio = b.bd()
	e.StartParam = b.bd()
	e.EndParam = b.bd()
	return e
}

// A spline's arrays are read from counts in the file, so they are capped
// before anything is allocated. The bound is generous — a surveyed
// contour legitimately runs to thousands of control points — and exists
// only to stop a corrupt count from reaching make().
const splineMaxPoints = 1 << 20

// How a SPLINE states itself. The two scenarios are alternatives, not
// stages: 1 is the control net that defines the curve exactly, 2 is the
// points it was drawn through with the net left to be recomputed.
const (
	splineScenarioControl = 1
	splineScenarioFit     = 2
)

// readSpline decodes a SPLINE.
//
// The shape of this one is unusual in that almost none of it is present
// at once: a spline states itself either as a control net or as the
// points it passes through, and the fields of the other scenario are
// simply not written. Both branches then share the trailing arrays,
// whose lengths come from counts read in the branch above — the same
// arrangement as LWPOLYLINE, and the same reason every count is capped
// before it reaches an allocation.
func readSpline(b *bitReader, v Version, c cad.Common) (*cad.Spline, error) {
	s := &cad.Spline{Common: c}

	scenario := b.bl()
	if v.AtLeast(R2013) {
		b.bl() // spline flags: which of the fit fields the editor last set
		b.bl() // knot parameterisation: chord length, square root, uniform
	}
	s.Degree = int(b.bl())

	var numKnots, numCtrl, numFit uint32
	var weighted bool
	switch scenario {
	case splineScenarioFit:
		b.bd()  // fit tolerance
		b.bd3() // start tangent
		b.bd3() // end tangent
		numFit = b.bl()
	case splineScenarioControl:
		b.bit() // rational: implied by the weights, which are flagged below
		s.Closed = b.bit() == 1
		s.Periodic = b.bit() == 1
		b.bd() // knot tolerance
		b.bd() // control point tolerance
		numKnots = b.bl()
		numCtrl = b.bl()
		weighted = b.bit() == 1
	default:
		return nil, fmt.Errorf("%w: SPLINE scenario %d is neither a control net nor a fit list",
			ErrMalformed, scenario)
	}
	if numKnots > splineMaxPoints || numCtrl > splineMaxPoints || numFit > splineMaxPoints {
		return nil, fmt.Errorf("%w: SPLINE claims %d knots, %d control points and %d fit points",
			ErrMalformed, numKnots, numCtrl, numFit)
	}

	// The counts are honoured even if a read has already failed, because
	// the object's extent has to be consumed either way; bitReader latches
	// its error and returns zeros, so this cannot spin on garbage.
	s.Knots = make([]float64, 0, numKnots)
	for range numKnots {
		s.Knots = append(s.Knots, b.bd())
	}
	s.ControlPoints = make([]cad.Vec3, 0, numCtrl)
	if weighted {
		s.Weights = make([]float64, 0, numCtrl)
	}
	for range numCtrl {
		var p cad.Vec3
		p.X, p.Y, p.Z = b.bd3()
		s.ControlPoints = append(s.ControlPoints, p)
		if weighted {
			s.Weights = append(s.Weights, b.bd())
		}
	}
	s.FitPoints = make([]cad.Vec3, 0, numFit)
	for range numFit {
		var p cad.Vec3
		p.X, p.Y, p.Z = b.bd3()
		s.FitPoints = append(s.FitPoints, p)
	}
	return s, nil
}

// Which of TEXT's fields were written. R2000 replaced eight always-present
// fields with a byte saying which of them differ from the obvious default —
// no elevation, justified at the insertion point, upright, unmirrored, unit
// width, left of the baseline — and a plan's labels are almost all default,
// so most of these bits are set on most of the text in a drawing.
//
// Note the sense: a set bit means the field is *absent*.
const (
	textNoElevation   = 0x01
	textAlignAtInsert = 0x02
	textNoOblique     = 0x04
	textNoRotation    = 0x08
	textUnitWidth     = 0x10
	textNoGeneration  = 0x20
	textLeftAligned   = 0x40
	textBaseline      = 0x80
)

// readText decodes a TEXT: one line of it, at a point, in a style.
//
// The string is the reason this takes the pair of streams rather than the
// data reader every other decoder here takes. Since R2007 an object's text
// lives in a separate stream at the end of the data, so reading the value
// must not advance the data cursor — and the landing assertion in
// readEntity would catch it immediately if it did, since the data stops
// exactly where the string stream starts.
func readText(s *streams, v Version, c cad.Common) *cad.Text {
	b := s.data
	t := &cad.Text{Common: c, WidthFactor: 1}

	if !v.AtLeast(R2000) {
		t.Position.Z = b.bd()
		t.Position.X, t.Position.Y = b.rd2()
		t.AlignPoint.X, t.AlignPoint.Y = b.rd2()
		t.HasAlign = true
		t.Extrusion.X, t.Extrusion.Y, t.Extrusion.Z = b.be()
		b.bt() // thickness
		t.Oblique = b.bd()
		t.Rotation = b.bd()
		t.Height = b.bd()
		t.WidthFactor = b.bd()
		t.Value = cad.PlainText(s.tv())
		b.bs() // generation: whether the glyphs are mirrored
		t.HAlign = cad.HAlign(b.bs())
		t.VAlign = cad.VAlign(b.bs())
		return t
	}

	flags := b.rc()
	if flags&textNoElevation == 0 {
		t.Position.Z = b.rd()
	}
	t.Position.X, t.Position.Y = b.rd2()

	// The alignment point is where the text sits when it is not justified
	// from its insertion point, and it is written as a delta against that
	// point because the two are usually close. Absent, the two coincide —
	// which is what HasAlign reports, since a consumer needs to know the
	// difference between "aligned here" and "aligned nowhere in particular".
	if flags&textAlignAtInsert == 0 {
		t.AlignPoint.X, t.AlignPoint.Y = b.dd2(t.Position.X, t.Position.Y)
		t.HasAlign = true
	} else {
		t.AlignPoint = t.Position
	}
	t.Extrusion.X, t.Extrusion.Y, t.Extrusion.Z = b.be()
	b.bt() // thickness
	if flags&textNoOblique == 0 {
		t.Oblique = b.rd()
	}
	if flags&textNoRotation == 0 {
		t.Rotation = b.rd()
	}
	t.Height = b.rd()
	if flags&textUnitWidth == 0 {
		t.WidthFactor = b.rd()
	}
	t.Value = cad.PlainText(s.tv())
	if flags&textNoGeneration == 0 {
		b.bs()
	}
	if flags&textLeftAligned == 0 {
		t.HAlign = cad.HAlign(b.bs())
	}
	if flags&textBaseline == 0 {
		t.VAlign = cad.VAlign(b.bs())
	}
	return t
}

// What an attribute's flag byte says about whether it is drawn.
// Invisible is carried without being shown — how a plan keeps a fixture's
// bill of materials attached to the fixture without printing it across
// the floor. Constant is the case where the definition has no answer to
// wait for, and so is itself what appears.
const (
	attrInvisible = 0x01
	attrConstant  = 0x02
)

// readAttribute decodes an ATTRIB or an ATTDEF.
//
// The two are one record with one field's difference, and the difference
// is in what they mean rather than in the bits. An ATTDEF is the
// *question* a block definition carries — a tag, a prompt, and a default
// to show until it is answered. An ATTRIB is the *answer*, written
// beside the insert that asked it. A plan's room numbers and door tags
// are therefore ATTRIBs, and the definitions behind them all say
// "ROOMNO".
//
// Which is why the definitions are decoded without being drawn, the way
// VERTEX is: emitting them stamps the placeholder at every insertion
// point of every block that declares one, and one fixture here holds 920
// definitions against 9 answers. The exception is the constant
// attribute, which by construction never receives an ATTRIB — so the
// definition is what a CAD application shows, and dropping it would lose
// text that is genuinely on the drawing. The corpus corroborates the
// reading rather than just permitting it: the nine constant tags in the
// restaurant fixture have no ATTRIB anywhere in the file, and the two
// variable ones do.
func readAttribute(s *streams, v Version, c cad.Common, def bool) cad.Entity {
	b := s.data
	t := readText(s, v, c)

	s.tv() // tag: which question this answers, not what it answers
	b.bs() // field length, which every writer here leaves at one value
	flags := b.rc()
	if v.AtLeast(R2007) {
		b.bit() // whether the answer may be dragged off its insert
	}
	if def {
		// One byte, zero in every record examined, which the
		// specification describes as a record version. It is read here
		// rather than at the front of the object where the specification
		// places it, because the fixtures put it here: a byte at the front
		// misaligns the text data on all 929 attributes in the R2018
		// fixture, and none at all leaves all 920 definitions eight bits
		// short. ATTRIB has no equivalent — its data ends exactly on the
		// lock bit.
		//
		// The prompt follows, and since R2007 costs the data cursor
		// nothing, so nothing observable distinguishes the two orders.
		if v.AtLeast(R2010) {
			b.rc()
		}
		s.tv() // prompt: what the block asks when it is inserted
	}

	// An unanswered question is not an answer. A blank value is ordinary —
	// 202 of the hotel plans' ROOM_NAME attributes are placeholders nobody
	// filled in — and it draws nothing, so emitting it puts invisible text
	// entities on the drawing at coordinates that mean nothing. It also
	// reads exactly like a misplaced string stream from the outside, so
	// dropping it here is what lets the decoder's own check stay at "every
	// string in the corpus is readable" rather than "most of them".
	if t.Value == "" || flags&attrInvisible != 0 || (def && flags&attrConstant == 0) {
		return nil
	}
	return t
}

// mtextAttachment splits MTEXT's single attachment code into the pair of
// justifications the model keeps. The code runs 1..9 across the corners
// and edges of the text box, reading left to right and top to bottom, so
// the two axes fall out of a division.
func mtextAttachment(code uint16) (cad.HAlign, cad.VAlign) {
	if code < 1 || code > 9 {
		return cad.HAlignLeft, cad.VAlignTop
	}
	code--
	rows := [3]cad.VAlign{cad.VAlignTop, cad.VAlignMiddle, cad.VAlignBottom}
	return cad.HAlign(code % 3), rows[code/3]
}

// readMText decodes an MTEXT: a paragraph rather than a line, wrapped to
// a width, with its own inline formatting language inside the value.
//
// It reports whether the object names a registered application in the
// handle stream, which only R2018 does and only for text that is not
// annotative. The caller has to be told rather than working it out,
// because the flag deciding it is in the data stream and the handle it
// costs is in the other one.
func readMText(s *streams, v Version, c cad.Common) (*cad.Text, bool) {
	b := s.data
	t := &cad.Text{Common: c, WidthFactor: 1, Multiline: true}

	t.Position.X, t.Position.Y, t.Position.Z = b.bd3()
	t.Extrusion.X, t.Extrusion.Y, t.Extrusion.Z = b.bd3()

	// MTEXT states its rotation as the direction its first line runs in
	// rather than as an angle. The vector carries the same information and
	// one fewer convention — there is no question of which way positive
	// turns — but the model keeps angles, so it is converted here.
	dx, dy, _ := b.bd3()
	t.Rotation = math.Atan2(dy, dx)

	t.RectWidth = b.bd()
	if v.AtLeast(R2007) {
		b.bd() // rectangle height
	}
	t.Height = b.bd()
	t.HAlign, t.VAlign = mtextAttachment(b.bs())
	b.bs() // drawing direction: left-to-right, top-to-bottom, or by style
	b.bd() // extents height, which is the laid-out result rather than input
	b.bd() // extents width
	t.Value = cad.PlainMText(s.tv())

	if v.AtLeast(R2000) {
		b.bs()  // line spacing style
		b.bd()  // line spacing factor
		b.bit() // unnamed by the specification and set on no fixture here
	}
	if v.AtLeast(R2004) {
		// The background is a filled box drawn behind the text. Its
		// description is present only when it is switched on and not
		// inherited, which is what the two flags below distinguish.
		flags := b.bl()
		if flags&mtextBackgroundFill != 0 && flags&mtextBackgroundInherit == 0 {
			b.bl()  // scale factor, as a percentage of the text height
			s.cmc() // fill colour
			b.bl()  // transparency
		}
	}

	var hasAppID bool
	if v.AtLeast(R2018) {
		// Annotative text scales with the viewport rather than with the
		// drawing, and R2018 records everything about it somewhere else.
		// So the flag is stated the negative way round: the block below is
		// present for ordinary text, and absent for the annotative kind.
		if b.bit() == 1 {
			hasAppID = true
			b.bs()  // class version
			b.bit() // default flag
			b.bl()  // attachment point, restated

			// The placement is then written a second time. The values agree
			// with the ones above on every fixture here; they are read to
			// step over, not to use, because a duplicate that disagreed
			// would be a question this reader has no way to settle.
			b.bd3()
			b.bd3()
			b.bd() // rectangle width
			b.bd() // rectangle height
			b.bd() // extents width
			b.bd() // extents height

			readMTextColumns(b)
		}
	}
	return t, hasAppID
}

// Background flags. The fill bit switches the box on; the inherit bit
// says to take the drawing's own background instead of a stated colour,
// which leaves nothing to state.
const (
	mtextBackgroundFill    = 0x01
	mtextBackgroundInherit = 0x10
)

// mtextMaxColumns caps the column count. It comes from the file and
// reaches a loop, so a corrupt value would otherwise be read as an
// instruction to keep reading until the object ran out.
const mtextMaxColumns = 1 << 12

// readMTextColumns steps over the newspaper-column layout. The model has
// no place for it — a column break is a rendering decision, and the text
// it breaks is already read — but its length varies, so it has to be
// decoded to reach the end of the object.
func readMTextColumns(b *bitReader) {
	const (
		columnsNone    = 0
		columnsDynamic = 2
	)
	kind := b.bs()
	if kind == columnsNone {
		return
	}
	count := b.bl()
	b.bd() // column width
	b.bd() // gutter between columns
	auto := b.bit() == 1
	b.bit() // flow reversed

	// Heights are listed only when the columns do not size themselves, and
	// only for the dynamic kind: static columns are all the same height,
	// which the height above already gave.
	if auto || kind != columnsDynamic {
		return
	}
	if count > mtextMaxColumns {
		b.fail(malformed("MTEXT claims %d columns", count))
		return
	}
	for range count {
		b.bd()
	}
}

func readArc(b *bitReader, c cad.Common) *cad.ArcEntity {
	a := &cad.ArcEntity{Common: c}
	a.Center.X, a.Center.Y, a.Center.Z = b.bd3()
	a.Radius = b.bd()
	b.bt() // thickness
	a.Extrusion.X, a.Extrusion.Y, a.Extrusion.Z = b.be()
	a.StartAngle = b.bd()
	a.EndAngle = b.bd()
	return a
}
