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
}

/**
 * Build a local frame anchored at the given lng/lat. Picks the scene
 * centroid or bbox centre in practice — anywhere inside the scene is
 * fine; the further points are from the anchor the more the tiny
 * cosine approximation error grows, but at 250 m it's <0.1 cm.
 */
export function makeLocalFrame(anchor: [number, number]): LocalFrame {
  const [lng0, lat0] = anchor
  return {
    lat0,
    lng0,
    metersPerDegLng: DEG_TO_M * Math.cos((lat0 * Math.PI) / 180),
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

/** Convert a lng/lat point to local East/North metres. */
export function toLocal(frame: LocalFrame, ll: [number, number]): [number, number] {
  const [lng, lat] = ll
  return [(lng - frame.lng0) * frame.metersPerDegLng, (lat - frame.lat0) * DEG_TO_M]
}

/** Convert local East/North metres back to lng/lat. */
export function fromLocal(frame: LocalFrame, xy: [number, number]): [number, number] {
  const [x, y] = xy
  return [frame.lng0 + x / frame.metersPerDegLng, frame.lat0 + y / DEG_TO_M]
}
