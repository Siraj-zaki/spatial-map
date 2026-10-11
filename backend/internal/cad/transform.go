package cad

import "math"

// Transforming curves is where block expansion stops being bookkeeping.
//
// A line under any transform is still a line. A circle is not: scale a
// block 2× in X only and its circles become ellipses. Blocks are scaled
// non-uniformly in real drawings — a door block stretched to a wider
// opening is the everyday case — so an importer that just scales the
// radius by "the" scale factor draws door swings at the wrong size and
// leaves gaps between the arc and the wall it should meet.
//
// So circles and arcs are promoted to ellipses whenever the transform is
// not a similarity, and left alone when it is. The promotion needs the
// singular value decomposition of the 2×2 linear part, which for 2×2 has
// a closed form — no iteration, no library.

// transform returns a world-space clone of an entity. It never mutates
// the input, so a document can be flattened repeatedly.
func transform(e Entity, m Matrix) Entity {
	switch src := e.(type) {
	case *Line:
		out := *src
		out.Start = m.Point(src.Start)
		out.End = m.Point(src.End)
		return &out

	case *Point:
		out := *src
		out.Position = m.Point(src.Position)
		return &out

	case *Polyline:
		out := *src
		out.Vertices = make([]Vertex, len(src.Vertices))
		// A reflection reverses the direction every arc curves in, and a
		// bulge's sign is exactly that direction.
		flip := 1.0
		if determinant2D(m) < 0 {
			flip = -1
		}
		scale := m.UniformScale()
		for i, v := range src.Vertices {
			p := v.Point
			// LWPOLYLINE keeps one elevation for the whole polyline
			// rather than a Z per vertex.
			if p.Z == 0 && src.Elevation != 0 {
				p.Z = src.Elevation
			}
			out.Vertices[i] = Vertex{
				Point: m.Point(p),
				// Bulge is scale-invariant for a similarity transform.
				// Under a non-uniform one the segment is really an
				// elliptical arc that no bulge can express; keeping the
				// value is the closest approximation available without
				// splitting the polyline apart.
				Bulge:      v.Bulge * flip,
				StartWidth: v.StartWidth * scale,
				EndWidth:   v.EndWidth * scale,
			}
		}
		out.ConstWidth = src.ConstWidth * scale
		out.Elevation = 0
		return &out

	case *Solid:
		out := *src
		out.Corners = make([]Vec3, len(src.Corners))
		for i, c := range src.Corners {
			out.Corners[i] = m.Point(c)
		}
		return &out

	case *Spline:
		// A NURBS curve is affine-invariant: transforming the control net
		// transforms the curve exactly. That is a defining property of the
		// basis, not an approximation, so unlike the arc and ellipse cases
		// below there is no degenerate transform to detect — knots are
		// parametric and weights are ratios, and neither is touched.
		out := *src
		out.ControlPoints = make([]Vec3, len(src.ControlPoints))
		for i, p := range src.ControlPoints {
			out.ControlPoints[i] = m.Point(p)
		}
		out.FitPoints = make([]Vec3, len(src.FitPoints))
		for i, p := range src.FitPoints {
			out.FitPoints[i] = m.Point(p)
		}
		return &out

	case *Text:
		out := *src
		out.Position = m.Point(src.Position)
		if src.HasAlign {
			out.AlignPoint = m.Point(src.AlignPoint)
		}
		out.Height = src.Height * m.UniformScale()
		out.Rotation = src.Rotation + rotationOf(m)
		return &out

	case *Circle:
		return transformCircular(&src.Common, m, src.Center, src.Radius, 0, 2*math.Pi, true)

	case *ArcEntity:
		return transformCircular(&src.Common, m, src.Center, src.Radius, src.StartAngle, src.EndAngle, false)

	case *Ellipse:
		major := src.MajorAxis
		ratio := src.Ratio
		if ratio <= 0 {
			ratio = 1
		}
		// The ellipse is centre + A·cos p + B·sin p, so [A B] is the
		// matrix that maps the unit circle onto it. Composing that with
		// the transform reduces the problem to the circle case.
		minor := Vec3{-major.Y, major.X, 0}.Mul(ratio)
		return transformConic(&src.Common, m, src.Center, major, minor, src.StartParam, src.EndParam,
			isFullSweep(src.StartParam, src.EndParam))
	}
	return nil
}

// transformCircular handles circles and circular arcs, keeping them
// circular when it can.
func transformCircular(c *Common, m Matrix, center Vec3, radius, start, end float64, full bool) Entity {
	if similarity(m) {
		scale := m.UniformScale()
		newCenter := m.Point(center)
		newRadius := radius * scale
		rot := rotationOf(m)
		if full {
			out := &Circle{Common: *c, Center: newCenter, Radius: newRadius}
			return out
		}
		s, e := start+rot, end+rot
		if determinant2D(m) < 0 {
			// Mirroring turns a counter-clockwise sweep into a clockwise
			// one. Arcs are stored counter-clockwise, so the same curve
			// is described by reflecting both ends and swapping them.
			//
			// A reflection about a line at angle ψ has the matrix
			// [[cos2ψ, sin2ψ], [sin2ψ, −cos2ψ]], so atan2(m[4], m[0])
			// reads back 2ψ directly — which is exactly the reflection
			// α ↦ 2ψ − α that the endpoints need.
			s, e = rot-end, rot-start
		}
		return &ArcEntity{
			Common:     *c,
			Center:     newCenter,
			Radius:     newRadius,
			StartAngle: normalizeAngle(s),
			EndAngle:   normalizeAngle(e),
		}
	}
	major := Vec3{radius, 0, 0}
	minor := Vec3{0, radius, 0}
	return transformConic(c, m, center, major, minor, start, end, full)
}

// transformConic maps any conic given by its centre and two conjugate
// axis vectors through the transform, producing the ellipse (or circle)
// that results.
func transformConic(c *Common, m Matrix, center, axisA, axisB Vec3, start, end float64, full bool) Entity {
	// Compose the transform's linear part with the conic's own axes.
	a := m[0]*axisA.X + m[1]*axisA.Y
	b := m[0]*axisB.X + m[1]*axisB.Y
	cc := m[4]*axisA.X + m[5]*axisA.Y
	d := m[4]*axisB.X + m[5]*axisB.Y

	phi, sx, sy, theta := svd2x2(a, b, cc, d)
	if sx == 0 {
		// Collapsed to a segment or a point. Nothing meaningful to draw.
		return nil
	}

	newCenter := m.Point(center)
	ratio := math.Abs(sy) / sx
	if ratio > 1 {
		ratio = 1
	}
	major := Vec3{sx * math.Cos(phi), sx * math.Sin(phi), 0}

	// Points map as p ↦ rot(phi)·Σ·rot(theta)·(cos p, sin p), and the
	// inner rotation just shifts the parameter.
	s, e := start+theta, end+theta
	if sy < 0 {
		// A negative singular value is a reflection about the major
		// axis: the same ellipse, traversed the other way.
		s, e = -e, -s
	}

	if ratio > 0.99999 {
		if full {
			return &Circle{Common: *c, Center: newCenter, Radius: sx}
		}
		return &ArcEntity{
			Common:     *c,
			Center:     newCenter,
			Radius:     sx,
			StartAngle: normalizeAngle(s + phi),
			EndAngle:   normalizeAngle(e + phi),
		}
	}
	if full {
		s, e = 0, 2*math.Pi
	} else {
		s, e = normalizeAngle(s), normalizeAngle(e)
	}
	return &Ellipse{
		Common:     *c,
		Center:     newCenter,
		MajorAxis:  major,
		Ratio:      ratio,
		StartParam: s,
		EndParam:   e,
	}
}

// svd2x2 decomposes [[a,b],[c,d]] into rot(phi)·diag(sx,sy)·rot(theta).
//
// Note the second factor is the rotation itself, not its transpose —
// the usual U·Σ·Vᵀ statement of the SVD hides a sign here, and getting
// it backwards silently negates the result for axis-aligned inputs while
// still looking right for pure rotations.
//
// Closed form, from the observation that any 2×2 splits into a symmetric
// and an antisymmetric part whose magnitudes give the two rotation
// angles directly. sy carries the sign of the determinant, so a
// reflection is represented as a negative singular value rather than
// being lost.
func svd2x2(a, b, c, d float64) (phi, sx, sy, theta float64) {
	e := (a + d) / 2
	f := (a - d) / 2
	g := (c + b) / 2
	h := (c - b) / 2

	q := math.Hypot(e, h)
	r := math.Hypot(f, g)
	sx = q + r
	sy = q - r

	a1 := math.Atan2(g, f)
	a2 := math.Atan2(h, e)
	theta = (a2 - a1) / 2
	phi = (a2 + a1) / 2
	return phi, sx, sy, theta
}

// determinant2D is the signed area scale of the transform's XY part.
// Negative means the transform mirrors.
func determinant2D(m Matrix) float64 { return m[0]*m[5] - m[1]*m[4] }

// rotationOf reports the angle the transform rotates the X axis by.
func rotationOf(m Matrix) float64 { return math.Atan2(m[4], m[0]) }

// similarity reports whether the transform preserves shape — uniform
// scale, rotation and mirroring only. Circles survive these unchanged;
// anything else turns them into ellipses.
func similarity(m Matrix) bool {
	x := Vec3{m[0], m[4], 0}
	y := Vec3{m[1], m[5], 0}
	lx, ly := x.Length(), y.Length()
	if lx == 0 || ly == 0 {
		return false
	}
	// Axes must stay perpendicular and equally long. The tolerance is
	// relative so it holds at any drawing scale.
	if math.Abs(lx-ly) > 1e-9*math.Max(lx, ly) {
		return false
	}
	return math.Abs(x.Dot(y)) < 1e-9*lx*ly
}

func normalizeAngle(a float64) float64 {
	a = math.Mod(a, 2*math.Pi)
	if a < 0 {
		a += 2 * math.Pi
	}
	return a
}

func isFullSweep(start, end float64) bool {
	return math.Abs(math.Abs(end-start)-2*math.Pi) < 1e-9
}
