/**
 * Floor-plan renderer: a Mapbox custom layer that draws one image as a
 * textured quad at an exact altitude.
 *
 * Why not a `raster` layer on an `image` source? Floor plans used one,
 * lifted with `raster-elevation` so upper floors sit at their height.
 * That path (experimental in 3.25) broke in two ways, both measured on
 * real facilities (zoom 14–28 × pitch 0–70):
 *
 *  1. **The plan vanished when zoomed in without tilt.** The Standard
 *     style switches to an orthographic camera below ~15° pitch. The
 *     elevated-raster shader always compiles its near-camera cutoff
 *     fade, and `cutoffParamsForElevation()` returns all zeros for an
 *     orthographic camera, so the fade divides by zero and turns every
 *     fragment transparent once the far plane passes ~2× the camera
 *     distance — around zoom 21–21.5. A few degrees of pitch blend the
 *     perspective matrix back in and the plan reappears.
 *  2. **Shapes on the plan vanished at mid zooms.** An elevated raster
 *     always writes depth (whatever its opacity — the old 254/255
 *     opacity cap did nothing) and its shader pulls that depth ~2 px
 *     toward the camera, i.e. ~1 m at zoom 18 and 6 cm at zoom 22. So
 *     extrusions centimetres above the plan lost the depth test at
 *     some zooms and won at others. At opacity 0 Mapbox skips the draw
 *     entirely, which is why the shapes came back then.
 *
 * This layer has neither problem: no cutoff fade, no depth bias, and
 * full float64 precision (vertices are metres from the plan's centre,
 * the matrix is composed in float64) — pixel-identical to a flat raster
 * up to zoom 32. It renders in Mapbox's 3D pass (`renderingMode: '3d'`,
 * LEQUAL depth test, shared depth buffer with fill-extrusions/models).
 *
 * Depth policy:
 *  - A slight polygon offset pushes the plan's depth back, so a shape
 *    drawn at exactly the plan's altitude (a line or fill z-offset to
 *    the floor) always wins.
 *  - The plan writes depth only when it is a raised, opaque floor: then
 *    it correctly hides the floors below it. A ground plan, or a
 *    see-through one, never writes depth, so it can't hide anything.
 *  - Fully transparent texels are discarded (PNG plans with holes).
 *
 * Crop is done with texture coordinates on the full image — no canvas
 * re-encode, so a crop change is instant.
 *
 * Cut-out (focus mode): `cuts` — up to `MAX_CUTS` discs ([lng, lat] +
 * radius in metres). Every fragment within a disc is discarded, with a
 * `cutFeatherM` smoothstep edge, so a plate standing in the line of sight
 * keeps its opacity and gets a soft round hole around the focused item
 * instead of fading whole. Discarded fragments write no depth, so only
 * the hole shows what is below. The disc centres are converted to the
 * plan's local metres once per change (cuts or geometry), never per
 * frame. With no cuts the shader path is bit-identical to having none.
 *
 * Mask ("hide outside walls"): optional polygons in full-image UV. They
 * are rasterised once into a single-channel texture (unit 1) and every
 * fragment outside them is discarded, so the sheet margin, title block
 * and dimension chains around the building disappear. Changing the
 * mask re-rasterises a ~2k canvas; the image itself is untouched.
 *
 * GL hygiene: Mapbox caches GL state. Every GL call here happens inside
 * `render()`, after which Mapbox marks its cache dirty (`drawCustom` →
 * `context.setDirty()`). Image decoding happens off the render path;
 * the decoded bitmap is uploaded on the next frame.
 */

import mapboxgl, { type CustomLayerInterface, type Map as MapboxMapInstance } from 'mapbox-gl'

/** TL, TR, BR, BL — the order Mapbox `image` sources use. */
export type FloorPlanCorners = [[number, number], [number, number], [number, number], [number, number]]

/** Visible part of the image in texture space (0–1, v down). */
export interface FloorPlanUV {
  u0: number
  v0: number
  u1: number
  v1: number
}

export interface FloorPlanLayerState {
  url: string
  corners: FloorPlanCorners
  /** Defaults to the whole image. */
  uv?: FloorPlanUV
  /** Metres above sea level (the map has no terrain). */
  elevation: number
  /** 0–1. */
  opacity: number
  visible: boolean
  /** Keep only these areas: rings in full-image UV (0–1, v down). */
  mask?: number[][][][] | null
  /**
   * Round holes (focus-mode cut-out): [lng, lat] centre + radius in
   * metres, at most `MAX_CUTS` (extra ones are ignored). Compared by
   * value: equal cuts never repaint.
   */
  cuts?: ReadonlyArray<FloorPlanCut> | null
  /** Soft edge of each hole, metres (default 1). */
  cutFeatherM?: number
}

export interface FloorPlanCut {
  center: readonly [number, number]
  radiusM: number
}

/** Most holes the shader takes (`u_cuts` length). */
export const MAX_CUTS = 12
const DEFAULT_CUT_FEATHER_M = 1

const FULL_UV: FloorPlanUV = { u0: 0, v0: 0, u1: 1, v1: 1 }

/** At or above this opacity a raised plan counts as solid and writes depth. */
const SOLID_OPACITY = 0.95
/** Plans lower than this are ground floors and never write depth. */
const RAISED_MIN_M = 0.01

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform mat4 u_matrix;
uniform float u_elevation;
out vec2 v_uv;
out vec2 v_pos;
void main() {
  v_uv = a_uv;
  v_pos = a_pos;
  gl_Position = u_matrix * vec4(a_pos, u_elevation, 1.0);
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_pos;
uniform sampler2D u_texture;
uniform sampler2D u_mask;
uniform float u_use_mask;
uniform float u_opacity;
// Cut-out discs: local metres (x east, y south) + radius.
uniform int u_cut_count;
uniform vec3 u_cuts[${MAX_CUTS}];
uniform float u_cut_feather;
out vec4 fragColor;
void main() {
  if (u_use_mask > 0.5 && texture(u_mask, v_uv).r < 0.5) discard;
  // The texture is premultiplied, matching Mapbox's blend
  // (ONE, ONE_MINUS_SRC_ALPHA).
  vec4 c = texture(u_texture, v_uv) * u_opacity;
  if (u_cut_count > 0) {
    float f = 1.0;
    for (int i = 0; i < ${MAX_CUTS}; i++) {
      if (i >= u_cut_count) break;
      vec3 k = u_cuts[i];
      f = min(f, smoothstep(k.z - u_cut_feather, k.z, distance(v_pos, k.xy)));
    }
    if (f < 0.02) discard;
    c *= f;
  }
  if (c.a < 0.004) discard;
  fragColor = c;
}`

interface GlResources {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  vbo: WebGLBuffer
  uMatrix: WebGLUniformLocation | null
  uElevation: WebGLUniformLocation | null
  uTexture: WebGLUniformLocation | null
  uOpacity: WebGLUniformLocation | null
  uMask: WebGLUniformLocation | null
  uUseMask: WebGLUniformLocation | null
  uCutCount: WebGLUniformLocation | null
  uCuts: WebGLUniformLocation | null
  uCutFeather: WebGLUniformLocation | null
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('floor-plan layer: createShader failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`floor-plan layer: shader compile failed: ${log}`)
  }
  return shader
}

/**
 * Decode an image URL (http(s), relative or data:) into a premultiplied
 * ImageBitmap no larger than `maxSize` on either side.
 */
async function decodeImage(url: string, maxSize: number): Promise<ImageBitmap> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.decoding = 'async'
  img.src = url
  await img.decode()
  const w = img.naturalWidth || 1024
  const h = img.naturalHeight || 1024
  const scale = Math.min(1, maxSize / Math.max(w, h))
  return createImageBitmap(img, {
    premultiplyAlpha: 'premultiply',
    colorSpaceConversion: 'default',
    imageOrientation: 'from-image',
    ...(scale < 1
      ? { resizeWidth: Math.max(1, Math.floor(w * scale)), resizeHeight: Math.max(1, Math.floor(h * scale)), resizeQuality: 'high' as const }
      : {}),
  })
}

/** Column-major 4×4 multiply in float64. */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let v = 0
      for (let k = 0; k < 4; k++) v += a[k * 4 + row] * b[col * 4 + k]
      out[col * 4 + row] = v
    }
  }
  return out
}

/** Does the current style declare a slot with this name? */
export function styleHasSlot(map: MapboxMapInstance, slot: string): boolean {
  try {
    const slots = (map as unknown as { getSlots?: () => string[] }).getSlots?.()
    return Array.isArray(slots) && slots.includes(slot)
  } catch {
    return false
  }
}

export class FloorPlanLayer implements CustomLayerInterface {
  readonly id: string
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const
  slot?: string

  private state: FloorPlanLayerState
  private map: MapboxMapInstance | null = null
  private gl: WebGL2RenderingContext | null = null
  private res: GlResources | null = null
  private texture: WebGLTexture | null = null
  /** URL whose pixels are in `texture`. */
  private textureUrl: string | null = null
  /** Decoded and waiting for the next frame to upload. */
  private pending: { url: string; bitmap: ImageBitmap } | null = null
  /** URL currently being decoded (dedupes loads). */
  private loadingUrl: string | null = null
  private geometryDirty = true
  private maskTexture: WebGLTexture | null = null
  private maskDirty = true
  /** Image aspect (w / h), for the mask canvas. */
  private aspect = 1
  /** Plan centre in Mercator units, and metres → Mercator scale there. */
  private origin = { x: 0, y: 0, scale: 1 }
  /** `state.cuts` in local metres (x, y, r per disc), rebuilt when the cuts or the geometry change. */
  private cutData = new Float32Array(MAX_CUTS * 3)
  private cutCount = 0
  private cutsDirty = true

  constructor(id: string, state: FloorPlanLayerState, slot?: string) {
    this.id = id
    this.state = { ...state }
    if (slot) this.slot = slot
  }

  /**
   * Apply new props; reloads the texture only when the URL changed.
   * Compared by value (corners, uv, cuts) or identity (mask): props equal
   * to the current ones leave everything as is and don't repaint.
   */
  update(next: Partial<FloorPlanLayerState>): void {
    const prev = this.state
    let changed = false
    const merged: FloorPlanLayerState = { ...prev, ...next }
    if (next.corners && !sameCorners(next.corners, prev.corners)) {
      this.geometryDirty = true
      changed = true
    } else {
      merged.corners = prev.corners
    }
    if (next.uv && !sameUV(next.uv, prev.uv)) {
      this.geometryDirty = true
      changed = true
    }
    if ('mask' in next && next.mask !== prev.mask) {
      this.maskDirty = true
      changed = true
    }
    if ('cuts' in next && !sameCuts(next.cuts, prev.cuts)) {
      this.cutsDirty = true
      changed = true
    } else {
      merged.cuts = prev.cuts
    }
    if ((merged.cutFeatherM ?? DEFAULT_CUT_FEATHER_M) !== (prev.cutFeatherM ?? DEFAULT_CUT_FEATHER_M)) changed = true
    if (
      merged.url !== prev.url ||
      merged.elevation !== prev.elevation ||
      merged.opacity !== prev.opacity ||
      merged.visible !== prev.visible
    ) {
      changed = true
    }
    this.state = merged
    if (next.url && next.url !== prev.url) this.load()
    if (changed) this.map?.triggerRepaint()
  }

  onAdd(map: MapboxMapInstance, gl: WebGL2RenderingContext): void {
    // A new context (style swap on some setups) invalidates every handle;
    // the same context keeps them, so re-adding after removal is cheap.
    if (this.gl !== gl) {
      this.res = null
      this.texture = null
      this.textureUrl = null
      this.maskTexture = null
      this.maskDirty = true
    }
    this.map = map
    this.gl = gl
    this.geometryDirty = true
    this.cutsDirty = true
    if (this.textureUrl !== this.state.url) this.load()
  }

  onRemove(_map: MapboxMapInstance, gl: WebGL2RenderingContext): void {
    if (this.res) {
      gl.deleteBuffer(this.res.vbo)
      gl.deleteVertexArray(this.res.vao)
      gl.deleteProgram(this.res.program)
    }
    if (this.texture) gl.deleteTexture(this.texture)
    if (this.maskTexture) gl.deleteTexture(this.maskTexture)
    this.maskTexture = null
    this.maskDirty = true
    this.pending?.bitmap.close()
    this.pending = null
    this.res = null
    this.texture = null
    this.textureUrl = null
    this.loadingUrl = null
    this.map = null
  }

  render(gl: WebGL2RenderingContext, matrix: number[]): void {
    const { state } = this
    if (!state.visible || state.opacity <= 0) return
    if (this.pending) this.upload(gl)
    if (!this.texture) return
    const res = this.res ?? (this.res = this.createResources(gl))
    if (this.geometryDirty) this.writeGeometry(gl, res)
    if (this.cutsDirty) this.writeCuts()

    // matrix (float64 copy of Mapbox's mercatorMatrix) × T(origin) ×
    // S(metres → Mercator). Composing in float64 and only then dropping
    // to float32 keeps vertices (small metre offsets) precise at any zoom.
    const { x, y, scale } = this.origin
    const local = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, 0, 1]
    const m = multiply(matrix, local)

    gl.useProgram(res.program)
    gl.uniformMatrix4fv(res.uMatrix, false, new Float32Array(m))
    gl.uniform1f(res.uElevation, state.elevation)
    gl.uniform1f(res.uOpacity, Math.min(1, state.opacity))
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniform1i(res.uTexture, 0)
    if (this.maskDirty) this.writeMask(gl)
    const useMask = !!(state.mask && state.mask.length > 0 && this.maskTexture)
    gl.uniform1f(res.uUseMask, useMask ? 1 : 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, useMask ? this.maskTexture : this.texture)
    gl.uniform1i(res.uMask, 1)
    gl.activeTexture(gl.TEXTURE0)
    // The program is this layer's own, but its uniforms are set every
    // frame anyway (three calls) — a recreated program never misses them.
    gl.uniform1i(res.uCutCount, this.cutCount)
    if (this.cutCount > 0) {
      gl.uniform3fv(res.uCuts, this.cutData)
      gl.uniform1f(res.uCutFeather, Math.max(1e-3, state.cutFeatherM ?? DEFAULT_CUT_FEATHER_M))
    }

    // Mapbox has set LEQUAL depth testing, the 3D depth range and
    // premultiplied blending for us (drawCustom, renderingMode '3d').
    const writeDepth = state.elevation >= RAISED_MIN_M && state.opacity >= SOLID_OPACITY
    gl.depthMask(writeDepth)
    gl.enable(gl.POLYGON_OFFSET_FILL)
    gl.polygonOffset(1, 2)
    gl.disable(gl.CULL_FACE)

    gl.bindVertexArray(res.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)

    gl.disable(gl.POLYGON_OFFSET_FILL)
    gl.depthMask(true)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /**
   * `state.cuts` → local metres around the plan centre (x east, y south,
   * the same frame as the vertices), radius scaled by the Mercator scale
   * at the disc over the one at the centre. Runs after `writeGeometry`
   * (needs `origin`), only when the cuts or the geometry changed.
   */
  private writeCuts(): void {
    this.cutsDirty = false
    this.cutData.fill(0)
    this.cutCount = 0
    const cuts = this.state.cuts
    if (!cuts || cuts.length === 0) return
    const { x: ox, y: oy, scale } = this.origin
    let n = 0
    for (const cut of cuts) {
      if (n >= MAX_CUTS) break
      const [lng, lat] = cut.center
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || !(cut.radiusM > 0)) continue
      const m = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], 0)
      this.cutData[n * 3] = (m.x - ox) / scale
      this.cutData[n * 3 + 1] = (m.y - oy) / scale
      this.cutData[n * 3 + 2] = (cut.radiusM * m.meterInMercatorCoordinateUnits()) / scale
      n++
    }
    this.cutCount = n
  }

  /** Rasterise `state.mask` (UV rings) into a single-channel texture. */
  private writeMask(gl: WebGL2RenderingContext): void {
    this.maskDirty = false
    const mask = this.state.mask
    if (!mask || mask.length === 0) return
    const longSide = 2048
    const w = this.aspect >= 1 ? longSide : Math.max(16, Math.round(longSide * this.aspect))
    const h = this.aspect >= 1 ? Math.max(16, Math.round(longSide / this.aspect)) : longSide
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) return
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#fff'
    for (const poly of mask) {
      ctx.beginPath()
      for (const ring of poly) {
        ring.forEach(([u, v], i) => (i === 0 ? ctx.moveTo(u * w, v * h) : ctx.lineTo(u * w, v * h)))
        ctx.closePath()
      }
      ctx.fill('evenodd')
    }
    const texture = this.maskTexture ?? gl.createTexture()
    if (!texture) return
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas as TexImageSource)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    this.maskTexture = texture
  }

  private load(): void {
    const gl = this.gl
    const url = this.state.url
    if (!gl || !url || this.loadingUrl === url) return
    this.loadingUrl = url
    const maxSize = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096
    decodeImage(url, maxSize).then(
      (bitmap) => {
        // A newer URL (or a removal) superseded this load.
        if (this.loadingUrl !== url || this.state.url !== url) {
          bitmap.close()
          return
        }
        this.loadingUrl = null
        this.pending?.bitmap.close()
        this.pending = { url, bitmap }
        this.map?.triggerRepaint()
      },
      (err) => {
        if (this.loadingUrl === url) this.loadingUrl = null
        console.warn('[FloorPlanLayer] image failed to load', url.slice(0, 80), err)
      },
    )
  }

  private upload(gl: WebGL2RenderingContext): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    const texture = this.texture ?? gl.createTexture()
    if (!texture) {
      pending.bitmap.close()
      return
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    // ImageBitmap uploads ignore UNPACK_FLIP_Y / UNPACK_PREMULTIPLY_ALPHA,
    // so Mapbox's cached pixelStore state is left untouched.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pending.bitmap)
    const aspect = pending.bitmap.width / Math.max(1, pending.bitmap.height)
    if (Math.abs(aspect - this.aspect) > 1e-3) {
      this.aspect = aspect
      this.maskDirty = true
    }
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max || 1))
    }
    gl.bindTexture(gl.TEXTURE_2D, null)
    pending.bitmap.close()
    this.texture = texture
    this.textureUrl = pending.url
  }

  private createResources(gl: WebGL2RenderingContext): GlResources {
    const program = gl.createProgram()
    const vao = gl.createVertexArray()
    const vbo = gl.createBuffer()
    if (!program || !vao || !vbo) throw new Error('floor-plan layer: GL allocation failed')
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`floor-plan layer: link failed: ${gl.getProgramInfoLog(program)}`)
    }
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, 16 * 4, gl.DYNAMIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'a_pos')
    const aUv = gl.getAttribLocation(program, 'a_uv')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    return {
      program,
      vao,
      vbo,
      uMatrix: gl.getUniformLocation(program, 'u_matrix'),
      uElevation: gl.getUniformLocation(program, 'u_elevation'),
      uTexture: gl.getUniformLocation(program, 'u_texture'),
      uOpacity: gl.getUniformLocation(program, 'u_opacity'),
      uMask: gl.getUniformLocation(program, 'u_mask'),
      uUseMask: gl.getUniformLocation(program, 'u_use_mask'),
      uCutCount: gl.getUniformLocation(program, 'u_cut_count'),
      uCuts: gl.getUniformLocation(program, 'u_cuts'),
      uCutFeather: gl.getUniformLocation(program, 'u_cut_feather'),
    }
  }

  /**
   * Corners → metres from the plan centre (x east, y south — Mercator y
   * grows southward). Triangle strip TL, TR, BL, BR: the same diagonal
   * Mapbox's image source uses, so the texture maps identically.
   */
  private writeGeometry(gl: WebGL2RenderingContext, res: GlResources): void {
    this.geometryDirty = false
    // The cut centres are relative to `origin`, which this recomputes.
    this.cutsDirty = true
    const merc = this.state.corners.map(([lng, lat]) => mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], 0))
    const ox = (merc[0].x + merc[1].x + merc[2].x + merc[3].x) / 4
    const oy = (merc[0].y + merc[1].y + merc[2].y + merc[3].y) / 4
    const center = new mapboxgl.MercatorCoordinate(ox, oy, 0).toLngLat()
    const scale = mapboxgl.MercatorCoordinate.fromLngLat(center, 0).meterInMercatorCoordinateUnits()
    this.origin = { x: ox, y: oy, scale }
    const local = merc.map((c) => [(c.x - ox) / scale, (c.y - oy) / scale])
    const { u0, v0, u1, v1 } = this.state.uv ?? FULL_UV
    const [tl, tr, br, bl] = local
    const data = new Float32Array([
      tl[0], tl[1], u0, v0,
      tr[0], tr[1], u1, v0,
      bl[0], bl[1], u0, v1,
      br[0], br[1], u1, v1,
    ])
    gl.bindBuffer(gl.ARRAY_BUFFER, res.vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }
}

function sameCorners(a: FloorPlanCorners, b: FloorPlanCorners): boolean {
  if (a === b) return true
  for (let i = 0; i < 4; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false
  }
  return true
}

/** Equal by value (null / undefined / [] are all "no cuts"). */
export function sameCuts(
  a: ReadonlyArray<FloorPlanCut> | null | undefined,
  b: ReadonlyArray<FloorPlanCut> | null | undefined,
): boolean {
  if (a === b) return true
  const n = a?.length ?? 0
  if (n !== (b?.length ?? 0)) return false
  for (let i = 0; i < n; i++) {
    const x = a![i]
    const y = b![i]
    if (x.radiusM !== y.radiusM || x.center[0] !== y.center[0] || x.center[1] !== y.center[1]) return false
  }
  return true
}

function sameUV(a: FloorPlanUV | undefined, b: FloorPlanUV | undefined): boolean {
  const x = a ?? FULL_UV
  const y = b ?? FULL_UV
  return x.u0 === y.u0 && x.v0 === y.v0 && x.u1 === y.u1 && x.v1 === y.v1
}
