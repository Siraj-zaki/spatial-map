/**
 * Local tangent-plane projection for indoor routing math.
 *
 * Why not Web Mercator? Mercator's units-per-degree changes with
 * latitude AND diverges from ground distance the further from the
 * anchor you go. For a warehouse-scale scene (< 500 m radius) an
 * equirectangular projection *centred on the scene* is trivially
 * cheap AND accurate to sub-centimetre — the Earth's curvature at
 * that radius is a rounding error compared to a 25 cm grid cell.
 *
 * The transform:
 *   x_m = (lng - lng0) * DEG_TO_M * cos(lat0)
 *   y_m = (lat - lat0) * DEG_TO_M
 *
 * where `lat0`/`lng0` is the anchor and `DEG_TO_M = π * R_earth / 180`
 * with R_earth = 6 378 137 (WGS84 semi-major axis). Roundtrip is exact
 * to within floating-point precision, which is our invariant.
 *
 * Every routing coordinate crosses this boundary exactly twice: once
 * inbound (lng/lat → metres) when the scene is compiled, and once
 * outbound (metres → lng/lat) when the path is emitted. No downstream
 * consumer needs to know the projection exists.
 *
 * **Building axis.** The frame can be turned so its x axis runs along the
 * building's main wall direction (`axisDeg`, maths degrees: 0 = east,
 * counter-clockwise). The occupancy grid is laid out in this frame, so on
 * a building rotated 33° on the map the grid rows still run parallel to
 * its walls — 4-connected A* then produces real left / right turns
 * instead of a staircase that has to be cut into diagonals.
 * `dominantAxisDeg` finds the angle from the walls themselves.
 */

const R_EARTH_M = 6378137
const DEG_TO_M = (Math.PI * R_EARTH_M) / 180

/** Immutable anchor for a routing scene's local frame. */
export interface LocalFrame {
  /** Anchor latitude in degrees. */
  lat0: number
  /** Anchor longitude in degrees. */
  lng0: number
  /** Precomputed metres per degree of longitude at `lat0`. */
  metersPerDegLng: number
  /** Building axis in maths degrees (0 = east, counter-clockwise). */
  axisDeg: number
  /** cos / sin of `axisDeg`, precomputed. */
  cosA: number
  sinA: number
}

/**
 * Build a local frame anchored at the given lng/lat. Picks the scene
 * centroid or bbox centre in practice — anywhere inside the scene is
 * fine; the further points are from the anchor the more the tiny
 * cosine approximation error grows, but at 250 m it's <0.1 cm.
 */
export function makeLocalFrame(anchor: [number, number], axisDeg = 0): LocalFrame {
  const [lng0, lat0] = anchor
  const a = (axisDeg * Math.PI) / 180
  return {
    lat0,
    lng0,
    metersPerDegLng: DEG_TO_M * Math.cos((lat0 * Math.PI) / 180),
    axisDeg,
    cosA: Math.cos(a),
    sinA: Math.sin(a),
  }
}

/**
 * Pick an anchor from a set of lng/lat samples — the bbox centre.
 * Robust to duplicated / near-coincident points; falls back to the
 * first sample when the set has fewer than two distinct entries.
 */
export function pickAnchor(samples: ReadonlyArray<[number, number]>): [number, number] {
  if (samples.length === 0) return [0, 0]
  let minLng = Infinity
  let maxLng = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const [lng, lat] of samples) {
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2]
}

/** Convert a lng/lat point to local metres along / across the building axis
 *  (East / North when the axis is 0). */
export function toLocal(frame: LocalFrame, ll: [number, number]): [number, number] {
  const [lng, lat] = ll
  const e = (lng - frame.lng0) * frame.metersPerDegLng
  const n = (lat - frame.lat0) * DEG_TO_M
  return [e * frame.cosA + n * frame.sinA, -e * frame.sinA + n * frame.cosA]
}

/** Convert local metres back to lng/lat. */
export function fromLocal(frame: LocalFrame, xy: [number, number]): [number, number] {
  const [x, y] = xy
  const e = x * frame.cosA - y * frame.sinA
  const n = x * frame.sinA + y * frame.cosA
  return [frame.lng0 + e / frame.metersPerDegLng, frame.lat0 + n / DEG_TO_M]
}

/**
 * The building's main wall direction, in maths degrees within [-45, 45),
 * from segments in lng/lat. Orthogonal buildings have walls at θ and
 * θ + 90°, so each segment votes with 4θ (which folds both onto one
 * angle), weighted by its length. Returns 0 when the walls don't agree on
 * a direction (round or irregular buildings) — the grid then stays
 * north-up, as before.
 */
export function dominantAxisDeg(
  segments: ReadonlyArray<{ a: [number, number]; b: [number, number]; weight?: number }>,
  anchor: [number, number],
): number {
  const frame = makeLocalFrame(anchor)
  let sx = 0
  let sy = 0
  let total = 0
  for (const { a, b, weight = 1 } of segments) {
    const [ax, ay] = toLocal(frame, a)
    const [bx, by] = toLocal(frame, b)
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 0.5) continue
    const t = 4 * Math.atan2(by - ay, bx - ax)
    sx += Math.cos(t) * len * weight
    sy += Math.sin(t) * len * weight
    total += len * weight
  }
  if (total === 0 || Math.hypot(sx, sy) / total < 0.3) return 0
  const deg = (Math.atan2(sy, sx) * 180) / Math.PI / 4
  return Math.abs(deg) < 0.5 ? 0 : deg
}
