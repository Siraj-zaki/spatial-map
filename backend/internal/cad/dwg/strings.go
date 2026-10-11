package dwg

import "fmt"

// R2007 moved every string out of the object's data into a stream of its
// own — and then wrote that stream backwards from the end of the data: a
// flag saying it exists, below it the stream's size, below that the
// strings themselves. So an object with strings has data that stops
// short of the flag, and finding where means reading down from the end
// before anything can be read along from the start.
//
// The arrangement is not perverse. It lets a writer emit the data in one
// forward pass without knowing in advance how much text the object will
// carry, and it lets a reader that does not care about text skip the
// whole stream by subtraction.
//
// Implemented from the Open Design Alliance's specification §2.2.

// locateStrings finds the string stream and, with it, the point at which
// the object's own data stops.
func (o *object) locateStrings() error {
	flag := o.dataEnd()
	o.strStart, o.strEnd = flag, flag
	if !o.Version.AtLeast(R2007) {
		return nil
	}

	b := o.data.window(0, flag+1)
	b.seekBit(flag)
	if b.bit() != 1 {
		return b.Err()
	}
	o.hasStrings = true

	// The size is itself extensible: a stream too long for fifteen bits
	// sets the top bit of the first word and puts the rest in a second
	// word below it. Both are raw shorts, so both are found by
	// subtraction rather than by reading forwards.
	end := flag - 16
	b.seekBit(end)
	size := int(b.rs())
	if size&0x8000 != 0 {
		end = flag - 32
		b.seekBit(end)
		size = size&0x7FFF | int(b.rs())<<15
	}
	if err := b.Err(); err != nil {
		return fmt.Errorf("object %#x string stream: %w", o.Handle, err)
	}
	if end-size < 0 {
		return fmt.Errorf("%w: object %#x claims a %d-bit string stream ending at bit %d",
			ErrMalformed, o.Handle, size, end)
	}

	o.strStart, o.strEnd = end-size, end
	return nil
}

// dataStop is where the object's own data ends: at the string stream
// when there is one, at the flag that says so when there is not — and one
// bit further on a release that has no flag, because R2007 took that bit
// out of the data rather than adding one for it.
//
// The last case is easy to miss, since dataEnd is right for both: the
// handle stream begins at dataEnd+1 either way. It shows up only in a
// decoder's landing check, where every pre-R2007 object appears to
// overrun by exactly one bit — and one bit is small enough to look like
// a field read too wide rather than a boundary drawn too early.
func (o *object) dataStop() int {
	if o.hasStrings {
		return o.strStart
	}
	if !o.Version.AtLeast(R2007) {
		return o.dataEnd() + 1
	}
	return o.dataEnd()
}

// strings returns a reader over the string stream. The object's fields
// name their strings in order, so a decoder threads this reader through
// alongside the data one rather than seeking within it.
func (o *object) strings() *bitReader {
	return o.data.window(o.strStart, o.strEnd)
}
