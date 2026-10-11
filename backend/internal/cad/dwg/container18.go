package dwg

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"sort"
)

// The R2004 container, also used unchanged by R2010, R2013 and R2018.
//
// Reading it is a three-step indirection, and the order matters: an
// obfuscated header at a fixed offset points at a *page* map, which
// gives every page's size (and therefore, by running total, its
// address); one of those pages is the *section* map, which names the
// logical sections and lists the pages each is made of. Only then can
// "give me AcDb:Header" be answered.
//
// Implemented from the ODA specification §4.1-4.7.

const (
	// r18HeaderOffset is where the obfuscated file header data sits, and
	// r18HeaderLen its length. Fixed by the format.
	r18HeaderOffset = 0x80
	r18HeaderLen    = 0x6C

	// r18FirstPage is the address of page 1. Every later page follows
	// immediately, so addresses are a running total from here.
	r18FirstPage = 0x100

	// fileIDString proves the header decoded correctly. Cheaper and far
	// more legible in a log than the CRC32 that follows it, and it fails
	// just as reliably.
	fileIDString = "AcFssFcAJMB"

	pageTypeSectionPageMap = 0x41630E3B
	pageTypeSectionMap     = 0x4163003B
	pageTypeData           = 0x4163043B

	// dataPageHeaderLen is the encrypted header on every data page.
	dataPageHeaderLen = 0x20
)

// r18FileHeader is the decoded content of the obfuscated block. Only the
// fields needed to navigate are kept; the rest are tree-balancing
// bookkeeping for the writer.
// Both addresses are relative to the first page rather than to the start
// of the file, so each needs r18FirstPage added before use.
type r18FileHeader struct {
	SectionPageMapID      uint32
	SectionPageMapAddress uint64
	SectionMapID          uint32
	SectionPageCount      uint32
	LastPageID            uint32
	LastPageEndAddress    uint64
}

func readR18FileHeader(data []byte) (r18FileHeader, error) {
	var h r18FileHeader
	if len(data) < r18HeaderOffset+r18HeaderLen {
		return h, fmt.Errorf("%w: file shorter than its own header", ErrTruncated)
	}

	// The obfuscation is a plain XOR against a fixed pseudo-random
	// stream. It is not a security measure and the specification
	// publishes the stream; it exists to stop naive tools from editing
	// the header in place.
	blob := make([]byte, r18HeaderLen)
	copy(blob, data[r18HeaderOffset:r18HeaderOffset+r18HeaderLen])
	for i, m := range magicSequence(r18HeaderLen) {
		blob[i] ^= m
	}

	if !bytes.HasPrefix(blob, []byte(fileIDString)) {
		return h, fmt.Errorf("dwg: file header did not decode (expected %q) — file is corrupt or not really R2004-family",
			fileIDString)
	}

	c := newCursor(blob)
	c.seek(0x28)
	h.LastPageID = c.rl()
	h.LastPageEndAddress = c.rll()
	c.seek(0x40)
	h.SectionPageCount = c.rl()
	c.seek(0x50)
	h.SectionPageMapID = c.rl()
	h.SectionPageMapAddress = c.rll()
	h.SectionMapID = c.rl()
	return h, c.Err()
}

// page is one physical page of the file: where it starts and how many
// bytes it occupies, including its own header.
type page struct {
	ID      int32
	Size    uint32
	Address uint64
}

// systemPage reads and expands one of the two map pages. Both share the
// same 0x14-byte plaintext header.
func systemPage(data []byte, addr uint64, wantType uint32) ([]byte, error) {
	if addr > uint64(len(data)) {
		return nil, fmt.Errorf("%w: system page at %#x beyond %#x", ErrTruncated, addr, len(data))
	}
	c := newCursor(data)
	c.seek(int(addr))
	pageType := c.rl()
	decompLen := c.rl()
	compLen := c.rl()
	compType := c.rl()
	_ = c.rl() // checksum; the type check below is the load-bearing one
	if err := c.Err(); err != nil {
		return nil, err
	}
	if pageType != wantType {
		return nil, fmt.Errorf("dwg: system page at %#x has type %#08x, expected %#08x",
			addr, pageType, wantType)
	}
	if decompLen > maxSectionBytes {
		return nil, fmt.Errorf("dwg: system page claims %d bytes decompressed, over the %d cap",
			decompLen, maxSectionBytes)
	}
	body := c.take(int(compLen))
	if err := c.Err(); err != nil {
		return nil, err
	}
	if compType == 1 {
		out := make([]byte, len(body))
		copy(out, body)
		return out, nil
	}
	return decompressR2004(body, int(decompLen))
}

// readPageMap turns the global page map into addresses. The map stores
// only sizes; the address of each page is the running total, which is
// why a single bad size desynchronises everything after it.
//
// What it deliberately does not require is that a page *end* inside the
// file. Pages are allocated in whole granules but the file stops after
// the bytes actually written, so a legal drawing routinely declares a
// final page running past its own EOF: Apartment-1.dwg allocates 0x7c0
// for the page map at 0x5a4a0 and then ends 0x5e1 bytes short of it.
// Every file examined does this except one, so the obvious bounds check
// rejects most real drawings — and rejects them at the very last entry,
// after the whole map has already parsed correctly, which makes it read
// like a corrupt file rather than a wrong rule.
//
// The running total is checked against wantEnd instead — the file
// header's own last-page end. That is an equality rather than a bound,
// so it is strictly stronger: it also catches a desynchronisation in
// the *middle* of the map, which the EOF test never could, because a
// size that is too small leaves every later address inside the file
// while making all of them wrong.
func readPageMap(raw []byte, fileLen int, wantEnd uint64) (map[int32]page, error) {
	pages := make(map[int32]page)
	c := newCursor(raw)
	addr := uint64(r18FirstPage)
	for c.remaining() >= 8 {
		id := c.rsl()
		size := c.rl()
		if err := c.Err(); err != nil {
			return nil, err
		}
		// A page that *starts* past the end has no readable bytes at all,
		// whatever it claims to be, so this direction really is fatal.
		if addr >= uint64(fileLen) {
			return nil, fmt.Errorf("dwg: page %d starts at %#x, past the %#x-byte file",
				id, addr, fileLen)
		}
		if id > 0 {
			pages[id] = page{ID: id, Size: size, Address: addr}
		} else {
			// A negative id marks a gap left by an in-place edit. It
			// still occupies space, so it still advances the address —
			// and it carries four extra tree fields.
			c.take(16)
		}
		addr += uint64(size)
	}
	if err := c.Err(); err != nil {
		return nil, err
	}
	// Zero means the writer did not state it, which no file examined
	// does — but a missing cross-check must cost the read nothing, the
	// same way an absent $INSUNITS costs it only a confirmation.
	if wantEnd != 0 && addr != wantEnd {
		return nil, fmt.Errorf("dwg: page map ends at %#x, file header says %#x", addr, wantEnd)
	}
	return pages, nil
}

// section is a logical, named unit of the file — "AcDb:Header",
// "AcDb:AcDbObjects" — assembled from one or more pages.
type section struct {
	Name        string
	Size        uint64
	MaxPageSize uint32
	Compressed  bool
	Encrypted   bool
	Pages       []sectionPage
}

type sectionPage struct {
	PageID      int32
	CompSize    uint32
	StartOffset uint64
}

// maxSectionBytes caps any single decompressed section. Drawings this
// reader cares about have object sections in the low tens of megabytes;
// the cap exists because every size below is read from the file and a
// crafted one would otherwise be an allocation request.
const maxSectionBytes = 512 << 20

func readSectionMap(raw []byte) ([]section, error) {
	c := newCursor(raw)
	count := c.rl()
	c.seek(0x14) // the four fields between are format constants
	if err := c.Err(); err != nil {
		return nil, err
	}
	if int(count) > c.remaining()/0x20 {
		return nil, fmt.Errorf("dwg: section map claims %d sections in %d bytes", count, c.remaining())
	}

	out := make([]section, 0, count)
	for i := uint32(0); i < count; i++ {
		var s section
		s.Size = c.rll()
		pageCount := c.rl()
		s.MaxPageSize = c.rl()
		_ = c.rl() // unknown
		s.Compressed = c.rl() == 2
		_ = c.rl() // section id
		s.Encrypted = c.rl() == 1
		s.Name = c.fixedString(64)
		if err := c.Err(); err != nil {
			return nil, err
		}
		if s.Size > maxSectionBytes {
			return nil, fmt.Errorf("dwg: section %q claims %d bytes, over the %d cap",
				s.Name, s.Size, maxSectionBytes)
		}
		if int(pageCount) > c.remaining()/16 {
			return nil, fmt.Errorf("dwg: section %q claims %d pages in %d bytes",
				s.Name, pageCount, c.remaining())
		}
		s.Pages = make([]sectionPage, pageCount)
		for j := range s.Pages {
			s.Pages[j] = sectionPage{
				PageID:      c.rsl(),
				CompSize:    c.rl(),
				StartOffset: c.rll(),
			}
		}
		if err := c.Err(); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// r18File is a parsed container: enough to hand out any section by name.
type r18File struct {
	data     []byte
	pages    map[int32]page
	sections map[string]section
}

func openR18(data []byte) (*r18File, error) {
	h, err := readR18FileHeader(data)
	if err != nil {
		return nil, err
	}

	rawPageMap, err := systemPage(data, h.SectionPageMapAddress+r18FirstPage, pageTypeSectionPageMap)
	if err != nil {
		return nil, fmt.Errorf("dwg: page map: %w", err)
	}
	pages, err := readPageMap(rawPageMap, len(data), h.LastPageEndAddress+r18FirstPage)
	if err != nil {
		return nil, err
	}

	mapPage, ok := pages[int32(h.SectionMapID)]
	if !ok {
		return nil, fmt.Errorf("dwg: section map page %d is missing from the page map", h.SectionMapID)
	}
	rawSectionMap, err := systemPage(data, mapPage.Address, pageTypeSectionMap)
	if err != nil {
		return nil, fmt.Errorf("dwg: section map: %w", err)
	}
	sections, err := readSectionMap(rawSectionMap)
	if err != nil {
		return nil, err
	}

	f := &r18File{data: data, pages: pages, sections: make(map[string]section, len(sections))}
	for _, s := range sections {
		// The first descriptor is a nameless empty section; skipping it
		// by name keeps the lookup map honest.
		if s.Name == "" {
			continue
		}
		f.sections[s.Name] = s
	}
	return f, nil
}

// sectionNames lists what the file actually contains, in no particular
// order. Used by diagnostics and by the "this DWG has no model space"
// error path, where naming what *was* found is far more useful than
// reporting only what was not.
func (f *r18File) sectionNames() []string {
	out := make([]string, 0, len(f.sections))
	for n := range f.sections {
		out = append(out, n)
	}
	return out
}

// Section assembles a named section from its pages.
//
// The decompressed length of a page is not stored anywhere. It has to be
// inferred from the distance to the next page's start offset, with the
// last page running to the end of the section — which is also what makes
// the format's "zero pages" free here: a page of all zeroes is simply
// omitted from the file, leaving a gap in the offsets that the
// already-zeroed output buffer fills correctly without special handling.
func (f *r18File) Section(name string) ([]byte, error) {
	s, ok := f.sections[name]
	if !ok {
		return nil, fmt.Errorf("dwg: section %q not present", name)
	}

	ordered := append([]sectionPage(nil), s.Pages...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].StartOffset < ordered[j].StartOffset })

	out := make([]byte, s.Size)
	for i, sp := range ordered {
		end := s.Size
		if i+1 < len(ordered) {
			end = ordered[i+1].StartOffset
		}
		if sp.StartOffset > end || end > s.Size {
			return nil, fmt.Errorf("dwg: section %q page %d spans %d..%d of a %d-byte section",
				name, sp.PageID, sp.StartOffset, end, s.Size)
		}
		decompLen := int(end - sp.StartOffset)

		p, ok := f.pages[sp.PageID]
		if !ok {
			return nil, fmt.Errorf("dwg: section %q references missing page %d", name, sp.PageID)
		}
		body, err := f.dataPage(p, sp.CompSize)
		if err != nil {
			return nil, fmt.Errorf("dwg: section %q page %d: %w", name, sp.PageID, err)
		}
		if s.Compressed {
			// The compressor works in fixed blocks of MaxPageSize and
			// pads the tail, so the final page of a section expands to a
			// full block of which only decompLen bytes are live. Passing
			// the live length as the cap makes exactly the last page of
			// every section fail, which is a memorable way to spend an
			// afternoon.
			if body, err = decompressR2004(body, max(decompLen, int(s.MaxPageSize))); err != nil {
				return nil, fmt.Errorf("dwg: section %q page %d: %w", name, sp.PageID, err)
			}
		}
		if len(body) < decompLen {
			return nil, fmt.Errorf("dwg: section %q page %d yielded %d of the %d bytes it must cover",
				name, sp.PageID, len(body), decompLen)
		}
		copy(out[sp.StartOffset:], body[:decompLen])
	}
	return out, nil
}

// dataPage decrypts a data page's header, validates it against what the
// section map claimed, and returns the page's raw body.
//
// The header encryption is a XOR with a mask derived from the page's own
// address, so a page moved without being re-encrypted decodes to
// nonsense — which the page-type check catches.
//
// Note that the specification's field table calls the long at 0x0C "Page
// Size (decompressed)". It is not: measured against real files it is the
// page's footprint in the file — header plus compressed data, rounded up
// to the 0x20 boundary every page starts on — and it agrees exactly with
// the size the page map reports. Trusting the name gives a decompression
// limit slightly larger than the compressed input, so small pages appear
// to expand correctly and large ones fail deep inside the stream.
func (f *r18File) dataPage(p page, wantCompSize uint32) ([]byte, error) {
	if p.Address+dataPageHeaderLen > uint64(len(f.data)) {
		return nil, ErrTruncated
	}
	raw := make([]byte, dataPageHeaderLen)
	copy(raw, f.data[p.Address:p.Address+dataPageHeaderLen])

	mask := uint32(0x4164536B) ^ uint32(p.Address)
	for i := 0; i < dataPageHeaderLen; i += 4 {
		v := binary.LittleEndian.Uint32(raw[i:]) ^ mask
		binary.LittleEndian.PutUint32(raw[i:], v)
	}

	c := newCursor(raw)
	pageType := c.rl()
	_ = c.rl() // section number
	dataSize := c.rl()
	if err := c.Err(); err != nil {
		return nil, err
	}
	if pageType != pageTypeData {
		return nil, fmt.Errorf("dwg: data page at %#x has type %#08x, expected %#08x",
			p.Address, pageType, pageTypeData)
	}
	// The two maps must agree about the compressed length. When they do
	// not, one of them was misparsed, and continuing would decompress
	// whatever bytes happened to follow.
	if dataSize != wantCompSize {
		return nil, fmt.Errorf("dwg: data page at %#x holds %d compressed bytes, section map says %d",
			p.Address, dataSize, wantCompSize)
	}

	start := p.Address + dataPageHeaderLen
	if start+uint64(dataSize) > uint64(len(f.data)) {
		return nil, ErrTruncated
	}
	body := make([]byte, dataSize)
	copy(body, f.data[start:start+uint64(dataSize)])
	return body, nil
}
