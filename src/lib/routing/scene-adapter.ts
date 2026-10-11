/**
 * Adapters that translate the editor's shape rows into a
 * `RoutingScene`. Kept in its own file so the routing core stays
 * un-coupled from the app's data model — any other consumer (a
 * presenter view, a headless test, a future server-side worker)
 * builds the scene however it likes and hands it to `computeRoute`.
 *
 * Rules of thumb:
 *   - **Every LineShape is a wall.** In this editor the line tool is
 *     documented as "aisles / walls" — both are barriers for
 *     wayfinding. If we later add a "walkable path" line kind, that
 *     one gets excluded here.
 *   - **Every DoorShape is a portal.** Doors carry their opening as
 *     the two-vertex `mouth`; the router punches walkable space out
 *     of the walls at that mouth.
 *   - **PolygonShapes are neither walls nor obstacles by default.**
 *     Polygons in this editor mostly represent rooms / zones which
 *     are walkable regions, not obstacles. If a specific role wants
 *     to block movement, mark it via `polygonRolesAsObstacles`.
 *   - **The outer facility polygon (if any) is passed as `bounds`.**
 *     Callers can flag it explicitly.
 */

import { polygon as turfPolygon, transformRotate } from '@turf/turf'

import type { DoorShape } from '@/lib/door/types'
import type { Grid } from '@/lib/db'
import { buildGridFromLine } from '@/lib/grid-generators'
import type { LineShape, PolygonShape } from '@/lib/shapes'
import type { LngLat, RoutingScene } from './types'

/**
 * Rotate a lng/lat vertex list around its centroid by `degrees`
 * (compass, clockwise, same as turf.transformRotate). Uses turf so
 * the math is done in metric space via rhumb bearing/destination —
 * the naive "rotate in raw lng/lat" version (rotatePointAroundPivot
 * from grid-generators) is only correct at the equator; at any real
 * latitude it distorts the shape because 1° lng ≠ 1° lat in metres.
 * That's the bug that caused route lines to visually clip racks even
 * though the rack CENTRES were correctly marked blocked.
 */
function rotateRingAroundCentroid(
  vertices: ReadonlyArray<LngLat>,
  degrees: number,
): LngLat[] {
  if (!degrees || Math.abs(degrees) < 1e-6) return vertices.slice() as LngLat[]
  let cx = 0
  let cy = 0
  for (const [x, y] of vertices) {
    cx += x
    cy += y
  }
  cx /= vertices.length
  cy /= vertices.length
  return rotateRingAroundPivot(vertices, degrees, [cx, cy])
}

function rotateRingAroundPivot(
  vertices: ReadonlyArray<LngLat>,
  degrees: number,
  pivot: LngLat,
): LngLat[] {
  if (!degrees || Math.abs(degrees) < 1e-6) return vertices.slice() as LngLat[]
  // Turf wants a closed ring for polygon(); duplicate the first vertex
  // at the end, rotate, then drop the closure.
  const closed = [...vertices, vertices[0]]
  const poly = turfPolygon([closed as [number, number][]])
  const rotated = transformRotate(poly, degrees, { pivot, mutate: false })
  const ring = rotated.geometry.coordinates[0] as LngLat[]
  return ring.slice(0, ring.length - 1)
}

/**
 * Alias — walls / doors / polygons rotate around their centroid, same
 * metric math as grid bboxes rotate around their `start` pivot.
 */
const rotateVerticesAroundCentroid = rotateRingAroundCentroid

export interface BuildSceneInput {
  walls?: ReadonlyArray<LineShape>
  doors?: ReadonlyArray<DoorShape>
  polygons?: ReadonlyArray<PolygonShape>
  /**
   * Rack / grid rows. Each grid's ROTATED bbox is emitted as an
   * obstacle polygon so the router walks around rack blocks (through
   * the aisles between them) instead of straight through them. Aisles
   * are the gaps *between* grids — the router figures that out
   * automatically once the grids are marked as obstacles.
   */
  grids?: ReadonlyArray<Grid>
  /**
   * When set, polygons whose `role` matches one of these keys are
   * treated as blocking obstacles (rack blocks, kiosks, planters).
   * Empty / omitted → polygons are ignored, so open floor space stays
   * walkable by default.
   */
  polygonRolesAsObstacles?: ReadonlySet<string>
  /**
   * When set, the polygon with this id is used as the walkable
   * bounds — every cell outside becomes non-walkable, so a route
   * can't cut across the exterior of the building.
   */
  boundsPolygonId?: number
  /**
   * When true, respect each shape's `visible` flag. Hidden walls /
   * doors / polygons / grids are then treated as if they weren't in
   * the scene at all. Default true.
   */
  respectVisibility?: boolean
}

export function buildRoutingScene(input: BuildSceneInput): RoutingScene {
  const respectVisibility = input.respectVisibility ?? true

  const walls = (input.walls ?? [])
    .filter((w) => (!respectVisibility || w.visible) && w.vertices.length >= 2)
    .map((w) => ({
      vertices: rotateVerticesAroundCentroid(w.vertices, w.rotation ?? 0),
      thicknessMeters: w.config?.wallThickness ?? 0.3,
    }))

  const doors = (input.doors ?? [])
    .filter((d) => (!respectVisibility || d.visible) && d.vertices.length === 2)
    .map((d) => {
      const rotated = rotateVerticesAroundCentroid(
        d.vertices as ReadonlyArray<LngLat>,
        d.rotation ?? 0,
      )
      return {
        vertices: [rotated[0], rotated[1]] as [LngLat, LngLat],
      }
    })

  const roles = input.polygonRolesAsObstacles
  const polygonObstacles = (input.polygons ?? [])
    .filter(
      (p) =>
        (!respectVisibility || p.visible) &&
        p.vertices.length >= 3 &&
        p.id !== input.boundsPolygonId &&
        !!roles &&
        !!p.role &&
        roles.has(p.role),
    )
    .map((p) => ({
      vertices: rotateVerticesAroundCentroid(p.vertices, p.rotation ?? 0),
    }))

  // Grid rows → rotated bbox polygons. Every grid is an obstacle.
  // We use the SAME helper the renderer uses (`rotatedBboxCorners`)
  // so the router sees the exact same footprint the user sees on the
  // map — no drift between what's drawn and what's routed around.
  //
  // Visibility filter: a grid can be hidden per-shape (`config.visible`)
  // or via the shape master flag doesn't exist on Grid — the type has
  // no top-level `visible`, only `config.visible`. Respect that.
  const gridObstacles = (input.grids ?? [])
    .filter((g) => !respectVisibility || g.config?.visible !== false)
    .flatMap((g) => {
      // Emit EACH cell of the grid as its own obstacle polygon. We
      // used to synthesise a single rotated-bbox polygon per grid,
      // but that gave the WRONG shape on any grid whose start/current
      // don't form the corners of the axis-aligned bbox (i.e. every
      // rotated grid). The app's `buildGridFromLine` runs the exact
      // same pipeline the map renderer uses — square/hex tessellation
      // inside the bbox, drop cells outside, then rotate around the
      // pivot — so the polygons it returns MATCH the rendered cells
      // pixel-for-pixel. We take just the level-0 footprint (skip
      // stacked pallet-rack levels) so we don't rasterize the same
      // footprint N times.
      try {
        const result = buildGridFromLine(g.start, g.current, g.config, {
          gridId: g.id,
        })
        const seen = new Set<string>()
        const obstacles: { vertices: LngLat[] }[] = []
        for (const cell of result.cells) {
          if ((cell.properties?.level ?? 0) !== 0) continue
          const key = `${cell.properties?.row ?? 0}:${cell.properties?.col ?? 0}`
          if (seen.has(key)) continue
          seen.add(key)
          const ring = cell.geometry.coordinates[0] as LngLat[]
          // Drop the closing vertex — our rasterizer doesn't require it.
          obstacles.push({ vertices: ring.slice(0, ring.length - 1) })
        }
        return obstacles
      } catch (err) {
        console.warn('[routing/scene-adapter] buildGridFromLine failed', g.id, err)
        return []
      }
    })

  const obstacles = [...polygonObstacles, ...gridObstacles]

  const boundsPoly = input.boundsPolygonId
    ? (input.polygons ?? []).find((p) => p.id === input.boundsPolygonId)
    : undefined
  const bounds =
    boundsPoly && boundsPoly.vertices.length >= 3
      ? {
          vertices: rotateVerticesAroundCentroid(
            boundsPoly.vertices,
            boundsPoly.rotation ?? 0,
          ),
        }
      : undefined

  return { walls, doors, obstacles, bounds }
}
