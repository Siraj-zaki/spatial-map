package dwg

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// Ownership is stated twice and the two statements are made in different
// places, which is what makes them worth comparing.
//
// A block header lists the objects it owns, by handle, in its handle
// stream. Each of those objects separately says who owns it — either by
// naming the handle back, or by spending two bits in its data to say
// "model space" or "paper space" and naming nobody. So the drawing
// asserts the same fact from both ends, and a decoder that read either
// end wrongly disagrees with itself.
//
// It is the only check available on the two-bit form. An entity that says
// "model space" says it in a field with four legal values and no
// redundancy: read as the wrong value it is still a legal value, the
// object still lands exactly, its handle stream is still exhausted, and
// the only visible consequence is that a wall ends up filed under the
// title block. The block header's list is what catches that, because the
// list has to contain exactly the objects that claimed it and no others.
func TestBlockContentsAgreeWithOwners(t *testing.T) {
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
		if !f.Version.AtLeast(R2004) {
			// Before R2004 a block header named only the first and last of
			// its contents and the chain ran through the entities themselves,
			// so there is no list to compare against.
			continue
		}
		objects, _ := f.sections.Section("AcDb:AcDbObjects")
		raw, _ := f.sections.Section("AcDb:Handles")
		refs, err := readObjectMap(raw, len(objects))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}

		// What the block headers say.
		ownerOf := map[uint64]uint64{}
		headerName := map[uint64]string{}
		var contested int
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if o.Type != typeBlockHeader {
				continue
			}
			blk, owned, err := readBlockHeader(o)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			headerName[o.Handle] = blk.Name
			for _, h := range owned {
				c := h.resolve(o.Handle)
				if _, dup := ownerOf[c]; dup {
					contested++
				}
				ownerOf[c] = o.Handle
			}
		}
		if len(headerName) == 0 {
			t.Errorf("%s: no block headers", name)
			continue
		}
		if contested != 0 {
			t.Errorf("%s: %d objects are owned by more than one block", name, contested)
		}

		// What the entities say.
		var checked, unowned, mismatched, wrongSpace int
		spaces := map[string]int{}
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			e, err := readEntity(o)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if e.Entity == nil && e.Vertex == nil {
				continue
			}
			if e.Vertex != nil || o.Type == typeAttrib ||
				e.Refs.EntMode == entModeOwned && !isSpaceOwned(ownerOf, headerName, o.Handle) {
				// A vertex belongs to its polyline and an attribute to its
				// insert, neither of which is a block header. Those chains are
				// proved by TestPolylineChainsClaimEveryVertex and
				// TestAttributesHangOffInserts; here they would only read as
				// absences.
				continue
			}
			checked++

			owner, ok := ownerOf[o.Handle]
			if !ok {
				unowned++
				continue
			}
			switch e.Refs.EntMode {
			case entModeOwned:
				if got := e.Refs.Owner.resolve(o.Handle); got != owner {
					mismatched++
					if mismatched <= 3 {
						t.Errorf("%s: %s %#x names owner %#x but is listed by %#x (%s)",
							name, typeName(o.Type), o.Handle, got, owner, headerName[owner])
					}
				}
			case entModeModel:
				if !isModelSpaceBlock(headerName[owner]) {
					wrongSpace++
				}
			case entModePaper:
				if !isLayoutBlock(headerName[owner]) {
					wrongSpace++
				}
			default:
				wrongSpace++
			}
			spaces[headerName[owner]]++
		}

		if unowned != 0 {
			t.Errorf("%s: %d of %d entities are listed by no block", name, unowned, checked)
		}
		if mismatched != 0 {
			t.Errorf("%s: %d of %d entities disagree with the block that lists them", name, mismatched, checked)
		}
		if wrongSpace != 0 {
			t.Errorf("%s: %d of %d entities claim a space the listing block is not", name, wrongSpace, checked)
		}
		t.Logf("%-24s %4d blocks own %6d entities; largest %d in %q",
			name, len(headerName), checked, maxCount(spaces), argmax(spaces))
	}
}

// Blocks are held by name and looked up by name, and a DWG does not give
// its anonymous definitions individual names: it stores them under a bare
// prefix, so a plan with 875 dimensions has 875 BLOCK_HEADERs all called
// "*D". Registered as they stand, one survives and the other 874 become
// copies of it.
//
// Both halves of that are checked here, and only together do they mean
// anything. Counting the definitions catches the loss; reading the same
// bytes twice catches the part that made it a moving target rather than a
// consistent mistake — the definitions arrived from a map, so which one
// survived changed on each read, and the same drawing converted to a
// different size every time it was opened. A count alone would be
// satisfied by a reader that lost the same 874 blocks every time.
func TestBlockNamesSurviveTheirNamesakes(t *testing.T) {
	for _, p := range fixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}

		// What the file holds, counted from the objects rather than from
		// the document, so the expectation cannot inherit the bug.
		f, err := open(data)
		if err != nil {
			t.Skipf("%s: %v", name, err)
		}
		objects, _ := f.sections.Section("AcDb:AcDbObjects")
		raw, _ := f.sections.Section("AcDb:Handles")
		refs, err := readObjectMap(raw, len(objects))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var want int
		shared := map[string]int{}
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if o.Type != typeBlockHeader {
				continue
			}
			blk, _, err := readBlockHeader(o)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if isModelSpaceBlock(blk.Name) {
				continue
			}
			want++
			shared[blk.Name]++
		}

		doc, err := Read(data)
		if errors.Is(err, ErrNoGeometry) {
			t.Logf("%s: %v", name, err)
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(doc.Blocks) != want {
			t.Errorf("%s: %d block headers became %d definitions", name, want, len(doc.Blocks))
		}

		// A second read of the same bytes. Entity counts and extents are
		// what the import is placed by, so they are what has to be stable;
		// the block a reference resolves to is upstream of both.
		again, err := Read(data)
		if err != nil {
			t.Fatalf("%s: second read: %v", name, err)
		}
		first, err := doc.Flatten(cad.DefaultFlattenOptions())
		if err != nil {
			t.Fatalf("%s: flatten: %v", name, err)
		}
		second, err := again.Flatten(cad.DefaultFlattenOptions())
		if err != nil {
			t.Fatalf("%s: flatten again: %v", name, err)
		}
		if len(first.Entities) != len(second.Entities) {
			t.Errorf("%s: reading the same bytes twice gave %d and %d entities",
				name, len(first.Entities), len(second.Entities))
		}
		a, b := cad.Bounds(first.Entities), cad.Bounds(second.Entities)
		if a != b {
			t.Errorf("%s: reading the same bytes twice gave extents %v and %v", name, a, b)
		}

		t.Logf("%-24s %4d definitions, most shared name %q x%d, extent %.1f x %.1f",
			name, want, argmax(shared), maxCount(shared),
			a.Max.X-a.Min.X, a.Max.Y-a.Min.Y)
	}
}

// isSpaceOwned reports whether an entity's stated owner is a block header
// at all. An entity owned by a polyline or an insert is a fragment of it,
// not a member of a block.
func isSpaceOwned(ownerOf map[uint64]uint64, headerName map[uint64]string, h uint64) bool {
	owner, ok := ownerOf[h]
	if !ok {
		return true // absences are the failure this test is looking for
	}
	_, isHeader := headerName[owner]
	return isHeader
}

func maxCount(m map[string]int) int {
	var n int
	for _, v := range m {
		n = max(n, v)
	}
	return n
}

func argmax(m map[string]int) string {
	var best string
	var n int
	for k, v := range m {
		if v > n || v == n && k < best {
			best, n = k, v
		}
	}
	return best
}

// A block reference is not geometry, and a reader that stops at decoding
// one has produced a list of positions. The test that it decoded
// correctly is therefore not that the INSERT parsed but that expanding it
// yields a drawing: the same extent, arrived at by a different route.
//
// patient-chairs.dwg is the case that makes the point. Model space holds
// 27 objects, all of them references; every one of its 11,794 polylines
// is inside a block. Before this file existed the reader opened it and
// reported 27 points.
func TestInsertsExpandIntoGeometry(t *testing.T) {
	var grandTotal int
	for _, p := range fixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		doc, err := Read(data)
		if errors.Is(err, ErrNoGeometry) {
			t.Logf("%s: %v", name, err)
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}

		var inserts int
		for _, e := range doc.Entities {
			if _, ok := e.(*cad.Insert); ok {
				inserts++
			}
		}

		res, err := doc.Flatten(cad.DefaultFlattenOptions())
		if err != nil {
			t.Fatalf("%s: flatten: %v", name, err)
		}
		// Every reference this reader emits was resolved to a name at parse
		// time — Read refuses an insert whose block the drawing does not
		// define — so a missing block here means the name resolved to a
		// block that was never registered, which is a different bug and one
		// nothing else would show.
		if len(res.MissingBlocks) != 0 {
			t.Errorf("%s: flatten cannot find blocks %v", name, res.MissingBlocks)
		}
		if res.Truncated {
			t.Errorf("%s: flatten truncated at %d entities", name, len(res.Entities))
		}
		for _, e := range res.Entities {
			if _, ok := e.(*cad.Insert); ok {
				t.Fatalf("%s: flatten left an unexpanded insert", name)
			}
		}
		if inserts == 0 {
			continue
		}
		grandTotal += inserts

		// An expansion that produced fewer entities than it consumed did not
		// expand anything: the references were dropped rather than resolved.
		if len(res.Entities) <= len(doc.Entities)-inserts {
			t.Errorf("%s: %d entities including %d inserts expanded to %d",
				name, len(doc.Entities), inserts, len(res.Entities))
		}

		box := cad.Bounds(res.Entities)
		if !box.Valid {
			t.Errorf("%s: no bounds from %d expanded entities", name, len(res.Entities))
			continue
		}
		w, h := box.Max.X-box.Min.X, box.Max.Y-box.Min.Y
		if math.IsNaN(w) || math.IsInf(w, 0) || w <= 0.001 || w > 1e9 ||
			math.IsNaN(h) || math.IsInf(h, 0) || h <= 0.001 || h > 1e9 {
			t.Errorf("%s: expanded extent %.3f x %.3f is not a drawing", name, w, h)
		}
		t.Logf("%-24s %6d entities incl. %5d inserts -> %6d, extent %.1f x %.1f",
			name, len(doc.Entities), inserts, len(res.Entities), w, h)
	}
	if grandTotal == 0 {
		t.Error("no block references expanded in any fixture")
	}
}
