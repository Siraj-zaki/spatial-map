package dwg

import (
	"bytes"
	"encoding/binary"
	"math"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// The header section is where a drawing says how big it is.
//
// Everything decoded until now is geometry in whatever units the drawing
// was authored in, and a floor plan whose units are unknown is a shape,
// not a building — 42000 across is a warehouse in millimetres and forty
// kilometres in metres, and nothing in the geometry distinguishes them.
// $INSUNITS is the field that does, and this file is what it takes to
// reach it.
//
// What it takes is the whole list. The section is a few hundred variables
// written back to back with no names, no tags and no lengths — position
// is the only thing that identifies a value, so $INSUNITS can only be
// found by decoding every field in front of it correctly. Perhaps a dozen
// of those matter to us. The rest are read to be stepped over: dimension
// styles, plot settings, snap modes, the two timestamps, a camera the
// application uses for walkthroughs.
//
// That makes it the most fragile thing in the reader and the one most
// worth checking hard, because a misread here is not a decode failure. It
// is a plausible number: read two bits early and $INSUNITS comes back 4
// instead of 6, the drawing imports at a thousandth of its size, and
// nothing about the result looks wrong until someone measures a door.
// readHeaderVars therefore ends by asserting that the data stream landed
// exactly where the section said it would, and that the handles it
// gathered are the objects they claim to be. See headervars_test.go.
//
// Implemented from the Open Design Alliance's specification §2.1 and its
// header-variable table.

// headerVars is what the section is decoded for. Most of it is discarded
// on the way past; these are the fields anything downstream can use.
type headerVars struct {
	InsUnits    uint16
	ExtMin      cad.Vec3
	ExtMax      cad.Vec3
	HasExtents  bool
	HandSeed    uint64
	ModelSpace  uint64
	PaperSpace  uint64
	NamedObject uint64

	// Controls are the nine table-control objects, in the order the
	// section names them. They are kept for one reason: each is an object
	// of a known type, so resolving them is an independent check that the
	// whole list above was read at the right offsets.
	Controls [9]uint64
}

// typeDictionary is the named-object root's type. Named here rather than
// beside the entity types because nothing decodes a dictionary — it is
// read only as the answer to "what should this handle point at".
const typeDictionary = 0x2A

// headerControlTypes are the object types the nine control handles must
// resolve to, in the section's own order.
var headerControlTypes = [9]uint16{
	0x30, // BLOCK_CONTROL
	0x32, // LAYER_CONTROL
	0x34, // STYLE_CONTROL
	0x38, // LTYPE_CONTROL
	0x3C, // VIEW_CONTROL
	0x3E, // UCS_CONTROL
	0x40, // VPORT_CONTROL
	0x42, // APPID_CONTROL
	0x44, // DIMSTYLE_CONTROL
}

// hdr threads the section's streams together.
//
// From R2007 the section is laid out exactly like an object and for the
// same reasons: its own data, the strings lifted out and written
// backwards from the end of that data, and past both the handles of
// everything it names. All three are read in step — a field in the data
// decides whether a string or a handle follows — so a decoder holds them
// all at once rather than making three passes.
type hdr struct {
	*streams
	hdl *bitReader
	v   Version
	out headerVars
}

// h reads a handle from whichever stream this release keeps them in.
func (d *hdr) h() uint64 {
	return d.hdl.h().resolve(0)
}

// cmc reads a colour as the header states it, which is the table
// record's encoding rather than the entity's: a flag byte of its own,
// and the names that follow it in the string stream.
func (d *hdr) cmc() {
	b := d.data
	b.bs()
	if !d.v.AtLeast(R2004) {
		return
	}
	b.bl()
	flags := b.rc()
	if flags&1 != 0 {
		d.tv()
	}
	if flags&2 != 0 {
		d.tv()
	}
}

// headerMaxSection bounds the section before any of it is indexed. The
// header is a fixed list of variables, so it is small by construction —
// under a kilobyte in every fixture — and a section claiming megabytes
// is not one.
const headerMaxSection = 1 << 20

// readHeaderVars decodes the header-variable section.
func readHeaderVars(sec []byte, v Version) (*headerVars, error) {
	if len(sec) > headerMaxSection {
		return nil, malformed("header section is %d bytes", len(sec))
	}
	if len(sec) < 24 || !bytes.Equal(sec[:16], headerSentinel[:]) {
		return nil, malformed("header section does not open with its sentinel")
	}
	size := int(binary.LittleEndian.Uint32(sec[16:20]))
	off := 20
	if v.AtLeast(R2010) {
		// A field the specification does not name, zero in every fixture.
		off += 4
	}
	if size < 4 || off+size > len(sec) {
		return nil, malformed("header section declares %d bytes, %d remain", size, len(sec)-off)
	}
	body := sec[off : off+size]

	full := newBitReader(body)
	d := &hdr{v: v, hdl: full}
	dataStop := size * 8
	if v.AtLeast(R2007) {
		// A count of bits, and it counts itself: the flag that says whether
		// there is a string stream lands on the last bit of the run, not one
		// past it. Measured — read as a count of what follows the field, the
		// flag reads zero on every fixture and 22 KB of legible text
		// (linetype names, a URL, the two GUIDs) is silently discarded as if
		// the drawing had none.
		bits := int(full.rl())
		if bits < 33 || bits > size*8 {
			return nil, malformed("header declares %d bits of data in %d", bits, size*8)
		}
		str, stop, err := headerStrings(body, bits-1)
		if err != nil {
			return nil, err
		}
		d.streams = &streams{data: full.window(32, stop), str: str, v: v}
		d.hdl = newBitReader(body)
		d.hdl.seekBit(bits)
		dataStop = stop
	} else {
		// Before R2007 there is no split: strings and handles are written
		// in place, so all three readers are the same reader.
		d.streams = &streams{data: full, str: full, v: v}
	}

	d.walk()

	if err := d.data.Err(); err != nil {
		return nil, err
	}
	if err := d.hdl.Err(); err != nil {
		return nil, err
	}
	if slack := d.str.remainingBits(); slack >= 16 {
		return nil, malformed("header leaves %d bits of string stream unread", slack)
	}
	// From R2007 the string stream is what stops the data, and its start is
	// stated, so the walk must land on it exactly — that exactness is what
	// makes several hundred unnamed variables falsifiable at all. Before
	// R2007 nothing follows the variables but the section's own byte
	// padding, so the most that can be required is that the walk finish
	// inside the final byte.
	maxSlack := 0
	if !v.AtLeast(R2007) {
		maxSlack = 7
	}
	if got := d.data.bitPos(); got > dataStop || dataStop-got > maxSlack {
		return nil, malformed("header variables end at bit %d, data ends at %d (off by %d)",
			got, dataStop, got-dataStop)
	}
	// The handle stream is not asserted to be exhausted, unlike an
	// object's. The section's body runs ten bytes past its last handle in
	// every fixture, with contents that differ per file and match nothing
	// else in it; a page allocated in fixed units and left uncleared fits
	// what is there. What the handles are is checked instead of how many
	// bits they took: see TestHeaderNamesTheObjectsItClaims.
	if v.AtLeast(R2007) {
		if slack := size*8 - d.hdl.bitPos(); slack >= 128 {
			return nil, malformed("header leaves %d bits of handle stream unread", slack)
		}
	}
	return &d.out, nil
}

// headerStrings locates the string stream the same way an object's is
// located, and returns it along with the bit at which the data proper
// stops.
func headerStrings(body []byte, flag int) (*bitReader, int, error) {
	b := newBitReader(body)
	b.seekBit(flag)
	if b.bit() != 1 {
		return b.window(flag, flag), flag, b.Err()
	}
	end := flag - 16
	b.seekBit(end)
	size := int(b.rs())
	if size&0x8000 != 0 {
		end = flag - 32
		b.seekBit(end)
		size = size&0x7FFF | int(b.rs())<<15
	}
	if err := b.Err(); err != nil {
		return nil, 0, err
	}
	if end-size < 32 {
		return nil, 0, malformed("header claims a %d-bit string stream ending at bit %d", size, end)
	}
	return b.window(end-size, end), end - size, nil
}

// walk reads the variables in order.
//
// It is deliberately one long routine rather than a table of field
// descriptors. A table would be shorter and would read like the
// specification, but every entry would still have to be in the right
// place and a misplaced one would be no easier to find; what a table
// costs is the ability to say, at the four or five places it matters,
// why a field is where it is.
func (d *hdr) walk() {
	b := d.data
	v := d.v

	if v.AtLeast(R2013) {
		b.bll() // REQUIREDVERSIONS
	}

	// Four doubles and four strings the specification does not name. The
	// first double is 412148564080.0 in every file ever examined, which is
	// what makes it useful: it is the one value in the section whose
	// correctness can be judged without reading anything before it, so a
	// release that starts its data stream somewhere unexpected announces
	// itself here rather than a thousand bits later. R2013's
	// REQUIREDVERSIONS above was found that way — three bits, and without
	// them every double, short and timestamp in the section is nonsense.
	b.bd()
	b.bd()
	b.bd()
	b.bd()
	d.tv()
	d.tv()
	d.tv()
	d.tv()
	b.bl()
	b.bl()
	if !v.AtLeast(R2000) {
		b.bs()
	}
	if !v.AtLeast(R2004) {
		d.h() // current viewport entity header
	}

	// Modes and toggles, one bit each. They are the switches along the
	// top of the application's status bar — snap, ortho, fill — and are
	// read only because the list has to be walked in order.
	b.bit() // DIMASO
	b.bit() // DIMSHO
	if !v.AtLeast(R2000) {
		b.bit() // DIMSAV
	}
	b.bit() // PLINEGEN
	b.bit() // ORTHOMODE
	b.bit() // REGENMODE
	b.bit() // FILLMODE
	b.bit() // QTEXTMODE
	b.bit() // PSLTSCALE
	b.bit() // LIMCHECK
	if !v.AtLeast(R2000) {
		b.bit() // BLIPMODE
	}
	if v.AtLeast(R2004) {
		b.bit() // unnamed
	}
	b.bit() // USRTIMER
	b.bit() // SKPOLY
	b.bit() // ANGDIR
	b.bit() // SPLFRAME
	if !v.AtLeast(R2000) {
		b.bit() // ATTREQ
		b.bit() // ATTDIA
	}
	b.bit() // MIRRTEXT
	b.bit() // WORLDVIEW
	if !v.AtLeast(R2000) {
		b.bit() // WIREFRAME
	}
	b.bit() // TILEMODE
	b.bit() // PLIMCHECK
	b.bit() // VISRETAIN
	if !v.AtLeast(R2000) {
		b.bit() // DELOBJ
	}
	b.bit() // DISPSILH
	b.bit() // PELLIPSE

	b.bs() // PROXYGRAPHICS
	if !v.AtLeast(R2000) {
		b.bs() // DRAGMODE
	}
	b.bs() // TREEDEPTH
	b.bs() // LUNITS
	b.bs() // LUPREC
	b.bs() // AUNITS
	b.bs() // AUPREC
	if !v.AtLeast(R2000) {
		b.bs() // OSMODE
	}
	b.bs() // ATTMODE
	if !v.AtLeast(R2000) {
		b.bs() // COORDS
	}
	b.bs() // PDMODE
	if !v.AtLeast(R2000) {
		b.bs() // PICKSTYLE
	}
	if v.AtLeast(R2004) {
		b.bl()
		b.bl()
		b.bl()
	}
	b.bs() // USERI1
	b.bs() // USERI2
	b.bs() // USERI3
	b.bs() // USERI4
	b.bs() // USERI5
	b.bs() // SPLINESEGS
	b.bs() // SURFU
	b.bs() // SURFV
	b.bs() // SURFTYPE
	b.bs() // SURFTAB1
	b.bs() // SURFTAB2
	b.bs() // SPLINETYPE
	b.bs() // SHADEDGE
	b.bs() // SHADEDIF
	b.bs() // UNITMODE
	b.bs() // MAXACTVP
	b.bs() // ISOLINES
	b.bs() // CMLJUST
	b.bs() // TEXTQLTY

	b.bd() // LTSCALE
	b.bd() // TEXTSIZE
	b.bd() // TRACEWID
	b.bd() // SKETCHINC
	b.bd() // FILLETRAD
	b.bd() // THICKNESS
	b.bd() // ANGBASE
	b.bd() // PDSIZE
	b.bd() // PLINEWID
	b.bd() // USERR1
	b.bd() // USERR2
	b.bd() // USERR3
	b.bd() // USERR4
	b.bd() // USERR5
	b.bd() // CHAMFERA
	b.bd() // CHAMFERB
	b.bd() // CHAMFERC
	b.bd() // CHAMFERD
	b.bd() // FACETRES
	b.bd() // CMLSCALE
	b.bd() // CELTSCALE
	if !v.AtLeast(R2007) {
		d.tv() // MENUNAME
	}

	// Two timestamps and two elapsed timers, each a Julian day and a
	// count of milliseconds into it.
	b.bl() // TDCREATE day
	b.bl() // TDCREATE ms
	b.bl() // TDUPDATE day
	b.bl() // TDUPDATE ms
	if v.AtLeast(R2004) {
		b.bl()
		b.bl()
		b.bl()
	}
	b.bl() // TDINDWG days
	b.bl() // TDINDWG ms
	b.bl() // TDUSRTIMER days
	b.bl() // TDUSRTIMER ms

	d.cmc() // CECOLOR

	// HANDSEED is the next handle the application would hand out. It is
	// the one handle in the section written into the data stream rather
	// than the handle stream — it names no object, so there is nothing
	// for the handle stream to point at.
	d.out.HandSeed = b.h().resolve(0)

	d.h() // CLAYER
	d.h() // TEXTSTYLE
	d.h() // CELTYPE
	if v.AtLeast(R2007) {
		d.h() // CMATERIAL
	}
	d.h() // DIMSTYLE
	d.h() // CMLSTYLE
	if v.AtLeast(R2000) {
		b.bd() // PSVPSCALE
	}

	// Paper space, then model space: the same nine values twice over.
	// Only the second set describes the drawing; the first describes the
	// sheet it is plotted on, and its extents are the size of a piece of
	// paper.
	d.space()
	if v.AtLeast(R2000) {
		d.ucsOrtho()
	}
	d.space()
	if v.AtLeast(R2000) {
		d.ucsOrtho()
		d.tv() // DIMPOST
		d.tv() // DIMAPOST
	}

	d.dimensions()

	// The nine table controls. Every named thing in the drawing hangs off
	// one of these, and each is an object of a fixed type, which is what
	// makes them worth keeping: see TestHeaderNamesTheObjectsItClaims.
	for i := range d.out.Controls {
		d.out.Controls[i] = d.h()
	}
	if !v.AtLeast(R2004) {
		d.h() // viewport entity header control
	}
	d.h() // ACAD_GROUP dictionary
	d.h() // ACAD_MLINESTYLE dictionary
	d.out.NamedObject = d.h()

	if v.AtLeast(R2000) {
		b.bs() // TSTACKALIGN
		b.bs() // TSTACKSIZE
		d.tv() // HYPERLINKBASE
		d.tv() // STYLESHEET
		d.h()  // LAYOUTS dictionary
		d.h()  // PLOTSETTINGS dictionary
		d.h()  // PLOTSTYLES dictionary
	}
	if v.AtLeast(R2004) {
		d.h() // MATERIALS dictionary
		d.h() // COLORS dictionary
	}
	if v.AtLeast(R2007) {
		d.h() // VISUALSTYLE dictionary
	}
	if v.AtLeast(R2013) {
		d.h() // unnamed
	}

	if v.AtLeast(R2000) {
		b.bl() // packed flags: line weight, end caps, join style, and more

		// The field this file exists for.
		d.out.InsUnits = b.bs()

		cepsntype := b.bs()
		if cepsntype == 3 {
			d.h() // CPSNID, present only for that one value
		}
		d.tv() // FINGERPRINTGUID
		d.tv() // VERSIONGUID
	}
	if v.AtLeast(R2004) {
		b.rc() // SORTENTS
		b.rc() // INDEXCTL
		b.rc() // HIDETEXT
		b.rc() // XCLIPFRAME
		b.rc() // DIMASSOC
		b.rc() // HALOGAP
		b.bs() // OBSCUREDCOLOR
		b.bs() // INTERSECTIONCOLOR
		b.rc() // OBSCUREDLTYPE
		b.rc() // INTERSECTIONDISPLAY
		d.tv() // PROJECTNAME
	}

	d.out.PaperSpace = d.h()
	d.out.ModelSpace = d.h()
	d.h() // LTYPE BYLAYER
	d.h() // LTYPE BYBLOCK
	d.h() // LTYPE CONTINUOUS

	if v.AtLeast(R2007) {
		d.walkthrough()
		return
	}

	// Four shorts of no stated meaning, which R2007 dropped. Their absence
	// is not a guess: with them the data stream overruns its own end by 56
	// bits and reads the first string as a number, and without them
	// walkthrough finishes exactly on the boundary in every fixture.
	b.bs()
	b.bs()
	b.bs()
	b.bs()
}

// space reads one of the two coordinate systems — paper or model. The
// layout is identical for both, which is why reading the wrong one is
// possible and why only the second is kept.
func (d *hdr) space() {
	b := d.data
	var min, max cad.Vec3
	b.bd3() // INSBASE
	min.X, min.Y, min.Z = b.bd3()
	max.X, max.Y, max.Z = b.bd3()
	b.rd2() // LIMMIN
	b.rd2() // LIMMAX
	b.bd()  // ELEVATION
	b.bd3() // UCSORG
	b.bd3() // UCSXDIR
	b.bd3() // UCSYDIR
	d.h()   // UCSNAME

	// The model-space pair is read second, so the last call wins. Recorded
	// here rather than returned to the caller's discretion because the
	// distinction is the whole point: paper-space extents are the size of
	// a sheet of paper and would silently pass every plausibility check.
	d.out.ExtMin, d.out.ExtMax = min, max
	d.out.HasExtents = extentsComputed(min, max)
}

// extentsNotComputed is what AutoCAD writes into $EXTMIN/$EXTMAX for a
// drawing whose extents it has never worked out — an inverted box of
// ±1e20, so that the first entity considered replaces both corners.
const extentsNotComputed = 1e20

// extentsComputed reports whether the header's extents are a measurement
// rather than that sentinel. Two of our five fixtures carry it, so this
// is the common case and not an edge one, and passing the sentinel on as
// a measurement would offer a bounding box a hundred billion times the
// size of the building — which the import would then scale to.
func extentsComputed(min, max cad.Vec3) bool {
	for _, c := range [...]float64{min.X, min.Y, min.Z, max.X, max.Y, max.Z} {
		if math.IsNaN(c) || math.Abs(c) >= extentsNotComputed {
			return false
		}
	}
	return max.X > min.X && max.Y > min.Y
}

// ucsOrtho reads the six named orthographic origins R2000 added to each
// coordinate system.
func (d *hdr) ucsOrtho() {
	b := d.data
	d.h() // UCSORTHOREF
	b.bs()
	d.h() // UCSBASE
	for range 6 {
		b.bd3() // top, bottom, left, right, front, back
	}
}

// dimensions reads the dimension-style block: seventy-odd variables
// controlling how a measurement is drawn. None of it is geometry and none
// of it is kept — it is here because $INSUNITS is on the far side of it.
func (d *hdr) dimensions() {
	b := d.data
	v := d.v

	b.bd() // DIMSCALE
	b.bd() // DIMASZ
	b.bd() // DIMEXO
	b.bd() // DIMDLI
	b.bd() // DIMEXE
	b.bd() // DIMRND
	b.bd() // DIMDLE
	b.bd() // DIMTP
	b.bd() // DIMTM
	if v.AtLeast(R2007) {
		b.bd()  // DIMFXL
		b.bd()  // DIMJOGANG
		b.bs()  // DIMTFILL
		d.cmc() // DIMTFILLCLR
	}
	if v.AtLeast(R2000) {
		b.bit() // DIMTOL
		b.bit() // DIMLIM
		b.bit() // DIMTIH
		b.bit() // DIMTOH
		b.bit() // DIMSE1
		b.bit() // DIMSE2
		b.bs()  // DIMTAD
		b.bs()  // DIMZIN
		b.bs()  // DIMAZIN
	}
	if v.AtLeast(R2007) {
		b.bs() // DIMARCSYM
	}
	b.bd() // DIMTXT
	b.bd() // DIMCEN
	b.bd() // DIMTSZ
	b.bd() // DIMALTF
	b.bd() // DIMLFAC
	b.bd() // DIMTVP
	b.bd() // DIMTFAC
	b.bd() // DIMGAP
	if !v.AtLeast(R2000) {
		for range 5 {
			d.tv() // DIMPOST, DIMAPOST, DIMBLK, DIMBLK1, DIMBLK2
		}
	}
	if v.AtLeast(R2000) {
		b.bd()  // DIMALTRND
		b.bit() // DIMALT
		b.bs()  // DIMALTD
		b.bit() // DIMTOFL
		b.bit() // DIMSAH
		b.bit() // DIMTIX
		b.bit() // DIMSOXD
	}
	d.cmc() // DIMCLRD
	d.cmc() // DIMCLRE
	d.cmc() // DIMCLRT
	if v.AtLeast(R2000) {
		b.bs()  // DIMADEC
		b.bs()  // DIMDEC
		b.bs()  // DIMTDEC
		b.bs()  // DIMALTU
		b.bs()  // DIMALTTD
		b.bs()  // DIMAUNIT
		b.bs()  // DIMFRAC
		b.bs()  // DIMLUNIT
		b.bs()  // DIMDSEP
		b.bs()  // DIMTMOVE
		b.bs()  // DIMJUST
		b.bit() // DIMSD1
		b.bit() // DIMSD2
		b.bs()  // DIMTOLJ
		b.bs()  // DIMTZIN
		b.bs()  // DIMALTZ
		b.bs()  // DIMALTTZ
		b.bit() // DIMUPT
		b.bs()  // DIMATFIT
	}
	if v.AtLeast(R2007) {
		b.bit() // DIMFXLON
	}
	if v.AtLeast(R2010) {
		b.bit() // DIMTXTDIRECTION
		b.bd()  // DIMALTMZF
		d.tv()  // DIMALTMZS
		b.bd()  // DIMMZF
		d.tv()  // DIMMZS
	}
	if v.AtLeast(R2000) {
		d.h() // DIMTXSTY
		d.h() // DIMLDRBLK
		d.h() // DIMBLK
		d.h() // DIMBLK1
		d.h() // DIMBLK2
	}
	if v.AtLeast(R2007) {
		d.h() // DIMLTYPE
		d.h() // DIMLTEX1
		d.h() // DIMLTEX2
	}
	if v.AtLeast(R2000) {
		b.bs() // DIMLWD
		b.bs() // DIMLWE
	}
}

// walkthrough reads the block R2007 added for the application's camera
// and sun: step size, lens length, latitude, longitude.
//
// The last three are the only place a DWG comes close to saying where on
// earth the drawing is, and they are not usable for it. They default to a
// location in California that most files never change, they describe a
// sun angle rather than a position, and nothing states a coordinate
// reference system to interpret them in — so georeferencing stays what
// §6.12 says it is, a human judgement made on the map.
func (d *hdr) walkthrough() {
	b := d.data
	b.bit() // CAMERADISPLAY
	b.bl()
	b.bl()
	b.bd()
	b.bd()  // STEPSPERSEC
	b.bd()  // STEPSIZE
	b.bd()  // 3DDWFPREC
	b.bd()  // LENSLENGTH
	b.bd()  // CAMERAHEIGHT
	b.rc()  // SOLIDHIST
	b.rc()  // SHOWHIST
	b.bd()  // PSOLWIDTH
	b.bd()  // PSOLHEIGHT
	b.bd()  // LOFTANG1
	b.bd()  // LOFTANG2
	b.bd()  // LOFTMAG1
	b.bd()  // LOFTMAG2
	b.bs()  // LOFTPARAM
	b.rc()  // LOFTNORMALS
	b.bd()  // LATITUDE
	b.bd()  // LONGITUDE
	b.bd()  // NORTHDIRECTION
	b.bl()  // TIMEZONE
	b.rc()  // LIGHTGLYPHDISPLAY
	b.rc()  // TILEMODELIGHTSYNCH
	b.rc()  // DWFFRAME
	b.rc()  // DGNFRAME
	b.bit() // unnamed
	d.cmc() // INTERFERECOLOR
	d.h()   // INTERFEREOBJVS
	d.h()   // INTERFEREVPVS
	d.h()   // DRAGVS
	b.rc()  // CSHADOW
	b.bd()  // unnamed
}
