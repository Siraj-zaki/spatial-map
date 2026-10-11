package dwg

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// Real DWG files are the only meaningful test for a container reader —
// a synthetic one would only prove the writer and reader agree with each
// other. But drawings are customer data and must not live in the repo
// (docs/workflow.md), so the corpus is supplied out of band and these
// tests skip without it.
//
//	DWG_FIXTURES=/path/to/dwgs go test ./internal/cad/dwg/
func fixtures(t *testing.T) []string {
	t.Helper()
	dir := os.Getenv("DWG_FIXTURES")
	if dir == "" {
		t.Skip("set DWG_FIXTURES to a directory of .dwg files to run this")
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*.dwg"))
	if err != nil || len(paths) == 0 {
		t.Skipf("no .dwg files in %s", dir)
	}
	sort.Strings(paths)
	return paths
}

func TestDetectVersionOnFixtures(t *testing.T) {
	for _, p := range fixtures(t) {
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		v, err := DetectVersion(data)
		if err != nil {
			t.Errorf("%s: %v", filepath.Base(p), err)
			continue
		}
		if _, ok := v.container(); !ok {
			t.Errorf("%s: no container for %s", filepath.Base(p), v)
		}
		t.Logf("%-24s %s", filepath.Base(p), v)
	}
}

// A refusal is the one message a user of an unsupported release will ever
// see, and it is worth more than the release it refuses: every case here
// is one Save As away, so a message that names the release without naming
// the direction has told them nothing they can act on.
//
// Fixture-free on purpose. The releases under test are exactly the ones no
// fixture exists for — which is why they are unsupported — so a test that
// needed one could never run.
func TestUnsupportedVersionNamesTheRemedy(t *testing.T) {
	// Every version the reader claims must actually open, or the advice
	// below sends users to a Save As that does not help. This is the check
	// that keeps the two constants honest as containers are added.
	for v := range versionNames {
		_, ok := v.container()
		if got := v.AtLeast(oldestSupported) && !(v > newestSupported); got != ok {
			t.Errorf("%s: container()=%v but the supported range says %v", v, ok, got)
		}
	}

	for _, tc := range []struct {
		name    string
		version Version
		want    string
	}{
		{"old known release", R2000, `dwg: R2000 (AC1015) is older than this reader supports — re-save as AutoCAD R2004 or later`},
		{"oldest known release", R13, `dwg: R13 (AC1012) is older than this reader supports — re-save as AutoCAD R2004 or later`},
		// R11/R12 shared "AC1009" and predate the named table entirely, so
		// the raw magic is all there is to report — quoting it beats
		// inventing a name for it.
		{"unknown old release", Version("AC1009"), `dwg: unrecognised version "AC1009" is older than this reader supports — re-save as AutoCAD R2004 or later`},
		// A release that does not exist yet. The advice has to invert:
		// telling someone with a future file to save it *newer* is the one
		// instruction guaranteed not to work.
		{"unknown future release", Version("AC1035"), `dwg: unrecognised version "AC1035" is newer than this reader supports — re-save as AutoCAD R2018 or earlier`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := (&ErrUnsupportedVersion{Version: tc.version}).Error()
			if got != tc.want {
				t.Errorf("\n got: %s\nwant: %s", got, tc.want)
			}
		})
	}
}

// The container is proved by the section map: the names are ASCII and
// highly specific, so getting "AcDb:Header" out the far end means the
// header decryption, the LZ77 decompressor, the page-address running
// total and the section map layout are all simultaneously right.
func TestR18ContainerListsSections(t *testing.T) {
	for _, p := range fixtures(t) {
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		v, err := DetectVersion(data)
		if err != nil {
			t.Fatalf("%s: %v", filepath.Base(p), err)
		}
		kind, ok := v.container()
		if !ok || kind != containerR18 {
			continue
		}

		f, err := openR18(data)
		if err != nil {
			t.Errorf("%s (%s): %v", filepath.Base(p), v, err)
			continue
		}
		names := f.sectionNames()
		sort.Strings(names)
		t.Logf("%s (%s): %v", filepath.Base(p), v, names)

		for _, want := range []string{"AcDb:Header", "AcDb:Handles", "AcDb:AcDbObjects", "AcDb:Classes"} {
			body, err := f.Section(want)
			if err != nil {
				t.Errorf("%s: %v", filepath.Base(p), err)
				continue
			}
			if len(body) == 0 {
				t.Errorf("%s: section %q is empty", filepath.Base(p), want)
			}
			t.Logf("  %-20s %d bytes", want, len(body))
		}

		// Byte counts only prove the plumbing lines up. The header
		// section opens with a fixed 16-byte sentinel, so finding it is
		// the difference between "some bytes came out" and "the right
		// bytes came out".
		hdr, err := f.Section("AcDb:Header")
		if err != nil {
			continue
		}
		if !bytes.HasPrefix(hdr, headerSentinel[:]) {
			t.Errorf("%s: AcDb:Header does not start with the header sentinel; got % x",
				filepath.Base(p), hdr[:min(16, len(hdr))])
		}
	}
}

// R2007 splits what R2004 keeps in one section: object data, the strings
// inside those objects and the handle map each get their own section. So
// the name list is the first thing to check, and "AcDb:AcDbObjects"
// appearing alongside "AcDb:StrongPtr" is itself evidence the map decoded.
func TestR21ContainerListsSections(t *testing.T) {
	for _, p := range fixtures(t) {
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		v, err := DetectVersion(data)
		if err != nil {
			t.Fatalf("%s: %v", filepath.Base(p), err)
		}
		kind, ok := v.container()
		if !ok || kind != containerR21 {
			continue
		}

		f, err := openR21(data)
		if err != nil {
			t.Errorf("%s (%s): %v", filepath.Base(p), v, err)
			continue
		}
		names := f.sectionNames()
		t.Logf("%s (%s): %v", filepath.Base(p), v, names)

		for _, want := range []string{"AcDb:Header", "AcDb:Handles", "AcDb:AcDbObjects", "AcDb:Classes"} {
			body, err := f.Section(want)
			if err != nil {
				t.Errorf("%s: %v", filepath.Base(p), err)
				continue
			}
			if len(body) == 0 {
				t.Errorf("%s: section %q is empty", filepath.Base(p), want)
			}
			t.Logf("  %-20s %d bytes", want, len(body))
		}

		hdr, err := f.Section("AcDb:Header")
		if err != nil {
			continue
		}
		if !bytes.HasPrefix(hdr, headerSentinel[:]) {
			t.Errorf("%s: AcDb:Header does not start with the header sentinel; got % x",
				filepath.Base(p), hdr[:min(16, len(hdr))])
		}
	}
}
