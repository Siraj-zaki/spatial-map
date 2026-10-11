// Package dwg reads AutoCAD DWG files into the format-agnostic model in
// internal/cad.
//
// DWG is a binary format with no public standard, but it is thoroughly
// documented by the Open Design Alliance's reverse-engineered
// specification, and reading it is neither restricted nor unusual — it
// is what every non-Autodesk CAD tool does. What is restricted is the
// AGPL and proprietary source of the existing readers, which is why this
// is written from the format description rather than ported. See
// docs/cad-import.md.
//
// The format is really several formats sharing a magic string. The
// entity encoding is broadly stable across releases; the *container* —
// how sections are located, compressed and checksummed — was rewritten
// three times. Version detection therefore selects a container reader
// first, and only then a mostly-common object reader.
package dwg

import (
	"errors"
	"fmt"
)

// Version is the release a file was written by, identified by the six
// ASCII bytes every DWG starts with.
type Version string

const (
	R13   Version = "AC1012"
	R14   Version = "AC1014"
	R2000 Version = "AC1015"
	R2004 Version = "AC1018"
	R2007 Version = "AC1021"
	R2010 Version = "AC1024"
	R2013 Version = "AC1027"
	R2018 Version = "AC1032"
)

var versionNames = map[Version]string{
	R13:   "R13",
	R14:   "R14",
	R2000: "R2000",
	R2004: "R2004",
	R2007: "R2007",
	R2010: "R2010",
	R2013: "R2013",
	R2018: "R2018",
}

// Name is the release name for display and error messages. "AC1021" in
// a message tells a user nothing; "R2007" tells them which Save As
// option produced it.
func (v Version) Name() string {
	if n, ok := versionNames[v]; ok {
		return n
	}
	return string(v)
}

func (v Version) String() string { return fmt.Sprintf("%s (%s)", v.Name(), string(v)) }

// container names the family of file layout a version uses.
type container int

const (
	// containerR18 introduced page maps, LZ77 compression and an
	// obfuscated file header. R2010 through R2018 use it unchanged, so
	// this covers four releases.
	containerR18 container = iota
	// containerR21 is R2007 alone. It re-encodes the page maps with
	// Reed-Solomon, uses a different compressor, and moves object
	// strings into a separate stream. It is the odd one out — later
	// releases went back to the R2004 layout.
	containerR21
)

// container names the reader that opens a version, and false means there
// is none — which is the same thing as unsupported, and is why open needs
// no second refusal of its own.
//
// R13/R14/R2000 are the missing family. Their layout is the original one,
// a flat uncompressed section locator at a fixed offset, and it is not the
// container that makes them hard: they also predate the bitsize field, so
// object.dataEnd has nothing to measure from and the shared object path
// would have to grow a branch. Naming them here before that exists would
// route them into a switch that cannot open them.
func (v Version) container() (container, bool) {
	switch v {
	case R2004, R2010, R2013, R2018:
		return containerR18, true
	case R2007:
		return containerR21, true
	}
	return 0, false
}

// AtLeast orders versions by release, which is how the format's own
// conditionals are written ("R2004+ stores this as a raw long").
func (v Version) AtLeast(other Version) bool {
	return versionRank[v] >= versionRank[other]
}

var versionRank = map[Version]int{
	R13: 1, R14: 2, R2000: 3, R2004: 4, R2007: 5, R2010: 6, R2013: 7, R2018: 8,
}

// ErrNotDWG is returned for a file that does not begin with a DWG magic
// string at all — the common case being a DXF, which users reasonably
// expect to work here and which deserves a better message than a parse
// failure deep in the container.
var ErrNotDWG = errors.New("dwg: not a DWG file")

// ErrUnsupportedVersion is returned for a real DWG whose release this
// reader does not handle. Distinct from ErrNotDWG because the answer for
// the user is different: re-save at a different release, rather than pick
// a different file.
type ErrUnsupportedVersion struct {
	Version Version
}

// oldestSupported and newestSupported bound what open can actually read,
// and are what the error message quotes back. They are named rather than
// written into the string so that adding a container moves the advice with
// the code instead of leaving it recommending a Save As nobody needs any
// more. The consistency loop in the version test is what enforces that
// against container.
const (
	oldestSupported = R2004
	newestSupported = R2018
)

// Error names the release and the remedy. "Unsupported" alone leaves the
// user with a file, no next step, and a support ticket; every case here is
// one Save As away, and which direction to go is not obvious from a
// version string nobody reads in hex.
func (e *ErrUnsupportedVersion) Error() string {
	// Magic strings rise monotonically with release, so an unrecognised one
	// can still be placed either side of what we read even though its name
	// is unknown — which is the whole difference between "save it older"
	// and "save it newer".
	if e.Version > newestSupported {
		return fmt.Sprintf("dwg: %s is newer than this reader supports — re-save as AutoCAD %s or earlier",
			e.describe(), newestSupported.Name())
	}
	return fmt.Sprintf("dwg: %s is older than this reader supports — re-save as AutoCAD %s or later",
		e.describe(), oldestSupported.Name())
}

// describe names the release when we know it and quotes the raw magic
// when we do not, so a future release is reported as the file's own bytes
// rather than as a guess.
func (e *ErrUnsupportedVersion) describe() string {
	if _, known := versionNames[e.Version]; known {
		return e.Version.String()
	}
	return fmt.Sprintf("unrecognised version %q", string(e.Version))
}

// DetectVersion reads the magic string. It needs only the first six
// bytes, so it can run before a file is fully uploaded.
func DetectVersion(data []byte) (Version, error) {
	if len(data) < 6 {
		return "", ErrNotDWG
	}
	v := Version(data[:6])
	// Every DWG magic is "AC" or "MC" followed by four digits. Checking
	// the shape rather than membership lets an unknown future release
	// report ErrUnsupportedVersion instead of "not a DWG", which is the
	// truthful answer.
	if !(v[0] == 'A' || v[0] == 'M') || v[1] != 'C' {
		return "", ErrNotDWG
	}
	for _, c := range v[2:] {
		if c < '0' || c > '9' {
			return "", ErrNotDWG
		}
	}
	return v, nil
}
