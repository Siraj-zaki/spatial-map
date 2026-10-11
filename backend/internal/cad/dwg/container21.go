package dwg

import (
	"encoding/binary"
	"fmt"
	"sort"
	"unicode/utf16"
)

// The R2007 container is the odd one out. R2004 introduced page maps and
// LZ77; R2010 onward went back to it unchanged. R2007 alone sits in
// between with everything re-done: a Reed-Solomon coded file header, a
// second LZ77 dialect, 64-bit sizes throughout, and UTF-16 section names.
//
// The indirection is one step deeper than R2004's, too. The header names
// a page; that page holds the page map; the page map locates the page
// holding the section map; and only then can a section be assembled from
// its pages. Every one of those hops is Reed-Solomon coded and
// conditionally compressed.
//
// Implemented from the Open Design Alliance's specification §5.

const (
	// r21MetaOffset is where the coded file header sits, and r21PageBase
	// is just past it — every offset the header reports is relative to
	// the end of the header rather than to the start of the file.
	r21MetaOffset = 0x80
	r21MetaLen    = 0x400
	r21PageBase   = r21MetaOffset + r21MetaLen

	// r21MetaBlocks is fixed by the format: the header is always coded as
	// three interleaved codewords regardless of how little it holds.
	r21MetaBlocks = 3

	// r21HeaderLen is the size the header always decompresses to.
	r21HeaderLen = 0x110

	crcBlockSize = 8
)

// r21FileHeader is the subset of the 0x110-byte header this reader uses.
// The full structure is mostly CRCs and seeds, which only matter for
// verifying a file we have no intention of repairing.
type r21FileHeader struct {
	FileSize uint64

	PagesMapOffset           uint64
	PagesMapSizeCompressed   uint64
	PagesMapSizeUncompressed uint64
	PagesMapCorrectionFactor uint64
	PagesMaxID               uint64

	SectionsMapID               uint64
	SectionsMapSizeCompressed   uint64
	SectionsMapSizeUncompressed uint64
	SectionsMapCorrectionFactor uint64
	SectionsAmount              uint64
}

// readR21FileHeader decodes the 0x400-byte block at 0x80.
//
// Only the first 3*255 bytes carry the header; the remainder of the block
// is random padding, and the last 0x28 bytes are check values. Decoding
// more than the three codewords would fold that padding into the result.
func readR21FileHeader(data []byte) (r21FileHeader, error) {
	var h r21FileHeader
	if len(data) < r21PageBase {
		return h, fmt.Errorf("%w: file shorter than the R2007 header", ErrTruncated)
	}

	coded := data[r21MetaOffset : r21MetaOffset+r21MetaLen]
	decoded, err := rsStripInterleaved(coded, r21MetaBlocks, rsSystemDataSize)
	if err != nil {
		return h, err
	}

	// 0x00 CRC, 0x08 key, 0x10 payload CRC, 0x18 length, 0x20 payload.
	// The length is signed: negative means the encoder found compression
	// unprofitable and stored the header verbatim.
	const payloadOffset = 0x20
	rawLen := int32(binary.LittleEndian.Uint32(decoded[0x18:]))

	var body []byte
	switch {
	case rawLen < 0:
		n := int(-rawLen)
		if payloadOffset+n > len(decoded) {
			return h, fmt.Errorf("%w: R2007 header payload of %d bytes", ErrTruncated, n)
		}
		body = decoded[payloadOffset : payloadOffset+n]
	case rawLen > 0:
		n := int(rawLen)
		if payloadOffset+n > len(decoded) {
			return h, fmt.Errorf("%w: R2007 header payload of %d bytes", ErrTruncated, n)
		}
		body, err = decompressR21(decoded[payloadOffset:payloadOffset+n], r21HeaderLen)
		if err != nil {
			return h, fmt.Errorf("dwg: R2007 file header: %w", err)
		}
	default:
		return h, fmt.Errorf("dwg: R2007 file header claims zero length")
	}

	if len(body) < r21HeaderLen {
		return h, fmt.Errorf("%w: R2007 header is %d bytes, want %d", ErrTruncated, len(body), r21HeaderLen)
	}

	u := func(off int) uint64 { return binary.LittleEndian.Uint64(body[off:]) }
	h = r21FileHeader{
		FileSize:                    u(0x08),
		PagesMapCorrectionFactor:    u(0x18),
		PagesMapOffset:              u(0x38),
		PagesMapSizeCompressed:      u(0x50),
		PagesMapSizeUncompressed:    u(0x58),
		PagesMaxID:                  u(0x68),
		SectionsAmount:              u(0xA0),
		SectionsMapSizeCompressed:   u(0xB0),
		SectionsMapID:               u(0xC0),
		SectionsMapSizeUncompressed: u(0xC8),
		SectionsMapCorrectionFactor: u(0xD8),
	}
	return h, nil
}

// r21Page is one entry of the page map. A negative ID marks a gap the
// encoder left behind; the entry still occupies address space, which is
// why gaps are kept rather than skipped.
type r21Page struct {
	ID     int64
	Size   uint64
	Offset uint64
}

// loadSysPage reads one of the two maps.
//
// A system page repeats its payload as many times as fits, so that a
// damaged copy can fall back on another. For reading, one copy is enough
// and the repetition only matters because it determines how many
// codewords the page occupies.
func loadSysPage(data []byte, offset, sizeCompressed, sizeUncompressed, repeat uint64) ([]byte, error) {
	if sizeCompressed == 0 || sizeCompressed > maxSectionBytes || sizeUncompressed > maxSectionBytes {
		return nil, fmt.Errorf("dwg: implausible system page (%d compressed, %d uncompressed)",
			sizeCompressed, sizeUncompressed)
	}
	if repeat == 0 {
		repeat = 1
	}

	aligned := (sizeCompressed + crcBlockSize - 1) &^ (crcBlockSize - 1)
	blocks := (aligned*repeat + rsSystemDataSize - 1) / rsSystemDataSize
	if blocks == 0 || blocks > maxSectionBytes/rsCodewordSize {
		return nil, fmt.Errorf("dwg: implausible system page block count %d", blocks)
	}

	start := r21PageBase + offset
	end := start + blocks*rsCodewordSize
	if end > uint64(len(data)) || start > end {
		return nil, fmt.Errorf("%w: system page at %d spans %d bytes of %d",
			ErrTruncated, start, end-start, len(data))
	}

	decoded, err := rsStripInterleaved(data[start:end], int(blocks), rsSystemDataSize)
	if err != nil {
		return nil, err
	}
	payload := decoded[:sizeCompressed]

	if sizeCompressed < sizeUncompressed {
		return decompressR21(payload, int(sizeUncompressed))
	}
	return payload[:sizeUncompressed], nil
}

// readR21PageMap turns the map into addresses. The map stores only sizes;
// each page's offset is the running total of every page before it, which
// is why a gap entry must still be accounted for.
func readR21PageMap(raw []byte, maxID uint64) (map[int64]r21Page, error) {
	pages := make(map[int64]r21Page)
	var offset uint64
	c := newCursor(raw)
	for c.remaining() >= 16 {
		size := c.rll()
		id := int64(c.rll())
		if c.Err() != nil {
			return nil, c.Err()
		}
		index := id
		if index < 0 {
			index = -index
		}
		if maxID != 0 && uint64(index) > maxID {
			return nil, fmt.Errorf("dwg: page id %d exceeds the declared maximum %d", index, maxID)
		}
		pages[index] = r21Page{ID: id, Size: size, Offset: offset}
		offset += size
	}
	if len(pages) == 0 {
		return nil, fmt.Errorf("dwg: R2007 page map is empty")
	}
	return pages, nil
}

// r21Section mirrors r18's section but with the extra per-page detail
// R2007 records. Both a compressed and an uncompressed size are stored
// per page, which removes the guesswork that the R2004 reader needs.
type r21Section struct {
	Name       string
	DataSize   uint64
	MaxSize    uint64
	Encryption uint64
	Encoding   uint64
	Pages      []r21SectionPage
}

type r21SectionPage struct {
	Offset           uint64
	Size             uint64
	PageID           int64
	UncompressedSize uint64
	CompressedSize   uint64
}

func readR21SectionMap(raw []byte) ([]r21Section, error) {
	var out []r21Section
	c := newCursor(raw)

	// The map ends when it runs out, not at a declared count: the header's
	// section total counts an entry that is not in the map.
	for c.remaining() >= 0x40 {
		var s r21Section
		s.DataSize = c.rll()
		s.MaxSize = c.rll()
		s.Encryption = c.rll()
		_ = c.rll() // hash code
		nameLen := c.rll()
		_ = c.rll() // unknown
		s.Encoding = c.rll()
		pageCount := c.rll()
		if c.Err() != nil {
			return nil, c.Err()
		}

		// The name is UTF-16 and its length is in bytes, terminator
		// included — so "AcDb:AppInfoHistory" reports 40, not 19.
		if nameLen%2 != 0 || nameLen > uint64(c.remaining()) {
			return nil, fmt.Errorf("dwg: section name of %d bytes overruns the map", nameLen)
		}
		if nameLen > 0 {
			units := make([]uint16, nameLen/2-1)
			for i := range units {
				units[i] = c.rs()
			}
			s.Name = string(utf16.Decode(units))
			c.take(2) // terminator, present only for a non-empty name
		}

		if pageCount > uint64(c.remaining())/0x38 {
			return nil, fmt.Errorf("dwg: section %q claims %d pages", s.Name, pageCount)
		}
		s.Pages = make([]r21SectionPage, pageCount)
		for i := range s.Pages {
			s.Pages[i] = r21SectionPage{
				Offset:           c.rll(),
				Size:             c.rll(),
				PageID:           int64(c.rll()),
				UncompressedSize: c.rll(),
				CompressedSize:   c.rll(),
			}
			c.rll() // checksum
			c.rll() // crc
		}
		if c.Err() != nil {
			return nil, c.Err()
		}
		out = append(out, s)
	}

	if len(out) == 0 {
		return nil, fmt.Errorf("dwg: R2007 section map is empty")
	}
	return out, nil
}

type r21File struct {
	data     []byte
	pages    map[int64]r21Page
	sections map[string]r21Section
}

func openR21(data []byte) (*r21File, error) {
	h, err := readR21FileHeader(data)
	if err != nil {
		return nil, err
	}
	if h.FileSize != 0 && h.FileSize > uint64(len(data)) {
		return nil, fmt.Errorf("%w: header claims %d bytes, file has %d", ErrTruncated, h.FileSize, len(data))
	}

	rawPages, err := loadSysPage(data, h.PagesMapOffset,
		h.PagesMapSizeCompressed, h.PagesMapSizeUncompressed, h.PagesMapCorrectionFactor)
	if err != nil {
		return nil, fmt.Errorf("dwg: page map: %w", err)
	}
	pages, err := readR21PageMap(rawPages, h.PagesMaxID)
	if err != nil {
		return nil, err
	}

	mapPage, ok := pages[int64(h.SectionsMapID)]
	if !ok {
		return nil, fmt.Errorf("dwg: page map has no page %d for the section map", h.SectionsMapID)
	}
	rawSections, err := loadSysPage(data, mapPage.Offset,
		h.SectionsMapSizeCompressed, h.SectionsMapSizeUncompressed, h.SectionsMapCorrectionFactor)
	if err != nil {
		return nil, fmt.Errorf("dwg: section map: %w", err)
	}
	list, err := readR21SectionMap(rawSections)
	if err != nil {
		return nil, err
	}

	f := &r21File{data: data, pages: pages, sections: make(map[string]r21Section, len(list))}
	for _, s := range list {
		if s.Name != "" {
			f.sections[s.Name] = s
		}
	}
	return f, nil
}

func (f *r21File) sectionNames() []string {
	names := make([]string, 0, len(f.sections))
	for n := range f.sections {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func (f *r21File) Section(name string) ([]byte, error) {
	s, ok := f.sections[name]
	if !ok {
		return nil, fmt.Errorf("dwg: no section %q", name)
	}
	if s.DataSize > maxSectionBytes {
		return nil, fmt.Errorf("dwg: section %q claims %d bytes", name, s.DataSize)
	}

	// Pages that would hold nothing but zeroes are omitted from the file
	// entirely, so the output is allocated whole and written into by
	// offset. Anything no page covers is a gap and is correctly zero.
	out := make([]byte, s.DataSize)
	for _, sp := range s.Pages {
		body, err := f.dataPage(s, sp)
		if err != nil {
			return nil, fmt.Errorf("dwg: section %q page %d: %w", name, sp.PageID, err)
		}
		if sp.Offset > s.DataSize || sp.Offset+uint64(len(body)) > s.DataSize {
			return nil, fmt.Errorf("dwg: section %q page at %d overruns %d bytes",
				name, sp.Offset, s.DataSize)
		}
		copy(out[sp.Offset:], body)
	}
	return out, nil
}

func (f *r21File) dataPage(s r21Section, sp r21SectionPage) ([]byte, error) {
	p, ok := f.pages[sp.PageID]
	if !ok {
		return nil, fmt.Errorf("page %d is not in the page map", sp.PageID)
	}
	if sp.CompressedSize == 0 || sp.CompressedSize > maxSectionBytes ||
		sp.UncompressedSize == 0 || sp.UncompressedSize > maxSectionBytes {
		return nil, fmt.Errorf("implausible page sizes (%d compressed, %d uncompressed)",
			sp.CompressedSize, sp.UncompressedSize)
	}

	aligned := (sp.CompressedSize + crcBlockSize - 1) &^ (crcBlockSize - 1)
	blocks := (aligned + rsDataDataSize - 1) / rsDataDataSize
	start := r21PageBase + p.Offset
	end := start + blocks*rsCodewordSize
	if end > uint64(len(f.data)) || start > end {
		return nil, fmt.Errorf("%w: page spans %d bytes at %d of %d", ErrTruncated, end-start, start, len(f.data))
	}

	// Section encoding 4 interleaves the codewords, 1 lays them out
	// sequentially. With a single codeword the two are the same, so a
	// wrong choice here only shows up on the large sections.
	var decoded []byte
	var err error
	if s.Encoding == 4 {
		decoded, err = rsStripInterleaved(f.data[start:end], int(blocks), rsDataDataSize)
	} else {
		decoded, err = rsStripSequential(f.data[start:end], int(blocks), rsDataDataSize)
	}
	if err != nil {
		return nil, err
	}

	body := decoded[:sp.CompressedSize]
	if sp.CompressedSize < sp.UncompressedSize {
		return decompressR21(body, int(sp.UncompressedSize))
	}
	return body[:sp.UncompressedSize], nil
}
