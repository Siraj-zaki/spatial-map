/**
 * Line-drawing snap resolver
 *
 * Called on every `mousemove` of the line-placement tool to decide
 * whether the cursor should snap to a nearby endpoint or a
 * floor-plan-relative cardinal axis. Snap decisions are pure — they
 * take a raw lng/lat + context and return where the vertex WOULD land
 * plus a `kind` tag the overlay uses to swap chain colour + surface a
 * "connected" / "H↔" / "V↕" indicator.
 *
 * Priority (first non-none result wins):
 *
 *   1. Endpoint snap — within `endpointPixelThreshold` screen pixels
 *      of any endpoint of any existing line, the CURRENT chain's first
 *      vertex (to close a loop), or the CURRENT chain's last committed
 *      vertex (rare — but useful for stopping cleanly). Uses screen-
 *      pixel math so the tolerance stays constant at any zoom.
 *   2. Axis snap — from the last committed vertex, if the cursor's
 *      bearing relative to the floor plan's rotation is within
 *      `axisDegreeThreshold` of 0/90/180/270, snap the cursor to
 *      exactly that axis (preserving distance from the last vertex).
 *      The reference frame is the FLOOR PLAN'S local axes so a wall
 *      drawn on a plan rotated 30° north-of-east is snapped to that
 *      plan's own horizontal / vertical — not to true-north.
 *   3. No snap.
 *
 * Callers pass in a `map` for pixel math AND for `turf`-style bearing /
 * destination helpers. All coordinates in/out are `[lng, lat]`.
 */

import { bearing as turfBearing, destination as turfDestination } from '@turf/turf'
import type { Map as MapboxMapInstance } from 'mapbox-gl'

import type { LineShape } from './shapes'

export type LineSnapKind =
  | 'none'
  | 'endpoint'          // cursor snapped to another line's or own chain's endpoint
  | 'axis-horizontal'   // 0° / 180° in floor-plan frame
  | 'axis-vertical'     // 90° / 270° in floor-plan frame

export interface LineSnap {
  kind: LineSnapKind
  /** Snapped `[lng, lat]` — always populated (equals cursor when kind==='none'). */
  position: [number, number]
  /** For endpoint snap, the vertex snapped to. */
  targetVertex?: [number, number]
  /**
   * For axis snap, the "guide" ray we snapped onto — a second point along
   * the axis, used by the overlay to draw the perfect-axis reference line.
   * (start = last committed vertex, end = this guide point.)
   */
  axisGuideEnd?: [number, number]
  /**
   * Diagnostic — kind='endpoint' → distance in pixels from raw cursor to
   * the endpoint (0 after snap); kind='axis-*' → angular deviation from
   * the perfect axis in degrees (0 after snap).
   */
  metricBefore?: number
}

export interface LineSnapContext {
  map: MapboxMapInstance
  /**
   * Cursor position in world coords. This is what the user is pointing
   * at — the caller has already ray-cast against the tool's elevation
   * plane via `unprojectAtAltitude`.
   */
  cursor: [number, number]
  /** Vertices committed in the current draw so far. */
  chainVertices: ReadonlyArray<[number, number]>
  /** Every already-committed line (from the store). Used as endpoint sources. */
  savedLines: ReadonlyArray<LineShape>
  /**
   * Rotation of the active floor plan, in degrees measured east-of-north
   * (Mapbox `bearing` convention: 0 = north-up). Snap axes are rotated
   * by this amount so walls drawn on a plan tilted 30° pick up snapping
   * that matches the plan's own orthogonal grid, NOT the map compass.
   * Default 0 = true-north-aligned (equivalent to disabling axis snap
   * on a floor plan with rotation 0).
   */
  floorPlanRotationDeg?: number
  /**
   * Endpoint snap tolerance in screen pixels. Constant across zoom
   * levels because `map.project` handles the conversion.
   */
  endpointPixelThreshold?: number
  /** Axis snap tolerance in degrees. */
  axisDegreeThreshold?: number
}

const DEFAULT_ENDPOINT_PX = 14
const DEFAULT_AXIS_DEG = 3

/**
 * Enumerate every candidate snap endpoint: (a) endpoints of every saved
 * line, (b) FIRST vertex of the current chain (close-a-loop shortcut),
 * (c) LAST vertex of the current chain (rarely useful but consistent —
 * lets the user land the cursor exactly on the last-placed dot for
 * cleaner backspace behaviour). The chain's intermediate vertices are
 * NOT included on purpose: snapping to a middle vertex mid-draw is
 * usually a jitter surprise, not a feature.
 */
function collectEndpointCandidates(
  chainVertices: ReadonlyArray<[number, number]>,
  savedLines: ReadonlyArray<LineShape>,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  if (chainVertices.length > 0) out.push(chainVertices[0])
  if (chainVertices.length > 1) out.push(chainVertices[chainVertices.length - 1])
  for (const ln of savedLines) {
    if (ln.visible === false) continue
    const vs = ln.vertices
    if (vs.length < 2) continue
    out.push(vs[0])
    out.push(vs[vs.length - 1])
  }
  return out
}

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
 * Distance between two lng/lat in meters via haversine. Turf ships a
 * `distance` helper we already import elsewhere, but hard-coding this
 * saves a per-tick import cycle in the hot mousemove path.
 */
function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/**
 * Normalise a bearing to [0, 360). Handy for the axis-modulo math below.
 */
function norm360(deg: number): number {
  let d = deg % 360
  if (d < 0) d += 360
  return d
}

/**
 * Smallest absolute angular difference between two bearings, in degrees
 * (always in [0, 180]).
 */
function angleDelta(a: number, b: number): number {
  const d = Math.abs(norm360(a) - norm360(b))
  return d > 180 ? 360 - d : d
}

/**
 * Compute the snap decision for a mouse-move tick.
 *
 * Complexity: O(N) in the number of candidate endpoints (endpoints of
 * saved lines + chain terminals). N is small in practice — a warehouse
 * with 200 walls has 400 candidates — so the per-tick cost is well
 * under a millisecond. The pixel-distance helper does the only heavy
 * work (an inverse-mercator round-trip) which Mapbox implements in
 * constant time.
 */
export function resolveLineSnap(ctx: LineSnapContext): LineSnap {
  const pxThreshold = ctx.endpointPixelThreshold ?? DEFAULT_ENDPOINT_PX
  const axisThreshold = ctx.axisDegreeThreshold ?? DEFAULT_AXIS_DEG

  // ---- 1. Endpoint snap ------------------------------------------
  const candidates = collectEndpointCandidates(ctx.chainVertices, ctx.savedLines)
  let best: { vertex: [number, number]; distPx: number } | null = null
  for (const v of candidates) {
    // Skip the point we're already sitting on — floating-point equality
    // is fine here because both come from the same integer pixel path.
    const distPx = pixelDistance(ctx.map, ctx.cursor, v)
    if (distPx > pxThreshold) continue
    if (!best || distPx < best.distPx) best = { vertex: v, distPx }
  }
  if (best) {
    return {
      kind: 'endpoint',
      position: best.vertex,
      targetVertex: best.vertex,
      metricBefore: best.distPx,
    }
  }

  // ---- 2. Axis snap ---------------------------------------------
  // Needs a last committed vertex to draw the axis FROM. Without one
  // (empty chain) there's nothing to align to.
  const lastVertex =
    ctx.chainVertices.length > 0
      ? ctx.chainVertices[ctx.chainVertices.length - 1]
      : null
  if (lastVertex) {
    // Bearing from last vertex to cursor. Turf's bearing is measured
    // east-of-north in degrees, matching Mapbox's `getBearing()`
    // convention exactly.
    const cursorBearing = turfBearing(lastVertex, ctx.cursor)
    // The floor plan's own east-of-north rotation. When the user's
    // plan is oriented "30° clockwise from true north", their
    // horizontal axis is at bearing = 90 + 30 = 120°.
    const planRot = ctx.floorPlanRotationDeg ?? 0
    const cardinals = [
      { deg: planRot,             kind: 'axis-vertical'   as const, label: 'N' },
      { deg: planRot + 90,        kind: 'axis-horizontal' as const, label: 'E' },
      { deg: planRot + 180,       kind: 'axis-vertical'   as const, label: 'S' },
      { deg: planRot + 270,       kind: 'axis-horizontal' as const, label: 'W' },
    ]
    let closest: (typeof cardinals)[number] | null = null
    let closestDelta = Infinity
    for (const c of cardinals) {
      const d = angleDelta(cursorBearing, c.deg)
      if (d < closestDelta) {
        closestDelta = d
        closest = c
      }
    }
    if (closest && closestDelta <= axisThreshold) {
      // Preserve distance from `lastVertex` to the cursor, but rotate
      // the direction onto the perfect cardinal axis via turf. Turf's
      // `destination` takes (start, distance, bearing, {units}).
      const distanceKm = haversineMeters(lastVertex, ctx.cursor) / 1000
      const snapped = turfDestination(lastVertex, distanceKm, closest.deg, {
        units: 'kilometers',
      }).geometry.coordinates as [number, number]
      // Extend the axis a further 5× the drawn distance for the guide
      // line the overlay renders. Long guides make it visually obvious
      // the wall is on-axis; short ones look like just another segment.
      const guide = turfDestination(lastVertex, distanceKm * 5 + 0.001, closest.deg, {
        units: 'kilometers',
      }).geometry.coordinates as [number, number]
      return {
        kind: closest.kind,
        position: snapped,
        axisGuideEnd: guide,
        metricBefore: closestDelta,
      }
    }
  }

  // ---- 3. No snap ----------------------------------------------
  return {
    kind: 'none',
    position: ctx.cursor,
  }
}

/**
 * Total length in meters of a vertex list. Used for the "total wall
 * length" line of the drawing HUD. Symmetric with the polygon /
 * distance helpers elsewhere in the codebase; kept here so callers
 * that only import `line-snap` don't drag in the polygon module.
 */
export function chainLengthMeters(vertices: ReadonlyArray<[number, number]>): number {
  if (vertices.length < 2) return 0
  let total = 0
  for (let i = 1; i < vertices.length; i++) {
    total += haversineMeters(vertices[i - 1], vertices[i])
  }
  return total
}

/**
 * Length of the "in-flight" segment: last committed vertex → cursor.
 * Returns 0 when the chain is empty (no segment yet).
 */
export function inFlightSegmentMeters(
  vertices: ReadonlyArray<[number, number]>,
  cursor: [number, number] | null,
): number {
  if (!cursor || vertices.length === 0) return 0
  return haversineMeters(vertices[vertices.length - 1], cursor)
}
