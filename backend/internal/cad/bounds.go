package cad

import "math"

// The drawing's extents decide the real-world size the map places it at,
// so they have to be tight.
//
// $EXTMIN/$EXTMAX are right there in the header and free to read, but
// they are whatever AutoCAD last computed — stale after a delete without
// a regen, and routinely inflated by a stray point at the origin or a
// forgotten construction line ten kilometres away. Treating them as
// truth makes a 60 m building import as a 10 km one.
//
// Recomputing from the flattened geometry is cheap by comparison, and it
// is the only version that reflects the layer filter the user chose:
// dropping the annotation layer should shrink the extents to the
// building, and it only does if the extents come from what was kept.

// Bounds computes the tight bounding box of a set of entities.
//
// Curves are measured properly rather than by their control points: an
// arc contributes only the part of its circle it actually sweeps, and a
// polyline's bulged segments contribute their arcs rather than their
// chords. The difference is up to a radius on each side, which on a
// plan full of door swings and curved walls is the difference between a
// correct footprint and one padded by a metre.
func Bounds(entities []Entity) BBox {
	var b BBox
	for _, e := range entities {
		b = b.Union(EntityBounds(e))
	}
	return b
}

// EntityBounds is the tight bounding box of one entity in whatever
// coordinate space it currently occupies.
func EntityBounds(e Entity) BBox {
	var b BBox
	switch s := e.(type) {
	case *Line:
		b.Grow(s.Start)
		b.Grow(s.End)

	case *Point:
		b.Grow(s.Position)

	case *Circle:
		b.Grow(Vec3{s.Center.X - s.Radius, s.Center.Y - s.Radius, s.Center.Z})
		b.Grow(Vec3{s.Center.X + s.Radius, s.Center.Y + s.Radius, s.Center.Z})

	case *ArcEntity:
		b = s.Geometry().Bounds()

	case *Ellipse:
		b = ellipseBounds(s)

	case *Solid:
		for _, c := range s.Corners {
			b.Grow(c)
		}

	case *Spline:
		// A NURBS curve lies inside the convex hull of its control net, so
		// the net's box contains the curve — loosely, but never wrongly.
		// Evaluating for a tight box would cost the tessellation twice and
		// buy an extent no caller is measuring to. When only fit points
		// were stored the curve passes through them, so their box is a
		// slight under-estimate for the same reason it is the only thing
		// available.
		for _, p := range s.ControlPoints {
			b.Grow(p)
		}
		for _, p := range s.FitPoints {
			b.Grow(p)
		}

	case *Polyline:
		b = polylineBounds(s)

	case *Text:
		// Text has no reliable extent without font metrics, and guessing
		// one would let a single note inflate the drawing. The insertion
		// point is the honest answer.
		b.Grow(s.Position)

	case *Insert:
		// An unexpanded insert has no geometry of its own. Bounds is
		// meant to run on a flattened drawing; reaching here means the
		// caller skipped Flatten, and inventing a box would hide that.
		b.Grow(s.Position)
	}
	return b
}

func polylineBounds(p *Polyline) BBox {
	var b BBox
	n := len(p.Vertices)
	if n == 0 {
		return b
	}
	for _, v := range p.Vertices {
		pt := v.Point
		if pt.Z == 0 && p.Elevation != 0 {
			pt.Z = p.Elevation
		}
		b.Grow(pt)
	}

	last := n - 1
	if !p.Closed {
		last = n - 2
	}
	for i := 0; i <= last; i++ {
		v := p.Vertices[i]
		if v.Bulge == 0 {
			continue
		}
		next := p.Vertices[(i+1)%n]
		if arc, ok := ArcFromBulge(v.Point, next.Point, v.Bulge); ok {
			b = b.Union(arc.Bounds())
		}
	}
	return b
}

// ellipseBounds measures a full or partial ellipse.
//
// The axis-aligned extremes of a rotated ellipse are found by solving
// d/dp of the parametric form for zero, which gives the parameter where
// each axis peaks in closed form. For a partial sweep those peaks only
// count when the sweep passes through them — same rule as Arc.Bounds,
// and it matters for the same reason.
func ellipseBounds(e *Ellipse) BBox {
	var b BBox
	ratio := e.Ratio
	if ratio <= 0 {
		ratio = 1
	}
	ax := e.MajorAxis
	ay := Vec3{-ax.Y, ax.X, 0}.Mul(ratio)

	at := func(p float64) Vec3 {
		return Vec3{
			e.Center.X + ax.X*math.Cos(p) + ay.X*math.Sin(p),
			e.Center.Y + ax.Y*math.Cos(p) + ay.Y*math.Sin(p),
			e.Center.Z,
		}
	}

	start, end := e.StartParam, e.EndParam
	sweep := math.Mod(end-start, 2*math.Pi)
	if sweep <= 0 {
		sweep += 2 * math.Pi
	}
	if isFullSweep(start, end) {
		sweep = 2 * math.Pi
	}

	b.Grow(at(start))
	b.Grow(at(start + sweep))

	// x(p) = cx + ax.X·cos p + ay.X·sin p  ⇒  x'(p) = 0 at
	// tan p = ay.X / ax.X. Two solutions half a turn apart.
	for _, base := range []float64{math.Atan2(ay.X, ax.X), math.Atan2(ay.Y, ax.Y)} {
		for _, p := range []float64{base, base + math.Pi} {
			delta := math.Mod(p-start, 2*math.Pi)
			if delta < 0 {
				delta += 2 * math.Pi
			}
			if delta <= sweep {
				b.Grow(at(p))
			}
		}
	}
	return b
}
