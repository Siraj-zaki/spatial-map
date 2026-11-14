/**
 * Router facade — the one function callers actually import.
 *
 *   const result = computeRoute(scene, { start, end })
 *
 * Orchestrates the whole pipeline:
 *
 *   1. Compile the scene into an occupancy grid + Euclidean distance
 *      transform (the DT is what feeds the centre-bias in A* and the
 *      corridor-centring post-pass).
 *
 *   2. Snap start / end to the nearest walkable cell within the
 *      configured snap radius. If either fails, return a discriminated
 *      status so the UI can render a "start blocked" / "end blocked"
 *      badge instead of pretending it found a route.
 *
 *   3. Run A* (4-connected, Manhattan heuristic, small turn penalty,
 *      centre bias when a DT is present).
 *
 *   4. Post-process (`orthogonal.ts`): right-angle runs along the
 *      building's axis, through door centres, down corridor middles,
 *      with small zig-zags merged → convert back to lng/lat. The grid is
 *      compiled in the building's frame (projection.ts), so "along the
 *      walls" is horizontal / vertical on the grid.
 *
 * The whole thing is a pure function of `(scene, request)`. No React,
 * no map instance, no store — so the same function runs identically
 * in the editor tool, in a headless test, or (later) in a WebWorker.
 */

import { findPath, snapToWalkable, type AStarOptions } from './astar.ts'
import {
  cellToLl as cellCentreLngLat,
  compileScene,
  llToCell,
  type CompiledGrid,
} from './occupancy-grid.ts'
import { orthogonalPath, type OrthogonalOptions } from './orthogonal.ts'
import {
  cellsToLngLatFractional,
  centreOnCorridor,
  collapseCollinear,
  polylineLengthMeters,
  simplifyByLineOfSight,
  simplifyByLineOfSightFractional,
} from './postprocess.ts'
import { toLocal } from './projection.ts'
import type { RouteRequest, RouteResult, RoutingScene } from './types.ts'

/** Default cell size — fine enough for a 0.9 m door, coarse enough to be quick. */
const DEFAULT_CELL_SIZE_M = 0.25
/** Default agent radius — approx a person carrying a box. */
const DEFAULT_AGENT_RADIUS_M = 0.3
/** Default bbox padding around the scene. */
const DEFAULT_PADDING_M = 2

export interface ComputeRouteOptions extends AStarOptions, OrthogonalOptions {
  /** Return the compiled grid alongside the result for debug overlays. */
  returnGrid?: boolean
  /**
   * `orthogonal` (default): runs parallel to the walls, right-angle turns,
   * through door centres and corridor middles. `any-angle`: the older
   * string-pulled shortest line (diagonals across open space).
   */
  pathStyle?: 'orthogonal' | 'any-angle'
}

/**
 * Extended result that optionally exposes the compiled grid for
 * debug tooling. Most callers can just destructure `RouteResult`
 * fields and ignore `grid`.
 */
export interface RouteResultDebug extends RouteResult {
  grid?: CompiledGrid
}

export function computeRoute(
  scene: RoutingScene,
  request: RouteRequest,
  opts: ComputeRouteOptions = {},
): RouteResultDebug {
  const start = request.start
  const end = request.end
  const agentRadiusMeters = request.agentRadiusMeters ?? DEFAULT_AGENT_RADIUS_M
  const cellSizeMeters = request.cellSizeMeters ?? DEFAULT_CELL_SIZE_M
  const paddingMeters = request.paddingMeters ?? DEFAULT_PADDING_M

  const hasAnyGeometry =
    (scene.walls?.length ?? 0) > 0 ||
    (scene.doors?.length ?? 0) > 0 ||
    (scene.obstacles?.length ?? 0) > 0 ||
    (scene.bounds?.vertices.length ?? 0) > 0

  if (!hasAnyGeometry) {
    // Nothing to route around — the "best" route is a straight line.
    // Emit that so the UI still shows a visible result on empty scenes.
    const distanceMeters = polylineLengthMeters([start, end])
    return { status: 'empty-scene', waypoints: [start, end], distanceMeters }
  }

  const grid = compileScene(scene, {
    agentRadiusMeters,
    cellSizeMeters,
    paddingMeters,
    start,
    end,
    withDistanceTransform: true,
    axisDeg: request.axisDeg,
  })

  const snapRadiusMeters = opts.snapRadiusMeters ?? 3
  const snapRadiusCells = Math.max(1, Math.ceil(snapRadiusMeters / cellSizeMeters))

  const [sx, sy] = llToCell(grid, start)
  const startBlocked = grid.occ[sy * grid.width + sx] === 1
  const startSnap = snapToWalkable(grid, sx, sy, snapRadiusCells)
  if (!startSnap) {
    return {
      status: 'start-blocked',
      waypoints: [start, end],
      distanceMeters: polylineLengthMeters([start, end]),
      grid: opts.returnGrid ? grid : undefined,
    }
  }

  const [ex, ey] = llToCell(grid, end)
  const endBlocked = grid.occ[ey * grid.width + ex] === 1
  const endSnap = snapToWalkable(grid, ex, ey, snapRadiusCells)
  if (!endSnap) {
    return {
      status: 'end-blocked',
      waypoints: [start, end],
      distanceMeters: polylineLengthMeters([start, end]),
      grid: opts.returnGrid ? grid : undefined,
    }
  }

  const astar = findPath(grid, startSnap, endSnap, opts)
  if (!astar.found) {
    return {
      status: 'unreachable',
      waypoints: [start, end],
      distanceMeters: polylineLengthMeters([start, end]),
      cellsExpanded: astar.cellsExpanded,
      grid: opts.returnGrid ? grid : undefined,
    }
  }

  // Post-process the raw A* cell chain in four passes:
  //   1. Collapse collinear runs — cheap, deterministic dedupe of
  //      the ~N step-by-step cells A* emitted.
  //   2. String-pull with line-of-sight — collapse the resulting
  //      corner list into the minimum any-angle polyline that stays
  //      inside walkable cells. This handles the "staircase" look
  //      you get whenever an aisle isn't axis-aligned (34°-rotated
  //      racks in this warehouse being the obvious case).
  //   3. Centre each interior waypoint on the corridor midline (the
  //      ridge of the distance transform). This is what puts the path
  //      in the MIDDLE of the aisle instead of hugging one wall — the
  //      MazeMap / Situm "professional wayfinding" look.
  //   4. Re-simplify: centring can make some waypoints collinear or
  //      redundant, so run string-pulling one more time to keep the
  //      polyline minimal + turns sharp.
  let finalCells: [number, number][]
  if (opts.pathStyle === 'any-angle') {
    const collapsed = collapseCollinear(astar.cells)
    const strung = simplifyByLineOfSight(grid, collapsed)
    const centred = centreOnCorridor(grid, strung, 12)
    finalCells = simplifyByLineOfSightFractional(grid, centred)
  } else {
    // The exact click (fractional cells) unless it sat in an obstacle.
    const frac = (ll: [number, number], blocked: boolean, snap: [number, number]): [number, number] => {
      if (blocked) return [snap[0] + 0.5, snap[1] + 0.5]
      const [x, y] = toLocal(grid.frame, ll)
      return [(x - grid.originX) / grid.cellSize, (y - grid.originY) / grid.cellSize]
    }
    finalCells = orthogonalPath(
      grid,
      astar.cells,
      frac(start, startBlocked, startSnap),
      frac(end, endBlocked, endSnap),
      opts,
    )
  }
  // Endpoint replacement in `cellsToLngLat` normally snaps the first
  // and last emitted waypoints to the user's exact click. That's the
  // right thing UNLESS the click landed INSIDE an obstacle — in that
  // case the segment [clicked → first walkable cell] cuts through the
  // obstacle. Pass the snapped cell centres in those cases so the
  // rendered path stays on walkable ground.
  const startLL: [number, number] = startBlocked
    ? cellCentreLngLat(grid, startSnap[0], startSnap[1])
    : start
  const endLL: [number, number] = endBlocked
    ? cellCentreLngLat(grid, endSnap[0], endSnap[1])
    : end
  const waypoints = cellsToLngLatFractional(grid, finalCells, startLL, endLL)

  return {
    status: 'ok',
    waypoints,
    distanceMeters: polylineLengthMeters(waypoints),
    cellsExpanded: astar.cellsExpanded,
    grid: opts.returnGrid ? grid : undefined,
  }
}
