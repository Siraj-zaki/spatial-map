/**
 * Image-plane generator helpers — wraps a raster image into a textured
 * unit-square GLB so Mapbox's `model` layer can render it with full 3D
 * transforms (elevation + X/Y/Z rotation + scale).
 *
 * Why a GLB? Mapbox's `raster` source (what the floor `image-overlay` uses)
 * is hardcoded to lie flat on the ground at a fixed elevation — no
 * rotation in 3D, no tilting. The `model` layer, on the other hand, accepts
 * `model-rotation` (per-axis degrees), `model-scale`, and `model-
 * translation` (z is elevation), which is exactly the surface area we need
 * for "image planted in 3D space".
 *
 * GLB synthesis:
 *   We hand-write the binary glTF rather than going through a library
 *   (`@gltf-transform/core`) because Mapbox is **very strict** about
 *   chunk alignment and buffer offsets — see AGENTS.md's "GLB models" note.
 *   The library produced GLBs Mapbox rejected with "offset is out of
 *   bounds". A hand-crafted GLB with explicit 4-byte alignment on every
 *   chunk and bufferView passes cleanly.
 *
 * Structure of the synthesised GLB:
 *   - JSON chunk: scene → node → mesh → primitive (4 verts, 2 tris,
 *     POSITION/NORMAL/TEXCOORD_0/indices, single material with
 *     baseColorTexture).
 *   - BIN chunk: positions(48) | normals(48) | uvs(32) | indices(12+4 pad)
 *     | image-bytes (4-byte padded).
 *
 * Width / height come from the layer paint via `model-scale =
 * [width, 1, height]`, so the plane GLB is **shape-independent** and can
 * be cached per image. Resizing never regenerates the GLB; only swapping
 * the image does.
 */

import type {
  ImagePlaneShape,
  ImagePlaneShapeConfig,
} from './shapes'
import { rewriteFilesUrlSameOrigin } from './binary-store'

// ---------------------------------------------------------------------------
// Source-entry + layer-paint shapes (mirror `model-generators.ts`)
// ---------------------------------------------------------------------------

export interface ImagePlaneSourceSpec {
  uri: string
  position: [number, number] | [number, number, number]
  orientation?: [number, number, number]
  [key: string]: unknown
}

export interface ImagePlaneEntry {
  /** Key in the model source's `models` map. We use `imageplane-<id>`. */
  key: string
  spec: ImagePlaneSourceSpec
}

export interface ImagePlaneLayerPaint {
  'model-rotation': [number, number, number]
  'model-scale': [number, number, number]
  'model-translation': [number, number, number]
  'model-color'?: string
  'model-color-mix-intensity'?: number
  'model-opacity'?: number
}

// ---------------------------------------------------------------------------
// Source spec + layer paint builders
// ---------------------------------------------------------------------------

export function buildImagePlaneEntry(
  shape: ImagePlaneShape,
  glbUri: string,
): ImagePlaneEntry | null {
  if (shape.id === undefined) return null
  return {
    key: `imageplane-${shape.id}`,
    spec: {
      uri: glbUri,
      position: shape.position,
      orientation: shape.config.rotation,
    },
  }
}

export function buildImagePlaneLayerPaint(
  cfg: ImagePlaneShapeConfig,
): ImagePlaneLayerPaint {
  // Mapbox's `model` layer applies `model-translation` and `model-scale`
  // in **world coordinates** (Z-up): index [0] = east-west,
  // [1] = north-south, [2] = up. This is confirmed by `model-generators.ts`
  // which feeds `cfg.elevation` into `model-translation[2]`.
  //
  // The GLB itself is authored in standard glTF Y-up; Mapbox does the
  // Y-up → Z-up remap internally before applying these transforms.
  // We model the plane in the GLB's **XZ** plane (Y = 0) so that after
  // the remap it lies flat in the world's X-Y plane — i.e. flat on the
  // ground at Z = 0.
  return {
    'model-rotation': cfg.rotation,
    'model-scale': [Math.max(cfg.width, 0.01), Math.max(cfg.height, 0.01), 1],
    'model-translation': [0, 0, cfg.elevation],
    'model-color': cfg.color,
    'model-color-mix-intensity': clamp01(cfg.colorMix),
    'model-opacity': clamp01(cfg.opacity / 100),
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
}

// ---------------------------------------------------------------------------
// GLB synthesis — hand-crafted for Mapbox strictness
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67 // 'glTF'
const GLB_VERSION = 2
const CHUNK_TYPE_JSON = 0x4e4f534a // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942 // 'BIN\0'

/** Round `n` up to the next multiple of `align`. */
function alignUp(n: number, align: number): number {
  return (n + (align - 1)) & ~(align - 1)
}

/**
 * Fetch the image bytes from a URL and wrap them into a self-contained
 * textured-plane GLB. The plane is a unit square in the XZ plane (Y up,
 * glTF convention).
 *
 * The GLB has exactly one BIN chunk, which holds:
 *   [0   .. 48 )  POSITION  — 4 verts × 3 floats × 4 bytes
 *   [48  .. 96 )  NORMAL    — 4 verts × 3 floats × 4 bytes
 *   [96  .. 128)  TEXCOORD_0 — 4 verts × 2 floats × 4 bytes
 *   [128 .. 140)  INDICES   — 6 ushort × 2 bytes (12 bytes)
 *   [140 .. 144)  padding   — to 4-byte boundary for the next bufferView
 *   [144 .. 144+N) IMAGE    — encoded image bytes
 *   [..  .. end)  padding   — to 4-byte boundary for the chunk
 *
 * MIME type defaults to `image/png`. If a user uploads something other
 * than PNG/JPEG, Mapbox may refuse to decode it.
 */
export async function createImagePlaneGlb(
  imageUrl: string,
  mimeType?: string,
): Promise<Uint8Array> {
  const fetchUrl = rewriteFilesUrlSameOrigin(imageUrl)
  const resp = await fetch(fetchUrl, { credentials: 'same-origin' })
  if (!resp.ok) {
    throw new Error(`image-plane: failed to fetch ${fetchUrl} (${resp.status})`)
  }
  const imageBytes = new Uint8Array(await resp.arrayBuffer())
  const inferredMime =
    mimeType && mimeType.length > 0 ? mimeType : guessMimeFromBytes(imageBytes)

  // ---------- Geometry --------------------------------------------------
  // The GLB is authored in standard glTF **Y-up** convention. Mapbox's
  // model loader remaps glTF Y-up → world Z-up automatically before
  // applying `model-scale` / `model-translation` (which operate in
  // **world Z-up** coords).
  //
  // To get a plane that lies FLAT on the ground in the world, we author
  // it in the GLB's **XZ plane** (Y = 0, normal +Y). After Mapbox's
  // Y→Z remap, that XZ plane becomes the world X-Y plane (horizontal at
  // Z = 0), with the +Y normal becoming +Z (up). `model-scale[0]` then
  // stretches it east-west, `model-scale[1]` stretches north-south.
  //
  //   v0 (-X, 0, -Z) ────── v1 (+X, 0, -Z)
  //          │                    │
  //          │       Plane        │
  //          │                    │
  //   v3 (-X, 0, +Z) ────── v2 (+X, 0, +Z)
  //
  // After Mapbox's remap, GLB-X stays world east, GLB-Z becomes
  // world-north (since +Z in glTF Y-up maps to "forward / north").
  //
  // UVs put the image's top edge at v0/v1 (the GLB-Z = -Z side) so the
  // image's top maps to world-north when viewed from above. Winding is
  // CCW from above so the geometric normal points +Y (up in GLB =
  // world up after remap). doubleSided=true also renders the back.
  // prettier-ignore
  const positions = new Float32Array([
    -0.5, 0, -0.5,   // v0 north-west (after remap)
     0.5, 0, -0.5,   // v1 north-east
     0.5, 0,  0.5,   // v2 south-east
    -0.5, 0,  0.5,   // v3 south-west
  ])
  // prettier-ignore
  const normals = new Float32Array([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ])
  // prettier-ignore
  const uvs = new Float32Array([
    0, 0,   // v0 north-west → top-left of texture
    1, 0,   // v1 north-east → top-right
    1, 1,   // v2 south-east → bottom-right
    0, 1,   // v3 south-west → bottom-left
  ])
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3])

  // ---------- Buffer layout --------------------------------------------
  const POSITIONS_OFFSET = 0
  const POSITIONS_LENGTH = positions.byteLength // 48
  const NORMALS_OFFSET = POSITIONS_OFFSET + POSITIONS_LENGTH
  const NORMALS_LENGTH = normals.byteLength // 48
  const UVS_OFFSET = NORMALS_OFFSET + NORMALS_LENGTH
  const UVS_LENGTH = uvs.byteLength // 32
  const INDICES_OFFSET = UVS_OFFSET + UVS_LENGTH
  const INDICES_LENGTH = indices.byteLength // 12
  // Pad to 4-byte boundary so the image bufferView starts aligned.
  const IMAGE_OFFSET = alignUp(INDICES_OFFSET + INDICES_LENGTH, 4)
  const IMAGE_LENGTH = imageBytes.byteLength
  const BIN_DATA_LENGTH = IMAGE_OFFSET + IMAGE_LENGTH
  // BIN chunk itself padded to 4-byte boundary.
  const BIN_CHUNK_LENGTH = alignUp(BIN_DATA_LENGTH, 4)

  // ---------- glTF JSON -------------------------------------------------
  const gltf = {
    asset: { version: '2.0', generator: 'spatial-grid-vis image-plane' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'image-plane-root' }],
    meshes: [
      {
        name: 'image-plane',
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: 'image-plane-material',
        doubleSided: true,
        // Per the glTF 2.0 spec (§ Material.alphaMode), the default is
        // "OPAQUE" — the base-colour alpha channel is discarded. That
        // caused transparent PNGs uploaded through the image-plane
        // tool to render their transparent regions as SOLID BLACK on
        // the map. Setting "BLEND" honours the alpha channel so the
        // plane is see-through where the PNG is. JPEGs (no alpha
        // channel) are unaffected because their baseColor alpha
        // stays 1.0 everywhere.
        alphaMode: 'BLEND',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [
      {
        // Linear filter + clamp-to-edge keeps the texture crisp at the
        // edges of the quad with no surrounding tile bleed.
        magFilter: 9729, // LINEAR
        minFilter: 9987, // LINEAR_MIPMAP_LINEAR
        wrapS: 33071, // CLAMP_TO_EDGE
        wrapT: 33071, // CLAMP_TO_EDGE
      },
    ],
    images: [{ bufferView: 4, mimeType: inferredMime }],
    accessors: [
      // 0: POSITION
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: 4,
        type: 'VEC3',
        min: [-0.5, 0, -0.5],
        max: [0.5, 0, 0.5],
      },
      // 1: NORMAL
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: 4,
        type: 'VEC3',
      },
      // 2: TEXCOORD_0
      {
        bufferView: 2,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: 4,
        type: 'VEC2',
      },
      // 3: indices
      {
        bufferView: 3,
        byteOffset: 0,
        componentType: 5123, // UNSIGNED_SHORT
        count: 6,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: POSITIONS_OFFSET, byteLength: POSITIONS_LENGTH, target: 34962 }, // ARRAY_BUFFER
      { buffer: 0, byteOffset: NORMALS_OFFSET, byteLength: NORMALS_LENGTH, target: 34962 },
      { buffer: 0, byteOffset: UVS_OFFSET, byteLength: UVS_LENGTH, target: 34962 },
      { buffer: 0, byteOffset: INDICES_OFFSET, byteLength: INDICES_LENGTH, target: 34963 }, // ELEMENT_ARRAY_BUFFER
      { buffer: 0, byteOffset: IMAGE_OFFSET, byteLength: IMAGE_LENGTH },
    ],
    // buffer.byteLength is the actual data length, NOT the padded chunk
    // length. The glTF spec allows up to 3 trailing bytes of padding
    // between the buffer's end and the BIN chunk's end. Mapbox enforces
    // this — declaring the padded length as buffer.byteLength makes any
    // accessor whose bufferView ends at the real data boundary appear
    // to read past the buffer to a strict loader.
    buffers: [{ byteLength: BIN_DATA_LENGTH }],
  }

  // ---------- Serialise JSON chunk -------------------------------------
  const jsonString = JSON.stringify(gltf)
  const jsonBytes = new TextEncoder().encode(jsonString)
  const jsonChunkPaddedLength = alignUp(jsonBytes.byteLength, 4)
  const jsonChunk = new Uint8Array(jsonChunkPaddedLength)
  jsonChunk.set(jsonBytes, 0)
  // glTF spec: JSON chunk is padded with 0x20 (space).
  for (let i = jsonBytes.byteLength; i < jsonChunkPaddedLength; i++) {
    jsonChunk[i] = 0x20
  }

  // ---------- Serialise BIN chunk --------------------------------------
  const binChunk = new Uint8Array(BIN_CHUNK_LENGTH)
  binChunk.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), POSITIONS_OFFSET)
  binChunk.set(new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength), NORMALS_OFFSET)
  binChunk.set(new Uint8Array(uvs.buffer, uvs.byteOffset, uvs.byteLength), UVS_OFFSET)
  binChunk.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), INDICES_OFFSET)
  binChunk.set(imageBytes, IMAGE_OFFSET)
  // The rest of `binChunk` (between INDICES_OFFSET+12 and IMAGE_OFFSET, and
  // between IMAGE_OFFSET+IMAGE_LENGTH and BIN_CHUNK_LENGTH) is already zero
  // from the Uint8Array constructor — glTF spec calls for 0x00 padding in
  // the BIN chunk, which Uint8Array satisfies for free.

  // ---------- Assemble GLB ---------------------------------------------
  const TOTAL_LENGTH =
    12 + // header
    8 + jsonChunk.byteLength + // JSON chunk header + data
    8 + binChunk.byteLength // BIN chunk header + data
  const out = new Uint8Array(TOTAL_LENGTH)
  const view = new DataView(out.buffer)
  let cursor = 0

  // Header
  view.setUint32(cursor, GLB_MAGIC, true); cursor += 4
  view.setUint32(cursor, GLB_VERSION, true); cursor += 4
  view.setUint32(cursor, TOTAL_LENGTH, true); cursor += 4

  // JSON chunk
  view.setUint32(cursor, jsonChunk.byteLength, true); cursor += 4
  view.setUint32(cursor, CHUNK_TYPE_JSON, true); cursor += 4
  out.set(jsonChunk, cursor); cursor += jsonChunk.byteLength

  // BIN chunk
  view.setUint32(cursor, binChunk.byteLength, true); cursor += 4
  view.setUint32(cursor, CHUNK_TYPE_BIN, true); cursor += 4
  out.set(binChunk, cursor)

  return out
}

/**
 * Sniff the first few magic bytes to guess the image MIME type when the
 * upload didn't report one. Falls back to `image/png` for unknown
 * formats — Mapbox handles PNG and JPEG natively.
 */
function guessMimeFromBytes(bytes: Uint8Array): string {
  if (bytes.length >= 8) {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ) {
      return 'image/png'
    }
    // JPEG signature: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg'
    }
  }
  return 'image/png'
}

/**
 * Convert a freshly synthesised GLB Uint8Array into a session-scoped
 * Blob URL Mapbox can `fetch`. Callers are responsible for revoking the
 * URL when the plane is removed (or the overlay unmounts).
 */
export function glbUint8ToBlobUrl(bytes: Uint8Array): string {
  // Copy into a fresh Uint8Array so the Blob doesn't pin a SharedArrayBuffer
  // or a slice of a larger buffer.
  const copy = new Uint8Array(bytes)
  return URL.createObjectURL(new Blob([copy], { type: 'model/gltf-binary' }))
}
