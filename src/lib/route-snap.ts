/**
 * Route-drawing snap resolver.
 *
 * Called on every `mousemove` of the route-placement tool to decide
 * whether the cursor should snap to a vertex of an existing route (so
 * users can build a shared junction for pathfinding). Unlike
 * `resolveLineSnap`, this deliberately DOES NOT do axis-alignment —
 * routes are curvy paths through space and users found the axis lock
 * fighting their intent. Only endpoint / waypoint snap is offered.
 *
 * Priority (first non-none result wins):
 *   1. Close-loop — cursor within threshold of the CURRENT chain's own
 *      first vertex. Snapping there commits a closed route.
 *   2. Vertex snap — cursor within threshold of ANY vertex of ANY visible
 *      saved route. Every vertex counts (endpoints AND interior waypoints)
 *      so users can build T-junctions and cross-intersections, not just
 *      end-to-end chains. That coincident coordinate later becomes a
 *      shared node in the A* / Dijkstra graph the pathfinding solver
 *      will construct.
 *   3. No snap.
 *
 * Kept separate from `line-snap.ts` because routes and walls have
 * intentionally different snap semantics (walls want axis + endpoint,
 * routes want vertex-only).
 */

import type { Map as MapboxMapInstance } from 'mapbox-gl'
import type { RouteShape } from './shapes'

export type RouteSnapKind =
  | 'none'
  | 'endpoint'    // Snapped to another route's endpoint (start or end vertex).
  | 'waypoint'   // Snapped to another route's interior vertex.
  | 'close-loop' // Snapped to this chain's own first vertex.

export interface RouteSnap {
  kind: RouteSnapKind
  /** Snapped `[lng, lat]`. Equals cursor when `kind === 'none'`. */
  position: [number, number]
  /** The vertex we're snapping to. Populated for every non-none kind so
   *  the overlay can draw the "you'll land here" green ring. */
  targetVertex?: [number, number]
  /** ID of the route that owns the target vertex. Undefined for the
   *  close-loop case (the target vertex belongs to the in-progress chain
   *  that hasn't been saved yet). Later used by the pathfinding graph
   *  builder to record cross-route edges without a coord equality scan. */
  targetRouteId?: number
  /** Index of the target vertex within `targetRouteId`'s vertex array. */
  targetVertexIndex?: number
  /** Diagnostic — distance in pixels from raw cursor to the snapped
   *  vertex (0 after snap). Only populated for non-none kinds. */
  metricBefore?: number
}

export interface RouteSnapContext {
  map: MapboxMapInstance
  /**
   * Cursor position in world coords. Callers ray-cast the click against
   * the tool's elevation plane via `unprojectAtAltitude` before calling
   * — same convention as `resolveLineSnap`.
   */
  cursor: [number, number]
  /** Vertices committed in the current draw so far. */
  chainVertices: ReadonlyArray<[number, number]>
  /** Every already-saved route (scoped by the caller — usually the
   *  active-warehouse view). Used as vertex sources. */
  savedRoutes: ReadonlyArray<RouteShape>
  /** Endpoint / waypoint snap tolerance in screen pixels. Constant across
   *  zoom levels because `map.project` handles the conversion. */
  endpointPixelThreshold?: number
}

const DEFAULT_ENDPOINT_PX = 18

function pixelDistance(
  map: MapboxMapInstance,
  a: [number, number],
  b: [number, number],
): number {
  const pa = map.project(a as [number, number])
  const pb = map.project(b as [number, number])
  const dx = pa.x - pb.x
  const dy = pa.y - pb.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Compute the snap decision for a mouse-move / click tick.
 *
 * Complexity: O(N) in the total vertex count across all visible routes.
 * A warehouse with 50 routes at 5 vertices each is 250 candidates — the
 * per-tick cost stays well under a millisecond because `pixelDistance`
 * is a single `map.project` round-trip per candidate.
 */
export function resolveRouteSnap(ctx: RouteSnapContext): RouteSnap {
  const threshold = ctx.endpointPixelThreshold ?? DEFAULT_ENDPOINT_PX

  // Track the CLOSEST candidate so far. This ensures that when the
  // cursor is within snap-range of two different vertices (e.g. a
  // T-junction where three route ends meet), we snap to whichever one
  // is actually nearest to the cursor pixel.
  let best: {
    kind: RouteSnapKind
    vertex: [number, number]
    distPx: number
    routeId?: number
    vertexIdx?: number
  } | null = null

  // (1) Close-loop — chain's own first vertex. Only offered once the
  // chain has at least 2 committed vertices; before that there's no
  // "loop" to close and the check would falsely snap the second click
  // back onto the first.
  if (ctx.chainVertices.length >= 2) {
    const first = ctx.chainVertices[0]
    const d = pixelDistance(ctx.map, ctx.cursor, first)
    if (d <= threshold) {
      best = { kind: 'close-loop', vertex: first, distPx: d }
    }
  }

  // (2) Every vertex of every visible saved route. Skip hidden routes
  // so a toggled-off route doesn't lure the cursor. The chain's own
  // vertices (other than the first, handled above) are NOT included —
  // snapping the cursor back onto the just-placed dot would be a
  // frustrating jitter, not a feature.
  for (const r of ctx.savedRoutes) {
    if (r.visible === false) continue
    if (r.id === undefined) continue
    const vs = r.vertices
    if (vs.length < 2) continue
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i]
      const d = pixelDistance(ctx.map, ctx.cursor, v)
      if (d > threshold) continue
      if (best && d >= best.distPx) continue
      const isEndpoint = i === 0 || i === vs.length - 1
      best = {
        kind: isEndpoint ? 'endpoint' : 'waypoint',
        vertex: v,
        distPx: d,
        routeId: r.id,
        vertexIdx: i,
      }
    }
  }

  if (best) {
    return {
      kind: best.kind,
      position: best.vertex,
      targetVertex: best.vertex,
      targetRouteId: best.routeId,
      targetVertexIndex: best.vertexIdx,
      metricBefore: best.distPx,
    }
  }
  return { kind: 'none', position: ctx.cursor }
}
