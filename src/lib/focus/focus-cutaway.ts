/**
 * Focus mode — the local cut-away: a BIG near / blocker shape fades only
 * where it is near the item or in the line of sight, not as a whole.
 *
 * Regions (computed once per focus / camera settle, never per frame):
 *  - **R_item** — the NEAR column (`scene.near.region`): a disc of
 *    `FOCUS_NEAR_RADIUS_M` around a point item, the item's footprint grown
 *    by that radius for an area item.
 *  - **R_pierce(id)** — discs of the same radius where the camera→item
 *    rays pierce blocker `id` (`blockers.pierce`, `focus-blockers.ts`).
 *  A 'near' shape is cut by R_item, a 'ghost' (blocker) by R_item ∪
 *  R_pierce(id). Everything else has no region.
 *
 * Only a shape much larger than a disc is cut (`isCutWorthy`: area over
 * 4πR² or a bbox diagonal over 3R); a small one keeps fading whole, as
 * before. A cut shape becomes two features with the SAME id and shape
 * props — the 'in' piece at the fade tier's opacity / bucket, the 'out'
 * piece as drawn — so click, hover and selection still resolve the shape.
 * Lines split at the region boundary; meshes (domes, tapers, leaning
 * walls) split per triangle by centroid, so their profile is untouched;
 * rack grids fade only the cells in the region (`gridCutPlan`).
 *
 * Everything here is pure, synchronous and cached by input identity +
 * region key: the same focus state hands back the same objects (memo-
 * and diff-writer-safe), and focus off never reaches it (factor 1 →
 * identity). Nothing touches the map.
 */

import {
  buffer as turfBuffer,
  circle as turfCircle,
  difference as turfDifference,
  featureCollection,
  intersect as turfIntersect,
  lineSplit,
  union as turfUnion,
} from '@turf/turf'
import mapboxgl from 'mapbox-gl'

import type { LiftMeshData } from '@/lib/lift-mesh-layer'

import { fadedFeature, fadedOpacity, fadeMeshData, type FadeableProps } from './focus-fade'
import {
  FOCUS_NEAR_RADIUS_M,
  focusNearRegionContainsMerc,
  type FocusNear,
  type FocusNearRegion,
} from './focus-near'
import {
  blockerPierceOf,
  FOCUS_FACTOR,
  focusTier,
  type FocusBlockers,
  type FocusDiscs,
  type FocusScene,
} from './focus-scene'
import type { FocusShapeKind } from './focus-target'

/** A shape is cut only above this footprint area, m² (4 discs' worth). */
export const FOCUS_CUT_MIN_AREA_M2 = 4 * Math.PI * FOCUS_NEAR_RADIUS_M * FOCUS_NEAR_RADIUS_M
/** …or above this bbox diagonal, metres. */
export const FOCUS_CUT_MIN_DIAGONAL_M = 3 * FOCUS_NEAR_RADIUS_M
/** Soft edge of a floor-plan raster's cut-out, metres. */
export const FOCUS_CUT_FEATHER_M = 1
/** Most discs a region hands a shader cut-out. */
export const FOCUS_CUT_MAX_DISCS = 12

/** Circle segments of a region disc. */
const DISC_STEPS = 48
const METERS_PER_DEG = 111_320

export interface FocusCutDisc {
  /** [lng, lat] */
  center: readonly [number, number]
  radiusM: number
}

export interface FocusCutRegion {
  /** Stable identity: equal keys ⇔ equal regions. */
  key: string
  tier: 'near' | 'ghost'
  /** FOCUS_FACTOR[tier] — what the 'in' part fades by. */
  factor: number
  /** R_item ∪ pierce discs, [lng, lat] (discs as 48-gons). */
  polygon: GeoJSON.MultiPolygon
  /** [w, s, e, n] of `polygon`. */
  bbox: readonly [number, number, number, number]
  /** Item discs (the item's samples) then pierce discs, at most FOCUS_CUT_MAX_DISCS — for a shader cut-out. */
  discs: ReadonlyArray<FocusCutDisc>
  /** The NEAR column this region includes (exact containment), or null. */
  item: FocusNearRegion | null
  /** The pierce disc centres this region includes (radius FOCUS_NEAR_RADIUS_M). */
  pierce: FocusDiscs
}

// ---------------------------------------------------------------------------
// Regions

/** The near column's part of `scene.near.key` (focus key + region tag). */
function regionKeyOf(scene: FocusScene): string {
  const near = scene.near
  if (!near.region) return `${near.focusKey}@-`
  const bar = near.key.indexOf('|')
  return bar < 0 ? near.key : near.key.slice(0, bar)
}

function discsSig(discs: FocusDiscs): string {
  return discs.map((d) => `${d[0].toFixed(6)},${d[1].toFixed(6)}`).join(';')
}

function discPolygon(center: readonly [number, number], radiusM: number): GeoJSON.Polygon {
  return turfCircle([center[0], center[1]], radiusM, { steps: DISC_STEPS, units: 'meters' }).geometry
}

/** Signed area of an open or closed [lng, lat] ring in a local frame (only the sign / ratio matters). */
function ringArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return a / 2
}

function inRingLL(ring: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function closeRing(ring: ReadonlyArray<readonly [number, number]>): number[][] {
  const out = ring.map((v) => [v[0], v[1]])
  const f = out[0]
  const l = out[out.length - 1]
  if (f && l && (f[0] !== l[0] || f[1] !== l[1])) out.push([f[0], f[1]])
  return out
}

/**
 * Even-odd rings → polygons: a ring nested in an odd number of others is a
 * hole of the smallest ring containing it; the rest are outer rings.
 */
function nestRings(rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): GeoJSON.MultiPolygon {
  const usable = rings.filter((r) => r.length >= 3)
  const depth = usable.map((r, i) =>
    usable.reduce((n, other, k) => (k !== i && inRingLL(other, r[0][0], r[0][1]) ? n + 1 : n), 0),
  )
  const polys: number[][][][] = []
  const outerIndex = new Map<number, number>()
  usable.forEach((r, i) => {
    if (depth[i] % 2 === 0) {
      outerIndex.set(i, polys.length)
      polys.push([closeRing(r)])
    }
  })
  usable.forEach((r, i) => {
    if (depth[i] % 2 === 0) return
    // The containing outer ring with the smallest area.
    let best = -1
    let bestArea = Infinity
    for (const [k] of outerIndex) {
      if (!inRingLL(usable[k], r[0][0], r[0][1])) continue
      const a = Math.abs(ringArea(usable[k]))
      if (a < bestArea) {
        bestArea = a
        best = k
      }
    }
    if (best >= 0) polys[outerIndex.get(best)!].push(closeRing(r))
  })
  return { type: 'MultiPolygon', coordinates: polys }
}

function toMulti(g: GeoJSON.Polygon | GeoJSON.MultiPolygon | null | undefined): GeoJSON.MultiPolygon | null {
  if (!g) return null
  if (g.type === 'Polygon') return g.coordinates.length > 0 ? { type: 'MultiPolygon', coordinates: [g.coordinates] } : null
  return g.coordinates.length > 0 ? g : null
}

/** R_item as a polygon, per near-region object. */
const itemPolygonCache = new WeakMap<FocusNearRegion, GeoJSON.MultiPolygon | null>()

function itemPolygon(region: FocusNearRegion): GeoJSON.MultiPolygon | null {
  const hit = itemPolygonCache.get(region)
  if (hit !== undefined) return hit
  let out: GeoJSON.MultiPolygon | null = null
  try {
    if (!region.footprint || region.footprint.length === 0) {
      out = toMulti(discPolygon(region.position, region.radiusM))
    } else {
      const nested = nestRings(region.footprint)
      if (nested.coordinates.length > 0) {
        const grown = turfBuffer(nested, region.radiusM, { units: 'meters' })
        out = toMulti(grown?.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | undefined)
      }
    }
  } catch {
    out = null
  }
  // A footprint turf can't buffer: the disc around the anchor, never nothing.
  if (!out) {
    try {
      out = toMulti(discPolygon(region.position, region.radiusM))
    } catch {
      out = null
    }
  }
  itemPolygonCache.set(region, out)
  return out
}

function bboxOf(g: GeoJSON.MultiPolygon): [number, number, number, number] {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const poly of g.coordinates) {
    for (const ring of poly) {
      for (const v of ring) {
        if (v[0] < w) w = v[0]
        if (v[0] > e) e = v[0]
        if (v[1] < s) s = v[1]
        if (v[1] > n) n = v[1]
      }
    }
  }
  return [w, s, e, n]
}

const REGION_CACHE_MAX = 64
const regionCache = new Map<string, FocusCutRegion | null>()

function rememberRegion(key: string, region: FocusCutRegion | null): FocusCutRegion | null {
  regionCache.set(key, region)
  if (regionCache.size > REGION_CACHE_MAX) {
    const oldest = regionCache.keys().next().value
    if (oldest !== undefined) regionCache.delete(oldest)
  }
  return region
}

const NO_DISCS: FocusDiscs = Object.freeze([])

/**
 * The cut region of shape (kind, id), or null when it doesn't fade or has
 * no region (a 'near' shape of a target without a column). The same object
 * for the same focus column, tier and pierce discs.
 */
export function focusCutRegion(
  scene: FocusScene,
  blockers: FocusBlockers,
  kind: FocusShapeKind,
  id: number | undefined,
): FocusCutRegion | null {
  if (!scene.active || id === undefined) return null
  const tier = focusTier(scene, blockers, kind, id)
  if (tier !== 'near' && tier !== 'ghost') return null
  const item = scene.near.region
  const pierce = tier === 'ghost' ? blockerPierceOf(blockers, kind).get(id) ?? NO_DISCS : NO_DISCS
  if (!item && pierce.length === 0) return null
  const key = `${regionKeyOf(scene)}#${tier}#${discsSig(pierce)}`
  if (regionCache.has(key)) {
    const hit = regionCache.get(key) ?? null
    regionCache.delete(key)
    regionCache.set(key, hit)
    return hit
  }
  const parts: GeoJSON.MultiPolygon[] = []
  if (item) {
    const ip = itemPolygon(item)
    if (ip) parts.push(ip)
  }
  for (const c of pierce) {
    try {
      const d = toMulti(discPolygon(c, FOCUS_NEAR_RADIUS_M))
      if (d) parts.push(d)
    } catch {
      // A degenerate centre: that disc is skipped.
    }
  }
  if (parts.length === 0) return rememberRegion(key, null)
  let polygon: GeoJSON.MultiPolygon | null = parts[0]
  if (parts.length > 1) {
    try {
      const u = turfUnion(featureCollection(parts.map((g) => ({ type: 'Feature' as const, properties: {}, geometry: g }))))
      polygon = toMulti(u?.geometry)
    } catch {
      polygon = null
    }
    if (!polygon) polygon = { type: 'MultiPolygon', coordinates: parts.flatMap((g) => g.coordinates) }
  }
  const discs: FocusCutDisc[] = []
  if (item) for (const s of item.samples) if (discs.length < FOCUS_CUT_MAX_DISCS) discs.push({ center: s, radiusM: item.radiusM })
  for (const c of pierce) if (discs.length < FOCUS_CUT_MAX_DISCS) discs.push({ center: c, radiusM: FOCUS_NEAR_RADIUS_M })
  const region: FocusCutRegion = Object.freeze({
    key,
    tier,
    factor: FOCUS_FACTOR[tier],
    polygon,
    bbox: Object.freeze(bboxOf(polygon)),
    discs: Object.freeze(discs),
    item,
    pierce,
  })
  return rememberRegion(key, region)
}

/** Pierce disc centres in Mercator with their radius in Mercator units. */
const pierceMercCache = new WeakMap<FocusCutRegion, { x: number; y: number; r2: number }[]>()

function pierceMerc(region: FocusCutRegion): { x: number; y: number; r2: number }[] {
  let out = pierceMercCache.get(region)
  if (!out) {
    out = region.pierce.map((c) => {
      const m = mapboxgl.MercatorCoordinate.fromLngLat([c[0], c[1]], 0)
      const r = FOCUS_NEAR_RADIUS_M * m.meterInMercatorCoordinateUnits()
      return { x: m.x, y: m.y, r2: r * r }
    })
    pierceMercCache.set(region, out)
  }
  return out
}

function containsMerc(region: FocusCutRegion, x: number, y: number): boolean {
  if (region.item && focusNearRegionContainsMerc(region.item, x, y)) return true
  for (const d of pierceMerc(region)) {
    const dx = x - d.x
    const dy = y - d.y
    if (dx * dx + dy * dy <= d.r2) return true
  }
  return false
}

/**
 * Exact containment (no turf, no polygon approximation): within the NEAR
 * column (footprint distance ≤ R, or the anchor disc) or within R of a
 * pierce disc centre.
 */
export function cutRegionContains(region: FocusCutRegion, lng: number, lat: number): boolean {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false
  const m = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], 0)
  return containsMerc(region, m.x, m.y)
}

// ---------------------------------------------------------------------------
// Worthiness

/** bbox diagonal in metres (local equirectangular). */
function diagonalM(bbox: readonly [number, number, number, number]): number {
  const [w, s, e, n] = bbox
  if (!(e >= w && n >= s)) return 0
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180)
  return Math.hypot((e - w) * METERS_PER_DEG * k, (n - s) * METERS_PER_DEG)
}

/** Big enough to cut: area over FOCUS_CUT_MIN_AREA_M2 or bbox diagonal over FOCUS_CUT_MIN_DIAGONAL_M. */
export function isCutWorthy(bbox: readonly [number, number, number, number], areaM2: number): boolean {
  return areaM2 > FOCUS_CUT_MIN_AREA_M2 || diagonalM(bbox) > FOCUS_CUT_MIN_DIAGONAL_M
}

/** Every [lng, lat] of a geometry's coordinates. */
function eachCoord(coords: unknown, visit: (x: number, y: number) => void): void {
  if (!Array.isArray(coords)) return
  if (typeof coords[0] === 'number') {
    visit(coords[0] as number, coords[1] as number)
    return
  }
  for (const c of coords) eachCoord(c, visit)
}

function geometryBbox(g: GeoJSON.Geometry): [number, number, number, number] {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  if ('coordinates' in g) {
    eachCoord(g.coordinates, (x, y) => {
      if (x < w) w = x
      if (x > e) e = x
      if (y < s) s = y
      if (y > n) n = y
    })
  }
  return [w, s, e, n]
}

/** |area| in m² of a Polygon / MultiPolygon (local equirectangular, holes subtracted). */
function areaM2Of(g: GeoJSON.Geometry): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
  let total = 0
  for (const poly of polys) {
    poly.forEach((ring, i) => {
      if (ring.length < 3) return
      const k = Math.cos((ring[0][1] * Math.PI) / 180) * METERS_PER_DEG
      let a = 0
      for (let p = 0, q = ring.length - 1; p < ring.length; q = p++) {
        a += (ring[q][0] * k) * (ring[p][1] * METERS_PER_DEG) - (ring[p][0] * k) * (ring[q][1] * METERS_PER_DEG)
      }
      total += i === 0 ? Math.abs(a / 2) : -Math.abs(a / 2)
    })
  }
  return Math.max(0, total)
}

const worthyCache = new WeakMap<object, boolean>()

/** `isCutWorthy` of a geometry's bbox and area, cached per geometry object. */
export function geometryCutWorthy(geometry: GeoJSON.Geometry): boolean {
  let hit = worthyCache.get(geometry)
  if (hit === undefined) {
    const bbox = geometryBbox(geometry)
    hit = diagonalM(bbox) > FOCUS_CUT_MIN_DIAGONAL_M || isCutWorthy(bbox, areaM2Of(geometry))
    worthyCache.set(geometry, hit)
  }
  return hit
}

function bboxesOverlap(a: readonly number[], b: readonly number[]): boolean {
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1])
}

// ---------------------------------------------------------------------------
// Splits

/** geometry → region key → split (null = don't cut). */
const areaSplitCache = new WeakMap<object, Map<string, AreaSplit | null>>()

type AreaSplit = { inside: GeoJSON.MultiPolygon; outside: GeoJSON.MultiPolygon }

/**
 * The geometry's part inside the region and the part outside it, or null
 * when it isn't cut-worthy, doesn't meet the region, or lies wholly
 * inside it (it then fades whole). Cached per (geometry, region.key).
 */
export function splitAreaByRegion(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  region: FocusCutRegion,
): AreaSplit | null {
  let byKey = areaSplitCache.get(geometry)
  if (byKey?.has(region.key)) return byKey.get(region.key) ?? null
  let out: AreaSplit | null = null
  if (geometryCutWorthy(geometry) && bboxesOverlap(geometryBbox(geometry), region.bbox)) {
    try {
      const a = { type: 'Feature' as const, properties: {}, geometry }
      const b = { type: 'Feature' as const, properties: {}, geometry: region.polygon }
      const inside = toMulti(turfIntersect(featureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>([a, b]))?.geometry)
      const outside = inside
        ? toMulti(turfDifference(featureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>([a, b]))?.geometry)
        : null
      if (inside && outside) out = { inside, outside }
    } catch {
      out = null
    }
  }
  if (!byKey) {
    byKey = new Map()
    areaSplitCache.set(geometry, byKey)
  }
  byKey.set(region.key, out)
  return out
}

type LineSplitResult = { inside: GeoJSON.MultiLineString; outside: GeoJSON.MultiLineString }

const lineSplitCache = new WeakMap<object, Map<string, LineSplitResult | null>>()

/** Point halfway along a polyline (by length in a local frame). */
function midpointOf(coords: ReadonlyArray<ReadonlyArray<number>>): [number, number] {
  if (coords.length === 1) return [coords[0][0], coords[0][1]]
  const k = Math.cos((coords[0][1] * Math.PI) / 180)
  const seg: number[] = []
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    const l = Math.hypot((coords[i][0] - coords[i - 1][0]) * k, coords[i][1] - coords[i - 1][1])
    seg.push(l)
    total += l
  }
  let want = total / 2
  for (let i = 1; i < coords.length; i++) {
    const l = seg[i - 1]
    if (want <= l || i === coords.length - 1) {
      const f = l > 0 ? Math.min(1, want / l) : 0
      return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f]
    }
    want -= l
  }
  const last = coords[coords.length - 1]
  return [last[0], last[1]]
}

/**
 * The line split at the region boundary, pieces sorted by whether their
 * midpoint lies in the region; null when it isn't cut-worthy or all of it
 * falls on one side. Cached per (geometry, region.key).
 */
export function splitLineByRegion(
  geometry: GeoJSON.LineString | GeoJSON.MultiLineString,
  region: FocusCutRegion,
): LineSplitResult | null {
  let byKey = lineSplitCache.get(geometry)
  if (byKey?.has(region.key)) return byKey.get(region.key) ?? null
  let out: LineSplitResult | null = null
  if (geometryCutWorthy(geometry) && bboxesOverlap(geometryBbox(geometry), region.bbox)) {
    try {
      const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates
      const splitter = { type: 'Feature' as const, properties: {}, geometry: region.polygon }
      const inside: number[][][] = []
      const outside: number[][][] = []
      for (const coords of lines) {
        if (coords.length < 2) continue
        const pieces = lineSplit({ type: 'LineString', coordinates: coords }, splitter).features
        const list = pieces.length > 0 ? pieces.map((f) => f.geometry.coordinates) : [coords]
        for (const piece of list) {
          if (piece.length < 2) continue
          const [lng, lat] = midpointOf(piece)
          ;(cutRegionContains(region, lng, lat) ? inside : outside).push(piece)
        }
      }
      if (inside.length > 0 && outside.length > 0) {
        out = {
          inside: { type: 'MultiLineString', coordinates: inside },
          outside: { type: 'MultiLineString', coordinates: outside },
        }
      }
    } catch {
      out = null
    }
  }
  if (!byKey) {
    byKey = new Map()
    lineSplitCache.set(geometry, byKey)
  }
  byKey.set(region.key, out)
  return out
}

type MeshSplit = { outside: LiftMeshData; inside: LiftMeshData }

const meshSplitCache = new WeakMap<LiftMeshData, Map<string, MeshSplit | null>>()

/**
 * A mesh split per triangle by its centroid (east / north metres placed
 * exactly as the mesh layer draws them): the inside triangles at alpha ×
 * region.factor under the key `${mesh.key}#cut`, the outside ones as drawn
 * under `mesh.key`. The mesh isn't rebuilt, so a lean, a closed loop or a
 * dome profile is kept exactly. null when the mesh isn't cut-worthy or
 * every triangle falls on one side. Cached per (mesh, region.key).
 */
export function splitMeshByRegion(mesh: LiftMeshData, region: FocusCutRegion): MeshSplit | null {
  let byKey = meshSplitCache.get(mesh)
  if (byKey?.has(region.key)) return byKey.get(region.key) ?? null
  const out = computeMeshSplit(mesh, region)
  if (!byKey) {
    byKey = new Map()
    meshSplitCache.set(mesh, byKey)
  }
  byKey.set(region.key, out)
  return out
}

function computeMeshSplit(mesh: LiftMeshData, region: FocusCutRegion): MeshSplit | null {
  const P = mesh.positions
  const triCount = Math.floor(P.length / 9)
  if (triCount === 0) return null
  let minE = Infinity
  let minN = Infinity
  let maxE = -Infinity
  let maxN = -Infinity
  for (let i = 0; i < triCount * 9; i += 3) {
    if (P[i] < minE) minE = P[i]
    if (P[i] > maxE) maxE = P[i]
    if (P[i + 1] < minN) minN = P[i + 1]
    if (P[i + 1] > maxN) maxN = P[i + 1]
  }
  const [olng, olat] = mesh.origin
  const kx = METERS_PER_DEG * Math.cos((olat * Math.PI) / 180)
  const bbox: [number, number, number, number] = [
    olng + minE / kx,
    olat + minN / METERS_PER_DEG,
    olng + maxE / kx,
    olat + maxN / METERS_PER_DEG,
  ]
  if (!isCutWorthy(bbox, (maxE - minE) * (maxN - minN))) return null
  if (!bboxesOverlap(bbox, region.bbox)) return null
  // Same placement as LiftMeshLayer: x = ox + e·s, y = oy − n·s.
  const o = mapboxgl.MercatorCoordinate.fromLngLat([olng, olat], 0)
  const scale = o.meterInMercatorCoordinateUnits()
  const inside = new Uint8Array(triCount)
  let nIn = 0
  for (let t = 0; t < triCount; t++) {
    const b = t * 9
    const e = (P[b] + P[b + 3] + P[b + 6]) / 3
    const n = (P[b + 1] + P[b + 4] + P[b + 7]) / 3
    if (containsMerc(region, o.x + e * scale, o.y - n * scale)) {
      inside[t] = 1
      nIn++
    }
  }
  if (nIn === 0 || nIn === triCount) return null
  const pick = (want: number, alpha: number, key: string): LiftMeshData => {
    const n = want === 1 ? nIn : triCount - nIn
    const positions = new Float32Array(n * 9)
    const normals = new Float32Array(n * 9)
    const colors = new Float32Array(n * 12)
    let k = 0
    for (let t = 0; t < triCount; t++) {
      if (inside[t] !== want) continue
      positions.set(mesh.positions.subarray(t * 9, t * 9 + 9), k * 9)
      normals.set(mesh.normals.subarray(t * 9, t * 9 + 9), k * 9)
      colors.set(mesh.colors.subarray(t * 12, t * 12 + 12), k * 12)
      k++
    }
    if (alpha !== 1) for (let i = 3; i < colors.length; i += 4) colors[i] *= alpha
    return { key, origin: mesh.origin, positions, normals, colors }
  }
  return { outside: pick(0, 1, mesh.key), inside: pick(1, region.factor, `${mesh.key}#cut`) }
}

// ---------------------------------------------------------------------------
// Collection post-passes

export type FocusPiece = 'in' | 'out'

type AnyFeature = GeoJSON.Feature<GeoJSON.Geometry, GeoJSON.GeoJsonProperties>

/** feature → `${region.key}@${factor}` → [in, out] pieces. */
const pieceCache = new WeakMap<object, Map<string, [AnyFeature, AnyFeature]>>()

function cachedPieces<F extends AnyFeature>(f: F, tag: string, build: () => [F, F]): [F, F] {
  let byTag = pieceCache.get(f)
  const hit = byTag?.get(tag)
  if (hit) return hit as unknown as [F, F]
  const pieces = build()
  if (!byTag) {
    byTag = new Map()
    pieceCache.set(f, byTag)
  }
  byTag.set(tag, pieces as unknown as [AnyFeature, AnyFeature])
  return pieces
}

/** The 'in' piece's opacity / bucket — `fadedFeature`'s non-meshed arithmetic. */
function inPieceOpacity(props: FadeableProps, factor: number): { opacity: number; opacityBucket: number } {
  const faded = fadedOpacity(props.opacity, factor)
  return { opacity: faded.opacity, opacityBucket: props.opacity >= 10 ? faded.opacityBucket : props.opacityBucket }
}

/**
 * `fadeFeatureCollection` with the cut-away: per feature, factor 1 →
 * identity; a meshed hit target → identity when it has a region (its mesh
 * is split instead, `meshCutAway`), else faded whole; a cut-worthy shape
 * that meets its region → an 'in' piece (fade-tier opacity / bucket,
 * `focusPiece: 'in'`) and an 'out' piece (original props, `focusPiece:
 * 'out'`), both with the feature's id and shape props; anything else →
 * faded whole exactly as before. Returns `fc` ITSELF when nothing changes;
 * pieces are cached per (feature, region, factor).
 */
export function focusFadeCollection<G extends GeoJSON.Polygon | GeoJSON.MultiPolygon, P extends FadeableProps>(
  fc: GeoJSON.FeatureCollection<G, P>,
  factorOf: (f: GeoJSON.Feature<G, P>) => number,
  regionOf: (f: GeoJSON.Feature<G, P>) => FocusCutRegion | null,
): GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, P & { focusPiece?: FocusPiece }> {
  type Out = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, P & { focusPiece?: FocusPiece }>
  const features = fc.features
  let out: Out[] | null = null
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    const factor = factorOf(f)
    let next: Out | [Out, Out] = f as Out
    if (factor !== 1 && Number.isFinite(factor) && f.properties) {
      const region = regionOf(f)
      if (f.properties.meshed) {
        if (!region) next = fadedFeature(f, factor) as Out
      } else {
        const split = region ? splitAreaByRegion(f.geometry, region) : null
        if (split && region) {
          next = cachedPieces(f as unknown as Out, `${region.key}@${factor}`, () => {
            const props = f.properties
            return [
              { ...f, geometry: split.inside, properties: { ...props, ...inPieceOpacity(props, factor), focusPiece: 'in' } } as Out,
              { ...f, geometry: split.outside, properties: { ...props, focusPiece: 'out' } } as Out,
            ]
          })
        } else {
          next = fadedFeature(f, factor) as Out
        }
      }
    }
    if (out === null) {
      if (next === (f as Out)) continue
      out = features.slice(0, i) as Out[]
    }
    if (Array.isArray(next)) out.push(next[0], next[1])
    else out.push(next)
  }
  return out === null
    ? (fc as unknown as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, P & { focusPiece?: FocusPiece }>)
    : { ...fc, features: out }
}

/** `focusFadeCollection` for line strokes: split at the region boundary (`splitLineByRegion`). */
export function focusFadeLineCollection<G extends GeoJSON.LineString | GeoJSON.MultiLineString, P extends FadeableProps>(
  fc: GeoJSON.FeatureCollection<G, P>,
  factorOf: (f: GeoJSON.Feature<G, P>) => number,
  regionOf: (f: GeoJSON.Feature<G, P>) => FocusCutRegion | null,
): GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString, P & { focusPiece?: FocusPiece }> {
  type Out = GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString, P & { focusPiece?: FocusPiece }>
  const features = fc.features
  let out: Out[] | null = null
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    const factor = factorOf(f)
    let next: Out | [Out, Out] = f as Out
    if (factor !== 1 && Number.isFinite(factor) && f.properties) {
      const region = regionOf(f)
      if (f.properties.meshed) {
        if (!region) next = fadedFeature(f, factor) as Out
      } else {
        const split = region ? splitLineByRegion(f.geometry, region) : null
        if (split && region) {
          next = cachedPieces(f as unknown as Out, `${region.key}@${factor}`, () => {
            const props = f.properties
            return [
              { ...f, geometry: split.inside, properties: { ...props, ...inPieceOpacity(props, factor), focusPiece: 'in' } } as Out,
              { ...f, geometry: split.outside, properties: { ...props, focusPiece: 'out' } } as Out,
            ]
          })
        } else {
          next = fadedFeature(f, factor) as Out
        }
      }
    }
    if (out === null) {
      if (next === (f as Out)) continue
      out = features.slice(0, i) as Out[]
    }
    if (Array.isArray(next)) out.push(next[0], next[1])
    else out.push(next)
  }
  return out === null
    ? (fc as unknown as GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString, P & { focusPiece?: FocusPiece }>)
    : { ...fc, features: out }
}

/** Last result per input array: same inputs (meshes + per-mesh region / factor) → same output array. */
const meshListCache = new WeakMap<ReadonlyArray<LiftMeshData>, { sig: string; out: ReadonlyArray<LiftMeshData> }>()

/**
 * Per mesh: factor 1 or no region → unchanged; otherwise its outside and
 * inside parts (`splitMeshByRegion`), or the whole mesh faded when it
 * can't be cut. Returns `meshes` itself when nothing changes, and the
 * same output array for the same inputs.
 */
export function meshCutAway(
  meshes: ReadonlyArray<LiftMeshData>,
  regionOfKey: (key: string) => FocusCutRegion | null,
  factorOfKey: (key: string) => number,
): ReadonlyArray<LiftMeshData> {
  const plan: (readonly [FocusCutRegion, number] | null)[] = []
  let sig = ''
  for (const m of meshes) {
    const factor = factorOfKey(m.key)
    const region = factor !== 1 && Number.isFinite(factor) ? regionOfKey(m.key) : null
    plan.push(region ? [region, factor] : null)
    if (region) sig += `${m.key}=${region.key}@${factor};`
  }
  if (sig === '') return meshes
  const hit = meshListCache.get(meshes)
  if (hit && hit.sig === sig) return hit.out
  const out: LiftMeshData[] = []
  meshes.forEach((m, i) => {
    const p = plan[i]
    if (!p) {
      out.push(m)
      return
    }
    const split = splitMeshByRegion(m, p[0])
    if (split) out.push(split.outside, split.inside)
    else out.push(fadeMeshData(m, p[1]))
  })
  meshListCache.set(meshes, { sig, out })
  return out
}

// ---------------------------------------------------------------------------
// Grids

export interface GridCutPlan {
  /** 'whole': every cell of the grid fades; 'cells': only `fades(...)` cells. */
  mode: 'whole' | 'cells'
  tier: 'near' | 'ghost'
  factor: number
  region: FocusCutRegion | null
  /** Does this cell (row, col, level, centroid lng / lat) fade? Always true in 'whole' mode. */
  fades(row: number, col: number, level: number, lng: number, lat: number): boolean
}

/** Plans per near column (the cells it reads), then per grid / tier / mode / region. */
const gridPlanCache = new WeakMap<FocusNear, Map<string, GridCutPlan>>()

/**
 * How a near / blocker rack grid fades: whole when it is small, else only
 * the cells in the region — near: the NEAR column's cells
 * (`scene.near.gridCells`); ghost: those or any cell whose centroid lies in
 * R_item ∪ R_pierce. null for a 'normal' or 'focus' grid. The same object
 * for the same inputs.
 */
export function gridCutPlan(
  scene: FocusScene,
  blockers: FocusBlockers,
  gridId: number,
  bbox: readonly [number, number, number, number],
  areaM2: number,
): GridCutPlan | null {
  const tier = focusTier(scene, blockers, 'grids', gridId)
  if (tier !== 'near' && tier !== 'ghost') return null
  const mode: 'whole' | 'cells' = isCutWorthy(bbox, areaM2) ? 'cells' : 'whole'
  const region = mode === 'cells' ? focusCutRegion(scene, blockers, 'grids', gridId) : null
  const cacheKey = `${gridId}#${tier}#${mode}#${region?.key ?? ''}`
  let byKey = gridPlanCache.get(scene.near)
  const hit = byKey?.get(cacheKey)
  if (hit) return hit
  const cells = scene.near.gridCells
  const plan: GridCutPlan = Object.freeze({
    mode,
    tier,
    factor: FOCUS_FACTOR[tier],
    region,
    fades(row: number, col: number, level: number, lng: number, lat: number): boolean {
      if (mode === 'whole') return true
      if (cells.has(`${gridId}:${row}:${col}:${level}`)) return true
      return tier === 'ghost' && region !== null && cutRegionContains(region, lng, lat)
    },
  })
  if (!byKey) {
    byKey = new Map()
    gridPlanCache.set(scene.near, byKey)
  }
  byKey.set(cacheKey, plan)
  return plan
}
