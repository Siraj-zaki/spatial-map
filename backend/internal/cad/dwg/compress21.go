package dwg

import "fmt"

// R2007 uses a second, unrelated LZ77 variant. Sharing nothing with the
// R2004 one but the family name, it is opcode-for-opcode different and
// gets its own file rather than a mode flag on the other decoder.
//
// The shape of the stream is: a run of literal bytes, then one or more
// back-references, then a run of literals, and so on. What makes it
// awkward to read is that the *next* run's literal count is carried in
// the low three bits of the last back-reference opcode, so the two loops
// below hand a length back and forth rather than each reading their own.
//
// Implemented from the Open Design Alliance's specification §5.10.

// decompressR21 expands a stream to exactly outLen bytes.
//
// Unlike the R2004 decompressor the length here is a contract, not a cap:
// every R21 caller knows the decompressed size from the page or section
// map, and a stream that produces a different amount has been misread.
func decompressR21(src []byte, outLen int) ([]byte, error) {
	if outLen < 0 {
		return nil, fmt.Errorf("%w: negative output size", errCorruptStream)
	}
	d := &lz21{src: src, dst: make([]byte, 0, outLen), max: outLen}

	// The stream opens with a literal run, but the encoding of its length
	// depends on how long it is. A run of 8 or more is announced by an
	// opcode in 0x00-0x0F; a run of 1-7 has nowhere to live in that
	// space, so the encoder emits a dummy back-reference opcode whose low
	// three bits carry the count, and the run length is picked up from
	// the third byte of it.
	if len(src) == 0 {
		return nil, fmt.Errorf("%w: empty stream", errCorruptStream)
	}
	var length int
	if src[0]>>4 == 2 {
		if len(src) < 4 {
			return nil, fmt.Errorf("%w: truncated opening opcode", errCorruptStream)
		}
		length = int(src[3] & 0x07)
		d.pos = 4
	} else {
		d.op = src[0]
		d.pos = 1
	}

	for {
		if length == 0 {
			var err error
			if length, err = d.literalLength(); err != nil {
				return nil, err
			}
		}
		if err := d.literals(length); err != nil {
			return nil, err
		}
		if d.pos >= len(d.src) {
			break
		}

		n, done, err := d.matches()
		if err != nil {
			return nil, err
		}
		if done {
			break
		}
		length = n
	}

	if len(d.dst) != outLen {
		return nil, fmt.Errorf("%w: expanded to %d bytes, want %d", errCorruptStream, len(d.dst), outLen)
	}
	return d.dst, nil
}

type lz21 struct {
	src []byte
	pos int
	dst []byte
	max int
	// op is the opcode most recently consumed. It outlives the routine
	// that read it because a back-reference opcode announces the literal
	// run that follows it.
	op byte
}

func (d *lz21) byteAt() (byte, error) {
	if d.pos >= len(d.src) {
		return 0, fmt.Errorf("%w: input exhausted", errCorruptStream)
	}
	b := d.src[d.pos]
	d.pos++
	return b, nil
}

// literalLength decodes a run of 8 or more literals from the pending
// opcode, extending through 0xFF continuation bytes and then 0xFFFF pairs
// once the one-byte extension saturates.
func (d *lz21) literalLength() (int, error) {
	length := int(d.op) + 8
	if length != 0x17 {
		return length, nil
	}
	n, err := d.byteAt()
	if err != nil {
		return 0, err
	}
	length += int(n)
	if n != 0xFF {
		return length, nil
	}
	for {
		lo, err := d.byteAt()
		if err != nil {
			return 0, err
		}
		hi, err := d.byteAt()
		if err != nil {
			return 0, err
		}
		wide := int(lo) | int(hi)<<8
		length += wide
		if length > d.max {
			return 0, fmt.Errorf("%w: literal run exceeds output size", errCorruptStream)
		}
		if wide != 0xFFFF {
			return length, nil
		}
	}
}

func (d *lz21) literals(n int) error {
	if n == 0 {
		return nil
	}
	if n < 0 || d.pos+n > len(d.src) {
		return fmt.Errorf("%w: literal run of %d overruns input", errCorruptStream, n)
	}
	if len(d.dst)+n > d.max {
		return fmt.Errorf("%w: literal run overruns output", errCorruptStream)
	}
	d.dst = appendLiteralRun(d.dst, d.src[d.pos:d.pos+n])
	d.pos += n
	return nil
}

// A literal run is not stored in order. The encoder emits it in chunks
// taken from the end of the run backwards — the last few bytes first,
// then the block below them, and so on. Runs longer than 32 bytes are
// cut into 32-byte pieces that ARE in order, and only the piece is
// shuffled.
//
// It looks like a mistake and is not: the fields that open every R2007
// file header are unambiguous (a version constant, the file's own byte
// count, the object map's 16-byte sentinel) and they only come out right
// this way.
//
// The layout is a lookup rather than a formula because the sizes the
// encoder splits each length into are not derivable — the writing side
// is a hand-written copy routine per length, so this is a permutation
// per length.
//
// Each entry is a list of {size, source index} chunks written to the
// output in order, and the sizes are *recursive*: a chunk of n bytes is
// itself laid out by entry n, not copied straight through. So entry 23's
// trailing {16, 0} is not "sixteen bytes from the start" but "entry 16
// applied to the first sixteen bytes", which swaps their halves.
//
// The recursion bottoms out at 1, 4 and 8 — the sizes the writer moves
// as whole machine words, which come out unpermuted. Their slots below
// are left empty because appendLiteralChunk answers them directly.
var literalChunks = [33][][2]uint8{
	2:  {{1, 1}, {1, 0}},
	3:  {{1, 2}, {1, 1}, {1, 0}},
	5:  {{1, 4}, {4, 0}},
	6:  {{1, 5}, {4, 1}, {1, 0}},
	7:  {{2, 5}, {4, 1}, {1, 0}},
	9:  {{1, 8}, {8, 0}},
	10: {{1, 9}, {8, 1}, {1, 0}},
	11: {{2, 9}, {8, 1}, {1, 0}},
	12: {{4, 8}, {8, 0}},
	13: {{1, 12}, {4, 8}, {8, 0}},
	14: {{1, 13}, {4, 9}, {8, 1}, {1, 0}},
	15: {{2, 13}, {4, 9}, {8, 1}, {1, 0}},
	16: {{8, 8}, {8, 0}},
	17: {{8, 9}, {1, 8}, {8, 0}},
	18: {{1, 17}, {16, 1}, {1, 0}},
	19: {{3, 16}, {16, 0}},
	20: {{4, 16}, {16, 0}},
	21: {{1, 20}, {4, 16}, {16, 0}},
	22: {{2, 20}, {4, 16}, {16, 0}},
	23: {{3, 20}, {4, 16}, {16, 0}},
	24: {{8, 16}, {16, 0}},
	25: {{8, 17}, {1, 16}, {16, 0}},
	26: {{1, 25}, {8, 17}, {1, 16}, {16, 0}},
	27: {{2, 25}, {8, 17}, {1, 16}, {16, 0}},
	28: {{4, 24}, {8, 16}, {16, 0}},
	29: {{1, 28}, {4, 24}, {8, 16}, {16, 0}},
	30: {{2, 28}, {4, 24}, {8, 16}, {16, 0}},
	31: {{1, 30}, {4, 26}, {8, 18}, {16, 2}, {2, 0}},
	32: {{16, 16}, {16, 0}},
}

func appendLiteralRun(dst, src []byte) []byte {
	for len(src) > 32 {
		dst = appendLiteralChunk(dst, src[:32])
		src = src[32:]
	}
	return appendLiteralChunk(dst, src)
}

func appendLiteralChunk(dst, src []byte) []byte {
	switch len(src) {
	case 0:
		return dst
	case 1, 4, 8:
		return append(dst, src...)
	}
	for _, c := range literalChunks[len(src)] {
		off, size := int(c[1]), int(c[0])
		dst = appendLiteralChunk(dst, src[off:off+size])
	}
	return dst
}

// matches copies back-references until the stream turns back to
// literals. It returns the length of the run that follows, which is zero
// when that run is long enough to carry its own length opcode, and done
// when the stream has ended.
func (d *lz21) matches() (n int, done bool, err error) {
	op, err := d.byteAt()
	if err != nil {
		return 0, false, err
	}
	d.op = op
	offset, length, err := d.instruction()
	if err != nil {
		return 0, false, err
	}

	for {
		if err := d.match(length, offset); err != nil {
			return 0, false, err
		}

		// The low three bits of the opcode that produced this match hold
		// the length of the literal run that follows it. That is the only
		// place a run shorter than eight bytes can be encoded, so a
		// non-zero value ends the run of back-references.
		if n := int(d.op & 0x07); n != 0 {
			return n, false, nil
		}
		if d.pos >= len(d.src) {
			return 0, true, nil
		}

		op, err := d.byteAt()
		if err != nil {
			return 0, false, err
		}
		// A high nibble of zero is not a back-reference: it is the
		// length opcode for a literal run of eight or more, so leave it
		// pending and let the caller read the run.
		if op>>4 == 0 {
			d.op = op
			return 0, false, nil
		}
		if op>>4 == 0x0F {
			op &= 0x0F
		}
		d.op = op
		if offset, length, err = d.instruction(); err != nil {
			return 0, false, err
		}
	}
}

// instruction decodes one back-reference from the pending opcode. Each
// branch consumes a different number of trailing bytes and may replace
// the pending opcode with the last byte it read, which is where the
// following literal count comes from.
func (d *lz21) instruction() (offset, length int, err error) {
	next := func() (int, error) {
		b, err := d.byteAt()
		return int(b), err
	}

	switch d.op >> 4 {
	case 0:
		length = int(d.op&0x0F) + 0x13
		if offset, err = next(); err != nil {
			return 0, 0, err
		}
		b, err := d.byteAt()
		if err != nil {
			return 0, 0, err
		}
		d.op = b
		length += int(b>>3) & 0x10
		offset += int(b&0x78)<<5 + 1

	case 1:
		length = int(d.op&0x0F) + 3
		if offset, err = next(); err != nil {
			return 0, 0, err
		}
		b, err := d.byteAt()
		if err != nil {
			return 0, 0, err
		}
		d.op = b
		offset += int(b&0xF8)<<5 + 1

	case 2:
		lo, err := next()
		if err != nil {
			return 0, 0, err
		}
		hi, err := next()
		if err != nil {
			return 0, 0, err
		}
		offset = lo | hi<<8
		length = int(d.op & 0x07)
		if d.op&0x08 == 0 {
			b, err := d.byteAt()
			if err != nil {
				return 0, 0, err
			}
			d.op = b
			length += int(b & 0xF8)
		} else {
			offset++
			n, err := next()
			if err != nil {
				return 0, 0, err
			}
			length += n << 3
			b, err := d.byteAt()
			if err != nil {
				return 0, 0, err
			}
			d.op = b
			length += int(b&0xF8)<<8 + 0x100
		}

	default:
		length = int(d.op >> 4)
		offset = int(d.op & 0x0F)
		b, err := d.byteAt()
		if err != nil {
			return 0, 0, err
		}
		d.op = b
		offset += int(b&0xF8)<<1 + 1
	}

	return offset, length, nil
}

// match copies length bytes from offset back in the output. As in R2004
// the copy must run byte by byte: length may exceed offset, which is how
// the format encodes a repeating run.
func (d *lz21) match(length, offset int) error {
	start := len(d.dst) - offset
	if length < 0 || offset <= 0 || start < 0 {
		return fmt.Errorf("%w: match %d bytes at -%d", errCorruptStream, length, offset)
	}
	if len(d.dst)+length > d.max {
		return fmt.Errorf("%w: match overruns output", errCorruptStream)
	}
	for i := range length {
		d.dst = append(d.dst, d.dst[start+i])
	}
	return nil
}
