package dwg

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The layer references and the layer table are decoded from opposite
// ends of an object and by unrelated code, so they agree only if both
// are right. Every entity naming a layer the table declared is therefore
// a check on the handle stream, on the table record and on the handle
// arithmetic that relates them — none of which the two halves could pass
// separately by luck, since a wrong reference lands on a real object far
// more often than on a real *layer*.
func TestReadNamesEveryEntitysLayer(t *testing.T) {
	for _, p := range fixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		doc, err := Read(data)
		if errors.Is(err, ErrNoGeometry) {
			// Honest for a drawing built entirely from types that are not
			// decoded yet. Skipping keeps this test about the layer
			// pipeline rather than about coverage of entity types.
			t.Logf("%s: %v", name, err)
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}

		used := map[string]int{}
		for _, e := range doc.Entities {
			l := e.Base().Layer
			if l == "" {
				t.Errorf("%s: %s %#x names no layer", name, e.Kind(), e.Base().Handle)
				continue
			}
			if doc.Layer(l) == nil {
				t.Errorf("%s: %s %#x names layer %q, which the table does not declare",
					name, e.Kind(), e.Base().Handle, l)
			}
			used[l]++
		}
		t.Logf("%s: %s, %d entities across %d of %d layers",
			name, doc.Header.Version, len(doc.Entities), len(used), len(doc.Layers))
	}
}
