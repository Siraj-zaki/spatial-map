/**
 * Shape-local nudge helpers.
 *
 * Translates a vertex list in the LOCAL frame defined by the first
 * segment (`vertices[0] → vertices[1]`) instead of the geographic
 * compass. UI callers in the editor route door / line / stair arrow-
 * key nudges through this helper so that, when the user is editing
 * a floor plan whose image was placed at a non-zero rotation, the
 * arrows match the wall the shape was drawn on rather than the
 * basemap's true north.
 *
 * Pure, side-effect-free, and intentionally standalone (no imports
 * from other shape modules) so adding it can't perturb any existing
 * pipeline.
 */

const METERS_PER_DEG_LAT = 111_320

function metersToLngDelta(meters: number, lat: number): number {
  return meters / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
}

function metersToLatDelta(meters: number): number {
  return meters / METERS_PER_DEG_LAT
}

/**
 * Returns a translated copy of `vertices`. The motion is decomposed
 * into:
 *
 *   - `alongMeters`     — positive = forward along the first segment
 *                         (toward `vertices[1]`).
 *   - `perpMeters`      — positive = to the left of that direction
 *                         (left-perpendicular).
 *   - `rotationDeg`     — additional CCW rotation to add to the
 *                         first-segment heading before applying the
 *                         motion. Needed for shape kinds (polygon,
 *                         line, stair, image) that store their
 *                         `rotation` in a separate field and apply it
 *                         at render time — the vertices are the
 *                         un-rotated original, so the natural
 *                         `v0 → v1` heading is off by exactly this
 *                         angle from what the user sees on screen.
 *                         Doors bake rotation into the vertices, so
 *                         they pass `0` (or omit) and this becomes a
 *                         no-op.
 *
 * When the first segment is degenerate (zero length), the call falls
 * back to a geographic-frame translation so the shape still moves and
 * the user can recover. Pass at least 2 vertices.
 */
export function nudgeVerticesAlongHeading(
  vertices: ReadonlyArray<[number, number]>,
  alongMeters: number,
  perpMeters: number,
  rotationDeg = 0,
): [number, number][] {
  if (vertices.length < 2) return vertices.map(([lng, lat]) => [lng, lat])
  const [v0, v1] = vertices
  const midLat = (v0[1] + v1[1]) / 2
  const dx = (v1[0] - v0[0]) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
  const dy = (v1[1] - v0[1]) * METERS_PER_DEG_LAT
  const len = Math.hypot(dx, dy)
  let dxMeters: number
  let dyMeters: number
  if (len < 1e-6) {
    // Degenerate heading — interpret along/perp as east/north so the
    // user still has a recovery path.
    dxMeters = alongMeters
    dyMeters = perpMeters
  } else {
    let ux = dx / len
    let uy = dy / len
    if (Math.abs(rotationDeg) > 1e-9) {
      // Rotate the heading unit vector by `rotationDeg` CCW to match
      // the visible orientation the user sees on screen.
      const theta = (rotationDeg * Math.PI) / 180
      const cos = Math.cos(theta)
      const sin = Math.sin(theta)
      const rx = ux * cos - uy * sin
      const ry = ux * sin + uy * cos
      ux = rx
      uy = ry
    }
    // Left-perpendicular: (-uy, ux).
    const px = -uy
    const py = ux
    dxMeters = alongMeters * ux + perpMeters * px
    dyMeters = alongMeters * uy + perpMeters * py
  }
  const dLng = metersToLngDelta(dxMeters, midLat)
  const dLat = metersToLatDelta(dyMeters)
  return vertices.map(([lng, lat]) => [lng + dLng, lat + dLat])
}
