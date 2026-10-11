package dwg

import (
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// A drawing does not repeat itself. The four hundred desks in an office
// plan are one desk drawn once and four hundred references to it, and
// model space holds only the references — so a reader that decodes every
// geometry type but skips INSERT opens the file and shows an empty
// floor. Our own fixtures say it more quietly: canteen.dwg contains 750
// of them, and its doors, chairs and fittings are all among them.
//
// The definition and the reference are separate objects and neither is
// useful alone. BLOCK_HEADER is a table record holding the block's name,
// the base point its contents are drawn around, and the list of objects
// that make it up. INSERT is an entity naming a BLOCK_HEADER by handle
// and stating where to put it, at what size and at what angle. This file
// reads both.
//
// It is also where the drawing stops being a flat list. Until now every
// object decoded here belonged to model space by default; a block
// header's contents belong to the block instead, and paper space — the
// plotted sheet, with its title block and its viewport frames — belongs
// to neither and is not the drawing. Sorting the three apart is what
// keeps a border and a scale bar from arriving as if they were part of
// the building.
//
// Implemented from the Open Design Alliance's specification §2.4.5 and
// §2.4.6.

const (
	typeBlock       = 0x04
	typeEndblk      = 0x05
	typeInsert      = 0x07
	typeMinsert     = 0x08
	typeBlockHeader = 0x31
)

// blockMaxOwned caps a block header's owned-object list. Model space is
// a block header like any other and owns the whole drawing through it,
// so this cannot be a small number — our largest fixture is 94,183
// objects. It is a 32-bit field read from an uploaded file and it reaches
// both a loop and a slice, so it still needs a bound.
const blockMaxOwned = 1 << 24

// blockMaxInserts caps the count of references to a block. Same
// reasoning, and the encoding is worse: the count is a run of non-zero
// bytes with no length of its own.
const blockMaxInserts = 1 << 24

// blockMaxPreview caps the saved thumbnail. Skipped rather than kept, but
// the length still decides how far the cursor moves.
const blockMaxPreview = 1 << 26

// readBlockHeader decodes a BLOCK_HEADER record and the entities it
// owns.
//
// It is a table record, not an entity: no graphics preview, no entity
// mode, no colour — the same shape as LAYER and read through the same
// two-stream helper, because R2007 put its name and its xref path in the
// string stream.
func readBlockHeader(o *object) (*cad.Block, []handle, error) {
	s := objectStreams(o)
	b := s.data
	h := readObjectHeader(b, o.Version)

	blk := &cad.Block{Name: s.tv()}
	b.bit() // set on every record in every fixture; xref bookkeeping
	if !o.Version.AtLeast(R2007) {
		// The xref index. R2007 dropped it, not R2004 — a distinction that
		// only an R2004 fixture can make, and that costs two bits ahead of
		// the insert count, whose run-length encoding turns them into a
		// hundred-byte overrun. See docs/dwg-format.md.
		b.bs()
	}
	b.bit() // xref dependent
	b.bit() // anonymous: a name the program invented, like *U3
	b.bit() // has attribute definitions

	// Two flags, one meaning: the geometry is in another file. Attached
	// and overlaid differ in whether a further reference to this drawing
	// carries it along, which is a question for whoever has the other
	// file. Here both mean the same thing — there is nothing to draw and
	// the import has to say so rather than showing a gap.
	isXref := b.bit() == 1
	overlaid := b.bit() == 1
	blk.External = isXref || overlaid

	if o.Version.AtLeast(R2000) {
		b.bit() // loaded, meaningful only for an xref
	}
	var owned uint32
	if o.Version.AtLeast(R2004) {
		owned = b.bl()
	}
	blk.Base.X, blk.Base.Y, blk.Base.Z = b.bd3()
	blk.ExternalPath = s.tv()

	// How many INSERTs name this block, written as a run of non-zero
	// bytes closed by a zero. Only the length of the run is information:
	// it is the number of handles that appear near the end of the handle
	// stream. The bytes themselves are all 1.
	inserts := 0
	for inserts <= blockMaxInserts && b.rc() != 0 {
		inserts++
	}
	if inserts > blockMaxInserts {
		return nil, nil, malformed("BLOCK_HEADER %#x names more than %d inserts", o.Handle, blockMaxInserts)
	}

	s.tv() // block description
	preview := b.bl()
	if preview > blockMaxPreview {
		return nil, nil, malformed("BLOCK_HEADER %#x claims a %d-byte preview", o.Handle, preview)
	}
	b.seekBit(b.bitPos() + int(preview)*8)

	if o.Version.AtLeast(R2007) {
		b.bs()  // insert units
		b.bit() // explodable
		b.rc()  // block scaling
	}

	if err := b.Err(); err != nil {
		return nil, nil, err
	}
	if got, want := b.bitPos(), o.dataStop(); got != want {
		return nil, nil, malformed("BLOCK_HEADER %#x ends at bit %d, data ends at %d (off by %d)",
			o.Handle, got, want, got-want)
	}

	blk.Layout = isLayoutBlock(blk.Name)

	children, err := readBlockHeaderRefs(o, h, owned, inserts)
	if err != nil {
		return nil, nil, err
	}
	if slack := o.totalBits - b.bitPos(); slack >= 8 {
		return nil, nil, malformed("BLOCK_HEADER %#x leaves %d bits of handle stream unread", o.Handle, slack)
	}
	return blk, children, nil
}

// readBlockHeaderRefs consumes the record's handle stream and returns the
// entities it owns.
//
// The owned list is not what routes an entity into its block — an entity
// states its own owner, and that is what document.go goes by. It is read
// because it has to be, to reach the handles after it, and returned
// because two independent statements of the same fact are worth
// comparing: see TestBlockContentsAgreeWithOwners.
func readBlockHeaderRefs(o *object, h objectHeader, owned uint32, inserts int) ([]handle, error) {
	b := o.data
	b.seekBit(o.dataEnd() + 1)

	b.h() // the BLOCK_CONTROL table that owns this record
	if h.numReactors > maxReactors {
		return nil, malformed("BLOCK_HEADER %#x claims %d reactors", o.Handle, h.numReactors)
	}
	for range h.numReactors {
		b.h()
	}
	if !h.xdicMissing {
		b.h() // extension dictionary
	}
	b.h() // a null hard pointer the specification does not name
	b.h() // the BLOCK entity that opens the definition

	var children []handle
	if o.Version.AtLeast(R2004) {
		if owned > blockMaxOwned {
			return nil, malformed("BLOCK_HEADER %#x claims %d owned objects", o.Handle, owned)
		}
		children = make([]handle, 0, owned)
		for range owned {
			children = append(children, b.h())
		}
	} else {
		// Before R2004 the record named only the ends and the entities
		// themselves carried the links between. Untested: no fixture is old
		// enough, which is why the handles are stepped over rather than
		// followed.
		b.h() // first entity
		b.h() // last entity
	}

	b.h() // the ENDBLK entity that closes the definition
	if o.Version.AtLeast(R2000) {
		for range inserts {
			b.h()
		}
		b.h() // layout
	}
	return children, b.Err()
}

// isLayoutBlock reports whether a block header holds a plotted sheet
// rather than a symbol.
//
// The name is what says so. A block header carries a layout handle too,
// but it is present on every record and resolving it would mean decoding
// LAYOUT objects to find that most of them point at nothing. The naming
// is not a convention a user can break: the program reserves the leading
// asterisk, and paper space layouts are numbered from it.
func isLayoutBlock(name string) bool {
	n := strings.ToLower(name)
	return strings.HasPrefix(n, "*paper_space") || strings.HasPrefix(n, "$paper_space")
}

// isModelSpaceBlock reports whether a block header is the drawing itself.
// Its contents are the document's entities rather than a block's, which
// is why it is the one record that does not become a cad.Block.
func isModelSpaceBlock(name string) bool {
	n := strings.ToLower(name)
	return n == "*model_space" || n == "$model_space"
}

// readInsert decodes INSERT and MINSERT, which differ only in a tail.
//
// It returns the number of attributes the reference owns, because that
// count is read here and spent in the handle stream: the ATTRIBs are
// named there, and a reader that did not know how many would take the
// SEQEND after them for one of them.
func readInsert(b *bitReader, v Version, c cad.Common, array bool) (*cad.Insert, int, bool) {
	ins := &cad.Insert{Common: c, Scale: cad.Vec3{X: 1, Y: 1, Z: 1}, ColumnCount: 1, RowCount: 1}
	ins.Position.X, ins.Position.Y, ins.Position.Z = b.bd3()

	if !v.AtLeast(R2000) {
		ins.Scale.X, ins.Scale.Y, ins.Scale.Z = b.bd3()
	} else {
		// Nearly every reference is placed at the size it was drawn, and
		// most of the rest are scaled equally on all three axes, so two
		// bits buy the whole field: what follows is three doubles, two,
		// one, or nothing at all.
		switch b.bb() {
		case 0:
			ins.Scale.X = b.rd()
			ins.Scale.Y = b.dd(ins.Scale.X)
			ins.Scale.Z = b.dd(ins.Scale.X)
		case 1:
			ins.Scale.Y = b.dd(1)
			ins.Scale.Z = b.dd(1)
		case 2:
			ins.Scale.X = b.rd()
			ins.Scale.Y, ins.Scale.Z = ins.Scale.X, ins.Scale.X
		case 3:
			// Unscaled, which the two bits have already said.
		}
	}
	ins.Rotation = b.bd()

	// Written out in full, unlike every other entity's, which spends one
	// bit saying "the usual Z axis" and stops. There is no obvious reason
	// for the difference and the cost is five bits per reference, but the
	// fixtures are unanimous: read as the compressed form, every INSERT in
	// every drawing lands five bits short of its declared end.
	ins.Extrusion.X, ins.Extrusion.Y, ins.Extrusion.Z = b.bd3()

	hasAttribs := b.bit() == 1
	owned := 0
	if hasAttribs && v.AtLeast(R2004) {
		owned = int(b.bl())
	}
	if array {
		// A rectangular array of the same block: warehouse racking, seating,
		// parking bays. The model carries the counts and spacings rather
		// than the expansion, so a 40 × 12 array stays one entity until
		// something asks for its geometry.
		ins.ColumnCount = int(b.bs())
		ins.RowCount = int(b.bs())
		ins.ColumnSpacing = b.bd()
		ins.RowSpacing = b.bd()
	}
	return ins, owned, hasAttribs
}

// insertMaxAttribs caps the owned-attribute list, for the same reason
// polylines cap their vertices: the count is read from one stream and
// spent in another, so nothing about the object bounds it.
const insertMaxAttribs = 1 << 20

// readInsertRefs consumes the type-specific tail of the handle stream:
// the block, then the attributes, then the SEQEND that closes them.
func readInsertRefs(b *bitReader, v Version, owned int, hasAttribs bool) (handle, error) {
	block := b.h()
	if !hasAttribs {
		return block, b.Err()
	}
	if v.AtLeast(R2004) {
		if owned < 0 || owned > insertMaxAttribs {
			return handle{}, malformed("insert claims %d attributes", owned)
		}
		for range owned {
			b.h()
		}
	} else {
		b.h() // first ATTRIB
		b.h() // last ATTRIB
	}
	b.h() // SEQEND
	return block, b.Err()
}

// readBlockName decodes the BLOCK entity, which opens a definition and
// states the name a second time.
//
// Nothing needs the value: the name is already on the block header, and
// the header is where the base point lives too, so a reader could skip
// this type entirely. It is decoded because doing so is nearly free and
// buys an assertion — a BLOCK is the only entity in the fixtures whose
// sole field is a string, so it is the one place the entity landing check
// depends on the string stream having been located correctly.
func readBlockName(o *object) string {
	return objectStreams(o).tv()
}
