/**
 * Magic wall generator.
 *
 * Emits ONE closed-ring wall per selected polygon. No shared-edge
 * detection, no existing-wall coverage — each polygon owns exactly
 * one LineShape row that traces its full outward-offset perimeter.
 *
 * Each polygon's perimeter is first simplified via `simplifyRing`
 * to remove duplicate consecutive vertices and near-collinear
 * vertices (drawing jitter). Sharp corners are preserved. Then the
 * simplified ring is offset outward by `wallThickness/2 + wallGap`
 * — the wall centerline sits outside the polygon boundary so the
 * wall's inner face is `wallGap` outside the polygon (visible strip
 * between polygon fill and wall).
 *
 * Trade-off: adjacent polygons multi-selected together will have
 * their rings overlap at shared boundaries — no attempt to detect
 * or dedupe. The user has explicitly asked for "single wall per
 * polygon" and accepts the overlap.
 *
 * Wall placement (outward offset):
 *   - Wall centerline sits OUTSIDE the polygon by
 *     `wallThickness/2 + wallGapMeters`.
 *   - The wall extrudes ±wallThickness/2 perpendicular from that
 *     centerline, so:
 *       - inner face is `wallGapMeters` OUTSIDE the polygon (a
 *         visible strip separates the polygon fill from the wall's
 *         inner face — the "little gap" ask)
 *       - outer face is `wallThickness + wallGapMeters` outside
 *   - Trade-off: adjacent polygons multi-selected together each
 *     emit their own outward walls that COLLIDE at shared
 *     boundaries. Existing-wall coverage handles the one-at-a-
 *     time case (second polygon detects the first's wall on its
 *     edge and skips it).
 *
 * The output is non-destructive: existing walls are never mutated,
 * and polygons are never linked to their generated walls. Safe to
 * re-run.
 *
 * All geometric reasoning happens in a local East-North-Up (ENU)
 * frame anchored at the centroid of the selection. Warehouse-scale
 * distances (up to a few km) round-trip through this frame with < 1
 * cm error, which lets us do plain Euclidean math instead of great-
 * circle work on every segment pair.
 */

import { polygonCentroid } from '@/lib/polygon-generators'
import { polygon as turfPolygon, transformRotate } from '@turf/turf'
import type { Feature, Polygon } from 'geojson'

import type { LineShape, PolygonShape } from '@/lib/shapes'

/** A generated wall: an ordered list of lng/lat vertices. Always a
 *  simple 2-vertex line segment — the caller creates one LineShape
 *  row per polyline. */
export interface MagicWallPolyline {
  vertices: [number, number][]
  closed: boolean
}

export interface MagicWallOptions {
  /** Max perpendicular distance (m) for a polygon's edge to be
   *  considered "already covered" by an existing wall. Hand-drawn
   *  walls rarely land pixel-perfect on the polygon boundary — with
   *  the inward inset (walls sit inside the polygon by wallGapMeters
   *  from the boundary) this tolerance has to be wide enough to
   *  detect a previously-generated wall as still coincident. Default
   *  0.5 m (50 cm). */
  sharedEdgeToleranceMeters?: number
  /** Endpoints closer than this (m) get snapped to a common point.
   *  Only applied to OPEN polylines (arcs left over after existing-
   *  wall coverage subtraction). Closed rings are self-contained
   *  and bypass the snap. Default 0.5 m. */
  endpointSnapMeters?: number
  /** Minimum retained segment length (m). Sub-segments shorter than
   *  this are dropped so we don't spawn 2 cm hairlines from a
   *  partial coverage cut. Default 0.05 m (5 cm). */
  minSegmentLengthMeters?: number
  /** Base wall thickness (m) that the caller applies to every wall.
   *  Used internally to place the wall centerline OUTSIDE the
   *  polygon by wallThickness/2 + wallGapMeters, so the wall's
   *  inner face lands wallGapMeters outside the polygon boundary.
   *  Default 0.3 m (matches DEFAULT_LINE_CONFIG.wallThickness). */
  wallThicknessMeters?: number
  /** Visible gap (m) between the polygon boundary and the wall's
   *  inner face. 0 = wall butts up flush against the polygon
   *  boundary (no visible strip). Default 0.1 m (10 cm). */
  wallGapMeters?: number
}

const DEFAULT_OPTS: Required<MagicWallOptions> = {
  sharedEdgeToleranceMeters: 0.5,
  endpointSnapMeters: 0.5,
  minSegmentLengthMeters: 0.05,
  wallThicknessMeters: 0.3,
  wallGapMeters: 0.1,
}

// ---- ENU (local flat metric) frame ----------------------------------------

const METERS_PER_DEG_LAT = 111_320

interface EnuFrame {
  originLng: number
  originLat: number
  mPerDegLon: number
}

function makeEnuFrame(polygons: PolygonShape[]): EnuFrame | null {
  let sumLng = 0
  let sumLat = 0
  let count = 0
  for (const p of polygons) {
    for (const [lng, lat] of p.vertices) {
      sumLng += lng
      sumLat += lat
      count += 1
    }
  }
  if (count === 0) return null
  const originLat = sumLat / count
  const originLng = sumLng / count
  const mPerDegLon = METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180)
  return { originLng, originLat, mPerDegLon }
}

function toEnu(frame: EnuFrame, [lng, lat]: [number, number]): [number, number] {
  return [
    (lng - frame.originLng) * frame.mPerDegLon,
    (lat - frame.originLat) * METERS_PER_DEG_LAT,
  ]
}

function fromEnu(frame: EnuFrame, [east, north]: [number, number]): [number, number] {
  return [
    frame.originLng + east / frame.mPerDegLon,
    frame.originLat + north / METERS_PER_DEG_LAT,
  ]
}

// ---- Segment primitives (all in ENU meters) ------------------------------

interface Vec { x: number; y: number }
interface SegEnu { a: Vec; b: Vec }

function distance(u: Vec, v: Vec): number { return Math.hypot(u.x - v.x, u.y - v.y) }

// ---- Polygon perimeter extraction ----------------------------------------

function rotatePolygonRing(
  ring: [number, number][],
  degrees: number,
): [number, number][] {
  if (Math.abs(degrees) < 1e-6 || ring.length < 3) return ring.slice()
  const pivot = polygonCentroid(ring)
  if (!pivot) return ring.slice()
  const closed = [...ring, ring[0]]
  let rotated: Feature<Polygon>
  try {
    const poly = turfPolygon([closed])
    rotated = transformRotate(poly, degrees, { pivot })
  } catch {
    return ring.slice()
  }
  const out = rotated.geometry.coordinates[0] as [number, number][]
  return out.slice(0, -1)
}

/** Drop vertices that lie (approximately) on the straight line between
 *  their two neighbours. Casually-drawn polygons often accumulate 3-6
 *  clustered vertices along what the user meant to be a single edge.
 *  Emitting one wall per raw vertex-to-vertex segment produces many
 *  tiny walls whose round caps dominate the visual and create the
 *  "stepped / notched" appearance at corners. Also drops duplicate
 *  consecutive vertices (some polygons have the last vertex repeated).
 *  Real corners (angle change > `collinearityToleranceDeg`) are
 *  preserved.
 */
function simplifyRing(
  ring: [number, number][],
  collinearityToleranceDeg: number,
  duplicateVertexEpsilonDeg: number,
): [number, number][] {
  if (ring.length < 3) return ring.slice()
  // First pass: drop duplicate consecutive vertices (within the epsilon
  // in degrees, ~1e-5 ≈ 1 metre at this latitude).
  const deduped: [number, number][] = []
  for (const v of ring) {
    const last = deduped[deduped.length - 1]
    if (!last || Math.abs(v[0] - last[0]) > duplicateVertexEpsilonDeg ||
        Math.abs(v[1] - last[1]) > duplicateVertexEpsilonDeg) {
      deduped.push(v)
    }
  }
  // Wrap-around dedupe: last equals first?
  if (deduped.length >= 2) {
    const first = deduped[0]
    const last = deduped[deduped.length - 1]
    if (Math.abs(first[0] - last[0]) < duplicateVertexEpsilonDeg &&
        Math.abs(first[1] - last[1]) < duplicateVertexEpsilonDeg) {
      deduped.pop()
    }
  }
  if (deduped.length < 3) return deduped

  // Second pass: drop collinear vertices. sin(angle) between adjacent
  // edge vectors — anything below `sin(toleranceDeg)` counts as
  // straight enough to remove.
  const sinTol = Math.sin((collinearityToleranceDeg * Math.PI) / 180)
  const out: [number, number][] = []
  const n = deduped.length
  for (let i = 0; i < n; i++) {
    const prev = deduped[(i - 1 + n) % n]
    const curr = deduped[i]
    const next = deduped[(i + 1) % n]
    const dx1 = curr[0] - prev[0]
    const dy1 = curr[1] - prev[1]
    const dx2 = next[0] - curr[0]
    const dy2 = next[1] - curr[1]
    const len1 = Math.hypot(dx1, dy1)
    const len2 = Math.hypot(dx2, dy2)
    if (len1 < 1e-12 || len2 < 1e-12) continue
    const cross = dx1 * dy2 - dy1 * dx2
    const sinAngle = cross / (len1 * len2)
    if (Math.abs(sinAngle) < sinTol) continue
    out.push(curr)
  }
  return out.length >= 3 ? out : deduped
}

function polygonEdgesEnu(polygon: PolygonShape, frame: EnuFrame): SegEnu[] {
  // Simplify BEFORE rotation so tolerances (in degrees) reflect the
  // stored polygon vertices. Tolerance chosen conservatively: 1° angle
  // change is a real corner, anything smaller is treated as a straight
  // segment with a stray click. Duplicate epsilon 1e-6 degrees ≈ 11 cm
  // at this latitude — well below any deliberate vertex spacing.
  const simplified = simplifyRing(polygon.vertices, 1.0, 1e-6)
  const rotated = rotatePolygonRing(simplified, polygon.rotation)
  if (rotated.length < 2) return []
  const out: SegEnu[] = []
  for (let i = 0; i < rotated.length; i++) {
    const a = toEnu(frame, rotated[i])
    const b = toEnu(frame, rotated[(i + 1) % rotated.length])
    out.push({ a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } })
  }
  return out
}

function lineSegmentsEnu(line: LineShape, frame: EnuFrame): SegEnu[] {
  const verts = line.vertices
  if (verts.length < 2) return []
  const out: SegEnu[] = []
  for (let i = 0; i < verts.length - 1; i++) {
    const a = toEnu(frame, verts[i])
    const b = toEnu(frame, verts[i + 1])
    out.push({ a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } })
  }
  return out
}

/** Return a new ring of edges shifted from the polygon's perimeter
 *  by `distance` metres. Sign convention: positive = INWARD (into
 *  the polygon interior); negative = OUTWARD.
 *
 *  Per-vertex bisector offset so adjacent edges share the same
 *  shifted corner point — the ring closes cleanly.
 *
 *  Winding detected via signed area in the local ENU frame.
 *  Reflex corners get the scale factor capped at `|distance| * 6`
 *  to prevent runaway spikes at very sharp angles.
 */
function insetPolygonEdges(edges: SegEnu[], distance: number): SegEnu[] {
  if (edges.length === 0 || distance === 0) return edges.slice()

  const verts: Vec[] = edges.map((e) => e.a)
  const n = verts.length

  let area2 = 0
  for (let i = 0; i < n; i++) {
    const a = verts[i]
    const b = verts[(i + 1) % n]
    area2 += a.x * b.y - b.x * a.y
  }
  const ccw = area2 > 0

  const inward = distance > 0
  const shiftNormalFor = (edge: SegEnu): Vec => {
    const dx = edge.b.x - edge.a.x
    const dy = edge.b.y - edge.a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) return { x: 0, y: 0 }
    // Right-of-direction perpendicular.
    const rx = dy / len
    const ry = -dx / len
    const outwardX = ccw ? rx : -rx
    const outwardY = ccw ? ry : -ry
    return inward ? { x: -outwardX, y: -outwardY } : { x: outwardX, y: outwardY }
  }

  const absDist = Math.abs(distance)
  const shiftedVerts: Vec[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const inEdge = edges[(i - 1 + n) % n]
    const outEdge = edges[i]
    const nIn = shiftNormalFor(inEdge)
    const nOut = shiftNormalFor(outEdge)
    const bx = nIn.x + nOut.x
    const by = nIn.y + nOut.y
    const bLen = Math.hypot(bx, by)
    if (bLen < 1e-6) {
      shiftedVerts[i] = { x: verts[i].x, y: verts[i].y }
      continue
    }
    const bnx = bx / bLen
    const bny = by / bLen
    const cosHalf = nIn.x * bnx + nIn.y * bny
    const rawScale = cosHalf < 1e-6 ? absDist : absDist / cosHalf
    const scaleFactor = Math.min(rawScale, absDist * 6)
    shiftedVerts[i] = {
      x: verts[i].x + bnx * scaleFactor,
      y: verts[i].y + bny * scaleFactor,
    }
  }

  const out: SegEnu[] = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = { a: shiftedVerts[i], b: shiftedVerts[(i + 1) % n] }
  }
  return out
}

// ---- Endpoint snapping (union-find) --------------------------------------

class SnapGroups {
  private points: Vec[] = []
  private parent: number[] = []

  add(p: Vec): number {
    this.points.push(p)
    this.parent.push(this.points.length - 1)
    return this.points.length - 1
  }

  private find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]]
      i = this.parent[i]
    }
    return i
  }

  union(i: number, j: number): void {
    const ri = this.find(i)
    const rj = this.find(j)
    if (ri !== rj) this.parent[ri] = rj
  }

  resolved(): Vec[] {
    const groups = new Map<number, Vec[]>()
    for (let i = 0; i < this.points.length; i++) {
      const root = this.find(i)
      const arr = groups.get(root)
      if (arr) arr.push(this.points[i])
      else groups.set(root, [this.points[i]])
    }
    const centroid = new Map<number, Vec>()
    for (const [root, pts] of groups) {
      let sx = 0
      let sy = 0
      for (const p of pts) { sx += p.x; sy += p.y }
      centroid.set(root, { x: sx / pts.length, y: sy / pts.length })
    }
    const out: Vec[] = new Array(this.points.length)
    for (let i = 0; i < this.points.length; i++) {
      out[i] = centroid.get(this.find(i))!
    }
    return out
  }
}

// ---- Per-polygon perimeter walk ------------------------------------------

interface EnuPolyline {
  points: Vec[]
  closed: boolean
}

/** Emit ONE closed polyline of the polygon's full outward-offset
 *  perimeter. Every polygon becomes exactly one wall LineShape.
 *
 *  The last vertex is duplicated from the first so that when the
 *  line overlay turf-buffers this polyline for the 3D wall, turf
 *  recognises it as a CLOSED LineString and produces a full-
 *  perimeter buffered polygon with no round caps. Without the
 *  duplicated closing vertex, turf treats the polyline as OPEN,
 *  buffers it with round caps at each end, and the closing edge
 *  (vN → v0) is NEVER drawn — visible as the "one side open"
 *  wall bug. */
function emitClosedRing(insetEdges: SegEnu[], minLen: number): EnuPolyline[] {
  if (insetEdges.length < 2) return []
  const pts = insetEdges.map((e) => e.a)
  // Reject rings whose total perimeter length is below the min. Rare
  // (would require a degenerate polygon), but guards against emitting
  // near-empty walls.
  let totalLen = 0
  for (let i = 0; i < pts.length; i++) {
    totalLen += distance(pts[i], pts[(i + 1) % pts.length])
  }
  if (totalLen < minLen) return []
  // Close the ring — last vertex === first vertex.
  const closedPts = [...pts, pts[0]]
  return [{ points: closedPts, closed: true }]
}

// ---- Main entry -----------------------------------------------------------

/**
 * Generate wall polylines for the given selected polygons.
 *
 * One closed-ring wall per polygon (its full outward-offset
 * perimeter, after collinear-vertex simplification). Adjacent
 * polygons in a multi-select overlap at shared boundaries.
 */
export function generateMagicWallPolylines(
  selectedPolygons: PolygonShape[],
  existingWalls: LineShape[],
  options?: MagicWallOptions,
): MagicWallPolyline[] {
  const opts = { ...DEFAULT_OPTS, ...(options ?? {}) }
  const eligible = selectedPolygons.filter((p) => p.vertices.length >= 3)
  if (eligible.length === 0) return []

  const frame = makeEnuFrame(eligible)
  if (!frame) return []

  const existingSegs: SegEnu[] = []
  for (const wall of existingWalls) {
    for (const seg of lineSegmentsEnu(wall, frame)) {
      if (distance(seg.a, seg.b) < opts.minSegmentLengthMeters) continue
      existingSegs.push(seg)
    }
  }

  const perPolygonEdges: SegEnu[][] = eligible.map((p) => polygonEdgesEnu(p, frame))
  // Negative distance → OUTWARD offset. Wall centerline sits outside
  // the polygon by wallThickness/2 + wallGap so the wall's inner
  // face is wallGap away from the polygon boundary.
  const offsetMeters = -(opts.wallThicknessMeters / 2 + opts.wallGapMeters)
  const perPolygonOffsetEdges: SegEnu[][] = perPolygonEdges.map((edges) =>
    insetPolygonEdges(edges, offsetMeters),
  )

  // ONE closed-ring wall per polygon. No shared-edge detection, no
  // existing-wall coverage — each polygon owns one clean wall. If
  // adjacent polygons are multi-selected, their rings will overlap
  // at shared boundaries; that's the trade-off for "single wall per
  // polygon".
  const polylinesEnu: EnuPolyline[] = []
  for (let polyIdx = 0; polyIdx < eligible.length; polyIdx++) {
    const walked = emitClosedRing(
      perPolygonOffsetEdges[polyIdx],
      opts.minSegmentLengthMeters,
    )
    polylinesEnu.push(...walked)
  }

  if (polylinesEnu.length === 0) return []

  // Endpoint snap — only for OPEN polylines. Closed rings are self-
  // contained and bypass the snap (adding their identical
  // points[0]/points[last] to the union-find distorted the ring
  // when neighbouring closed rings got unioned).
  const groups = new SnapGroups()
  const perPolylineSnap: ({ start: number; end: number } | null)[] =
    polylinesEnu.map((pl) => {
      if (pl.closed) return null
      return {
        start: groups.add(pl.points[0]),
        end: groups.add(pl.points[pl.points.length - 1]),
      }
    })
  for (const seg of existingSegs) {
    groups.add(seg.a)
    groups.add(seg.b)
  }

  const tol2 = opts.endpointSnapMeters * opts.endpointSnapMeters
  const flatPoints: Vec[] = []
  for (const pl of polylinesEnu) {
    if (pl.closed) continue
    flatPoints.push(pl.points[0])
    flatPoints.push(pl.points[pl.points.length - 1])
  }
  for (const seg of existingSegs) {
    flatPoints.push(seg.a)
    flatPoints.push(seg.b)
  }
  for (let i = 0; i < flatPoints.length; i++) {
    for (let j = i + 1; j < flatPoints.length; j++) {
      const dx = flatPoints[i].x - flatPoints[j].x
      const dy = flatPoints[i].y - flatPoints[j].y
      if (dx * dx + dy * dy <= tol2) groups.union(i, j)
    }
  }

  const resolved = groups.resolved()

  const out: MagicWallPolyline[] = []
  for (let i = 0; i < polylinesEnu.length; i++) {
    const pl = polylinesEnu[i]
    const pts = pl.points.slice()
    const snap = perPolylineSnap[i]
    if (snap !== null) {
      pts[0] = resolved[snap.start]
      pts[pts.length - 1] = resolved[snap.end]
    }
    let totalLen = 0
    for (let k = 1; k < pts.length; k++) totalLen += distance(pts[k - 1], pts[k])
    if (totalLen < opts.minSegmentLengthMeters) continue
    out.push({
      vertices: pts.map((p) => fromEnu(frame, [p.x, p.y])),
      closed: pl.closed,
    })
  }
  return out
}
