/**
 * What a walker can't pass through on one floor, beyond the walls and rack
 * cells `buildRoutingScene` already blocks: raised furniture and fixtures
 * (polygons with a height), round columns and planters (circles), 3D
 * models (their bounding box on the floor) and the footprint of stairs that
 * climb to the next floor, escalators and lifts.
 *
 * Left walkable on purpose: anything whose underside is above head height
 * (canopies, mezzanine slabs), spaces (rooms, offices, areas, zones, floor
 * areas, roofs, any polygon over 200 m²), walk-through security scanners,
 * and short stairs that link two levels of the same floor.
 *
 * Shared with the mobile app (its `nav/` used these first).
 */

import { area as turfArea, convex, featureCollection, polygon as turfPolygon } from '@turf/turf'

import { buildCirclePolygonRing } from '@/lib/circle-generators'
import type { CircleShape, ModelShape, PolygonShape, StairShape } from '@/lib/shapes'
import { stairToFeatureCollection } from '@/lib/stair-generators'
import type { LngLat, RoutingObstacle } from './types'

/** Lower than this is stepped over (kerbs, lane separators, floor markings). */
const MIN_HEIGHT = 0.2
/** An underside this high is walked under. */
const HEADROOM = 2.0
const MAX_OBJECT_AREA = 200
/** Areas you walk into, whatever their drawn height: the built-in space roles
 *  (a room drawn as a 1 m block is still a room — its walls and doors bound
 *  it) plus slabs, walk-through scanners and stairs. Areas with no role or
 *  another role (counters, displays) block. */
const WALKABLE_ROLES = new Set([
  'floor-area', 'area', 'zone', 'room', 'office', 'surface', 'place',
  'roof', 'security', 'corridor', 'stair',
])

/** Marks the polygons `buildRoutingScene` should block. */
export const SOLID_ROLE = '__solid'

type Height = { height?: number; elevation?: number }

/**
 * `elevation` is absolute (metres above the ground floor), as the renderer
 * reads it, so the headroom test takes off the floor's own `base`.
 */
function solid(cfg: Height | undefined, base: number): boolean {
  const above = Math.max(0, Number(cfg?.elevation ?? 0) - base)
  return Number(cfg?.height ?? 0) >= MIN_HEIGHT && above < HEADROOM
}

/**
 * The raised polygons, re-tagged with `SOLID_ROLE` so the shared scene
 * adapter blocks them with its own rotation handling.
 */
export function solidPolygons(polygons: PolygonShape[], base: number): PolygonShape[] {
  return polygons
    .filter((p) => p.vertices.length >= 3 && solid(p.config as Height, base) && !WALKABLE_ROLES.has(p.role ?? ''))
    .filter((p) => turfArea(turfPolygon([[...p.vertices, p.vertices[0]]])) <= MAX_OBJECT_AREA)
    .map((p) => ({ ...p, role: SOLID_ROLE }))
}

export function circleObstacles(circles: CircleShape[], base: number): RoutingObstacle[] {
  return circles
    .filter((c) => c.mode === 'single' && c.center && c.radius && solid(c.config as Height, base))
    .map((c) => ({ vertices: buildCirclePolygonRing(c.center!, c.radius!, 24).slice(0, -1) as LngLat[] }))
}

type Bounds = { min: [number, number, number]; max: [number, number, number] }

/**
 * A model's bounding box on the floor. Mapbox lays a glTF model with +X
 * east, +Z south and +Y up, scales it, then turns it clockwise by
 * `rotation[2]` about its anchor (mapbox-gl `rotationScaleYZFlipMatrix`).
 */
export function modelObstacles(
  models: ModelShape[],
  bounds: ReadonlyMap<string, unknown> | Record<string, unknown>,
  base: number,
): RoutingObstacle[] {
  const out: RoutingObstacle[] = []
  const boundsOf = (id: string) => (bounds instanceof Map ? bounds.get(id) : (bounds as Record<string, unknown>)[id])
  for (const m of models) {
    const b = boundsOf(m.config.modelAssetId ?? '') as Bounds | null | undefined
    if (!b?.min || !b?.max) continue
    const [sx, sy, sz] = m.config.scale ?? [1, 1, 1]
    if ((b.max[1] - b.min[1]) * sz < MIN_HEIGHT) continue
    if (Number((m.config as { elevation?: number }).elevation ?? 0) - base >= HEADROOM) continue
    const t = (m.config.rotation?.[2] ?? 0) * (Math.PI / 180)
    const [lng, lat] = m.position
    const kx = 111_320 * Math.cos((lat * Math.PI) / 180)
    const corners: Array<[number, number]> = [
      [b.min[0], b.min[2]],
      [b.max[0], b.min[2]],
      [b.max[0], b.max[2]],
      [b.min[0], b.max[2]],
    ]
    out.push({
      vertices: corners.map(([x, z]) => {
        const e = x * sx
        const s = z * sy
        const e2 = e * Math.cos(t) - s * Math.sin(t)
        const s2 = e * Math.sin(t) + s * Math.cos(t)
        return [lng + e2 / kx, lat - s2 / 110_540] as LngLat
      }),
    })
  }
  return out
}

/**
 * The steps of stairs that join floors and of escalators: a route walks to
 * the foot of the flight, not over it. `climbs` tells whether a staircase
 * reaches the next floor (the same rule that makes it a portal). Escalator
 * landings stay walkable; lifts are left out, as their shafts sit behind
 * drawn walls and the generator's lift box spills into the lobby.
 */
export function stairObstacles(stairs: StairShape[], climbs: (s: StairShape) => boolean): RoutingObstacle[] {
  const out: RoutingObstacle[] = []
  for (const s of stairs) {
    const type = s.config.stairType
    if (type === 'elevator' || (type !== 'escalator' && !climbs(s))) continue
    // One outline round every step: the well between a U stair's flights
    // goes with it, so no closed pocket is left in the middle.
    const steps = stairToFeatureCollection(s).features.filter((f) => (f.properties as { part?: string }).part !== 'landing')
    const hull = steps.length ? convex(featureCollection(steps)) : null
    const ring = hull?.geometry.coordinates[0] as LngLat[] | undefined
    if (ring && ring.length >= 4) out.push({ vertices: ring.slice(0, -1) })
  }
  return out
}
