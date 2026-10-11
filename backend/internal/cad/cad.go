// Package cad is the format-agnostic drawing model that every CAD
// importer populates.
//
// The split this package exists to enforce: a *reader* (internal/cad/dwg,
// internal/cad/dxf) knows one file format and nothing about warehouses;
// this package knows what a drawing means and nothing about file bytes.
// Everything downstream — unit resolution, block expansion, extents,
// rasterization, GeoJSON conversion — is written once here against this
// model and works for every format we ever add.
//
// Two deliberate normalisations happen at the reader boundary:
//
//   - References are by NAME, not by handle. DWG points at its layers and
//     blocks with 8-byte handles; DXF uses names. Resolving handles is the
//     DWG reader's problem, so the model never carries a format's linking
//     scheme.
//
//   - Geometry stays in the drawing's own units and coordinate system. No
//     reader is allowed to "helpfully" convert to metres, because whether
//     that conversion is even knowable depends on header fields the reader
//     may not have (see units.go). Conversion happens once, explicitly,
//     when the caller has decided what the units are.
//
// What a CAD file gives us that a PDF cannot: real coordinates. A PDF
// records a sheet of paper and we must infer the plot scale (see
// internal/pdfconv/scale.go, where the suggestions are openly ranked
// guesses). A DWG or DXF stores model space at 1:1 in drawing units, and
// usually declares what those units are — so the scale is *known*.
//
// What it still cannot give us is georeferencing. No CRS, no origin, no
// north. Position and rotation on the map remain a human judgement call,
// exactly as they are for PDF.
package cad

// Document is a parsed drawing.
//
// Only model space is represented. Paper-space layouts are plotting
// artefacts — title blocks, viewports, revision tables — and importing
// them would place a picture of a drawing rather than the drawing.
type Document struct {
	Header Header

	// Layers in the order the file declared them. Order is preserved
	// because it is the order users see in the CAD application, and the
	// import UI lets them pick layers by sight.
	Layers []*Layer

	// Blocks are reusable symbol definitions, keyed by name. A drawing of
	// 400 identical desks stores one desk here and 400 Insert entities in
	// Entities — so a reader that ignores blocks reports an almost empty
	// drawing. See Flatten.
	Blocks map[string]*Block

	// Entities is model space in draw order.
	Entities []Entity

	layerIndex map[string]*Layer
}

// NewDocument returns an empty document with its indexes ready.
func NewDocument() *Document {
	return &Document{
		Blocks:     make(map[string]*Block),
		layerIndex: make(map[string]*Layer),
	}
}

// AddLayer registers a layer, replacing any earlier one with the same
// name. Readers call this as they walk the layer table.
func (d *Document) AddLayer(l *Layer) {
	if l == nil || l.Name == "" {
		return
	}
	if d.layerIndex == nil {
		d.layerIndex = make(map[string]*Layer)
	}
	if prev, ok := d.layerIndex[l.Name]; ok {
		for i, existing := range d.Layers {
			if existing == prev {
				d.Layers[i] = l
				break
			}
		}
		d.layerIndex[l.Name] = l
		return
	}
	d.Layers = append(d.Layers, l)
	d.layerIndex[l.Name] = l
}

// AddBlock registers a block definition.
func (d *Document) AddBlock(b *Block) {
	if b == nil || b.Name == "" {
		return
	}
	if d.Blocks == nil {
		d.Blocks = make(map[string]*Block)
	}
	d.Blocks[b.Name] = b
}

// Layer looks a layer up by name, returning nil when it is absent.
//
// Absent is normal, not corrupt: drawings in the wild reference layers
// whose table entry was purged. Callers treat nil as "default layer,
// visible" rather than failing the import.
func (d *Document) Layer(name string) *Layer {
	if d.layerIndex == nil {
		return nil
	}
	return d.layerIndex[name]
}

// Block looks a block definition up by name.
func (d *Document) Block(name string) *Block {
	if d.Blocks == nil {
		return nil
	}
	return d.Blocks[name]
}

// Header carries the drawing-wide settings that decide how the geometry
// should be interpreted.
type Header struct {
	// Version is the format version string the file declared, verbatim
	// ("AC1032", "AC1021", "R2018"). Kept for diagnostics: when an import
	// produces something odd, the first question is always which producer
	// and version wrote it.
	Version string

	// Producer is the application that wrote the file, when it says so.
	Producer string

	// Units is $INSUNITS — the drawing unit one coordinate step
	// represents. Zero (unitless) is common and means we have to guess;
	// see GuessUnits.
	Units Units

	// Measurement is $MEASUREMENT, a coarser imperial/metric flag that
	// survives in files where $INSUNITS was never set. It is a weak
	// signal — it selects a hatch/linetype library, not a unit — but it
	// is better than nothing when Units is Unitless.
	Measurement Measurement

	// ExtMin/ExtMax are $EXTMIN/$EXTMAX, the extents AutoCAD last
	// computed. Present in most files and free to read, but stale
	// whenever geometry was deleted without a regen, so they are a hint
	// rather than the truth. Bounds() recomputes from geometry.
	ExtMin, ExtMax Vec3
	HasExtents     bool
}

// Layer is a drawing layer.
//
// Layers are how CAD users separate walls from furniture from
// dimensioning from the title block, which makes them the single most
// useful thing to expose in an import UI: "give me walls and doors, drop
// the annotation" turns a noisy plan into a usable base layer.
type Layer struct {
	Name  string
	Color Color

	// Off and Frozen both mean "not currently drawn". They differ in CAD
	// (frozen layers are also excluded from regeneration) but for import
	// purposes they are the same signal, and both are worth honouring:
	// the author already told us this content is not wanted.
	Off    bool
	Frozen bool

	// Locked layers are visible but not editable. Irrelevant to import,
	// preserved so the UI can explain what it found.
	Locked bool

	// Plottable is false for layers the author excluded from plots —
	// construction geometry, notes to self, viewport frames. A layer that
	// was never meant to appear on paper is rarely wanted on a map.
	Plottable bool

	LineWeightMM float64
	Linetype     string
}

// Visible reports whether a layer's content should be imported by
// default. A nil layer is visible: see Document.Layer on why absent
// layers are normal.
func (l *Layer) Visible() bool {
	if l == nil {
		return true
	}
	return !l.Off && !l.Frozen
}

// Block is a reusable symbol definition — a door, a desk, a sheet
// border. Its geometry is authored around Base and instantiated by
// Insert entities that scale, rotate and translate it.
type Block struct {
	Name string

	// Base is the block's insertion point in its own coordinate system.
	// It is subtracted before the insert's transform, so a block whose
	// geometry sits far from the origin still lands where the insert
	// says.
	Base Vec3

	Entities []Entity

	// Layout marks a paper-space layout block rather than a real symbol.
	// These are skipped during flattening — they contain the title block
	// and viewport frames, not the drawing.
	Layout bool

	// External marks an xref: a reference to geometry in a *different*
	// file that we do not have. Instances resolve to nothing, and the
	// import should say so rather than silently dropping content the user
	// can see in their CAD application.
	External bool
	// ExternalPath is the referenced file's path as recorded, so the UI
	// can name what is missing.
	ExternalPath string
}

// Color is an entity or layer colour.
//
// CAD colour is indirect by default: an entity is usually "ByLayer",
// the layer holds an AutoCAD Color Index, and the index means a
// different RGB in every viewer. Resolving an index to RGB is a
// rendering decision, not a parsing one, so this type preserves what
// the file said and leaves the palette to the renderer.
type Color struct {
	// Index is the AutoCAD Color Index. 0 is ByBlock, 256 is ByLayer,
	// 1-255 are palette entries.
	Index int16

	// RGB is a 24-bit true colour, valid only when HasRGB is set.
	// Post-R2004 files may carry one instead of an index.
	RGB    uint32
	HasRGB bool
}

// Colour index sentinels.
const (
	ColorByBlock int16 = 0
	ColorByLayer int16 = 256
)

// ByLayer reports whether the colour defers to the entity's layer.
func (c Color) ByLayer() bool { return !c.HasRGB && c.Index == ColorByLayer }

// ByBlock reports whether the colour defers to the containing block
// reference.
func (c Color) ByBlock() bool { return !c.HasRGB && c.Index == ColorByBlock }

// Line weight sentinels, in the same field as a real millimetre width so
// callers have one number to carry.
const (
	LineWeightByLayer  = -1.0
	LineWeightByBlock  = -2.0
	LineWeightDefault  = -3.0
	LineWeightStandard = 0.25 // what "default" resolves to in practice
)
