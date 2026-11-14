/**
 * Focus mode — what is focused, and where it is.
 *
 * Pure (no map, no React). Two jobs:
 *
 *  1. **Target grammar.** A `FocusTarget` names one item: a shape row
 *     (`{ kind: 'markers', id }`, optionally one rack bin `cell`, and the
 *     data-link row it was clicked through `dl`), or one data-link entity
 *     (`{ kind: 'dl', configId, entityKey }`). `parseFocusParam` /
 *     `formatFocusParam` are the ONLY reader / writer of the `?focus=`
 *     share-link form, and `focusKey` is the stable identity every memo
 *     keys on.
 *
 *  2. **Resolution.** `resolveFocus` turns a target into the geometry the
 *     rest of focus mode needs: the anchor the pulse ring / camera aim at,
 *     the item's floor, the points occlusion is tested at (`samples`), the
 *     prisms that are the item itself (`ownPrismKeys`, never blockers) and
 *     the footprint the NEAR column is grown from (`footprint`,
 *     `focus-near.ts`).
 *     Every kind mirrors its OWN overlay: markers / labels / doors use the
 *     exact occlusion target their overlay builds (`markerOcclusionTargets`,
 *     the text-label and door label targets), and extruded shapes use the
 *     generator `buildOccluders` builds their prisms from — so a sample
 *     sits exactly where the item is drawn, and prism keys line up.
 *
 * Results are cached per source row object (rows keep their identity
 * while unchanged), so a host that re-resolves on every store update gets
 * the same `ResolvedFocus` object back and nothing downstream re-runs.
 */

import { buildCircleFeatures } from '@/lib/circle-generators'
import type { DoorShape } from '@/lib/door/types'
import { buildGridFromLine, type GridCell, type GridConfig } from '@/lib/grid-generators'
import { imageCroppedCorners } from '@/lib/image-generators'
import { buildLineWallFeature, rotateLine } from '@/lib/line-generators'
import type { GridOccluderInput, OccludableTarget } from '@/lib/marker-occlusion'
import { buildPolygonFeature, polygonCentroid } from '@/lib/polygon-generators'
import { leaningWallFootprint, leaningWallTopLine, wallLeans } from '@/lib/sloped-mesh'
import {
  isLiftType,
  type CircleShape,
  type ImagePlaneShape,
  type ImageShape,
  type LineShape,
  type MarkerShape,
  type ModelShape,
  type PolygonShape,
  type StairShape,
  type TextLabelShape,
} from '@/lib/shapes'
import { liftIconFeatures, stairToFeatureCollection } from '@/lib/stair-generators'

// ---------------------------------------------------------------------------
// Target grammar

/** API kinds — the same names report entity keys and the editor's `?select=` use. */
export type FocusShapeKind =
  | 'markers'
  | 'polygons'
  | 'circles'
  | 'lines'
  | 'stairs'
  | 'grids'
  | 'images'
  | 'image-planes'
  | 'models'
  | 'doors'
  | 'text-labels'

export const FOCUS_SHAPE_KINDS: readonly FocusShapeKind[] = Object.freeze([
  'markers',
  'polygons',
  'circles',
  'lines',
  'stairs',
  'grids',
  'images',
  'image-planes',
  'models',
  'doors',
  'text-labels',
] as const)

const SHAPE_KIND_SET: ReadonlySet<string> = new Set(FOCUS_SHAPE_KINDS)

/** One rack bin: the grid cell at (row, col, level). */
export interface FocusCell {
  row: number
  col: number
  level: number
}

/** One data-link row: the config that draws it + the row's entity key. */
export interface FocusDlRef {
  configId: number
  entityKey: string
}

/** Where the data-link symbol is drawn (feature coordinates + properties.elevation). */
export interface DlAnchor {
  position: [number, number]
  elevationM: number
  floorPlanId: number | null
}

export interface FocusShapeTarget {
  kind: FocusShapeKind
  id: number
  /** grids only: focus one bin instead of the whole rack. */
  cell?: FocusCell
  /**
   * The data-link row this shape was focused through (a click on a dl
   * symbol bound to the shape). Exempts that symbol too; part of the key.
   */
  dl?: FocusDlRef
}

export interface FocusDlTarget {
  kind: 'dl'
  configId: number
  entityKey: string
  /**
   * Filled in by the data-link overlay (`FocusScene.onDlAnchor`) once it
   * has found the entity's drawn feature; absent = pending. Not part of
   * the key or the URL.
   */
  anchor?: DlAnchor
}

export type FocusTarget = FocusShapeTarget | FocusDlTarget

const POSITIVE_INT = /^[1-9]\d{0,15}$/
const NON_NEGATIVE_INT = /^(?:0|[1-9]\d{0,15})$/

function positiveInt(raw: string): number | null {
  if (!POSITIVE_INT.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

function nonNegativeInt(raw: string): number | null {
  if (!NON_NEGATIVE_INT.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * 'markers:12' | 'grids:5' | 'grids:5:2:3:0' | 'image-planes:4' | 'dl:<configId>:<encodeURIComponent(entityKey)>'.
 * dl: split on the FIRST TWO colons only, decodeURIComponent the rest.
 * Ids are positive integers. Anything else → null.
 */
export function parseFocusParam(raw: string | null | undefined): FocusTarget | null {
  if (typeof raw !== 'string' || raw === '') return null
  const first = raw.indexOf(':')
  if (first <= 0) return null
  const kind = raw.slice(0, first)
  if (kind === 'dl') {
    const second = raw.indexOf(':', first + 1)
    if (second < 0) return null
    const configId = positiveInt(raw.slice(first + 1, second))
    if (configId === null) return null
    let entityKey: string
    try {
      entityKey = decodeURIComponent(raw.slice(second + 1))
    } catch {
      return null
    }
    if (entityKey === '') return null
    return { kind: 'dl', configId, entityKey }
  }
  if (!SHAPE_KIND_SET.has(kind)) return null
  const parts = raw.slice(first + 1).split(':')
  const id = positiveInt(parts[0] ?? '')
  if (id === null) return null
  if (parts.length === 1) return { kind: kind as FocusShapeKind, id }
  if (parts.length === 4 && kind === 'grids') {
    const row = nonNegativeInt(parts[1])
    const col = nonNegativeInt(parts[2])
    const level = nonNegativeInt(parts[3])
    if (row === null || col === null || level === null) return null
    return { kind: 'grids', id, cell: { row, col, level } }
  }
  return null
}

/** Inverse of parseFocusParam; never includes `anchor` or the `dl` sub-ref. */
export function formatFocusParam(target: FocusTarget): string {
  if (target.kind === 'dl') {
    return `dl:${target.configId}:${encodeURIComponent(target.entityKey)}`
  }
  const base = `${target.kind}:${target.id}`
  const c = target.cell
  return c ? `${base}:${c.row}:${c.col}:${c.level}` : base
}

/**
 * Stable identity: formatFocusParam(t) + (shape target with t.dl ?
 * `+dl:${configId}:${encodeURIComponent(entityKey)}` : ''); '' for null.
 */
export function focusKey(target: FocusTarget | null): string {
  if (!target) return ''
  const base = formatFocusParam(target)
  if (target.kind !== 'dl' && target.dl) {
    return `${base}+dl:${target.dl.configId}:${encodeURIComponent(target.dl.entityKey)}`
  }
  return base
}

/** dl target → {configId, entityKey}; shape target → target.dl ?? null; null → null. */
export function focusDlRef(target: FocusTarget | null): FocusDlRef | null {
  if (!target) return null
  if (target.kind === 'dl') return { configId: target.configId, entityKey: target.entityKey }
  return target.dl ?? null
}

// ---------------------------------------------------------------------------
// Resolution

export interface FocusShapes {
  markers?: readonly MarkerShape[]
  polygons?: readonly PolygonShape[]
  circles?: readonly CircleShape[]
  lines?: readonly LineShape[]
  stairs?: readonly StairShape[]
  grids?: readonly GridOccluderInput[]
  images?: readonly ImageShape[]
  imagePlanes?: readonly ImagePlaneShape[]
  models?: readonly ModelShape[]
  doors?: readonly DoorShape[]
  textLabels?: readonly TextLabelShape[]
}

export interface ResolvedFocus {
  /** focusKey(target) */
  key: string
  target: FocusTarget
  /** Anchor (ring + camera aim), [lng, lat]. */
  position: [number, number]
  /** Anchor altitude in metres (marker elevation, shape top, dl elevation). */
  altitudeM: number
  /** [w, s, e, n] for area items, null for points. */
  bounds: [number, number, number, number] | null
  /** images row id of the item's floor (an image's own id for kind 'images'). */
  floorPlanId: number | null
  /** Occlusion sample points (1 for points, ≤ 5 for areas, at the top). */
  samples: readonly OccludableTarget[]
  /** Exact prism keys, or prefixes ending in ':' — never blockers. */
  ownPrismKeys: readonly string[]
  /**
   * The item's footprint as open [lng, lat] rings, or null for a point
   * item (marker, text label, model, image plane, door, data-link row).
   * Read with even-odd parity over ALL rings, so a ring inside another is
   * a hole (a closed wall loop's open middle, a leaning roof's opening).
   * A polygon's ring, a circle's rings, a wall's outline (every ring of
   * its buffer; a leaning wall's plan band), a bin's cell, an image's
   * cropped corners; one convex hull for a whole rack, a stair / lift, or
   * a circle drawn as more than 4 pieces. `focus-near.ts` grows the NEAR
   * column from it.
   */
  footprint: ReadonlyArray<ReadonlyArray<readonly [number, number]>> | null
}

type Ring = ReadonlyArray<readonly [number, number] | readonly number[]>
type Footprint = ReadonlyArray<ReadonlyArray<readonly [number, number]>>

const NO_KEYS: readonly string[] = Object.freeze([])

/**
 * Resolved results per source object (a row, a grid config, a dl anchor)
 * and key. `sig` guards fields that can change while the owner object is
 * reused (a grid wrapper's corners, a row's floor).
 */
const resolvedCache = new WeakMap<object, Map<string, { sig: readonly unknown[]; resolved: ResolvedFocus | null }>>()

function cachedResolve(
  owner: object,
  key: string,
  sig: readonly unknown[],
  build: () => ResolvedFocus | null,
): ResolvedFocus | null {
  let byKey = resolvedCache.get(owner)
  const hit = byKey?.get(key)
  if (hit && hit.sig.length === sig.length && hit.sig.every((v, i) => v === sig[i])) return hit.resolved
  const resolved = build()
  if (!byKey) {
    byKey = new Map()
    resolvedCache.set(owner, byKey)
  }
  byKey.set(key, { sig, resolved })
  return resolved
}

function findById<R extends { id?: number }>(rows: readonly R[] | undefined, id: number): R | undefined {
  if (!rows) return undefined
  for (const r of rows) if (r.id === id) return r
  return undefined
}

function finite(n: unknown, fallback = 0): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function floorOf(row: { floorPlanId?: number | null }): number | null {
  const f = row.floorPlanId
  return typeof f === 'number' && Number.isFinite(f) ? f : null
}

/** One sample at `position` / `elevationM` on `floorPlanId`. */
function pointSample(position: readonly [number, number], elevationM: number, floorPlanId: number | null): OccludableTarget {
  const s: OccludableTarget = { id: 0, position: [position[0], position[1]], elevationM }
  if (floorPlanId !== null) s.floorPlanId = floorPlanId
  return s
}

function pointResolved(
  key: string,
  target: FocusTarget,
  position: readonly [number, number],
  altitudeM: number,
  floorPlanId: number | null,
  ownPrismKeys: readonly string[] = NO_KEYS,
): ResolvedFocus | null {
  const lng = position[0]
  const lat = position[1]
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return {
    key,
    target,
    position: [lng, lat],
    altitudeM,
    bounds: null,
    floorPlanId,
    samples: Object.freeze([pointSample([lng, lat], altitudeM, floorPlanId)]),
    ownPrismKeys,
    footprint: null,
  }
}

/** Bounds of every vertex of `rings`, or null when none is finite. */
function ringsBounds(rings: readonly Ring[]): [number, number, number, number] | null {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const ring of rings) {
    for (const v of ring) {
      const x = v[0]
      const y = v[1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < w) w = x
      if (x > e) e = x
      if (y < s) s = y
      if (y > n) n = y
    }
  }
  return w <= e && s <= n ? [w, s, e, n] : null
}

/** Even-odd test; works on open or closed rings (a closing edge is zero-length). */
function inRing(ring: Ring, x: number, y: number): boolean {
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

function inAnyRing(rings: readonly Ring[], x: number, y: number): boolean {
  for (const r of rings) if (inRing(r, x, y)) return true
  return false
}

/** Open, finite copy of `ring` (a repeated closing vertex dropped), or null below 3 vertices. */
function footprintRing(ring: Ring): ReadonlyArray<readonly [number, number]> | null {
  const out: [number, number][] = []
  const n = ring.length
  const closed = n > 3 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]
  for (let i = 0; i < (closed ? n - 1 : n); i++) {
    const x = ring[i][0]
    const y = ring[i][1]
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y])
  }
  return out.length >= 3 ? Object.freeze(out) : null
}

/** Every ring of `rings` as a footprint ring (degenerate ones dropped), or null when none is left. */
function footprintOf(rings: readonly Ring[]): Footprint | null {
  const out: ReadonlyArray<readonly [number, number]>[] = []
  for (const r of rings) {
    const f = footprintRing(r)
    if (f) out.push(f)
  }
  return out.length > 0 ? Object.freeze(out) : null
}

function hullCross(o: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/**
 * Convex hull of every finite vertex of `rings` (Andrew's monotone chain,
 * counter-clockwise, open, collinear points dropped) as a one-ring
 * footprint. Falls back to `footprintOf` when the vertices are collinear.
 */
function hullFootprint(rings: readonly Ring[]): Footprint | null {
  const pts: [number, number][] = []
  for (const ring of rings) {
    for (const v of ring) {
      if (Number.isFinite(v[0]) && Number.isFinite(v[1])) pts.push([v[0], v[1]])
    }
  }
  if (pts.length < 3) return null
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const lower: [number, number][] = []
  for (const p of pts) {
    while (lower.length >= 2 && hullCross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: [number, number][] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && hullCross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  const hull = lower.concat(upper)
  if (hull.length < 3) return footprintOf(rings)
  return Object.freeze([Object.freeze(hull)])
}

/**
 * Area samples: the centroid, plus each bbox corner pulled 25 % toward the
 * centroid when that point lies inside the footprint. All at `topM`.
 */
function areaSamples(
  centroid: readonly [number, number],
  bounds: readonly [number, number, number, number],
  rings: readonly Ring[],
  topM: number,
  floorPlanId: number | null,
): readonly OccludableTarget[] {
  const out: OccludableTarget[] = [pointSample(centroid, topM, floorPlanId)]
  const [w, s, e, n] = bounds
  const corners: [number, number][] = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ]
  for (const [cx, cy] of corners) {
    const x = cx + (centroid[0] - cx) * 0.25
    const y = cy + (centroid[1] - cy) * 0.25
    if (!inAnyRing(rings, x, y)) continue
    const sample = pointSample([x, y], topM, floorPlanId)
    sample.id = out.length
    out.push(sample)
  }
  return Object.freeze(out)
}

function areaResolved(
  key: string,
  target: FocusTarget,
  rings: readonly Ring[],
  centroid: readonly [number, number] | null,
  topM: number,
  floorPlanId: number | null,
  ownPrismKeys: readonly string[],
  footprint: Footprint | null = footprintOf(rings),
): ResolvedFocus | null {
  const bounds = ringsBounds(rings)
  if (!bounds) return null
  const c: [number, number] =
    centroid && Number.isFinite(centroid[0]) && Number.isFinite(centroid[1])
      ? [centroid[0], centroid[1]]
      : [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
  return {
    key,
    target,
    position: c,
    altitudeM: topM,
    bounds,
    floorPlanId,
    samples: areaSamples(c, bounds, rings, topM, floorPlanId),
    ownPrismKeys,
    footprint,
  }
}

function boundsCenter(b: readonly [number, number, number, number]): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
}

/** Point `t` (0..1) of the way along a polyline, by length in a local metric frame. */
function alongPolyline(vertices: ReadonlyArray<readonly [number, number]>, t: number): [number, number] {
  if (vertices.length === 1) return [vertices[0][0], vertices[0][1]]
  const k = Math.cos((vertices[0][1] * Math.PI) / 180)
  let total = 0
  const seg: number[] = []
  for (let i = 1; i < vertices.length; i++) {
    const dx = (vertices[i][0] - vertices[i - 1][0]) * k
    const dy = vertices[i][1] - vertices[i - 1][1]
    const len = Math.hypot(dx, dy)
    seg.push(len)
    total += len
  }
  if (!(total > 0)) return [vertices[0][0], vertices[0][1]]
  let want = total * t
  for (let i = 1; i < vertices.length; i++) {
    const len = seg[i - 1]
    if (want <= len || i === vertices.length - 1) {
      const f = len > 0 ? Math.min(1, want / len) : 0
      return [
        vertices[i - 1][0] + (vertices[i][0] - vertices[i - 1][0]) * f,
        vertices[i - 1][1] + (vertices[i][1] - vertices[i - 1][1]) * f,
      ]
    }
    want -= len
  }
  const last = vertices[vertices.length - 1]
  return [last[0], last[1]]
}

function openRing(ring: ReadonlyArray<readonly number[]>): [number, number][] {
  const out: [number, number][] = []
  const n = ring.length
  const closed = n > 3 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]
  for (let i = 0; i < (closed ? n - 1 : n); i++) out.push([ring[i][0], ring[i][1]])
  return out
}

// ---- per-kind resolvers ---------------------------------------------------

function resolveMarkerLike(
  key: string,
  target: FocusTarget,
  row: { position: [number, number]; floorPlanId?: number; config: { elevation?: number } },
): ResolvedFocus | null {
  // Same altitude the overlays place the item at (`Math.max(0, elevation)`)
  // and test occlusion at (`elevationM`, clamped inside the test).
  return pointResolved(key, target, row.position, Math.max(0, finite(row.config.elevation)), floorOf(row))
}

function resolveDoor(key: string, target: FocusTarget, d: DoorShape): ResolvedFocus | null {
  const [v0, v1] = d.vertices ?? []
  if (!v0 || !v1) return null
  // Door overlay's label target: opening midpoint at the door's top.
  const position: [number, number] = [(v0[0] + v1[0]) / 2, (v0[1] + v1[1]) / 2]
  const elevationM = finite(d.config?.elevation) + Math.max(0.01, finite(d.config?.doorHeight))
  const wall = d.config?.attachedToLineId
  const own = typeof wall === 'number' ? Object.freeze([`line:${wall}`]) : NO_KEYS
  return pointResolved(key, target, position, elevationM, floorOf(d), own)
}

function resolvePolygon(key: string, target: FocusTarget, poly: PolygonShape): ResolvedFocus | null {
  const feature = buildPolygonFeature(poly)
  if (!feature) return null
  const ring = openRing(feature.geometry.coordinates[0])
  if (ring.length < 3) return null
  const baseM = Math.max(0, finite(poly.config.elevation))
  const topM = baseM + Math.max(0, finite(poly.config.height))
  return areaResolved(key, target, [ring], polygonCentroid(ring), topM, floorOf(poly), Object.freeze([`polygon:${poly.id}`]))
}

function resolveCircle(key: string, target: FocusTarget, circle: CircleShape): ResolvedFocus | null {
  const rings = buildCircleFeatures(circle)
    .map((f) => f.geometry.coordinates[0])
    .filter((r): r is number[][] => Array.isArray(r) && r.length >= 3)
  if (rings.length === 0) return null
  const baseM = Math.max(0, finite(circle.config.elevation))
  const topM = baseM + Math.max(0, finite(circle.config.height))
  const center = circle.mode === 'single' && circle.center ? circle.center : null
  // Grid mode draws one circle per cell: one hull instead of hundreds of rings.
  const footprint = rings.length > 4 ? hullFootprint(rings) : footprintOf(rings)
  return areaResolved(key, target, rings, center, topM, floorOf(circle), Object.freeze([`circle:${circle.id}:`]), footprint)
}

/** Every ring of a Polygon (`number[][][]`) or MultiPolygon (`number[][][][]`) coordinate array. */
function polygonRings(coords: unknown): Ring[] {
  const c = coords as number[][][] | number[][][][]
  if (!Array.isArray(c) || c.length === 0) return []
  if (typeof (c as number[][][])[0]?.[0]?.[0] === 'number') return c as number[][][]
  const out: Ring[] = []
  for (const piece of c as number[][][][]) for (const r of piece ?? []) out.push(r)
  return out
}

function resolveLine(key: string, target: FocusTarget, line: LineShape): ResolvedFocus | null {
  if (!line.vertices || line.vertices.length < 2) return null
  const drawn = rotateLine(line.vertices, line.rotation ?? 0)
  const baseM = Math.max(0, finite(line.config.elevation))
  const topM = baseM + Math.max(0, finite(line.config.height))
  const floorPlanId = floorOf(line)
  // A leaning wall is drawn as a mesh whose top overhangs the base line by
  // `lean`: ring, samples and footprint follow the drawn top rim and the
  // plan band it covers (with the opening as a hole on a closed loop) —
  // the same band its occluder slices span.
  const leaning = wallLeans(line.config, line.config.height)
  const topLine = leaning ? leaningWallTopLine(drawn, line.config) : null
  const along = topLine && topLine.length >= 2 ? topLine : drawn
  const leanRings = leaning ? leaningWallFootprint(drawn, line.config) : null
  const bounds = ringsBounds(leanRings ? [drawn, along, ...leanRings] : [drawn])
  if (!bounds) return null
  const samples = [0.5, 0.25, 0.75].map((t, i) => {
    const s = pointSample(alongPolyline(along, t), topM, floorPlanId)
    s.id = i
    return s
  })
  // The wall's outline — the same `buildLineWallFeature` its prism is
  // built from, every ring (a closed loop keeps its open middle as a
  // hole). A flat line has no wall: its drawn bounds instead.
  const wall = leanRings ? null : buildLineWallFeature(line)
  const footprint =
    (leanRings ? footprintOf(leanRings) : null) ??
    (wall ? footprintOf(polygonRings(wall.geometry.coordinates)) : null) ??
    footprintOf([
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[1]],
        [bounds[2], bounds[3]],
        [bounds[0], bounds[3]],
      ],
    ])
  return {
    key,
    target,
    position: [samples[0].position[0], samples[0].position[1]],
    altitudeM: topM,
    bounds,
    floorPlanId,
    samples: Object.freeze(samples),
    ownPrismKeys: Object.freeze([`line:${line.id}`]),
    footprint,
  }
}

function resolveStair(
  key: string,
  target: FocusTarget,
  stair: StairShape,
  images: readonly ImageShape[] | undefined,
): ResolvedFocus | null {
  if (isLiftType(stair.config.stairType)) return resolveLift(key, target, stair, images)
  const fc = stairToFeatureCollection(stair)
  const rings: number[][][] = []
  let topM = -Infinity
  for (const f of fc.features) {
    const ring = f.geometry.coordinates[0]
    if (!ring || ring.length < 3) continue
    rings.push(ring)
    const h = finite(f.properties.height, NaN)
    if (Number.isFinite(h) && h > topM) topM = h
  }
  if (rings.length === 0) return null
  if (!Number.isFinite(topM)) topM = 0
  const bounds = ringsBounds(rings)
  if (!bounds) return null
  return areaResolved(
    key,
    target,
    rings,
    boundsCenter(bounds),
    Math.max(0, topM),
    floorOf(stair),
    Object.freeze([`stair:${stair.id}:`]),
    hullFootprint(rings),
  )
}

/**
 * A lift (escalator / elevator) is anchored where the stair overlay draws
 * it on the item's own floor: its wayfinding icon (`liftIconFeatures`,
 * built with the same floor elevations the overlay passes) whose z is
 * closest to that floor's elevation — the lowest icon when the floor is
 * unknown. The shaft's top would put the ring floors above the drawn box.
 * Samples sit at that altitude over the solid (non-glass) parts.
 *
 * An elevator's ring sits on its car instead of the floor sign: at the
 * centre of the lift's drawn bounds, at the top of the box over that stop
 * — `min(stop + 2.75 m, next stop − 0.1 m, top)` (a stop is its icon's z
 * − 0.05). Escalators keep the icon anchor.
 */
/** An elevator's ring sits this far above its stop (a car's height), metres. */
const LIFT_RING_ABOVE_STOP_M = 2.75

function resolveLift(
  key: string,
  target: FocusTarget,
  stair: StairShape,
  images: readonly ImageShape[] | undefined,
): ResolvedFocus | null {
  const fe = new Map<number, number>()
  for (const img of images ?? []) {
    if (typeof img.id === 'number') fe.set(img.id, finite(img.config?.elevation))
  }
  const fc = stairToFeatureCollection(stair, { floorElevations: fe })
  const all: number[][][] = []
  const solid: number[][][] = []
  let topM = -Infinity
  for (const f of fc.features) {
    const ring = f.geometry.coordinates[0]
    if (!ring || ring.length < 3) continue
    all.push(ring)
    if (!f.properties.glass && !f.properties.seeThrough) solid.push(ring)
    const h = finite(f.properties.height, NaN)
    if (Number.isFinite(h) && h > topM) topM = h
  }
  if (all.length === 0) return null
  const bounds = ringsBounds(all)
  if (!bounds) return null
  const floorPlanId = floorOf(stair)
  const ownPrismKeys = Object.freeze([`stair:${stair.id}:`])
  const footprint = hullFootprint(all)
  const own = floorPlanId !== null ? fe.get(floorPlanId) : undefined
  let anchor: { position: [number, number]; z: number } | null = null
  let best = Infinity
  const stopZs: number[] = []
  for (const icon of liftIconFeatures(stair, fe)) {
    const [x, y] = icon.geometry.coordinates
    const z = icon.properties.z
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    stopZs.push(z)
    const score = own !== undefined ? Math.abs(z - own) : z
    if (score < best) {
      best = score
      anchor = { position: [x, y], z }
    }
  }
  if (!anchor) {
    // No icon (degenerate lift): the old box-centre anchor at the top.
    return areaResolved(
      key,
      target,
      all,
      boundsCenter(bounds),
      Math.max(0, Number.isFinite(topM) ? topM : 0),
      floorPlanId,
      ownPrismKeys,
      footprint,
    )
  }
  let position = anchor.position
  let altitudeM = Math.max(0, anchor.z)
  if (stair.config.stairType === 'elevator') {
    const stop = anchor.z - 0.05
    let nextStop = Infinity
    for (const z of stopZs) if (z - 0.05 > stop + 1e-6 && z - 0.05 < nextStop) nextStop = z - 0.05
    const top = Number.isFinite(topM) ? topM : Infinity
    const lid = Math.min(stop + LIFT_RING_ABOVE_STOP_M, nextStop - 0.1, top)
    altitudeM = Math.max(0, Number.isFinite(lid) ? lid : stop)
    position = boundsCenter(bounds)
  }
  const samples =
    solid.length > 0
      ? areaSamples(position, ringsBounds(solid) ?? bounds, solid, altitudeM, floorPlanId)
      : Object.freeze([pointSample(position, altitudeM, floorPlanId)])
  return {
    key,
    target,
    position,
    altitudeM,
    bounds,
    floorPlanId,
    samples,
    ownPrismKeys,
    footprint,
  }
}

function resolveImage(key: string, target: FocusTarget, img: ImageShape): ResolvedFocus | null {
  const corners = imageCroppedCorners(img)
  if (!corners) return null
  let cx = 0
  let cy = 0
  for (const [x, y] of corners) {
    cx += x
    cy += y
  }
  const altitudeM = Math.max(0, finite(img.config.elevation))
  return areaResolved(key, target, [corners], [cx / 4, cy / 4], altitudeM, img.id ?? null, Object.freeze([`image:${img.id}`]))
}

/**
 * The last grid tessellated here — consecutive bin focuses on one rack
 * (the common case: clicking through a rack's bins) reuse it instead of
 * re-tessellating. One entry, so a stadium grid isn't kept alive by it
 * for long.
 */
let lastGridCells: {
  cfg: GridConfig
  id: number
  start: [number, number]
  current: [number, number]
  cells: GridCell[]
} | null = null

function gridCells(grid: GridOccluderInput & { id: number }): GridCell[] {
  const last = lastGridCells
  if (last && last.cfg === grid.config && last.id === grid.id && last.start === grid.start && last.current === grid.current) {
    return last.cells
  }
  // The same tessellation `buildOccluders` and the grid overlay use.
  const { cells } = buildGridFromLine(grid.start, grid.current, grid.config, { committed: true, gridId: grid.id })
  lastGridCells = { cfg: grid.config, id: grid.id, start: grid.start, current: grid.current, cells }
  return cells
}

function cellTopM(cell: GridCell): number {
  const p = cell.properties
  return Math.max(0, finite(p.elevation)) + Math.max(0, finite(p.height))
}

function resolveGrid(key: string, target: FocusShapeTarget, grid: GridOccluderInput & { id: number }): ResolvedFocus | null {
  const cells = gridCells(grid)
  if (cells.length === 0) return null
  const floorPlanId = floorOf(grid)
  if (target.cell) {
    const { row, col, level } = target.cell
    // First match: triangle grids have two cells (A / B) per (row, col,
    // level), and the key can't tell them apart.
    const cell = cells.find((c) => c.properties.row === row && c.properties.col === col && (c.properties.level ?? 0) === level)
    if (!cell) return null
    const ring = openRing(cell.geometry.coordinates[0])
    if (ring.length < 3) return null
    let sx = 0
    let sy = 0
    for (const [x, y] of ring) {
      sx += x
      sy += y
    }
    const centroid: [number, number] = [sx / ring.length, sy / ring.length]
    const bounds = ringsBounds([ring])
    if (!bounds) return null
    const topM = cellTopM(cell)
    return {
      key,
      target,
      position: centroid,
      altitudeM: topM,
      bounds,
      floorPlanId,
      // One sample, at the cell's centroid and top — a bin is small, and
      // inset corners would mostly re-test the same line of sight.
      samples: Object.freeze([pointSample(centroid, topM, floorPlanId)]),
      ownPrismKeys: Object.freeze([`grid:${grid.id}:${row}:${col}:${level}`]),
      footprint: Object.freeze([Object.freeze(ring)]),
    }
  }
  const rings: number[][][] = []
  let topM = 0
  for (const c of cells) {
    const r = c.geometry.coordinates[0]
    if (!r || r.length < 3) continue
    rings.push(r)
    const t = cellTopM(c)
    if (t > topM) topM = t
  }
  const bounds = ringsBounds(rings)
  if (!bounds) return null
  return areaResolved(
    key,
    target,
    rings,
    boundsCenter(bounds),
    topM,
    floorPlanId,
    Object.freeze([`grid:${grid.id}:`]),
    hullFootprint(rings),
  )
}

/** null when the id is unknown, or for a dl target without `anchor` (pending). */
export function resolveFocus(target: FocusTarget | null, shapes: FocusShapes): ResolvedFocus | null {
  if (!target) return null
  const key = focusKey(target)
  if (target.kind === 'dl') {
    const a = target.anchor
    if (!a) return null
    return cachedResolve(a, key, [a.position, a.elevationM, a.floorPlanId], () =>
      pointResolved(key, target, a.position, Math.max(0, finite(a.elevationM)), a.floorPlanId ?? null),
    )
  }
  const id = target.id
  switch (target.kind) {
    case 'markers': {
      const row = findById(shapes.markers, id)
      return row ? cachedResolve(row, key, [], () => resolveMarkerLike(key, target, row)) : null
    }
    case 'text-labels': {
      const row = findById(shapes.textLabels, id)
      return row ? cachedResolve(row, key, [], () => resolveMarkerLike(key, target, row)) : null
    }
    case 'models': {
      const row = findById(shapes.models, id)
      return row ? cachedResolve(row, key, [], () => resolveMarkerLike(key, target, row)) : null
    }
    case 'image-planes': {
      const row = findById(shapes.imagePlanes, id)
      return row ? cachedResolve(row, key, [], () => resolveMarkerLike(key, target, row)) : null
    }
    case 'doors': {
      const row = findById(shapes.doors, id)
      return row ? cachedResolve(row, key, [], () => resolveDoor(key, target, row)) : null
    }
    case 'polygons': {
      const row = findById(shapes.polygons, id)
      return row ? cachedResolve(row, key, [], () => resolvePolygon(key, target, row)) : null
    }
    case 'circles': {
      const row = findById(shapes.circles, id)
      return row ? cachedResolve(row, key, [], () => resolveCircle(key, target, row)) : null
    }
    case 'lines': {
      const row = findById(shapes.lines, id)
      return row ? cachedResolve(row, key, [], () => resolveLine(key, target, row)) : null
    }
    case 'stairs': {
      const row = findById(shapes.stairs, id)
      if (!row) return null
      // A lift is built against the floors' elevations: re-resolve when
      // the images array changes.
      const sig = isLiftType(row.config.stairType) ? [shapes.images] : []
      return cachedResolve(row, key, sig, () => resolveStair(key, target, row, shapes.images))
    }
    case 'images': {
      const row = findById(shapes.images, id)
      return row ? cachedResolve(row, key, [], () => resolveImage(key, target, row)) : null
    }
    case 'grids': {
      const row = findById(shapes.grids, id)
      if (!row || row.id === undefined || !row.config) return null
      const grid = row as GridOccluderInput & { id: number }
      // Grid inputs are often fresh wrappers (`CommittedLine`) around the
      // row's own config / corners — cache on the config, like
      // `buildOccluders` does, and check the rest.
      return cachedResolve(grid.config, key, [grid.id, grid.start, grid.current, grid.floorPlanId], () =>
        resolveGrid(key, target, grid),
      )
    }
  }
  return null
}

export function isOwnPrismKey(resolved: ResolvedFocus, prismKey: string): boolean {
  for (const k of resolved.ownPrismKeys) {
    if (k.endsWith(':') ? prismKey.startsWith(k) : prismKey === k) return true
  }
  return false
}
