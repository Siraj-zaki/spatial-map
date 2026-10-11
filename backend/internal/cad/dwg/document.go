package dwg

import (
	"errors"
	"fmt"
	"strconv"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
)

// ErrNoGeometry means the file was read but held nothing drawable.
//
// Reported rather than returned as an empty document, because the two
// causes look identical to the caller and neither is a success: the
// drawing may genuinely be empty, or it may be made entirely of a type
// this reader does not decode yet. An empty result would be presented to
// the user as an import that worked and produced nothing.
var ErrNoGeometry = errors.New("dwg: no drawable geometry")

// maxOwnerHops bounds the walk from an entity to the block it is drawn
// in. Real nesting is one hop — an attribute on an insert — but the
// handles come from the file, so a drawing can name a cycle for free.
const maxOwnerHops = 32

// Read parses a DWG into the format-agnostic drawing model.
//
// This is the whole package's only exported entry point, and everything
// below it exists to make this one function honest: the container
// readers to get at the sections, the object map to find the objects,
// the bit reader to take them apart, and the assertions throughout to
// refuse a result that decoded into plausible numbers from the wrong
// bits.
//
// It is strict. An object it claims to understand but cannot decode
// fails the whole read rather than being skipped, because a CAD import
// that silently drops geometry is worse than one that refuses: the user
// can act on a refusal and cannot act on an absence they never see. An
// object it does not claim to understand is skipped without comment —
// a drawing is mostly bookkeeping, and most of it is not geometry.
func Read(data []byte) (*cad.Document, error) {
	f, err := open(data)
	if err != nil {
		return nil, err
	}
	objects, err := f.sections.Section("AcDb:AcDbObjects")
	if err != nil {
		return nil, err
	}
	handles, err := f.sections.Section("AcDb:Handles")
	if err != nil {
		return nil, err
	}
	refs, err := readObjectMap(handles, len(objects))
	if err != nil {
		return nil, err
	}

	doc := cad.NewDocument()
	doc.Header.Version = string(f.Version)
	readUnits(f, doc)

	// Three things an entity needs can appear after it: the layer table
	// that gives its layer a name, the VERTEX objects a polyline is made
	// of, and the block header that gives an insert's block a name and
	// says whether the entity itself belongs to the drawing or to a
	// definition. All are therefore deferred to a second pass over what
	// the first collected, rather than decoding every object twice to find
	// them. Collecting is cheap — a few handles per entity, a point per
	// vertex.
	type placed struct {
		entity   cad.Entity
		layer    uint64
		owner    uint64
		entMode  uint64
		block    uint64
		hasBlock bool
		children []uint64
	}
	var placedEntities []placed
	placedBy := make(map[uint64]int)
	layerNames := make(map[uint64]string)
	vertices := make(map[uint64]cad.Vertex)
	blocks := make(map[uint64]*cad.Block)
	var blockOrder []uint64

	for _, ref := range refs {
		o, err := readObject(objects, ref, f.Version)
		if err != nil {
			return nil, err
		}
		switch o.Type {
		case typeLayer:
			l, _, err := readLayer(o)
			if err != nil {
				return nil, err
			}
			doc.AddLayer(l)
			layerNames[o.Handle] = l.Name
			continue
		case typeBlockHeader:
			blk, _, err := readBlockHeader(o)
			if err != nil {
				return nil, err
			}
			blocks[o.Handle] = blk
			blockOrder = append(blockOrder, o.Handle)
			continue
		}
		p, err := readEntity(o)
		if err != nil {
			return nil, err
		}
		if p.Vertex != nil {
			vertices[o.Handle] = *p.Vertex
			continue
		}
		if p.Entity == nil {
			continue
		}
		children := make([]uint64, len(p.Refs.Children))
		for i, h := range p.Refs.Children {
			children[i] = h.resolve(o.Handle)
		}
		placedBy[o.Handle] = len(placedEntities)
		placedEntities = append(placedEntities, placed{
			entity:   p.Entity,
			layer:    p.Refs.Layer.resolve(o.Handle),
			owner:    p.Refs.Owner.resolve(o.Handle),
			entMode:  p.Refs.EntMode,
			block:    p.Refs.Block.resolve(o.Handle),
			hasBlock: p.Refs.HasBlock,
			children: children,
		})
	}

	// Model space is a block header like any other, but its contents are
	// the drawing rather than a symbol, so it is the one record that does
	// not become a block. Everything else is registered — including the
	// layouts and the xrefs, which are kept precisely so that flattening
	// can say what it declined to draw and why.
	//
	// Registration is by name, and a DWG's anonymous definitions are not
	// individually named: it stores them under a bare prefix, so one
	// mezzanine plan here holds 875 BLOCK_HEADERs all called "*D", one per
	// dimension. The number a CAD application shows beside them is its
	// own. Registered as they stand, 874 of those are silently redefined
	// as a copy of whichever arrived last — and because the source was a
	// map, which one that was differed on every read, so the same drawing
	// converted to a different size each time it was opened. Names are
	// therefore made unique here, walking the object map's order so the
	// result is fixed, and the entity pass below reads its block back by
	// handle before copying the name, so every insert lands on its own
	// definition.
	nextSuffix := make(map[string]int)
	for _, h := range blockOrder {
		blk := blocks[h]
		if isModelSpaceBlock(blk.Name) {
			continue
		}
		blk.Name = uniqueBlockName(blk.Name, doc, nextSuffix)
		doc.AddBlock(blk)
	}

	doc.Entities = make([]cad.Entity, 0, len(placedEntities))
	for _, p := range placedEntities {
		// A layer the table never declared is left empty rather than
		// invented. cad.Document.Layer already treats an unknown name as
		// the default, so a purged layer costs the entity its colour
		// inheritance and nothing else.
		p.entity.Base().Layer = layerNames[p.layer]

		// A vertex named but not found is different, and is refused: it
		// means the chain and the object map disagree, and the polyline
		// that results would be a shape the drawing does not contain —
		// silently missing a corner rather than obviously missing a run.
		if len(p.children) > 0 {
			poly, ok := p.entity.(*cad.Polyline)
			if !ok {
				return nil, malformed("object %#x names vertices but is a %s", p.entity.Base().Handle, p.entity.Kind())
			}
			poly.Vertices = make([]cad.Vertex, 0, len(p.children))
			for _, h := range p.children {
				v, ok := vertices[h]
				if !ok {
					return nil, malformed("polyline %#x names vertex %#x, which the drawing does not contain",
						poly.Handle, h)
				}
				poly.Vertices = append(poly.Vertices, v)
			}
		}

		// An insert whose block is missing is refused for the same reason:
		// the reference is the only trace of that geometry in model space,
		// so keeping it nameless would produce a drawing with a hole in it
		// that nothing downstream could describe.
		if p.hasBlock {
			ins, ok := p.entity.(*cad.Insert)
			if !ok {
				return nil, malformed("object %#x names a block but is a %s", p.entity.Base().Handle, p.entity.Kind())
			}
			blk, ok := blocks[p.block]
			if !ok {
				return nil, malformed("insert %#x places block %#x, which the drawing does not define",
					ins.Handle, p.block)
			}
			ins.BlockName = blk.Name
		}

		// An entity can be owned by another entity rather than by a block:
		// an ATTRIB belongs to the INSERT it labels, the way a VERTEX
		// belongs to its polyline. It is drawn wherever that insert is
		// drawn, so ownership resolves *through* the parent rather than
		// stopping at it. Stopping would put a tag on an insert inside a
		// block definition into model space instead — drawn once, at the
		// definition's own coordinates, rather than once per insertion.
		//
		// Every attribute in every fixture here hangs off an insert that
		// sits directly in model space, so the walk is one hop and the
		// difference is invisible in this corpus. That is the reason to
		// write the rule rather than the reason to skip it: the case it
		// guards against is a drawing we do not have, and it would fail
		// quietly.
		mode, ownerHandle := p.entMode, p.owner
		for hops := 0; mode == entModeOwned && blocks[ownerHandle] == nil; hops++ {
			i, ok := placedBy[ownerHandle]
			if !ok || hops == maxOwnerHops {
				break
			}
			parent := placedEntities[i]
			mode, ownerHandle = parent.entMode, parent.owner
		}

		// Where the entity belongs. Paper space is the sheet the drawing is
		// plotted on — border, title block, viewport frames — and importing
		// it would place a picture of the building beside the building. A
		// block's contents belong to the block, and are drawn only where
		// something inserts them. Everything else is the drawing.
		switch owner := blocks[ownerHandle]; {
		case mode == entModePaper:
		case mode == entModeModel, owner == nil, isModelSpaceBlock(owner.Name):
			doc.Entities = append(doc.Entities, p.entity)
		case owner.Layout:
		default:
			owner.Entities = append(owner.Entities, p.entity)
		}
	}
	if len(doc.Entities) == 0 {
		return nil, fmt.Errorf("%w: %d objects, none of them drawable", ErrNoGeometry, len(refs))
	}
	return doc, nil
}

// uniqueBlockName returns name, or the first "name<n>" the document does
// not already hold — which is what a CAD application displays for the
// anonymous definitions a DWG stores under a shared prefix.
//
// The counter is carried across calls rather than rescanning from 1 each
// time. A drawing is attacker-controlled and a prefix may repeat tens of
// thousands of times, so a per-collision scan would be quadratic in a
// file that costs nothing to produce.
func uniqueBlockName(name string, doc *cad.Document, nextSuffix map[string]int) string {
	if doc.Block(name) == nil {
		return name
	}
	for {
		nextSuffix[name]++
		candidate := name + strconv.Itoa(nextSuffix[name])
		if doc.Block(candidate) == nil {
			return candidate
		}
	}
}

// readUnits fills in what the header section says about scale, and is the
// one part of the read allowed to fail quietly.
//
// Everywhere else a decode failure fails the import, because the
// alternative is geometry the user never learns was dropped. Here the
// alternative is a question the user is already asked: a drawing whose
// $INSUNITS is zero — a large minority of them, AutoCAD's template was
// unitless for years — reaches cad.GuessUnits and then the import UI
// either way. So a header this reader cannot walk costs the user a
// confirmation, not a drawing.
//
// What makes that acceptable rather than merely convenient is that the
// failure is one-sided. readHeaderVars asserts its three streams landed
// exactly before it returns anything, and a wrong walk cannot land — so
// the degraded outcome is "no answer", never "wrong answer", and a wrong
// answer here is the expensive one: it imports the building at a
// thousandth of its size and looks entirely reasonable doing it.
func readUnits(f *file, doc *cad.Document) {
	sec, err := f.sections.Section("AcDb:Header")
	if err != nil {
		return
	}
	hv, err := readHeaderVars(sec, f.Version)
	if err != nil {
		return
	}
	doc.Header.Units = cad.Units(hv.InsUnits)
	doc.Header.ExtMin, doc.Header.ExtMax = hv.ExtMin, hv.ExtMax
	doc.Header.HasExtents = hv.HasExtents

	// $MEASUREMENT is deliberately not set. It is a DXF variable with no
	// counterpart in the DWG header-variable list, so leaving
	// Header.Measurement at zero states the truth — the file did not say —
	// rather than asserting "imperial", which is what zero would mean if
	// this reader had actually looked.
}
