package dwg

import (
	"os"
	"path/filepath"
	"testing"
)

// Landing proves a polyline's own fields and a vertex's own fields, but
// it cannot prove the list that joins them: the count is read from the
// data stream and the handles it counts live in the handle stream, so a
// decoder that read the count wrongly consumes a different number of
// handles and still finishes somewhere legal.
//
// What catches that is arithmetic across the whole drawing. Every VERTEX
// object belongs to exactly one polyline — the format has no way to
// share one and no reason to orphan one — so claiming each of them once
// and only once is a statement no miscount can satisfy. A count read one
// too high steals its neighbour's first vertex, leaving that one short
// and this one claiming a vertex twice; a count read one too low orphans
// the last. Both show up here as a non-zero number, and neither shows up
// anywhere else.
func TestPolylineChainsClaimEveryVertex(t *testing.T) {
	for _, p := range fixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		f, err := open(data)
		if err != nil {
			t.Skipf("%s: %v", name, err)
		}
		objects, err := f.sections.Section("AcDb:AcDbObjects")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		raw, err := f.sections.Section("AcDb:Handles")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		refs, err := readObjectMap(raw, len(objects))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}

		isVertex := map[uint64]bool{}
		claims := map[uint64]int{}
		var polylines, seqends, shortest, longest int
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			part, err := readEntity(o)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			switch o.Type {
			case typeVertex2D, typeVertex3D:
				isVertex[o.Handle] = true
			case typeSeqend:
				seqends++
			case typePolyline2D, typePolyline3D:
				polylines++
				n := len(part.Refs.Children)
				if polylines == 1 || n < shortest {
					shortest = n
				}
				if n > longest {
					longest = n
				}
				for _, h := range part.Refs.Children {
					claims[h.resolve(o.Handle)]++
				}
			}
		}
		if len(isVertex) == 0 {
			continue
		}

		var unclaimed, contested int
		for h := range isVertex {
			switch claims[h] {
			case 0:
				unclaimed++
			case 1:
			default:
				contested++
			}
		}
		var phantom int
		for h := range claims {
			if !isVertex[h] {
				phantom++
			}
		}
		if unclaimed != 0 {
			t.Errorf("%s: %d of %d vertices belong to no polyline", name, unclaimed, len(isVertex))
		}
		if contested != 0 {
			t.Errorf("%s: %d vertices are claimed by more than one polyline", name, contested)
		}
		if phantom != 0 {
			t.Errorf("%s: polylines name %d handles that are not vertices", name, phantom)
		}

		// A SEQEND closes a vertex chain, and INSERT uses one too when it
		// carries attributes, so there can be more of them than there are
		// polylines — but never fewer, because every chain needs one.
		if seqends < polylines {
			t.Errorf("%s: %d polylines but only %d SEQENDs", name, polylines, seqends)
		}
		// A run of one point is not a line. It is legal to store and some
		// drawings contain them, so this is reported rather than refused —
		// but a decoder that lost its vertices would report it for every
		// polyline at once, which is the reading worth noticing.
		if shortest < 2 {
			t.Logf("%s: shortest run is %d vertices", name, shortest)
		}
		t.Logf("%-24s %5d polylines claim all %6d vertices, runs of %d to %d",
			name, polylines, len(isVertex), shortest, longest)
	}
}
