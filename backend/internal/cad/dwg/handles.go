package dwg

import "fmt"

// An object's references live in a separate stream after its data: the
// layer it sits on, the block that owns it, the vertices a polyline
// strings together. Nothing in the drawing model refers to objects by
// handle — a layer is a name, a block is a name — so this stream is the
// step that turns a file's internal wiring into something a reader of
// the model never has to know about.
//
// Implemented from the Open Design Alliance's specification §2.4.5.

// entityRefs is the shared reference block of one entity, decoded.
type entityRefs struct {
	// Owner is the block that contains the entity, present only when the
	// entity names it. The other entity modes encode it instead: the
	// entity belongs to model space or to paper space, which the reader
	// knows without being told.
	Owner    handle
	HasOwner bool

	// EntMode is that encoding, kept because "no owner handle" is two
	// different answers and the difference decides whether the entity is
	// part of the drawing or part of the sheet it is plotted on.
	EntMode uint64

	// Layer is the one reference every entity carries.
	Layer handle

	// Children are the objects an entity strings together, in the order it
	// names them: the vertices of a POLYLINE. Empty for every type that
	// holds its geometry in one object, which is all of them since R13.
	Children []handle

	// Block is the definition an INSERT places. The model names a block by
	// name and the file names it by handle, so this goes through the same
	// deferred resolution the layer does.
	Block    handle
	HasBlock bool
}

// Entity modes. An entity states its owner in one of three ways, and two
// of them cost no handle: belonging to model space or to paper space is
// implied by the mode itself.
const (
	entModeOwned = 0 // the owner handle follows in the handle stream
	entModePaper = 1 // paper space
	entModeModel = 2 // model space
)

// maxReactors caps the reactor list. The count comes from the file and
// reaches a loop, so a corrupt value would otherwise be read as an
// instruction to keep reading until the object ran out.
const maxReactors = 1 << 16

// readEntityRefs decodes the shared reference block, leaving the reader
// on the first type-specific handle.
//
// It seeks rather than continuing: the caller has just finished the
// data, and the two streams are adjacent but not contiguous — the
// strings-present flag sits between them.
func readEntityRefs(o *object, h entityHeader) (entityRefs, error) {
	b := o.data
	b.seekBit(o.dataEnd() + 1)

	r := entityRefs{EntMode: h.entMode}

	// The colour comes first, and out of order: it belongs to a field
	// read near the top of the data, not to the block below. A colour
	// stated as a book entry is a reference to a separate object, and the
	// reference is taken as the colour is read — which is before any of
	// the shared handles. Only one object across the fixtures uses a
	// colour book, and it has no owner and no reactors, so the position
	// is fixed by the specification rather than measured: what the
	// fixture proves is that the handle exists and that the layer follows
	// it.
	if h.colorBook {
		b.h()
	}
	if h.entMode == entModeOwned {
		r.Owner = b.h()
		r.HasOwner = true
	}
	if h.numReactors > maxReactors {
		return r, fmt.Errorf("%w: object %#x claims %d reactors", ErrMalformed, o.Handle, h.numReactors)
	}
	for range h.numReactors {
		b.h()
	}
	if !h.xdicMissing {
		b.h() // extension dictionary
	}

	r.Layer = b.h()

	// The remaining four are present only when the corresponding field in
	// the data said "3", meaning the value is not one of the shorthands
	// the flag itself can express and a real reference is needed.
	if h.linetypeFlag == 3 {
		b.h()
	}
	if o.Version.AtLeast(R2007) && h.material == 3 {
		b.h()
	}
	// The shadow field is a whole byte of enumeration, not a two-bit flag
	// like its neighbours, and only its value 3 costs a handle. Nothing
	// about the name suggests a reference — the other three values are
	// plainly "casts", "receives", "both" — so this is easy to read as a
	// value and leave at that. It is also rare enough to look like it
	// doesn't exist: 16 objects in 139,000 across the fixtures set it, all
	// of them inside block definitions in one drawing.
	if o.Version.AtLeast(R2007) && h.shadow == 3 {
		b.h()
	}
	if h.plotStyle == 3 {
		b.h()
	}
	if o.Version.AtLeast(R2010) {
		for _, present := range h.visualStyle {
			if present {
				b.h()
			}
		}
	}
	return r, b.Err()
}
