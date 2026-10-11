/**
 * Door → wall snap resolver.
 *
 * Runs on every `mousemove` of the door-placement tool. Finds the
 * nearest wall (`LineShape` with a wall extrusion — either `height > 0`
 * or `elevation > 0`) within a pixel tolerance, projects the cursor
 * onto that wall's nearest segment, and reports back the snapped
 * midpoint + the segment's heading + the wall's own thickness.
 *
 * The overlay uses the result to:
 *   1. Show a "ghost" door preview aligned to the wall (so the user sees
 *      exactly where and how the door will land BEFORE clicking).
 *   2. Auto-orient the door to the wall on commit — no manual rotate
 *      after placement.
 *   3. Stamp `config.attachedToLineId` on the persisted row so the wall
 *      generator can cut a real hole where the door lands.
 *
 * Snap tolerance is expressed in SCREEN PIXELS so it stays consistent
 * across zoom (a 14 px threshold gives the same "click feels magnetic"
 * feedback whether the wall is 1 or 100 map-meters wide on screen).
 */

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import type { LineShape } from '@/lib/shapes'

export interface DoorWallSnap {
  /** id of the wall the cursor snapped to. */
  wallId: number
  /**
   * The point on the wall's polyline closest to the cursor, in lng/lat.
   * This becomes the door's centre (midpoint of v0/v1).
   */
  snappedCenter: [number, number]
  /**
   * Heading of the wall segment at the snap point, in degrees measured
   * east-of-north (Mapbox `getBearing()` convention). This is what the
   * door's v0→v1 axis is rotated to match.
   */
  wallAxisDeg: number
  /**
   * Wall thickness in METERS from the wall's config. Used by the door
   * generator to choose an opening width that matches the wall
   * (default 0.9 m otherwise). Also used by the wall-cut helper to
   * decide how deep the hole must go perpendicular to the wall.
   */
  wallThickness: number
  /**
   * 0..1 fractional position along the wall's polyline where the snap
   * landed. Persisted on the door so a "slide door along wall" future
   * UX can use it as a starting position.
   */
  positionOnLine: number
  /**
   * Diagnostic — distance in screen pixels from the raw cursor to the
   * nearest point on the wall.
   */
  distancePx: number
}

export interface DoorWallSnapContext {
  map: MapboxMapInstance
  cursor: [number, number]
  savedLines: ReadonlyArray<LineShape>
  /** Pixel tolerance for hit detection. Default 14 px. */
  pixelThreshold?: number
}

const DEFAULT_PIXEL_THRESHOLD = 14
const DEFAULT_WALL_THICKNESS = 0.3

/** Squared 2D screen distance from cursor to a lng/lat. */
function pixelDistanceSq(
  map: MapboxMapInstance,
  cursor: [number, number],
  point: [number, number],
): number {
  const c = map.project(cursor as [number, number])
  const p = map.project(point as [number, number])
  const dx = c.x - p.x
  const dy = c.y - p.y
  return dx * dx + dy * dy
}

/**
 * Project point `p` onto segment `[a, b]` in SCREEN space. Returns the
 * nearest point ON the segment (clamped to endpoints if the projection
 * falls off the ends), the parameter `t` in [0, 1] along the segment,
 * and the squared pixel distance. Screen space is used so the pixel
 * tolerance stays stable across zoom.
 */
function projectPointToSegmentPx(
  map: MapboxMapInstance,
  p: [number, number],
  a: [number, number],
  b: [number, number],
): {
  nearestLngLat: [number, number]
  t: number
  distancePxSq: number
} {
  const pp = map.project(p as [number, number])
  const pa = map.project(a as [number, number])
  const pb = map.project(b as [number, number])
  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) {
    // Degenerate segment — both endpoints coincide.
    return {
      nearestLngLat: a,
      t: 0,
      distancePxSq: pixelDistanceSq(map, p, a),
    }
  }
  const raw = ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / lenSq
  const t = Math.max(0, Math.min(1, raw))
  const nx = pa.x + dx * t
  const ny = pa.y + dy * t
  const ex = pp.x - nx
  const ey = pp.y - ny
  const distSq = ex * ex + ey * ey
  // Convert back to lng/lat via unproject so the caller can consume it
  // in the same coord space it queries other geometry with. Mapbox's
  // `unproject` signature wants a PointLike; `[x, y]` works as an alias.
  const nearest = map.unproject([nx, ny])
  return {
    nearestLngLat: [nearest.lng, nearest.lat],
    t,
    distancePxSq: distSq,
  }
}

/**
 * Bearing of a segment `[a, b]` measured east-of-north (0 = due north,
 * 90 = due east), matching Mapbox's `getBearing()` convention. Uses a
 * flat-earth approximation which is exact at warehouse scale — walls
 * are at most a few hundred meters long.
 */
function segmentBearingDeg(
  a: [number, number],
  b: [number, number],
): number {
  const midLat = (a[1] + b[1]) / 2
  const dx = (b[0] - a[0]) * Math.cos((midLat * Math.PI) / 180)
  const dy = b[1] - a[1]
  // atan2 gives math-convention east-of-x; convert to east-of-north by
  // measuring from the +y axis instead of +x, i.e. atan2(dx, dy).
  const rad = Math.atan2(dx, dy)
  return (rad * 180) / Math.PI
}

/**
 * Straight-line distance in meters between two lng/lat via the flat-earth
 * (equirectangular) approximation — good to sub-mm at warehouse scale
 * and orders of magnitude faster than haversine. Used to compute a
 * wall segment's meter length for the `positionOnLine` fraction.
 */
const METERS_PER_DEG_LAT = 111_320
function segmentMeters(a: [number, number], b: [number, number]): number {
  const midLat = (a[1] + b[1]) / 2
  const dx = (b[0] - a[0]) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
  const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Full snap resolution — iterates every visible wall's every segment and
 * returns the closest snap under the pixel threshold. Only lines with
 * `height > 0` OR `elevation > 0` are considered walls (flat aisles
 * shouldn't magnetise doors — they aren't structural).
 *
 * Complexity: O(N × M) where N = walls and M = average segments per
 * wall. Typical warehouse: 100 walls × 2 segments = 200 iterations
 * per mousemove. Well within a millisecond even before Turf's overhead.
 */
export function resolveDoorWallSnap(
  ctx: DoorWallSnapContext,
): DoorWallSnap | null {
  const pxThreshold = ctx.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD
  const pxThresholdSq = pxThreshold * pxThreshold

  let best: {
    wallId: number
    nearest: [number, number]
    axisDeg: number
    thickness: number
    positionOnLine: number
    distancePxSq: number
  } | null = null

  for (const wall of ctx.savedLines) {
    if (wall.visible === false) continue
    if (wall.id === undefined) continue
    // Skip flat lines (aisles) — only walls magnetise doors.
    const isWall = (wall.config.height ?? 0) > 0 || (wall.config.elevation ?? 0) > 0
    if (!isWall) continue
    const verts = wall.vertices
    if (verts.length < 2) continue

    // Compute total wall length once for the position fraction.
    let totalMeters = 0
    const segmentMetersCache: number[] = []
    for (let i = 1; i < verts.length; i++) {
      const m = segmentMeters(verts[i - 1], verts[i])
      segmentMetersCache.push(m)
      totalMeters += m
    }
    if (totalMeters < 1e-6) continue

    let cumulative = 0
    for (let i = 1; i < verts.length; i++) {
      const a = verts[i - 1]
      const b = verts[i]
      const proj = projectPointToSegmentPx(ctx.map, ctx.cursor, a, b)
      if (proj.distancePxSq > pxThresholdSq) {
        cumulative += segmentMetersCache[i - 1]
        continue
      }
      if (best && proj.distancePxSq >= best.distancePxSq) {
        cumulative += segmentMetersCache[i - 1]
        continue
      }
      const positionMeters = cumulative + segmentMetersCache[i - 1] * proj.t
      best = {
        wallId: wall.id,
        nearest: proj.nearestLngLat,
        axisDeg: segmentBearingDeg(a, b),
        thickness: Math.max(0.05, wall.config.wallThickness ?? DEFAULT_WALL_THICKNESS),
        positionOnLine: positionMeters / totalMeters,
        distancePxSq: proj.distancePxSq,
      }
      cumulative += segmentMetersCache[i - 1]
    }
  }

  if (!best) return null
  return {
    wallId: best.wallId,
    snappedCenter: best.nearest,
    wallAxisDeg: best.axisDeg,
    wallThickness: best.thickness,
    positionOnLine: best.positionOnLine,
    distancePx: Math.sqrt(best.distancePxSq),
  }
}

/**
 * Given a wall snap, produce the two door anchors [v0, v1] that would
 * commit an `openingWidthMeters`-wide door centred on the snap point,
 * aligned to the wall's axis. Called from the placement effect right
 * before persisting the door.
 *
 * The math: from the snap centre, walk `openingWidth/2` in each
 * direction along the wall's bearing to get v0 and v1. Flat-earth math
 * is exact at warehouse scale; if we later ship this for continental
 * layouts we can swap to `@turf/destination`.
 */
export function doorAnchorsFromWallSnap(
  snap: DoorWallSnap,
  openingWidthMeters: number,
): [[number, number], [number, number]] {
  const half = Math.max(0.05, openingWidthMeters) / 2
  const bearingRad = (snap.wallAxisDeg * Math.PI) / 180
  // East-of-north bearing → decompose into +east (lng) and +north (lat).
  // sin(bearing) = eastward component; cos(bearing) = northward.
  const dxMeters = Math.sin(bearingRad) * half
  const dyMeters = Math.cos(bearingRad) * half
  const midLat = snap.snappedCenter[1]
  const cosLat = Math.cos((midLat * Math.PI) / 180)
  const dLng = dxMeters / (METERS_PER_DEG_LAT * cosLat)
  const dLat = dyMeters / METERS_PER_DEG_LAT
  return [
    [snap.snappedCenter[0] - dLng, snap.snappedCenter[1] - dLat],
    [snap.snappedCenter[0] + dLng, snap.snappedCenter[1] + dLat],
  ]
}

/**
 * Preview anchors WITHOUT a wall — for the "empty hover" case where
 * the user is drawing in free space. Renders a door of
 * `openingWidthMeters` width centred on the cursor, oriented east-west
 * so the ghost has a stable heading before the user picks an axis.
 */
export function doorAnchorsAroundCursor(
  cursor: [number, number],
  openingWidthMeters: number,
): [[number, number], [number, number]] {
  const half = Math.max(0.05, openingWidthMeters) / 2
  const cosLat = Math.cos((cursor[1] * Math.PI) / 180)
  const dLng = half / (METERS_PER_DEG_LAT * cosLat)
  return [
    [cursor[0] - dLng, cursor[1]],
    [cursor[0] + dLng, cursor[1]],
  ]
}
