/**
 * Indoor wayfinding — public types.
 *
 * The routing module is intentionally self-contained: it consumes plain
 * geometry (lng/lat vertex lists) and returns a plain path. It never
 * imports from the spatial store, the api-db facade, or the door /
 * line stores. That keeps it testable in isolation, and means any
 * caller (editor, presenter, future server-side worker) can drive it
 * with whatever data source they already have.
 *
 * The scene model mirrors the shapes the editor already produces:
 *   - `walls`   — polyline barriers (LineShapes). Every segment is an
 *                 obstacle to walk-through. Thickness comes from the
 *                 wall's own config so a chunky architectural wall
 *                 casts a chunky obstacle.
 *   - `doors`   — thin pass-through slits carved out of the walls. A
 *                 door's two vertices define the mouth; the router
 *                 clears wall occupancy inside the mouth so the path
 *                 can pass through.
 *   - `obstacles` — filled polygons that block movement (rack blocks,
 *                 equipment). Same as walls but for closed regions.
 *   - `bounds`  — the container polygon of the walkable indoor space
 *                 (usually the outer facility wall). Optional; when
 *                 present, cells outside are marked non-walkable so
 *                 routes don't cut across the exterior.
 *
 * Everything is in **WGS84 lng/lat** at the module boundary. Internally
 * the router projects to a local metric plane (see `projection.ts`) so
 * distances / grid math are Euclidean and correct at building scale.
 */

/** WGS84 [longitude, latitude] pair. */
export type LngLat = [number, number]

/** A polyline barrier — walls, aisle dividers, fencing. */
export interface RoutingWall {
  /** Ordered [lng, lat] vertices. Minimum 2. */
  vertices: LngLat[]
  /** Perpendicular thickness in METERS. Defaults to 0.3 when omitted. */
  thicknessMeters?: number
}

/**
 * A pass-through opening in a wall. The door's mouth is the segment
 * `[vertices[0], vertices[1]]`; both jambs must lie on (or very close
 * to) a wall. During grid build every cell inside the door mouth (plus
 * a small margin so a person can actually walk through) is force-set
 * to walkable, even if a wall previously occupied it.
 */
export interface RoutingDoor {
  /** Exactly two [lng, lat] jambs. */
  vertices: [LngLat, LngLat]
  /**
   * Optional over-clear along the mouth axis in METERS. Widens the
   * opening slightly beyond the raw mouth so the path can slip through
   * without brushing the jamb cells. Defaults to `agentRadiusMeters`
   * from the request when omitted.
   */
  overClearMeters?: number
}

/** A filled polygon that blocks movement (rack, kiosk, equipment). */
export interface RoutingObstacle {
  /** Closed ring of [lng, lat] vertices. Do NOT repeat the first vertex. */
  vertices: LngLat[]
}

/** The walkable container polygon (usually the outer facility wall). */
export interface RoutingBounds {
  vertices: LngLat[]
}

/**
 * Full scene input. All arrays default to empty when the field is
 * absent, so a caller can build the scene incrementally.
 */
export interface RoutingScene {
  walls?: RoutingWall[]
  doors?: RoutingDoor[]
  obstacles?: RoutingObstacle[]
  bounds?: RoutingBounds
}

/** One-shot pathfinding request. */
export interface RouteRequest {
  start: LngLat
  end: LngLat
  /**
   * Half-width of the agent in METERS. Walls + obstacles are dilated
   * by this amount so the returned path never comes closer than
   * `agentRadiusMeters` to a barrier. Default 0.3 m (person-sized).
   */
  agentRadiusMeters?: number
  /**
   * Grid resolution in METERS per cell. Smaller = smoother paths but
   * O(1/n²) more memory. Default 0.25 m — fine enough to route
   * through a 0.9 m door with room to spare.
   */
  cellSizeMeters?: number
  /**
   * Padding around the scene bbox in METERS when the caller doesn't
   * supply explicit `bounds`. Guarantees start/end near the edge
   * still fit inside the grid. Default 2 m.
   */
  paddingMeters?: number
  /**
   * The building's main wall direction in maths degrees (0 = east,
   * counter-clockwise). The routing grid is laid out along it so routes
   * run parallel to the walls. Omitted → found from the walls / doors /
   * racks in the scene; floors whose walls agree on no direction stay
   * north-up.
   */
  axisDeg?: number
}

/**
 * The outcome of `computeRoute`. `status` discriminates the success
 * and failure cases so callers can render meaningful UX:
 *   - `ok`             — path found; `waypoints` is a lng/lat polyline.
 *   - `unreachable`    — start and end are on the grid but no path
 *                        connects them (blocked by walls or outside
 *                        bounds).
 *   - `start-blocked`  — the start point falls inside an obstacle /
 *                        wall dilation; couldn't snap to a walkable
 *                        cell within a reasonable radius.
 *   - `end-blocked`    — same for the end point.
 *   - `empty-scene`    — nothing to route in; returns a straight line.
 */
export type RouteStatus =
  | 'ok'
  | 'unreachable'
  | 'start-blocked'
  | 'end-blocked'
  | 'empty-scene'

export interface RouteResult {
  status: RouteStatus
  /**
   * Ordered [lng, lat] waypoints. Always contains the start + end
   * even on failure so the caller can still render a "best effort"
   * straight line if it wants (with an error badge).
   */
  waypoints: LngLat[]
  /** Total path length in METERS along the returned polyline. */
  distanceMeters: number
  /**
   * Cells expanded by A*. Useful for perf triage and dev overlays;
   * safe to ignore in production UI.
   */
  cellsExpanded?: number
}
