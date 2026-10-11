package dwg

import "fmt"

// Objects sit back to back in the object-data section with no directory
// of their own; the object map supplies the offsets. What is stored at
// each offset is a short prologue giving the length and the type,
// followed by data whose layout depends on the type.
//
// Implemented from the Open Design Alliance's specification §2.4.

// object is one entry of the object-data section, located and framed but
// not yet interpreted.
type object struct {
	Handle  uint64
	Type    uint16
	Version Version
	// data is positioned just past the prologue and bounded to this
	// object alone. The bound is the point: a decoder that misreads a
	// field would otherwise run on into the next object and return
	// values that are wrong rather than an error, and the object map
	// gives us the exact extent for free.
	data *bitReader
	// An object is really two streams laid end to end: its own data, then
	// the handles of everything it refers to. Neither is self-delimiting,
	// so the boundary is stored — but which way round changed with
	// R2010, which replaced a count of the data bits with a count of the
	// handle bits. Exactly one of these is meaningful for a given file.
	dataBits         uint32
	handleStreamBits uint64
	// dataStart is where dataBits is counted from: the first bit past the
	// prologue. It is not a constant, because the prologue's own length
	// varies with the size it states. See dataEnd.
	dataStart int
	// totalBits is the object's framed extent. The handle stream runs
	// from the end of the data to here.
	totalBits int
	// The string stream, located by locateStrings. It sits at the end of
	// the data region rather than after it, so its start is also where
	// the data stops. See strings.go.
	hasStrings       bool
	strStart, strEnd int
}

// dataEnd is the bit position of the last bit of the object's own data.
//
// The two releases state the boundary from opposite ends. Up to R2007
// the object counts its data bits, so the end is that count laid out
// from where the count is measured — which is the first bit past the
// prologue, not bit zero. R2010 counts the handle stream instead, so the
// data is whatever precedes it.
//
// The prologue length has to be carried rather than assumed because the
// size field is a modular short: two bytes for an object under 32 KiB
// and four for anything larger. Assuming two puts the end of every large
// object sixteen bits early — which no geometry notices, since it is
// read from the other end, and which surfaces only as a string stream
// whose declared length exceeds the object.
func (o *object) dataEnd() int {
	if o.Version.AtLeast(R2010) {
		return o.totalBits - int(o.handleStreamBits) - 1
	}
	return o.dataStart + int(o.dataBits) - 1
}

// stringsPresent reports whether the object carries a string stream.
func (o *object) stringsPresent() bool { return o.hasStrings }

// readObject frames the object at ref and decodes its prologue.
func readObject(objects []byte, ref objectRef, v Version) (*object, error) {
	if ref.Offset < 0 || ref.Offset >= int64(len(objects)) {
		return nil, fmt.Errorf("%w: object %#x at %d", ErrTruncated, ref.Handle, ref.Offset)
	}
	rest := objects[ref.Offset:]

	// The length excludes itself and is bit-packed, so how many bytes it
	// occupied has to be read back off the cursor rather than assumed.
	// R2010 added a second field on the same footing — the handle stream
	// size, also outside the count — so both have to be stepped over
	// before the cursor marks where the counted bytes begin.
	probe := newBitReader(rest)
	size := int64(probe.ms())
	var handleStreamBits uint64
	if v.AtLeast(R2010) {
		handleStreamBits = probe.umc()
	}
	if err := probe.Err(); err != nil {
		return nil, fmt.Errorf("object %#x at %d: %w", ref.Handle, ref.Offset, err)
	}
	end := int64(probe.bitPos()/8) + size
	if size <= 0 || end > int64(len(rest)) {
		return nil, fmt.Errorf("dwg: object %#x at %d claims %d bytes, %d remain",
			ref.Handle, ref.Offset, size, len(rest))
	}

	b := newBitReader(rest[:end])
	b.seekBit(probe.bitPos())

	o := &object{
		Handle:           ref.Handle,
		Version:          v,
		data:             b,
		handleStreamBits: handleStreamBits,
		dataStart:        probe.bitPos(),
		totalBits:        int(end) * 8,
	}
	o.Type = b.objectType(v)
	if v.AtLeast(R2000) && !v.AtLeast(R2010) {
		o.dataBits = b.rl()
	}

	// The object repeats its own handle, which the map has already told
	// us. Checking the two agree costs one comparison and proves the
	// whole chain that produced this object — the page map, the
	// decompressor, the object map's delta arithmetic and the prologue
	// layout — rather than trusting them separately.
	if h := b.h(); h.Code != 0 || h.Value != ref.Handle {
		return nil, fmt.Errorf("dwg: object at %d is indexed as %#x but identifies itself as %#x (code %#x)",
			ref.Offset, ref.Handle, h.Value, h.Code)
	}
	if err := b.Err(); err != nil {
		return nil, fmt.Errorf("object %#x at %d: %w", ref.Handle, ref.Offset, err)
	}
	if err := o.locateStrings(); err != nil {
		return nil, err
	}
	return o, nil
}
