package dwg

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// An ATTRIB is a subentity: it is owned by the INSERT it labels rather
// than by a block, so it appears in no block's contents list and
// TestBlockContentsAgreeWithOwners can only read it as an absence. This
// is the assertion that stands in its place, and it is worth more than
// the one it replaces, because the two halves come from different
// streams of different objects.
//
// The insert states how many attributes it owns in its *data* stream and
// then spends that many handles in its *handle* stream. Each attribute
// separately names its owner, in its own handle stream. So a miscounted
// owned-list consumes a different number of handles and still lands
// legally — the failure this catches is one where every per-object
// assertion passes and the drawing is quietly wrong.
func TestAttributesHangOffInserts(t *testing.T) {
	var grandTotal int
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
		objects, _ := f.sections.Section("AcDb:AcDbObjects")
		raw, _ := f.sections.Section("AcDb:Handles")
		refs, err := readObjectMap(raw, len(objects))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}

		kind := make(map[uint64]uint16)
		claimed := make(map[uint64]int) // insert handle -> attributes it declares
		named := make(map[uint64]int)   // insert handle -> attributes naming it
		var attribs, defs int

		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			kind[o.Handle] = o.Type

			switch o.Type {
			case typeInsert, typeMinsert:
				s := objectStreams(o)
				h := readEntityHeader(s.data, o.Version)
				_, owned, hasAttribs := readInsert(s.data, o.Version, h.common(o), o.Type == typeMinsert)
				if !hasAttribs {
					continue
				}
				if !f.Version.AtLeast(R2004) {
					// Pre-R2004 names only the first and last of the run, so
					// there is no count to compare against.
					continue
				}
				claimed[o.Handle] = owned

			case typeAttrib, typeAttdef:
				e, err := readEntity(o)
				if err != nil {
					t.Fatalf("%s: %v", name, err)
				}
				if o.Type == typeAttdef {
					defs++
					continue
				}
				attribs++
				if e.Refs.EntMode != entModeOwned {
					t.Errorf("%s: ATTRIB %#x is not owned by an entity (entmode %d)",
						name, o.Handle, e.Refs.EntMode)
					continue
				}
				named[e.Refs.Owner.resolve(o.Handle)]++
			}
		}
		if attribs == 0 {
			continue
		}
		grandTotal += attribs

		// Backwards: every attribute names an insert, not something else.
		for owner, n := range named {
			switch kind[owner] {
			case typeInsert, typeMinsert:
			case 0:
				t.Errorf("%s: %d attributes name owner %#x, which the drawing does not contain",
					name, n, owner)
			default:
				t.Errorf("%s: %d attributes name owner %#x, which is a %s",
					name, n, owner, typeName(kind[owner]))
			}
		}
		// Forwards: the count the insert declared is the number that came
		// back. Both directions have to agree for either to be trusted.
		for ins, want := range claimed {
			if got := named[ins]; got != want {
				t.Errorf("%s: insert %#x declares %d attributes but %d name it",
					name, ins, want, got)
			}
		}
		for ins, got := range named {
			if _, ok := claimed[ins]; !ok {
				t.Errorf("%s: %d attributes name insert %#x, which declares none", name, got, ins)
			}
		}
		t.Logf("%-24s %-6s %4d attributes across %d inserts, %d definitions",
			name, f.Version.Name(), attribs, len(claimed), defs)
	}
	if grandTotal == 0 {
		t.Skip("no attributes in any fixture")
	}
}

// An attribute is text, and text is the one field in this reader whose
// value has a knowable shape — so it gets the same treatment TEXT does.
// A tag is an identifier the drawing's author typed, so it is never
// empty and never punctuation; the landing check cannot see either fact,
// because for R2007 and later a string costs the data cursor nothing at
// all.
func TestAttributeTextIsReadable(t *testing.T) {
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

		tags := map[string]int{}
		var total, blank int
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil || (o.Type != typeAttrib && o.Type != typeAttdef) {
				continue
			}
			s := objectStreams(o)
			readEntityHeader(s.data, o.Version)
			readText(s, o.Version, cad.Common{})
			tag := s.tv()
			total++
			if tag == "" {
				blank++
				continue
			}
			tags[tag]++
		}
		if total == 0 {
			continue
		}
		if blank != 0 {
			t.Errorf("%s: %d of %d attributes have an empty tag", name, blank, total)
		}
		t.Logf("%-24s %-6s %4d attributes, %d distinct tags", name, f.Version.Name(), total, len(tags))
	}
}
