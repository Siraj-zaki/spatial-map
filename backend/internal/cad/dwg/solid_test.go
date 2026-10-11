package dwg

import (
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// A SOLID's corners are stored as a bow tie — 0 and 1 along one edge, 2
// and 3 along the opposite one — so joining them in file order draws a
// figure that crosses itself. readSolid reorders to 0,1,3,2.
//
// Landing cannot see that. The reorder happens after every bit has been
// consumed, so a decoder that skipped it consumes exactly the same data
// and passes the exact-landing assertion in full. What can see it is the
// shape: a quad that does not cross itself is the definition of the
// untangled order, and a bow tie is the definition of the raw one. So
// the test asserts the emitted ring is simple, and separately counts how
// many rings *would* self-intersect if the reorder were dropped — which
// is what stops this from being a check that passes for free on a corpus
// whose solids happen to be stored simple already.
func TestSolidCornersAreASimplePolygon(t *testing.T) {
	var total, wouldCross int
	for _, p := range fixtures(t) {
		name := filepath.Base(p)
		data, _ := os.ReadFile(p)
		f, err := open(data)
		if err != nil {
			t.Skipf("%s: %v", name, err)
		}
		objects, _ := f.sections.Section("AcDb:AcDbObjects")
		raw, _ := f.sections.Section("AcDb:Handles")
		refs, _ := readObjectMap(raw, len(objects))

		var solids, tris, degenerate, crossing int
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil || o.Type != typeSolid {
				continue
			}
			e, err := readEntity(o)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			s, ok := e.Entity.(*cad.Solid)
			if !ok {
				t.Fatalf("%s: SOLID %#x decoded as %T", name, o.Handle, e.Entity)
			}
			solids++
			if len(s.Corners) == 3 {
				tris++
			}
			if area(s.Corners) < 1e-9 {
				degenerate++
			}
			if selfCrossing(s.Corners) {
				crossing++
				t.Errorf("%s: SOLID %#x is self-intersecting: %v", name, o.Handle, s.Corners)
			}
			// The raw file order is the emitted one with its last two
			// corners swapped back.
			if len(s.Corners) == 4 {
				bow := []cad.Vec3{s.Corners[0], s.Corners[1], s.Corners[3], s.Corners[2]}
				if selfCrossing(bow) {
					wouldCross++
				}
			}
		}
		if solids == 0 {
			continue
		}
		total += solids
		if degenerate != 0 {
			t.Errorf("%s: %d of %d solids enclose no area", name, degenerate, solids)
		}
		t.Logf("%-24s %-6s %3d solids (%d triangles), %d self-intersecting",
			name, f.Version.Name(), solids, tris, crossing)
	}
	if total == 0 {
		t.Skip("no solids in any fixture")
	}
	// Reported rather than asserted, because it is currently zero: every
	// solid in this corpus is a triangle, and the two orders coincide for
	// a triangle. So the check above is real but cannot distinguish the
	// reorder from its absence, and TestSolidRingUntanglesABowTie carries
	// that half. If a future fixture makes this non-zero, the corpus has
	// started proving it too.
	t.Logf("%d solids total; %d would self-intersect without the bow-tie reorder", total, wouldCross)
}

// The quad case no fixture here contains. A SOLID's corners are stored
// as two edges of a strip — 0→1 on one side, 2→3 on the other — so the
// ring 0,1,2,3 crosses itself and the ring 0,1,3,2 does not. Constructed
// rather than sampled because the corpus is all triangles; without this
// the reorder would be code no test can reach.
func TestSolidRingUntanglesABowTie(t *testing.T) {
	// The unit square, stored as the strip its two triangles want.
	sw := cad.Vec3{X: 0, Y: 0}
	se := cad.Vec3{X: 1, Y: 0}
	nw := cad.Vec3{X: 0, Y: 1}
	ne := cad.Vec3{X: 1, Y: 1}

	stored := [4]cad.Vec3{sw, se, nw, ne}
	if bow := stored[:]; !selfCrossing(bow) {
		t.Fatalf("the stored order is not a bow tie, so this test proves nothing: %v", bow)
	}

	ring := solidRing(stored)
	if len(ring) != 4 {
		t.Fatalf("four distinct corners produced a ring of %d", len(ring))
	}
	if selfCrossing(ring) {
		t.Errorf("untangled ring still crosses itself: %v", ring)
	}
	if got := area(ring); math.Abs(got-1) > 1e-9 {
		t.Errorf("unit square came out with area %g", got)
	}

	// And the degenerate quad the format uses for a triangle.
	tri := solidRing([4]cad.Vec3{sw, se, ne, ne})
	if len(tri) != 3 {
		t.Errorf("a quad with a repeated corner produced %d corners: %v", len(tri), tri)
	}
	if got := area(tri); math.Abs(got-0.5) > 1e-9 {
		t.Errorf("half-square triangle came out with area %g", got)
	}
}

// area is the shoelace area of a ring, ignoring Z. Solids are planar in
// their own coordinate system, so the projection is exact.
func area(ring []cad.Vec3) float64 {
	var a float64
	for i, p := range ring {
		q := ring[(i+1)%len(ring)]
		a += p.X*q.Y - q.X*p.Y
	}
	return math.Abs(a) / 2
}

// selfCrossing reports whether a ring's non-adjacent edges intersect.
// For a quad that is the single pair of opposite edges, which is exactly
// what tells a bow tie from a simple quadrilateral.
func selfCrossing(ring []cad.Vec3) bool {
	n := len(ring)
	for i := range n {
		for j := i + 1; j < n; j++ {
			if j == i+1 || (i == 0 && j == n-1) {
				continue // adjacent edges share a corner by construction
			}
			if segmentsCross(ring[i], ring[(i+1)%n], ring[j], ring[(j+1)%n]) {
				return true
			}
		}
	}
	return false
}

func segmentsCross(a, b, c, d cad.Vec3) bool {
	d1, d2 := side(c, d, a), side(c, d, b)
	d3, d4 := side(a, b, c), side(a, b, d)
	return d1*d2 < 0 && d3*d4 < 0
}

// side is the signed area of the triangle pqr — positive on one side of
// pq, negative on the other, zero when collinear.
func side(p, q, r cad.Vec3) float64 {
	return (q.X-p.X)*(r.Y-p.Y) - (q.Y-p.Y)*(r.X-p.X)
}
