/**
 * Spatial index + exact per-prism depth test behind the analytic
 * occlusion pass in `marker-occlusion.ts`.
 *
 * The pass asks one question per target per camera move: "does ANY
 * extruded solid sit on the camera→target segment?". The answer is an OR
 * over prisms, so visiting fewer prisms cannot change it as long as every
 * prism that could hit is still visited. At stadium scale (17–32k prisms:
 * one per seat cell, stair tread and wall piece × ~440 markers, labels
 * and doors) a linear scan was ~25 ms of every frame; this index skips
 * every prism the segment provably misses and runs the unchanged per-prism
 * test (`prismHides`) on the rest.
 *
 * Two levels, so an edit rebuilds only what changed:
 *
 *  - **bottom level** — one BVH per source row (the per-row prism array
 *    `buildOccluders` caches), keyed by that array's identity. Dragging
 *    one rack rebuilds that rack's tree; every other row's is reused.
 *  - **top level** — one BVH over the rows' root boxes (a few hundred
 *    items), rebuilt per prism list in well under a millisecond.
 *
 * Exactness. A node is skipped only when (a) every prism under it would
 * fail the `topM <= altitude + tolerance` check — the same `<=` on the
 * subtree's maximum top — or (b) the camera→target segment misses the
 * node's box. A hit needs a point of that segment inside the prism's 3D
 * bounding box, and every box is inflated by `BOX_EPS` (~3.5 cm, ~10^7
 * ulps at Mercator magnitudes) so float error can never cull a true hit.
 * A prism with any non-finite field gets an unbounded box: the linear
 * loop's guards behave differently around NaN, so such a prism is always
 * handed to the exact test rather than reasoned about.
 *
 * Large footprints (the curved bowl walls run to 300–720 vertices) also
 * get y-band edge buckets: the even-odd and crossing tests only read the
 * edges whose y-range can matter, with the per-edge arithmetic unchanged.
 *
 * Holes. A footprint is the outer `ring` plus optional interior `holes`
 * (a closed-loop wall's buffer, a leaning roof's band), read with
 * even-odd parity over every ring: a point in a hole is outside, a
 * segment that stays inside a hole hits nothing, and any outer or hole
 * edge counts as a crossing. Every footprint test here — the per-prism
 * depth test, the y-band buckets (built over all rings), the box bounds,
 * the box query and the pierce span — reads the holes. A prism without
 * holes runs the exact arithmetic it always did, so its verdicts are
 * unchanged bit for bit.
 */

/**
 * One extruded solid reduced to what the depth test needs: a footprint
 * in Mercator x/y plus the altitude band it occupies. Re-exported from
 * `marker-occlusion.ts`, which builds them.
 */
export interface OccluderPrism {
  /** `<kind>:<id>` — diagnostics, and stable across rebuilds. */
  key: string
  /**
   * `images` row id when this prism came from a floor plan. A marker
   * whose `floorPlanId` matches is exempt: that plate is its floor.
   */
  floorPlanId?: number
  /** Bottom of the solid in metres. */
  baseM: number
  /** Top of the solid in metres. Equals `baseM` for a flat occluder. */
  topM: number
  zBottom: number
  zTop: number
  /** Footprint as Mercator x/y, open ring (first point not repeated). */
  ring: ReadonlyArray<readonly [number, number]>
  /**
   * Interior rings (holes) of the footprint: open Mercator rings of at
   * least 3 vertices lying inside `ring`. The footprint is even-odd over
   * `ring` + every hole — a point in a hole is outside. Absent (or empty)
   * for the common one-ring prism.
   */
  holes?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * Occluders whose top face is within this many metres of a marker's own
 * altitude never hide it — the marker is standing ON that surface, not
 * behind it. Without the slop a marker at `elevation: 0` would be hidden
 * by the very floor it belongs to: a slab drawn as a thin polygon sits a
 * few centimetres proud of the ground (an 11 cm minimum base for shapes
 * with a height, 1 cm for flat areas — see `POLYGON_MIN_BASE_M`).
 */
export const SELF_SURFACE_TOLERANCE_M = 0.5

/** Bounding-box inflation in Mercator units (~3.5 cm at the stadium's latitude). */
const BOX_EPS = 1e-9
/** Max prisms per BVH leaf. */
const LEAF_SIZE = 4
/** Footprints with at least this many vertices get y-band edge buckets. */
const RING_ACCEL_MIN_VERTICES = 24
/**
 * |d| below which the segment counts as flat along x/y in the box test.
 * Far below `BOX_EPS`, so the flat interval check stays conservative.
 */
const FLAT_XY = 1e-18
/** Same threshold the per-prism test uses for "camera level with the target". */
const FLAT_Z = 1e-15

// ---------------------------------------------------------------------------
// The exact per-prism test

/**
 * Does `prism` hide the target at Mercator point (px, py) / `altitudeM`
 * from the camera at (cx, cy, cz)? `dx/dy/dz` is target − camera.
 *
 * This is the body of the original linear loop, unchanged — the index
 * only decides which prisms reach it. `accel` (y-band buckets for a big
 * footprint, or null) swaps in bucketed versions of the two ring tests
 * that return bit-identical answers.
 */
export function prismHides(
  prism: OccluderPrism,
  cx: number,
  cy: number,
  cz: number,
  px: number,
  py: number,
  dx: number,
  dy: number,
  dz: number,
  altitudeM: number,
  floorPlanId: number | undefined,
  accel: RingAccel | null,
): boolean {
  if (prism.floorPlanId !== undefined && prism.floorPlanId === floorPlanId) {
    return false
  }
  // Standing on it (or on something above it) — not behind it.
  if (prism.topM <= altitudeM + SELF_SURFACE_TOLERANCE_M) return false

  // Clip the camera→marker segment to the prism's altitude slab.
  let tLo: number
  let tHi: number
  if (Math.abs(dz) < FLAT_Z) {
    // Camera level with the marker: the segment stays at one
    // altitude, so it either lies inside the slab or misses it.
    if (cz < prism.zBottom || cz > prism.zTop) return false
    tLo = 0
    tHi = 1
  } else {
    const ta = (prism.zBottom - cz) / dz
    const tb = (prism.zTop - cz) / dz
    tLo = Math.min(ta, tb)
    tHi = Math.max(ta, tb)
  }
  // Outside (0, 1) the crossing sits behind the eye or past the
  // marker — this is what makes geometry BELOW a marker fall out
  // when looking down at it.
  if (tHi <= 0 || tLo >= 1) return false
  if (tLo < 0) tLo = 0
  if (tHi > 1) tHi = 1

  const ax = cx + tLo * dx
  const ay = cy + tLo * dy
  const bx = cx + tHi * dx
  const by = cy + tHi * dy
  if (Math.max(ax, bx) < prism.minX) return false
  if (Math.min(ax, bx) > prism.maxX) return false
  if (Math.max(ay, by) < prism.minY) return false
  if (Math.min(ay, by) > prism.maxY) return false

  // A marker buried inside a solid is an authoring artifact (e.g.
  // left at elevation 0 on top of a shape extruded from 0). Hiding
  // it would make it blink in and out as the camera orbits, so the
  // solid a marker is embedded in never occludes it.
  //
  // The `>=` on `baseM` is deliberate — v5.4: text labels almost
  // always sit AT floor level (altitude 0) inside rooms whose
  // polygon extrudes UP from 0 (walls). With a strict `>` those
  // labels never satisfied the "embedded" test and every one was
  // hidden by the very room it belongs to. `>=` treats "sitting on
  // the floor of a room" as embedded too, which is what a label /
  // sensor on the floor plan is.
  if (
    altitudeM >= prism.baseM &&
    altitudeM < prism.topM &&
    (accel ? containsPointBanded(accel, px, py) : containsFootprint(prism.ring, prism.holes, px, py))
  ) {
    return false
  }

  return accel
    ? segmentHitsRingBanded(accel, ax, ay, bx, by)
    : segmentHitsFootprint(prism.ring, prism.holes, ax, ay, bx, by)
}

type Ring = ReadonlyArray<readonly [number, number]>
type Holes = ReadonlyArray<Ring> | undefined

/**
 * Does the 2D segment a→b touch the footprint's area? True when either
 * endpoint is inside (even-odd over the ring and its holes), or any edge
 * of any ring is crossed (the segment passes straight through). A segment
 * wholly inside a hole crosses nothing and has no endpoint inside.
 */
function segmentHitsFootprint(
  ring: Ring,
  holes: Holes,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  if (containsFootprint(ring, holes, ax, ay)) return true
  if (containsFootprint(ring, holes, bx, by)) return true
  if (segmentCrossesRing(ring, ax, ay, bx, by)) return true
  if (holes) {
    for (const h of holes) if (segmentCrossesRing(h, ax, ay, bx, by)) return true
  }
  return false
}

function segmentCrossesRing(ring: Ring, ax: number, ay: number, bx: number, by: number): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (
      segmentsCross(ax, ay, bx, by, ring[j][0], ring[j][1], ring[i][0], ring[i][1])
    ) {
      return true
    }
  }
  return false
}

function cross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

/** Strict segment intersection; collinear touching doesn't count. */
function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = cross(ax, ay, bx, by, cx, cy)
  const d2 = cross(ax, ay, bx, by, dx, dy)
  const d3 = cross(cx, cy, dx, dy, ax, ay)
  const d4 = cross(cx, cy, dx, dy, bx, by)
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0
}

/**
 * Even-odd over the outer ring and every hole: parity XOR, so a point in
 * a hole is outside. Without holes this is `containsPoint(ring)` itself.
 */
function containsFootprint(ring: Ring, holes: Holes, x: number, y: number): boolean {
  let inside = containsPoint(ring, x, y)
  if (holes) {
    for (const h of holes) if (containsPoint(h, x, y)) inside = !inside
  }
  return inside
}

/** Even-odd crossing test. The ring is open (no repeated first point). */
function containsPoint(
  ring: ReadonlyArray<readonly [number, number]>,
  x: number,
  y: number,
): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// ---------------------------------------------------------------------------
// Y-band edge buckets for big footprints

/**
 * Edges of one footprint bucketed into horizontal bands. Every ring (the
 * outer one, then each hole) is concatenated into `xs` / `ys`; edge `i`
 * runs vertex `prev[i]` → vertex `i`, where `prev[i]` is the previous
 * vertex of the SAME ring (its last vertex for the ring's first) — the
 * same pairing and orientation as the plain loops. Without holes
 * `prev[i] = i === 0 ? n − 1 : i − 1`, the old arithmetic exactly.
 *
 * Exact by construction: `band(y)` is monotone (subtract, multiply by a
 * positive constant, floor, clamp — each step non-decreasing even under
 * rounding), and each edge is filed in every band from band(minY) to
 * band(maxY). So any edge whose y-range contains `y` is in band(y), and
 * the even-odd parity over that band equals the parity over the whole
 * ring (XOR commutes; each edge's arithmetic is unchanged).
 */
export interface RingAccel {
  /** Total vertices over every ring. */
  n: number
  xs: Float64Array
  ys: Float64Array
  /** Previous vertex index within the same ring. */
  prev: Int32Array
  y0: number
  y1: number
  /** bands / (y1 − y0). */
  inv: number
  /** Band count. */
  bands: number
  /** Band k's edges are `edges[start[k] .. start[k + 1])`. */
  start: Int32Array
  edges: Int32Array
  /** De-dup marks for edges filed in several bands (per crossing query). */
  stamp: Uint32Array
  gen: number
}

/** Total vertex count over the ring and its holes. */
function footprintVertexCount(ring: Ring, holes: Holes): number {
  let n = ring.length
  if (holes) for (const h of holes) n += h.length
  return n
}

/** Buckets for one footprint, or null when it is small or not fully finite. */
function buildRingAccel(ring: Ring, holes: Holes): RingAccel | null {
  const n = footprintVertexCount(ring, holes)
  if (n < RING_ACCEL_MIN_VERTICES) return null
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const prev = new Int32Array(n)
  let y0 = Infinity
  let y1 = -Infinity
  let at = 0
  const rings: Ring[] = [ring]
  if (holes) for (const h of holes) rings.push(h)
  for (const r of rings) {
    const first = at
    const len = r.length
    for (let k = 0; k < len; k++) {
      const x = r[k][0]
      const y = r[k][1]
      // A non-finite vertex makes `band()` meaningless; the plain loops
      // handle it (they never flip on NaN), so leave this footprint to them.
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      xs[at] = x
      ys[at] = y
      prev[at] = k === 0 ? first + len - 1 : at - 1
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      at++
    }
  }
  const bands = Math.max(1, n >> 2)
  const inv = y1 > y0 ? bands / (y1 - y0) : 0
  if (!Number.isFinite(inv)) return null
  const A: RingAccel = {
    n,
    xs,
    ys,
    prev,
    y0,
    y1,
    inv,
    bands,
    start: new Int32Array(bands + 1),
    edges: new Int32Array(0),
    stamp: new Uint32Array(n),
    gen: 0,
  }
  // Two passes: count per band, then fill.
  const counts = A.start
  for (let i = 0; i < n; i++) {
    const j = prev[i]
    const k1 = bandOf(A, Math.max(ys[i], ys[j]))
    for (let k = bandOf(A, Math.min(ys[i], ys[j])); k <= k1; k++) counts[k + 1]++
  }
  for (let k = 0; k < bands; k++) counts[k + 1] += counts[k]
  const edges = new Int32Array(counts[bands])
  const fill = counts.slice(0, bands)
  for (let i = 0; i < n; i++) {
    const j = prev[i]
    const k1 = bandOf(A, Math.max(ys[i], ys[j]))
    for (let k = bandOf(A, Math.min(ys[i], ys[j])); k <= k1; k++) edges[fill[k]++] = i
  }
  A.edges = edges
  return A
}

function bandOf(A: RingAccel, y: number): number {
  const k = Math.floor((y - A.y0) * A.inv)
  // `!(k > 0)` also catches NaN; any band then reads no flips/crossings,
  // exactly like the plain loops on a NaN coordinate.
  if (!(k > 0)) return 0
  return k < A.bands ? k : A.bands - 1
}

/** `containsPoint`, reading only band(y)'s edges. */
function containsPointBanded(A: RingAccel, x: number, y: number): boolean {
  // Outside [y0, y1] no edge can satisfy `yi > y !== yj > y`.
  if (y < A.y0 || y > A.y1) return false
  const k = bandOf(A, y)
  const xs = A.xs
  const ys = A.ys
  const prev = A.prev
  const edges = A.edges
  let inside = false
  for (let e = A.start[k], end = A.start[k + 1]; e < end; e++) {
    const i = edges[e]
    const j = prev[i]
    const xi = xs[i]
    const yi = ys[i]
    const xj = xs[j]
    const yj = ys[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/**
 * `segmentHitsRing`, reading only the edges in the bands the segment's
 * y-range (± `BOX_EPS`) covers. A strict crossing needs the edge's and
 * the segment's y-ranges to overlap; the margin dwarfs rounding.
 */
function segmentHitsRingBanded(
  A: RingAccel,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  if (containsPointBanded(A, ax, ay)) return true
  if (containsPointBanded(A, bx, by)) return true
  const lo = Math.min(ay, by) - BOX_EPS
  const hi = Math.max(ay, by) + BOX_EPS
  if (hi < A.y0 || lo > A.y1) return false
  const k0 = bandOf(A, lo)
  const k1 = bandOf(A, hi)
  const xs = A.xs
  const ys = A.ys
  const prev = A.prev
  const edges = A.edges
  const stamp = A.stamp
  A.gen = (A.gen + 1) >>> 0
  if (A.gen === 0) {
    stamp.fill(0)
    A.gen = 1
  }
  const gen = A.gen
  for (let e = A.start[k0], end = A.start[k1 + 1]; e < end; e++) {
    const i = edges[e]
    if (stamp[i] === gen) continue
    stamp[i] = gen
    const j = prev[i]
    if (segmentsCross(ax, ay, bx, by, xs[j], ys[j], xs[i], ys[i])) return true
  }
  return false
}

/** Buckets are a pure function of the (immutable) footprint, so cache per prism. */
const accelCache = new WeakMap<OccluderPrism, RingAccel | null>()

function accelFor(prism: OccluderPrism): RingAccel | null {
  if (footprintVertexCount(prism.ring, prism.holes) < RING_ACCEL_MIN_VERTICES) return null
  let A = accelCache.get(prism)
  if (A === undefined) {
    A = buildRingAccel(prism.ring, prism.holes)
    accelCache.set(prism, A)
  }
  return A
}

// ---------------------------------------------------------------------------
// BVH

/**
 * Static BVH over axis-aligned boxes. Node `i` owns `nb[7i .. 7i + 7)`:
 * minX, minY, minZ, maxX, maxY, maxZ, then the largest `topM` below it.
 * `count[i] === 0` marks an inner node whose children are `left[i]` and
 * `left[i] + 1`; a leaf's items are `order[start[i] .. start[i] + count[i])`.
 */
interface Bvh {
  nodes: number
  nb: Float64Array
  left: Int32Array
  start: Int32Array
  count: Int32Array
  order: Int32Array
}

/**
 * Median split on the longest centroid axis (quickselect), leaves of at
 * most `LEAF_SIZE`. Any partition is correct — boxes are always recomputed
 * from the items actually under a node — the split only affects speed.
 */
function buildBvh(box: Float64Array, n: number): Bvh {
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  // Every leaf of a tree over n >= 2 items holds >= 2 (a node of >= 5
  // splits into halves of >= 2), so n - 1 nodes suffice; max(1, n) is safe.
  const cap = Math.max(1, n)
  const nb = new Float64Array(cap * 7)
  const left = new Int32Array(cap)
  const start = new Int32Array(cap)
  const count = new Int32Array(cap)
  if (n === 0) return { nodes: 0, nb, left, start, count, order }

  const cent = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 7
    for (let a = 0; a < 3; a++) {
      const c = (box[o + a] + box[o + 3 + a]) * 0.5
      // Unbounded boxes have no meaningful centre; park them at 0 so the
      // quickselect never compares NaN.
      cent[i * 3 + a] = Number.isFinite(c) ? c : 0
    }
  }

  const select = (lo: number, hi: number, k: number, axis: number) => {
    while (hi - lo > 1) {
      const pv = cent[order[(lo + hi) >> 1] * 3 + axis]
      let i = lo
      let j = hi - 1
      while (i <= j) {
        while (cent[order[i] * 3 + axis] < pv) i++
        while (cent[order[j] * 3 + axis] > pv) j--
        if (i <= j) {
          const t = order[i]
          order[i] = order[j]
          order[j] = t
          i++
          j--
        }
      }
      if (k <= j) hi = j + 1
      else if (k >= i) lo = i
      else return
    }
  }

  let nodes = 1
  const work: number[] = [0, 0, n] // (node, lo, hi) triples
  while (work.length > 0) {
    const hi = work.pop()!
    const lo = work.pop()!
    const node = work.pop()!
    let mnX = Infinity, mnY = Infinity, mnZ = Infinity
    let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity
    let top = -Infinity
    let cnX = Infinity, cnY = Infinity, cnZ = Infinity
    let cxX = -Infinity, cxY = -Infinity, cxZ = -Infinity
    for (let i = lo; i < hi; i++) {
      const it = order[i]
      const o = it * 7
      if (box[o] < mnX) mnX = box[o]
      if (box[o + 1] < mnY) mnY = box[o + 1]
      if (box[o + 2] < mnZ) mnZ = box[o + 2]
      if (box[o + 3] > mxX) mxX = box[o + 3]
      if (box[o + 4] > mxY) mxY = box[o + 4]
      if (box[o + 5] > mxZ) mxZ = box[o + 5]
      if (box[o + 6] > top) top = box[o + 6]
      const c = it * 3
      if (cent[c] < cnX) cnX = cent[c]
      if (cent[c] > cxX) cxX = cent[c]
      if (cent[c + 1] < cnY) cnY = cent[c + 1]
      if (cent[c + 1] > cxY) cxY = cent[c + 1]
      if (cent[c + 2] < cnZ) cnZ = cent[c + 2]
      if (cent[c + 2] > cxZ) cxZ = cent[c + 2]
    }
    const o = node * 7
    nb[o] = mnX
    nb[o + 1] = mnY
    nb[o + 2] = mnZ
    nb[o + 3] = mxX
    nb[o + 4] = mxY
    nb[o + 5] = mxZ
    nb[o + 6] = top
    const cnt = hi - lo
    const ex = cxX - cnX
    const ey = cxY - cnY
    const ez = cxZ - cnZ
    if (cnt <= LEAF_SIZE || (ex === 0 && ey === 0 && ez === 0) || nodes + 2 > cap) {
      start[node] = lo
      count[node] = cnt
      continue
    }
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2
    const mid = (lo + hi) >> 1
    select(lo, hi, mid, axis)
    const l = nodes
    nodes += 2
    left[node] = l
    count[node] = 0
    work.push(l, lo, mid, l + 1, mid, hi)
  }
  return { nodes, nb, left, start, count, order }
}

/** One source row's prisms and their tree. */
interface Blas {
  group: ReadonlyArray<OccluderPrism>
  /** `group.length` at build — a guard against in-place mutation. */
  size: number
  bvh: Bvh
  accel: (RingAccel | null)[]
}

/**
 * A prism list's acceleration structure. Opaque to callers: get one with
 * `occluderIndexFor(prisms)` and pass it to `queryOccluder`.
 */
export interface OccluderIndex {
  /** Total prisms indexed (= the list's length at build). */
  readonly size: number
  readonly blases: ReadonlyArray<Blas>
  readonly tlas: Bvh
}

/**
 * Writes `p`'s inflated box + top into `box[o .. o + 7)`.
 *
 * x/y come from the rings themselves, not the prism's stored bbox: a hit
 * needs the segment to reach the footprint (inside it or across an edge),
 * so the extent of every vertex — outer ring and holes — bounds every hit
 * even for a hand-built prism whose bbox disagrees with its rings. Holes
 * lie inside the outer ring, so they never widen a real prism's box.
 * (`buildOccluders` prisms always agree.)
 */
function prismBox(p: OccluderPrism, box: Float64Array, o: number): void {
  const zLo = Math.min(p.zBottom, p.zTop)
  const zHi = Math.max(p.zBottom, p.zTop)
  let finite = Number.isFinite(zLo) && Number.isFinite(zHi) && !Number.isNaN(p.topM)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const rings: Ring[] = [p.ring]
  if (p.holes) for (const h of p.holes) rings.push(h)
  for (let r = 0; r < rings.length && finite; r++) {
    const ring = rings[r]
    for (let i = 0; i < ring.length && finite; i++) {
      const x = ring[i][0]
      const y = ring[i][1]
      // A NaN vertex is skipped by min/max but can still flip the even-odd
      // parity outside the other vertices' extent, so no box bounds it.
      finite = Number.isFinite(x) && Number.isFinite(y)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!finite) {
    // Anything non-finite: never culled, the exact test decides.
    box[o] = box[o + 1] = box[o + 2] = -Infinity
    box[o + 3] = box[o + 4] = box[o + 5] = Infinity
    box[o + 6] = Infinity
    return
  }
  // An empty ring can never hit; its inverted (±Infinity) box adds
  // nothing to its parents' bounds and the exact test rejects it.
  box[o] = minX - BOX_EPS
  box[o + 1] = minY - BOX_EPS
  box[o + 2] = zLo - BOX_EPS
  box[o + 3] = maxX + BOX_EPS
  box[o + 4] = maxY + BOX_EPS
  box[o + 5] = zHi + BOX_EPS
  box[o + 6] = p.topM
}

/** Bottom-level trees, keyed by the per-row prism array they index. */
const blasCache = new WeakMap<ReadonlyArray<OccluderPrism>, Blas>()

function blasFor(group: ReadonlyArray<OccluderPrism>): Blas {
  const hit = blasCache.get(group)
  if (hit && hit.size === group.length) return hit
  const n = group.length
  const box = new Float64Array(n * 7)
  const accel: (RingAccel | null)[] = []
  for (let i = 0; i < n; i++) {
    prismBox(group[i], box, i * 7)
    accel.push(accelFor(group[i]))
  }
  const blas: Blas = { group, size: n, bvh: buildBvh(box, n), accel }
  blasCache.set(group, blas)
  return blas
}

/**
 * Build the two-level index over `groups` (each one source row's prisms).
 * Bottom-level trees are reused for any group array seen before.
 */
export function buildOccluderIndex(
  groups: ReadonlyArray<ReadonlyArray<OccluderPrism>>,
): OccluderIndex {
  const blases: Blas[] = []
  let size = 0
  for (const g of groups) {
    if (g.length === 0) continue
    blases.push(blasFor(g))
    size += g.length
  }
  const box = new Float64Array(blases.length * 7)
  for (let i = 0; i < blases.length; i++) {
    box.set(blases[i].bvh.nb.subarray(0, 7), i * 7)
  }
  return { size, blases, tlas: buildBvh(box, blases.length) }
}

/**
 * How `buildOccluders` assembled each flat list from per-row arrays, so
 * the index can reuse one bottom-level tree per row.
 */
const groupsOfList = new WeakMap<
  ReadonlyArray<OccluderPrism>,
  ReadonlyArray<ReadonlyArray<OccluderPrism>>
>()

/**
 * Record that `prisms` is the in-order concatenation of `groups`. Lists
 * without a record are indexed as one group (correct, just no per-row
 * reuse).
 */
export function registerOccluderGroups(
  prisms: ReadonlyArray<OccluderPrism>,
  groups: ReadonlyArray<ReadonlyArray<OccluderPrism>>,
): void {
  groupsOfList.set(prisms, groups)
}

const indexCache = new WeakMap<ReadonlyArray<OccluderPrism>, OccluderIndex>()

/**
 * The index for a prism list, built on first use and cached by the
 * list's identity — every overlay handed the same list shares one index.
 * Lists are treated as immutable; a length change forces a rebuild.
 */
export function occluderIndexFor(prisms: ReadonlyArray<OccluderPrism>): OccluderIndex {
  const hit = indexCache.get(prisms)
  if (hit && hit.size === prisms.length) return hit
  const groups = groupsOfList.get(prisms)
  let total = 0
  if (groups) for (const g of groups) total += g.length
  const ix = buildOccluderIndex(groups && total === prisms.length ? groups : [prisms])
  indexCache.set(prisms, ix)
  return ix
}

// ---------------------------------------------------------------------------
// Query

/**
 * Segment (camera → target, t ∈ [0, 1]) vs node box, slab method with
 * precomputed reciprocals. A flat axis falls back to an interval check,
 * conservative because boxes are inflated far beyond the flat threshold.
 */
function segmentHitsBox(
  nb: Float64Array,
  o: number,
  ox: number,
  oy: number,
  oz: number,
  ix: number,
  iy: number,
  iz: number,
  flatX: boolean,
  flatY: boolean,
  flatZ: boolean,
): boolean {
  let t0 = 0
  let t1 = 1
  let a: number
  let b: number
  if (flatX) {
    if (ox < nb[o] || ox > nb[o + 3]) return false
  } else {
    a = (nb[o] - ox) * ix
    b = (nb[o + 3] - ox) * ix
    if (a > b) { const t = a; a = b; b = t }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return false
  }
  if (flatY) {
    if (oy < nb[o + 1] || oy > nb[o + 4]) return false
  } else {
    a = (nb[o + 1] - oy) * iy
    b = (nb[o + 4] - oy) * iy
    if (a > b) { const t = a; a = b; b = t }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return false
  }
  if (flatZ) {
    if (oz < nb[o + 2] || oz > nb[o + 5]) return false
  } else {
    a = (nb[o + 2] - oz) * iz
    b = (nb[o + 5] - oz) * iz
    if (a > b) { const t = a; a = b; b = t }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return false
  }
  return true
}

// Traversal stacks. Trees are median-split, so depth is ~log2(n / 4);
// 256 entries is far beyond any real list. Shared by `queryOccluder` and
// `collectOccluders`; never re-entered (neither runs callbacks).
const stackTop = new Int32Array(256)
const stackRow = new Int32Array(256)

/**
 * First prism of `index` that hides the target at Mercator (px, py, pz)
 * standing at `altitudeM`, or null when nothing does. Exactly the
 * linear loop's verdict: `hit !== null` ⇔ some prism of the list hides it.
 *
 * `hint` — a prism FROM THE SAME LIST (typically last frame's hit for this
 * target) — is tried first; it is checked with the same exact test, so a
 * stale hint costs one test and never changes the answer.
 */
export function queryOccluder(
  index: OccluderIndex,
  cx: number,
  cy: number,
  cz: number,
  px: number,
  py: number,
  pz: number,
  altitudeM: number,
  floorPlanId: number | undefined,
  hint: OccluderPrism | null,
): OccluderPrism | null {
  const dx = px - cx
  const dy = py - cy
  const dz = pz - cz
  if (
    hint !== null &&
    prismHides(hint, cx, cy, cz, px, py, dx, dy, dz, altitudeM, floorPlanId, accelFor(hint))
  ) {
    return hint
  }
  const tlas = index.tlas
  if (tlas.nodes === 0) return null
  // Same expression as the per-prism `topM <= altitudeM + tolerance` skip,
  // applied to a subtree's largest top.
  const thr = altitudeM + SELF_SURFACE_TOLERANCE_M
  const flatX = Math.abs(dx) < FLAT_XY
  const flatY = Math.abs(dy) < FLAT_XY
  const flatZ = Math.abs(dz) < FLAT_Z
  const ix = 1 / dx
  const iy = 1 / dy
  const iz = 1 / dz
  const blases = index.blases
  const tnb = tlas.nb
  let sp = 0
  stackTop[sp++] = 0
  while (sp > 0) {
    const n = stackTop[--sp]
    const o = n * 7
    if (tnb[o + 6] <= thr) continue
    if (!segmentHitsBox(tnb, o, cx, cy, cz, ix, iy, iz, flatX, flatY, flatZ)) continue
    const c = tlas.count[n]
    if (c === 0) {
      stackTop[sp++] = tlas.left[n]
      stackTop[sp++] = tlas.left[n] + 1
      continue
    }
    for (let k = tlas.start[n], ke = k + c; k < ke; k++) {
      const blas = blases[tlas.order[k]]
      const bvh = blas.bvh
      const nb = bvh.nb
      const group = blas.group
      const accel = blas.accel
      let bp = 0
      stackRow[bp++] = 0
      while (bp > 0) {
        const m = stackRow[--bp]
        const q = m * 7
        if (nb[q + 6] <= thr) continue
        if (!segmentHitsBox(nb, q, cx, cy, cz, ix, iy, iz, flatX, flatY, flatZ)) continue
        const cc = bvh.count[m]
        if (cc === 0) {
          stackRow[bp++] = bvh.left[m]
          stackRow[bp++] = bvh.left[m] + 1
          continue
        }
        for (let r = bvh.start[m], re = r + cc; r < re; r++) {
          const pi = bvh.order[r]
          const p = group[pi]
          if (prismHides(p, cx, cy, cz, px, py, dx, dy, dz, altitudeM, floorPlanId, accel[pi])) {
            return p
          }
        }
      }
    }
  }
  return null
}

/**
 * Every prism of `index` that hides the target at Mercator (px, py, pz)
 * standing at `altitudeM`, appended to `out` in traversal order (every
 * list entry is visited at most once). `out` gains nothing ⇔
 * `queryOccluder` returns null for the same arguments.
 *
 * The all-hits twin of `queryOccluder`: the same exact per-prism test
 * (`prismHides`) and the same pruning (subtree top vs `altitudeM +
 * SELF_SURFACE_TOLERANCE_M`, `segmentHitsBox` on every TLAS / BLAS node),
 * with no hint and no early return. Focus mode uses it to ask WHICH
 * shapes stand between the camera and a focused item, so only those
 * fade.
 *
 * Synchronous and NOT re-entrant: it shares this module's traversal
 * stacks with `queryOccluder` and runs no callbacks, so never call either
 * from inside the other.
 */
export function collectOccluders(
  index: OccluderIndex,
  cx: number,
  cy: number,
  cz: number,
  px: number,
  py: number,
  pz: number,
  altitudeM: number,
  floorPlanId: number | undefined,
  out: OccluderPrism[],
): void {
  const dx = px - cx
  const dy = py - cy
  const dz = pz - cz
  const tlas = index.tlas
  if (tlas.nodes === 0) return
  const thr = altitudeM + SELF_SURFACE_TOLERANCE_M
  const flatX = Math.abs(dx) < FLAT_XY
  const flatY = Math.abs(dy) < FLAT_XY
  const flatZ = Math.abs(dz) < FLAT_Z
  const ix = 1 / dx
  const iy = 1 / dy
  const iz = 1 / dz
  const blases = index.blases
  const tnb = tlas.nb
  let sp = 0
  stackTop[sp++] = 0
  while (sp > 0) {
    const n = stackTop[--sp]
    const o = n * 7
    if (tnb[o + 6] <= thr) continue
    if (!segmentHitsBox(tnb, o, cx, cy, cz, ix, iy, iz, flatX, flatY, flatZ)) continue
    const c = tlas.count[n]
    if (c === 0) {
      stackTop[sp++] = tlas.left[n]
      stackTop[sp++] = tlas.left[n] + 1
      continue
    }
    for (let k = tlas.start[n], ke = k + c; k < ke; k++) {
      const blas = blases[tlas.order[k]]
      const bvh = blas.bvh
      const nb = bvh.nb
      const group = blas.group
      const accel = blas.accel
      let bp = 0
      stackRow[bp++] = 0
      while (bp > 0) {
        const m = stackRow[--bp]
        const q = m * 7
        if (nb[q + 6] <= thr) continue
        if (!segmentHitsBox(nb, q, cx, cy, cz, ix, iy, iz, flatX, flatY, flatZ)) continue
        const cc = bvh.count[m]
        if (cc === 0) {
          stackRow[bp++] = bvh.left[m]
          stackRow[bp++] = bvh.left[m] + 1
          continue
        }
        for (let r = bvh.start[m], re = r + cc; r < re; r++) {
          const pi = bvh.order[r]
          const p = group[pi]
          if (prismHides(p, cx, cy, cz, px, py, dx, dy, dz, altitudeM, floorPlanId, accel[pi])) {
            out.push(p)
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Box query

/**
 * Does the closed segment a→b touch the closed box? Liang–Barsky clip of
 * the segment's parameter range against each slab; a zero-length axis is
 * an interval check. Touching counts.
 */
function segmentTouchesBox(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0) {
    if (ax < minX || ax > maxX) return false
  } else {
    let a = (minX - ax) / dx
    let b = (maxX - ax) / dx
    if (a > b) { const t = a; a = b; b = t }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return false
  }
  if (dy === 0) {
    if (ay < minY || ay > maxY) return false
  } else {
    let a = (minY - ay) / dy
    let b = (maxY - ay) / dy
    if (a > b) { const t = a; a = b; b = t }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return false
  }
  return true
}

/**
 * Exact polygon-vs-rectangle overlap for an open ring (plus optional
 * holes) and a closed box. True when any edge of any ring (vertices
 * included) touches the box, or — no edge touching means the box lies
 * wholly inside or wholly outside the footprint — when a box corner is
 * inside it (even-odd over the ring and its holes, so a box wholly inside
 * a hole doesn't match). A footprint with any non-finite vertex never
 * matches.
 */
export function ringIntersectsBox(
  ring: ReadonlyArray<readonly [number, number]>,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  holes?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): boolean {
  const n = ring.length
  if (n === 0) return false
  const rings: Ring[] = [ring]
  if (holes) for (const h of holes) rings.push(h)
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      if (!Number.isFinite(r[i][0]) || !Number.isFinite(r[i][1])) return false
    }
  }
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (segmentTouchesBox(r[j][0], r[j][1], r[i][0], r[i][1], minX, minY, maxX, maxY)) return true
    }
  }
  return n >= 3 && containsFootprint(ring, holes, minX, minY)
}

/**
 * Every prism of `index` whose footprint (ring and holes) overlaps the
 * Mercator box [minX, maxX] × [minY, maxY] (exactly — `ringIntersectsBox`) and whose
 * top is strictly above `minTopM`, appended to `out` in traversal order.
 * Each list entry is visited at most once.
 *
 * Pruning mirrors the segment queries: a TLAS / BLAS node is skipped when
 * its x/y box misses the query box or its largest top is `<= minTopM`.
 * Node boxes enclose every ring vertex (inflated by `BOX_EPS`), so a ring
 * that touches the query box always lies under an overlapping node; a
 * prism with a non-finite field has an unbounded box and reaches the
 * exact test, which rejects a non-finite ring.
 *
 * Focus mode asks it which solids stand in a column around the focused
 * item (`focus-near.ts`). Synchronous and NOT re-entrant: it shares this
 * module's traversal stacks with `queryOccluder` / `collectOccluders`
 * and runs no callbacks, so never call one from inside another.
 */
export function collectPrismsInBox(
  index: OccluderIndex,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  minTopM: number,
  out: OccluderPrism[],
): void {
  const tlas = index.tlas
  if (tlas.nodes === 0) return
  if (!(minX <= maxX && minY <= maxY)) return
  const blases = index.blases
  const tnb = tlas.nb
  let sp = 0
  stackTop[sp++] = 0
  while (sp > 0) {
    const n = stackTop[--sp]
    const o = n * 7
    if (tnb[o + 6] <= minTopM) continue
    if (tnb[o] > maxX || tnb[o + 3] < minX || tnb[o + 1] > maxY || tnb[o + 4] < minY) continue
    const c = tlas.count[n]
    if (c === 0) {
      stackTop[sp++] = tlas.left[n]
      stackTop[sp++] = tlas.left[n] + 1
      continue
    }
    for (let k = tlas.start[n], ke = k + c; k < ke; k++) {
      const blas = blases[tlas.order[k]]
      const bvh = blas.bvh
      const nb = bvh.nb
      const group = blas.group
      let bp = 0
      stackRow[bp++] = 0
      while (bp > 0) {
        const m = stackRow[--bp]
        const q = m * 7
        if (nb[q + 6] <= minTopM) continue
        if (nb[q] > maxX || nb[q + 3] < minX || nb[q + 1] > maxY || nb[q + 4] < minY) continue
        const cc = bvh.count[m]
        if (cc === 0) {
          stackRow[bp++] = bvh.left[m]
          stackRow[bp++] = bvh.left[m] + 1
          continue
        }
        for (let r = bvh.start[m], re = r + cc; r < re; r++) {
          const p = group[bvh.order[r]]
          if (p.topM > minTopM && ringIntersectsBox(p.ring, minX, minY, maxX, maxY, p.holes)) out.push(p)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Point / pierce queries (focus mode)

/**
 * Is Mercator (x, y) inside `prism`'s footprint? Even-odd over the ring
 * and its holes (a point in a hole is outside) — the same test the depth
 * pass's embedded check runs, through the y-band buckets for a big
 * footprint.
 */
export function prismContainsPoint(prism: OccluderPrism, x: number, y: number): boolean {
  const A = accelFor(prism)
  return A ? containsPointBanded(A, x, y) : containsFootprint(prism.ring, prism.holes, x, y)
}

/** Parameter along a→b where it meets edge c→d, or NaN when they don't meet (parallel included). */
function edgeParam(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const rx = bx - ax
  const ry = by - ay
  const sx = dx - cx
  const sy = dy - cy
  const den = rx * sy - ry * sx
  if (den === 0 || !Number.isFinite(den)) return NaN
  const qx = cx - ax
  const qy = cy - ay
  const t = (qx * sy - qy * sx) / den
  const u = (qx * ry - qy * rx) / den
  if (!(t >= 0 && t <= 1 && u >= 0 && u <= 1)) return NaN
  return t
}

/**
 * Where the camera→target segment runs through `prism`: the first and
 * last Mercator points of the segment that lie inside the footprint
 * (hole-aware), as `[x0, y0, x1, y1]`, or null when no part does.
 *
 * The segment is first clipped to the prism's altitude slab exactly as
 * `prismHides` clips it (same flat-camera case), giving A..B. Every edge
 * crossing (outer ring and holes) splits A..B into sub-intervals; each
 * one's midpoint decides whether it is inside, and the outermost inside
 * endpoints are returned. A flat plate clips to one point A: `[A, A]`
 * when A is inside, else null.
 *
 * Focus mode turns these into the cut-away discs of a line-of-sight
 * blocker (`focus-blockers.ts`). Pure: no shared stacks, no callbacks.
 */
export function prismPierceSpan(
  prism: OccluderPrism,
  cx: number,
  cy: number,
  cz: number,
  px: number,
  py: number,
  pz: number,
): [x0: number, y0: number, x1: number, y1: number] | null {
  const dx = px - cx
  const dy = py - cy
  const dz = pz - cz
  let tLo: number
  let tHi: number
  if (Math.abs(dz) < FLAT_Z) {
    if (cz < prism.zBottom || cz > prism.zTop) return null
    tLo = 0
    tHi = 1
  } else {
    const ta = (prism.zBottom - cz) / dz
    const tb = (prism.zTop - cz) / dz
    tLo = Math.min(ta, tb)
    tHi = Math.max(ta, tb)
  }
  if (!(tHi > 0) || !(tLo < 1)) return null
  if (tLo < 0) tLo = 0
  if (tHi > 1) tHi = 1
  const ax = cx + tLo * dx
  const ay = cy + tLo * dy
  const bx = cx + tHi * dx
  const by = cy + tHi * dy
  if (ax === bx && ay === by) {
    return prismContainsPoint(prism, ax, ay) ? [ax, ay, ax, ay] : null
  }
  if (Math.max(ax, bx) < prism.minX || Math.min(ax, bx) > prism.maxX) return null
  if (Math.max(ay, by) < prism.minY || Math.min(ay, by) > prism.maxY) return null

  const ts: number[] = [0, 1]
  const addRing = (ring: Ring) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const t = edgeParam(ax, ay, bx, by, ring[j][0], ring[j][1], ring[i][0], ring[i][1])
      if (t > 0 && t < 1) ts.push(t)
    }
  }
  addRing(prism.ring)
  if (prism.holes) for (const h of prism.holes) addRing(h)
  ts.sort((a, b) => a - b)
  let first = -1
  let last = -1
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k]
    const t1 = ts[k + 1]
    if (!(t1 > t0)) continue
    const tm = (t0 + t1) / 2
    if (!prismContainsPoint(prism, ax + tm * (bx - ax), ay + tm * (by - ay))) continue
    if (first < 0) first = t0
    last = t1
  }
  if (first < 0) return null
  return [ax + first * (bx - ax), ay + first * (by - ay), ax + last * (bx - ax), ay + last * (by - ay)]
}
