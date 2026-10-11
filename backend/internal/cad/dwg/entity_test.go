package dwg

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// A decoder that misreads any field lands somewhere other than the end
// of the data, and the odds of landing there anyway are one in the
// object's length. Requiring an exact landing on every object of every
// decoded type is therefore a complete proof of the field layout, not a
// sample of it — and it is the only such proof available, because
// nothing in the file states what a coordinate should be.
func TestEntityDecodeConsumesExactlyTheDataStream(t *testing.T) {
	var grandTotal int
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

		var decoded, fragments, stringClaims, skipped int
		var texts, empty, unreadable int
		for _, r := range refs {
			o, err := readObject(objects, r, f.Version)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			// readEntity itself refuses any entity that does not finish on
			// dataEnd, so an error here is that assertion firing.
			p, err := readEntity(o)
			if err != nil {
				t.Errorf("%s: %v", name, err)
				continue
			}
			// readEntity lets an attribute abandon its record rather than
			// fail the drawing, because R2010's multiline form embeds a
			// whole MTEXT and nothing in the single-line layout announces
			// it. No fixture holds one, so the escape must stay unused
			// here — otherwise the landing assertion above is no longer a
			// statement about every object in the file.
			if p.Skipped {
				skipped++
			}
			if p.Entity == nil {
				// A VERTEX or a SEQEND was still decoded and still had to
				// land, so it is counted rather than ignored: those are the
				// bulk of some drawings, and the assertion above covered them
				// on the way past.
				if p.Vertex != nil || o.Type == typeSeqend {
					fragments++
				}
				continue
			}
			decoded++
			// Every decoded type but the text-bearing ones is pure geometry,
			// so the flag at the end of its data must be clear. It is an
			// independent check on the landing position: a wrong one would
			// put this on an arbitrary bit, which would not read as zero
			// every time. Attributes carry a tag, a value and a prompt, so
			// they claim a string stream as legitimately as TEXT does.
			switch o.Type {
			case typeText, typeMText, typeAttrib, typeAttdef:
			default:
				if o.stringsPresent() {
					stringClaims++
				}
			}
			// Landing proves the framing and cannot see what the bits were
			// read as, so the one field here that has a knowable shape is
			// checked directly. A string stream located even slightly wrong
			// decodes as replacement characters or as nothing at all.
			if txt, ok := p.Entity.(*cad.Text); ok {
				texts++
				switch {
				case txt.Value == "":
					empty++
				case !utf8.ValidString(txt.Value) || strings.ContainsRune(txt.Value, utf8.RuneError):
					unreadable++
				}
			}
		}
		grandTotal += decoded
		if skipped != 0 {
			t.Errorf("%s: %d objects took the attribute escape instead of landing", name, skipped)
		}
		if stringClaims != 0 {
			t.Errorf("%s: %d of %d entities claim a string stream but have no string fields",
				name, stringClaims, decoded)
		}
		// Zero is legitimate per file — a drawing can be built entirely
		// from types not decoded yet — so the guard against the decoder
		// quietly finding nothing drawable anywhere has to be taken across
		// the whole fixture set.
		// Text that decoded to nothing, or to replacement characters, means
		// the string stream was located wrongly — which the landing check
		// above cannot see, because the strings are read from a different
		// stream and cost the data cursor nothing. Every one of the 3,733
		// strings across these fixtures is readable, so the bar is all of
		// them rather than most: a file where it slips is a file where the
		// room names arrive as mojibake.
		if empty != 0 || unreadable != 0 {
			t.Errorf("%s: of %d text entities, %d decoded empty and %d contain replacement characters",
				name, texts, empty, unreadable)
		}
		t.Logf("%-24s %-6s %6d entities + %6d vertices/seqends, all landing exactly, %d readable strings",
			name, f.Version.Name(), decoded, fragments, texts)
	}
	if grandTotal == 0 {
		t.Error("no drawable entities decoded in any fixture")
	}
}

// Landing proves the field layout but says nothing about whether the
// bits were interpreted as the right kind of value; a coordinate read
// with its bytes reversed still consumes 64 bits. Real drawings are
// bounded — a building is not light-years across, and its geometry is
// not all at the origin — so the extent is the check that the numbers
// mean what the layout says they mean.
// It runs on the assembled document rather than on loose entities,
// because a POLYLINE is not geometry until its vertices are attached —
// an unstitched chain has an empty extent, and the drawing made
// entirely of chains would pass a bounds check by having nothing to
// bound.
func TestEntityGeometryIsPlausible(t *testing.T) {
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
		ents := doc.Entities

		box := cad.Bounds(ents)
		if !box.Valid {
			t.Errorf("%s: no bounds from %d entities", name, len(ents))
			continue
		}
		w, hgt := box.Max.X-box.Min.X, box.Max.Y-box.Min.Y
		for _, v := range []float64{box.Min.X, box.Min.Y, box.Max.X, box.Max.Y} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				t.Fatalf("%s: bounds are not finite: %v", name, box)
			}
		}
		// Drawing units are unknown here, so the bound has to be loose
		// enough for millimetres and feet alike. It still rules out the
		// failure that matters: misread doubles land at 1e300 or at
		// denormal zero, never in the range a building occupies.
		if w <= 0.001 || hgt <= 0.001 || w > 1e9 || hgt > 1e9 {
			t.Errorf("%s: extent %.3f x %.3f is not a drawing", name, w, hgt)
		}
		t.Logf("%-24s %6d entities, extent %.1f x %.1f drawing units", name, len(ents), w, hgt)
	}
}
