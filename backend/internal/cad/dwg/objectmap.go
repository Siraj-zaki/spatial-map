package dwg

import (
	"encoding/binary"
	"fmt"
)

// The object map (section "AcDb:Handles") is the drawing's index: it
// says, for every object in the file, what its handle is and where in
// the object-data section to find it. Nothing above this can work
// without it — a handle is the only way one object refers to another,
// and the objects themselves are stored back to back with no directory.
//
// Both fields are stored as deltas from the previous entry rather than
// absolutely, which is the whole reason the map is small: handles are
// allocated in near-sequence and objects are written in handle order, so
// most deltas fit in a single byte.
//
// Implemented from the Open Design Alliance's specification §2.3.

// maxMapChunk bounds one chunk of the map. The specification allows 2032
// bytes of pairs and real files sit within a few bytes of that, but the
// bound here is deliberately loose: its job is to catch a length read in
// the wrong byte order, which lands in the tens of thousands, not to
// enforce a limit the format itself treats as advisory.
const maxMapChunk = 2048

// objectRef is one entry: an object's handle and its byte offset into
// the object-data section.
type objectRef struct {
	Handle uint64
	Offset int64
}

// readObjectMap decodes the whole map. objectsLen bounds the offsets so
// a corrupt map is rejected here rather than producing seeks that fail
// one at a time later, each with a less useful message.
func readObjectMap(raw []byte, objectsLen int) ([]objectRef, error) {
	var refs []objectRef
	pos := 0

	for {
		if pos+2 > len(raw) {
			return nil, fmt.Errorf("%w: object map ended without its terminator", ErrTruncated)
		}
		// This length is big-endian, alone among the format's integers.
		size := int(binary.BigEndian.Uint16(raw[pos : pos+2]))
		if size < 2 || size > maxMapChunk {
			return nil, fmt.Errorf("dwg: object map chunk of %d bytes at %d is out of range", size, pos)
		}
		// The length counts itself, so a chunk of exactly 2 carries no
		// pairs: that is the terminator, followed by the trailing CRC.
		if size == 2 {
			return refs, nil
		}
		if pos+size+2 > len(raw) {
			return nil, fmt.Errorf("%w: object map chunk at %d overruns the section", ErrTruncated, pos)
		}

		// Each chunk is independent: the running handle and offset both
		// restart at zero, so the first pair carries absolute values and
		// only the rest are deltas. That is what keeps a chunk readable in
		// isolation — a reader can resynchronise on any chunk boundary
		// after damage instead of losing the remainder of the file.
		var (
			handle uint64
			offset int64
		)
		b := newBitReader(raw[pos+2 : pos+size])
		for b.remainingBits() >= 8 {
			// The handle delta is unsigned: handles are allocated upward
			// and the map is written in handle order. The offset delta is
			// signed, because objects are not necessarily written in the
			// order their handles imply.
			handle += b.umc()
			offset += b.mc()
			if b.Err() != nil {
				return nil, b.Err()
			}
			if offset < 0 || offset >= int64(objectsLen) {
				return nil, fmt.Errorf("dwg: object %#x at offset %d is outside the %d-byte object section", handle, offset, objectsLen)
			}
			refs = append(refs, objectRef{Handle: handle, Offset: offset})
		}
		if err := b.Err(); err != nil {
			return nil, err
		}

		pos += size + 2 // the chunk, then its CRC
	}
}
