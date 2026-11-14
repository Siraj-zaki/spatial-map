/**
 * Planar measurement helpers for the drafting tools.
 *
 * Everything works in a local east/north metre frame centred on a
 * reference point (equirectangular, same Earth radius turf uses). At
 * building scale the error against great-circle maths is far below a
 * millimetre, and unlike turf the projection round-trips exactly — which
 * the angle lock and typed lengths need: a vertex placed "3.5 m along
 * 90°" must read back as exactly 3.5 m and 90°.
 */

const EARTH_RADIUS_M = 6371008.8
const DEG = Math.PI / 180

export type LngLat = [number, number]

/** `p` in metres east / north of `origin`. */
export function toLocal(origin: LngLat, p: LngLat): [number, number] {
  const k = EARTH_RADIUS_M * DEG
  return [(p[0] - origin[0]) * k * Math.cos(origin[1] * DEG), (p[1] - origin[1]) * k]
}

export function fromLocal(origin: LngLat, xy: [number, number]): LngLat {
  const k = EARTH_RADIUS_M * DEG
  return [origin[0] + xy[0] / (k * Math.cos(origin[1] * DEG)), origin[1] + xy[1] / k]
}

export function distanceM(a: LngLat, b: LngLat): number {
  const [x, y] = toLocal(a, b)
  return Math.hypot(x, y)
}

export function pathLengthM(vertices: ReadonlyArray<LngLat>, closed = false): number {
  let total = 0
  for (let i = 1; i < vertices.length; i++) total += distanceM(vertices[i - 1], vertices[i])
  if (closed && vertices.length > 2) total += distanceM(vertices[vertices.length - 1], vertices[0])
  return total
}

/** Shoelace area in m² (absolute). */
export function polygonAreaM2(vertices: ReadonlyArray<LngLat>): number {
  if (vertices.length < 3) return 0
  const origin = vertices[0]
  let sum = 0
  let prev = toLocal(origin, vertices[vertices.length - 1])
  for (const v of vertices) {
    const cur = toLocal(origin, v)
    sum += prev[0] * cur[1] - cur[0] * prev[1]
    prev = cur
  }
  return Math.abs(sum) / 2
}

/** Area-weighted centroid (falls back to the vertex mean when degenerate). */
export function polygonCentroid(vertices: ReadonlyArray<LngLat>): LngLat {
  const origin = vertices[0]
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < vertices.length; i++) {
    const p = toLocal(origin, vertices[i])
    const q = toLocal(origin, vertices[(i + 1) % vertices.length])
    const cross = p[0] * q[1] - q[0] * p[1]
    a += cross
    cx += (p[0] + q[0]) * cross
    cy += (p[1] + q[1]) * cross
  }
  if (Math.abs(a) < 1e-9) {
    const n = vertices.length
    return [
      vertices.reduce((s, v) => s + v[0], 0) / n,
      vertices.reduce((s, v) => s + v[1], 0) / n,
    ]
  }
  return fromLocal(origin, [cx / (3 * a), cy / (3 * a)])
}

export function midpoint(a: LngLat, b: LngLat): LngLat {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

/** Direction a→b in degrees counter-clockwise from east, in [0, 360). */
export function angleDeg(a: LngLat, b: LngLat): number {
  const [x, y] = toLocal(a, b)
  const deg = Math.atan2(y, x) / DEG
  return (deg + 360) % 360
}

/** The point `meters` from `origin` heading `deg` (CCW from east). */
export function pointAt(origin: LngLat, deg: number, meters: number): LngLat {
  return fromLocal(origin, [Math.cos(deg * DEG) * meters, Math.sin(deg * DEG) * meters])
}

/**
 * Plan-relative "east" for the angle lock. Image rotation is clockwise
 * (turf convention); the lock works counter-clockwise, hence the sign.
 */
export function planBaseAngle(floorPlanRotationDeg: number): number {
  return -floorPlanRotationDeg
}

/**
 * Snap `cursor` onto the nearest ray from `anchor` whose angle is a
 * multiple of `stepDeg` measured from `baseDeg`. The distance along the
 * ray is the cursor's projection onto it, so the length still follows
 * the mouse.
 */
export function constrainAngle(
  anchor: LngLat,
  cursor: LngLat,
  stepDeg: number,
  baseDeg: number,
): LngLat {
  const [x, y] = toLocal(anchor, cursor)
  const len = Math.hypot(x, y)
  if (len < 1e-9) return cursor
  const raw = Math.atan2(y, x) / DEG
  const snapped = baseDeg + Math.round((raw - baseDeg) / stepDeg) * stepDeg
  const along = x * Math.cos(snapped * DEG) + y * Math.sin(snapped * DEG)
  return pointAt(anchor, snapped, Math.max(0, along))
}

/**
 * Where the next vertex lands when the user types a length: `meters`
 * from the last vertex toward the cursor (angle-locked when asked). With
 * no usable cursor direction it continues the previous segment, or heads
 * along the plan's east axis for the first segment.
 */
export function typedLengthTarget(opts: {
  vertices: ReadonlyArray<LngLat>
  cursor: LngLat | null
  meters: number
  lock: { stepDeg: number; baseDeg: number } | null
}): LngLat | null {
  const { vertices, cursor, meters, lock } = opts
  const anchor = vertices[vertices.length - 1]
  if (!anchor) return null
  let deg: number | null = null
  if (cursor && distanceM(anchor, cursor) > 1e-6) {
    const aim = lock ? constrainAngle(anchor, cursor, lock.stepDeg, lock.baseDeg) : cursor
    if (distanceM(anchor, aim) > 1e-6) deg = angleDeg(anchor, aim)
    else if (lock) deg = lock.baseDeg
  }
  if (deg === null && vertices.length >= 2) deg = angleDeg(vertices[vertices.length - 2], anchor)
  if (deg === null) deg = lock?.baseDeg ?? 0
  return pointAt(anchor, deg, meters)
}

/**
 * Live drafting settings the vertex tools read at event time (through a
 * ref, so their map handlers don't rebind on every toggle).
 */
export interface DrawAssist {
  angleLock: boolean
  angleStep: number
  /** Plan-relative east, from `planBaseAngle`. */
  baseDeg: number
}

/** The lock in force for this event: the setting, flipped while Shift is held. */
export function activeLock(assist: DrawAssist, shiftKey: boolean): { stepDeg: number; baseDeg: number } | null {
  return assist.angleLock !== shiftKey ? { stepDeg: assist.angleStep, baseDeg: assist.baseDeg } : null
}

/** The raw cursor, or its angle-locked position off the last vertex. */
export function assistedPoint(
  assist: DrawAssist,
  shiftKey: boolean,
  vertices: ReadonlyArray<LngLat>,
  raw: LngLat,
): LngLat {
  const lock = activeLock(assist, shiftKey)
  const anchor = vertices[vertices.length - 1]
  if (!lock || !anchor) return raw
  return constrainAngle(anchor, raw, lock.stepDeg, lock.baseDeg)
}

/** Angle between the plan's east axis and a→b, in [0, 360). */
export function planRelativeAngle(a: LngLat, b: LngLat, baseDeg: number): number {
  return (((angleDeg(a, b) - baseDeg) % 360) + 360) % 360
}
