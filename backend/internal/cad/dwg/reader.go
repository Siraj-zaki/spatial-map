package dwg

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// ErrTruncated means the file ended in the middle of something the
// format says must be there. Every read goes through the cursor below so
// that a truncated or hostile file produces this rather than a panic —
// the input is an upload, so a slice bounds panic would be a denial of
// service with extra steps.
var ErrTruncated = errors.New("dwg: unexpected end of data")

// cursor is a bounds-checked little-endian byte reader. DWG is
// little-endian throughout, including on the wire formats it embeds.
type cursor struct {
	data []byte
	pos  int
	err  error
}

func newCursor(data []byte) *cursor { return &cursor{data: data} }

func (c *cursor) fail(err error) {
	if c.err == nil {
		c.err = err
	}
}

// Err reports the first failure. Reads after a failure are no-ops
// returning zero, so a parse routine can read a whole struct and check
// once at the end instead of after every field.
func (c *cursor) Err() error { return c.err }

func (c *cursor) seek(off int) {
	if off < 0 || off > len(c.data) {
		c.fail(fmt.Errorf("%w: seek to %d of %d", ErrTruncated, off, len(c.data)))
		return
	}
	c.pos = off
}

func (c *cursor) remaining() int {
	if c.err != nil {
		return 0
	}
	return len(c.data) - c.pos
}

func (c *cursor) take(n int) []byte {
	if c.err != nil {
		return make([]byte, n)
	}
	if n < 0 || c.pos+n > len(c.data) {
		c.fail(fmt.Errorf("%w: want %d bytes at %d of %d", ErrTruncated, n, c.pos, len(c.data)))
		return make([]byte, max(n, 0))
	}
	out := c.data[c.pos : c.pos+n]
	c.pos += n
	return out
}

// The names match the format documentation's own type codes, so a
// reader routine reads like the spec paragraph it implements: RC is a
// raw char, RS a raw short, RL a raw long, RLL a raw long long, RD a raw
// double.
func (c *cursor) rc() byte    { return c.take(1)[0] }
func (c *cursor) rs() uint16  { return binary.LittleEndian.Uint16(c.take(2)) }
func (c *cursor) rl() uint32  { return binary.LittleEndian.Uint32(c.take(4)) }
func (c *cursor) rll() uint64 { return binary.LittleEndian.Uint64(c.take(8)) }
func (c *cursor) rd() float64 { return math.Float64frombits(c.rll()) }
func (c *cursor) rsl() int32  { return int32(c.rl()) }
func (c *cursor) bytes(n int) []byte {
	// Copy: callers keep these past the lifetime of the backing buffer,
	// and an alias into a multi-megabyte upload would pin it.
	out := make([]byte, n)
	copy(out, c.take(n))
	return out
}

// fixedString reads a null-terminated string from a fixed-width field,
// which is how section names are stored.
func (c *cursor) fixedString(n int) string {
	raw := c.take(n)
	for i, b := range raw {
		if b == 0 {
			return string(raw[:i])
		}
	}
	return string(raw)
}
