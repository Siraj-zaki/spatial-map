/**
 * Runtime point clustering for data-link point layers (point-at-coord /
 * history-movement) — pure TypeScript, no React, no map writes.
 *
 * Why not Mapbox's native GeoJSON clustering: the source `maxzoom`
 * defaults to 18, so native clusters freeze above z18; rows 1–2 cm apart
 * (an RFID bag pile) never separate; and supercluster can't keep floors,
 * rooms or field values apart. So the overlay pre-aggregates here on the
 * main thread, once per data / filter / floor / focus / setting change
 * and once per settled zoom bucket (`clusterZoomBucket`), never per frame.
 *
 * Three modes:
 *   - `location` — a greedy grid hash in Web-Mercator world pixels at the
 *     bucket zoom (cell = radius px): each unassigned item, in input
 *     order, seeds a group of the unassigned items within `radius` px.
 *   - `room`     — one bubble per room (the smallest polygon on the item's
 *     floor that contains it), at the room's label point; zoom-independent.
 *     Items outside every room fall back to `location`.
 *   - `field`    — `location`, partitioned by the item's `part` (the
 *     field value); bubbles of different values that land on top of each
 *     other are fanned out on a small ring.
 *
 * Every mode is partitioned by floor first. A group of one stays a single.
 */

import { destination as turfDestination, point as turfPoint } from '@turf/turf'
import type { PolygonShape } from '@/lib/shapes'
import { buildPolygonFeature, polygonCentroid } from '@/lib/polygon-generators'

// ---------------------------------------------------------------------------
// types + constants
// ---------------------------------------------------------------------------

export type PointClusterMode = 'location' | 'room' | 'field'

export interface PointClusterSpec {
  mode: PointClusterMode
  /** Screen radius in px (location grouping; room mode: items outside rooms). */
  radius: number
  /** Field mode: the payload field whose value partitions the items. */
  field?: string
}

export const CLUSTER_RADIUS_DEFAULT = 48
export const CLUSTER_RADIUS_MIN = 20
export const CLUSTER_RADIUS_MAX = 120
export const CLUSTER_MAX_ZOOM = 22

/** The zoom clustering runs at: half-zoom steps, clamped to 0–22. */
export function clusterZoomBucket(zoom: number): number {
  if (!Number.isFinite(zoom)) return 0
  return Math.min(CLUSTER_MAX_ZOOM, Math.max(0, Math.floor(zoom * 2) / 2))
}

export interface ClusterItem {
  key: string
  lng: number
  lat: number
  elevation: number
  /** The colour the item's disc draws in (its ring segment). */
  color: string
  floor: number | null
  /** Field mode: the item's value; '' otherwise. */
  part: string
}

export interface ClusterBreakdownEntry {
  color: string
  count: number
}

export interface ClusterBubbleProps {
  clusterKey: string
  configId: number
  point_count: number
  point_count_abbreviated: string
  elevation: number
  /** Donut image id (`donutImageId`). */
  icon: string
  /** Room name | field value | ''. */
  label: string
  labelKind: 'location' | 'room' | 'field'
  /** `hex:count,...`, largest first. */
  breakdown: string
}

export interface ClusterMembers {
  kind: PointClusterMode
  keys: readonly string[]
  items: readonly ClusterItem[]
  bbox: [number, number, number, number]
  label: string
  radius: number
  breakdown: readonly ClusterBreakdownEntry[]
}

export interface ClusterResult {
  /** Keys folded into a bubble (left out of the singles source). */
  memberKeys: ReadonlySet<string>
  bubbles: GeoJSON.Feature<GeoJSON.Point, ClusterBubbleProps>[]
  members: Map<string, ClusterMembers>
}

/** A bubble the viewer picked for the list (the members couldn't separate). */
export interface ClusterPick {
  configId: number
  clusterKey: string
  keys: ReadonlySet<string>
  label: string
  labelKind: 'location' | 'room' | 'field'
  breakdown: readonly ClusterBreakdownEntry[]
}

// ---------------------------------------------------------------------------
// room index
// ---------------------------------------------------------------------------

interface RoomEntry {
  id: number
  name: string
  floor: number | undefined
  ring: [number, number][]
  minX: number
  minY: number
  maxX: number
  maxY: number
  area: number
  point: [number, number]
}

type RoomHit = { id: number; name: string; point: [number, number] } | null

export interface RoomIndex {
  readonly rooms: readonly RoomEntry[]
  readonly cache: Map<string, RoomHit>
}

/** Room lookup table over the facility's polygons (rebuild when they change). */
export function buildRoomIndex(polygons: ReadonlyArray<PolygonShape>): RoomIndex {
  const rooms: RoomEntry[] = []
  for (const p of polygons) {
    if (p.id === undefined) continue
    const f = buildPolygonFeature(p)
    const center = polygonCentroid(p.vertices)
    if (!f || !center) continue
    const ring = f.geometry.coordinates[0] as [number, number][]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    // Planar shoelace on (lng·cos(lat), lat): ranking only.
    const k = Math.cos(((minY + maxY) / 2) * (Math.PI / 180))
    let a = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += ring[j][0] * k * ring[i][1] - ring[i][0] * k * ring[j][1]
    }
    // The label point, exactly as map-polygon-overlay places a room label.
    const offX = p.config?.labelOffsetX ?? 0
    const offY = p.config?.labelOffsetY ?? 0
    let point: [number, number] = center
    if (offX !== 0 || offY !== 0) {
      const distance = Math.hypot(offX, offY)
      const bearing = (Math.atan2(offX, offY) * 180) / Math.PI + (p.rotation ?? 0)
      point = turfDestination(turfPoint(center), distance, bearing, { units: 'meters' }).geometry.coordinates as [number, number]
    }
    rooms.push({
      id: p.id,
      name: p.config?.label?.trim() || p.name || '',
      floor: p.floorPlanId,
      ring,
      minX, minY, maxX, maxY,
      area: Math.abs(a) / 2,
      point,
    })
  }
  return { rooms, cache: new Map() }
}

function ringContains(ring: readonly [number, number][], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * The smallest room containing the point on its floor (a polygon with no
 * floor counts on every floor; an item with an unknown floor tests every
 * room), or null.
 */
export function roomOf(index: RoomIndex, lng: number, lat: number, floor: number | null): RoomHit {
  const cacheKey = `${lng},${lat},${floor}`
  const cached = index.cache.get(cacheKey)
  if (cached !== undefined) return cached
  let best: RoomEntry | null = null
  for (const r of index.rooms) {
    if (floor !== null && r.floor !== undefined && r.floor !== floor) continue
    if (lng < r.minX || lng > r.maxX || lat < r.minY || lat > r.maxY) continue
    if (best && r.area >= best.area) continue
    if (ringContains(r.ring, lng, lat)) best = r
  }
  const hit: RoomHit = best ? { id: best.id, name: best.name, point: best.point } : null
  index.cache.set(cacheKey, hit)
  return hit
}

// ---------------------------------------------------------------------------
// colours + donut image ids
// ---------------------------------------------------------------------------

const HEX6 = /^#([0-9a-f]{6})$/i
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i

/** A colour as an image-id-safe token: `#rrggbb` → `rrggbb`, else URI-encoded. */
export function colorToken(c: string): string {
  const m6 = HEX6.exec(c)
  if (m6) return m6[1].toLowerCase()
  const m3 = HEX3.exec(c)
  if (m3) return `${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase()
  return encodeURIComponent(c)
}

function tokenColor(tok: string): string {
  if (/^[0-9a-f]{6}$/.test(tok)) return `#${tok}`
  try {
    return decodeURIComponent(tok)
  } catch {
    return tok
  }
}

export const DONUT_IMAGE_PREFIX = 'dl-donut:'
const DONUT_UNITS = 32
const DONUT_MAX_SEGMENTS = 6
/** Bubble radius per size bucket — the native cluster radii (14/18/22/28 px). */
const DONUT_RADII = [14, 18, 22, 28] as const

function sizeBucket(count: number): 0 | 1 | 2 | 3 {
  return count < 25 ? 0 : count < 100 ? 1 : count < 500 ? 2 : 3
}

/**
 * The donut icon id of a bubble: its size bucket plus up to six colour
 * segments in 32 units. Every colour present gets at least one unit (one
 * red bag among 546 stays visible); the largest absorbs the rounding.
 */
export function donutImageId(breakdown: readonly ClusterBreakdownEntry[], count: number): string {
  const segs = breakdown.slice(0, DONUT_MAX_SEGMENTS)
  const total = segs.reduce((s, e) => s + e.count, 0)
  if (segs.length === 0 || total <= 0) return `${DONUT_IMAGE_PREFIX}${sizeBucket(count)}:`
  const units = segs.map((e) => Math.max(1, Math.round((DONUT_UNITS * e.count) / total)))
  let largest = 0
  for (let i = 1; i < segs.length; i++) if (segs[i].count > segs[largest].count) largest = i
  const others = units.reduce((s, u, i) => (i === largest ? s : s + u), 0)
  units[largest] = Math.max(1, DONUT_UNITS - others)
  return `${DONUT_IMAGE_PREFIX}${sizeBucket(count)}:${segs.map((e, i) => `${colorToken(e.color)}.${units[i]}`).join('_')}`
}

export function parseDonutImageId(
  id: string,
): { size: 0 | 1 | 2 | 3; radiusPx: number; segments: { color: string; units: number }[] } | null {
  if (!id.startsWith(DONUT_IMAGE_PREFIX)) return null
  const rest = id.slice(DONUT_IMAGE_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon < 0) return null
  const size = Number(rest.slice(0, colon))
  if (size !== 0 && size !== 1 && size !== 2 && size !== 3) return null
  const body = rest.slice(colon + 1)
  const segments: { color: string; units: number }[] = []
  if (body !== '') {
    for (const part of body.split('_')) {
      const dot = part.lastIndexOf('.')
      if (dot <= 0) return null
      const units = Number(part.slice(dot + 1))
      if (!Number.isFinite(units) || units <= 0) return null
      segments.push({ color: tokenColor(part.slice(0, dot)), units })
    }
  }
  return { size, radiusPx: DONUT_RADII[size], segments }
}

// ---------------------------------------------------------------------------
// clustering
// ---------------------------------------------------------------------------

const TILE = 512
const DEG = Math.PI / 180

function worldX(lng: number, scale: number): number {
  return ((lng + 180) / 360) * scale
}
function worldY(lat: number, scale: number): number {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * DEG)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale
}
function lngOf(x: number, scale: number): number {
  return (x / scale) * 360 - 180
}
function latOf(y: number, scale: number): number {
  const n = Math.PI - (2 * Math.PI * y) / scale
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI
}

function abbreviate(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`
  return String(n)
}

function breakdownOf(group: readonly ClusterItem[]): ClusterBreakdownEntry[] {
  const counts = new Map<string, ClusterBreakdownEntry>()
  for (const it of group) {
    const tok = colorToken(it.color)
    const e = counts.get(tok)
    if (e) e.count += 1
    else counts.set(tok, { color: tokenColor(tok), count: 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || (a.color < b.color ? -1 : a.color > b.color ? 1 : 0))
}

interface PendingBubble {
  key: string
  kind: PointClusterMode
  label: string
  group: ClusterItem[]
  lng: number
  lat: number
  floor: number | null
  part: string
}

/** Greedy grid grouping of `idx` (indices into `items`) at world `scale`. */
function groupByLocation(
  items: readonly ClusterItem[],
  idx: readonly number[],
  scale: number,
  radius: number,
  assigned: Uint8Array,
  onGroup: (seed: number, members: number[]) => void,
): void {
  const n = idx.length
  if (n === 0) return
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  let minCx = Infinity, minCy = Infinity, maxCx = -Infinity, maxCy = -Infinity
  const cxs = new Float64Array(n)
  const cys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const it = items[idx[i]]
    const x = worldX(it.lng, scale)
    const y = worldY(it.lat, scale)
    xs[i] = x
    ys[i] = y
    const cx = Math.floor(x / radius)
    const cy = Math.floor(y / radius)
    cxs[i] = cx
    cys[i] = cy
    if (cx < minCx) minCx = cx
    if (cx > maxCx) maxCx = cx
    if (cy < minCy) minCy = cy
    if (cy > maxCy) maxCy = cy
  }
  const spanY = maxCy - minCy + 3
  const cellKey = (cx: number, cy: number) => (cx - minCx + 1) * spanY + (cy - minCy + 1)
  const grid = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const k = cellKey(cxs[i], cys[i])
    const cell = grid.get(k)
    if (cell) cell.push(i)
    else grid.set(k, [i])
  }
  const r2 = radius * radius
  for (let i = 0; i < n; i++) {
    if (assigned[idx[i]]) continue
    const members: number[] = []
    const x = xs[i], y = ys[i]
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(cellKey(cxs[i] + dx, cys[i] + dy))
        if (!cell) continue
        for (const j of cell) {
          if (assigned[idx[j]]) continue
          const ddx = xs[j] - x
          const ddy = ys[j] - y
          if (ddx * ddx + ddy * ddy <= r2) members.push(idx[j])
        }
      }
    }
    for (const m of members) assigned[m] = 1
    onGroup(idx[i], members)
  }
}

/**
 * Fold `items` into bubbles for `spec` at `zoom` (use `clusterZoomBucket`).
 * Items keep their input order as seeds, so bubble keys are stable while
 * the data is.
 */
export function clusterPoints(
  items: readonly ClusterItem[],
  spec: PointClusterSpec,
  zoom: number,
  opts: { configId: number; rooms?: RoomIndex | null },
): ClusterResult {
  const memberKeys = new Set<string>()
  const bubbles: GeoJSON.Feature<GeoJSON.Point, ClusterBubbleProps>[] = []
  const members = new Map<string, ClusterMembers>()
  if (items.length < 2) return { memberKeys, bubbles, members }

  const radius = Math.max(1, spec.radius)
  const scale = TILE * Math.pow(2, clusterZoomBucket(zoom))
  const assigned = new Uint8Array(items.length)
  const pending: PendingBubble[] = []
  const floorTag = (f: number | null) => (f === null ? '-' : String(f))

  // Room mode: one group per (floor, room); groups of one fall back.
  if (spec.mode === 'room' && opts.rooms) {
    const byRoom = new Map<number | null, Map<number, number[]>>()
    const roomHit = new Map<number, NonNullable<RoomHit>>()
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const hit = roomOf(opts.rooms, it.lng, it.lat, it.floor)
      if (!hit) continue
      roomHit.set(hit.id, hit)
      let perFloor = byRoom.get(it.floor)
      if (!perFloor) byRoom.set(it.floor, (perFloor = new Map()))
      const list = perFloor.get(hit.id)
      if (list) list.push(i)
      else perFloor.set(hit.id, [i])
    }
    for (const [floor, perFloor] of byRoom) {
      for (const [roomId, list] of perFloor) {
        if (list.length < 2) continue
        const hit = roomHit.get(roomId)!
        for (const i of list) assigned[i] = 1
        pending.push({
          key: `room:${floorTag(floor)}:${roomId}`,
          kind: 'room',
          label: hit.name,
          group: list.map((i) => items[i]),
          lng: hit.point[0],
          lat: hit.point[1],
          floor,
          part: '',
        })
      }
    }
  }

  // Location (and field) grouping, per floor and part.
  const partitions = new Map<number | null, Map<string, number[]>>()
  for (let i = 0; i < items.length; i++) {
    if (assigned[i]) continue
    const it = items[i]
    let perFloor = partitions.get(it.floor)
    if (!perFloor) partitions.set(it.floor, (perFloor = new Map()))
    const part = spec.mode === 'field' ? it.part : ''
    const list = perFloor.get(part)
    if (list) list.push(i)
    else perFloor.set(part, [i])
  }
  const locKind: PointClusterMode = spec.mode === 'field' ? 'field' : 'location'
  for (const [floor, perFloor] of partitions) {
    for (const [part, idx] of perFloor) {
      groupByLocation(items, idx, scale, radius, assigned, (seed, group) => {
        if (group.length < 2) {
          // A single: release it (it isn't anyone's member).
          return
        }
        let sx = 0, sy = 0
        for (const g of group) {
          sx += items[g].lng
          sy += items[g].lat
        }
        pending.push({
          key: `loc:${floorTag(floor)}:${part}:${items[seed].key}`,
          kind: locKind,
          label: locKind === 'field' ? part : '',
          group: group.map((g) => items[g]),
          lng: sx / group.length,
          lat: sy / group.length,
          floor,
          part,
        })
      })
    }
  }

  if (spec.mode === 'field') fanOut(pending, scale)

  for (const b of pending) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let elevation = -Infinity
    const keys: string[] = new Array(b.group.length)
    for (let i = 0; i < b.group.length; i++) {
      const it = b.group[i]
      keys[i] = it.key
      memberKeys.add(it.key)
      if (it.lng < minX) minX = it.lng
      if (it.lng > maxX) maxX = it.lng
      if (it.lat < minY) minY = it.lat
      if (it.lat > maxY) maxY = it.lat
      if (it.elevation > elevation) elevation = it.elevation
    }
    if (!Number.isFinite(elevation)) elevation = 0
    const breakdown = breakdownOf(b.group)
    const count = b.group.length
    members.set(b.key, {
      kind: b.kind,
      keys,
      items: b.group,
      bbox: [minX, minY, maxX, maxY],
      label: b.label,
      radius,
      breakdown,
    })
    bubbles.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
      properties: {
        clusterKey: b.key,
        configId: opts.configId,
        point_count: count,
        point_count_abbreviated: abbreviate(count),
        elevation,
        icon: donutImageId(breakdown, count),
        label: b.label,
        labelKind: b.kind,
        breakdown: breakdown.map((e) => `${colorToken(e.color)}:${e.count}`).join(','),
      },
    })
  }
  return { memberKeys, bubbles, members }
}

/**
 * Field mode: bubbles of different values on one floor that would overlap
 * (closer than their radii plus a gap) are spread on a small ring around
 * their mean, largest first, so "479 · 67" reads side by side.
 */
function fanOut(pending: PendingBubble[], scale: number): void {
  if (pending.length < 2) return
  const GAP = 4
  const n = pending.length
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const rs = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = worldX(pending[i].lng, scale)
    ys[i] = worldY(pending[i].lat, scale)
    rs[i] = DONUT_RADII[sizeBucket(pending[i].group.length)]
  }
  // Union-find over overlapping pairs on the same floor.
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pending[i].floor !== pending[j].floor || pending[i].part === pending[j].part) continue
      const d = Math.hypot(xs[i] - xs[j], ys[i] - ys[j])
      if (d < rs[i] + rs[j] + GAP) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const g = groups.get(root)
    if (g) g.push(i)
    else groups.set(root, [i])
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue
    g.sort((a, b) => pending[b].group.length - pending[a].group.length)
    let cx = 0, cy = 0
    for (const i of g) {
      cx += xs[i]
      cy += ys[i]
    }
    cx /= g.length
    cy /= g.length
    const m = g.length
    const chord = 2 * Math.sin(Math.PI / m)
    let ring = 0
    for (let k = 0; k < m; k++) {
      const a = g[k]
      const b = g[(k + 1) % m]
      ring = Math.max(ring, (rs[a] + rs[b] + GAP) / chord)
    }
    for (let k = 0; k < m; k++) {
      const angle = Math.PI + (2 * Math.PI * k) / m
      const i = g[k]
      pending[i].lng = lngOf(cx + Math.cos(angle) * ring, scale)
      pending[i].lat = latOf(cy + Math.sin(angle) * ring, scale)
    }
  }
}

/**
 * Whether zooming in can split the bubble: its members re-clustered alone
 * at the deepest zoom with the same radius give more than one group. Room
 * bubbles never qualify (rooms don't depend on zoom).
 */
export function isClusterExpandable(m: ClusterMembers): boolean {
  if (m.kind === 'room') return false
  const r = clusterPoints(m.items, { mode: 'location', radius: m.radius }, CLUSTER_MAX_ZOOM, { configId: 0 })
  const singles = m.items.length - r.memberKeys.size
  return r.bubbles.length + singles > 1
}

// ---------------------------------------------------------------------------
// registry (mirrors manualClusterLeaves): the last push's members per config
// ---------------------------------------------------------------------------

const runtimeMembers = new Map<number, ReadonlyMap<string, ClusterMembers>>()

export function setRuntimeClusterMembers(configId: number, members: ReadonlyMap<string, ClusterMembers>): void {
  runtimeMembers.set(configId, members)
}

export function getRuntimeClusterMembers(configId: number, clusterKey: string): ClusterMembers | undefined {
  return runtimeMembers.get(configId)?.get(clusterKey)
}

export function clearRuntimeClusterMembers(configId: number): void {
  runtimeMembers.delete(configId)
}
