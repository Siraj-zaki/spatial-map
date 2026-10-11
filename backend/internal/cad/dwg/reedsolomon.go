package dwg

import "fmt"

// R2007 wraps every page in a Reed-Solomon code so that a damaged sector
// still reads. That is a write-side concern: for a file that is not
// damaged, "decoding" is only stripping the parity bytes and undoing the
// interleave, which is what this file does.
//
// Skipping the Berlekamp-Massey half is a deliberate trade. Implementing
// it means Galois field arithmetic, a syndrome pass and an error locator
// polynomial to salvage at most 8 bad bytes in 255 — and a DWG that is
// damaged enough to need that is a file the user should be re-exporting,
// not one we should be silently guessing at. If a corpus ever shows real
// files arriving with recoverable damage, the correction step slots in
// here without touching a caller.
//
// Two configurations are in use, both n = 255:
//
//	system pages: k = 239 (16 parity bytes, corrects 8)
//	data pages:   k = 251 (4 parity bytes, corrects 2)
const (
	rsCodewordSize   = 255
	rsSystemDataSize = 239
	rsDataDataSize   = 251
)

// rsStripInterleaved undoes the interleave used by system pages and by
// data pages whose section encoding is 4.
//
// The encoder splits the payload into `blocks` codewords and writes them
// round-robin, so codeword b's byte i lands at i*blocks+b. Reversing that
// and keeping only the first k bytes of each codeword rebuilds the
// payload in order.
func rsStripInterleaved(src []byte, blocks, k int) ([]byte, error) {
	if blocks <= 0 || k <= 0 || k > rsCodewordSize {
		return nil, fmt.Errorf("dwg: bad Reed-Solomon parameters (blocks=%d k=%d)", blocks, k)
	}
	need := blocks * rsCodewordSize
	if len(src) < need {
		return nil, fmt.Errorf("%w: Reed-Solomon page wants %d bytes, have %d", ErrTruncated, need, len(src))
	}
	out := make([]byte, 0, blocks*k)
	for b := range blocks {
		for i := range k {
			out = append(out, src[i*blocks+b])
		}
	}
	return out, nil
}

// rsStripSequential undoes the non-interleaved layout (section encoding
// 1), where every data block is written before the first parity block.
// With a single block the two layouts coincide, which is why most small
// sections read correctly either way — that coincidence is exactly what
// makes a wrong choice here hard to notice, so the caller picks by the
// section's declared encoding rather than by trial.
func rsStripSequential(src []byte, blocks, k int) ([]byte, error) {
	if blocks <= 0 || k <= 0 || k > rsCodewordSize {
		return nil, fmt.Errorf("dwg: bad Reed-Solomon parameters (blocks=%d k=%d)", blocks, k)
	}
	need := blocks * rsCodewordSize
	if len(src) < need {
		return nil, fmt.Errorf("%w: Reed-Solomon page wants %d bytes, have %d", ErrTruncated, need, len(src))
	}
	return src[:blocks*k], nil
}
