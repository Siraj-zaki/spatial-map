/**
 * Route options between two places, on one floor or across floors.
 *
 * Per floor, `computeRoute` (occupancy grid + A* + the orthogonal post
 * process) does the walking part on that floor's own shapes. Floors are
 * joined by **portals** — the facility's stairs, escalators and lifts:
 *   - a lift serves `servedFloorPlanIds` (and lifts drawn on several floors
 *     within 3 m of each other are one shaft);
 *   - an escalator joins the floors at its two landings, one way;
 *   - a staircase joins the floor at its base height and the next floor
 *     up, when it really climbs (≥ half the floor height).
 * A portal stands at its landing / door on every floor it serves.
 *
 * Options offered (each only when it exists and differs from the others):
 *   fastest      least walking time + floor-change time;
 *   stepFree     lifts only — no stairs or escalators;
 *   alternative  a really different way: another portal, or on one floor
 *                the best route that avoids the middle of the fastest one
 *                (shares < 60 % of it and is < 1.5× longer).
 *
 * Shared by the web editor / viewer route tool and the mobile app (synced
 * into its core). A floor is a floor-plan image (`images`); shapes belong
 * to the floor in their `floorPlanId`, or to the lowest floor when unset.
 */

import { along, buffer, length as turfLength, lineString, nearestPointOnLine } from '@turf/turf'
import type { Polygon } from 'geojson'

import type { DoorShape } from '@/lib/door/types'
import type { Grid } from '@/lib/db'
import type { CircleShape, ImageShape, LineShape, ModelShape, PolygonShape, StairShape } from '@/lib/shapes'
import { liftIconFeatures, stairWalkRuns, type StairWalkRun } from '@/lib/stair-generators'
import { snapToWalkable } from './astar'
import { generateInstructions, type Instruction } from './directions'
import { circleObstacles, modelObstacles, SOLID_ROLE, solidPolygons, stairObstacles } from './obstacles'
import { cellToLl, isBlocked, llToCell, type CompiledGrid } from './occupancy-grid'
import { computeRoute } from './router'
import { buildRoutingScene } from './scene-adapter'
import type { LngLat, RoutingScene } from './types'

const SOLID = new Set([SOLID_ROLE])
const SNAP_METERS = 8

/** Everything on the facility's map the planner reads. */
export interface FacilityRoutingInput {
  images: ReadonlyArray<ImageShape>
  lines: ReadonlyArray<LineShape>
  doors: ReadonlyArray<DoorShape>
  polygons: ReadonlyArray<PolygonShape>
  grids: ReadonlyArray<Grid>
  stairs: ReadonlyArray<StairShape>
  circles?: ReadonlyArray<CircleShape>
  models?: ReadonlyArray<ModelShape>
  /** Model asset id → glTF bounds (`useModelBoundsMap`, or a plain object). */
  modelBounds?: ReadonlyMap<string, unknown> | Record<string, unknown>
  /** Only to tell which floors are in use (a floor with only markers on it). */
  markers?: ReadonlyArray<{ floorPlanId?: number | null }>
}

export interface Floor {
  id: number
  name: string
  elevation: number
}

export interface Endpoint {
  floorId: number | null
  coord: LngLat
}

export type PortalKind = 'stairs' | 'escalator' | 'lift'

export interface Leg {
  floorId: number | null
  waypoints: LngLat[]
  meters: number
}

export interface Transition {
  portal: Portal
  fromFloor: Floor
  toFloor: Floor
}

export interface RouteOption {
  id: 'fastest' | 'stepFree' | 'alternative'
  legs: Leg[]
  /** transitions[i] joins legs[i] and legs[i + 1]. */
  transitions: Transition[]
  meters: number
  seconds: number
}

export type PlanResult =
  | { status: 'ok'; options: RouteOption[] }
  | { status: 'start-blocked' | 'end-blocked' | 'unreachable' | 'no-connection' }

const WALK_MPS = 1.3
const CHANGE_SECONDS: Record<PortalKind, number> = { stairs: 20, escalator: 25, lift: 45 }

// ---- floors

/** "01-ground-floor" → "Ground floor" (a label set on the plan wins). */
export function floorName(img: ImageShape): string {
  const label = (img.config as { label?: string }).label?.trim()
  if (label) return label
  const s = img.name.replace(/^[\d\s_-]+/, '').replace(/[-_]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : img.name
}

/**
 * The facility's floors, lowest first: every floor-plan image that is
 * visible or has shapes on it (a plan image can be hidden while its
 * floor's shapes are still in use — the floor stays, its picture doesn't).
 */
export function floorsOf(input: FacilityRoutingInput): Floor[] {
  const used = new Set<number>()
  const lists: ReadonlyArray<ReadonlyArray<{ floorPlanId?: number | null }>> = [
    input.polygons, input.lines, input.doors, input.stairs, input.grids as ReadonlyArray<{ floorPlanId?: number | null }>,
    input.markers ?? [],
  ]
  for (const list of lists) for (const s of list) if (s.floorPlanId != null) used.add(s.floorPlanId)
  return input.images
    .filter((img): img is ImageShape & { id: number } => img.id !== undefined && (img.visible !== false || used.has(img.id)))
    .map((img) => ({ id: img.id, name: floorName(img), elevation: Number(img.config.elevation ?? 0) }))
    .sort((a, b) => a.elevation - b.elevation || a.name.localeCompare(b.name))
}

// ---- floor scenes (cached per input)

const sceneCache = new WeakMap<FacilityRoutingInput, Map<number | null, RoutingScene>>()

function onFloor<T extends { floorPlanId?: number | null; visible?: boolean }>(
  items: ReadonlyArray<T>,
  floorId: number | null,
  lowestId: number | null,
): T[] {
  return items.filter(
    (s) => s.visible !== false && (s.floorPlanId === floorId || (s.floorPlanId == null && floorId === lowestId)),
  )
}

/** One floor's walls, doors and obstacles (cached per input + floor). Also
 *  read by the heatmap (`data-link/heat-spread.ts`), so heat and routes
 *  agree on what is solid. */
export function routingScene(input: FacilityRoutingInput, floorId: number | null): RoutingScene {
  let byFloor = sceneCache.get(input)
  if (!byFloor) sceneCache.set(input, (byFloor = new Map()))
  const hit = byFloor.get(floorId)
  if (hit) return hit
  const floors = floorsOf(input)
  const lowestId = floors[0]?.id ?? null
  const z = floors.find((f) => f.id === floorId)?.elevation ?? 0
  const base = buildRoutingScene({
    walls: onFloor(input.lines, floorId, lowestId),
    doors: onFloor(input.doors, floorId, lowestId),
    polygons: solidPolygons(onFloor(input.polygons, floorId, lowestId), z),
    polygonRolesAsObstacles: SOLID,
    grids: onFloor(input.grids as ReadonlyArray<Grid & { floorPlanId?: number | null }>, floorId, lowestId),
  })
  const scene: RoutingScene = {
    ...base,
    obstacles: [
      ...(base.obstacles ?? []),
      ...circleObstacles(onFloor(input.circles ?? [], floorId, lowestId), z),
      ...modelObstacles(onFloor(input.models ?? [], floorId, lowestId), input.modelBounds ?? {}, z),
      ...stairObstacles(
        floors.length
          ? input.stairs.filter((s) => s.visible !== false && stairFloor(s, floors, lowestId)?.id === floorId)
          : onFloor(input.stairs, floorId, lowestId),
        (s) => !!climbsToNextFloor(s, floors, lowestId),
      ),
    ],
  }
  byFloor.set(floorId, scene)
  return scene
}

// ---- portals

export interface Portal {
  id: number
  kind: PortalKind
  name: string
  /** Floor id → where to stand on that floor (a landing, a lift door). */
  at: Map<number, LngLat>
  /** Escalators run one way: from → to (floor ids). */
  oneWay?: { from: number; to: number }
  /** Stairs: the walk up the steps (one piece per tread, landing between
   *  flights), so a route climbs the stair instead of jumping floors. */
  climb?: StairWalkRun[]
}

function centroid(vs: ReadonlyArray<LngLat>): LngLat {
  const n = vs.length || 1
  return [vs.reduce((a, v) => a + v[0], 0) / n, vs.reduce((a, v) => a + v[1], 0) / n]
}

const metres = (a: LngLat, b: LngLat) => {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
  return Math.hypot((a[0] - b[0]) * 111_320 * k, (a[1] - b[1]) * 110_540)
}

/** The floor at height `z` (within 1.2 m), if any. */
function floorAt(floors: Floor[], z: number): Floor | undefined {
  let best: Floor | undefined
  for (const f of floors) {
    if (Math.abs(f.elevation - z) <= 1.2 && (!best || Math.abs(f.elevation - z) < Math.abs(best.elevation - z))) best = f
  }
  return best
}

/**
 * How the facility's floors connect. Drawings rarely link floors
 * explicitly, so the links are read from the geometry the map draws:
 *   - escalator: its two landings from `liftIconFeatures` (with heights) →
 *     the floors at those heights; one way, by `direction`;
 *   - lift: every lift drawn within 3 m of another on a different floor is
 *     the same shaft; a lift that lists stops / served floors adds those;
 *   - staircase: bottom of the flight on its floor, top of the flight on
 *     the next floor up — when it really climbs (≥ half the floor height).
 */
export function portalsOf(input: FacilityRoutingInput): Portal[] {
  const floors = floorsOf(input)
  const byId = new Map(floors.map((f) => [f.id, f]))
  const elevations = new Map(floors.map((f) => [f.id, f.elevation]))
  const lowestId = floors[0]?.id
  const out: Portal[] = []
  const lifts: Array<{ shape: StairShape; floorId: number; at: LngLat; stops: Map<number, LngLat> }> = []

  for (const s of input.stairs) {
    if (!s.id || s.visible === false || s.vertices.length < 2) continue
    const cfg = s.config
    if (cfg.status === 'out-of-service') continue
    const floorId = s.floorPlanId ?? lowestId
    if (floorId === undefined || !byId.has(floorId)) continue
    const name = s.name?.trim() || ''

    if (cfg.stairType === 'escalator') {
      const ends = liftIconFeatures(s, elevations)
      const at = new Map<number, LngLat>()
      for (const e of ends) {
        const f = floorAt(floors, e.properties.z)
        if (f && !at.has(f.id)) at.set(f.id, e.geometry.coordinates as LngLat)
      }
      if (at.size < 2) {
        // No icons resolved: bottom at the shape's floor, top `rise` higher.
        const base = byId.get(floorId)!
        const top = floorAt(floors, base.elevation + Number((cfg as { rise?: number }).rise ?? 0))
        if (!top || top.id === base.id) continue
        at.set(base.id, s.vertices[0])
        at.set(top.id, s.vertices[s.vertices.length - 1])
      }
      const [lo, hi] = [...at.keys()].sort((a, b) => elevations.get(a)! - elevations.get(b)!)
      const down = (cfg as { direction?: string }).direction === 'down'
      out.push({ id: s.id, kind: 'escalator', name, at, oneWay: down ? { from: hi, to: lo } : { from: lo, to: hi } })
      continue
    }

    if (cfg.stairType === 'elevator') {
      const stops = new Map<number, LngLat>()
      for (const e of liftIconFeatures(s, elevations)) {
        const f = floorAt(floors, e.properties.z)
        if (f && !stops.has(f.id)) stops.set(f.id, e.geometry.coordinates as LngLat)
      }
      for (const id of cfg.servedFloorPlanIds ?? []) if (byId.has(id) && !stops.has(id)) stops.set(id, centroid(s.vertices))
      if (!stops.size) stops.set(floorId, centroid(s.vertices))
      lifts.push({ shape: s, floorId, at: centroid(s.vertices), stops })
      continue
    }

    const above = climbsToNextFloor(s, floors, lowestId)
    const here = stairFloor(s, floors, lowestId)
    if (!above || !here) continue
    // Foot of the first flight below, top of the last flight above (a U
    // stair arrives beside where it starts, one flight width over).
    const climb = stairWalkRuns(s)
    const foot = climb[0]?.coordinates[0] ?? s.vertices[0]
    const lastRun = climb[climb.length - 1]
    const top =
      lastRun?.coordinates[lastRun.coordinates.length - 1] ??
      (cfg.stairType === 'u' ? s.vertices[0] : s.vertices[s.vertices.length - 1])
    out.push({ id: s.id, kind: 'stairs', name, at: new Map([[here.id, foot], [above.id, top]]), climb })
  }

  // Lifts: shapes on different floors standing within 3 m are one shaft.
  const used = new Set<number>()
  for (let i = 0; i < lifts.length; i++) {
    if (used.has(i)) continue
    used.add(i)
    const shaft = [lifts[i]]
    for (let j = i + 1; j < lifts.length; j++) {
      if (used.has(j)) continue
      if (shaft.some((l) => l.floorId !== lifts[j].floorId && metres(l.at, lifts[j].at) <= 3)) {
        used.add(j)
        shaft.push(lifts[j])
      }
    }
    const at = new Map<number, LngLat>()
    for (const l of shaft) for (const [f, c] of l.stops) if (!at.has(f)) at.set(f, c)
    if (at.size < 2) continue
    const named = shaft.find((l) => l.shape.name?.trim())
    out.push({ id: shaft[0].shape.id!, kind: 'lift', name: named?.shape.name?.trim() ?? '', at })
  }
  return out
}

/**
 * The floor a staircase starts on: the floor at its base height
 * (`baseElevation`), else its `floorPlanId`. By height first — a stair
 * drawn while another floor was the default carries that floor's id.
 */
function stairFloor(s: StairShape, floors: Floor[], lowestId: number | null | undefined): Floor | undefined {
  const base = s.config.baseElevation
  const byHeight = typeof base === 'number' && Number.isFinite(base) ? floorAt(floors, base) : undefined
  return byHeight ?? floors.find((f) => f.id === (s.floorPlanId ?? lowestId))
}

/** The floor a staircase climbs to: the next one up, when it rises ≥ half the floor height. */
function climbsToNextFloor(s: StairShape, floors: Floor[], lowestId: number | null | undefined): Floor | undefined {
  const here = stairFloor(s, floors, lowestId)
  if (!here) return undefined
  const above = floors.find((f) => f.elevation > here.elevation + 0.5)
  if (!above) return undefined
  const cfg = s.config
  const flights = cfg.stairType === 'u' || cfg.stairType === 'l' ? 2 : 1
  const rise = Number(cfg.stepCount ?? 0) * Number(cfg.riserHeight ?? 0) * flights
  return rise >= (above.elevation - here.elevation) * 0.5 ? above : undefined
}

/** Whether `p` may be taken from floor `a` to floor `b`. */
function usable(p: Portal, a: number, b: number): boolean {
  return p.at.has(a) && p.at.has(b) && (!p.oneWay || (p.oneWay.from === a && p.oneWay.to === b))
}

// ---- legs

type LegResult = { ok: true; leg: Leg } | { ok: false; status: 'start-blocked' | 'end-blocked' | 'unreachable' }

function walk(input: FacilityRoutingInput, floorId: number | null, from: LngLat, to: LngLat, extraObstacles: Polygon[] = []): LegResult {
  const base = routingScene(input, floorId)
  const scene = extraObstacles.length
    ? { ...base, obstacles: [...(base.obstacles ?? []), ...extraObstacles.map((p) => ({ vertices: p.coordinates[0].slice(0, -1) as LngLat[] }))] }
    : base
  // A place inside a solid object (a counter, a display) is reached at its edge.
  let r = computeRoute(scene, { start: from, end: to }, { snapRadiusMeters: SNAP_METERS, returnGrid: true })
  const grid = r.grid
  if (r.status !== 'ok' && r.status !== 'empty-scene' && grid) {
    // Its nearest edge can face a closed pocket (the well of a staircase,
    // the staff side of a counter): go as close as the walker can get —
    // to the goal, or else from the start.
    const near = closestReachable(grid, from, to)
    if (near) r = computeRoute(scene, { start: from, end: near }, { snapRadiusMeters: SNAP_METERS })
    const back = r.status === 'ok' ? null : closestReachable(grid, to, from)
    if (back) r = computeRoute(scene, { start: back, end: to }, { snapRadiusMeters: SNAP_METERS })
  }
  if (r.status === 'ok' || r.status === 'empty-scene') return { ok: true, leg: { floorId, waypoints: r.waypoints, meters: r.distanceMeters } }
  return { ok: false, status: r.status }
}

/** Accepted distance from the goal to the closest point the walker can reach. */
const CLOSE_ENOUGH_METERS = 6

/** The walkable cell joined to `from` that lies nearest `to`, if it is close enough. */
function closestReachable(grid: CompiledGrid, from: LngLat, to: LngLat): LngLat | null {
  const [sx, sy] = llToCell(grid, from)
  const start = snapToWalkable(grid, sx, sy, Math.ceil(SNAP_METERS / grid.cellSize))
  if (!start) return null
  const [ex, ey] = llToCell(grid, to)
  const { width, height } = grid
  const seen = new Uint8Array(width * height)
  const queue = [start[1] * width + start[0]]
  seen[queue[0]] = 1
  let best = queue[0]
  let bestD = Infinity
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]
    const x = c % width
    const y = (c - x) / width
    const d = (x - ex) ** 2 + (y - ey) ** 2
    if (d < bestD) [best, bestD] = [c, d]
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const n = ny * width + nx
        if (!seen[n] && !isBlocked(grid, nx, ny)) {
          seen[n] = 1
          queue.push(n)
        }
      }
    }
  }
  if (Math.sqrt(bestD) * grid.cellSize > CLOSE_ENOUGH_METERS) return null
  const bx = best % width
  return cellToLl(grid, bx, (best - bx) / width)
}

// ---- planning

function option(id: RouteOption['id'], legs: Leg[], transitions: Transition[]): RouteOption {
  const meters = legs.reduce((a, l) => a + l.meters, 0)
  const seconds = meters / WALK_MPS + transitions.reduce((a, t) => a + CHANGE_SECONDS[t.portal.kind], 0)
  return { id, legs, transitions, meters, seconds }
}

/** Share of `a`'s length lying within 1.5 m of `b`. */
function overlap(a: LngLat[], b: LngLat[]): number {
  if (a.length < 2 || b.length < 2) return 1
  const la = lineString(a)
  const lb = lineString(b)
  const total = turfLength(la, { units: 'meters' })
  if (total < 1) return 1
  let near = 0
  let n = 0
  for (let d = 0; d <= total; d += 1) {
    const p = along(la, d, { units: 'meters' })
    const q = nearestPointOnLine(lb, p, { units: 'meters' })
    if ((q.properties.dist ?? Infinity) <= 1.5) near++
    n++
  }
  return near / n
}

/** One floor: the fastest route, and a different one if there is one. */
function sameFloor(input: FacilityRoutingInput, from: Endpoint, to: Endpoint): PlanResult {
  const first = walk(input, from.floorId, from.coord, to.coord)
  if (!first.ok) return { status: first.status }
  const options = [option('fastest', [first.leg], [])]
  const line = lineString(first.leg.waypoints)
  const total = turfLength(line, { units: 'meters' })
  if (total > 12) {
    for (const f of [0.5, 0.35, 0.65]) {
      const mid = along(line, total * f, { units: 'meters' })
      const block = buffer(mid, 1.6, { units: 'meters', steps: 6 })
      if (!block) continue
      const alt = walk(input, from.floorId, from.coord, to.coord, [block.geometry as Polygon])
      if (!alt.ok || alt.leg.meters > first.leg.meters * 1.5) continue
      if (overlap(alt.leg.waypoints, first.leg.waypoints) >= 0.6) continue
      options.push(option('alternative', [alt.leg], []))
      break
    }
  }
  return { status: 'ok', options }
}

/** Floors reachable from `f` through one portal. */
function nextFloors(portals: Portal[], f: number): Set<number> {
  const next = new Set<number>()
  for (const p of portals) if (p.at.has(f)) for (const g of p.at.keys()) if (g !== f && usable(p, f, g)) next.add(g)
  return next
}

/** Fewest floor changes from `a` to `b`, or Infinity. */
function minHops(portals: Portal[], a: number, b: number): number {
  const dist = new Map([[a, 0]])
  const queue = [a]
  for (let i = 0; i < queue.length; i++) {
    const f = queue[i]
    if (f === b) return dist.get(f)!
    for (const g of nextFloors(portals, f)) {
      if (dist.has(g)) continue
      dist.set(g, dist.get(f)! + 1)
      queue.push(g)
    }
  }
  return Infinity
}

/**
 * Floor sequences from `a` to `b` (each step through one portal), with at
 * most one change more than the fewest possible (and at least 3) — a
 * stairs-only tower still connects its top floor, while a lift serving
 * every floor doesn't multiply the paths.
 */
function floorPaths(portals: Portal[], a: number, b: number): number[][] {
  const fewest = minHops(portals, a, b)
  if (!Number.isFinite(fewest)) return []
  const maxHops = Math.max(3, fewest + 1)
  const out: number[][] = []
  const stack: number[][] = [[a]]
  while (stack.length) {
    const path = stack.pop()!
    const last = path[path.length - 1]
    if (last === b) {
      out.push(path)
      continue
    }
    if (path.length > maxHops) continue
    for (const f of nextFloors(portals, last)) if (!path.includes(f)) stack.push([...path, f])
  }
  return out
}

function crossFloors(input: FacilityRoutingInput, from: Endpoint, to: Endpoint): PlanResult {
  const floors = new Map(floorsOf(input).map((f) => [f.id, f]))
  const portals = portalsOf(input)
  const paths = floorPaths(portals, from.floorId!, to.floorId!)
  if (!paths.length) return { status: 'no-connection' }

  // Walking legs are memoised: the same floor, from and to come up for
  // several portal choices.
  const memo = new Map<string, LegResult>()
  const leg = (floorId: number, a: LngLat, b: LngLat) => {
    const k = `${floorId}:${a.join(',')}:${b.join(',')}`
    let r = memo.get(k)
    if (!r) memo.set(k, (r = walk(input, floorId, a, b)))
    return r
  }

  const candidates: RouteOption[] = []
  let firstFailure: 'start-blocked' | 'end-blocked' | 'unreachable' | null = null
  for (const path of paths) {
    // Every combination of one portal per floor change (bounded).
    let combos: Portal[][] = [[]]
    for (let i = 0; i < path.length - 1; i++) {
      const choices = portals.filter((p) => usable(p, path[i], path[i + 1]))
      combos = combos.flatMap((c) => choices.map((p) => [...c, p])).slice(0, 40)
    }
    for (const combo of combos) {
      const legs: Leg[] = []
      const transitions: Transition[] = []
      let cursor = from.coord
      let failed = false
      for (let i = 0; i < path.length; i++) {
        const floorId = path[i]
        const target = i === path.length - 1 ? to.coord : combo[i].at.get(floorId)!
        const r = leg(floorId, cursor, target)
        if (!r.ok) {
          firstFailure ??=
            i === 0
              ? r.status === 'end-blocked' ? 'unreachable' : r.status
              : i === path.length - 1
                ? r.status === 'start-blocked' ? 'unreachable' : r.status
                : 'unreachable'
          failed = true
          break
        }
        legs.push(r.leg)
        if (i < path.length - 1) {
          transitions.push({ portal: combo[i], fromFloor: floors.get(floorId)!, toFloor: floors.get(path[i + 1])! })
          cursor = combo[i].at.get(path[i + 1])!
        }
      }
      if (!failed) candidates.push(option('fastest', legs, transitions))
    }
  }
  if (!candidates.length) return { status: firstFailure ?? 'unreachable' }

  candidates.sort((a, b) => a.seconds - b.seconds)
  const fastest = candidates[0]
  const options: RouteOption[] = [fastest]
  const key = (o: RouteOption) => o.transitions.map((t) => t.portal.id).join('>')
  const stepFree = candidates.find((o) => o.transitions.every((t) => t.portal.kind === 'lift'))
  if (stepFree && key(stepFree) !== key(fastest)) options.push({ ...stepFree, id: 'stepFree' })
  const alternative = candidates.find((o) => !options.some((x) => key(x) === key(o)) && o.seconds <= fastest.seconds * 1.5)
  if (alternative) options.push({ ...alternative, id: 'alternative' })
  return { status: 'ok', options }
}

export function planRoutes(input: FacilityRoutingInput, from: Endpoint, to: Endpoint): PlanResult {
  if (from.floorId === to.floorId) return sameFloor(input, from, to)
  if (from.floorId == null || to.floorId == null) return sameFloor(input, from, to)
  return crossFloors(input, from, to)
}

/** Whether the option is step-free (no stairs or escalators). */
export function isStepFree(o: RouteOption): boolean {
  return o.transitions.every((t) => t.portal.kind === 'lift')
}

// ---- steps

export type Step =
  | { kind: 'walk'; floorId: number | null; instruction: Instruction }
  | { kind: 'change'; transition: Transition; up: boolean }

export function stepsOf(o: RouteOption): Step[] {
  const steps: Step[] = []
  o.legs.forEach((l, i) => {
    const ins = generateInstructions(l.waypoints)
    // Between legs: the leg's "arrive" is the portal, said by the change step.
    const keep = i < o.legs.length - 1 ? ins.filter((x) => x.kind !== 'arrive') : ins
    // After a floor change, "start" repeats the change; keep it only first.
    for (const x of i > 0 ? keep.filter((y) => y.kind !== 'start') : keep) steps.push({ kind: 'walk', floorId: l.floorId, instruction: x })
    const t = o.transitions[i]
    if (t) steps.push({ kind: 'change', transition: t, up: t.toFloor.elevation > t.fromFloor.elevation })
  })
  return steps
}
