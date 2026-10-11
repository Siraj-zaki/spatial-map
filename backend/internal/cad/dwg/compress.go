package dwg

import (
	"errors"
	"fmt"
)

// The R2004 container compresses every section with a variation on
// LZ77. The variation that matters is that a match length may exceed its
// own offset — the copy is defined to run byte by byte so it can overlap
// itself and thereby encode a repeating run. Using a bulk copy() here
// works on most files and then silently corrupts the ones that use run
// encoding, which is why the inner loop below is deliberately a byte
// loop rather than the copy() a reviewer would expect.
//
// Implemented from the Open Design Alliance's published format
// specification (§4.7), which the ODA releases specifically so that
// third parties can read DWG. Deliberately not ported from any existing
// reader: the mature ones are GPL or AGPL, and this repository cannot
// take that dependency (docs/cad-import.md).

var errCorruptStream = errors.New("dwg: corrupt compressed stream")

// magicSequence is the byte string the format uses both to obfuscate the
// file header and to pad the gaps between section pages. It is a linear
// congruential generator with the parameters of the original Microsoft C
// rand(), sampled at bits 16-23.
func magicSequence(n int) []byte {
	out := make([]byte, n)
	seed := uint32(1)
	for i := range out {
		seed = seed*0x343FD + 0x269EC3
		out[i] = byte(seed >> 0x10)
	}
	return out
}

// decompressR2004 expands a section page, stopping at maxLen.
//
// The cap is required rather than discovered: every length in the stream
// is attacker-controlled, and an append-driven loop would let a few
// hundred bytes of input claim gigabytes. The caller supplies the page
// size the container promises.
//
// The result may legitimately be shorter than maxLen — a stream ends at
// its terminator, and the caller knows how much of the page is live
// data — so the length is returned rather than asserted.
func decompressR2004(src []byte, maxLen int) ([]byte, error) {
	if maxLen < 0 {
		return nil, fmt.Errorf("%w: negative output size", errCorruptStream)
	}
	d := &lz77{src: src, dst: make([]byte, 0, maxLen), max: maxLen}

	// A compressed section opens with a literal run.
	n, err := d.literalLength()
	if err != nil {
		return nil, err
	}
	if err := d.literals(n); err != nil {
		return nil, err
	}

	for {
		op, err := d.byteAt()
		if err != nil {
			// Running out of input with the output already full is how
			// well-formed pages that omit the terminator end.
			if len(d.dst) >= d.max {
				break
			}
			return nil, err
		}
		if op == 0x11 {
			break
		}

		var length, offset, litCount int
		switch {
		case op == 0x10:
			if length, err = d.longLength(); err != nil {
				return nil, err
			}
			length += 9
			if offset, litCount, err = d.twoByteOffset(); err != nil {
				return nil, err
			}
			offset += 0x3FFF

		case op >= 0x12 && op <= 0x1F:
			length = int(op&0x0F) + 2
			if offset, litCount, err = d.twoByteOffset(); err != nil {
				return nil, err
			}
			offset += 0x3FFF

		case op == 0x20:
			if length, err = d.longLength(); err != nil {
				return nil, err
			}
			length += 0x21
			if offset, litCount, err = d.twoByteOffset(); err != nil {
				return nil, err
			}

		case op >= 0x21 && op <= 0x3F:
			length = int(op) - 0x1E
			if offset, litCount, err = d.twoByteOffset(); err != nil {
				return nil, err
			}

		case op >= 0x40:
			length = int((op&0xF0)>>4) - 1
			op2, err := d.byteAt()
			if err != nil {
				return nil, err
			}
			offset = int(op2)<<2 | int(op&0x0C)>>2
			litCount = int(op & 0x03)

		default:
			// 0x00-0x0F never appear as an opcode; the format reserves
			// them so a literal length can never be mistaken for one.
			return nil, fmt.Errorf("%w: opcode %#02x", errCorruptStream, op)
		}

		if err := d.match(length, offset); err != nil {
			return nil, err
		}

		if litCount == 0 {
			if litCount, err = d.literalLength(); err != nil {
				return nil, err
			}
		}
		if err := d.literals(litCount); err != nil {
			return nil, err
		}
	}

	return d.dst, nil
}

type lz77 struct {
	src []byte
	pos int
	dst []byte
	max int
}

func (d *lz77) byteAt() (byte, error) {
	if d.pos >= len(d.src) {
		return 0, fmt.Errorf("%w: input exhausted", errCorruptStream)
	}
	b := d.src[d.pos]
	d.pos++
	return b, nil
}

// literalLength reads the run length of the literal bytes that follow.
//
// The encoding overlaps the opcode space: a byte with any high-nibble
// bit set is not a length at all but the next opcode, meaning the run is
// empty. So this peeks and only consumes when the byte really is a
// length.
func (d *lz77) literalLength() (int, error) {
	if d.pos >= len(d.src) {
		return 0, fmt.Errorf("%w: input exhausted reading literal length", errCorruptStream)
	}
	b := d.src[d.pos]
	if b&0xF0 != 0 {
		return 0, nil
	}
	d.pos++
	if b != 0 {
		return int(b) + 3, nil
	}
	total, err := d.extend(0x0F)
	if err != nil {
		return 0, err
	}
	return total + 3, nil
}

// longLength is the format's other variable-length integer, differing
// from a literal length only in its starting total and in having no
// empty-run escape.
func (d *lz77) longLength() (int, error) {
	b, err := d.byteAt()
	if err != nil {
		return 0, err
	}
	if b != 0 {
		return int(b), nil
	}
	return d.extend(0xFF)
}

// extend accumulates the 0x00-continues encoding shared by both
// variable-length integers. Capped because the continuation byte is
// attacker-controlled and an unbounded run of 0x00 would otherwise spin
// until the input ended, adding 0xFF each time.
func (d *lz77) extend(total int) (int, error) {
	for {
		n, err := d.byteAt()
		if err != nil {
			return 0, err
		}
		if n != 0 {
			return total + int(n), nil
		}
		total += 0xFF
		if total > d.max {
			return 0, fmt.Errorf("%w: length exceeds page size", errCorruptStream)
		}
	}
}

func (d *lz77) literals(n int) error {
	if n == 0 {
		return nil
	}
	if n < 0 || d.pos+n > len(d.src) {
		return fmt.Errorf("%w: literal run of %d overruns input", errCorruptStream, n)
	}
	if len(d.dst)+n > d.max {
		return fmt.Errorf("%w: literal run overruns page", errCorruptStream)
	}
	d.dst = append(d.dst, d.src[d.pos:d.pos+n]...)
	d.pos += n
	return nil
}

// match copies length bytes from offset back in the output. offset is
// stored one less than the true distance.
func (d *lz77) match(length, offset int) error {
	start := len(d.dst) - offset - 1
	if length < 0 || start < 0 {
		return fmt.Errorf("%w: match %d bytes at -%d", errCorruptStream, length, offset+1)
	}
	if len(d.dst)+length > d.max {
		return fmt.Errorf("%w: match overruns page", errCorruptStream)
	}
	// Byte at a time on purpose: length may exceed the offset, and the
	// bytes this copy writes are then legitimately re-read as its own
	// source. See the note at the top of the file.
	for i := 0; i < length; i++ {
		d.dst = append(d.dst, d.dst[start+i])
	}
	return nil
}

func (d *lz77) twoByteOffset() (offset, litCount int, err error) {
	first, err := d.byteAt()
	if err != nil {
		return 0, 0, err
	}
	second, err := d.byteAt()
	if err != nil {
		return 0, 0, err
	}
	return int(first)>>2 | int(second)<<6, int(first & 0x03), nil
}

// pageChecksum is the format's Adler-style rolling sum, used for both
// system and data page headers. The 0x15b0 chunking is part of the
// definition rather than an optimisation: the modulo is applied per
// chunk, so a different chunk size gives a different answer.
func pageChecksum(seed uint32, data []byte) uint32 {
	sum1 := seed & 0xFFFF
	sum2 := seed >> 0x10
	for len(data) > 0 {
		n := min(0x15B0, len(data))
		for _, b := range data[:n] {
			sum1 += uint32(b)
			sum2 += sum1
		}
		sum1 %= 0xFFF1
		sum2 %= 0xFFF1
		data = data[n:]
	}
	return sum2<<0x10 | sum1&0xFFFF
}
