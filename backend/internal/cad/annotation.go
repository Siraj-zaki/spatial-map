package cad

import "strings"

// A layer is the only statement of *intent* a CAD file makes.
//
// Geometry alone cannot tell a wall from a shelf: both are two parallel
// lines. What separates them is that the author drew one on A-WALL and
// the other on A2-EQUIP2, because that is how a draughtsman organises a
// drawing and has been since layers existed.
//
// The one question worth asking of a name here is whether the layer
// describes the *building* or the *drawing*. A construction sheet carries
// dimension runs, hatch patterns, revision clouds, a title block and a
// border, and rendering all of it produces a plan buried in the paper it
// was plotted on — which is the opposite of what an importer, or anything
// reading the rendered image afterwards, needs to see.
//
// The answer is deliberately a guess. Layer naming has a standard (the
// AIA's) that a good half of real drawings follow loosely and the rest
// ignore entirely — one fixture here names its walls "Muro1" and another
// "A2-WALL" — so anything derived from the name is a starting position
// for a human, never a decision. It only chooses which boxes the import
// dialog opens ticked, and every one of them can be ticked back on.

// annotationTokens mark layers whose content describes the drawing rather
// than the building, checked against a normalised layer name.
//
// Substring matching rather than the AIA's positional field parsing,
// because the fixtures show the positional reading failing on the
// majority of real files: "A2-WALL" has the discipline and major group
// fused, "Muro1" has no fields at all, and "CEILINGDRAWERS" is one word.
// A substring test degrades to "not annotation" on those — the safe
// direction, since the layer is then drawn and the user can see it.
var annotationTokens = []string{
	"DEFPOINTS", // AutoCAD's own non-plotting construction layer
	"DIM",
	"ANNO",
	"TEXT",
	"TXT",
	"NOTE",
	"LABEL",
	// A layer named for names carries the room captions, not the rooms.
	"NAME",
	"IDEN", // AIA: identification tags
	"PATT", // AIA: hatch patterns
	"HATCH",
	"TTLB", // AIA: title block
	"TITLE",
	"LEGEND",
	"NPLT", // AIA: non-plotting
	"VPORT",
	"VIEWPORT",
	// The CAD sense: A-GRID is the structural column grid, which is
	// reference lines with bubbles on the ends — annotation, not racking.
	"GRID",
	"SYMB",
	"REVISION",
	"REVCLD",
	"SCHED",
}

// IsAnnotationLayer reports whether a layer describes the drawing rather
// than the building, and so is better left out of the rendered sheet.
func IsAnnotationLayer(layer string) bool {
	name := normalizeLayerName(layer)
	if name == "" {
		return false
	}
	for _, tok := range annotationTokens {
		if strings.Contains(name, tok) {
			return true
		}
	}
	return false
}

// normalizeLayerName upper-cases and strips the separators layer names
// are built from, so "A-WALL", "A2_WALL" and "a2 wall" all reduce to a
// string the tokens can be found in.
//
// Accented characters are folded to their base letter for the handful
// that appear in the vocabulary: a German drawing writes "TÜR", and a
// token list that only knows "TUER" would miss every door in it.
func normalizeLayerName(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToUpper(s) {
		switch r {
		case 'Ü':
			b.WriteString("UE")
		case 'Ö':
			b.WriteString("OE")
		case 'Ä':
			b.WriteString("AE")
		case 'É', 'È', 'Ê':
			b.WriteByte('E')
		case 'Á', 'À', 'Â':
			b.WriteByte('A')
		case 'Í', 'Ì', 'Î':
			b.WriteByte('I')
		case 'Ó', 'Ò', 'Ô':
			b.WriteByte('O')
		case 'Ú', 'Ù', 'Û':
			b.WriteByte('U')
		case 'Ñ':
			b.WriteByte('N')
		default:
			if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}
