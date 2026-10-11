package dwg

import (
	"fmt"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// LWPOLYLINE is the modern polyline: one object holding every vertex,
// rather than the older POLYLINE's chain of separate VERTEX objects. It
// is what a drawing is mostly made of once it is past straight walls —
// room outlines, furniture, kerbs, anything traced as a run of segments.
//
// Implemented from the Open Design Alliance's specification §2.4.5.

// The flag word says which optional fields are present. Everything here
// is optional: a plain open polyline with no width and no bulges stores
// nothing but its points, which is why the flag exists at all.
const (
	lwExtrusion  = 0x001
	lwThickness  = 0x002
	lwConstWidth = 0x004
	lwElevation  = 0x008
	lwBulges     = 0x010
	lwWidths     = 0x020
	lwClosed     = 0x200
	lwVertexIDs  = 0x400
)

// lwMaxVertices caps the per-object vertex count. The count is a
// 32-bit field read straight from an attacker-controlled file, so it
// must not reach make() unchecked. The cap is far above any real
// drawing — the largest polyline in any fixture is three orders of
// magnitude below it — and the object's own framed extent would reject
// anything near it anyway, but that rejection happens after the
// allocation.
const lwMaxVertices = 1 << 22

func readLWPolyline(b *bitReader, v Version, c cad.Common) (*cad.Polyline, error) {
	p := &cad.Polyline{Common: c}

	flags := b.bs()
	p.Closed = flags&lwClosed != 0

	if flags&lwConstWidth != 0 {
		p.ConstWidth = b.bd()
	}
	if flags&lwElevation != 0 {
		p.Elevation = b.bd()
	}
	if flags&lwThickness != 0 {
		b.bd()
	}
	if flags&lwExtrusion != 0 {
		p.Extrusion.X, p.Extrusion.Y, p.Extrusion.Z = b.bd3()
	}

	// The three counts are independent of the vertex count and of each
	// other: a polyline can carry bulges for every vertex, for none, or
	// for a subset, and the file says which.
	nPoints := b.bl()
	var nBulges, nIDs, nWidths uint32
	if flags&lwBulges != 0 {
		nBulges = b.bl()
	}
	if v.AtLeast(R2010) && flags&lwVertexIDs != 0 {
		nIDs = b.bl()
	}
	if flags&lwWidths != 0 {
		nWidths = b.bl()
	}
	if err := b.Err(); err != nil {
		return nil, err
	}
	for _, n := range [...]uint32{nPoints, nBulges, nIDs, nWidths} {
		if n > lwMaxVertices {
			return nil, fmt.Errorf("%w: lwpolyline claims %d elements", ErrMalformed, n)
		}
	}

	// Vertices are a chain of deltas: only the first arrives whole, and
	// each one after it is expressed against its predecessor. Successive
	// points on a traced outline are close together, so most of the bits
	// of each coordinate repeat and the encoding drops them.
	p.Vertices = make([]cad.Vertex, nPoints)
	var prevX, prevY float64
	for i := range p.Vertices {
		if i == 0 {
			prevX, prevY = b.rd2()
		} else {
			prevX, prevY = b.dd2(prevX, prevY)
		}
		p.Vertices[i].Point = cad.Vec3{X: prevX, Y: prevY, Z: p.Elevation}
	}

	// The remaining arrays are positional: bulge n belongs to vertex n.
	// They are read in full even when longer than the vertex list,
	// because the object's data has to be consumed exactly whatever the
	// counts say, and dropping the surplus is cheaper than being wrong
	// about where the entity ends.
	for i := range nBulges {
		bulge := b.bd()
		if int(i) < len(p.Vertices) {
			p.Vertices[i].Bulge = bulge
		}
	}
	for range nIDs {
		b.bl()
	}
	for i := range nWidths {
		start, end := b.bd(), b.bd()
		if int(i) < len(p.Vertices) {
			p.Vertices[i].StartWidth, p.Vertices[i].EndWidth = start, end
		}
	}
	return p, b.Err()
}
