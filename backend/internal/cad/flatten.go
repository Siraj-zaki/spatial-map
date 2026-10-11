package cad

import (
	"errors"
	"fmt"
	"sort"
)

// Flattening is the step that turns a parsed drawing into geometry.
//
// Model space in a real plan is mostly Insert entities. The doors, the
// windows, the toilets, the desks, the column grid, often the entire
// furniture layout — each is one reference to a block defined once. An
// importer that renders only what model space literally holds produces a
// nearly empty drawing and looks broken, which is the single most common
// way a first-pass CAD importer fails.
//
// Expansion also has to resolve inheritance, because CAD attributes are
// indirect by default. Geometry drawn on layer "0" inside a block takes
// the layer of whatever inserts it; colour and linetype set to ByBlock
// take the insert's. That is what lets one door block appear in the wall
// layer here and the fire-escape layer there. Get it wrong and every
// symbol in the drawing collapses onto layer "0", which destroys the
// layer filtering that makes the import usable in the first place.
//
// And it is a security boundary. Blocks nest, files are uploaded by
// users, and nothing in the format prevents a block from referencing
// itself or an MINSERT from claiming a billion-column array. The caps
// below are not tidiness.

// Errors from Flatten that callers may want to distinguish.
var (
	// ErrTooManyEntities means expansion hit the entity cap. The result
	// is returned alongside it, truncated — a partial drawing is more
	// useful than none, as long as the caller knows it is partial.
	ErrTooManyEntities = errors.New("cad: drawing expands to too many entities")
)

// FlattenOptions tune expansion.
type FlattenOptions struct {
	// MaxEntities caps the flattened result. Zero uses the default.
	MaxEntities int

	// MaxDepth caps block nesting. Zero uses the default. Legitimate
	// drawings nest a handful deep; the cap exists for the ones that
	// nest maliciously.
	MaxDepth int

	// SkipHiddenLayers drops entities whose layer is off or frozen. On by
	// default via DefaultFlattenOptions, because the author already said
	// this content is not wanted.
	SkipHiddenLayers bool

	// LayerFilter, when non-nil, keeps only the layers it approves. This
	// is what backs "import walls and doors, drop the annotation".
	//
	// It is applied after inheritance resolution, so it sees the layer an
	// entity actually ends up on rather than the "0" it was authored on
	// inside its block.
	LayerFilter func(layer string) bool

	// KeepText retains text entities. Off by default: a plan's text is
	// room names, dimensions and general notes sized for a paper sheet,
	// and rendering it onto a map produces illegible clutter at every
	// zoom the user actually works at.
	KeepText bool
}

// DefaultFlattenOptions are the settings a floor-plan import wants.
func DefaultFlattenOptions() FlattenOptions {
	return FlattenOptions{
		MaxEntities:      2_000_000,
		MaxDepth:         32,
		SkipHiddenLayers: true,
	}
}

// FlattenResult is the expanded drawing plus what expansion had to skip.
//
// The skips are reported rather than swallowed because they are the
// explanation for the only complaint a CAD import ever gets: "things are
// missing". An unresolved xref or a truncated array is a sentence the UI
// can show, instead of the user comparing two screens and guessing.
type FlattenResult struct {
	Entities []Entity

	// MissingBlocks are block names referenced by an insert but not
	// defined in the file.
	MissingBlocks []string
	// MissingXrefs are external references whose file we do not have.
	MissingXrefs []string
	// Truncated is set when a cap stopped expansion early.
	Truncated bool
	// SkippedCycles counts self-referencing block chains that were cut.
	SkippedCycles int
}

// Flatten resolves every block reference into world-space geometry.
//
// The returned entities are clones — the document is left untouched, so
// a caller can flatten twice with different layer filters without
// reparsing.
func (d *Document) Flatten(opts FlattenOptions) (FlattenResult, error) {
	def := DefaultFlattenOptions()
	if opts.MaxEntities <= 0 {
		opts.MaxEntities = def.MaxEntities
	}
	if opts.MaxDepth <= 0 {
		opts.MaxDepth = def.MaxDepth
	}

	f := &flattener{
		doc:     d,
		opts:    opts,
		active:  make(map[string]bool),
		missing: make(map[string]bool),
		xrefs:   make(map[string]bool),
	}
	f.walk(d.Entities, Identity(), inherited{layer: "0"}, 0)

	res := FlattenResult{
		Entities:      f.out,
		MissingBlocks: sortedKeys(f.missing),
		MissingXrefs:  sortedKeys(f.xrefs),
		Truncated:     f.truncated,
		SkippedCycles: f.cycles,
	}
	if f.truncated {
		return res, fmt.Errorf("%w: stopped at %d", ErrTooManyEntities, opts.MaxEntities)
	}
	return res, nil
}

// inherited carries the attributes a block's contents fall back to.
type inherited struct {
	layer     string
	color     Color
	linetype  string
	lineWidth float64
}

type flattener struct {
	doc  *Document
	opts FlattenOptions

	out       []Entity
	active    map[string]bool // block names currently being expanded
	missing   map[string]bool
	xrefs     map[string]bool
	truncated bool
	cycles    int
}

func (f *flattener) walk(entities []Entity, m Matrix, inh inherited, depth int) {
	for _, e := range entities {
		if f.truncated {
			return
		}
		if ins, ok := e.(*Insert); ok {
			f.expand(ins, m, inh, depth)
			continue
		}
		f.emit(e, m, inh)
	}
}

func (f *flattener) expand(ins *Insert, m Matrix, inh inherited, depth int) {
	if depth >= f.opts.MaxDepth {
		f.cycles++
		return
	}
	block := f.doc.Block(ins.BlockName)
	if block == nil {
		f.missing[ins.BlockName] = true
		return
	}
	if block.External {
		name := block.ExternalPath
		if name == "" {
			name = block.Name
		}
		f.xrefs[name] = true
		return
	}
	if block.Layout {
		return
	}
	// A block that (transitively) inserts itself would otherwise recurse
	// until the depth cap, silently multiplying entity count by the
	// branching factor at every level. Cutting at the cycle is both
	// cheaper and more honest.
	if f.active[block.Name] {
		f.cycles++
		return
	}
	f.active[block.Name] = true
	defer delete(f.active, block.Name)

	// Attributes the block's contents inherit from this reference.
	child := inherited{
		layer:     resolveLayer(ins.Layer, inh.layer),
		color:     resolveColor(ins.Color, inh.color),
		linetype:  resolveLinetype(ins.Linetype, inh.linetype),
		lineWidth: resolveWidth(ins.LineWeightMM, inh.lineWidth),
	}

	// The insert's own transform, built in its object coordinate system.
	// Position, rotation and scale are all expressed in OCS, so the OCS
	// change of basis wraps the whole thing rather than composing after
	// it.
	local := Translation(ins.Position).
		Mul(RotationZ(ins.Rotation)).
		Mul(Scaling(normalizeScale(ins.Scale))).
		Mul(Translation(block.Base.Mul(-1)))
	if !ins.Extrusion.IsZAxis() && ins.Extrusion.Length() > 0 {
		local = ArbitraryAxis(ins.Extrusion).Mul(local)
	}
	base := m.Mul(local)

	cols, rows := ins.ColumnCount, ins.RowCount
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}
	// An MINSERT array multiplies the block's entity count. Bounding the
	// array by what is left of the budget stops a 65535×65535 header
	// value from being expanded before the per-entity cap can notice.
	if remaining := f.opts.MaxEntities - len(f.out); remaining <= 0 {
		f.truncated = true
		return
	} else if cols*rows > remaining {
		f.truncated = true
		if cols > remaining {
			cols = remaining
		}
		rows = 1
	}

	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			// Array offsets are in the block's own space, so they go
			// inside the insert transform.
			step := base
			if c != 0 || r != 0 {
				step = base.Mul(Translation(Vec3{
					X: float64(c) * ins.ColumnSpacing,
					Y: float64(r) * ins.RowSpacing,
				}))
			}
			f.walk(block.Entities, step, child, depth+1)
			if f.truncated {
				return
			}
		}
	}
}

func (f *flattener) emit(e Entity, m Matrix, inh inherited) {
	if len(f.out) >= f.opts.MaxEntities {
		f.truncated = true
		return
	}
	src := e.Base()
	if src.Invisible {
		return
	}
	if !f.opts.KeepText && e.Kind() == KindText {
		return
	}

	layer := resolveLayer(src.Layer, inh.layer)
	if f.opts.SkipHiddenLayers && !f.doc.Layer(layer).Visible() {
		return
	}
	if f.opts.LayerFilter != nil && !f.opts.LayerFilter(layer) {
		return
	}

	// The entity's own coordinates are in its object coordinate system,
	// so that change of basis has to run before the world transform. It
	// is the identity for anything authored flat, which is nearly
	// everything — and then only shows up on mirrored content, where
	// skipping it lands the geometry reflected about the wrong axis.
	em := m
	if !src.Extrusion.IsZAxis() && src.Extrusion.Length() > 0 {
		em = m.Mul(ArbitraryAxis(src.Extrusion))
	}

	clone := transform(e, em)
	if clone == nil {
		return
	}
	b := clone.Base()
	b.Layer = layer
	b.Color = resolveColor(src.Color, inh.color)
	b.Linetype = resolveLinetype(src.Linetype, inh.linetype)
	b.LineWeightMM = resolveWidth(src.LineWeightMM, inh.lineWidth)
	// Everything is in world space now, so any OCS the entity carried has
	// been consumed by the transform. Leaving a stale extrusion behind
	// would make a second pass apply it twice.
	b.Extrusion = ZAxis

	f.out = append(f.out, clone)
}

// resolveLayer implements the rule that geometry authored on layer "0"
// inside a block adopts the layer of the reference that placed it.
// Anything on a named layer keeps that layer wherever it is inserted.
func resolveLayer(own, parent string) string {
	if own == "" || own == "0" {
		if parent != "" {
			return parent
		}
		return "0"
	}
	return own
}

func resolveColor(own, parent Color) Color {
	if own.ByBlock() && (parent.HasRGB || parent.Index != ColorByBlock) {
		return parent
	}
	return own
}

func resolveLinetype(own, parent string) string {
	if own == "" || own == "BYBLOCK" {
		return parent
	}
	return own
}

func resolveWidth(own, parent float64) float64 {
	if own == LineWeightByBlock {
		return parent
	}
	return own
}

// normalizeScale replaces a zero scale component with 1.
//
// Zero is not a legal scale but it does appear in files, and honouring
// it collapses the block to a line or a point — geometry that vanishes
// rather than geometry that looks wrong, which is much harder to
// diagnose from a screenshot.
func normalizeScale(s Vec3) Vec3 {
	if s.X == 0 {
		s.X = 1
	}
	if s.Y == 0 {
		s.Y = 1
	}
	if s.Z == 0 {
		s.Z = 1
	}
	return s
}

func sortedKeys(m map[string]bool) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
