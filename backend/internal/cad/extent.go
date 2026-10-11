package cad

import "math"

// A drawing's extent and its building's extent are not the same thing.
//
// Every plan accumulates debris over its life: a stray click at the
// origin, a construction line left behind by a delete, a block exploded
// somewhere off the sheet. None of it draws anything a reader would
// notice, and all of it counts towards a min/max. A hotel plan here
// measures 974 m across because ten entities out of 150,878 sit ~850 m
// from a building that is 122 m wide.
//
// The obvious cost is a bad placement — the map sizes an import by its
// reported extent, so an eightfold inflation puts the building at an
// eighth of its size, and a raster of that extent spends its texture
// budget on empty paper. The expensive cost is upstream of that.
// ResolveUnits judges a declared unit by whether it implies an extent a
// building could have, and it is handed exactly this number: a
// restaurant here is ~40 units of real geometry, which is implausible in
// inches and would have been overridden, but debris reports it as 684
// units, which is a plausible 17 m, so the check passes and the whole
// drawing is scaled wrong. Debris does not merely widen the answer, it
// changes the units — so this has to run before units are resolved, and
// it has to remove the entities rather than just measure around them.
//
// Discarding geometry is not free, though — a cropped site boundary or a
// dropped outbuilding is a worse error than a loose extent, because it is
// silent and the user cannot see what went missing. So this does not hunt
// for outliers to remove. It finds the drawing and then gives back
// everything attached to it:
//
//   - The core is the narrowest window holding all but planOutlierFraction
//     of the entities. Being a quantile it cannot be moved by a far-flung
//     speck at all, which is the whole reason to start from mass rather
//     than from extremes.
//   - Then it grows outward across every gap narrower than what it has
//     already kept, and keeps growing on what it just admitted.
//
// The growth step is what makes it safe. Real linework is near-continuous
// at building scale, so a second wing, a site boundary or a detached
// outbuilding chains back in one hop at a time. Debris does not: it sits
// past a gap many times the width of anything it could belong to, and
// there is nothing in between for it to chain through.

const (
	// planBins is the resolution gaps are measured at. It only has to be
	// fine enough to see one: too coarse and a cluster merges with the
	// body it should have been separated from, which keeps geometry
	// rather than losing it.
	planBins = 4096

	// planOutlierFraction is the share of entities the core is allowed to
	// leave out. It decides where growth starts, not what survives, so it
	// only has to be above the debris a drawing can accumulate: a
	// restaurant here carries an off-sheet furniture legend that is 0.70%
	// of its entities, and a tighter bound forces the core to span the
	// whole sheet and trims nothing at all. Anything real that lands
	// outside it is re-admitted by the growth step regardless.
	planOutlierFraction = 0.02
)

// TrimOutliers removes entities that are detached from the drawing, and
// reports how many it dropped.
//
// Entities are weighted one apiece, at the centre of their own box. Ink
// length would be the intuitive weight and is the wrong one twice over: a
// tessellated door swing carries hundreds of points across a few
// centimetres while a 15 m wall carries two, and a single forgotten
// construction line can outweigh a room. "How many things are here" is
// the question being asked, so counting things is the answer.
//
// Judging an entity by its centre rather than its box is what stops one
// line reaching from the origin to the building from bridging the gap it
// is the only thing inside. It also decides the filter: a wall whose
// middle is in the drawing stays whole even where it runs past the edge,
// so the surviving extent can be wider than the window that chose it.
// That is the safe direction — this may keep more than the core, never
// clip something it kept.
func TrimOutliers(entities []Entity) ([]Entity, int) {
	if len(entities) == 0 {
		return entities, 0
	}

	cx := make([]float64, len(entities))
	cy := make([]float64, len(entities))
	var full BBox
	for i, e := range entities {
		b := EntityBounds(e)
		if !b.Valid {
			// Nothing to place, so it can neither vote nor be dropped for
			// where it is.
			cx[i], cy[i] = math.NaN(), math.NaN()
			continue
		}
		cx[i] = (b.Min.X + b.Max.X) / 2
		cy[i] = (b.Min.Y + b.Max.Y) / 2
		full = full.Union(b)
	}
	if !full.Valid {
		return entities, 0
	}

	// X first, then Y over what X kept: debris dismissed on one axis must
	// not go on voting about the other, or a single far corner defends
	// its own row after its column has already been discarded.
	xLo, xHi := planTrimAxis(cx, nil, full.Min.X, full.Max.X)
	inX := make([]bool, len(entities))
	for i, v := range cx {
		inX[i] = v >= xLo && v <= xHi
	}
	yLo, yHi := planTrimAxis(cy, inX, full.Min.Y, full.Max.Y)

	kept := make([]Entity, 0, len(entities))
	for i, e := range entities {
		if inX[i] && cy[i] >= yLo && cy[i] <= yHi {
			kept = append(kept, e)
			continue
		}
		if math.IsNaN(cx[i]) {
			kept = append(kept, e)
		}
	}
	if len(kept) == len(entities) {
		return entities, 0
	}
	return kept, len(entities) - len(kept)
}

// PlanBounds is the extent of the geometry a drawing is about: Bounds
// with detached debris discarded. Prefer TrimOutliers where the entities
// themselves go on to be drawn — a box the debris is outside of does not
// stop the debris being rendered.
func PlanBounds(entities []Entity) BBox {
	kept, _ := TrimOutliers(entities)
	return Bounds(kept)
}

// planCluster is a run of occupied bins and the number of entities in it.
type planCluster struct{ lo, hi, n int }

// planTrimAxis returns the sub-range of [lo, hi] the drawing occupies,
// counting only entities the gate admits. A nil gate admits every one.
func planTrimAxis(centres []float64, gate []bool, lo, hi float64) (float64, float64) {
	if !(hi > lo) {
		return lo, hi
	}
	width := (hi - lo) / planBins

	var counts [planBins]int
	total := 0
	for i, v := range centres {
		if math.IsNaN(v) || (gate != nil && !gate[i]) {
			continue
		}
		counts[min(max(int((v-lo)/width), 0), planBins-1)]++
		total++
	}
	if total == 0 {
		return lo, hi
	}

	var cs []planCluster
	for i := 0; i < planBins; {
		if counts[i] == 0 {
			i++
			continue
		}
		j, n := i, 0
		for j < planBins && counts[j] > 0 {
			n += counts[j]
			j++
		}
		cs = append(cs, planCluster{lo: i, hi: j - 1, n: n})
		i = j
	}
	// One cluster is a drawing with nothing detached from it. There is no
	// gap to judge and nothing to discard.
	if len(cs) < 2 {
		return lo, hi
	}

	coreLo, coreHi := planCore(&counts, total)

	// Start from the clusters the core touches. A window is free to cut
	// through the middle of one — it is drawn at a quantile, not at a
	// gap — and half a cluster is never the intended answer.
	first, last := 0, len(cs)-1
	for i, c := range cs {
		if c.hi >= coreLo {
			first = i
			break
		}
	}
	for i := len(cs) - 1; i >= 0; i-- {
		if cs[i].lo <= coreHi {
			last = i
			break
		}
	}

	for {
		span := cs[last].hi - cs[first].lo + 1
		switch {
		case first > 0 && cs[first].lo-cs[first-1].hi-1 <= span:
			first--
		case last < len(cs)-1 && cs[last+1].lo-cs[last].hi-1 <= span:
			last++
		default:
			return lo + float64(cs[first].lo)*width, lo + float64(cs[last].hi+1)*width
		}
	}
}

// planCore is the narrowest run of bins holding all but
// planOutlierFraction of the entities.
func planCore(counts *[planBins]int, total int) (int, int) {
	need := max(total-int(float64(total)*planOutlierFraction), 1)

	best, bestLo, bestHi := planBins+1, 0, planBins-1
	sum, lo := 0, 0
	for hi := range planBins {
		sum += counts[hi]
		// Shrink from the left while the window can spare its first bin.
		for sum-counts[lo] >= need {
			sum -= counts[lo]
			lo++
		}
		if sum >= need && hi-lo < best {
			best, bestLo, bestHi = hi-lo, lo, hi
		}
	}
	return bestLo, bestHi
}
