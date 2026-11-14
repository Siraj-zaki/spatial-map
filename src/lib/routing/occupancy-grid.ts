/**
 * Occupancy grid + Euclidean distance transform for indoor routing.
 *
 * The grid is a `Uint8Array` (1 byte per cell) where 0 = walkable and
 * 1 = blocked. It's built in four passes:
 *
 *   1. Compute the scene bbox in local metres, pad it, and derive
 *      grid dimensions from the requested cell size.
 *   2. Rasterize every obstacle polygon (as an even-odd fill) and every
 *      wall segment (as a thickened strip = wallThickness/2 + agent
 *      radius on either side). Cells outside the bounds polygon (if
 *      provided) are also marked blocked.
 *   3. Punch door openings back out. Each door mouth defines a
 *      rectangle (mouth length × 2·overClear); every cell inside that
 *      rect flips to walkable, overriding whatever wall was there.
 *   4. (Optional) precompute a Euclidean distance transform so the
 *      post-processing pass can push waypoints toward corridor centres.
 *
 * The grid is laid out in the building's frame (projection.ts): its rows
 * run along the main wall direction, found from the walls / doors / racks
 * (`sceneAxisDeg`) unless the request names one. Door mouths are kept on
 * the grid (`doors`) so the post-process can route through their centres.
 *
 * All rasterization is done with plain integer scan conversion — no
 * canvas / no WASM. At 25 cm cells a 100 × 60 m warehouse compiles in
 * < 30 ms on a mid-tier laptop, which is well under the "instantly
 * responsive" budget for a click-driven UI.
 */

import type { RoutingScene } from './types.ts'
import {
  dominantAxisDeg,
  fromLocal,
  makeLocalFrame,
  pickAnchor,
  toLocal,
  type LocalFrame,
} from './projection.ts'

/** Compiled scene ready for A*. All coordinates are grid-cell indices. */
export interface CompiledGrid {
  /** Local tangent-plane frame used to project lng/lat ↔ metres. */
  frame: LocalFrame
  /** Cells per row (`width`) and rows (`height`). */
  width: number
  height: number
  /** Cell edge length in METERS. */
  cellSize: number
  /** Grid origin (top-left cell centre) in local metres. */
  originX: number
  originY: number
  /**
   * `width * height` occupancy bytes. 0 = walkable, 1 = blocked.
   * Row-major: `occ[y * width + x]`.
   */
  occ: Uint8Array
  /**
   * Optional Euclidean distance to the nearest blocked cell, in
   * METERS. Same layout as `occ`. Undefined until built via
   * `buildDistanceTransform`.
   */
  dist?: Float32Array
  /**
   * Door mouths (jamb → jamb) in fractional cell coordinates, cell
   * centre = index + 0.5 — the same convention the post-process works
   * in. Routes are pulled through their centres.
   */
  doors?: { a: [number, number]; b: [number, number] }[]
  /** How far a door's opening reaches either side of the mouth, in cells
   *  (widest wall half-thickness + agent radius). */
  doorDepthCells?: number
  /** Optional: 1 where a WALL blocks the cell (door openings punched), so a
   *  caller can tell walls from rack / object cells. Same layout as `occ`. */
  wall?: Uint8Array
}

/**
 * Building axis from the scene: walls vote with their full length, door
 * mouths and obstacle edges (rack cells) at half weight — a floor with
 * racks but no walls still lines up with its racks.
 */
function sceneAxisDeg(scene: RoutingScene, anchor: [number, number]): number {
  const segs: { a: [number, number]; b: [number, number]; weight?: number }[] = []
  for (const w of scene.walls ?? []) {
    for (let i = 0; i + 1 < w.vertices.length; i++) segs.push({ a: w.vertices[i], b: w.vertices[i + 1] })
  }
  for (const d of scene.doors ?? []) segs.push({ a: d.vertices[0], b: d.vertices[1], weight: 0.5 })
  for (const o of scene.obstacles ?? []) {
    for (let i = 0; i < o.vertices.length; i++) {
      segs.push({ a: o.vertices[i], b: o.vertices[(i + 1) % o.vertices.length], weight: 0.5 })
    }
  }
  return dominantAxisDeg(segs, anchor)
}

// ---------------------------------------------------------------------------
// Scene bbox → grid dimensions
// ---------------------------------------------------------------------------

/**
 * Enumerate every lng/lat sample the scene contains so we can pick a
 * projection anchor + tight bbox. Cheap: one linear pass over each
 * shape's vertex list, no allocations beyond the returned array.
 */
function collectSamples(
  scene: RoutingScene,
  start: [number, number],
  end: [number, number],
  include: ReadonlyArray<[number, number]> = [],
): [number, number][] {
  const out: [number, number][] = [start, end, ...include]
  for (const w of scene.walls ?? []) for (const v of w.vertices) out.push(v)
  for (const d of scene.doors ?? []) for (const v of d.vertices) out.push(v)
  for (const o of scene.obstacles ?? []) for (const v of o.vertices) out.push(v)
  for (const v of scene.bounds?.vertices ?? []) out.push(v)
  return out
}

// ---------------------------------------------------------------------------
// Segment rasterization (Bresenham-style thick line)
// ---------------------------------------------------------------------------

/**
 * Rasterize a thick line segment into the occupancy grid.
 * `radiusCells` is the half-thickness of the strip in cells; every
 * cell whose CENTRE is within `radiusCells` of the segment is marked
 * blocked. We use a per-column / per-row sweep that's O(len × radius)
 * — sufficient for our scale and easy to reason about vs a full
 * distance-based fill.
 */
function rasterSegment(
  occ: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radiusCells: number,
  value: 0 | 1,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy)
  if (len === 0) return
  // Step along the segment in half-cell increments so no pixel is
  // missed even for near-45° lines.
  const steps = Math.max(1, Math.ceil(len * 2))
  const r = Math.max(0, radiusCells)
  const r2 = r * r
  // Bbox of the swept disc so we only revisit cells that could
  // possibly be in range.
  const rCeil = Math.ceil(r)
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const cx = x0 + dx * t
    const cy = y0 + dy * t
    const minX = Math.max(0, Math.floor(cx - rCeil))
    const maxX = Math.min(width - 1, Math.ceil(cx + rCeil))
    const minY = Math.max(0, Math.floor(cy - rCeil))
    const maxY = Math.min(height - 1, Math.ceil(cy + rCeil))
    for (let gy = minY; gy <= maxY; gy++) {
      const ddy = gy + 0.5 - cy
      for (let gx = minX; gx <= maxX; gx++) {
        const ddx = gx + 0.5 - cx
        if (ddx * ddx + ddy * ddy <= r2) {
          occ[gy * width + gx] = value
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Polygon rasterization (scanline even-odd fill)
// ---------------------------------------------------------------------------

function rasterPolygonFill(
  occ: Uint8Array,
  width: number,
  height: number,
  poly: [number, number][],
  value: 0 | 1,
): void {
  if (poly.length < 3) return
  // Compute integer scanline range.
  let minY = Infinity
  let maxY = -Infinity
  for (const [, y] of poly) {
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(height - 1, Math.ceil(maxY))
  for (let y = y0; y <= y1; y++) {
    // Collect x-intersections of the horizontal line y+0.5 with every
    // polygon edge, using the standard "half-open" rule (edges are
    // upward-open) so vertices are counted exactly once.
    const yc = y + 0.5
    const xs: number[] = []
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j]
      const [bx, by] = poly[i]
      const upward = ay <= yc && by > yc
      const downward = by <= yc && ay > yc
      if (upward || downward) {
        const t = (yc - ay) / (by - ay)
        xs.push(ax + t * (bx - ax))
      }
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.floor(xs[k]))
      const xb = Math.min(width - 1, Math.ceil(xs[k + 1]))
      const rowStart = y * width
      for (let x = xa; x <= xb; x++) occ[rowStart + x] = value
    }
  }
}

/**
 * Mark every cell OUTSIDE the given polygon as blocked. Used for the
 * scene `bounds` — nothing outside the facility should be walkable.
 */
function markOutsidePolygonBlocked(
  occ: Uint8Array,
  width: number,
  height: number,
  poly: [number, number][],
): void {
  if (poly.length < 3) return
  // Build a "walkable inside" mask via even-odd fill, then invert.
  const inside = new Uint8Array(width * height)
  rasterPolygonFill(inside, width, height, poly, 1)
  for (let i = 0; i < occ.length; i++) {
    if (!inside[i]) occ[i] = 1
  }
}

// ---------------------------------------------------------------------------
// Door mouth rectangle
// ---------------------------------------------------------------------------

/**
 * Punch a door opening. The mouth is the segment between the two
 * jambs; we clear a rectangle centred on the mouth with
 * `overClearCells` half-thickness perpendicular to the mouth direction
 * so the path can slip through the wall's dilated buffer.
 */
function punchDoor(
  occ: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  overClearCells: number,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy)
  if (len === 0) return
  // Perpendicular unit vector so we can extrude a rectangle either side.
  const nx = -dy / len
  const ny = dx / len
  const r = Math.max(1, overClearCells)
  const corners: [number, number][] = [
    [x0 + nx * r, y0 + ny * r],
    [x1 + nx * r, y1 + ny * r],
    [x1 - nx * r, y1 - ny * r],
    [x0 - nx * r, y0 - ny * r],
  ]
  rasterPolygonFill(occ, width, height, corners, 0)
}

// ---------------------------------------------------------------------------
// Distance transform (2-pass Chamfer / Meijster)
// ---------------------------------------------------------------------------

/**
 * Compute a Euclidean-ish distance transform in METERS. Uses the
 * Meijster O(N) two-pass algorithm — fast and gives exact Euclidean
 * distances (unlike a chamfer / Manhattan approximation). Every cell
 * gets the distance to the nearest blocked cell; distances are
 * multiplied by `cellSize` so the field is in metres.
 *
 * The routing post-process reads this to (a) reject waypoints too
 * close to walls and (b) nudge waypoints toward corridor centres.
 */
export function buildDistanceTransform(grid: CompiledGrid): void {
  const { occ, width, height, cellSize } = grid
  const INF = width + height
  // Pass 1: for each column, distance to the nearest obstacle above/below.
  const g = new Int32Array(width * height)
  for (let x = 0; x < width; x++) {
    // Top-down.
    g[x] = occ[x] ? 0 : INF
    for (let y = 1; y < height; y++) {
      const i = y * width + x
      g[i] = occ[i] ? 0 : 1 + g[i - width]
    }
    // Bottom-up.
    for (let y = height - 2; y >= 0; y--) {
      const i = y * width + x
      if (g[i + width] + 1 < g[i]) g[i] = g[i + width] + 1
    }
  }
  // Pass 2: for each row, the exact Euclidean transform of the
  // column-wise distances via the "lower envelope of parabolas" trick.
  const dist = new Float32Array(width * height)
  const s = new Int32Array(width)
  const t = new Int32Array(width)
  const f = (x: number, i: number, gRow: Int32Array): number => {
    const d = x - i
    return d * d + gRow[i] * gRow[i]
  }
  const sep = (i: number, u: number, gRow: Int32Array): number => {
    return Math.floor((u * u - i * i + gRow[u] * gRow[u] - gRow[i] * gRow[i]) / (2 * (u - i)))
  }
  const gRow = new Int32Array(width)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) gRow[x] = g[y * width + x]
    let q = 0
    s[0] = 0
    t[0] = 0
    for (let u = 1; u < width; u++) {
      while (q >= 0 && f(t[q], s[q], gRow) > f(t[q], u, gRow)) q--
      if (q < 0) {
        q = 0
        s[0] = u
      } else {
        const w = 1 + sep(s[q], u, gRow)
        if (w < width) {
          q++
          s[q] = u
          t[q] = w
        }
      }
    }
    for (let u = width - 1; u >= 0; u--) {
      dist[y * width + u] = Math.sqrt(f(u, s[q], gRow)) * cellSize
      if (u === t[q]) q--
    }
  }
  grid.dist = dist
}

// ---------------------------------------------------------------------------
// Public: compile a routing scene
// ---------------------------------------------------------------------------

export interface CompileOptions {
  agentRadiusMeters: number
  cellSizeMeters: number
  paddingMeters: number
  /** Snap start/end anchors from the caller so the bbox always covers them. */
  start: [number, number]
  end: [number, number]
  /** When true, populate `dist` in the returned grid. */
  withDistanceTransform?: boolean
  /** When true, populate `wall` in the returned grid. */
  withWallMask?: boolean
  /** More lng/lat points the grid must cover (beyond start / end). */
  include?: ReadonlyArray<[number, number]>
  /** Building axis (maths degrees). Omitted → found from the walls. */
  axisDeg?: number
}

export function compileScene(scene: RoutingScene, opts: CompileOptions): CompiledGrid {
  const samples = collectSamples(scene, opts.start, opts.end, opts.include)
  const anchor = pickAnchor(samples)
  const frame = makeLocalFrame(anchor, opts.axisDeg ?? sceneAxisDeg(scene, anchor))

  // Project every sample to local metres to find the bbox.
  const localSamples: [number, number][] = samples.map((ll) => toLocal(frame, ll))
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, y] of localSamples) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const pad = Math.max(0, opts.paddingMeters)
  minX -= pad
  maxX += pad
  minY -= pad
  maxY += pad

  const cellSize = Math.max(0.05, opts.cellSizeMeters)
  const width = Math.max(2, Math.ceil((maxX - minX) / cellSize))
  const height = Math.max(2, Math.ceil((maxY - minY) / cellSize))
  const occ = new Uint8Array(width * height)

  const grid: CompiledGrid = {
    frame,
    width,
    height,
    cellSize,
    originX: minX,
    originY: minY,
    occ,
  }

  // Helper: local metres → fractional cell index.
  const toCell = (ll: [number, number]): [number, number] => {
    const [x, y] = toLocal(frame, ll)
    return [(x - minX) / cellSize, (y - minY) / cellSize]
  }

  // Pass 1: bounds — anything outside is blocked.
  if (scene.bounds && scene.bounds.vertices.length >= 3) {
    const ring: [number, number][] = scene.bounds.vertices.map(toCell)
    markOutsidePolygonBlocked(occ, width, height, ring)
  }

  // Pass 2: obstacles — filled polygons.
  const agentRadius = Math.max(0, opts.agentRadiusMeters)
  const agentRadiusCells = agentRadius / cellSize
  for (const ob of scene.obstacles ?? []) {
    if (ob.vertices.length < 3) continue
    const ring: [number, number][] = ob.vertices.map(toCell)
    rasterPolygonFill(occ, width, height, ring, 1)
    // Dilate: sweep the outline as a thick segment set (Minkowski
    // sum by a disc of `agentRadiusCells`). Cheaper than a full
    // distance transform when there are few polygons; correct because
    // we've already filled the interior.
    if (agentRadiusCells > 0) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i]
        const [bx, by] = ring[(i + 1) % ring.length]
        rasterSegment(occ, width, height, ax, ay, bx, by, agentRadiusCells, 1)
      }
    }
  }

  // Pass 3: walls — polylines thickened by wallThickness/2 + agentRadius.
  const wall = opts.withWallMask ? new Uint8Array(width * height) : undefined
  for (const w of scene.walls ?? []) {
    const halfThickness = ((w.thicknessMeters ?? 0.3) / 2) / cellSize
    const dilate = halfThickness + agentRadiusCells
    const cells = w.vertices.map(toCell)
    for (let i = 0; i + 1 < cells.length; i++) {
      const [ax, ay] = cells[i]
      const [bx, by] = cells[i + 1]
      rasterSegment(occ, width, height, ax, ay, bx, by, dilate, 1)
      if (wall) rasterSegment(wall, width, height, ax, ay, bx, by, dilate, 1)
    }
  }
  if (wall) grid.wall = wall

  // Pass 4: doors — punch openings back out of the walls. The punch
  // rectangle's PERPENDICULAR half-width has to cover:
  //     (widest wall's half-thickness) + agentRadius
  // Otherwise the residual wall-dilation on each side of the door
  // narrows the passage below the agent's diameter and the router
  // sees a closed door. This bit us in early testing — a nominally
  // 0.9 m door in a 0.3 m wall produced a 0.15 m-wide gap after
  // dilation, small enough to be flagged 'unreachable' even though
  // the door is clearly walkable in the real scene.
  const maxWallHalf = ((scene.walls ?? []).reduce(
    (m, w) => Math.max(m, w.thicknessMeters ?? 0.3),
    0.3,
  )) / 2
  const defaultOverClear = maxWallHalf + agentRadius
  grid.doors = []
  grid.doorDepthCells = defaultOverClear / cellSize
  for (const door of scene.doors ?? []) {
    const overClearMeters = Math.max(
      door.overClearMeters ?? defaultOverClear,
      defaultOverClear,
      cellSize,
    )
    const overClearCells = overClearMeters / cellSize
    const [ax, ay] = toCell(door.vertices[0])
    const [bx, by] = toCell(door.vertices[1])
    punchDoor(occ, width, height, ax, ay, bx, by, overClearCells)
    if (wall) punchDoor(wall, width, height, ax, ay, bx, by, overClearCells)
    grid.doors.push({ a: [ax, ay], b: [bx, by] })
  }

  if (opts.withDistanceTransform) buildDistanceTransform(grid)

  return grid
}

// ---------------------------------------------------------------------------
// Public: cell ↔ world conversions (used by the router + postprocess)
// ---------------------------------------------------------------------------

/** Fractional cell index → local metres (cell CENTRE for integer inputs). */
export function cellToLocal(grid: CompiledGrid, cx: number, cy: number): [number, number] {
  return [grid.originX + (cx + 0.5) * grid.cellSize, grid.originY + (cy + 0.5) * grid.cellSize]
}

/** Lng/lat → integer cell, clamped to grid bounds. */
export function llToCell(grid: CompiledGrid, ll: [number, number]): [number, number] {
  const [x, y] = toLocal(grid.frame, ll)
  const cx = Math.floor((x - grid.originX) / grid.cellSize)
  const cy = Math.floor((y - grid.originY) / grid.cellSize)
  return [
    Math.max(0, Math.min(grid.width - 1, cx)),
    Math.max(0, Math.min(grid.height - 1, cy)),
  ]
}

/** Integer cell → lng/lat (cell centre). */
export function cellToLl(grid: CompiledGrid, cx: number, cy: number): [number, number] {
  return fromLocal(grid.frame, cellToLocal(grid, cx, cy))
}

/** `occ[y * width + x]` accessor with bounds check. Blocked when out-of-range. */
export function isBlocked(grid: CompiledGrid, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return true
  return grid.occ[cy * grid.width + cx] === 1
}
