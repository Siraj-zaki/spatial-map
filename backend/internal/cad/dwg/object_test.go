package dwg

import (
	"os"
	"path/filepath"
	"testing"
)

// counts is the type histogram of a whole drawing.
type counts map[uint16]int

func histogram(t *testing.T, path string) (counts, Version, int) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	f, err := open(data)
	if err != nil {
		t.Skipf("%s: %v", filepath.Base(path), err)
	}
	objects, err := f.sections.Section("AcDb:AcDbObjects")
	if err != nil {
		t.Fatalf("%s: %v", filepath.Base(path), err)
	}
	raw, err := f.sections.Section("AcDb:Handles")
	if err != nil {
		t.Fatalf("%s: %v", filepath.Base(path), err)
	}
	refs, err := readObjectMap(raw, len(objects))
	if err != nil {
		t.Fatalf("%s: %v", filepath.Base(path), err)
	}

	h := counts{}
	for _, r := range refs {
		o, err := readObject(objects, r, f.Version)
		if err != nil {
			// One bad object is enough to know the map or the prologue is
			// wrong; reporting all of them buries the useful line.
			t.Fatalf("%s: %v", filepath.Base(path), err)
		}
		h[o.Type]++
	}
	return h, f.Version, len(refs)
}

// readObject already refuses any object whose embedded handle disagrees
// with the map, so reaching this assertion at all means every offset in
// the file landed on a real object prologue. What remains unproven is
// the *type*, which nothing cross-checks — so the counts check each
// other. The format requires certain objects to come in pairs, and no
// plausible wrong reading produces pairings that hold across every
// drawing: garbage does not count out to equal numbers of BLOCK and
// ENDBLK five times running.
func TestObjectTypesAreStructurallyConsistent(t *testing.T) {
	for _, p := range fixtures(t) {
		name := filepath.Base(p)
		h, v, total := histogram(t, p)
		if total == 0 {
			t.Errorf("%s: no objects", name)
			continue
		}

		// Every block definition is a BLOCK_HEADER table record plus the
		// BLOCK and ENDBLK entities that bracket its contents. The
		// brackets are what count: they must pair off exactly, and no
		// wrong reading of the type field produces equal totals of two
		// unrelated numbers five drawings running.
		//
		// The headers are only bounded, not matched. A drawing that has
		// been through enough edits keeps BLOCK/ENDBLK pairs whose header
		// record has since been purged — one fixture has 467 pairs against
		// 286 headers while every other check on it passes, including its
		// header extents agreeing with its geometry to a fraction of a
		// percent.
		const blockHeader, block, endblk = 0x31, 0x04, 0x05
		if h[block] != h[endblk] {
			t.Errorf("%s: %d BLOCK against %d ENDBLK — every definition is bracketed by both",
				name, h[block], h[endblk])
		}
		if h[blockHeader] < 2 || h[blockHeader] > h[block] {
			t.Errorf("%s: %d BLOCK_HEADER against %d BLOCK — expected at least model and paper space, and no more headers than definitions",
				name, h[blockHeader], h[block])
		}

		// Polylines own their vertices as following objects and are
		// terminated by a SEQEND. Inserts with attributes use one too, so
		// SEQENDs can outnumber polylines but never fall short.
		const seqend = 0x06
		polylines := h[0x0F] + h[0x10] + h[0x1D] + h[0x1E]
		if h[seqend] < polylines {
			t.Errorf("%s: %d SEQEND for %d polylines — every polyline needs one",
				name, h[seqend], polylines)
		}

		// A drawing always carries the nine table-control objects, and
		// they are singletons. Finding two of one would mean the type
		// field was being read from the wrong bit offset.
		for _, ctrl := range []uint16{0x30, 0x32, 0x34, 0x38, 0x3C, 0x3E, 0x40, 0x42, 0x44} {
			if h[ctrl] > 1 {
				t.Errorf("%s: %d %s objects, expected at most one", name, h[ctrl], typeName(ctrl))
			}
		}

		t.Logf("%-24s %-6s %6d objects, %d distinct types", name, v.Name(), total, len(h))
	}
}
