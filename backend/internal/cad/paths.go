package cad

import (
	"errors"
	"fmt"
	"math"
	"slices"
)

// Paths reduce a flattened drawing to the one shape a map can draw.
//
// Every entity in this model is either already a run of points or a
// curve that can be approximated by one, so a consumer that handles
// polylines handles the whole drawing. Doing that reduction here rather
// than in each renderer is the same argument as Flatten: an importer
// that only understands lines silently loses every arc, and the fix
// belongs in one place.
//
// Two things happen at once, and they are together on purpose. Curves
// become chords, and the chord tolerance is stated in *metres* — so the
// scale factor has to be known to tessellate correctly. A drawing in
// millimetres and the same drawing in metres want segment counts a
// thousand apart for the same visual result, and computing them in
// drawing units means a curve that looks smooth in one file looks
// faceted in another.

// Path is one run of points in a metric plane, in metres.
//
// Points is flat — x, y, x, y — rather than a slice of structs. A
// drawing of a few hundred thousand points is ordinary (a locker
// elevation in the fixture set has ninety thousand), this is what the
// wire format wants anyway, and a struct slice would double the
// allocation for no gain in a type nothing does arithmetic on.
type Path struct {
	// Layer is the layer name the entity resolved to, after block
	// inheritance. Empty means the default layer "0".
	Layer string

	// Color is what the entity declared, unresolved: ByLayer stays
	// ByLayer. Resolving an index to RGB is a palette decision, and the
	// layer table travels with the paths, so the consumer can do it.
	Color Color

	// Closed joins the last point back to the first.
	Closed bool

	// Filled marks a path that encloses ink rather than outlining a
	// shape — SOLID, TRACE and 3DFACE. Poché walls arrive this way, and
	// drawing them as hairlines loses the visual weight that makes a plan
	// readable.
	Filled bool

	// Handle is the source object's identifier, carried so a user
	// reporting that "this one wall is wrong" can be answered.
	Handle uint64

	Points []float64
}

// PathOptions tune the reduction.
type PathOptions struct {
	// MetersPerUnit scales drawing units to metres. Zero means the
	// drawing is already metric at 1:1, which is what an unresolved unit
	// amounts to.
	MetersPerUnit float64

	// Origin is the drawing-unit point that becomes (0, 0). Usually the
	// drawing's lower-left extent, so the result is a first-quadrant box
	// a caller can anchor anywhere on a map.
	Origin Vec3

	// Sagitta is the largest gap allowed between a chord and the curve it
	// replaces, in metres. Zero uses DefaultSagitta.
	Sagitta float64

	// MaxSegments caps a single curve's tessellation. Zero uses
	// DefaultMaxSegments. The cap exists because Sagitta alone is
	// unbounded on a large radius, and radii come from the file.
	MaxSegments int

	// MaxPoints caps the whole result. Zero uses DefaultMaxPoints.
	//
	// Flatten's entity cap does not bound this on its own: two million
	// entities are allowed, and each may be a curve worth MaxSegments
	// points, so the product is what actually has to be held.
	MaxPoints int
}

const (
	// DefaultSagitta is one centimetre. Below the width of a drawn line
	// at any zoom a floor plan is read at, and it keeps a 10 m radius
	// curve at about 90 segments rather than the thousands a
	// pixel-accurate tolerance would ask for.
	DefaultSagitta = 0.01

	// DefaultMaxSegments bounds one curve. A full circle at 128 segments
	// is smooth past the point anyone can see; the cap is really there so
	// a radius read from a hostile file cannot turn one entity into a
	// million points.
	DefaultMaxSegments = 128

	// DefaultMaxPoints bounds the whole result. Comfortably above any
	// real floor plan — the largest drawing in the fixture set reduces to
	// about 600 000 points — and low enough that the response is still
	// something a browser can hold.
	DefaultMaxPoints = 4_000_000

	// minSegments keeps a closed curve from collapsing into a triangle
	// when the tolerance is coarse relative to its size.
	minSegments = 8
)

// ErrTooManyPoints means the point cap stopped the reduction. The paths
// built so far are returned with it, on the same reasoning as
// ErrTooManyEntities: a partial drawing is useful, an unannounced
// partial drawing is not.
var ErrTooManyPoints = errors.New("cad: drawing reduces to too many points")

// Paths converts flattened entities. Entities with no drawable geometry —
// text, and inserts that Flatten should already have expanded — are
// skipped without comment.
func Paths(entities []Entity, opts PathOptions) ([]Path, error) {
	if opts.MetersPerUnit == 0 {
		opts.MetersPerUnit = 1
	}
	if opts.Sagitta <= 0 {
		opts.Sagitta = DefaultSagitta
	}
	if opts.MaxSegments <= 0 {
		opts.MaxSegments = DefaultMaxSegments
	}
	if opts.MaxPoints <= 0 {
		opts.MaxPoints = DefaultMaxPoints
	}

	b := &pathBuilder{opts: opts, out: make([]Path, 0, len(entities))}
	for _, e := range entities {
		if b.points >= opts.MaxPoints {
			return b.out, fmt.Errorf("%w: stopped at %d", ErrTooManyPoints, opts.MaxPoints)
		}
		b.add(e)
	}
	return b.out, nil
}

type pathBuilder struct {
	opts   PathOptions
	out    []Path
	buf    []float64
	points int

	// Scratch for deBoor. A drawing runs to thousands of splines and each
	// span to dozens of samples, so the working set is reused rather than
	// allocated per point.
	dbPoints  []Vec3
	dbWeights []float64
}

func (b *pathBuilder) add(e Entity) {
	b.buf = b.buf[:0]
	closed, filled := false, false

	switch v := e.(type) {
	case *Line:
		b.point(v.Start)
		b.point(v.End)
	case *Polyline:
		b.polyline(v)
		closed = v.Closed
	case *ArcEntity:
		b.arc(v.Geometry(), false)
	case *Circle:
		b.arc(Arc{Center: v.Center, Radius: v.Radius}, true)
		closed = true
	case *Ellipse:
		closed = b.ellipse(v)
	case *Spline:
		closed = b.spline(v)
	case *Solid:
		for _, c := range v.Corners {
			b.point(c)
		}
		closed, filled = true, true
	case *Point:
		b.point(v.Position)
	default:
		return
	}
	if len(b.buf) < 2 {
		return
	}

	c := e.Base()
	b.points += len(b.buf) / 2
	b.out = append(b.out, Path{
		Layer:  c.Layer,
		Color:  c.Color,
		Closed: closed,
		Filled: filled,
		Handle: c.Handle,
		Points: slices.Clone(b.buf),
	})
}

// point drops Z. Everything here is a plan: the drawing has already been
// flattened into world space, and a map has no third coordinate to put
// the elevation in.
func (b *pathBuilder) point(p Vec3) { b.pointXY(p.X, p.Y) }

func (b *pathBuilder) pointXY(x, y float64) {
	b.buf = append(b.buf,
		(x-b.opts.Origin.X)*b.opts.MetersPerUnit,
		(y-b.opts.Origin.Y)*b.opts.MetersPerUnit,
	)
}

// polyline walks the vertices, expanding any bulged segment into the arc
// it encodes. A bulge dropped is a rounded corner turned into a chord,
// which is how an importer quietly loses area on every curved wall.
func (b *pathBuilder) polyline(p *Polyline) {
	n := len(p.Vertices)
	if n == 0 {
		return
	}
	last := n - 1
	if p.Closed {
		last = n
	}
	for i := range last {
		v := p.Vertices[i]
		next := p.Vertices[(i+1)%n]
		b.point(v.Point)
		if a, ok := ArcFromBulge(v.Point, next.Point, v.Bulge); ok {
			// The endpoints are emitted by this iteration and the next, so
			// only the interior of the sweep is added here. A negative
			// bulge means the arc was stored the other way round, so its
			// interior has to be walked in reverse to stay in order.
			steps := b.segments(a.Radius, a.Sweep())
			for k := 1; k < steps; k++ {
				t := float64(k) / float64(steps)
				if v.Bulge < 0 {
					t = 1 - t
				}
				b.point(a.PointAt(t))
			}
		}
	}
	if !p.Closed {
		b.point(p.Vertices[last].Point)
	}
}

// arc emits a circular sweep. full forces the whole circle, which cannot
// be expressed as a sweep — Arc.Sweep is in [0, 2π) and reports zero for
// coincident endpoints, so a circle asked for as an arc would collapse to
// a point.
func (b *pathBuilder) arc(a Arc, full bool) {
	sweep := a.Sweep()
	if full {
		sweep = 2 * math.Pi
	}
	steps := b.segments(a.Radius, sweep)
	// A closed curve repeats its first point at the end, so the last step
	// is dropped; an open one keeps both endpoints.
	stop := steps
	if full {
		stop = steps - 1
	}
	for k := 0; k <= stop; k++ {
		ang := a.StartAngle + sweep*float64(k)/float64(steps)
		b.pointXY(a.Center.X+a.Radius*math.Cos(ang), a.Center.Y+a.Radius*math.Sin(ang))
	}
}

// ellipse walks the parametric form. The minor axis is the major rotated
// a quarter turn and scaled by the ratio; a flipped extrusion reverses
// the direction of travel but traces the same outline, which is all a
// filled or stroked path cares about.
func (b *pathBuilder) ellipse(e *Ellipse) bool {
	major := e.MajorAxis
	radius := math.Hypot(major.X, major.Y)
	if radius == 0 {
		return false
	}
	minorX, minorY := -major.Y*e.Ratio, major.X*e.Ratio

	start, end := e.StartParam, e.EndParam
	sweep := end - start
	if sweep <= 0 {
		sweep += 2 * math.Pi
	}
	full := sweep >= 2*math.Pi-1e-9

	steps := b.segments(radius, sweep)
	stop := steps
	if full {
		stop = steps - 1
	}
	for k := 0; k <= stop; k++ {
		t := start + sweep*float64(k)/float64(steps)
		cos, sin := math.Cos(t), math.Sin(t)
		b.pointXY(e.Center.X+major.X*cos+minorX*sin, e.Center.Y+major.Y*cos+minorY*sin)
	}
	return full
}

// spline reduces a NURBS curve to chords.
//
// The control form is evaluated when the file gave one. Fit points are
// the fallback and a poor one — the curve passes through them but bows
// between them, so joining them cuts every corner the spline was drawn to
// round. It is still better than dropping a drawn object, and a file that
// stated nothing but fit points has not said anything more precise than
// that.
func (b *pathBuilder) spline(s *Spline) bool {
	if !b.nurbs(s) {
		pts := s.FitPoints
		if len(pts) < 2 {
			pts = s.ControlPoints
		}
		for _, p := range pts {
			b.point(p)
		}
	}
	return s.Closed
}

// nurbs evaluates the control form span by span, reporting whether it
// could.
//
// A curve of degree d over n control points is only defined on the knot
// interval [knots[d], knots[n]]; the knots outside it exist to give the
// basis functions somewhere to start and stop, and evaluating there
// produces a curve the drawing does not contain. So the walk is over
// spans rather than over the knot vector, and a span of zero width is
// skipped — repeated knots are how a spline states a sharp corner, and
// they span no parameter at all.
func (b *pathBuilder) nurbs(s *Spline) bool {
	d, n := s.Degree, len(s.ControlPoints)
	if d < 1 || n <= d || len(s.Knots) != n+d+1 {
		return false
	}
	if len(s.Weights) != 0 && len(s.Weights) != n {
		return false
	}
	// deBoor divides by knot differences. Every one of them is at least
	// the width of the span being evaluated, so a positive-width span is
	// safe — but only if the vector is non-decreasing to begin with, which
	// is a claim the file makes rather than one it proves. The comparison
	// is inverted so a NaN fails it.
	for i := 1; i < len(s.Knots); i++ {
		if !(s.Knots[i] >= s.Knots[i-1]) {
			return false
		}
	}

	emitted := false
	for k := d; k < n; k++ {
		lo, hi := s.Knots[k], s.Knots[k+1]
		if hi <= lo {
			continue
		}
		steps := b.splineSteps(s, k)
		for i := range steps {
			b.point(b.deBoor(s, k, lo+(hi-lo)*float64(i)/float64(steps)))
		}
		emitted = true
	}
	if !emitted {
		return false
	}
	// Each span emitted its own start, so an open curve still owes its
	// end. A closed one does not: it ends where it began, and Path.Closed
	// already joins the two — emitting it would leave a zero-length edge,
	// invisible in an outline and fatal to a triangulator. Same rule the
	// full-circle branch of arc follows.
	//
	// The endpoint comes from the last span that had width, because asking
	// the one after it would be asking a span of zero width where its
	// parameter had got to.
	if !s.Closed {
		for k := n - 1; k >= d; k-- {
			if s.Knots[k+1] > s.Knots[k] {
				b.point(b.deBoor(s, k, s.Knots[k+1]))
				break
			}
		}
	}
	return true
}

// splineSteps is how many chords one span needs.
//
// A span lies inside the convex hull of the control points that influence
// it, so the furthest of those from the span's chord bounds how far the
// curve can stray from that chord. Subdividing reduces the gap with the
// square of the count — the error is second order in the step — so the
// answer is a square root, which is the same argument segments makes
// against a radius, made here against a hull because a NURBS span has no
// radius to invert.
func (b *pathBuilder) splineSteps(s *Spline, k int) int {
	first, last := s.ControlPoints[k-s.Degree], s.ControlPoints[k]
	dev := 0.0
	for _, p := range s.ControlPoints[k-s.Degree : k+1] {
		dev = max(dev, distanceToSegment(p, first, last))
	}
	// Measured in space rather than in the plane the path lands in, so a
	// spline that also rises is tessellated as if seen edge on. Wrong in
	// the affordable direction: extra points, never a visible facet.
	dev *= b.opts.MetersPerUnit
	if !(dev > b.opts.Sagitta) {
		return 1
	}
	steps := math.Ceil(math.Sqrt(dev / b.opts.Sagitta))
	if steps >= float64(b.opts.MaxSegments) {
		return b.opts.MaxSegments
	}
	return int(steps)
}

// deBoor evaluates the curve at u, which must lie in span k.
//
// The control points are lifted to homogeneous coordinates and divided
// through at the end, which is the whole of the weights' treatment: a
// rational curve in the plane is a polynomial one a dimension up.
func (b *pathBuilder) deBoor(s *Spline, k int, u float64) Vec3 {
	d := s.Degree
	if cap(b.dbPoints) < d+1 {
		b.dbPoints = make([]Vec3, d+1)
		b.dbWeights = make([]float64, d+1)
	}
	p, w := b.dbPoints[:d+1], b.dbWeights[:d+1]
	for j := range p {
		i := k - d + j
		w[j] = 1
		if len(s.Weights) != 0 {
			w[j] = s.Weights[i]
		}
		p[j] = s.ControlPoints[i].Mul(w[j])
	}

	for r := 1; r <= d; r++ {
		for j := d; j >= r; j-- {
			lo, hi := s.Knots[j+k-d], s.Knots[j+1+k-r]
			a := (u - lo) / (hi - lo)
			p[j] = p[j-1].Mul(1 - a).Add(p[j].Mul(a))
			w[j] = w[j-1]*(1-a) + w[j]*a
		}
	}
	if w[d] == 0 {
		return p[d]
	}
	return p[d].Mul(1 / w[d])
}

// distanceToSegment is the distance from p to the segment ab.
func distanceToSegment(p, a, c Vec3) float64 {
	d := c.Sub(a)
	l2 := d.Dot(d)
	if l2 == 0 {
		return p.Sub(a).Length()
	}
	t := min(max(p.Sub(a).Dot(d)/l2, 0), 1)
	return p.Sub(a.Add(d.Mul(t))).Length()
}

// segments is how many chords a sweep needs to stay within the sagitta.
//
// For a chord subtending angle θ on radius r the gap at the midpoint is
// r(1 − cos(θ/2)), so inverting gives the largest θ that still fits. The
// radius is converted to metres first because the tolerance is in metres —
// the whole reason the scale factor is an input here.
func (b *pathBuilder) segments(radius, sweep float64) int {
	r := math.Abs(radius) * b.opts.MetersPerUnit
	s := b.opts.Sagitta
	if !(r > 0) || !(sweep > 0) || math.IsNaN(r) || math.IsInf(r, 0) {
		return 1
	}

	steps := minSegments
	if s < r {
		theta := 2 * math.Acos(1-s/r)
		if theta > 0 {
			steps = int(math.Ceil(sweep / theta))
		}
	}
	// The minimum is proportional to the sweep so a 5° fillet does not
	// pay for the eight segments a full circle needs.
	floor := max(int(math.Ceil(sweep/(2*math.Pi)*minSegments)), 1)
	return min(max(steps, floor), b.opts.MaxSegments)
}

// PathBounds is the box the paths occupy, in metres.
//
// Recomputed from the emitted points rather than scaled from the
// document's extents: tessellation cannot leave the true curve by more
// than the sagitta, but the header's extents are a stale hint (see
// Header.ExtMin) and a filter that dropped a layer changes the answer
// outright.
func PathBounds(paths []Path) BBox {
	var b BBox
	for _, p := range paths {
		for i := 0; i+1 < len(p.Points); i += 2 {
			b.Grow(Vec3{p.Points[i], p.Points[i+1], 0})
		}
	}
	return b
}
