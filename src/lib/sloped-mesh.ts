/**
 * Sloped solids drawn as triangle meshes — the shapes `fill-extrusion`
 * can't make, because it only pushes a flat footprint straight up:
 *
 *  - **Leaning walls** (lines): `LineShapeConfig.lean` moves the top of the
 *    wall sideways. A `straight` profile is a flat slanted wall; `curved`
 *    rises vertically and bends over near the top (a quarter ellipse), so a
 *    closed loop with a big curved lean reads as a stadium roof or a bowl.
 *  - **Tapered / dome solids** (areas, circles): `FillShapeConfig.topShape`
 *    shrinks the footprint toward its centre as it rises — `taper` linearly
 *    (pyramid, cone, frustum), `dome` along a quarter ellipse. `topScale`
 *    is the top's size as a % of the base (0 = a point).
 *
 * Meshes are (east, north, up) metres from the first vertex and draw
 * through `LiftMeshLayer` (see `useShapeMeshLayers`). The overlays keep the
 * shape's ordinary extrusion in the zero-opacity bucket, so clicks, hover
 * and selection outlines work exactly as before — the same split stairs
 * use (docs/pitfalls-frontend.md, "Anything sloped can't be a
 * fill-extrusion").
 */

import type { LiftMeshData } from './lift-mesh'
import type { FillShapeConfig, LineShapeConfig } from './shapes'

type Vec2 = [number, number]
type Vec3 = [number, number, number]

/** Same metres-per-degree the stair meshes use (stair-generators.ts). */
const METERS_PER_DEG = 111_320
/** Profile samples for curved / dome shapes. */
const CURVE_STEPS = 16
/** Adjacent faces turning more than this keep a hard edge. */
const CREASE_DEG = 32
/** Below this a lean / height is treated as none. */
const MIN_M = 0.01

export type WallLeanProfile = 'straight' | 'curved'
/** `in` / `out` apply to closed loops; `left` / `right` of the drawing direction otherwise. */
export type WallLeanSide = 'left' | 'right' | 'in' | 'out'
export type FillTopShape = 'flat' | 'taper' | 'dome'

/** Default wall thickness (m) — matches buildLineWallFeature. */
const DEFAULT_WALL_THICKNESS = 0.3

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** True when a wall needs the mesh path (it leans and has a height). */
export function wallLeans(cfg: Pick<LineShapeConfig, 'lean' | 'height'>, height = cfg.height): boolean {
  return (cfg.lean ?? 0) > MIN_M && (height ?? 0) > MIN_M
}

/** True when an area / circle needs the mesh path (non-flat top with a height). */
export function fillTapers(cfg: Pick<FillShapeConfig, 'topShape' | 'height'>, height = cfg.height): boolean {
  const top = cfg.topShape ?? 'flat'
  return top !== 'flat' && (height ?? 0) > MIN_M
}

// ---------------------------------------------------------------------------
// Frames, colours
// ---------------------------------------------------------------------------

function localFrame(origin: Vec2) {
  const kx = METERS_PER_DEG * Math.cos((origin[1] * Math.PI) / 180)
  return (p: Vec2): Vec2 => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * METERS_PER_DEG]
}

/** `#rrggbb` → RGB 0–1. Falls back to grey on anything else. */
function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0.6, 0.6, 0.6]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export interface MeshPaint {
  /** Base colour, `#rrggbb`. */
  color: string
  /** 0–100. */
  opacity: number
  /** Selection wash colour (`#rrggbb`) mixed in when set. */
  tint?: string | null
}

function rgba(paint: MeshPaint): [number, number, number, number] {
  let [r, g, b] = hexRgb(paint.color)
  if (paint.tint) {
    const [tr, tg, tb] = hexRgb(paint.tint)
    const k = 0.35
    r = r * (1 - k) + tr * k
    g = g * (1 - k) + tg * k
    b = b * (1 - k) + tb * k
  }
  const a = Math.max(0, Math.min(1, paint.opacity / 100))
  return [r, g, b, a]
}

// ---------------------------------------------------------------------------
// Mesh assembly
// ---------------------------------------------------------------------------

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

class MeshBuilder {
  positions: number[] = []
  normals: number[] = []

  tri(a: Vec3, b: Vec3, c: Vec3, na: Vec3, nb: Vec3, nc: Vec3) {
    this.positions.push(...a, ...b, ...c)
    this.normals.push(...na, ...nb, ...nc)
  }

  flatTri(a: Vec3, b: Vec3, c: Vec3) {
    const n = norm(cross(sub(b, a), sub(c, a)))
    this.tri(a, b, c, n, n, n)
  }

  /**
   * A surface sampled on a grid: `rows[k][i]` (k along the profile, i
   * along the path). Normals are smoothed along k always, and along i
   * except where the path turns sharper than CREASE_DEG — curved walls and
   * domes read as smooth, a box's corners stay crisp. `wrap` joins the
   * last column back to the first (closed loops / rings).
   */
  surface(rows: Vec3[][], wrap: boolean) {
    const K = rows.length - 1
    const N = rows[0]?.length ?? 0
    if (K < 1 || N < 2) return
    const cols = wrap ? N : N - 1
    // Face normal of each quad (k, i) → (k+1, i+1).
    const face: Vec3[][] = []
    for (let k = 0; k < K; k++) {
      face.push([])
      for (let i = 0; i < cols; i++) {
        const j = (i + 1) % N
        const a = rows[k][i]
        const b = rows[k][j]
        const c = rows[k + 1][i]
        const d = rows[k + 1][j]
        let n = cross(sub(b, a), sub(c, a))
        if (Math.hypot(...n) < 1e-12) n = cross(sub(d, c), sub(c, a))
        if (Math.hypot(...n) < 1e-12) n = cross(sub(d, b), sub(b, a))
        face[k].push(norm(n))
      }
    }
    // Is column i a smooth joint between quads i-1 and i? Judged on the
    // bottom row's horizontal direction change.
    const smoothCol: boolean[] = []
    const cosCrease = Math.cos((CREASE_DEG * Math.PI) / 180)
    for (let i = 0; i < N; i++) {
      const hasPrev = wrap || i > 0
      const hasNext = wrap || i < N - 1
      if (!hasPrev || !hasNext) {
        smoothCol.push(false)
        continue
      }
      const p = rows[0][(i - 1 + N) % N]
      const c = rows[0][i]
      const n = rows[0][(i + 1) % N]
      const u = [c[0] - p[0], c[1] - p[1]]
      const v = [n[0] - c[0], n[1] - c[1]]
      const lu = Math.hypot(u[0], u[1])
      const lv = Math.hypot(v[0], v[1])
      smoothCol.push(lu < 1e-9 || lv < 1e-9 ? true : (u[0] * v[0] + u[1] * v[1]) / (lu * lv) >= cosCrease)
    }
    // Vertex normal for quad column q at grid point (k, i).
    const vertexNormal = (k: number, i: number, q: number): Vec3 => {
      const ks = [k - 1, k].filter((x) => x >= 0 && x < K)
      const qs = smoothCol[i] ? [(i - 1 + cols) % cols, i % cols].filter((x, idx, all) => x >= 0 && x < cols && all.indexOf(x) === idx) : [q]
      let n: Vec3 = [0, 0, 0]
      for (const kk of ks) for (const qq of qs) n = add(n, face[kk][qq])
      return norm(n)
    }
    for (let k = 0; k < K; k++) {
      for (let q = 0; q < cols; q++) {
        const i = q
        const j = (q + 1) % N
        const a = rows[k][i]
        const b = rows[k][j]
        const c = rows[k + 1][i]
        const d = rows[k + 1][j]
        const na = vertexNormal(k, i, q)
        const nb = vertexNormal(k, j, q)
        const nc = vertexNormal(k + 1, i, q)
        const nd = vertexNormal(k + 1, j, q)
        this.tri(a, b, d, na, nb, nd)
        this.tri(a, d, c, na, nd, nc)
      }
    }
  }

  /** Fan from `centre` over a closed ring (star-shaped about the centre). */
  fan(centre: Vec3, ring: Vec3[]) {
    for (let i = 0; i < ring.length; i++) this.flatTri(centre, ring[i], ring[(i + 1) % ring.length])
  }

  build(key: string, origin: Vec2, color: [number, number, number, number]): LiftMeshData {
    const count = this.positions.length / 3
    const colors = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) colors.set(color, i * 4)
    return {
      key,
      origin,
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors,
    }
  }
}

// ---------------------------------------------------------------------------
// Leaning walls
// ---------------------------------------------------------------------------

/** Quarter-ellipse or straight profile: (sideways 0…1, up 0…1) samples. */
function leanProfile(profile: WallLeanProfile): Vec2[] {
  if (profile === 'straight') return [[0, 0], [1, 1]]
  const out: Vec2[] = []
  for (let s = 0; s <= CURVE_STEPS; s++) {
    const th = (s / CURVE_STEPS) * (Math.PI / 2)
    out.push([1 - Math.cos(th), Math.sin(th)])
  }
  return out
}

/** Signed area of a ring in (east, north): > 0 when counter-clockwise. */
function signedArea(pts: Vec2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

/** A polyline is a closed loop when its ends meet (within 10 cm). */
export function isClosedLoop(vertices: ReadonlyArray<Vec2>): boolean {
  if (vertices.length < 4) return false
  const f = localFrame(vertices[0])
  const [x, y] = f(vertices[vertices.length - 1])
  return Math.hypot(x, y) < 0.1
}

/**
 * +1 to lean toward the left of the drawing direction, -1 toward the right.
 * On a closed loop `in` (the default there) resolves to whichever side the
 * interior is on; on an open line the default is `left`.
 */
function leanSign(side: WallLeanSide | undefined, closed: boolean, pts: Vec2[]): number {
  const s = side ?? (closed ? 'in' : 'left')
  if (s === 'left') return 1
  if (s === 'right') return -1
  if (!closed) return s === 'in' ? 1 : -1
  const ccw = signedArea(pts) > 0
  const inward = ccw ? 1 : -1
  return s === 'in' ? inward : -inward
}

/** Left-hand normals at each vertex, mitred (capped at 3×) so offsets stay parallel. */
function mitreNormals(pts: Vec2[], closed: boolean): Vec2[] {
  const n = pts.length
  const segN: Vec2[] = []
  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const L = Math.hypot(dx, dy) || 1e-9
    segN.push([-dy / L, dx / L])
  }
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    let a: Vec2 | undefined
    let b: Vec2 | undefined
    if (closed) {
      a = segN[(i - 1 + segs) % segs]
      b = segN[i % segs]
    } else {
      a = segN[i - 1]
      b = segN[i]
    }
    if (!a) {
      out.push(b!)
      continue
    }
    if (!b) {
      out.push(a)
      continue
    }
    let nx = a[0] + b[0]
    let ny = a[1] + b[1]
    const L = Math.hypot(nx, ny)
    if (L < 1e-6) {
      out.push(a)
      continue
    }
    nx /= L
    ny /= L
    const k = 1 / Math.max(nx * a[0] + ny * a[1], 1 / 3)
    out.push([nx * k, ny * k])
  }
  return out
}

export interface LeaningWallInput {
  /** The wall's polyline, rotation already applied, [lng, lat]. */
  vertices: ReadonlyArray<Vec2>
  config: Pick<LineShapeConfig, 'lean' | 'leanProfile' | 'leanSide' | 'wallThickness'>
  elevation: number
  height: number
  paint: MeshPaint
  key: string
}

/**
 * A wall swept along its polyline with a leaning cross-section: outer and
 * inner faces offset ± half the thickness along the profile's normal, plus
 * top, bottom and (open lines) end caps.
 */
export function buildLeaningWallMesh(input: LeaningWallInput): LiftMeshData | null {
  const { vertices, config, elevation, height, paint, key } = input
  if (vertices.length < 2) return null
  const lean = config.lean ?? 0
  if (lean <= MIN_M || height <= MIN_M) return null
  const origin = vertices[0]
  const toM = localFrame(origin)
  const closed = isClosedLoop(vertices)
  let pts = vertices.map((v) => toM(v))
  if (closed) pts = pts.slice(0, -1)
  // Drop repeated points (a double click leaves one).
  pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.02)
  if (pts.length < 2) return null
  const normals = mitreNormals(pts, closed)
  const sign = leanSign(config.leanSide, closed, pts)
  const half = Math.max(0.05, config.wallThickness ?? DEFAULT_WALL_THICKNESS) / 2
  const prof = leanProfile(config.leanProfile ?? 'curved')

  // Profile samples in (sideways m, up m) for the wall's centre plane, and
  // the two faces offset along each sample's in-plane normal.
  const centre = prof.map(([x, z]) => [x * lean, z * height] as Vec2)
  const offsetAt = (k: number, d: number): Vec2 => {
    const prev = centre[Math.max(0, k - 1)]
    const next = centre[Math.min(centre.length - 1, k + 1)]
    const tx = next[0] - prev[0]
    const tz = next[1] - prev[1]
    const L = Math.hypot(tx, tz) || 1
    // Normal pointing to +sideways when the wall is vertical.
    const nx = tz / L
    const nz = -tx / L
    return [centre[k][0] + nx * d, Math.max(0, centre[k][1] + nz * d)]
  }
  const sheet = (d: number): Vec3[][] =>
    centre.map((_, k) => {
      const [x, z] = offsetAt(k, d)
      return pts.map((p, i) => [p[0] + normals[i][0] * x * sign, p[1] + normals[i][1] * x * sign, elevation + z] as Vec3)
    })
  // The face on the lean side is `d > 0`; which one is "outer" doesn't
  // matter for drawing — the shader lights both sides.
  const faceA = sheet(half)
  const faceB = sheet(-half)
  // Offsetting sideways by ±half also needs the base to straddle the line.
  for (const row of [faceA[0], faceB[0]]) for (const p of row) p[2] = elevation
  const mesh = new MeshBuilder()
  mesh.surface(faceA, closed)
  mesh.surface(faceB, closed)
  const K = centre.length - 1
  mesh.surface([faceA[K], faceB[K]], closed) // top
  mesh.surface([faceA[0], faceB[0]], closed) // bottom
  if (!closed) {
    const last = pts.length - 1
    for (const i of [0, last]) {
      const strip = faceA.map((row, k) => [row[i], faceB[k][i]])
      mesh.surface(strip, false)
    }
  }
  return mesh.build(key, origin, rgba(paint))
}

// ---------------------------------------------------------------------------
// Tapered / dome solids
// ---------------------------------------------------------------------------

export interface TaperedSolidInput {
  /** The footprint's outer ring, rotation applied, [lng, lat] (closed or open). */
  ring: ReadonlyArray<Vec2>
  config: Pick<FillShapeConfig, 'topShape' | 'topScale'>
  elevation: number
  height: number
  paint: MeshPaint
  key: string
}

/**
 * The footprint shrunk toward its centre as it rises: rings scaled by
 * `s(t)` (linear for `taper`, a quarter ellipse for `dome`), capped top and
 * bottom with a fan from the centre. Works for any footprint that is
 * star-shaped about its centre — rectangles, circles, most rooms; a deep L
 * scales past its own corner.
 */
export function buildTaperedSolidMesh(input: TaperedSolidInput): LiftMeshData | null {
  const { ring, config, elevation, height, paint, key } = input
  const top = config.topShape ?? 'flat'
  if (top === 'flat' || height <= MIN_M || ring.length < 3) return null
  const origin = ring[0]
  const toM = localFrame(origin)
  let pts = ring.map((v) => toM(v))
  const f = pts[0]
  const l = pts[pts.length - 1]
  if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) pts = pts.slice(0, -1)
  pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.01)
  if (pts.length < 3) return null
  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p[0]
    cy += p[1]
  }
  cx /= pts.length
  cy /= pts.length
  const topScale = Math.max(0, Math.min(1, (config.topScale ?? 0) / 100))
  // (scale, up 0…1) samples.
  const samples: Vec2[] = []
  if (top === 'taper') {
    samples.push([1, 0], [topScale, 1])
  } else {
    for (let s = 0; s <= CURVE_STEPS; s++) {
      const th = (s / CURVE_STEPS) * (Math.PI / 2)
      samples.push([topScale + (1 - topScale) * Math.cos(th), Math.sin(th)])
    }
  }
  const rows: Vec3[][] = samples.map(([s, t]) =>
    pts.map((p) => [cx + (p[0] - cx) * s, cy + (p[1] - cy) * s, elevation + t * height] as Vec3),
  )
  const mesh = new MeshBuilder()
  mesh.surface(rows, true)
  mesh.fan([cx, cy, elevation], rows[0])
  if (topScale > 0) mesh.fan([cx, cy, elevation + height], rows[rows.length - 1])
  return mesh.build(key, origin, rgba(paint))
}

// ---------------------------------------------------------------------------
// Per-overlay mesh lists
// ---------------------------------------------------------------------------

interface MeshCacheEntry {
  sig: string
  mesh: LiftMeshData | null
}

/** Rebuild a shape's mesh only when its inputs change (selection toggles are common). */
function cached(cache: WeakMap<object, MeshCacheEntry>, owner: object, sig: string, build: () => LiftMeshData | null) {
  const hit = cache.get(owner)
  if (hit && hit.sig === sig) return hit.mesh
  const mesh = build()
  cache.set(owner, { sig, mesh })
  return mesh
}

const lineMeshCache = new WeakMap<object, MeshCacheEntry>()
const fillMeshCache = new WeakMap<object, MeshCacheEntry>()

interface MeshedProps {
  meshed?: boolean
  color: string
  opacity: number
  elevation: number
  height: number
}

export interface MeshListOptions {
  /** Ids drawn with the selection wash. */
  selectedIds?: ReadonlySet<number> | null
  /** Selection wash colour (`#rrggbb`). */
  tint?: string | null
  /** Id being moved / rotated — drawn from the in-flight extrusion instead. */
  skipId?: number | null
}

/**
 * Meshes for the leaning walls in a wall collection. Paint, elevation and
 * height come from the built features (so style-rule overrides apply); the
 * polyline and lean settings from the shapes.
 */
export function leaningWallMeshes(
  lines: ReadonlyArray<{ id?: number; vertices: [number, number][]; rotation: number; config: LineShapeConfig }>,
  features: ReadonlyArray<{ properties: MeshedProps & { lineId?: number } }>,
  rotate: (vertices: [number, number][], degrees: number) => [number, number][],
  opts: MeshListOptions = {},
): LiftMeshData[] {
  const byId = new Map<number, (typeof lines)[number]>()
  for (const l of lines) if (l.id !== undefined) byId.set(l.id, l)
  const out: LiftMeshData[] = []
  for (const f of features) {
    const p = f.properties
    if (!p.meshed || p.lineId === undefined || p.lineId === opts.skipId) continue
    const shape = byId.get(p.lineId)
    if (!shape) continue
    const tint = opts.selectedIds?.has(p.lineId) ? opts.tint ?? null : null
    const c = shape.config
    const sig = [p.color, p.opacity, p.elevation, p.height, tint, c.lean, c.leanProfile, c.leanSide, c.wallThickness, shape.rotation, shape.vertices.length].join('|')
    const mesh = cached(lineMeshCache, shape, sig, () =>
      buildLeaningWallMesh({
        vertices: rotate(shape.vertices, shape.rotation ?? 0),
        config: c,
        elevation: p.elevation,
        height: p.height,
        paint: { color: p.color, opacity: p.opacity, tint },
        key: `line:${p.lineId}`,
      }),
    )
    if (mesh) out.push(mesh)
  }
  return out
}

/**
 * Meshes for the tapered / dome solids in an area or circle collection.
 * The footprint is the built feature's own ring (rotation applied).
 */
export function taperedSolidMeshes(
  kind: 'polygon' | 'circle',
  shapes: ReadonlyArray<{ id?: number; config: FillShapeConfig }>,
  features: ReadonlyArray<{ geometry: { coordinates: number[][][] }; properties: MeshedProps & { polygonId?: number; circleId?: number } }>,
  opts: MeshListOptions = {},
): LiftMeshData[] {
  const byId = new Map<number, (typeof shapes)[number]>()
  for (const s of shapes) if (s.id !== undefined) byId.set(s.id, s)
  const out: LiftMeshData[] = []
  for (const f of features) {
    const p = f.properties
    const id = kind === 'polygon' ? p.polygonId : p.circleId
    if (!p.meshed || id === undefined || id === opts.skipId) continue
    const shape = byId.get(id)
    if (!shape) continue
    const ring = f.geometry.coordinates[0] as Vec2[] | undefined
    if (!ring) continue
    const tint = opts.selectedIds?.has(id) ? opts.tint ?? null : null
    const c = shape.config
    const sig = [p.color, p.opacity, p.elevation, p.height, tint, c.topShape, c.topScale, ring.length, ring[0]?.[0], ring[0]?.[1], ring[1]?.[0], ring[1]?.[1]].join('|')
    const mesh = cached(fillMeshCache, shape, sig, () =>
      buildTaperedSolidMesh({
        ring,
        config: c,
        elevation: p.elevation,
        height: p.height,
        paint: { color: p.color, opacity: p.opacity, tint },
        key: `${kind}:${id}`,
      }),
    )
    if (mesh) out.push(mesh)
  }
  return out
}

// ---------------------------------------------------------------------------
// Click footprint
// ---------------------------------------------------------------------------

/**
 * The ground area a leaning wall covers, seen from above: the band between
 * its base and its leaned top (± half the thickness). On a closed loop
 * that's a ring with the opening as its hole. The overlay extrudes this as
 * the wall's invisible click target, so clicking anywhere on a roof selects
 * it — not just the thin strip at its base. [lng, lat] rings, closed.
 */
export function leaningWallFootprint(
  vertices: ReadonlyArray<Vec2>,
  config: Pick<LineShapeConfig, 'lean' | 'leanSide' | 'wallThickness'>,
): Vec2[][] | null {
  if (vertices.length < 2) return null
  const origin = vertices[0]
  const kx = METERS_PER_DEG * Math.cos((origin[1] * Math.PI) / 180)
  const toM = localFrame(origin)
  const fromM = (p: Vec2): Vec2 => [origin[0] + p[0] / kx, origin[1] + p[1] / METERS_PER_DEG]
  const closed = isClosedLoop(vertices)
  let pts = vertices.map((v) => toM(v))
  if (closed) pts = pts.slice(0, -1)
  pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.02)
  if (pts.length < 2) return null
  const normals = mitreNormals(pts, closed)
  const sign = leanSign(config.leanSide, closed, pts)
  const half = Math.max(0.05, config.wallThickness ?? DEFAULT_WALL_THICKNESS) / 2
  const top = sign * (config.lean ?? 0)
  const a = Math.min(-half, top - half)
  const b = Math.max(half, top + half)
  const offset = (d: number) => pts.map((p, i) => fromM([p[0] + normals[i][0] * d, p[1] + normals[i][1] * d]))
  const ringA = offset(a)
  const ringB = offset(b)
  if (closed) {
    const area = (r: Vec2[]) => Math.abs(signedArea(r.map((p) => toM(p))))
    const [outer, inner] = area(ringA) >= area(ringB) ? [ringA, ringB] : [ringB, ringA]
    return [[...outer, outer[0]], [...inner, inner[0]]]
  }
  const ring = [...ringA, ...ringB.reverse()]
  return [[...ring, ring[0]]]
}

// ---------------------------------------------------------------------------
// Occlusion / focus geometry
// ---------------------------------------------------------------------------

/** Slices a leaning wall occludes as (one altitude band each). */
const LEAN_SLICES = 8

/**
 * The wall's polyline in the local metric frame with the same clean-up the
 * mesh builder runs (closing vertex dropped on a loop, repeats dropped),
 * its mitred normals and lean sign. null below 2 usable vertices.
 */
function leanFrame(vertices: ReadonlyArray<Vec2>, config: Pick<LineShapeConfig, 'leanSide' | 'wallThickness'>) {
  if (vertices.length < 2) return null
  const origin = vertices[0]
  const kx = METERS_PER_DEG * Math.cos((origin[1] * Math.PI) / 180)
  const toM = localFrame(origin)
  const fromM = (p: Vec2): Vec2 => [origin[0] + p[0] / kx, origin[1] + p[1] / METERS_PER_DEG]
  const closed = isClosedLoop(vertices)
  let pts = vertices.map((v) => toM(v))
  if (closed) pts = pts.slice(0, -1)
  pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.02)
  if (pts.length < 2) return null
  const normals = mitreNormals(pts, closed)
  const sign = leanSign(config.leanSide, closed, pts)
  const half = Math.max(0.05, config.wallThickness ?? DEFAULT_WALL_THICKNESS) / 2
  const offset = (d: number) => pts.map((p, i) => fromM([p[0] + normals[i][0] * d, p[1] + normals[i][1] * d]))
  return { toM, closed, pts, sign, half, offset }
}

/**
 * The centre line of a leaning wall's TOP rim, as drawn by
 * `buildLeaningWallMesh`: every base vertex offset sideways by the full
 * lean on the lean side (both profiles end at sideways 1). A closed loop
 * stays closed (first vertex repeated). [lng, lat]; null when the wall
 * has fewer than 2 usable vertices.
 */
export function leaningWallTopLine(
  vertices: ReadonlyArray<Vec2>,
  config: Pick<LineShapeConfig, 'lean' | 'leanSide'>,
): Vec2[] | null {
  const f = leanFrame(vertices, { leanSide: config.leanSide })
  if (!f) return null
  const line = f.offset(f.sign * (config.lean ?? 0))
  if (f.closed) line.push(line[0])
  return line
}

/**
 * A leaning wall as at most 8 stacked prisms that follow the drawn
 * profile — what the occlusion pass and focus mode test against instead
 * of the wall's base strip (the mesh overhangs that strip by `lean`).
 *
 * `straight`: 8 equal steps of the slant. `curved`: 8 slices of 2 profile
 * steps each (the same 16 steps the mesh samples). Slice k covers the
 * profile from sample k0 to k1: sideways [min x · lean − half, max x ·
 * lean + half] on the lean side, altitude [elevation + z_k0 · height,
 * elevation + z_k1 · height]. Rings are closed [lng, lat], offset exactly
 * as `leaningWallFootprint` offsets them: an open line gives [outer], a
 * closed loop [outer, hole]. [] for a wall that doesn't lean.
 */
export function leaningWallSlices(
  vertices: ReadonlyArray<Vec2>,
  config: Pick<LineShapeConfig, 'lean' | 'leanProfile' | 'leanSide' | 'wallThickness'>,
  elevation: number,
  height: number,
): { rings: Vec2[][]; baseM: number; topM: number }[] {
  const lean = config.lean ?? 0
  if (lean <= MIN_M || !(height > MIN_M)) return []
  const f = leanFrame(vertices, config)
  if (!f) return []
  const profile = config.leanProfile ?? 'curved'
  // (sideways 0…1, up 0…1) at each slice boundary.
  const samples: Vec2[] = []
  if (profile === 'straight') {
    for (let k = 0; k <= LEAN_SLICES; k++) samples.push([k / LEAN_SLICES, k / LEAN_SLICES])
  } else {
    const prof = leanProfile('curved')
    const step = Math.max(1, Math.round((prof.length - 1) / LEAN_SLICES))
    for (let k = 0; k < prof.length; k += step) samples.push(prof[k])
    if (samples[samples.length - 1] !== prof[prof.length - 1]) samples.push(prof[prof.length - 1])
  }
  const area = (r: Vec2[]) => Math.abs(signedArea(r.map((p) => f.toM(p))))
  const out: { rings: Vec2[][]; baseM: number; topM: number }[] = []
  for (let k = 0; k + 1 < samples.length; k++) {
    const [x0, z0] = samples[k]
    const [x1, z1] = samples[k + 1]
    const lo = Math.min(x0, x1) * lean - f.half
    const hi = Math.max(x0, x1) * lean + f.half
    const a = Math.min(f.sign * lo, f.sign * hi)
    const b = Math.max(f.sign * lo, f.sign * hi)
    const ringA = f.offset(a)
    const ringB = f.offset(b)
    let rings: Vec2[][]
    if (f.closed) {
      const [outer, inner] = area(ringA) >= area(ringB) ? [ringA, ringB] : [ringB, ringA]
      rings = [
        [...outer, outer[0]],
        [...inner, inner[0]],
      ]
    } else {
      const ring = [...ringA, ...ringB.reverse()]
      rings = [[...ring, ring[0]]]
    }
    out.push({ rings, baseM: elevation + Math.min(z0, z1) * height, topM: elevation + Math.max(z0, z1) * height })
  }
  return out
}
