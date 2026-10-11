/**
 * Tiny GLB parser. Two jobs:
 *
 *  1. `readGlbBounds(blob)` — extract the model's world-local AABB so the
 *     renderer can compensate Mapbox's origin-anchored `model-scale`
 *     (see comment block below).
 *  2. `parseGlbInspector(blob)` — extract a flat "schema" describing
 *     what's *inside* the GLB: named materials, named nodes, animation
 *     clips, and root/material/mesh/node `extras`. The model editor uses
 *     this to render per-GLB dynamic controls — material colour pickers,
 *     node visibility toggles, animation clip dropdowns. The Mapbox
 *     `type: 'model'` source consumes the same names when it applies
 *     `materialOverrides` and `nodeOverrides`.
 *
 * Why bounds matter: Mapbox's `model-scale` paint property scales the
 * model around its *local glTF origin* (0,0,0 in the source file), not
 * around the placement point on the map. Most glTF assets — especially
 * the low-poly imports our users upload — don't sit centered on (0,0,0);
 * their visual centre is offset by half-bounds. So as the user dials
 * scale up or down, the rendered model drifts. To keep the visual centre
 * anchored at the user's chosen point we need to know the model's bbox
 * centre in meters. The renderer then sets
 * `model-translation = -center * (scale - 1)` so the centre stays put.
 *
 * We parse the binary container directly (no extra dep). Walks the
 * default scene's node tree applying each node's TRS transform so the
 * bbox is in world-local meters, which is what Mapbox's translation
 * expects.
 */

export interface ModelBounds {
  /** Axis-aligned bounding box, in meters of the glTF's local space. */
  min: [number, number, number]
  max: [number, number, number]
  /** Convenience midpoint — what the renderer uses for scale-anchor compensation. */
  center: [number, number, number]
}

// ---------------------------------------------------------------------------
// Inspector schema — what's "inside" a GLB
// ---------------------------------------------------------------------------

/**
 * Per-material entry the editor renders a control card for. Names follow
 * what's actually in the glTF JSON; Mapbox's `materialOverrides` map is
 * keyed by the same name.
 */
export interface ModelMaterialInfo {
  /** Stable id we use to key overrides — `index` is unique even for unnamed materials. */
  index: number
  /** Material name from the glTF (e.g. "BodyPaint", "Glass"). Falls back to `material-${index}`. */
  name: string
  /** Source `baseColorFactor` as a hex string. Optional — assets without PBR have none. */
  baseColor?: string
  /** Source `emissiveFactor` as a hex string. */
  emissive?: string
  /** PBR metallic 0..1, if present. */
  metallic?: number
  /** PBR roughness 0..1, if present. */
  roughness?: number
  /** Source baseColorFactor alpha 0..1 (separate from `baseColor` rgb). */
  alpha?: number
  /** `material.extras` if any — surfaced as read-only metadata. */
  extras?: Record<string, unknown>
}

/**
 * Per-node entry the editor renders a control card for. We only surface
 * nodes that have a `name` in the glTF JSON — anonymous nodes wouldn't
 * be addressable by `nodeOverrides` anyway.
 */
export interface ModelNodeInfo {
  index: number
  name: string
  /** True when this node carries a mesh — useful for "hide this part" UI. */
  hasMesh: boolean
  /** True when this node sits under an animation channel. */
  animated: boolean
  /** `node.extras` if any. */
  extras?: Record<string, unknown>
}

/**
 * Per-clip entry. glTF animations don't carry a clip duration directly —
 * we approximate by taking the largest `input` accessor timestamp across
 * the clip's sampler channels (the model layer doesn't actually use the
 * duration; it's metadata for the editor only).
 */
export interface ModelAnimationInfo {
  index: number
  name: string
  /** Approx duration in seconds. May be undefined if accessor maxes aren't set. */
  duration?: number
}

/**
 * Full inspector schema for one GLB. Anything missing means "the GLB
 * didn't declare it" — the editor renders only the sections that have
 * entries, and the overlay only sends overrides for entries that exist.
 */
export interface ModelInspector {
  bounds: ModelBounds | null
  /** Materials in declaration order. */
  materials: ModelMaterialInfo[]
  /** Named nodes in declaration order. */
  nodes: ModelNodeInfo[]
  /** Animation clips in declaration order. */
  animations: ModelAnimationInfo[]
  /** Asset / scene / root extras merged into one flat record. */
  extras: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a GLB blob and return its world-local AABB. Returns `null` when
 * the file isn't a valid GLB or contains no positionable geometry.
 *
 * The result is approximate when accessors omit `min`/`max` (rare for
 * well-formed exports). For animated models the bbox is the rest-pose
 * one — accurate enough for centering.
 */
export async function readGlbBounds(blob: Blob): Promise<ModelBounds | null> {
  const inspector = await parseGlbInspector(blob)
  return inspector?.bounds ?? null
}

/**
 * Parse a GLB blob into a flat `ModelInspector`. Returns `null` when the
 * file isn't a valid GLB. Always safe to call — caller doesn't need to
 * check magic / version itself.
 *
 * Implementation lazily reads both glTF JSON and computes geometry
 * bounds in a single pass over the node tree.
 */
export async function parseGlbInspector(blob: Blob): Promise<ModelInspector | null> {
  let buf: ArrayBuffer
  try {
    buf = await blob.arrayBuffer()
  } catch {
    return null
  }
  if (buf.byteLength < 20) return null
  const dv = new DataView(buf)

  // GLB header: magic (4), version (4), length (4)
  const magic = dv.getUint32(0, true)
  if (magic !== 0x46546c67) return null // 'glTF'
  const version = dv.getUint32(4, true)
  if (version !== 2) return null

  // First chunk MUST be JSON in glTF 2.0.
  const chunk1Length = dv.getUint32(12, true)
  const chunk1Type = dv.getUint32(16, true)
  if (chunk1Type !== 0x4e4f534a) return null // 'JSON'
  if (20 + chunk1Length > buf.byteLength) return null

  let json: GltfJson
  try {
    const bytes = new Uint8Array(buf, 20, chunk1Length)
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }

  const bounds = computeBounds(json)
  const materials = extractMaterials(json)
  const animations = extractAnimations(json)
  const animatedNodeIndices = collectAnimatedNodes(json)
  const nodes = extractNodes(json, animatedNodeIndices)
  const extras = mergeRootExtras(json)

  return { bounds, materials, nodes, animations, extras }
}

// ---------------------------------------------------------------------------
// Inspector extraction
// ---------------------------------------------------------------------------

function extractMaterials(json: GltfJson): ModelMaterialInfo[] {
  const out: ModelMaterialInfo[] = []
  const mats = json.materials ?? []
  for (let i = 0; i < mats.length; i++) {
    const m = mats[i]
    const pbr = m.pbrMetallicRoughness ?? {}
    const baseFactor = pbr.baseColorFactor
    const emissiveFactor = m.emissiveFactor
    const entry: ModelMaterialInfo = {
      index: i,
      name: m.name && m.name.length > 0 ? m.name : `material-${i}`,
    }
    if (Array.isArray(baseFactor) && baseFactor.length >= 3) {
      entry.baseColor = rgbToHex(baseFactor[0], baseFactor[1], baseFactor[2])
      if (typeof baseFactor[3] === 'number') entry.alpha = clamp01(baseFactor[3])
    }
    if (Array.isArray(emissiveFactor) && emissiveFactor.length >= 3) {
      entry.emissive = rgbToHex(emissiveFactor[0], emissiveFactor[1], emissiveFactor[2])
    }
    if (typeof pbr.metallicFactor === 'number') entry.metallic = clamp01(pbr.metallicFactor)
    if (typeof pbr.roughnessFactor === 'number') entry.roughness = clamp01(pbr.roughnessFactor)
    if (m.extras && typeof m.extras === 'object') entry.extras = m.extras
    out.push(entry)
  }
  return out
}

function extractNodes(
  json: GltfJson,
  animatedIndices: Set<number>,
): ModelNodeInfo[] {
  const out: ModelNodeInfo[] = []
  const nodes = json.nodes ?? []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n.name || n.name.length === 0) continue
    const entry: ModelNodeInfo = {
      index: i,
      name: n.name,
      hasMesh: typeof n.mesh === 'number',
      animated: animatedIndices.has(i),
    }
    if (n.extras && typeof n.extras === 'object') entry.extras = n.extras
    out.push(entry)
  }
  return out
}

function collectAnimatedNodes(json: GltfJson): Set<number> {
  const out = new Set<number>()
  for (const a of json.animations ?? []) {
    for (const ch of a.channels ?? []) {
      const t = ch.target?.node
      if (typeof t === 'number') out.add(t)
    }
  }
  return out
}

function extractAnimations(json: GltfJson): ModelAnimationInfo[] {
  const out: ModelAnimationInfo[] = []
  const anims = json.animations ?? []
  for (let i = 0; i < anims.length; i++) {
    const a = anims[i]
    const entry: ModelAnimationInfo = {
      index: i,
      name: a.name && a.name.length > 0 ? a.name : `animation-${i}`,
    }
    // Duration = max `input` accessor.max across this clip's samplers.
    let maxT: number | undefined
    for (const s of a.samplers ?? []) {
      const acc = json.accessors?.[s.input]
      const t = acc?.max?.[0]
      if (typeof t === 'number' && (maxT === undefined || t > maxT)) maxT = t
    }
    if (typeof maxT === 'number') entry.duration = maxT
    out.push(entry)
  }
  return out
}

function mergeRootExtras(json: GltfJson): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (json.asset?.extras && typeof json.asset.extras === 'object') {
    Object.assign(out, json.asset.extras)
  }
  if (json.extras && typeof json.extras === 'object') {
    Object.assign(out, json.extras)
  }
  const scene = json.scenes?.[json.scene ?? 0]
  if (scene?.extras && typeof scene.extras === 'object') {
    Object.assign(out, scene.extras)
  }
  return out
}

// ---------------------------------------------------------------------------
// Bounds (same logic as before, factored into a helper)
// ---------------------------------------------------------------------------

function computeBounds(json: GltfJson): ModelBounds | null {
  const scene = json.scenes?.[json.scene ?? 0]
  if (!scene || !Array.isArray(scene.nodes)) return null

  let xmin = Infinity, ymin = Infinity, zmin = Infinity
  let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity
  let any = false

  const visit = (nodeIndex: number, parent: number[]) => {
    const node = json.nodes?.[nodeIndex]
    if (!node) return
    const local = nodeMatrix(node)
    const world = multiplyMatrices(parent, local)
    if (typeof node.mesh === 'number') {
      const mesh = json.meshes?.[node.mesh]
      if (mesh) {
        for (const prim of mesh.primitives ?? []) {
          const posIdx = prim.attributes?.POSITION
          if (typeof posIdx !== 'number') continue
          const accessor = json.accessors?.[posIdx]
          const lo = accessor?.min
          const hi = accessor?.max
          if (!isVec3(lo) || !isVec3(hi)) continue
          for (const corner of corners(lo, hi)) {
            const [wx, wy, wz] = transformPoint(world, corner)
            if (wx < xmin) xmin = wx
            if (wy < ymin) ymin = wy
            if (wz < zmin) zmin = wz
            if (wx > xmax) xmax = wx
            if (wy > ymax) ymax = wy
            if (wz > zmax) zmax = wz
            any = true
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world)
  }

  for (const root of scene.nodes) visit(root, identityMatrix())

  if (!any) return null
  return {
    min: [xmin, ymin, zmin],
    max: [xmax, ymax, zmax],
    center: [(xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2],
  }
}

// ---------------------------------------------------------------- matrices

function identityMatrix(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/**
 * Build a column-major 4x4 transform for a glTF node. glTF stores
 * either an explicit `matrix` or `translation`/`rotation`/`scale`
 * (TRS); we support both, defaulting any missing piece to identity.
 */
function nodeMatrix(node: GltfNode): number[] {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return [...node.matrix]
  }
  const t = node.translation ?? [0, 0, 0]
  const r = node.rotation ?? [0, 0, 0, 1] // quaternion (x,y,z,w)
  const s = node.scale ?? [1, 1, 1]

  // Build scale matrix
  const sx = s[0], sy = s[1], sz = s[2]
  // Quaternion → rotation matrix (column-major)
  const x = r[0], y = r[1], z = r[2], w = r[3]
  const xx = x * x, yy = y * y, zz = z * z
  const xy = x * y, xz = x * z, yz = y * z
  const wx = w * x, wy = w * y, wz = w * z
  const m00 = (1 - 2 * (yy + zz)) * sx
  const m01 = 2 * (xy + wz) * sx
  const m02 = 2 * (xz - wy) * sx
  const m10 = 2 * (xy - wz) * sy
  const m11 = (1 - 2 * (xx + zz)) * sy
  const m12 = 2 * (yz + wx) * sy
  const m20 = 2 * (xz + wy) * sz
  const m21 = 2 * (yz - wx) * sz
  const m22 = (1 - 2 * (xx + yy)) * sz
  // Column-major 4x4 with translation in the last column
  return [
    m00, m01, m02, 0,
    m10, m11, m12, 0,
    m20, m21, m22, 0,
    t[0], t[1], t[2], 1,
  ]
}

function multiplyMatrices(a: number[], b: number[]): number[] {
  // Column-major 4x4 multiplication: result = a * b
  const out = new Array<number>(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        sum += a[row + k * 4] * b[k + col * 4]
      }
      out[row + col * 4] = sum
    }
  }
  return out
}

function transformPoint(m: number[], p: [number, number, number]): [number, number, number] {
  const [x, y, z] = p
  const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
  const wy = m[1] * x + m[5] * y + m[9] * z + m[13]
  const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
  return [wx, wy, wz]
}

function corners(
  lo: [number, number, number],
  hi: [number, number, number],
): Array<[number, number, number]> {
  return [
    [lo[0], lo[1], lo[2]],
    [hi[0], lo[1], lo[2]],
    [lo[0], hi[1], lo[2]],
    [hi[0], hi[1], lo[2]],
    [lo[0], lo[1], hi[2]],
    [hi[0], lo[1], hi[2]],
    [lo[0], hi[1], hi[2]],
    [hi[0], hi[1], hi[2]],
  ]
}

function isVec3(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    typeof v[2] === 'number'
  )
}

// ---------------------------------------------------------------- helpers

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) =>
    Math.max(0, Math.min(255, Math.round(clamp01(v) * 255)))
  const hex = (v: number) => toByte(v).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

// ---------------------------------------------------------------- glTF types

interface GltfJson {
  asset?: { extras?: Record<string, unknown> }
  extras?: Record<string, unknown>
  scene?: number
  scenes?: GltfScene[]
  nodes?: GltfNode[]
  meshes?: GltfMesh[]
  accessors?: GltfAccessor[]
  materials?: GltfMaterial[]
  animations?: GltfAnimation[]
}

interface GltfScene {
  nodes?: number[]
  extras?: Record<string, unknown>
}

interface GltfNode {
  name?: string
  mesh?: number
  children?: number[]
  matrix?: number[]
  translation?: [number, number, number]
  rotation?: [number, number, number, number]
  scale?: [number, number, number]
  extras?: Record<string, unknown>
}

interface GltfMesh {
  primitives?: Array<{
    attributes?: Record<string, number>
  }>
}

interface GltfAccessor {
  min?: number[]
  max?: number[]
}

interface GltfMaterial {
  name?: string
  pbrMetallicRoughness?: {
    baseColorFactor?: number[]
    metallicFactor?: number
    roughnessFactor?: number
  }
  emissiveFactor?: number[]
  extras?: Record<string, unknown>
}

interface GltfAnimation {
  name?: string
  channels?: Array<{ target?: { node?: number } }>
  samplers?: Array<{ input: number; output: number }>
}
