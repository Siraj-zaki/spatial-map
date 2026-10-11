package cad

import "math"

// Vec3 is a point or direction in drawing units.
type Vec3 struct {
	X, Y, Z float64
}

func (v Vec3) Add(o Vec3) Vec3    { return Vec3{v.X + o.X, v.Y + o.Y, v.Z + o.Z} }
func (v Vec3) Sub(o Vec3) Vec3    { return Vec3{v.X - o.X, v.Y - o.Y, v.Z - o.Z} }
func (v Vec3) Mul(s float64) Vec3 { return Vec3{v.X * s, v.Y * s, v.Z * s} }
func (v Vec3) Dot(o Vec3) float64 { return v.X*o.X + v.Y*o.Y + v.Z*o.Z }

func (v Vec3) Cross(o Vec3) Vec3 {
	return Vec3{
		v.Y*o.Z - v.Z*o.Y,
		v.Z*o.X - v.X*o.Z,
		v.X*o.Y - v.Y*o.X,
	}
}

func (v Vec3) Length() float64 { return math.Sqrt(v.Dot(v)) }

func (v Vec3) Normalized() Vec3 {
	l := v.Length()
	if l == 0 {
		return Vec3{}
	}
	return v.Mul(1 / l)
}

// ZAxis is the default extrusion direction. An entity whose extrusion is
// ZAxis lives in the world plane and needs no OCS conversion, which is
// the overwhelmingly common case.
var ZAxis = Vec3{0, 0, 1}

// IsZAxis reports whether an extrusion vector is the identity, within
// the tolerance real files round to.
func (v Vec3) IsZAxis() bool {
	return math.Abs(v.X) < 1e-12 && math.Abs(v.Y) < 1e-12 && math.Abs(v.Z-1) < 1e-12
}

// Matrix is a 4×4 affine transform in row-major order, applied to
// column vectors: p' = M · p.
type Matrix [16]float64

// Identity is the no-op transform.
func Identity() Matrix {
	return Matrix{
		1, 0, 0, 0,
		0, 1, 0, 0,
		0, 0, 1, 0,
		0, 0, 0, 1,
	}
}

// Translation moves by v.
func Translation(v Vec3) Matrix {
	m := Identity()
	m[3], m[7], m[11] = v.X, v.Y, v.Z
	return m
}

// Scaling scales each axis independently. Negative components are legal
// and common — mirroring a block is expressed as a negative scale, which
// is also why winding order cannot be trusted after a transform.
func Scaling(v Vec3) Matrix {
	m := Identity()
	m[0], m[5], m[10] = v.X, v.Y, v.Z
	return m
}

// RotationZ rotates counter-clockwise about the Z axis, in radians.
func RotationZ(rad float64) Matrix {
	s, c := math.Sin(rad), math.Cos(rad)
	m := Identity()
	m[0], m[1] = c, -s
	m[4], m[5] = s, c
	return m
}

// Mul returns the transform that applies b first, then a.
func (a Matrix) Mul(b Matrix) Matrix {
	var out Matrix
	for r := 0; r < 4; r++ {
		for c := 0; c < 4; c++ {
			sum := 0.0
			for k := 0; k < 4; k++ {
				sum += a[r*4+k] * b[k*4+c]
			}
			out[r*4+c] = sum
		}
	}
	return out
}

// Point applies the full transform, translation included.
func (m Matrix) Point(p Vec3) Vec3 {
	return Vec3{
		m[0]*p.X + m[1]*p.Y + m[2]*p.Z + m[3],
		m[4]*p.X + m[5]*p.Y + m[6]*p.Z + m[7],
		m[8]*p.X + m[9]*p.Y + m[10]*p.Z + m[11],
	}
}

// Vector applies rotation and scale but not translation — for extrusion
// normals and axis vectors, which describe a direction rather than a
// place.
func (m Matrix) Vector(v Vec3) Vec3 {
	return Vec3{
		m[0]*v.X + m[1]*v.Y + m[2]*v.Z,
		m[4]*v.X + m[5]*v.Y + m[6]*v.Z,
		m[8]*v.X + m[9]*v.Y + m[10]*v.Z,
	}
}

// UniformScale reports the average length change the transform applies,
// used to carry scalar sizes (text height, radius, line width) through a
// nested block chain. It is exact for uniform scales and an
// approximation for anisotropic ones — where a circle genuinely becomes
// an ellipse and no single number is right.
func (m Matrix) UniformScale() float64 {
	x := Vec3{m[0], m[4], m[8]}.Length()
	y := Vec3{m[1], m[5], m[9]}.Length()
	return (x + y) / 2
}

// ArbitraryAxis builds the object coordinate system for an extrusion
// normal.
//
// 2D entities store their coordinates in a plane perpendicular to their
// extrusion vector, not in world space. When the extrusion is (0,0,1)
// the two coincide and nothing is needed — which is why this is easy to
// forget and then only shows up on mirrored blocks, where the extrusion
// flips to (0,0,-1) and everything lands mirrored about the wrong axis.
//
// The construction is AutoCAD's arbitrary axis algorithm: pick a
// reference axis that is not nearly parallel to the normal, and derive
// an orthonormal basis from it. The 1/64 threshold and the choice of
// which world axis to fall back to are part of the definition — any
// other choice produces a different, incompatible rotation about the
// normal.
func ArbitraryAxis(normal Vec3) Matrix {
	n := normal.Normalized()
	if n.Length() == 0 {
		return Identity()
	}
	var ax Vec3
	if math.Abs(n.X) < 1.0/64.0 && math.Abs(n.Y) < 1.0/64.0 {
		ax = Vec3{0, 1, 0}.Cross(n)
	} else {
		ax = Vec3{0, 0, 1}.Cross(n)
	}
	ax = ax.Normalized()
	ay := n.Cross(ax).Normalized()

	return Matrix{
		ax.X, ay.X, n.X, 0,
		ax.Y, ay.Y, n.Y, 0,
		ax.Z, ay.Z, n.Z, 0,
		0, 0, 0, 1,
	}
}

// BBox is an axis-aligned bounding box. The zero value is empty; Grow
// makes it valid.
type BBox struct {
	Min, Max Vec3
	Valid    bool
}

// Grow expands the box to contain p.
func (b *BBox) Grow(p Vec3) {
	if !b.Valid {
		b.Min, b.Max, b.Valid = p, p, true
		return
	}
	b.Min = Vec3{math.Min(b.Min.X, p.X), math.Min(b.Min.Y, p.Y), math.Min(b.Min.Z, p.Z)}
	b.Max = Vec3{math.Max(b.Max.X, p.X), math.Max(b.Max.Y, p.Y), math.Max(b.Max.Z, p.Z)}
}

// Union merges two boxes.
func (b BBox) Union(o BBox) BBox {
	if !o.Valid {
		return b
	}
	if !b.Valid {
		return o
	}
	b.Grow(o.Min)
	b.Grow(o.Max)
	return b
}

// Size is the box's extent. Zero for an invalid box.
func (b BBox) Size() Vec3 {
	if !b.Valid {
		return Vec3{}
	}
	return b.Max.Sub(b.Min)
}

// Arc is a circular arc, swept counter-clockwise from Start to End.
type Arc struct {
	Center     Vec3
	Radius     float64
	StartAngle float64 // radians, counter-clockwise from +X
	EndAngle   float64
}

// ArcFromBulge reconstructs the arc a polyline bulge encodes between two
// vertices, reporting false when the segment is straight or degenerate.
//
// Bulge is tan(θ/4) where θ is the arc's included angle, signed
// positive for counter-clockwise. It is the compact encoding that lets a
// single polyline mix straight walls and curved ones, which is why an
// importer that ignores bulges turns every rounded corner into a chord
// and quietly loses area.
func ArcFromBulge(start, end Vec3, bulge float64) (Arc, bool) {
	if bulge == 0 || math.IsNaN(bulge) || math.IsInf(bulge, 0) {
		return Arc{}, false
	}
	chord := end.Sub(start)
	c := math.Hypot(chord.X, chord.Y)
	if c == 0 {
		return Arc{}, false
	}

	theta := 4 * math.Atan(bulge)
	half := theta / 2
	sinHalf := math.Sin(half)
	if sinHalf == 0 {
		return Arc{}, false
	}
	radius := c / (2 * math.Abs(sinHalf))

	// Distance from the chord's midpoint to the centre. cos flips sign
	// past a half turn, which is exactly what moves the centre to the
	// other side of the chord for a major arc.
	apothem := radius * math.Cos(half)

	ux, uy := chord.X/c, chord.Y/c
	// Left-hand normal of the chord direction.
	nx, ny := -uy, ux
	side := math.Copysign(1, bulge)

	mid := Vec3{(start.X + end.X) / 2, (start.Y + end.Y) / 2, (start.Z + end.Z) / 2}
	center := Vec3{mid.X + nx*apothem*side, mid.Y + ny*apothem*side, mid.Z}

	a0 := math.Atan2(start.Y-center.Y, start.X-center.X)
	a1 := math.Atan2(end.Y-center.Y, end.X-center.X)
	if bulge < 0 {
		// Stored counter-clockwise, so a clockwise bulge is the same arc
		// traversed the other way.
		a0, a1 = a1, a0
	}
	return Arc{Center: center, Radius: radius, StartAngle: a0, EndAngle: a1}, true
}

// Sweep is the arc's included angle, always in [0, 2π).
func (a Arc) Sweep() float64 {
	s := math.Mod(a.EndAngle-a.StartAngle, 2*math.Pi)
	if s < 0 {
		s += 2 * math.Pi
	}
	return s
}

// PointAt returns the point at a fraction t of the sweep.
func (a Arc) PointAt(t float64) Vec3 {
	ang := a.StartAngle + a.Sweep()*t
	return Vec3{
		a.Center.X + a.Radius*math.Cos(ang),
		a.Center.Y + a.Radius*math.Sin(ang),
		a.Center.Z,
	}
}

// Bounds is the arc's tight bounding box.
//
// Tight, not the whole circle: a floor plan's extents are computed from
// these, and treating every arc as a full circle inflates a curved wall's
// footprint by up to its radius in each direction — enough to throw off
// the real-world size the map places the drawing at.
func (a Arc) Bounds() BBox {
	var b BBox
	b.Grow(a.PointAt(0))
	b.Grow(a.PointAt(1))

	sweep := a.Sweep()
	// The four axis extremes are candidates only when the sweep actually
	// passes through them.
	for k := 0; k < 4; k++ {
		ang := float64(k) * math.Pi / 2
		delta := math.Mod(ang-a.StartAngle, 2*math.Pi)
		if delta < 0 {
			delta += 2 * math.Pi
		}
		if delta <= sweep {
			b.Grow(Vec3{
				a.Center.X + a.Radius*math.Cos(ang),
				a.Center.Y + a.Radius*math.Sin(ang),
				a.Center.Z,
			})
		}
	}
	return b
}
