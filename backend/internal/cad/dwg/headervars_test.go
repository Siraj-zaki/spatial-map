package dwg

import (
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// A header variable has no name, no tag and no length. Position is the
// only thing that identifies it, so the section cannot be checked the way
// the rest of the reader is checked — there is no field that disagrees
// with itself, and every misreading produces a number rather than an
// error.
//
// Except in the handle stream. Nineteen of the section's values are
// handles, and a handle names an object whose type the object map states
// independently. Nine of those nineteen are the table controls, and their
// types are fixed by the format: the first must be a BLOCK_CONTROL, the
// fourth an LTYPE_CONTROL, and so on. So the section makes nine
// falsifiable claims about a part of the file it does not own, and a walk
// that took a wrong turn anywhere before them gets all nine wrong at
// once.
//
// That is what this test is for. The landing assertion inside
// readHeaderVars proves the walk consumed the right *number* of bits; it
// cannot distinguish a correct walk from a wrong one that happens to cost
// the same. These handles can, and they reach back through the whole
// list: the controls are read after the dimension block, which is after
// both coordinate systems, which is after the timestamps — so confirming
// them confirms everything in front of them landed too.
func TestHeaderNamesTheObjectsItClaims(t *testing.T) {
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
		sec, err := f.sections.Section("AcDb:Header")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		hv, err := readHeaderVars(sec, f.Version)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}

		objects, _ := f.sections.Section("AcDb:AcDbObjects")
		raw, _ := f.sections.Section("AcDb:Handles")
		refs, err := readObjectMap(raw, len(objects))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		typeOf := map[uint64]uint16{}
		var maxHandle uint64
		var modelSpace uint64
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			typeOf[o.Handle] = o.Type
			maxHandle = max(maxHandle, o.Handle)
			if o.Type != typeBlockHeader {
				continue
			}
			blk, _, err := readBlockHeader(o)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if isModelSpaceBlock(blk.Name) {
				modelSpace = o.Handle
			}
		}

		for i, h := range hv.Controls {
			if got, want := typeOf[h], headerControlTypes[i]; got != want {
				t.Errorf("%s: control %d is handle %#x, a %s, not a %s",
					name, i, h, typeName(got), typeName(want))
			}
		}

		// Model space is named twice over: here, and by whichever block
		// header calls itself *Model_Space. The second is found by reading
		// the object map, which shares no code and no offsets with the
		// header walk, so agreement is worth something.
		if modelSpace == 0 {
			t.Errorf("%s: no model-space block header", name)
		} else if hv.ModelSpace != modelSpace {
			t.Errorf("%s: header names model space %#x, the block table names it %#x",
				name, hv.ModelSpace, modelSpace)
		}
		if got := typeOf[hv.PaperSpace]; got != typeBlockHeader {
			t.Errorf("%s: paper space %#x is a %s", name, hv.PaperSpace, typeName(got))
		}
		if got := typeOf[hv.NamedObject]; got != typeDictionary {
			t.Errorf("%s: named-object root %#x is a %s", name, hv.NamedObject, typeName(got))
		}

		// HANDSEED is the next handle the application would issue, so it
		// bounds every handle in the file. It is the one value in the
		// section read from the data stream as a handle rather than from the
		// handle stream, which makes it the only check on that distinction.
		if hv.HandSeed <= maxHandle {
			t.Errorf("%s: handseed %#x does not exceed the largest handle in use, %#x",
				name, hv.HandSeed, maxHandle)
		}

		t.Logf("%-24s %s  units=%d handseed=%#x model=%#x", name, f.Version, hv.InsUnits, hv.HandSeed, hv.ModelSpace)
	}
}

// The extents are the section's other falsifiable claim, and the only one
// that touches geometry.
//
// $EXTMIN and $EXTMAX are what the application last computed for the
// drawing, decoded here from eighteen doubles roughly two thirds of the
// way through the walk. Every entity's coordinates are decoded somewhere
// else entirely, from a different section, so the two agreeing is a
// statement about both. They are not asserted equal — the extents go
// stale the moment something is deleted without a regen, which is why
// cad.Bounds recomputes rather than trusting them — but they must be the
// same drawing, and being read off by a field would make them the size of
// a sheet of paper or a number with no decimal point in common.
func TestHeaderExtentsDescribeTheSameDrawing(t *testing.T) {
	compared := 0
	for _, p := range fixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		doc, err := Read(data)
		if err != nil {
			t.Skipf("%s: %v", name, err)
		}
		// A drawing saved without a regen since its last edit carries the
		// ±1e20 sentinel instead of a measurement, and two of the fixtures
		// do. That is a fact about those files, not a decoding failure —
		// what would be a failure is reading the sentinel as a number, so
		// the assertion is that some fixture reaches the comparison below.
		if !doc.Header.HasExtents {
			t.Logf("%s: extents never computed", name)
			continue
		}
		compared++
		res, err := doc.Flatten(cad.DefaultFlattenOptions())
		if err != nil {
			t.Fatalf("%s: flatten: %v", name, err)
		}
		// Measured over the entities the header's box actually reaches,
		// because a drawing routinely carries a little scrap parked off the
		// sheet — a mirrored fragment, a detail somebody dragged aside — and
		// the extents do not follow it until the next regen. One such line
		// stretches a fixture's measured width sevenfold while its height
		// stays exact to a part in ten thousand, which is a fact about that
		// file and not about this decoder.
		//
		// Excluding them costs nothing the check was relying on: the count
		// below is the stricter half. A field-offset error puts the box
		// somewhere else entirely, so it strands the whole drawing outside
		// rather than five lines of it, and that is a failure this
		// formulation catches and the plain comparison never could.
		var inside cad.BBox
		var stray int
		for _, e := range res.Entities {
			b := cad.EntityBounds(e)
			if !b.Valid {
				continue
			}
			if b.Max.X < doc.Header.ExtMin.X || b.Min.X > doc.Header.ExtMax.X ||
				b.Max.Y < doc.Header.ExtMin.Y || b.Min.Y > doc.Header.ExtMax.Y {
				stray++
				continue
			}
			inside = inside.Union(b)
		}
		if !inside.Valid {
			t.Errorf("%s: the header's extents reach none of the %d entities", name, len(res.Entities))
			continue
		}
		if stray*100 > len(res.Entities) {
			t.Errorf("%s: %d of %d entities lie outside the header's extents",
				name, stray, len(res.Entities))
		}

		hw := doc.Header.ExtMax.X - doc.Header.ExtMin.X
		hh := doc.Header.ExtMax.Y - doc.Header.ExtMin.Y
		gw := inside.Max.X - inside.Min.X
		gh := inside.Max.Y - inside.Min.Y
		if hw <= 0 || hh <= 0 {
			t.Errorf("%s: header extents are %.1f x %.1f", name, hw, hh)
			continue
		}
		// A factor of four either way. Loose on purpose: the point is to
		// catch a field-offset error, and those miss by orders of magnitude
		// or by sign, never by a third. Paper-space extents — the failure
		// this is really watching for, since the section states the same
		// nine values twice and only the second set is the drawing — are a
		// sheet of paper measured in the same units, so on these fixtures
		// they are out by a factor of several hundred.
		for _, r := range []float64{hw / gw, hh / gh} {
			if math.IsNaN(r) || r < 0.25 || r > 4 {
				t.Errorf("%s: header says %.1f x %.1f, geometry measures %.1f x %.1f",
					name, hw, hh, gw, gh)
				break
			}
		}
		t.Logf("%-24s header %9.1f x %-9.1f geometry %9.1f x %-9.1f %4d stray units=%v",
			name, hw, hh, gw, gh, stray, doc.Header.Units)
	}
	if compared == 0 {
		t.Error("no fixture had computed extents — the comparison never ran")
	}
}
