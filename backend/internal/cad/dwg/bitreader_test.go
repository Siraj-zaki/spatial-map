package dwg

import (
	"errors"
	"math"
	"testing"
	"unicode/utf16"
)

// The container tests need real files because a synthetic DWG would only
// prove the reader agrees with a writer we also wrote. These do not: the
// bit encodings are self-contained, so a pattern written out by hand from
// the specification is independent evidence, and it is the only way to
// exercise the branches real drawings rarely take.
type bitWriter struct {
	data []byte
	n    int
}

// put appends the low `bits` bits of v, most significant first.
func (w *bitWriter) put(v uint64, bits int) *bitWriter {
	for i := bits - 1; i >= 0; i-- {
		if w.n%8 == 0 {
			w.data = append(w.data, 0)
		}
		if v>>uint(i)&1 == 1 {
			w.data[w.n/8] |= 1 << (7 - uint(w.n%8))
		}
		w.n++
	}
	return w
}

func (w *bitWriter) bytes(bs ...byte) *bitWriter {
	for _, b := range bs {
		w.put(uint64(b), 8)
	}
	return w
}

func bw() *bitWriter { return &bitWriter{} }

func TestBitsAreMostSignificantFirst(t *testing.T) {
	r := newBitReader([]byte{0b10110010})
	if got := r.bits(3); got != 0b101 {
		t.Errorf("first 3 bits = %b, want 101", got)
	}
	if got := r.bits(5); got != 0b10010 {
		t.Errorf("next 5 bits = %b, want 10010", got)
	}
}

// A multi-byte raw value is little-endian by byte even though the bits
// within each byte are read most significant first. Reading it at a
// non-zero bit offset is the case that catches an implementation that
// quietly assumes byte alignment.
func TestRawShortIsLittleEndianAtAnyBitOffset(t *testing.T) {
	w := bw().put(0b101, 3).bytes(0x34, 0x12)
	r := newBitReader(w.data)
	r.bits(3)
	if got := r.rs(); got != 0x1234 {
		t.Errorf("rs = %#x, want 0x1234", got)
	}
}

func TestBitShort(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   *bitWriter
		want uint16
	}{
		{"full short", bw().put(0, 2).bytes(0x34, 0x12), 0x1234},
		{"single byte", bw().put(1, 2).bytes(0x7F), 127},
		{"zero", bw().put(2, 2), 0},
		{"the constant 256", bw().put(3, 2), 256},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := newBitReader(tc.in.data).bs(); got != tc.want {
				t.Errorf("bs = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestBitLong(t *testing.T) {
	if got := newBitReader(bw().put(0, 2).bytes(0x78, 0x56, 0x34, 0x12).data).bl(); got != 0x12345678 {
		t.Errorf("bl = %#x, want 0x12345678", got)
	}
	if got := newBitReader(bw().put(1, 2).bytes(0xFF).data).bl(); got != 255 {
		t.Errorf("bl = %d, want 255", got)
	}
	if got := newBitReader(bw().put(2, 2).data).bl(); got != 0 {
		t.Errorf("bl = %d, want 0", got)
	}

	// The fourth pattern is reserved. Accepting it silently would let a
	// hostile file steer the reader rather than stop it.
	r := newBitReader(bw().put(3, 2).data)
	r.bl()
	if !errors.Is(r.Err(), ErrMalformed) {
		t.Errorf("reserved bit-long pattern: err = %v, want ErrMalformed", r.Err())
	}
}

func TestBitDouble(t *testing.T) {
	raw := math.Float64bits(3.14159)
	w := bw().put(0, 2)
	for i := range 8 {
		w.put(raw>>(8*uint(i))&0xFF, 8)
	}
	if got := newBitReader(w.data).bd(); got != 3.14159 {
		t.Errorf("bd = %v, want 3.14159", got)
	}
	if got := newBitReader(bw().put(1, 2).data).bd(); got != 1.0 {
		t.Errorf("bd = %v, want 1", got)
	}
	if got := newBitReader(bw().put(2, 2).data).bd(); got != 0.0 {
		t.Errorf("bd = %v, want 0", got)
	}
}

// DD exists so that a value close to one already known costs a few bytes
// instead of eight. Each pattern keeps a different slice of the default,
// so the test asserts on values whose bytes differ in exactly the range
// the pattern claims to replace.
func TestBitDoubleWithDefault(t *testing.T) {
	const def = 12345.6789

	if got := newBitReader(bw().put(0, 2).data).dd(def); got != def {
		t.Errorf("unchanged: %v, want %v", got, def)
	}

	// 01 replaces the low four bytes, so the result is the default with
	// its least significant mantissa bits swapped out.
	want := math.Float64frombits(math.Float64bits(def)&^0xFFFFFFFF | 0x89ABCDEF)
	w := bw().put(1, 2).bytes(0xEF, 0xCD, 0xAB, 0x89)
	if got := newBitReader(w.data).dd(def); got != want {
		t.Errorf("low four bytes: %v, want %v", got, want)
	}

	// 10 sends bytes 4 and 5 first, then bytes 0-3; only the sign and
	// exponent survive from the default.
	want = math.Float64frombits(math.Float64bits(def)&0xFFFF000000000000 | 0x1122<<32 | 0x89ABCDEF)
	w = bw().put(2, 2).bytes(0x22, 0x11).bytes(0xEF, 0xCD, 0xAB, 0x89)
	if got := newBitReader(w.data).dd(def); got != want {
		t.Errorf("low six bytes: %v, want %v", got, want)
	}

	raw := math.Float64bits(-7.5)
	w = bw().put(3, 2)
	for i := range 8 {
		w.put(raw>>(8*uint(i))&0xFF, 8)
	}
	if got := newBitReader(w.data).dd(def); got != -7.5 {
		t.Errorf("full double: %v, want -7.5", got)
	}
}

// The two examples are the specification's own, which is what makes them
// worth pinning: the sign living in bit 0x40 of the *last* byte rather
// than the first is the part that is easy to get backwards.
func TestModularChar(t *testing.T) {
	if got := newBitReader([]byte{0x82, 0x24}).mc(); got != 4610 {
		t.Errorf("mc = %d, want 4610", got)
	}
	if got := newBitReader([]byte{0x85, 0x4B}).mc(); got != -1413 {
		t.Errorf("mc = %d, want -1413", got)
	}
	// The same bytes read unsigned keep the 0x40 bit as a value bit.
	if got := newBitReader([]byte{0x85, 0x4B}).umc(); got != 0x4B<<7|5 {
		t.Errorf("umc = %d, want %d", got, 0x4B<<7|5)
	}
}

// A handle is stored as a delta from the object that refers to it, so
// the same value decodes differently depending on where it was found.
// Reading the count but ignoring the code yields plausible-looking
// garbage rather than an error, which is why it is pinned here.
func TestHandleResolution(t *testing.T) {
	r := newBitReader([]byte{0x21, 0x2B})
	h := r.h()
	if h.Code != 2 || h.Value != 0x2B {
		t.Fatalf("handle = %+v, want code 2 value 0x2B", h)
	}
	if got := h.resolve(0x100); got != 0x2B {
		t.Errorf("absolute handle resolved to %#x, want 0x2B", got)
	}

	for _, tc := range []struct {
		code  byte
		value uint64
		want  uint64
	}{
		{0x06, 0, 0x101}, // owner + 1
		{0x08, 0, 0x0FF}, // owner - 1
		{0x0A, 5, 0x105}, // owner + value
		{0x0C, 5, 0x0FB}, // owner - value
	} {
		got := handle{Code: tc.code, Value: tc.value}.resolve(0x100)
		if got != tc.want {
			t.Errorf("code %#x resolved to %#x, want %#x", tc.code, got, tc.want)
		}
	}
}

// R2007 stores every string as UTF-16 with a length in characters, not
// bytes — the same confusion that broke the section map.
func TestUnicodeText(t *testing.T) {
	const want = "Muré" // accented, so a byte-length reading comes out short
	units := utf16.Encode([]rune(want))
	w := bw().put(1, 2).bytes(byte(len(units))) // BS in its single-byte form
	for _, u := range units {
		w.bytes(byte(u), byte(u>>8))
	}
	if got := newBitReader(w.data).textU(); got != want {
		t.Errorf("textU = %q, want %q", got, want)
	}
}

// Every read is bounds-checked because the input is an upload. A short
// buffer must produce an error, not a panic and not silent zeroes that
// look like real geometry.
func TestReadsPastTheEndFail(t *testing.T) {
	r := newBitReader([]byte{0x00})
	r.bits(4)
	r.rll()
	if !errors.Is(r.Err(), ErrTruncated) {
		t.Errorf("err = %v, want ErrTruncated", r.Err())
	}
	// The first failure sticks and later reads are no-ops, so a decoder
	// can read a whole object and check once at the end.
	if got := r.bd(); got != 0 {
		t.Errorf("read after failure returned %v, want 0", got)
	}
}
