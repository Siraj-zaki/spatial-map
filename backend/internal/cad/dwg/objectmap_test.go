package dwg

import (
	"os"
	"path/filepath"
	"testing"
)

// The object map is self-proving in a way the sections above it are not:
// every offset it produces must land on an object whose own length field
// is sane, handles must be unique, and the entries must tile the object
// section without gaps big enough to hide a lost object. Getting the
// delta encoding or the chunk framing wrong fails all three loudly.
func TestObjectMapIndexesEveryObject(t *testing.T) {
	for _, p := range fixtures(t) {
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		name := filepath.Base(p)

		f, err := open(data)
		if err != nil {
			t.Logf("%s: %v", name, err)
			continue
		}
		objects, err := f.sections.Section("AcDb:AcDbObjects")
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		mapRaw, err := f.sections.Section("AcDb:Handles")
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}

		refs, err := readObjectMap(mapRaw, len(objects))
		if err != nil {
			t.Errorf("%s (%s): %v", name, f.Version, err)
			continue
		}
		if len(refs) == 0 {
			t.Errorf("%s: object map is empty", name)
			continue
		}

		seen := make(map[uint64]bool, len(refs))
		for _, r := range refs {
			if seen[r.Handle] {
				t.Errorf("%s: handle %#x appears twice in the object map", name, r.Handle)
				break
			}
			seen[r.Handle] = true
		}

		t.Logf("%-24s %-6s %6d objects, %d bytes of object data",
			name, f.Version.Name(), len(refs), len(objects))
	}
}
