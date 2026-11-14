/**
 * Path-layout grids: a rack / seat grid laid along a drawn polyline instead
 * of filling an axis-aligned rectangle (`GridConfig.layout === 'path'`).
 *
 * Storage — the path lives in `config.path` as vertices **normalised to the
 * grid's own box** (`start` / `current`): `[u, v]` with u running east from
 * the box's west edge and v north from its south edge, both 0…1. Because the
 * path is relative to the box, everything that already edits a grid through
 * `start` / `current` / `config.rotation` keeps working unchanged: move and
 * arrow-key nudge shift the box (and the path with it), resize stretches the
 * path, rotate turns the cells around `start`, duplicate offsets the box. No
 * database column or API field is involved — it round-trips in `config`.
 *
 * Geometry — cells are built in local metres. Columns run along the path
 * (`xSize` long, `cellGap` apart), rows sit across it (`ySize` deep), on the
 * path's left, right or centred on it (`pathAlign`). With `pathSmooth` the
 * clicked points are joined by a Catmull-Rom curve instead of straight
 * segments. Every cell keeps the square grid's `row` / `col` / `level`
 * addressing, so bins, labels, style rules and data links work as before.
 *
 * Counts — `pathGridDimensions` is the single source for rows / cols: the
 * column count comes from the path's length (along the curve when smoothed).
 * The Go copy in `backend/internal/handlers/import_pipeline.go` repeats the
 * same maths (frame, Catmull-Rom with 12 samples per segment) so bin labels
 * resolve to the same cells server-side.
 */
import { distance as turfDistance, point as turfPoint } from '@turf/turf'

export type GridLayout = 'bbox' | 'path'
export type GridPathAlign = 'center' | 'left' | 'right'

/** The path-layout fields of `GridConfig` (see grid-generators.ts). */
export interface GridPathFields {
  layout?: GridLayout
  path?: [number, number][]
  pathRows?: number
  pathAlign?: GridPathAlign
  pathSmooth?: boolean
  /** Metres each row sits above the one before it (row 0 = nearest the path) —
   *  raked seating: stadium stands, lecture theatres. 0 / unset = flat. */
  pathRowRise?: number
}

type Vec = [number, number]

/** Same cap as the square builder: never emit more than this many cells. */
export const PATH_GRID_MAX_CELLS = 20_000

/** The config asks for the path layout (the path itself may not be drawn yet). */
export function isPathLayout(config: GridPathFields | null | undefined): boolean {
  return config?.layout === 'path'
}

/** A path-layout config with a usable path (two or more vertices). */
export function isPathGrid(config: GridPathFields | null | undefined): boolean {
  return config?.layout === 'path' && Array.isArray(config.path) && config.path.length >= 2
}

const metres = (a: Vec, b: Vec) => turfDistance(turfPoint(a), turfPoint(b), { units: 'meters' })

/**
 * The grid's local frame: metres east / north of the box's south-west
 * corner. Width and height are measured along `start`'s latitude / longitude
 * — the same measurement `estimateGridDimensions` uses, so counts agree.
 */
export function pathGridFrame(start: Vec, current: Vec) {
  const minLng = Math.min(start[0], current[0])
  const maxLng = Math.max(start[0], current[0])
  const minLat = Math.min(start[1], current[1])
  const maxLat = Math.max(start[1], current[1])
  const widthM = metres([minLng, start[1]], [maxLng, start[1]])
  const heightM = metres([start[0], minLat], [start[0], maxLat])
  return {
    widthM,
    heightM,
    /** Normalised path vertex → local metres. */
    toMetres: ([u, v]: Vec): Vec => [u * widthM, v * heightM],
    /** Local metres → [lng, lat]. */
    toLngLat: ([x, y]: Vec): Vec => [
      minLng + (widthM > 0 ? x / widthM : 0) * (maxLng - minLng),
      minLat + (heightM > 0 ? y / heightM : 0) * (maxLat - minLat),
    ],
  }
}

/** The path in local metres — the Catmull-Rom curve when `smooth`. */
export function pathPolylineMetres(start: Vec, current: Vec, path: Vec[], smooth: boolean): Vec[] {
  const f = pathGridFrame(start, current)
  const raw = path.map(f.toMetres)
  return smooth ? smoothPolyline(raw) : raw
}

/** Length of the path (straight segments, or the curve when `smooth`), in metres. */
export function pathLengthMetres(start: Vec, current: Vec, path: Vec[], smooth = false): number {
  const pts = pathPolylineMetres(start, current, path, smooth)
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return len
}

/**
 * Rows across × columns along for a path grid. Mirrors the square builder's
 * rules (at least one column, `cellGap` widens the pitch, total cells capped
 * at PATH_GRID_MAX_CELLS) and is the only place the counts are derived.
 */
export function pathGridDimensions(
  start: Vec,
  current: Vec,
  config: GridPathFields & { xSize: number; ySize: number; cellGap?: number; levels?: number },
): { rows: number; cols: number; lengthM: number } {
  const lengthM = isPathGrid(config) ? pathLengthMetres(start, current, config.path as Vec[], !!config.pathSmooth) : 0
  const rows = Math.max(1, Math.floor(config.pathRows ?? 1))
  const levels = Math.max(1, Math.floor(config.levels ?? 1))
  const gap = Math.max(0, config.cellGap ?? 0)
  const pitch = Math.max(1e-6, config.xSize + gap)
  let cols = Math.max(1, Math.floor((lengthM + gap) / pitch + 1e-9))
  const cap = Math.max(1, Math.floor(PATH_GRID_MAX_CELLS / (rows * levels)))
  if (cols > cap) cols = cap
  return { rows, cols, lengthM }
}

/** Total depth across the path: rows × ySize plus the gaps between rows. */
export function pathGridDepth(config: GridPathFields & { ySize: number; cellGap?: number }): number {
  const rows = Math.max(1, Math.floor(config.pathRows ?? 1))
  const gap = Math.max(0, config.cellGap ?? 0)
  return rows * config.ySize + (rows - 1) * gap
}

/**
 * Catmull-Rom curve through the points (end points repeated), `steps` samples
 * per segment. Passes through every clicked point.
 */
export function smoothPolyline(pts: Vec[], steps = 12): Vec[] {
  if (pts.length < 3) return pts.slice()
  const out: Vec[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let k = 0; k < steps; k++) {
      const t = k / steps
      const t2 = t * t
      const t3 = t2 * t
      const c = (a: number, b: number, cc: number, d: number) =>
        0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3)
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** Drop consecutive points closer than `minM` metres (local metre space). */
function dedupe(pts: Vec[], minM = 0.02): Vec[] {
  const out: Vec[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minM) out.push(p)
  }
  return out
}

/**
 * A polyline in local metres with arc-length lookup. `at(s)` returns the
 * point and the left-hand normal at arc length s (extrapolated past the ends
 * along the end tangents). At a vertex the normal is the bisector of the two
 * segment normals, scaled by the mitre factor so offset edges stay parallel
 * to both segments; between vertices it is interpolated from one vertex's
 * mitre normal to the next. That makes each segment a trapezoid, so the cut
 * lines between cells fan round a bend instead of crossing on its inside —
 * cells on the inner side come out narrower, like seats on a curved row.
 */
export function makeArc(ptsIn: Vec[]) {
  const pts = dedupe(ptsIn)
  const cum: number[] = [0]
  const segN: Vec[] = []
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0]
    const dy = pts[i][1] - pts[i - 1][1]
    const L = Math.hypot(dx, dy) || 1e-9
    cum.push(cum[i - 1] + L)
    segN.push([-dy / L, dx / L])
  }
  const total = cum[cum.length - 1]
  const computeVertexNormal = (i: number): Vec => {
    if (i <= 0) return segN[0]
    if (i >= pts.length - 1) return segN[segN.length - 1]
    const a = segN[i - 1]
    const b = segN[i]
    let nx = a[0] + b[0]
    let ny = a[1] + b[1]
    const L = Math.hypot(nx, ny)
    if (L < 1e-6) return a // a 180° switch-back: no sensible mitre
    nx /= L
    ny /= L
    const cos = nx * a[0] + ny * a[1]
    const k = 1 / Math.max(cos, 1 / 3) // mitre, capped at 3×
    return [nx * k, ny * k]
  }
  // Every cell edge reads the mitre normals of the vertices it spans, so a
  // grid asks for the same few normals thousands of times. Computed once
  // per vertex (same arithmetic, same result) and handed out read-only.
  const normals: (Vec | undefined)[] = new Array(pts.length)
  const vertexNormal = (i: number): Vec => {
    if (i <= 0 || i >= pts.length - 1) return computeVertexNormal(i)
    return (normals[i] ??= computeVertexNormal(i))
  }
  /**
   * Smallest index i in [1, cum.length - 1] with cum[i] >= s (the last
   * index when none is) — the segment `at` interpolates on. `cum` is
   * strictly increasing (every segment is at least 1e-9 long), so a
   * binary search lands on the same index the old linear scan did.
   */
  const segmentAt = (s: number): number => {
    let lo = 1
    let hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < s) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const at = (s: number): { p: Vec; n: Vec } => {
    if (pts.length < 2) return { p: pts[0] ?? [0, 0], n: [0, 1] }
    if (s <= 0) {
      const n = segN[0]
      const t: Vec = [n[1], -n[0]]
      return { p: [pts[0][0] + t[0] * s, pts[0][1] + t[1] * s], n }
    }
    if (s >= total) {
      const n = segN[segN.length - 1]
      const t: Vec = [n[1], -n[0]]
      const e = pts[pts.length - 1]
      return { p: [e[0] + t[0] * (s - total), e[1] + t[1] * (s - total)], n }
    }
    const i = segmentAt(s)
    const s0 = cum[i - 1]
    const s1 = cum[i]
    const t = (s - s0) / (s1 - s0 || 1e-9)
    const a = pts[i - 1]
    const b = pts[i]
    const na = vertexNormal(i - 1)
    const nb = vertexNormal(i)
    return {
      p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      n: [na[0] + (nb[0] - na[0]) * t, na[1] + (nb[1] - na[1]) * t],
    }
  }
  /** Arc positions of the vertices strictly between s0 and s1. */
  const vertexStops = (s0: number, s1: number) => {
    const stops: { s: number; p: Vec; n: Vec }[] = []
    // cum is strictly increasing, so the matches are one contiguous run of
    // interior vertices starting at the first cum[i] > s0.
    let lo = 1
    let hi = pts.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= s0) lo = mid + 1
      else hi = mid
    }
    // (`cum[i] > s0` re-checked so a NaN bound still matches nothing.)
    for (let i = lo; i < pts.length - 1 && cum[i] < s1; i++) {
      if (cum[i] > s0) stops.push({ s: cum[i], p: pts[i], n: vertexNormal(i) })
    }
    return stops
  }
  return { total, at, vertexStops, valid: pts.length >= 2 }
}

/** A point on the arc with its (mitre) normal — what `cellRingFromStops` offsets. */
export type ArcStop = { p: Vec; n: Vec }

/**
 * The stops a cell edge between arc lengths s0 and s1 passes through: the
 * two ends plus every path vertex in between. Independent of the offsets,
 * so one column's stops serve every row of a path grid.
 */
export function arcStops(arc: ReturnType<typeof makeArc>, s0: number, s1: number): ArcStop[] {
  return [arc.at(s0), ...arc.vertexStops(s0, s1), arc.at(s1)]
}

/**
 * The closed ring between offsets `a` and `b` (left-hand positive) along
 * `stops`: the edge at offset a from the first stop to the last, then the
 * edge at offset b back.
 */
export function cellRingFromStops(stops: ReadonlyArray<ArcStop>, a: number, b: number): Vec[] {
  const near = stops.map(({ p, n }) => [p[0] + n[0] * a, p[1] + n[1] * a] as Vec)
  const far = stops.map(({ p, n }) => [p[0] + n[0] * b, p[1] + n[1] * b] as Vec).reverse()
  const ring = [...near, ...far]
  ring.push(ring[0])
  return ring
}

/**
 * One cell's outline in local metres: the strip between offsets `a` and `b`
 * (left-hand positive) along the arc from s0 to s1, following every vertex in
 * between. Returns a closed ring.
 */
export function cellRing(arc: ReturnType<typeof makeArc>, s0: number, s1: number, a: number, b: number): Vec[] {
  return cellRingFromStops(arcStops(arc, s0, s1), a, b)
}

/**
 * A closed [lng, lat] ring without the vertices that lie on a straight
 * line between their neighbours — within `epsM` metres of the chord that
 * replaces them, and strictly between its ends. Path-grid cells carry
 * every path vertex they span on both long edges; on a straight or gently
 * curved stretch most of those are collinear, and every one of them costs
 * a tile vertex, an extrusion wall and a line segment in Mapbox.
 *
 * The first vertex is always kept (it is where a LineString border starts
 * and ends), every other kept vertex is an original one (same array, never
 * moved), and the result is never further than `epsM` from the input.
 * Returns the input itself when nothing can be dropped or the ring is a
 * plain quad / triangle.
 */
export function compactRing(ring: ReadonlyArray<Vec>, epsM: number): Vec[] {
  const n = ring.length - 1 // open length; ring[n] repeats ring[0]
  if (n <= 4) return ring as Vec[]
  const kx = 111_320 * Math.cos((ring[0][1] * Math.PI) / 180)
  const ky = 111_320
  const eps2 = epsM * epsM
  // Every vertex strictly between a and b (indices into the open ring, b
  // may be n = the closing copy of 0) is within eps of the chord a→b and
  // projects strictly inside it.
  const chordCovers = (a: number, b: number): boolean => {
    const ax = ring[a][0] * kx
    const ay = ring[a][1] * ky
    const dx = ring[b][0] * kx - ax
    const dy = ring[b][1] * ky - ay
    const L2 = dx * dx + dy * dy
    if (!(L2 > 0)) return false
    for (let k = a + 1; k < b; k++) {
      const px = ring[k][0] * kx - ax
      const py = ring[k][1] * ky - ay
      const t = (px * dx + py * dy) / L2
      if (!(t > 0 && t < 1)) return false
      const cross = px * dy - py * dx
      if (!((cross * cross) / L2 < eps2)) return false
    }
    return true
  }
  const out: Vec[] = [ring[0] as Vec]
  let a = 0
  while (a < n) {
    let e = a + 1
    while (e < n && chordCovers(a, e + 1)) e++
    out.push((e === n ? ring[0] : ring[e]) as Vec)
    a = e
  }
  if (out.length === ring.length || out.length < 4) return ring as Vec[]
  return out
}

/**
 * Turn absolute path vertices ([lng, lat], as clicked) into a grid's
 * `start` / `current` box and a normalised `config.path`. The box is the
 * path's extent padded by half the strip depth (at least 0.5 m) so a
 * straight path still has a two-dimensional box. Returns null when the
 * path has fewer than two distinct points.
 */
export function pathGridGeometry(
  vertices: Vec[],
  config: GridPathFields & { ySize: number; cellGap?: number },
): { start: Vec; current: Vec; path: Vec[] } | null {
  const pts: Vec[] = []
  for (const v of vertices) {
    const last = pts[pts.length - 1]
    if (!last || metres(last, v) >= 0.05) pts.push(v)
  }
  if (pts.length < 2) return null
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const [lng, lat] of pts) {
    minLng = Math.min(minLng, lng)
    maxLng = Math.max(maxLng, lng)
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
  }
  const midLat = (minLat + maxLat) / 2
  const padM = Math.max(0.5, pathGridDepth(config) / 2)
  const padLat = padM / 110_540
  const padLng = padM / (111_320 * Math.cos((midLat * Math.PI) / 180))
  minLng -= padLng
  maxLng += padLng
  minLat -= padLat
  maxLat += padLat
  const path = pts.map(([lng, lat]) => [(lng - minLng) / (maxLng - minLng), (lat - minLat) / (maxLat - minLat)] as Vec)
  return { start: [minLng, minLat], current: [maxLng, maxLat], path }
}

/** The path's vertices back in [lng, lat] (unrotated), for guides and export. */
export function pathGridVertices(start: Vec, current: Vec, path: Vec[]): Vec[] {
  const f = pathGridFrame(start, current)
  return path.map((p) => f.toLngLat(f.toMetres(p)))
}
