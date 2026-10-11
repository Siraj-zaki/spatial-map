package dwg

import (
	"fmt"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// Table records are the drawing's own dictionaries — the layers,
// linetypes and block definitions that entities point at. They matter
// here for one reason: the model refers to a layer by name and the file
// refers to it by handle, so without these records an entity's layer is
// an eight-byte number that means nothing outside the file it came from.
//
// They are objects, not entities, and open differently: no graphics
// preview, no entity mode, no colour or linetype of their own in the
// shared block. Running an entity's layout over one is the mistake
// readEntity's type switch exists to prevent.
//
// Implemented from the Open Design Alliance's specification §2.4.6.

// streams pairs an object's two readers. R2007 moved strings out of the
// data into a stream of their own, so a field that is a single read on
// an older file is a read from each of two places on a newer one, and a
// decoder has to hold both at once.
type streams struct {
	data *bitReader
	str  *bitReader
	v    Version
}

func objectStreams(o *object) *streams {
	return &streams{data: o.data, str: o.strings(), v: o.Version}
}

// tv reads TV: a string, from whichever stream this release keeps
// strings in.
func (s *streams) tv() string {
	if !s.v.AtLeast(R2007) {
		return s.data.text()
	}
	// An object with no string stream has no strings to give. Saying so
	// is not the same as failing: a record whose only text is an empty
	// name is legal, and the alternative is refusing the whole drawing.
	if s.str.remainingBits() == 0 {
		return ""
	}
	return s.str.textU()
}

// cmc reads CMC, a colour as a table record states it.
//
// This is not the encoding an entity uses. R2004 gave the two forms
// different shapes — an entity packs its flags into the high byte of the
// index it already had, a record keeps a byte of its own and can name a
// colour in the string stream — which is why readEntityColor exists
// separately rather than either calling the other.
func (s *streams) cmc() cad.Color {
	b := s.data
	if !s.v.AtLeast(R2004) {
		return b.cmc(s.v)
	}
	c := cad.Color{Index: int16(b.bs())}
	rgb := b.bl()
	flags := b.rc()

	// The top byte says how to read the rest: a true colour, an index
	// carried in the bottom byte, or one of the two deferrals. Only the
	// first has anything the model cannot already express.
	switch rgb >> 24 {
	case 0xC2:
		c.RGB = rgb & 0xFFFFFF
		c.HasRGB = true
	case 0xC3:
		c.Index = int16(rgb & 0xFF)
	}
	if flags&1 != 0 {
		s.tv() // colour name
	}
	if flags&2 != 0 {
		s.tv() // colour book
	}
	return c
}

// objectHeader is the shared block every non-entity object opens with.
type objectHeader struct {
	numReactors uint32
	xdicMissing bool
}

// readObjectHeader consumes the shared block, leaving the reader on the
// first type-specific field.
func readObjectHeader(b *bitReader, v Version) objectHeader {
	readEED(b)
	var h objectHeader
	h.numReactors = b.bl()
	h.xdicMissing = true // the default for the releases with no flag
	if v.AtLeast(R2004) {
		h.xdicMissing = b.bit() == 1
	}
	if v.AtLeast(R2013) {
		b.bit() // data store data present
	}
	return h
}

// The table record types decoded so far.
const (
	typeLayer = 0x33
)

// Flags packed into a layer record's single "values" short. The width
// occupies five bits above them.
const (
	layerFrozen     = 1 << 0
	layerOn         = 1 << 1
	layerFrozenNew  = 1 << 2
	layerLocked     = 1 << 3
	layerPlottable  = 1 << 4
	layerWidthShift = 5
	layerWidthMask  = 0x1F
)

// readLayer decodes a LAYER record and the linetype it names.
func readLayer(o *object) (*cad.Layer, handle, error) {
	s := objectStreams(o)
	b := s.data
	h := readObjectHeader(b, o.Version)

	l := &cad.Layer{Name: s.tv()}
	b.bit() // set on every record in every fixture; xref bookkeeping
	if !o.Version.AtLeast(R2007) {
		b.bs() // xref index, dropped by R2007
	}
	b.bit() // xref dependent
	values := b.bs()
	l.Frozen = values&layerFrozen != 0
	l.Off = values&layerOn != 0
	l.Locked = values&layerLocked != 0
	l.Plottable = values&layerPlottable != 0
	l.LineWeightMM = lineWeightMM(values >> layerWidthShift & layerWidthMask)
	l.Color = s.cmc()

	if err := b.Err(); err != nil {
		return nil, handle{}, err
	}
	if got, want := b.bitPos(), o.dataStop(); got != want {
		return nil, handle{}, malformed("LAYER %#x ends at bit %d, data ends at %d (off by %d)",
			o.Handle, got, want, got-want)
	}

	linetype, err := readLayerRefs(o, h)
	if err != nil {
		return nil, handle{}, err
	}
	if slack := o.totalBits - b.bitPos(); slack >= 8 {
		return nil, handle{}, malformed("LAYER %#x leaves %d bits of handle stream unread", o.Handle, slack)
	}
	return l, linetype, nil
}

// readLayerRefs consumes the record's handle stream and returns the
// linetype it names. The others are bookkeeping — which control object
// owns the record, which dictionary extends it — that the model has no
// place for, but each still has to be read: they are what positions the
// one handle that matters.
func readLayerRefs(o *object, h objectHeader) (handle, error) {
	b := o.data
	b.seekBit(o.dataEnd() + 1)

	b.h() // the LAYER_CONTROL record that owns this one
	if h.numReactors > maxReactors {
		return handle{}, malformed("LAYER %#x claims %d reactors", o.Handle, h.numReactors)
	}
	for range h.numReactors {
		b.h()
	}
	if !h.xdicMissing {
		b.h() // extension dictionary
	}
	b.h() // the block this layer came from, when it came from an xref
	b.h() // plot style
	if o.Version.AtLeast(R2007) {
		b.h() // material
	}
	linetype := b.h()
	if o.Version.AtLeast(R2013) {
		b.h() // added by R2013 and unnamed by the specification
	}
	return linetype, b.Err()
}

// lineWeights maps the five-bit code a record stores to a width in
// millimetres. The first two dozen entries are the widths AutoCAD
// offers, in hundredths of a millimetre; above them sit the three
// sentinels that defer the width to something else.
var lineWeights = [...]float64{
	0.00, 0.05, 0.09, 0.13, 0.15, 0.18, 0.20, 0.25,
	0.30, 0.35, 0.40, 0.50, 0.53, 0.60, 0.70, 0.80,
	0.90, 1.00, 1.06, 1.20, 1.40, 1.58, 2.00, 2.11,
	cad.LineWeightByLayer, cad.LineWeightByBlock, cad.LineWeightDefault,
}

func lineWeightMM(code uint16) float64 {
	if int(code) >= len(lineWeights) {
		return cad.LineWeightDefault
	}
	return lineWeights[code]
}

// malformed reports a value the format allows to be written but not to
// mean what this one says.
func malformed(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrMalformed, fmt.Sprintf(format, args...))
}
