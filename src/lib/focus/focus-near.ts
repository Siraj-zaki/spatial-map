/**
 * Focus mode — the NEAR column: what stands right next to the focused
 * item, so it fades (`FOCUS_FACTOR.near`) instead of crowding it.
 *
 * Only two things fade while an item is focused: the line-of-sight
 * blockers (`focus-blockers.ts`, 'ghost') and this column ('near').
 * Everything else stays exactly as drawn.
 *
 * The column is the item's footprint (or its anchor, for a point item)
 * grown by `FOCUS_NEAR_RADIUS_M` horizontally. The item's floor is
 * `F = resolved.floorPlanId`; its elevation `floorElev` comes from that
 * floor plan (else the highest plan at or below the item, else 0), and
 * `nextFloorElev` is the lowest plan more than half a metre above it.
 *
 *  - **Solids** (polygons, circles, walls, stairs, rack cells — one prism
 *    each from `buildOccluders`, holes included) are tested in this order,
 *    first match wins:
 *     1. FLAT — rendered height under `FOCUS_NEAR_VOLUMETRIC_MIN_M`
 *        (floor / room tints, thin plates): never near.
 *     2. INTERSECTING — the prism contains the anchor or touches the
 *        item's footprint, its base is at or below the item and its top
 *        (a dome / taper's surface height over the anchor) is above it
 *        by `FOCUS_NEAR_INTERSECT_EPS_M`: near. The carousel dome a bag
 *        sits inside fades even though it barely rises above the bag.
 *     3. Farther than the radius from the footprint: skip.
 *     4. On a LOWER floor, or not rising above the item floor's own deck
 *        (`FOCUS_NEAR_FLOOR_DECK_M`): never near.
 *     5. SAME floor (same floor plan; or, with either unknown, a base in
 *        the item floor's band): near, whether its top is above or below
 *        the item — the belt around a carousel, the rack beside a bin —
 *        as long as it is also within the radius in 3D: of the item's
 *        altitude (point items) or of one of its own solids, horizontally
 *        and vertically. Without that, focusing a roof canopy would fade
 *        every seat 10 m beneath it.
 *     6. ABOVE — top above the item by more than the occlusion test's own
 *        tolerance (other floors, overhangs): near.
 *    Floor-plan rasters never join (a raster only gets a cut-out, and only
 *    as a blocker), nor do the item's own prisms.
 *  - **Point items** (markers, text labels, models, image planes, doors —
 *    a door by its opening midpoint) join when their anchor lies within
 *    the radius horizontally and at or above `altitudeM −
 *    FOCUS_NEAR_BELOW_M`. Data-link symbols use `isFocusNearPoint` with
 *    the same rule.
 *
 * Footprints are even-odd over all their rings on both sides (a closed
 * wall loop's open middle is not part of it), and a big footprint's
 * edges sit in a uniform grid so a 700-vertex roof band only measures
 * the edges near each candidate.
 *
 * Computed once per focus, not per frame: `computeFocusNear` is cached on
 * the `ResolvedFocus` object (checked against the prism list and every
 * shape array it reads), and `useFocusNear` hands back the same object
 * while its `key` is unchanged — safe as a memo dependency. Pure apart
 * from that cache; it never touches the map, and occluder inputs and
 * prism lists are only read.
 *
 * Must not import `focus-scene.ts` (which imports this module).
 */

import mapboxgl from 'mapbox-gl'
import { useMemo } from 'react'

import {
  collectPrismsInBox,
  occluderIndexFor,
  prismContainsPoint,
  SELF_SURFACE_TOLERANCE_M,
  type OccluderPrism,
} from '@/lib/occluder-index'
import { fillTapers } from '@/lib/sloped-mesh'

import { isOwnPrismKey, type FocusShapeKind, type FocusShapes, type ResolvedFocus } from './focus-target'

/** Horizontal reach of the NEAR column around the item's footprint, metres. */
export const FOCUS_NEAR_RADIUS_M = 5
/** Point items this far below the item's altitude still count as near, metres. */
export const FOCUS_NEAR_BELOW_M = 0.5
/** Solids with a rendered height below this are flat (floor tints, plates) and never near, metres. */
export const FOCUS_NEAR_VOLUMETRIC_MIN_M = 0.2
/** An intersecting solid must rise this far above the item to be near, metres. */
export const FOCUS_NEAR_INTERSECT_EPS_M = 0.05
/** A solid must rise this far above the item floor's elevation to be near, metres (the deck itself never is). */
export const FOCUS_NEAR_FLOOR_DECK_M = 0.1
/** Floor plans closer than this in elevation are the same floor; a lower floor is below by more, metres. */
export const FOCUS_NEAR_FLOOR_BAND_M = 0.5

export interface FocusNearRegion {
  /** The item's anchor, [lng, lat]. */
  position: [number, number]
  /**
   * Open [lng, lat] rings, even-odd over all of them (holes allowed);
   * null = a point item (the column is a disc around `position`).
   */
  footprint: ReadonlyArray<ReadonlyArray<readonly [number, number]>> | null
  altitudeM: number
  radiusM: number
  /** The item's occlusion sample positions, [lng, lat] ([position] for a point item). */
  samples: ReadonlyArray<readonly [number, number]>
}
export interface FocusNear {
  /** `resolved.key` this was computed for ('' for NO_NEAR). */
  focusKey: string
  /**
   * '' only for NO_NEAR and for a target that has no column (a floor
   * plan). Otherwise `${focusKey}@lng,lat,alt[,w,s,e,n][,rR]` + one
   * `|tag:ids` segment per non-empty set (sorted). Equal keys ⇔ equal
   * content.
   */
  key: string
  /** null = no column (NO_NEAR, a floor-plan target). */
  region: FocusNearRegion | null
  polygons: ReadonlySet<number>
  circles: ReadonlySet<number>
  lines: ReadonlySet<number>
  stairs: ReadonlySet<number>
  grids: ReadonlySet<number>
  /** `${gridId}:${row}:${col}:${level}` */
  gridCells: ReadonlySet<string>
  markers: ReadonlySet<number>
  textLabels: ReadonlySet<number>
  doors: ReadonlySet<number>
  models: ReadonlySet<number>
  imagePlanes: ReadonlySet<number>
}

const NO_IDS: ReadonlySet<number> = new Set()
const NO_CELLS: ReadonlySet<string> = new Set()

export const NO_NEAR: FocusNear = Object.freeze({
  focusKey: '',
  key: '',
  region: null,
  polygons: NO_IDS,
  circles: NO_IDS,
  lines: NO_IDS,
  stairs: NO_IDS,
  grids: NO_IDS,
  gridCells: NO_CELLS,
  markers: NO_IDS,
  textLabels: NO_IDS,
  doors: NO_IDS,
  models: NO_IDS,
  imagePlanes: NO_IDS,
})

/** The near ids of `kind`; a shared empty set for floor plans (never near). */
export function nearIdsOf(near: FocusNear, kind: FocusShapeKind): ReadonlySet<number> {
  switch (kind) {
    case 'markers':
      return near.markers
    case 'polygons':
      return near.polygons
    case 'circles':
      return near.circles
    case 'lines':
      return near.lines
    case 'stairs':
      return near.stairs
    case 'grids':
      return near.grids
    case 'text-labels':
      return near.textLabels
    case 'doors':
      return near.doors
    case 'models':
      return near.models
    case 'image-planes':
      return near.imagePlanes
    default:
      return NO_IDS
  }
}

// ---------------------------------------------------------------------------
// Geometry (Mercator x / y; exact, no projection shortcuts)

type XY = readonly [number, number]

/** Edges of an even-odd footprint: a uniform grid (distance) and y-bands (parity). */
interface EdgeIndex {
  /** Edge e runs (ax[e], ay[e]) → (bx[e], by[e]) — previous vertex → vertex, as the ring tests pair them. */
  ax: Float64Array
  ay: Float64Array
  bx: Float64Array
  by: Float64Array
  n: number
  // uniform grid
  gx0: number
  gy0: number
  ginv: number
  cols: number
  rows: number
  gstart: Int32Array
  gitems: Int32Array
  stamp: Uint32Array
  gen: number
  // y-bands
  y0: number
  y1: number
  binv: number
  bands: number
  bstart: Int32Array
  bitems: Int32Array
}

/** A region in Mercator units, built once per region object. */
interface Prepared {
  px: number
  py: number
  /** Radius in Mercator units at the anchor's latitude. */
  r: number
  r2: number
  /** Footprint rings in Mercator (even-odd), or null for a point region. */
  rings: XY[][] | null
  /** The footprint's edges (null for a point region). */
  E: EdgeIndex | null
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function finite(n: unknown, fallback = 0): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function toMerc(lng: number, lat: number): XY {
  const m = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], 0)
  return [m.x, m.y]
}

/** Squared distance from (x, y) to the closed segment a→b. */
function pointSegDist2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const ex = ax + t * dx - x
  const ey = ay + t * dy - y
  return ex * ex + ey * ey
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

/** Closed segments a→b and c→d intersect (touching and collinear overlap included). */
function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = orient(cx, cy, dx, dy, ax, ay)
  const d2 = orient(cx, cy, dx, dy, bx, by)
  const d3 = orient(ax, ay, bx, by, cx, cy)
  const d4 = orient(ax, ay, bx, by, dx, dy)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  const on = (px: number, py: number, qx: number, qy: number, sx: number, sy: number) =>
    Math.min(px, qx) <= sx && sx <= Math.max(px, qx) && Math.min(py, qy) <= sy && sy <= Math.max(py, qy)
  if (d1 === 0 && on(cx, cy, dx, dy, ax, ay)) return true
  if (d2 === 0 && on(cx, cy, dx, dy, bx, by)) return true
  if (d3 === 0 && on(ax, ay, bx, by, cx, cy)) return true
  if (d4 === 0 && on(ax, ay, bx, by, dx, dy)) return true
  return false
}

/** Squared distance between the closed segments a→b and c→d (0 when they meet). */
function segSegDist2(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0
  return Math.min(
    pointSegDist2(ax, ay, cx, cy, dx, dy),
    pointSegDist2(bx, by, cx, cy, dx, dy),
    pointSegDist2(cx, cy, ax, ay, bx, by),
    pointSegDist2(dx, dy, ax, ay, bx, by),
  )
}

/** Grid cells beyond this count grow the cell size instead (a huge footprint with a tiny radius). */
const MAX_GRID_CELLS = 1 << 18

function buildEdgeIndex(rings: ReadonlyArray<ReadonlyArray<XY>>, cellSize: number): EdgeIndex | null {
  let n = 0
  for (const r of rings) n += r.length
  if (n === 0) return null
  const ax = new Float64Array(n)
  const ay = new Float64Array(n)
  const bx = new Float64Array(n)
  const by = new Float64Array(n)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let e = 0
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      ax[e] = r[j][0]
      ay[e] = r[j][1]
      bx[e] = r[i][0]
      by[e] = r[i][1]
      if (r[i][0] < minX) minX = r[i][0]
      if (r[i][0] > maxX) maxX = r[i][0]
      if (r[i][1] < minY) minY = r[i][1]
      if (r[i][1] > maxY) maxY = r[i][1]
      e++
    }
  }
  const w = maxX - minX
  const h = maxY - minY
  let cell = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : Math.max(w, h, 1e-12)
  if ((w / cell + 1) * (h / cell + 1) > MAX_GRID_CELLS) cell = Math.sqrt((w * h) / MAX_GRID_CELLS) + Math.max(w, h) / 512
  if (!(cell > 0)) cell = 1e-12
  const cols = Math.max(1, Math.floor(w / cell) + 1)
  const rows = Math.max(1, Math.floor(h / cell) + 1)
  const ginv = 1 / cell
  const cx = (x: number) => {
    const k = Math.floor((x - minX) * ginv)
    return k < 0 ? 0 : k >= cols ? cols - 1 : k
  }
  const cy = (y: number) => {
    const k = Math.floor((y - minY) * ginv)
    return k < 0 ? 0 : k >= rows ? rows - 1 : k
  }
  const gstart = new Int32Array(cols * rows + 1)
  for (let k = 0; k < n; k++) {
    const x0 = cx(Math.min(ax[k], bx[k]))
    const x1 = cx(Math.max(ax[k], bx[k]))
    const y0 = cy(Math.min(ay[k], by[k]))
    const y1 = cy(Math.max(ay[k], by[k]))
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) gstart[yy * cols + xx + 1]++
  }
  for (let c = 0; c < cols * rows; c++) gstart[c + 1] += gstart[c]
  const gitems = new Int32Array(gstart[cols * rows])
  const gfill = gstart.slice(0, cols * rows)
  for (let k = 0; k < n; k++) {
    const x0 = cx(Math.min(ax[k], bx[k]))
    const x1 = cx(Math.max(ax[k], bx[k]))
    const y0 = cy(Math.min(ay[k], by[k]))
    const y1 = cy(Math.max(ay[k], by[k]))
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) gitems[gfill[yy * cols + xx]++] = k
  }
  // y-bands for the parity test (same monotone band function as occluder-index).
  const bands = Math.max(1, n >> 2)
  const binv = h > 0 ? bands / h : 0
  const band = (y: number) => {
    const k = Math.floor((y - minY) * binv)
    if (!(k > 0)) return 0
    return k < bands ? k : bands - 1
  }
  const bstart = new Int32Array(bands + 1)
  for (let k = 0; k < n; k++) {
    const k1 = band(Math.max(ay[k], by[k]))
    for (let b = band(Math.min(ay[k], by[k])); b <= k1; b++) bstart[b + 1]++
  }
  for (let b = 0; b < bands; b++) bstart[b + 1] += bstart[b]
  const bitems = new Int32Array(bstart[bands])
  const bfill = bstart.slice(0, bands)
  for (let k = 0; k < n; k++) {
    const k1 = band(Math.max(ay[k], by[k]))
    for (let b = band(Math.min(ay[k], by[k])); b <= k1; b++) bitems[bfill[b]++] = k
  }
  return {
    ax,
    ay,
    bx,
    by,
    n,
    gx0: minX,
    gy0: minY,
    ginv,
    cols,
    rows,
    gstart,
    gitems,
    stamp: new Uint32Array(n),
    gen: 0,
    y0: minY,
    y1: maxY,
    binv,
    bands,
    bstart,
    bitems,
  }
}

/** Even-odd over every ring of the indexed footprint (only band(y)'s edges are read). */
function insideFootprint(E: EdgeIndex, x: number, y: number): boolean {
  if (y < E.y0 || y > E.y1) return false
  let b = Math.floor((y - E.y0) * E.binv)
  if (!(b > 0)) b = 0
  else if (b >= E.bands) b = E.bands - 1
  let inside = false
  for (let k = E.bstart[b], end = E.bstart[b + 1]; k < end; k++) {
    const e = E.bitems[k]
    const xi = E.bx[e]
    const yi = E.by[e]
    const xj = E.ax[e]
    const yj = E.ay[e]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Calls `test(e)` for every footprint edge whose grid cells overlap the box
 * [x0 − pad, x1 + pad] × [y0 − pad, y1 + pad] (each edge at most once);
 * true as soon as one returns true.
 */
function someEdgeNear(
  E: EdgeIndex,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pad: number,
  test: (e: number) => boolean,
): boolean {
  const ix0 = Math.max(0, Math.floor((x0 - pad - E.gx0) * E.ginv))
  const ix1 = Math.min(E.cols - 1, Math.floor((x1 + pad - E.gx0) * E.ginv))
  const iy0 = Math.max(0, Math.floor((y0 - pad - E.gy0) * E.ginv))
  const iy1 = Math.min(E.rows - 1, Math.floor((y1 + pad - E.gy0) * E.ginv))
  if (!(ix0 <= ix1 && iy0 <= iy1)) return false
  E.gen = (E.gen + 1) >>> 0
  if (E.gen === 0) {
    E.stamp.fill(0)
    E.gen = 1
  }
  const gen = E.gen
  for (let yy = iy0; yy <= iy1; yy++) {
    for (let xx = ix0; xx <= ix1; xx++) {
      const c = yy * E.cols + xx
      for (let k = E.gstart[c], end = E.gstart[c + 1]; k < end; k++) {
        const e = E.gitems[k]
        if (E.stamp[e] === gen) continue
        E.stamp[e] = gen
        if (test(e)) return true
      }
    }
  }
  return false
}

const preparedCache = new WeakMap<FocusNearRegion, Prepared | null>()

/** The region in Mercator, or null when its anchor isn't finite. */
function prepare(region: FocusNearRegion): Prepared | null {
  const hit = preparedCache.get(region)
  if (hit !== undefined) return hit
  let out: Prepared | null = null
  const [lng, lat] = region.position
  const radiusM = finite(region.radiusM, FOCUS_NEAR_RADIUS_M)
  if (Number.isFinite(lng) && Number.isFinite(lat) && radiusM >= 0) {
    const anchor = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], 0)
    const r = radiusM * anchor.meterInMercatorCoordinateUnits()
    let rings: XY[][] | null = null
    let minX = anchor.x
    let minY = anchor.y
    let maxX = anchor.x
    let maxY = anchor.y
    if (region.footprint && region.footprint.length > 0) {
      rings = []
      minX = Infinity
      minY = Infinity
      maxX = -Infinity
      maxY = -Infinity
      for (const src of region.footprint) {
        const ring: XY[] = []
        for (const v of src) {
          if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) continue
          const m = toMerc(v[0], v[1])
          ring.push(m)
          if (m[0] < minX) minX = m[0]
          if (m[0] > maxX) maxX = m[0]
          if (m[1] < minY) minY = m[1]
          if (m[1] > maxY) maxY = m[1]
        }
        if (ring.length > 0) rings.push(ring)
      }
      if (rings.length === 0) {
        rings = null
        minX = maxX = anchor.x
        minY = maxY = anchor.y
      }
    }
    if (Number.isFinite(r)) {
      const E = rings ? buildEdgeIndex(rings, r) : null
      out = { px: anchor.x, py: anchor.y, r, r2: r * r, rings, E, minX, minY, maxX, maxY }
    }
  }
  preparedCache.set(region, out)
  return out
}

/** Horizontal: (x, y) within the radius of the region (inside the footprint = 0). */
function pointWithin(P: Prepared, x: number, y: number): boolean {
  const r = P.r
  if (x < P.minX - r || x > P.maxX + r || y < P.minY - r || y > P.maxY + r) return false
  const E = P.E
  if (!E) {
    const dx = x - P.px
    const dy = y - P.py
    return dx * dx + dy * dy <= P.r2
  }
  if (insideFootprint(E, x, y)) return true
  const r2 = P.r2
  return someEdgeNear(E, x, y, x, y, r, (e) => pointSegDist2(x, y, E.ax[e], E.ay[e], E.bx[e], E.by[e]) <= r2)
}

function prismIsFinite(p: OccluderPrism): boolean {
  if (!Number.isFinite(p.baseM) || !Number.isFinite(p.topM)) return false
  for (const v of p.ring) if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return false
  if (p.holes) for (const h of p.holes) for (const v of h) if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return false
  return true
}

/**
 * The prism's footprint (ring + holes, even-odd) within √limit2 of the
 * region (Mercator²; 0 = touching). Overlap or containment either way
 * counts as distance 0. Point region: distance to the anchor.
 */
function prismWithin(P: Prepared, p: OccluderPrism, limit2: number): boolean {
  const pad = Math.sqrt(limit2)
  if (p.minX > P.maxX + pad || p.maxX < P.minX - pad || p.minY > P.maxY + pad || p.maxY < P.minY - pad) return false
  if (p.ring.length === 0) return false
  const rings: ReadonlyArray<ReadonlyArray<XY>> = p.holes && p.holes.length > 0 ? [p.ring, ...p.holes] : [p.ring]
  if (!P.E || !P.rings) {
    if (p.ring.length >= 3 && prismContainsPoint(p, P.px, P.py)) return true
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (pointSegDist2(P.px, P.py, ring[j][0], ring[j][1], ring[i][0], ring[i][1]) <= limit2) return true
      }
    }
    return false
  }
  const E = P.E
  // With no boundary contact, every ring lies wholly on one side of the
  // other footprint, so one vertex per ring decides containment.
  for (const ring of rings) if (ring.length >= 3 && insideFootprint(E, ring[0][0], ring[0][1])) return true
  if (p.ring.length >= 3) {
    for (const fr of P.rings) if (fr.length > 0 && prismContainsPoint(p, fr[0][0], fr[0][1])) return true
  }
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const cx = ring[j][0]
      const cy = ring[j][1]
      const dx = ring[i][0]
      const dy = ring[i][1]
      const hit = someEdgeNear(E, Math.min(cx, dx), Math.min(cy, dy), Math.max(cx, dx), Math.max(cy, dy), pad, (e) =>
        segSegDist2(E.ax[e], E.ay[e], E.bx[e], E.by[e], cx, cy, dx, dy) <= limit2,
      )
      if (hit) return true
    }
  }
  return false
}

/** One of the focused item's own solids, prepared for `prismWithin`. */
interface OwnSolid {
  P: Prepared
  baseM: number
  topM: number
}

/**
 * The item's own prisms (a polygon, a wall's slices, a stair's steps, a
 * rack cell). Empty for point items. Collected from the footprint box
 * before the candidate query (`collectPrismsInBox` isn't re-entrant).
 */
function ownSolids(resolved: ResolvedFocus, prisms: ReadonlyArray<OccluderPrism>, P: Prepared): OwnSolid[] {
  if (resolved.ownPrismKeys.length === 0) return []
  const box: OccluderPrism[] = []
  collectPrismsInBox(occluderIndexFor(prisms), P.minX, P.minY, P.maxX, P.maxY, -Infinity, box)
  const out: OwnSolid[] = []
  for (const p of box) {
    if (!isOwnPrismKey(resolved, p.key) || !prismIsFinite(p) || p.ring.length < 3) continue
    const rings: XY[][] = [p.ring.map((v) => [v[0], v[1]] as XY)]
    if (p.holes) for (const h of p.holes) if (h.length >= 3) rings.push(h.map((v) => [v[0], v[1]] as XY))
    out.push({
      P: {
        px: p.ring[0][0],
        py: p.ring[0][1],
        r: P.r,
        r2: P.r2,
        rings,
        E: buildEdgeIndex(rings, P.r),
        minX: p.minX,
        minY: p.minY,
        maxX: p.maxX,
        maxY: p.maxY,
      },
      baseM: p.baseM,
      topM: p.topM,
    })
  }
  return out
}

/**
 * `p` within `radiusM` of the item in 3D: of one of its own solids (both
 * horizontally and vertically), or — a point item — of its altitude.
 */
function adjacent3D(own: readonly OwnSolid[], altitudeM: number, radiusM: number, p: OccluderPrism): boolean {
  if (own.length === 0) return Math.max(0, p.baseM - altitudeM, altitudeM - p.topM) <= radiusM
  for (const s of own) {
    if (Math.max(0, p.baseM - s.topM, s.baseM - p.topM) > radiusM) continue
    if (prismWithin(s.P, p, s.P.r2)) return true
  }
  return false
}

/**
 * The point rule: `elevationM ≥ altitudeM − FOCUS_NEAR_BELOW_M` and the
 * anchor horizontally within the radius of the region (inside the
 * footprint counts as 0). False for a null region.
 */
export function isFocusNearPoint(
  region: FocusNearRegion | null,
  position: readonly [number, number],
  elevationM: number,
): boolean {
  if (!region) return false
  if (!(elevationM >= region.altitudeM - FOCUS_NEAR_BELOW_M)) return false
  const lng = position[0]
  const lat = position[1]
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false
  const P = prepare(region)
  if (!P) return false
  const [x, y] = toMerc(lng, lat)
  return pointWithin(P, x, y)
}

/**
 * Exact horizontal test against the column (no altitude): inside the
 * footprint or within its radius; a disc around the anchor for a point
 * item. For `focus-cutaway.ts`, which cuts big shapes along this column.
 */
export function focusNearRegionContains(region: FocusNearRegion, lng: number, lat: number): boolean {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false
  const [x, y] = toMerc(lng, lat)
  return focusNearRegionContainsMerc(region, x, y)
}

/** `focusNearRegionContains` for a Mercator x / y. */
export function focusNearRegionContainsMerc(region: FocusNearRegion, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  const P = prepare(region)
  return P !== null && pointWithin(P, x, y)
}

// ---------------------------------------------------------------------------
// computeFocusNear

type SolidKind = 'polygons' | 'circles' | 'lines' | 'stairs' | 'grids'

const PRISM_KIND: Readonly<Record<string, SolidKind>> = {
  polygon: 'polygons',
  circle: 'circles',
  line: 'lines',
  stair: 'stairs',
  grid: 'grids',
}

interface SolidRow {
  floorPlanId?: number | null
  config?: { height?: number; topShape?: 'flat' | 'taper' | 'dome'; topScale?: number } | null
}

/** id → row per shape array, built once per array object. */
const rowIndexCache = new WeakMap<readonly object[], Map<number, SolidRow>>()

function rowIndex(rows: readonly object[] | undefined): Map<number, SolidRow> | null {
  if (!rows) return null
  let m = rowIndexCache.get(rows)
  if (!m) {
    m = new Map()
    for (const r of rows as readonly (SolidRow & { id?: number })[]) if (typeof r.id === 'number') m.set(r.id, r)
    rowIndexCache.set(rows, m)
  }
  return m
}

/**
 * The surface height of a dome / taper over Mercator (ax, ay): the
 * radial fraction s = |a − c| / |ring hit along c→a| about the ring's
 * vertex mean c (the mesh's own centre), mapped through the same profile
 * `buildTaperedSolidMesh` sweeps. `p.topM` for a flat-topped row.
 */
function surfaceTopAt(p: OccluderPrism, row: SolidRow | undefined, ax: number, ay: number): number {
  const cfg = row?.config
  if (!cfg || !fillTapers({ topShape: cfg.topShape, height: finite(cfg.height) })) return p.topM
  const ring = p.ring
  if (ring.length < 3) return p.topM
  let cx = 0
  let cy = 0
  for (const v of ring) {
    cx += v[0]
    cy += v[1]
  }
  cx /= ring.length
  cy /= ring.length
  const dx = ax - cx
  const dy = ay - cy
  let s = 0
  if (dx !== 0 || dy !== 0) {
    // Smallest u > 0 with c + u·d on a ring edge: the footprint's edge along c→a.
    let u = Infinity
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ex = ring[i][0] - ring[j][0]
      const ey = ring[i][1] - ring[j][1]
      const den = dx * ey - dy * ex
      if (den === 0) continue
      const qx = ring[j][0] - cx
      const qy = ring[j][1] - cy
      const t = (qx * ey - qy * ex) / den
      const v = (qx * dy - qy * dx) / den
      if (t > 0 && v >= 0 && v <= 1 && t < u) u = t
    }
    s = Number.isFinite(u) ? 1 / u : Infinity
  }
  const ts = Math.max(0, Math.min(1, (cfg.topScale ?? 0) / 100))
  const h = p.topM - p.baseM
  if (s <= ts || ts >= 1) return p.baseM + h
  const f = (s - ts) / (1 - ts)
  if (cfg.topShape === 'dome') return p.baseM + h * Math.sqrt(Math.max(0, 1 - f * f))
  return p.baseM + h * Math.max(0, 1 - s) / (1 - ts)
}

interface MutableNear {
  polygons: Set<number>
  circles: Set<number>
  lines: Set<number>
  stairs: Set<number>
  grids: Set<number>
  gridCells: Set<string>
  markers: Set<number>
  textLabels: Set<number>
  doors: Set<number>
  models: Set<number>
  imagePlanes: Set<number>
}

const ID_SEGMENTS: readonly [Exclude<keyof MutableNear, 'gridCells'>, string][] = [
  ['polygons', 'p'],
  ['circles', 'c'],
  ['lines', 'l'],
  ['stairs', 's'],
  ['grids', 'g'],
]
const POINT_SEGMENTS: readonly [Exclude<keyof MutableNear, 'gridCells'>, string][] = [
  ['markers', 'm'],
  ['textLabels', 't'],
  ['doors', 'd'],
  ['models', 'o'],
  ['imagePlanes', 'ip'],
]

function sortedIds(set: ReadonlySet<number>): string {
  return [...set].sort((a, b) => a - b).join(',')
}

function regionTag(region: FocusNearRegion): string {
  const [lng, lat] = region.position
  let tag = `${lng.toFixed(7)},${lat.toFixed(7)},${region.altitudeM.toFixed(2)}`
  const P = prepare(region)
  if (region.footprint && P && P.rings) {
    // Footprint extent: a reshaped item with the same anchor and the same
    // near sets is still a different column (the data-link symbols test
    // against it).
    const sw = new mapboxgl.MercatorCoordinate(P.minX, P.maxY, 0).toLngLat()
    const ne = new mapboxgl.MercatorCoordinate(P.maxX, P.minY, 0).toLngLat()
    tag += `,${sw.lng.toFixed(7)},${sw.lat.toFixed(7)},${ne.lng.toFixed(7)},${ne.lat.toFixed(7)}`
  }
  if (region.radiusM !== FOCUS_NEAR_RADIUS_M) tag += `,r${region.radiusM}`
  return tag
}

function keyOf(focusKey: string, region: FocusNearRegion, m: MutableNear): string {
  let key = `${focusKey}@${regionTag(region)}`
  for (const [k, tag] of ID_SEGMENTS) if (m[k].size > 0) key += `|${tag}:${sortedIds(m[k])}`
  if (m.gridCells.size > 0) key += `|gc:${[...m.gridCells].sort().join(',')}`
  for (const [k, tag] of POINT_SEGMENTS) if (m[k].size > 0) key += `|${tag}:${sortedIds(m[k])}`
  return key
}

let lastComputeMs = 0

/** Wall time of the last `computeFocusNear` that actually computed (cache hits excluded), ms. */
export function lastFocusNearComputeMs(): number {
  return lastComputeMs
}

interface CacheEntry {
  prisms: ReadonlyArray<OccluderPrism>
  rows: readonly unknown[]
  radiusM: number
  near: FocusNear
}

const nearCache = new WeakMap<ResolvedFocus, CacheEntry>()

/** Every shape array the computation reads — a change to any of them re-runs it. */
function rowsOf(shapes: FocusShapes): readonly unknown[] {
  return [
    shapes.markers,
    shapes.textLabels,
    shapes.doors,
    shapes.models,
    shapes.imagePlanes,
    shapes.polygons,
    shapes.circles,
    shapes.lines,
    shapes.stairs,
    shapes.grids,
    shapes.images,
  ]
}

/** The item floor's elevation and the next floor plan's above it (∞ when none). */
function itemFloor(resolved: ResolvedFocus, shapes: FocusShapes): { elevOf: Map<number, number>; floorElev: number; nextFloorElev: number } {
  const elevOf = new Map<number, number>()
  for (const img of shapes.images ?? []) {
    if (typeof img.id === 'number') elevOf.set(img.id, finite(img.config?.elevation))
  }
  const F = resolved.floorPlanId
  let floorElev: number | undefined = F !== null ? elevOf.get(F) : undefined
  if (floorElev === undefined) {
    let best = -Infinity
    for (const e of elevOf.values()) if (e <= resolved.altitudeM + FOCUS_NEAR_INTERSECT_EPS_M && e > best) best = e
    floorElev = Number.isFinite(best) ? best : 0
  }
  let nextFloorElev = Infinity
  for (const e of elevOf.values()) if (e > floorElev + FOCUS_NEAR_FLOOR_BAND_M && e < nextFloorElev) nextFloorElev = e
  return { elevOf, floorElev, nextFloorElev }
}

function finish(focusKey: string, region: FocusNearRegion, m: MutableNear): FocusNear {
  const pick = <T,>(set: Set<T>, empty: ReadonlySet<T>): ReadonlySet<T> => (set.size > 0 ? set : empty)
  return Object.freeze({
    focusKey,
    key: keyOf(focusKey, region, m),
    region,
    polygons: pick(m.polygons, NO_IDS),
    circles: pick(m.circles, NO_IDS),
    lines: pick(m.lines, NO_IDS),
    stairs: pick(m.stairs, NO_IDS),
    grids: pick(m.grids, NO_IDS),
    gridCells: pick(m.gridCells, NO_CELLS),
    markers: pick(m.markers, NO_IDS),
    textLabels: pick(m.textLabels, NO_IDS),
    doors: pick(m.doors, NO_IDS),
    models: pick(m.models, NO_IDS),
    imagePlanes: pick(m.imagePlanes, NO_IDS),
  })
}

function build(
  resolved: ResolvedFocus,
  prisms: ReadonlyArray<OccluderPrism>,
  shapes: FocusShapes,
  radiusM: number,
): FocusNear {
  const target = resolved.target
  // A floor plan has no column: focusing one fades only its blockers.
  if (target.kind === 'images') return Object.freeze({ ...NO_NEAR, focusKey: resolved.key })
  const samples: (readonly [number, number])[] = []
  for (const smp of resolved.samples) samples.push(Object.freeze([smp.position[0], smp.position[1]] as const))
  const region: FocusNearRegion = Object.freeze({
    position: [resolved.position[0], resolved.position[1]] as [number, number],
    footprint: resolved.footprint,
    altitudeM: resolved.altitudeM,
    radiusM,
    samples: Object.freeze(
      resolved.footprint || samples.length === 0
        ? samples
        : [Object.freeze([resolved.position[0], resolved.position[1]] as const)],
    ),
  })
  const P = prepare(region)
  if (!P) return Object.freeze({ ...NO_NEAR, focusKey: resolved.key })
  const m: MutableNear = {
    polygons: new Set(),
    circles: new Set(),
    lines: new Set(),
    stairs: new Set(),
    grids: new Set(),
    gridCells: new Set(),
    markers: new Set(),
    textLabels: new Set(),
    doors: new Set(),
    models: new Set(),
    imagePlanes: new Set(),
  }

  // ---- solids: box query, then the rule chain (file header) per prism
  if (prisms.length > 0) {
    const alt = resolved.altitudeM
    const F = resolved.floorPlanId
    const { elevOf, floorElev, nextFloorElev } = itemFloor(resolved, shapes)
    const rowsOfKind: Record<SolidKind, Map<number, SolidRow> | null> = {
      polygons: rowIndex(shapes.polygons),
      circles: rowIndex(shapes.circles),
      lines: rowIndex(shapes.lines),
      stairs: rowIndex(shapes.stairs),
      grids: rowIndex(shapes.grids),
    }
    const own = ownSolids(resolved, prisms, P)
    const hits: OccluderPrism[] = []
    collectPrismsInBox(
      occluderIndexFor(prisms),
      P.minX - P.r,
      P.minY - P.r,
      P.maxX + P.r,
      P.maxY + P.r,
      Math.min(floorElev + FOCUS_NEAR_FLOOR_DECK_M, alt + FOCUS_NEAR_INTERSECT_EPS_M),
      hits,
    )
    for (const p of hits) {
      const colon = p.key.indexOf(':')
      const kind = colon > 0 ? PRISM_KIND[p.key.slice(0, colon)] : undefined
      // Floor plans ('image:') never join; nor does the item itself.
      if (!kind || isOwnPrismKey(resolved, p.key)) continue
      const parts = p.key.split(':')
      const id = Number(parts[1])
      if (!Number.isFinite(id)) continue
      const cell = kind === 'grids' && parts.length === 5 ? `${id}:${parts[2]}:${parts[3]}:${parts[4]}` : null
      // Already in: a multi-piece row (circle grid, stair steps, wall slices) needs one hit.
      if (cell === null ? m[kind].has(id) : m.gridCells.has(cell)) continue
      if (!prismIsFinite(p)) continue
      const row = rowsOfKind[kind]?.get(id)
      // 1. FLAT: never near.
      const H =
        kind === 'stairs'
          ? Infinity
          : row && (kind === 'polygons' || kind === 'circles' || kind === 'lines')
            ? finite(row.config?.height)
            : p.topM - p.baseM
      if (!(H >= FOCUS_NEAR_VOLUMETRIC_MIN_M)) continue
      // 2. INTERSECTING: contains the anchor / touches the footprint, spans the item's altitude.
      let near = false
      if (p.baseM <= alt && p.topM > alt + FOCUS_NEAR_INTERSECT_EPS_M) {
        const topAt = kind === 'polygons' || kind === 'circles' ? surfaceTopAt(p, row, P.px, P.py) : p.topM
        if (
          topAt > alt + FOCUS_NEAR_INTERSECT_EPS_M &&
          (prismContainsPoint(p, P.px, P.py) || (P.rings !== null && prismWithin(P, p, 0)))
        ) {
          near = true
        }
      }
      if (!near) {
        // 4. LOWER floor, or the item floor's own deck: never near.
        const rowFloor = typeof row?.floorPlanId === 'number' ? row.floorPlanId : null
        const rowElev = rowFloor !== null ? elevOf.get(rowFloor) : undefined
        if (rowElev !== undefined && rowElev < floorElev - FOCUS_NEAR_FLOOR_BAND_M) continue
        if (p.topM <= floorElev + FOCUS_NEAR_FLOOR_DECK_M) continue
        // 5. SAME floor, top above or below the item; 6. ABOVE it.
        const sameFloor =
          rowFloor !== null && F !== null
            ? rowFloor === F
            : floorElev - FOCUS_NEAR_FLOOR_BAND_M <= p.baseM && p.baseM < nextFloorElev
        const above = p.topM > alt + SELF_SURFACE_TOLERANCE_M
        if (!sameFloor && !above) continue
        // 3. within the radius (checked last: the skips above are cheaper).
        if (!prismWithin(P, p, P.r2)) continue
        // 5b. A SAME-floor neighbour that isn't above the item must also be
        // within the radius of it in 3D — the stands 10 m under a roof
        // canopy sit inside its footprint but nowhere near it.
        if (!above && !adjacent3D(own, alt, radiusM, p)) continue
      }
      m[kind].add(id)
      if (cell !== null) m.gridCells.add(cell)
    }
  }

  // ---- point items: anchor within the radius, at or above the item's foot
  const minElevation = resolved.altitudeM - FOCUS_NEAR_BELOW_M
  const isTarget = (kind: FocusShapeKind, id: number) => target.kind === kind && target.id === id
  const scan = <R extends { id?: number; position: [number, number]; config: { elevation?: number } }>(
    rows: readonly R[] | undefined,
    kind: FocusShapeKind,
    into: Set<number>,
  ) => {
    for (const row of rows ?? []) {
      const id = row.id
      if (typeof id !== 'number' || isTarget(kind, id)) continue
      if (!(Math.max(0, finite(row.config?.elevation)) >= minElevation)) continue
      const lng = row.position?.[0]
      const lat = row.position?.[1]
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
      const [x, y] = toMerc(lng, lat)
      if (pointWithin(P, x, y)) into.add(id)
    }
  }
  scan(shapes.markers, 'markers', m.markers)
  scan(shapes.textLabels, 'text-labels', m.textLabels)
  scan(shapes.models, 'models', m.models)
  scan(shapes.imagePlanes, 'image-planes', m.imagePlanes)
  for (const d of shapes.doors ?? []) {
    if (typeof d.id !== 'number' || isTarget('doors', d.id)) continue
    const [v0, v1] = d.vertices ?? []
    if (!v0 || !v1) continue
    if (!(finite(d.config?.elevation) >= minElevation)) continue
    const lng = (v0[0] + v1[0]) / 2
    const lat = (v0[1] + v1[1]) / 2
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    const [x, y] = toMerc(lng, lat)
    if (pointWithin(P, x, y)) m.doors.add(d.id)
  }

  return finish(resolved.key, region, m)
}

/**
 * The NEAR column for `resolved` (rules in the file header). Cached on the
 * `resolved` object: the same prism list, shape arrays and radius return
 * the same `FocusNear` without recomputing. A floor-plan target
 * gets `{ ...NO_NEAR, focusKey }` (no column, key '').
 */
export function computeFocusNear(
  resolved: ResolvedFocus,
  prisms: ReadonlyArray<OccluderPrism>,
  shapes: FocusShapes,
  radiusM: number = FOCUS_NEAR_RADIUS_M,
): FocusNear {
  const rows = rowsOf(shapes)
  const hit = nearCache.get(resolved)
  if (
    hit &&
    hit.prisms === prisms &&
    hit.radiusM === radiusM &&
    hit.rows.length === rows.length &&
    hit.rows.every((v, i) => v === rows[i])
  ) {
    return hit.near
  }
  const t0 = performance.now()
  const near = build(resolved, prisms, shapes, radiusM)
  lastComputeMs = performance.now() - t0
  nearCache.set(resolved, { prisms, rows, radiusM, near })
  return near
}

/**
 * Canonical objects by key, most recent last: a recompute that lands on
 * the same content (a re-resolved item, a rebuilt prism list) hands back
 * the object already published, so every overlay memo keyed on it holds.
 */
const canonical = new Map<string, FocusNear>()
const CANONICAL_MAX = 8

function canonicalOf(near: FocusNear): FocusNear {
  if (near.key === '') return near
  const prev = canonical.get(near.key)
  if (prev) {
    canonical.delete(near.key)
    canonical.set(near.key, prev)
    return prev
  }
  canonical.set(near.key, near)
  if (canonical.size > CANONICAL_MAX) {
    const oldest = canonical.keys().next().value
    if (oldest !== undefined) canonical.delete(oldest)
  }
  return near
}

/**
 * Host hook: the NEAR column for the focused item, NO_NEAR for null.
 * Recomputed only when `resolved`, `prisms` or the shape arrays change —
 * never on a camera event — and the same object while its `key` is
 * unchanged.
 */
export function useFocusNear(
  resolved: ResolvedFocus | null,
  prisms: ReadonlyArray<OccluderPrism>,
  shapes: FocusShapes,
): FocusNear {
  return useMemo(
    () => (resolved ? canonicalOf(computeFocusNear(resolved, prisms, shapes)) : NO_NEAR),
    [resolved, prisms, shapes],
  )
}
