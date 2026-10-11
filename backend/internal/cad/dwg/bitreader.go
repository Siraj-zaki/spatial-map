package dwg

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf16"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// Everything below the container is a bit stream, not a byte stream. A
// DWG object does not begin on a byte boundary and its fields do not
// either: a boolean costs one bit, a coordinate that happens to be 0.0
// costs two, and a 32-bit integer under 256 costs ten. The saving is
// real — it is most of why DWG files are a fraction of the size of the
// equivalent DXF — and it means no part of an object can be read with a
// byte cursor.
//
// The type names are the format documentation's own codes, so a decoding
// routine reads like the spec paragraph it implements. Values are
// big-endian *by bit* within each byte, but little-endian by byte within
// a multi-byte number, which is the single easiest thing to get wrong.
//
// Implemented from the Open Design Alliance's specification §2.

// ErrMalformed means the bytes were readable but said something the
// format does not allow — a reserved bit pattern, a length that cannot
// be right. It is separate from ErrTruncated because it usually means
// the reader is out of step rather than the file being short.
var ErrMalformed = errors.New("dwg: malformed value")

type bitReader struct {
	data []byte
	pos  int // in bits
	// end bounds the reader in bits. It is not always the end of the
	// bytes: an object's streams are laid out inside one extent and each
	// has to be stopped at its own boundary, or a decoder that reads one
	// field too many is handed whatever the next stream begins with
	// instead of an error.
	end int
	err error
}

func newBitReader(data []byte) *bitReader {
	return &bitReader{data: data, end: len(data) * 8}
}

// window returns an independent reader over the same bytes, positioned
// at start and stopping at end. Bit positions are shared with the parent,
// so a position taken from one is meaningful in the other.
func (b *bitReader) window(start, end int) *bitReader {
	w := &bitReader{data: b.data, pos: start, end: end}
	if start < 0 || end > len(b.data)*8 || start > end {
		w.fail(fmt.Errorf("%w: window [%d,%d) of %d bits", ErrTruncated, start, end, len(b.data)*8))
	}
	return w
}

func (b *bitReader) fail(err error) {
	if b.err == nil {
		b.err = err
	}
}

// Err reports the first failure. As with cursor, reads after a failure
// are no-ops returning zero, so a routine can decode a whole object and
// check once rather than after every field.
func (b *bitReader) Err() error { return b.err }

func (b *bitReader) bitPos() int { return b.pos }
func (b *bitReader) seekBit(p int) {
	if p < 0 || p > b.end {
		b.fail(fmt.Errorf("%w: seek to bit %d of %d", ErrTruncated, p, b.end))
		return
	}
	b.pos = p
}

// align moves to the next byte boundary. Several structures are
// byte-aligned after a bit-packed preamble.
func (b *bitReader) align() { b.pos = (b.pos + 7) &^ 7 }

func (b *bitReader) remainingBits() int {
	if b.err != nil {
		return 0
	}
	return b.end - b.pos
}

// bits reads n bits, most significant first.
func (b *bitReader) bits(n int) uint64 {
	if b.err != nil {
		return 0
	}
	if n < 0 || n > 64 {
		b.fail(fmt.Errorf("%w: %d-bit read", ErrMalformed, n))
		return 0
	}
	if n == 0 {
		return 0
	}
	if b.pos+n > b.end {
		b.fail(fmt.Errorf("%w: want %d bits at %d of %d", ErrTruncated, n, b.pos, b.end))
		return 0
	}
	var v uint64
	for i := range n {
		p := b.pos + i
		v = v<<1 | uint64(b.data[p>>3]>>(7-uint(p&7))&1)
	}
	b.pos += n
	return v
}

func (b *bitReader) bit() uint64   { return b.bits(1) }
func (b *bitReader) bb() uint64    { return b.bits(2) }
func (b *bitReader) boolean() bool { return b.bits(1) == 1 }

// Raw types. The bit order within each byte is unchanged, but the bytes
// themselves assemble little-endian.
func (b *bitReader) rc() byte { return byte(b.bits(8)) }
func (b *bitReader) rs() uint16 {
	lo := uint16(b.bits(8))
	return lo | uint16(b.bits(8))<<8
}
func (b *bitReader) rl() uint32 {
	var v uint32
	for i := range 4 {
		v |= uint32(b.bits(8)) << (8 * uint(i))
	}
	return v
}
func (b *bitReader) rll() uint64 {
	var v uint64
	for i := range 8 {
		v |= b.bits(8) << (8 * uint(i))
	}
	return v
}
func (b *bitReader) rd() float64 { return math.Float64frombits(b.rll()) }

func (b *bitReader) rawBytes(n int) []byte {
	out := make([]byte, max(n, 0))
	for i := range out {
		out[i] = byte(b.bits(8))
	}
	return out
}

// bs is BS, a bit short. Two control bits buy the common cases: most
// shorts in a drawing are small, zero, or the constant 256 (which is the
// ByLayer colour, so it appears on nearly every entity).
func (b *bitReader) bs() uint16 {
	switch b.bb() {
	case 0:
		return b.rs()
	case 1:
		return uint16(b.bits(8))
	case 2:
		return 0
	default:
		return 256
	}
}

// bl is BL, a bit long. Same idea; the 11 pattern is unused rather than
// standing for a constant.
func (b *bitReader) bl() uint32 {
	switch b.bb() {
	case 0:
		return b.rl()
	case 1:
		return uint32(b.bits(8))
	case 2:
		return 0
	default:
		b.fail(fmt.Errorf("%w: reserved bit-long pattern", ErrMalformed))
		return 0
	}
}

// bll is BLL: three bits of byte count, then that many bytes.
func (b *bitReader) bll() uint64 {
	n := int(b.bits(3))
	var v uint64
	for i := range n {
		v |= b.bits(8) << (8 * uint(i))
	}
	return v
}

// bd is BD, a bit double. 0.0 and 1.0 cost two bits each because
// drawings are full of them — every unrotated insert, every unit scale,
// every point on the Z = 0 plane.
func (b *bitReader) bd() float64 {
	switch b.bb() {
	case 0:
		return b.rd()
	case 1:
		return 1.0
	case 2:
		return 0.0
	default:
		b.fail(fmt.Errorf("%w: reserved bit-double pattern", ErrMalformed))
		return 0
	}
}

func (b *bitReader) bd2() (x, y float64)    { return b.bd(), b.bd() }
func (b *bitReader) bd3() (x, y, z float64) { return b.bd(), b.bd(), b.bd() }
func (b *bitReader) rd2() (x, y float64)    { return b.rd(), b.rd() }

// dd is DD, a double that is usually close to a value the reader
// already knows — the second endpoint of a line shares its high bytes
// with the first far more often than not, so the encoding transmits only
// the bytes that differ.
func (b *bitReader) dd(def float64) float64 {
	raw := math.Float64bits(def)
	switch b.bb() {
	case 0:
		return def
	case 1:
		// The low four bytes are replaced; the exponent and high mantissa
		// bits carry over, which is what makes nearby values cheap.
		var lo uint64
		for i := range 4 {
			lo |= b.bits(8) << (8 * uint(i))
		}
		return math.Float64frombits(raw&^0xFFFFFFFF | lo)
	case 2:
		// Bytes 4 and 5 arrive first, then bytes 0-3. Only bytes 6 and 7
		// — the sign and most of the exponent — carry over.
		var mid uint64
		for i := range 2 {
			mid |= b.bits(8) << (8 * uint(i))
		}
		var lo uint64
		for i := range 4 {
			lo |= b.bits(8) << (8 * uint(i))
		}
		return math.Float64frombits(raw&0xFFFF000000000000 | mid<<32 | lo)
	default:
		return b.rd()
	}
}

func (b *bitReader) dd2(dx, dy float64) (x, y float64) {
	return b.dd(dx), b.dd(dy)
}

func (b *bitReader) dd3(dx, dy, dz float64) (x, y, z float64) {
	return b.dd(dx), b.dd(dy), b.dd(dz)
}

// bt is BT, a thickness. One bit says "zero", which is true of almost
// every entity ever drawn.
func (b *bitReader) bt() float64 {
	if b.bit() == 1 {
		return 0
	}
	return b.bd()
}

// be is BE, an extrusion direction. One bit says "+Z", which is true of
// everything drawn in plan.
func (b *bitReader) be() (x, y, z float64) {
	if b.bit() == 1 {
		return 0, 0, 1
	}
	return b.bd3()
}

// mc is MC, a modular char: seven value bits per byte, high bit
// continues, and bit 0x40 of the final byte is the sign. Used for
// counts and offsets that are small but not bounded.
func (b *bitReader) mc() int64 {
	var v uint64
	for shift := 0; shift < 63; shift += 7 {
		by := b.rc()
		if b.err != nil {
			return 0
		}
		if by&0x80 == 0 {
			if by&0x40 != 0 {
				v |= uint64(by&0x3F) << shift
				return -int64(v)
			}
			v |= uint64(by) << shift
			return int64(v)
		}
		v |= uint64(by&0x7F) << shift
	}
	b.fail(fmt.Errorf("%w: modular char does not terminate", ErrMalformed))
	return 0
}

// umc is the same encoding without the sign bit, so the final byte
// carries seven value bits rather than six.
func (b *bitReader) umc() uint64 {
	var v uint64
	for shift := 0; shift < 63; shift += 7 {
		by := b.rc()
		if b.err != nil {
			return 0
		}
		v |= uint64(by&0x7F) << shift
		if by&0x80 == 0 {
			return v
		}
	}
	b.fail(fmt.Errorf("%w: modular char does not terminate", ErrMalformed))
	return 0
}

// ms is MS, a modular short: the same continuation scheme over 16-bit
// words instead of bytes.
func (b *bitReader) ms() uint32 {
	var v uint32
	for shift := 0; shift < 32; shift += 15 {
		w := b.rs()
		if b.err != nil {
			return 0
		}
		v |= uint32(w&0x7FFF) << shift
		if w&0x8000 == 0 {
			return v
		}
	}
	b.fail(fmt.Errorf("%w: modular short does not terminate", ErrMalformed))
	return 0
}

// handle is H. The leading byte splits into a code saying how the value
// relates to the object being read and a count of value bytes that
// follow, most significant first.
//
// The codes matter: a handle is usually stored as a small delta from the
// containing object's own handle, so the same eight bytes are rarely
// written twice.
type handle struct {
	Code  byte
	Value uint64
}

func (b *bitReader) h() handle {
	first := b.rc()
	if b.err != nil {
		return handle{}
	}
	code, n := first>>4, int(first&0x0F)
	if n > 8 {
		b.fail(fmt.Errorf("%w: handle of %d bytes", ErrMalformed, n))
		return handle{}
	}
	var v uint64
	for range n {
		v = v<<8 | uint64(b.rc())
	}
	return handle{Code: code, Value: v}
}

// resolve turns a handle read inside an object into an absolute one.
// Codes 6-0xA are relative to the referencing object, which is why a
// handle cannot be interpreted without knowing where it was found.
func (h handle) resolve(owner uint64) uint64 {
	switch h.Code {
	case 0x06:
		return owner + 1
	case 0x08:
		return owner - 1
	case 0x0A:
		return owner + h.Value
	case 0x0C:
		return owner - h.Value
	default:
		return h.Value
	}
}

// text reads T: a length in bytes followed by that many bytes in the
// drawing's code page. Pre-R2007 only.
//
// The length counts a terminating NUL that is not part of the string:
// layer "0" is written as two bytes. Keeping it would be invisible in a
// bit-landing check — the framing is correct either way — and would
// surface much later as a layer whose name matches nothing.
func (b *bitReader) text() string {
	n := int(b.bs())
	if n < 0 {
		return ""
	}
	return strings.TrimSuffix(string(b.rawBytes(n)), "\x00")
}

// textU reads TU: a length in *characters* followed by that many UTF-16
// code units. R2007 and later store every string this way.
func (b *bitReader) textU() string {
	n := int(b.bs())
	if n <= 0 {
		return ""
	}
	if n*16 > b.remainingBits() {
		b.fail(fmt.Errorf("%w: string of %d characters", ErrTruncated, n))
		return ""
	}
	units := make([]uint16, n)
	for i := range units {
		units[i] = b.rs()
	}
	return string(utf16.Decode(units))
}

// cmc reads CMC, an entity colour. R2004 introduced true colour, so the
// index is followed by an optional RGB and an optional name; the flag
// byte that says which are present sits inside the RGB long.
func (b *bitReader) cmc(v Version) cad.Color {
	var c cad.Color
	c.Index = int16(b.bs())
	if !v.AtLeast(R2004) {
		return c
	}
	rgb := b.bl()
	flag := byte(rgb >> 24)
	if flag&0x80 != 0 {
		c.RGB = rgb & 0x00FFFFFF
		c.HasRGB = true
	}
	// The remaining flags announce names that follow. They are style
	// bookkeeping we do not use, but they must be consumed or every
	// later field in the object is off by their length.
	if flag&0x40 != 0 {
		_ = b.h()
	}
	if flag&0x20 != 0 {
		_ = b.bl()
	}
	return c
}

// objectType reads OT. R2010 widened the object-type field but kept the
// old one-byte form for the built-in entities, which are the only ones
// with a type below 500.
func (b *bitReader) objectType(v Version) uint16 {
	if !v.AtLeast(R2010) {
		return b.bs()
	}
	switch b.bb() {
	case 0:
		return uint16(b.bits(8))
	case 1:
		return uint16(b.bits(8)) + 0x1F0
	default:
		return b.rs()
	}
}
