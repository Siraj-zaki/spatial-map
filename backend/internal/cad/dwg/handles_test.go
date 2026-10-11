package dwg

import (
	"os"
	"path/filepath"
	"testing"
)

// readEntity already proves the handle stream is consumed exactly, the
// same way it proves it of the data. What that cannot show is that the
// handles were read in the right *order*: a stream whose entries are
// correctly framed but wrongly labelled consumes exactly as many bits.
//
// So this checks meaning rather than extent. Every entity carries a
// layer, and a layer is a real object elsewhere in the file, so the test
// is whether the handle resolves to something the object map knows and
// whether that something is a LAYER. A stream read at the right length
// but the wrong offset would still resolve to *objects* fairly often,
// since handles are dense — but it would land on dictionaries and
// vertices and text styles rather than on layers every single time.
//
// This is also an independent check on the data stream, because which
// handles precede the layer is decided entirely by flags read from the
// data. Getting the entity mode, the reactor count, the extension
// dictionary flag, the colour's book flag or any of the four "3 means a
// handle follows" fields wrong shifts the layer reference and the type
// check fails.
func TestEntityLayerReferencesResolveToLayers(t *testing.T) {
	const typeLayer = 0x33

	var grandTotal int
	for _, p := range fixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		f, err := open(data)
		if err != nil {
			t.Skipf("%s: %v", name, err)
		}
		objects, _ := f.sections.Section("AcDb:AcDbObjects")
		raw, _ := f.sections.Section("AcDb:Handles")
		refs, _ := readObjectMap(raw, len(objects))

		// The map is the file's own statement of what exists, so it is
		// what a resolved handle has to agree with.
		typeOf := make(map[uint64]uint16, len(refs))
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			typeOf[o.Handle] = o.Type
		}

		var checked, unknown, wrongType int
		seen := map[uint64]bool{}
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			p, err := readEntity(o)
			if err != nil || p.Entity == nil {
				continue
			}
			checked++
			h := p.Refs.Layer.resolve(o.Handle)
			switch typ, ok := typeOf[h]; {
			case !ok:
				unknown++
			case typ != typeLayer:
				wrongType++
				if wrongType <= 3 {
					t.Errorf("%s: %s %#x names layer %#x, which is a %s",
						name, typeName(o.Type), o.Handle, h, typeName(typ))
				}
			default:
				seen[h] = true
			}
		}
		if checked == 0 {
			continue
		}
		grandTotal += checked
		if unknown != 0 {
			t.Errorf("%s: %d of %d layer references resolve to handles the object map does not list",
				name, unknown, checked)
		}
		if wrongType != 0 {
			t.Errorf("%s: %d of %d layer references resolve to something that is not a LAYER",
				name, wrongType, checked)
		}
		// A file whose entities all claim the same layer would pass the
		// checks above while proving much less, so the spread is worth
		// reporting: a real drawing separates walls from furniture from
		// dimensions.
		t.Logf("%-24s %6d entities reference %d distinct layers", name, checked, len(seen))
	}
	if grandTotal == 0 {
		t.Error("no layer references checked in any fixture")
	}
}
