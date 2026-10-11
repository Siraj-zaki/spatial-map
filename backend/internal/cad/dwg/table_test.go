package dwg

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A layer record is held to the same two assertions as an entity: it
// must consume its data to the bit and its handle stream to the byte.
// Together those pin every field, because the record has no field whose
// length does not depend on the ones before it.
//
// What they cannot pin is meaning, and the meanings here are worth more
// than usual: a wrong visibility bit hides geometry the user expected to
// see. So two things that are knowable without the file are checked as
// well — that a layer called "0" exists, since the application creates
// one and will not let it be deleted, and that Defpoints and only
// Defpoints is non-plotting.
//
// The polarity of the visibility bit is the one thing here taken from
// the specification rather than measured: no fixture has a layer that is
// off or frozen, so both readings agree on all of them.
func TestLayerRecordsDecode(t *testing.T) {
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

		seen := map[string]bool{}
		var total, visible, plottable int
		for _, ref := range refs {
			o, err := readObject(objects, ref, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if o.Type != typeLayer {
				continue
			}
			l, _, err := readLayer(o)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			total++
			if l.Visible() {
				visible++
			}
			if l.Name == "" {
				t.Errorf("%s: layer %#x has no name", name, o.Handle)
				continue
			}
			if seen[l.Name] {
				t.Errorf("%s: two layers named %q", name, l.Name)
			}
			seen[l.Name] = true

			// Two layers have flags that are known from their names, which
			// is what pins the bit position of the values short: a decoder
			// reading it at the wrong offset does not single these two out
			// of a hundred. Defpoints is created by the dimensioning tools
			// to hold geometry that must exist but must never print, and is
			// marked non-plotting on creation; "0" is the layer every
			// drawing starts with and is plottable unless someone has gone
			// out of their way.
			//
			// Every *other* layer is left alone. Marking a layer no-plot is
			// a thing draughtsmen do — one fixture has seventeen, named for
			// it — so requiring the rest to be plottable asserted a drawing
			// convention rather than a decoding fact.
			switch {
			case strings.EqualFold(l.Name, "Defpoints") && l.Plottable:
				t.Errorf("%s: layer %q is plottable", name, l.Name)
			case l.Name == "0" && !l.Plottable:
				t.Errorf("%s: layer \"0\" is not plottable", name)
			}
			if l.Plottable {
				plottable++
			}
		}

		if total == 0 {
			t.Errorf("%s: no layers", name)
			continue
		}
		if !seen["0"] {
			t.Errorf("%s: no layer named \"0\" among %d layers", name, total)
		}

		// A drawing whose layers are mostly hidden — or mostly excluded
		// from the plot — is possible but perverse, and a polarity error on
		// either bit produces exactly that. Real drawings do both to a
		// handful.
		if visible*2 < total {
			t.Errorf("%s: only %d of %d layers visible — check the off/frozen bits",
				name, visible, total)
		}
		if plottable*2 < total {
			t.Errorf("%s: only %d of %d layers plottable — check the values short's offset",
				name, plottable, total)
		}
		t.Logf("%s: %d layers, %d visible, %d plottable", name, total, visible, plottable)
	}
}
