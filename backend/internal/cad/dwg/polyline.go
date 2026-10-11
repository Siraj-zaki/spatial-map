package dwg

import (
	"fmt"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// The older polyline is not an object but a chain: a POLYLINE holding
// the run's attributes, one VERTEX object per point, and a SEQEND to
// close it. LWPOLYLINE replaced it by putting everything in one object,
// but the chain did not go away — tools still write it for 3D runs,
// which LWPOLYLINE cannot express, and for anything exported for
// compatibility with older releases.
//
// The consequence for a reader is that a polyline cannot be finished
// from the bytes of the object that declares it, which is why this is
// the first type whose decoding is split across two passes. Skipping the
// chain is not a small omission: one of our fixtures is 94,183 objects
// of which 91,521 are polylines and their vertices, and a reader without
// this file opens that drawing as empty.
//
// Implemented from the Open Design Alliance's specification §2.4.5.

// Flags a POLYLINE_2D packs into its single flag word. The rest of the
// word describes curve and surface fitting, which changes how the run is
// displayed but not where its vertices are.
const (
	poly2DClosed = 1 << 0
)

// A POLYLINE_3D states its closedness in a byte of its own rather than
// in the flag word, which holds the spline type.
const (
	poly3DClosed = 1 << 0
)

// polyMaxVertices caps the owned-object count. It is a 32-bit field read
// straight from an attacker-controlled file and it reaches both make()
// and a loop, so it cannot be trusted to be bounded by the object it
// came from — the handles it counts live in a different stream from the
// count itself.
const polyMaxVertices = 1 << 22

// readPolyline2D decodes a POLYLINE_2D and returns the number of
// vertices it owns, which is what positions its handle list.
func readPolyline2D(b *bitReader, v Version, c cad.Common) (*cad.Polyline, int) {
	p := &cad.Polyline{Common: c}
	p.Closed = b.bs()&poly2DClosed != 0
	b.bs() // curve type: how the run is fitted, not where it goes

	// Two default widths, start and end. The model carries one, because a
	// run whose two defaults differ is a taper that the per-vertex widths
	// below describe anyway; the pair is only a default for vertices that
	// state neither.
	p.ConstWidth = b.bd()
	b.bd() // default end width

	b.bt() // thickness
	p.Elevation = b.bd()
	p.Extrusion.X, p.Extrusion.Y, p.Extrusion.Z = b.be()
	return p, ownedCount(b, v)
}

// readPolyline3D decodes a POLYLINE_3D. It carries no widths and no
// elevation: every vertex states its own Z, which is the whole reason
// this type exists alongside the 2D one.
func readPolyline3D(b *bitReader, v Version, c cad.Common) (*cad.Polyline, int) {
	p := &cad.Polyline{Common: c}
	b.bits(8) // spline type
	p.Closed = b.bits(8)&poly3DClosed != 0
	return p, ownedCount(b, v)
}

// ownedCount reads the vertex count R2004 added.
//
// Before it, a polyline named only its first and last vertex and the
// chain was walked through the object map. From R2004 the count is
// stated and every vertex handle is listed, which is both cheaper to
// read and impossible to desynchronise.
func ownedCount(b *bitReader, v Version) int {
	if !v.AtLeast(R2004) {
		return 0
	}
	return int(b.bl())
}

// readPolylineRefs consumes the type-specific tail of the handle stream:
// the vertices, then the SEQEND that closes them.
func readPolylineRefs(b *bitReader, v Version, owned int) ([]handle, error) {
	if !v.AtLeast(R2004) {
		// The older form names the ends of the run and leaves the middle to
		// be walked. Not implemented, because reaching it needs a container
		// that cannot be opened yet — but the handles still have to be
		// consumed, or the exhaustion check below reports a decoder bug
		// where there is only an unread reference.
		b.h() // first VERTEX
		b.h() // last VERTEX
		b.h() // SEQEND
		return nil, b.Err()
	}
	if owned < 0 || owned > polyMaxVertices {
		return nil, fmt.Errorf("%w: polyline claims %d vertices", ErrMalformed, owned)
	}
	children := make([]handle, 0, owned)
	for range owned {
		children = append(children, b.h())
	}
	b.h() // SEQEND
	return children, b.Err()
}

// readVertex2D decodes a VERTEX_2D: a point, and the width and curvature
// of the segment leaving it.
func readVertex2D(b *bitReader, v Version) *cad.Vertex {
	var vx cad.Vertex
	b.bits(8) // flags: which fits this vertex participates in
	vx.Point.X, vx.Point.Y, vx.Point.Z = b.bd3()

	// A negative start width is not a width. It means both ends share
	// its magnitude and that the end width is therefore not stored —
	// the encoder's way of halving the cost of the common case, since a
	// polyline with width usually has one width throughout.
	vx.StartWidth = b.bd()
	if vx.StartWidth < 0 {
		vx.StartWidth = -vx.StartWidth
		vx.EndWidth = vx.StartWidth
	} else {
		vx.EndWidth = b.bd()
	}

	vx.Bulge = b.bd()
	if v.AtLeast(R2010) {
		b.bl() // vertex identifier
	}
	b.bd() // tangent direction, used only by the curve fits
	return &vx
}

// readVertex3D decodes a VERTEX_3D, which is a point and nothing else.
// A 3D run has no width and no bulge: an arc is planar, so a bulge would
// have no plane to be measured in.
func readVertex3D(b *bitReader) *cad.Vertex {
	var vx cad.Vertex
	b.bits(8) // flags
	vx.Point.X, vx.Point.Y, vx.Point.Z = b.bd3()
	return &vx
}
