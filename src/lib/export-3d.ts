/**
 * 3D model export — the editor's scene as one binary glTF (`.glb`).
 *
 * Opens in Blender, Windows 3D Viewer, macOS Quick Look, Unity, Unreal,
 * three.js and any other glTF 2.0 reader. It is built from the SAME
 * generators the map overlays draw with, so the model matches the screen:
 *
 *   walls (joined corners, door openings cut, leaning walls)   line-generators
 *   areas / circles (flat slabs, extrusions, domes & tapers)   polygon- / circle-generators
 *   grid cells and racks (every level)                         grid-generators
 *   stairs, escalators, elevators                              stair-generators
 *   doors (frame + leaf + glass)                               door/mesh
 *   placed 3D models (re-embedded, scaled, turned, tinted)     model-generators rules
 *   floor-plan images (textured ground planes at floor height) image-generators
 *   image planes, routes (ribbons), markers + text (anchors)
 *
 * Frame: metres, glTF convention — +X east, +Y up, +Z south, origin at
 * the centroid of the exported shapes (`asset.extras.sgv.origin` holds its
 * lng/lat, so a GIS / CAD pipeline can georeference the file). Each floor
 * (floor-plan image) is a group node; every shape is a child node named
 * after the shape, whose `extras.sgv` holds the same flat record the
 * GeoJSON / JSON / XLSX exports write — id, name, kind, floor, config.
 *
 * Not in the file (by design): the Mapbox basemap, terrain and 3D
 * buildings (tiles, licensing), live data-link values, style-rule tints.
 */

import {
  Document,
  WebIO,
  type Buffer as GltfBuffer,
  type Material,
  type Mesh,
  type Node as GltfNode,
  type Scene,
  type Texture,
} from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from '@gltf-transform/extensions'
import { getBounds, mergeDocuments, prune } from '@gltf-transform/functions'
import { tesselate } from '@turf/turf'
import type { Feature, MultiPolygon, Polygon } from 'geojson'
import type { Grid } from '@/lib/db'
import type { DoorShape } from '@/lib/door/types'
import { buildDoorMesh } from '@/lib/door/mesh'
import {
  exportRecordOf,
  scopedSource,
  zoneSource,
  type ExportFile,
  type ExportOptions,
  type ExportScope,
  type ExportSource,
  type ExportableKind,
} from '@/lib/export-shapes'
import { buildCircleFeatureCollection } from '@/lib/circle-generators'
import { buildGridFromLine } from '@/lib/grid-generators'
import { imageCroppedCorners, getCroppedImageDataUrl, effectiveImageCrop } from '@/lib/image-generators'
import { buildLineWallCollection, rotateLine } from '@/lib/line-generators'
import { placeMesh, type LiftMeshData } from '@/lib/lift-mesh'
import {
  FLAT_SLAB_BASE_M,
  FLAT_SLAB_THICKNESS_M,
  POLYGON_MIN_BASE_M,
  buildPolygonFeatureCollection,
} from '@/lib/polygon-generators'
import { leaningWallMeshes, taperedSolidMeshes } from '@/lib/sloped-mesh'
import { stairMeshes } from '@/lib/stair-generators'
import { urlForImage, rewriteFilesUrlSameOrigin } from '@/lib/binary-store'
import type {
  CircleShape,
  ImagePlaneShape,
  ImageShape,
  LineShape,
  MarkerShape,
  ModelShape,
  PolygonShape,
  RouteShape,
  StairShape,
  TextLabelShape,
} from '@/lib/shapes'

// ---------------------------------------------------------------- public

export interface Export3DOptions {
  scope: ExportScope
  includeConfig?: boolean
  includeTimestamps?: boolean
  filenameStem?: string
  /** `{ modelAssetId: url }` — `useModelUrlMap()`. Without it placed models are left out. */
  modelUrls?: Record<string, string>
  /** Progress text for the dialog ("Walls…", "Models 2/5…"). */
  onProgress?: (message: string) => void
  /** Loads a model asset into a glTF Document. Defaults to a browser fetch; tests inject a file reader. */
  readModel?: (url: string) => Promise<Document>
  /** Loads image bytes. Defaults to fetch (+ canvas re-encode for non PNG/JPEG). */
  readImage?: (shape: ImageShape | ImagePlaneShape, cropped: boolean) => Promise<{ bytes: Uint8Array; mimeType: string } | null>
}

export interface Export3DStats {
  /** Shapes that made it into the file, per kind. */
  shapes: Partial<Record<ExportableKind, number>>
  triangles: number
  /** Human-readable reasons a shape or part was left out. */
  skipped: string[]
}

export interface Export3DResult extends ExportFile {
  stats: Export3DStats
}

export const GLB_MIME = 'model/gltf-binary'

export async function exportModel3D(source: ExportSource, options: Export3DOptions): Promise<Export3DResult> {
  const b = new SceneBuilder(source, options)
  return b.build()
}

/** Browser download of the .glb. */
export async function downloadModel3D(source: ExportSource, options: Export3DOptions): Promise<Export3DResult> {
  const result = await exportModel3D(source, options)
  const url = URL.createObjectURL(result.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = result.filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return result
}

// --------------------------------------------------------------- helpers

const M_PER_DEG_LAT = 111_320
/** A wall / cell / circle is never thinner than this (matches the overlays' 5 cm floor). */
const MIN_THICKNESS_M = 0.05

type V3 = [number, number, number]
type V2 = [number, number]
type RGBA = [number, number, number, number]

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

function hexToLinear(hex: string | undefined, fallback = '#9ca3af'): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? '').trim()) ?? /^#?([0-9a-f]{6})$/i.exec(fallback)!
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)]
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))

/** lng/lat → metres east/north of the model origin. */
class Frame {
  readonly kx: number
  readonly lng0: number
  readonly lat0: number
  constructor(lng0: number, lat0: number) {
    this.lng0 = lng0
    this.lat0 = lat0
    this.kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180)
  }
  en(lng: number, lat: number): V2 {
    return [(lng - this.lng0) * this.kx, (lat - this.lat0) * M_PER_DEG_LAT]
  }
}

/** East/north/up metres → glTF (X east, Y up, Z south). */
const gl = (e: number, n: number, u: number): V3 => [e, u, -n]

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Signed area of a ring in (east, north) — positive = counter-clockwise from above. */
function ringArea(r: ReadonlyArray<V2>): number {
  let a = 0
  for (let i = 0; i < r.length; i++) {
    const p = r[i]
    const q = r[(i + 1) % r.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

function isConvex(r: ReadonlyArray<V2>): boolean {
  let sign = 0
  for (let i = 0; i < r.length; i++) {
    const a = r[i]
    const b = r[(i + 1) % r.length]
    const c = r[(i + 2) % r.length]
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(z) < 1e-12) continue
    const s = z > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** Open ring (no repeated closing vertex, no consecutive duplicates). */
function openRing(ring: ReadonlyArray<ReadonlyArray<number>>, frame: Frame): V2[] {
  const out: V2[] = []
  for (const p of ring) {
    const q = frame.en(p[0], p[1])
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - q[0]) < 1e-6 && Math.abs(last[1] - q[1]) < 1e-6) continue
    out.push(q)
  }
  if (out.length > 1) {
    const f = out[0]
    const l = out[out.length - 1]
    if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) out.pop()
  }
  return out
}

/** Counter-clockwise triangles (east/north metres) covering an outer ring minus holes. */
function triangulate(outer: V2[], holes: V2[][]): Array<[V2, V2, V2]> {
  if (!holes.length && outer.length === 3) return [orient(outer[0], outer[1], outer[2])]
  if (!holes.length && outer.length === 4 && isConvex(outer)) {
    return [orient(outer[0], outer[1], outer[2]), orient(outer[0], outer[2], outer[3])]
  }
  if (!holes.length && isConvex(outer)) {
    const t: Array<[V2, V2, V2]> = []
    for (let i = 1; i < outer.length - 1; i++) t.push(orient(outer[0], outer[i], outer[i + 1]))
    return t
  }
  const close = (r: V2[]) => [...r, r[0]]
  const poly: Feature<Polygon> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [close(outer), ...holes.map(close)] },
  }
  const out: Array<[V2, V2, V2]> = []
  try {
    for (const f of tesselate(poly).features) {
      const r = f.geometry.coordinates[0] as V2[]
      if (r.length >= 4) out.push(orient(r[0], r[1], r[2]))
    }
  } catch {
    /* degenerate ring — leave the cap out, the sides still draw */
  }
  return out
}

function orient(a: V2, b: V2, c: V2): [V2, V2, V2] {
  const z = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  return z >= 0 ? [a, b, c] : [a, c, b]
}

// ---------------------------------------------------------- mesh builder

interface MatSpec {
  /** Linear base colour. */
  rgb: [number, number, number]
  alpha: number
  doubleSided?: boolean
  /** Per-vertex COLOR_0 carries the colour and alpha (glTF multiplies it with the base colour). */
  vertexColors?: boolean
  /** Alpha-blended (translucent) instead of opaque. */
  blend?: boolean
}

const matKey = (m: MatSpec) =>
  [m.rgb.map((c) => c.toFixed(4)).join(','), m.alpha.toFixed(3), m.doubleSided ? 'd' : '', m.vertexColors ? 'v' : '', m.blend ? 'b' : ''].join('|')

/**
 * Welded triangle list; one per material. No normals are written: glTF
 * readers shade a primitive without NORMAL flat, which is what these faceted
 * solids want, and shared vertices keep a 30k-cell grid a few MB.
 */
class MeshAcc {
  pos: number[] = []
  col: number[] = []
  idx: number[] = []
  private seen = new Map<string, number>()
  readonly vertexColors: boolean
  constructor(vertexColors: boolean) {
    this.vertexColors = vertexColors
  }
  get triangles(): number {
    return this.idx.length / 3
  }
  private vertex(p: V3, c?: RGBA): number {
    // Millimetre grid: vertices closer than that are the same corner.
    const key = this.vertexColors && c
      ? `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)},${c[0].toFixed(3)},${c[1].toFixed(3)},${c[2].toFixed(3)},${c[3].toFixed(2)}`
      : `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`
    const hit = this.seen.get(key)
    if (hit !== undefined) return hit
    const i = this.pos.length / 3
    this.pos.push(p[0], p[1], p[2])
    if (this.vertexColors) this.col.push(...(c ?? [1, 1, 1, 1]))
    this.seen.set(key, i)
    return i
  }
  /** Adds a triangle, wound counter-clockwise seen from outside. Degenerate ones are dropped. */
  tri(a: V3, b: V3, c: V3, ca?: RGBA, cb?: RGBA, cc?: RGBA): void {
    const n = cross(sub(b, a), sub(c, a))
    if (!(Math.hypot(n[0], n[1], n[2]) > 1e-9)) return
    const i = this.vertex(a, ca)
    const j = this.vertex(b, cb ?? ca)
    const k = this.vertex(c, cc ?? ca)
    if (i === j || j === k || i === k) return
    this.idx.push(i, j, k)
  }
  quad(a: V3, b: V3, c: V3, d: V3, color?: RGBA): void {
    this.tri(a, b, c, color)
    this.tri(a, c, d, color)
  }
}

/** A set of primitives (one per material) that becomes one glTF mesh. */
class Parts {
  readonly map = new Map<string, { spec: MatSpec; acc: MeshAcc }>()
  get(spec: MatSpec): MeshAcc {
    const k = matKey(spec)
    let e = this.map.get(k)
    if (!e) {
      e = { spec, acc: new MeshAcc(!!spec.vertexColors) }
      this.map.set(k, e)
    }
    return e.acc
  }
  get empty(): boolean {
    for (const e of this.map.values()) if (e.acc.idx.length) return false
    return true
  }
  get triangles(): number {
    let n = 0
    for (const e of this.map.values()) n += e.acc.triangles
    return n
  }
}

/**
 * Extrudes polygons (rings of east/north metres: outer first, then holes)
 * from `base` to `top`: a cap on top, a floor underneath (when asked) and
 * the side faces, all facing outward.
 */
function extrude(acc: MeshAcc, polys: V2[][][], base: number, top: number, bottom = true, color?: RGBA): void {
  for (const rings of polys) {
    const outer = openRing2(rings[0])
    if (outer.length < 3 || Math.abs(ringArea(outer)) < 1e-6) continue
    // Outer rings run counter-clockwise, holes clockwise: then "right of
    // travel" is outward for every ring.
    const o = ringArea(outer) > 0 ? outer : [...outer].reverse()
    const holes = rings
      .slice(1)
      .map(openRing2)
      .filter((h) => h.length >= 3 && Math.abs(ringArea(h)) > 1e-6)
      .map((h) => (ringArea(h) < 0 ? h : [...h].reverse()))
    for (const [a, b, c] of triangulate(o, holes)) {
      acc.tri(gl(a[0], a[1], top), gl(b[0], b[1], top), gl(c[0], c[1], top), color)
      if (bottom) acc.tri(gl(a[0], a[1], base), gl(c[0], c[1], base), gl(b[0], b[1], base), color)
    }
    for (const ring of [o, ...holes]) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]
        const q = ring[(i + 1) % ring.length]
        acc.quad(gl(p[0], p[1], base), gl(q[0], q[1], base), gl(q[0], q[1], top), gl(p[0], p[1], top), color)
      }
    }
  }
}

function openRing2(r: V2[]): V2[] {
  const out = r.filter((p, i) => i === 0 || Math.abs(p[0] - r[i - 1][0]) > 1e-6 || Math.abs(p[1] - r[i - 1][1]) > 1e-6)
  if (out.length > 1) {
    const f = out[0]
    const l = out[out.length - 1]
    if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) out.pop()
  }
  return out
}

// ------------------------------------------------- Mapbox rotation → glTF

type Quat = [number, number, number, number]

function qAxis(axis: V3, rad: number): Quat {
  const s = Math.sin(rad / 2)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)]
}
function qMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

/**
 * Mapbox `model-rotation` ([x, y, z] degrees about east / north / up) as a
 * glTF quaternion. Z is the heading and turns CLOCKWISE seen from above (a
 * model's +Z front faces south at 0); X / Y follow the right-hand rule.
 */
function mapboxRotation(rot: ReadonlyArray<number>, factor = 1): Quat {
  const d = Math.PI / 180
  const qx = qAxis([1, 0, 0], (rot[0] ?? 0) * factor * d)
  const qy = qAxis([0, 0, -1], (rot[1] ?? 0) * factor * d)
  const qz = qAxis([0, 1, 0], -(rot[2] ?? 0) * factor * d)
  return qMul(qz, qMul(qy, qx))
}

// ----------------------------------------------------------- the builder

interface Floor {
  key: string
  name: string
  elevation: number
  node: GltfNode
  id?: number
}

class SceneBuilder {
  private doc = new Document()
  private unlitExt: KHRMaterialsUnlit
  private buffer: GltfBuffer
  private scene: Scene
  private frame!: Frame
  private floors = new Map<string, Floor>()
  private materials = new Map<string, Material>()
  private stats: Export3DStats = { shapes: {}, triangles: 0, skipped: [] }
  private opts: ExportOptions
  private readonly scoped: ExportSource
  private readonly zone: ExportSource
  private readonly images: readonly ImageShape[]
  private readonly hiddenFloors = new Set<number>()
  private readonly floorElevations = new Map<number, number>()

  private source: ExportSource
  private o: Export3DOptions

  constructor(source: ExportSource, o: Export3DOptions) {
    this.source = source
    this.o = o
    this.opts = {
      format: 'json',
      scope: o.scope,
      includeConfig: o.includeConfig ?? true,
      includeTimestamps: o.includeTimestamps ?? false,
    }
    this.unlitExt = this.doc.createExtension(KHRMaterialsUnlit)
    this.buffer = this.doc.createBuffer()
    this.scene = this.doc.createScene('Spatial Grid Vis')
    this.doc.getRoot().setDefaultScene(this.scene)
    this.scoped = scopedSource(source, o.scope)
    this.zone = zoneSource(source, o.scope.zoneId)
    this.images = source.images ?? []
    for (const img of this.images) {
      if (img.id === undefined) continue
      this.floorElevations.set(img.id, img.config.elevation ?? 0)
      if (img.visible === false) this.hiddenFloors.add(img.id)
    }
  }

  private progress(m: string) {
    this.o.onProgress?.(m)
  }

  private skip(msg: string) {
    this.stats.skipped.push(msg)
  }

  private count(kind: ExportableKind, n = 1) {
    this.stats.shapes[kind] = (this.stats.shapes[kind] ?? 0) + n
  }

  /** Shapes on a hidden floor plan are hidden in the editor, so they are left out here too. */
  private shown<T extends { visible?: boolean; floorPlanId?: number }>(s: T): boolean {
    if (s.visible === false) return false
    return s.floorPlanId === undefined || !this.hiddenFloors.has(s.floorPlanId)
  }

  // ---- origin ----------------------------------------------------------

  private pickFrame(): Frame {
    const pts: V2[] = []
    const add = (p: ReadonlyArray<number> | undefined) => {
      if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) pts.push([p[0], p[1]])
    }
    const s = this.scoped
    s.grids?.forEach((g) => (add(g.start), add(g.current)))
    s.polygons?.forEach((p) => add(p.vertices?.[0]))
    s.circles?.forEach((c) => (add(c.center), add(c.start)))
    s.lines?.forEach((l) => add(l.vertices?.[0]))
    s.routes?.forEach((r) => add(r.vertices?.[0]))
    s.markers?.forEach((m) => add(m.position))
    s.images?.forEach((i) => (add(i.start), add(i.current)))
    s.imagePlanes?.forEach((p) => add(p.position))
    s.models?.forEach((m) => add(m.position))
    s.stairs?.forEach((st) => add(st.vertices?.[0]))
    s.doors?.forEach((d) => add(d.vertices?.[0]))
    s.textLabels?.forEach((t) => add(t.position))
    if (!pts.length) return new Frame(0, 0)
    const lng = pts.reduce((a, p) => a + p[0], 0) / pts.length
    const lat = pts.reduce((a, p) => a + p[1], 0) / pts.length
    return new Frame(lng, lat)
  }

  // ---- floors ------------------------------------------------------------

  private floorFor(floorPlanId: number | undefined): Floor {
    const key = floorPlanId === undefined ? 'none' : String(floorPlanId)
    const hit = this.floors.get(key)
    if (hit) return hit
    const img = floorPlanId === undefined ? undefined : this.images.find((i) => i.id === floorPlanId)
    const elevation = img?.config.elevation ?? 0
    const name = img ? img.name || `Floor ${floorPlanId}` : 'Unassigned'
    const node = this.doc.createNode(`Floor · ${name}`).setExtras({
      sgv: { type: 'floor', floorPlanId: floorPlanId ?? null, name, elevationM: elevation },
    })
    this.scene.addChild(node)
    const f: Floor = { key, name, elevation, node, id: floorPlanId }
    this.floors.set(key, f)
    return f
  }

  // ---- materials ---------------------------------------------------------

  private material(spec: MatSpec): Material {
    const k = matKey(spec)
    const hit = this.materials.get(k)
    if (hit) return hit
    const blend = !!spec.blend || (!spec.vertexColors && spec.alpha < 0.999)
    const m = this.doc
      .createMaterial(`mat-${this.materials.size}`)
      .setBaseColorFactor(spec.vertexColors ? [1, 1, 1, 1] : [spec.rgb[0], spec.rgb[1], spec.rgb[2], spec.alpha])
      .setRoughnessFactor(0.85)
      .setMetallicFactor(0)
      .setDoubleSided(!!spec.doubleSided || blend)
      .setAlphaMode(blend ? 'BLEND' : 'OPAQUE')
    this.materials.set(k, m)
    return m
  }

  // ---- node emit ---------------------------------------------------------

  private accessor(array: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>, type: 'VEC3' | 'VEC4' | 'VEC2' | 'SCALAR') {
    return this.doc.createAccessor().setType(type).setArray(array).setBuffer(this.buffer)
  }

  private meshFrom(name: string, parts: Parts): Mesh | null {
    if (parts.empty) return null
    const mesh = this.doc.createMesh(name)
    for (const { spec, acc } of parts.map.values()) {
      if (!acc.idx.length) continue
      const vertexCount = acc.pos.length / 3
      const prim = this.doc
        .createPrimitive()
        .setAttribute('POSITION', this.accessor(new Float32Array(acc.pos), 'VEC3'))
        .setIndices(this.accessor(vertexCount < 65535 ? new Uint16Array(acc.idx) : new Uint32Array(acc.idx), 'SCALAR'))
        .setMaterial(this.material(spec))
      if (spec.vertexColors) {
        // 16-bit normalised RGBA: a quarter of the size of floats, no visible banding.
        prim.setAttribute('COLOR_0', this.accessor(new Uint16Array(acc.col.map((v) => Math.round(clamp01(v) * 65535))), 'VEC4').setNormalized(true))
      }
      mesh.addPrimitive(prim)
      this.stats.triangles += acc.triangles
    }
    return mesh
  }

  private extrasFor(kind: ExportableKind, shape: unknown, extra?: Record<string, unknown>) {
    let record: Record<string, unknown>
    try {
      record = exportRecordOf(kind, shape, this.opts)
    } catch {
      record = { kind }
    }
    return { sgv: { ...record, ...extra } }
  }

  /** Adds a shape's mesh under its floor. Returns the node, or null when there was nothing to draw. */
  private emit(kind: ExportableKind, shape: { id?: number; name?: string; floorPlanId?: number }, parts: Parts, extra?: Record<string, unknown>): GltfNode | null {
    const name = shape.name || `${kind}-${shape.id ?? '?'}`
    const mesh = this.meshFrom(name, parts)
    if (!mesh) return null
    const node = this.doc.createNode(name).setMesh(mesh).setExtras(this.extrasFor(kind, shape, extra))
    this.floorFor(shape.floorPlanId).node.addChild(node)
    this.count(kind)
    return node
  }

  /** An empty node at a point — markers, text labels, anything without a body. */
  private anchor(kind: ExportableKind, shape: { id?: number; name?: string; floorPlanId?: number }, at: V3, name: string, extra?: Record<string, unknown>) {
    const node = this.doc.createNode(name).setTranslation(at).setExtras(this.extrasFor(kind, shape, extra))
    this.floorFor(shape.floorPlanId).node.addChild(node)
    this.count(kind)
  }

  // ---- LiftMeshData (stairs, doors, leaning walls, domes) -----------------

  /**
   * Adds an editor mesh. The editor draws these with culling off and flips
   * each normal toward the camera, so their winding is not consistent: they
   * are written double-sided (readers then shade both faces correctly), and
   * a closed solid (`closed`: domes, cones) is turned outward as well.
   */
  private liftToParts(m: LiftMeshData, parts: Parts, opts: { glass?: boolean; closed?: boolean } = {}): void {
    const [oe, on] = this.frame.en(m.origin[0], m.origin[1])
    const vcount = m.positions.length / 3
    let minA = 1
    for (let i = 0; i < vcount; i++) minA = Math.min(minA, m.colors[i * 4 + 3] ?? 1)
    const acc = parts.get({ rgb: [1, 1, 1], alpha: 1, vertexColors: true, blend: minA < 0.999, doubleSided: true })
    // Colours in the editor are display (sRGB) values; glTF wants linear.
    const col = (v: number): RGBA => [
      srgbToLinear(clamp01(m.colors[v * 4])),
      srgbToLinear(clamp01(m.colors[v * 4 + 1])),
      srgbToLinear(clamp01(m.colors[v * 4 + 2])),
      clamp01(m.colors[v * 4 + 3] ?? 1),
    ]
    const at = (v: number): V3 => gl(oe + m.positions[v * 3], on + m.positions[v * 3 + 1], m.positions[v * 3 + 2])
    let flip = false
    if (opts.closed) {
      // Outward = face normals point away from the mesh's centre.
      let cx = 0, cy = 0, cz = 0
      for (let v = 0; v < vcount; v++) {
        const p = at(v)
        cx += p[0]; cy += p[1]; cz += p[2]
      }
      cx /= vcount; cy /= vcount; cz /= vcount
      let score = 0
      for (let t = 0; t + 2 < vcount; t += 3) {
        const a = at(t), b = at(t + 1), c = at(t + 2)
        const n = cross(sub(b, a), sub(c, a))
        score += n[0] * ((a[0] + b[0] + c[0]) / 3 - cx) + n[1] * ((a[1] + b[1] + c[1]) / 3 - cy) + n[2] * ((a[2] + b[2] + c[2]) / 3 - cz)
      }
      flip = score < 0
    }
    for (let t = 0; t + 2 < vcount; t += 3) {
      if (flip) acc.tri(at(t), at(t + 2), at(t + 1), col(t), col(t + 2), col(t + 1))
      else acc.tri(at(t), at(t + 1), at(t + 2), col(t), col(t + 1), col(t + 2))
    }
  }

  // ======================================================================
  // build
  // ======================================================================

  async build(): Promise<Export3DResult> {
    this.frame = this.pickFrame()
    const s = this.scoped

    this.progress('floors')
    this.addImages(s.images ?? [])
    this.progress('walls')
    this.addWalls(s.lines ?? [])
    this.progress('areas')
    this.addPolygons(s.polygons ?? [])
    this.addCircles(s.circles ?? [])
    this.progress('grids')
    this.addGrids(s.grids ?? [])
    this.progress('stairs')
    this.addStairs(s.stairs ?? [])
    this.addDoors(s.doors ?? [])
    this.addRoutes(s.routes ?? [])
    this.addAnchors(s.markers ?? [], s.textLabels ?? [])
    await this.addFloorTextures(s.images ?? [])
    await this.addImagePlanes(s.imagePlanes ?? [])
    await this.addModels(s.models ?? [])

    // Floors with nothing in them are noise.
    for (const f of this.floors.values()) if (f.node.listChildren().length === 0) f.node.dispose()

    this.doc.getRoot().getAsset().generator = 'Spatial Grid Vis 3D export'
    this.doc.getRoot().setExtras({
      sgv: {
        generator: 'Spatial Grid Vis',
        units: 'metres',
        axes: 'glTF: +X east, +Y up, +Z south',
        origin: { lng: this.frame.lng0, lat: this.frame.lat0, altitudeM: 0 },
        zoneId: this.o.scope.zoneId ?? null,
        exportedAt: new Date().toISOString(),
        counts: this.stats.shapes,
      },
    })

    // Merged models bring their own buffers; a .glb holds exactly one.
    for (const acc of this.doc.getRoot().listAccessors()) acc.setBuffer(this.buffer)
    for (const buf of this.doc.getRoot().listBuffers()) if (buf !== this.buffer) buf.dispose()
    // Models bring animations and rigs along; a static export has no use for them.
    for (const a of this.doc.getRoot().listAnimations()) a.dispose()
    for (const sk of this.doc.getRoot().listSkins()) sk.dispose()
    await this.doc.transform(prune({ keepExtras: true }))

    const io = new WebIO().registerExtensions(ALL_EXTENSIONS)
    const bytes = await io.writeBinary(this.doc)
    const stem = this.o.filenameStem ?? defaultStem(this.stats)
    // Copy into a fresh ArrayBuffer-backed view so Blob accepts it everywhere.
    const blob = new Blob([new Uint8Array(bytes)], { type: GLB_MIME })
    return { blob, filename: `${stem}.glb`, mime: GLB_MIME, stats: this.stats }
  }

  // ---- walls ------------------------------------------------------------

  private addWalls(selected: readonly LineShape[]) {
    if (!selected.length) return
    // Joints and door openings depend on the neighbours, so they are worked
    // out over every wall in the zone, then only the chosen ones are emitted.
    const all = (this.zone.lines ?? []).filter((l) => this.shown(l))
    const want = new Set(selected.filter((l) => this.shown(l)).map((l) => l.id))
    const doorsByLine = new Map<number, DoorShape[]>()
    for (const d of this.source.doors ?? []) {
      const w = d.config.attachedToLineId
      if (w === undefined || !this.shown(d)) continue
      const b = doorsByLine.get(w)
      if (b) b.push(d)
      else doorsByLine.set(w, [d])
    }
    const fc = buildLineWallCollection(all, null, doorsByLine.size ? doorsByLine : null)
    const byLine = new Map<number, LineShape>()
    for (const l of all) if (l.id !== undefined) byLine.set(l.id, l)

    for (const f of fc.features) {
      const p = f.properties
      if (p.lineId === undefined || !want.has(p.lineId) || p.meshed) continue
      const shape = byLine.get(p.lineId)
      if (!shape) continue
      const alpha = clamp01((p.opacity ?? 100) / 100)
      if (alpha <= 0) continue
      const parts = new Parts()
      const acc = parts.get({ rgb: hexToLinear(p.color), alpha })
      const base = p.elevation ?? 0
      extrude(acc, this.polys(f.geometry), base, base + Math.max(p.height ?? 0, MIN_THICKNESS_M))
      this.emit('line', shape, parts, { elevationM: base, heightM: p.height ?? 0 })
    }

    // Leaning walls (roofs, bowls) are meshes in the editor.
    const meshed = fc.features.filter((f) => f.properties.meshed && f.properties.lineId !== undefined && want.has(f.properties.lineId))
    if (meshed.length) {
      const meshes = leaningWallMeshes(all, meshed as never, rotateLine as never)
      for (const m of meshes) {
        const id = Number(m.key.split(':')[1])
        const shape = byLine.get(id)
        if (!shape) continue
        const parts = new Parts()
        this.liftToParts(m, parts)
        this.emit('line', shape, parts, { leaning: true })
      }
    }
  }

  /** GeoJSON (Multi)Polygon → rings in east/north metres. */
  private polys(g: Polygon | MultiPolygon): V2[][][] {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    return polys.map((rings) => rings.map((r) => openRing(r, this.frame)))
  }

  // ---- areas + circles ------------------------------------------------------

  private addPolygons(selected: readonly PolygonShape[]) {
    if (!selected.length) return
    const shapes = selected.filter((p) => this.shown(p))
    const fc = buildPolygonFeatureCollection(shapes)
    const byId = new Map<number, PolygonShape>()
    for (const p of shapes) if (p.id !== undefined) byId.set(p.id, p)
    for (const f of fc.features) {
      const p = f.properties
      if (p.meshed || p.polygonId === undefined) continue
      const shape = byId.get(p.polygonId)
      if (!shape) continue
      const alpha = clamp01(p.opacity / 100)
      if (alpha <= 0) continue
      const h = p.height ?? 0
      const elev = p.elevation ?? 0
      // Same slab rules as map-polygon-overlay (SLAB_BASE / SLAB_TOP).
      const base = h > 0 ? Math.max(elev, POLYGON_MIN_BASE_M) : Math.max(elev, FLAT_SLAB_BASE_M)
      const top = base + (h > 0 ? Math.max(h, MIN_THICKNESS_M) : FLAT_SLAB_THICKNESS_M)
      const parts = new Parts()
      extrude(parts.get({ rgb: hexToLinear(p.color), alpha }), this.polys(f.geometry), base, top)
      this.emit('polygon', shape, parts, { elevationM: elev, heightM: h })
    }
    const meshed = fc.features.filter((f) => f.properties.meshed)
    if (meshed.length) {
      for (const m of taperedSolidMeshes('polygon', shapes, meshed as never)) {
        const shape = byId.get(Number(m.key.split(':')[1]))
        if (!shape) continue
        const parts = new Parts()
        this.liftToParts(m, parts, { closed: true })
        this.emit('polygon', shape, parts, { tapered: true })
      }
    }
  }

  private addCircles(selected: readonly CircleShape[]) {
    if (!selected.length) return
    const shapes = selected.filter((c) => this.shown(c))
    const fc = buildCircleFeatureCollection(shapes)
    const byId = new Map<number, CircleShape>()
    for (const c of shapes) if (c.id !== undefined) byId.set(c.id, c)
    // A circle grid is many features for one shape: gather them per shape.
    const perShape = new Map<number, Parts>()
    for (const f of fc.features) {
      const p = f.properties
      if (p.meshed || p.circleId === undefined) continue
      const alpha = clamp01(p.opacity / 100)
      if (alpha <= 0) continue
      const parts = perShape.get(p.circleId) ?? new Parts()
      perShape.set(p.circleId, parts)
      const elev = p.elevation ?? 0
      extrude(parts.get({ rgb: hexToLinear(p.color), alpha }), this.polys(f.geometry), elev, elev + Math.max(p.height ?? 0, MIN_THICKNESS_M))
    }
    for (const [id, parts] of perShape) {
      const shape = byId.get(id)
      if (shape) this.emit('circle', shape, parts)
    }
    const meshed = fc.features.filter((f) => f.properties.meshed)
    if (meshed.length) {
      for (const m of taperedSolidMeshes('circle', shapes, meshed as never)) {
        const shape = byId.get(Number(m.key.split(':')[1]))
        if (!shape) continue
        const parts = new Parts()
        this.liftToParts(m, parts, { closed: true })
        this.emit('circle', shape, parts, { tapered: true })
      }
    }
  }

  // ---- grids (cells, racks, every level) -------------------------------------

  private addGrids(grids: readonly Grid[]) {
    for (const g of grids) {
      if (!this.shown(g as never) || g.id === undefined) continue
      let cells
      try {
        cells = buildGridFromLine(g.start, g.current, g.config, { committed: true, gridId: g.id }).cells
      } catch (err) {
        this.skip(`grid "${g.name}": ${(err as Error).message}`)
        continue
      }
      const parts = new Parts()
      const ringCache = new Map<unknown, V2[]>()
      for (const cell of cells) {
        const p = cell.properties
        const alpha = clamp01((p.opacity ?? g.config.opacity ?? 100) / 100)
        if (alpha <= 0) continue
        const ring = cell.geometry.coordinates[0]
        let en = ringCache.get(ring)
        if (!en) {
          en = openRing(ring, this.frame)
          ringCache.set(ring, en)
        }
        const elev = p.elevation ?? 0
        const acc = parts.get({ rgb: hexToLinear(p.color ?? g.config.color), alpha })
        // The underside only shows on raised racks.
        extrude(acc, [[en]], elev, elev + Math.max(p.height ?? 0, MIN_THICKNESS_M), elev > 0.02)
      }
      this.emit('grid', g, parts, { cells: cells.length })
    }
  }

  // ---- stairs, escalators, elevators -------------------------------------------

  private addStairs(stairs: readonly StairShape[]) {
    for (const st of stairs) {
      if (!this.shown(st)) continue
      let meshes
      try {
        meshes = stairMeshes(st, this.floorElevations)
      } catch (err) {
        this.skip(`stair "${st.name}": ${(err as Error).message}`)
        continue
      }
      if (!meshes) continue
      const parts = new Parts()
      this.liftToParts(meshes.solid, parts)
      this.liftToParts(meshes.glass, parts, { glass: true })
      this.emit('stair', st, parts)
    }
  }

  // ---- doors -------------------------------------------------------------------

  private addDoors(doors: readonly DoorShape[]) {
    for (const d of doors) {
      if (!this.shown(d)) continue
      const m = buildDoorMesh(d.vertices, d.config)
      if (!m) continue
      const parts = new Parts()
      this.liftToParts(placeMesh(m.solid.positions, m.solid.colors, d.vertices[0], [0, 0], 0, `${d.id}:solid`), parts)
      this.liftToParts(placeMesh(m.glass.positions, m.glass.colors, d.vertices[0], [0, 0], 0, `${d.id}:glass`), parts, { glass: true })
      this.emit('door', d, parts)
    }
  }

  // ---- routes (flat ribbons) -----------------------------------------------------

  private addRoutes(routes: readonly RouteShape[]) {
    for (const r of routes) {
      if (!this.shown(r) || !r.vertices || r.vertices.length < 2) continue
      const cfg = r.config
      const alpha = clamp01((cfg.opacity ?? 100) / 100)
      if (alpha <= 0) continue
      const parts = new Parts()
      const acc = parts.get({ rgb: hexToLinear(cfg.color ?? '#3b82f6'), alpha, doubleSided: true })
      const u = (cfg.elevation ?? 0) + 0.04
      const half = 0.15
      const pts = r.vertices.map((v) => this.frame.en(v[0], v[1]))
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, ay] = pts[i]
        const [bx, by] = pts[i + 1]
        const len = Math.hypot(bx - ax, by - ay)
        if (len < 1e-6) continue
        const nx = (-(by - ay) / len) * half
        const ny = ((bx - ax) / len) * half
        acc.quad(gl(ax - nx, ay - ny, u), gl(bx - nx, by - ny, u), gl(bx + nx, by + ny, u), gl(ax + nx, ay + ny, u))
      }
      this.emit('route', r, parts)
    }
  }

  // ---- markers + text (anchors) --------------------------------------------------

  private addAnchors(markers: readonly MarkerShape[], labels: readonly TextLabelShape[]) {
    for (const m of markers) {
      if (!this.shown(m)) continue
      const [e, n] = this.frame.en(m.position[0], m.position[1])
      this.anchor('marker', m, gl(e, n, m.config.elevation ?? 0), m.name || `marker-${m.id}`)
    }
    for (const t of labels) {
      if (!this.shown(t)) continue
      const [e, n] = this.frame.en(t.position[0], t.position[1])
      this.anchor('text', t, gl(e, n, t.config.elevation ?? 0), t.config.text || t.name || `text-${t.id}`, { text: t.config.text })
    }
  }

  // ---- floor-plan images ---------------------------------------------------------

  private addImages(_images: readonly ImageShape[]) {
    /* Textures load asynchronously — see addFloorTextures. Floors are created here
       so their order follows the images, bottom to top. */
    const sorted = [..._images].filter((i) => this.shown(i)).sort((a, b) => (a.config.elevation ?? 0) - (b.config.elevation ?? 0))
    for (const img of sorted) if (img.id !== undefined) this.floorFor(img.id)
  }

  private async addFloorTextures(images: readonly ImageShape[]) {
    for (const img of images) {
      if (!this.shown(img)) continue
      this.progress(`floor plan ${img.name || img.id}`)
      const corners = imageCroppedCorners(img)
      if (!corners) continue
      const alpha = clamp01((img.config.opacity ?? 100) / 100)
      if (alpha <= 0) continue
      const tex = await this.texture(img, effectiveImageCrop(img.config.crop) !== null)
      if (!tex) {
        this.skip(`floor plan "${img.name}": image could not be loaded`)
        continue
      }
      const elev = (img.config.elevation ?? 0) + 0.005
      const [tl, tr, br, bl] = corners.map(([lng, lat]) => this.frame.en(lng, lat))
      const node = this.texturedQuad(img.name || `image-${img.id}`, [gl(tl[0], tl[1], elev), gl(tr[0], tr[1], elev), gl(br[0], br[1], elev), gl(bl[0], bl[1], elev)], tex, alpha)
      node.setExtras(this.extrasFor('image', img))
      // A floor plan sits in its own floor group.
      this.floorFor(img.id).node.addChild(node)
      this.count('image')
    }
  }

  private async texture(shape: ImageShape | ImagePlaneShape, cropped: boolean): Promise<Texture | null> {
    const read = this.o.readImage ?? defaultReadImage
    const data = await read(shape, cropped).catch(() => null)
    if (!data) return null
    return this.doc.createTexture(shape.name || 'image').setImage(data.bytes).setMimeType(data.mimeType)
  }

  /** a, b, c, d run top-left → top-right → bottom-right → bottom-left of the picture. */
  private texturedQuad(name: string, p: [V3, V3, V3, V3], tex: Texture, alpha: number): GltfNode {
    const pos = new Float32Array(p.flat())
    const n = norm(cross(sub(p[1], p[0]), sub(p[2], p[0])))
    const up = n[1] >= 0 ? n : ([-n[0], -n[1], -n[2]] as V3)
    const nrm = new Float32Array(Array(4).fill(up).flat())
    const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
    // Wound so the front face points up.
    const idx = new Uint32Array(n[1] >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2])
    const mat = this.doc
      .createMaterial(name)
      .setBaseColorTexture(tex)
      .setBaseColorFactor([1, 1, 1, alpha])
      .setDoubleSided(true)
      .setAlphaMode(alpha < 0.999 ? 'BLEND' : 'OPAQUE')
      .setRoughnessFactor(1)
      .setMetallicFactor(0)
    mat.setExtension('KHR_materials_unlit', this.unlitExt.createUnlit())
    const prim = this.doc
      .createPrimitive()
      .setAttribute('POSITION', this.accessor(pos, 'VEC3'))
      .setAttribute('NORMAL', this.accessor(nrm, 'VEC3'))
      .setAttribute('TEXCOORD_0', this.accessor(uv, 'VEC2'))
      .setIndices(this.accessor(idx, 'SCALAR'))
      .setMaterial(mat)
    this.stats.triangles += 2
    return this.doc.createNode(name).setMesh(this.doc.createMesh(name).addPrimitive(prim))
  }

  // ---- image planes ----------------------------------------------------------------

  private async addImagePlanes(planes: readonly ImagePlaneShape[]) {
    for (const pl of planes) {
      if (!this.shown(pl)) continue
      const tex = await this.texture(pl, false)
      if (!tex) {
        this.skip(`image plane "${pl.name}": image could not be loaded`)
        continue
      }
      const w = Math.max(pl.config.width, 0.01) / 2
      const h = Math.max(pl.config.height, 0.01) / 2
      // Authored flat in the XZ plane, top of the picture to the north (-Z).
      const node = this.texturedQuad(
        pl.name || `image-plane-${pl.id}`,
        [[-w, 0, -h], [w, 0, -h], [w, 0, h], [-w, 0, h]],
        tex,
        clamp01(pl.config.opacity / 100),
      )
      const [e, n] = this.frame.en(pl.position[0], pl.position[1])
      node.setTranslation(gl(e, n, pl.config.elevation ?? 0)).setRotation(mapboxRotation(pl.config.rotation ?? [0, 0, 0]))
      node.setExtras(this.extrasFor('imagePlane', pl))
      this.floorFor(pl.floorPlanId).node.addChild(node)
      this.count('imagePlane')
    }
  }

  // ---- placed 3D models --------------------------------------------------------------

  private templates = new Map<string, { root: GltfNode; min: V3; max: V3 } | null>()

  private async template(url: string): Promise<{ root: GltfNode; min: V3; max: V3 } | null> {
    if (this.templates.has(url)) return this.templates.get(url) ?? null
    let tpl: { root: GltfNode; min: V3; max: V3 } | null = null
    try {
      const read = this.o.readModel ?? defaultReadModel
      const src = await read(url)
      const map = mergeDocuments(this.doc, src)
      const root = this.doc.createNode('model-template')
      for (const sc of src.getRoot().listScenes()) {
        const copy = map.get(sc) as Scene | undefined
        if (!copy) continue
        for (const child of copy.listChildren()) root.addChild(child)
        copy.dispose()
      }
      const b = getBounds(root)
      tpl = { root, min: b.min as V3, max: b.max as V3 }
    } catch (err) {
      this.skip(`model ${url}: ${(err as Error).message}`)
    }
    this.templates.set(url, tpl)
    return tpl
  }

  private cloneTree(n: GltfNode, tint: { rgb: [number, number, number]; mix: number; alpha: number } | null, meshCache: Map<Mesh, Mesh>): GltfNode {
    const c = this.doc
      .createNode(n.getName())
      .setTranslation(n.getTranslation())
      .setRotation(n.getRotation())
      .setScale(n.getScale())
    const mesh = n.getMesh()
    if (mesh) c.setMesh(tint ? this.tintMesh(mesh, tint, meshCache) : mesh)
    for (const child of n.listChildren()) c.addChild(this.cloneTree(child, tint, meshCache))
    return c
  }

  private tintMesh(mesh: Mesh, tint: { rgb: [number, number, number]; mix: number; alpha: number }, cache: Map<Mesh, Mesh>): Mesh {
    const hit = cache.get(mesh)
    if (hit) return hit
    const copy = this.doc.createMesh(mesh.getName())
    for (const prim of mesh.listPrimitives()) {
      const p = prim.clone()
      const m = prim.getMaterial()
      const nm = m ? m.clone() : this.doc.createMaterial('tinted')
      const base = nm.getBaseColorFactor()
      const k = clamp01(tint.mix)
      nm.setBaseColorFactor([
        base[0] + (tint.rgb[0] - base[0]) * k,
        base[1] + (tint.rgb[1] - base[1]) * k,
        base[2] + (tint.rgb[2] - base[2]) * k,
        base[3] * tint.alpha,
      ])
      if (tint.alpha < 0.999) nm.setAlphaMode('BLEND')
      p.setMaterial(nm)
      copy.addPrimitive(p)
    }
    cache.set(mesh, copy)
    return copy
  }

  private async addModels(models: readonly ModelShape[]) {
    const urls = this.o.modelUrls ?? {}
    let i = 0
    for (const m of models) {
      i++
      if (!this.shown(m)) continue
      const assetId = m.config.modelAssetId
      const url = assetId ? urls[assetId] : undefined
      if (!url) {
        this.skip(`model "${m.name}": no 3D asset${assetId ? ` (${assetId})` : ''}`)
        continue
      }
      this.progress(`models ${i}/${models.length}`)
      const tpl = await this.template(toAbsolute(url))
      if (!tpl) continue
      const c = m.config
      const tinted = (c.colorMix ?? 0) > 0 || (c.opacity ?? 100) < 100 || c.active === false
      const alpha = clamp01((c.active === false ? Math.min(c.opacity, 30) : c.opacity) / 100)
      const inst = this.cloneTree(
        tpl.root,
        tinted ? { rgb: hexToLinear(c.color), mix: clamp01(c.colorMix ?? 0), alpha } : null,
        new Map(),
      )
      // Mapbox keeps the model's bbox centre on the pin and its bottom on
      // `elevation`: p' = scale · (p − [cx, minY, cz]) (model-generators).
      const cx = (tpl.min[0] + tpl.max[0]) / 2
      const cz = (tpl.min[2] + tpl.max[2]) / 2
      const offset = this.doc.createNode('offset').setTranslation([-cx, -tpl.min[1], -cz]).addChild(inst)
      const [sx, sn, su] = c.scale ?? [1, 1, 1]
      const [e, n] = this.frame.en(m.position[0], m.position[1])
      const node = this.doc
        .createNode(m.name || `model-${m.id}`)
        .setTranslation(gl(e, n, c.elevation ?? 0))
        // Mapbox adds the source `orientation` and the layer `model-rotation`,
        // both fed `config.rotation`: the heading on screen is twice the
        // stored one (docs/pitfalls-frontend.md → "Model rotation is applied twice").
        .setRotation(mapboxRotation(c.rotation ?? [0, 0, 0], 2))
        // Mapbox scale is [east, north, up] = glTF [x, z, y].
        .setScale([sx, su, sn])
        .setExtras(this.extrasFor('model', m, { modelAssetId: assetId }))
        .addChild(offset)
      this.floorFor(m.floorPlanId).node.addChild(node)
      this.count('model')
      for (const mesh of collectMeshes(node)) this.stats.triangles += triCount(mesh)
    }
    // The template roots stay detached: they only feed the clones.
    for (const t of this.templates.values()) if (t) disposeTree(t.root)
  }
}

function disposeTree(n: GltfNode): void {
  for (const c of n.listChildren()) disposeTree(c)
  n.dispose()
}

function collectMeshes(n: GltfNode, out: Mesh[] = []): Mesh[] {
  const m = n.getMesh()
  if (m) out.push(m)
  for (const c of n.listChildren()) collectMeshes(c, out)
  return out
}

function triCount(m: Mesh): number {
  let t = 0
  for (const p of m.listPrimitives()) t += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3
  return t
}

function defaultStem(stats: Export3DStats): string {
  const total = Object.values(stats.shapes).reduce((a, b) => a + (b ?? 0), 0)
  return `sgv-3d-${total}shapes`
}

function toAbsolute(url: string): string {
  if (/^(https?:|blob:|data:)/i.test(url)) return url
  return new URL(url, typeof location !== 'undefined' ? location.origin : 'http://localhost').toString()
}

// ------------------------------------------------------------- default IO

async function defaultReadModel(url: string): Promise<Document> {
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS)
  return io.read(url)
}

async function defaultReadImage(
  shape: ImageShape | ImagePlaneShape,
  cropped: boolean,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const isFloor = 'start' in shape
  let url = isFloor ? urlForImage(shape as ImageShape) : rewriteFilesUrlSameOrigin((shape as ImagePlaneShape).imageUrl)
  if (!url) return null
  if (isFloor && cropped) {
    const crop = (shape as ImageShape).config.crop
    const cut = crop ? await getCroppedImageDataUrl(url, crop) : null
    if (cut) url = cut
  }
  const resp = await fetch(url, { credentials: 'same-origin' })
  if (!resp.ok) return null
  const blob = await resp.blob()
  const type = blob.type || shape.mimeType || ''
  if (type === 'image/png' || type === 'image/jpeg') return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: type }
  // WebP, GIF, SVG, … → glTF only takes PNG / JPEG: re-encode through a canvas.
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')?.drawImage(bmp, 0, 0)
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!png) return null
  return { bytes: new Uint8Array(await png.arrayBuffer()), mimeType: 'image/png' }
}
