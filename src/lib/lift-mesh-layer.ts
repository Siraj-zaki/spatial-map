/**
 * Custom layer that draws triangle meshes in metres — the sloped parts
 * of escalators (truss, cladding, glass balustrades, looping handrails).
 *
 * fill-extrusion can only extrude vertical prisms, so anything inclined
 * came out as a staircase of boxes. These parts are swept meshes built by
 * `buildEscalatorMesh` and converted to world metres by `liftMeshes`.
 *
 * Same GL approach as floor-plan-layer.ts: renderingMode '3d' (shares the
 * depth buffer with extrusions and models, LEQUAL), vertices are metres
 * from each mesh's origin and the matrix is composed in float64, every GL
 * call happens inside render() (Mapbox dirties its state cache after a
 * custom layer). Shading is per-fragment and view-dependent: a key light
 * with a faint sheen on solids, and Fresnel + specular on glass.
 *
 * One instance draws opaque meshes (writes depth); a second, `translucent`
 * instance draws glass (no depth write) and is kept after every opaque 3D
 * layer by translucent-layer-order.ts.
 */

import mapboxgl, { type CustomLayerInterface, type Map as MapboxMapInstance } from 'mapbox-gl'

export interface LiftMeshData {
  /** Stable key (shape id + part) — GPU buffers are reused while it lives. */
  key: string
  /** Mesh origin. */
  origin: [number, number]
  /** (east, north, up) metres from the origin, 3 floats per vertex. */
  positions: Float32Array
  /** Per-vertex normals, same layout. */
  normals: Float32Array
  /** Per-vertex RGBA 0–1 (straight alpha). */
  colors: Float32Array
}

/**
 * A mesh in (east, north, up) metres from `origin`, turned clockwise by
 * `rotation` degrees about `pivot` (metres) — like turf's
 * transformRotate on the extruded parts — with flat per-triangle normals.
 */
export function placeMesh(
  en: ArrayLike<number>,
  colors: number[],
  origin: [number, number],
  pivot: [number, number],
  rotation: number,
  key: string,
): LiftMeshData {
  const r = (rotation * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const [pe, pn] = pivot
  const positions = new Float32Array(en.length)
  for (let i = 0; i < en.length; i += 3) {
    const e = en[i] - pe
    const n = en[i + 1] - pn
    positions[i] = pe + e * cos + n * sin
    positions[i + 1] = pn - e * sin + n * cos
    positions[i + 2] = en[i + 2]
  }
  const normals = new Float32Array(en.length)
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i + 3] - positions[i]
    const ay = positions[i + 4] - positions[i + 1]
    const az = positions[i + 5] - positions[i + 2]
    const bx = positions[i + 6] - positions[i]
    const by = positions[i + 7] - positions[i + 1]
    const bz = positions[i + 8] - positions[i + 2]
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
    for (let k = 0; k < 9; k += 3) {
      normals[i + k] = nx
      normals[i + k + 1] = ny
      normals[i + k + 2] = nz
    }
  }
  return { key, origin, positions, normals, colors: new Float32Array(colors) }
}

const VERTEX_SHADER = `#version 300 es
in vec3 a_pos;
in vec3 a_normal;
in vec4 a_color;
uniform mat4 u_matrix;
out vec3 v_pos;
out vec3 v_normal;
out vec4 v_color;
void main() {
  v_pos = a_pos;
  v_normal = a_normal;
  v_color = a_color;
  gl_Position = u_matrix * vec4(a_pos, 1.0);
}`

// Lighting in the mesh's metre frame. Faces are lit from whichever side
// faces the camera (no culling, panes are two-sided).
//  - Solids: key light, soft fill, sky/ground gradient, faint sheen.
//  - Glass: nearly clear face-on, more opaque and reflective at grazing
//    angles (Schlick-style Fresnel), plus a specular highlight — what
//    makes a pane read as glass rather than tinted plastic.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_pos;
in vec3 v_normal;
in vec4 v_color;
uniform vec3 u_camera;
uniform float u_glass;
out vec4 fragColor;
void main() {
  vec3 n = normalize(v_normal);
  vec3 v = normalize(u_camera - v_pos);
  if (dot(n, v) < 0.0) n = -n;
  vec3 light = normalize(vec3(-0.35, -0.45, 0.82));
  float diff = max(dot(n, light), 0.0);
  float spec = pow(max(dot(reflect(-light, n), v), 0.0), 48.0);
  if (u_glass > 0.5) {
    float facing = max(dot(n, v), 0.0);
    float fresnel = 0.04 + 0.96 * pow(1.0 - facing, 5.0);
    vec3 sky = vec3(0.86, 0.93, 0.98);
    // Soft diagonal reflection streaks, fixed in space so they slide
    // across a pane as the camera moves — reads as reflective glass
    // even face-on, where Fresnel alone leaves it nearly invisible.
    float t = fract(dot(v_pos, vec3(0.31, 0.23, 0.42)));
    float streak = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.12, 0.38, t));
    vec3 col = mix(v_color.rgb, sky, clamp(fresnel * 1.4, 0.0, 0.85)) + spec * 0.9 + streak * 0.25;
    float a = clamp(v_color.a + fresnel * 0.65 + spec * 0.6 + streak * 0.1, 0.0, 0.92);
    fragColor = vec4(col * a, a);
  } else {
    // Key light + a soft fill from the opposite side + a sky/ground
    // gradient, so faces turned away from the key still show their
    // relief (door panels, stair nosings) instead of one flat grey.
    vec3 fillDir = normalize(vec3(0.45, 0.55, 0.35));
    float fill = max(dot(n, fillDir), 0.0);
    float shade = clamp(0.46 + 0.42 * diff + 0.16 * fill + 0.06 * n.z, 0.0, 1.05);
    vec3 col = v_color.rgb * shade + spec * 0.12;
    fragColor = vec4(col * v_color.a, v_color.a);
  }
}`

interface GpuMesh {
  vao: WebGLVertexArrayObject
  buffers: WebGLBuffer[]
  count: number
  origin: { x: number; y: number; scale: number }
  data: LiftMeshData
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('lift-mesh layer: createShader failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`lift-mesh layer: shader compile failed: ${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

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

export class LiftMeshLayer implements CustomLayerInterface {
  readonly id: string
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const
  /** Read by translucent-layer-order.ts to keep glass after opaque 3D. */
  readonly translucent: boolean

  private map: MapboxMapInstance | null = null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private uMatrix: WebGLUniformLocation | null = null
  private uCamera: WebGLUniformLocation | null = null
  private uGlass: WebGLUniformLocation | null = null
  private meshes = new Map<string, GpuMesh>()
  private pending: LiftMeshData[] | null = []
  private visible = true

  constructor(id: string, translucent = false) {
    this.id = id
    this.translucent = translucent
  }

  /** Replace every mesh; uploaded on the next frame. */
  setMeshes(meshes: LiftMeshData[]): void {
    this.pending = meshes
    this.map?.triggerRepaint()
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.map?.triggerRepaint()
  }

  onAdd(map: MapboxMapInstance, gl: WebGL2RenderingContext): void {
    if (this.gl !== gl) {
      this.program = null
      // Buffers of another context are gone; re-upload what we had.
      const current = [...this.meshes.values()].map((m) => m.data)
      this.meshes.clear()
      if (this.pending === null) this.pending = current
    }
    this.map = map
    this.gl = gl
  }

  onRemove(_map: MapboxMapInstance, gl: WebGL2RenderingContext): void {
    const current = [...this.meshes.values()].map((m) => m.data)
    for (const m of this.meshes.values()) this.free(gl, m)
    this.meshes.clear()
    if (this.pending === null) this.pending = current
    if (this.program) gl.deleteProgram(this.program)
    this.program = null
    this.map = null
  }

  render(gl: WebGL2RenderingContext, matrix: number[]): void {
    if (this.pending) this.upload(gl, this.pending)
    if (!this.visible || this.meshes.size === 0) return
    if (!this.program) this.createProgram(gl)
    if (!this.program) return
    gl.useProgram(this.program)
    gl.uniform1f(this.uGlass, this.translucent ? 1 : 0)
    // Camera position (Mercator) for view-dependent shading.
    let cam: { x: number; y: number; z: number } | null = null
    try {
      const p = this.map?.getFreeCameraOptions().position
      if (p) cam = { x: p.x, y: p.y, z: p.z }
    } catch {
      cam = null
    }
    // Mapbox set LEQUAL + 3D depth range + premultiplied blending.
    gl.depthMask(!this.translucent)
    gl.disable(gl.CULL_FACE)
    for (const m of this.meshes.values()) {
      const { x, y, scale } = m.origin
      // East/north/up metres → Mercator: y grows south, hence -scale.
      const local = [scale, 0, 0, 0, 0, -scale, 0, 0, 0, 0, scale, 0, x, y, 0, 1]
      gl.uniformMatrix4fv(this.uMatrix, false, new Float32Array(multiply(matrix, local)))
      // Camera in this mesh's east/north/up metres.
      if (cam) gl.uniform3f(this.uCamera, (cam.x - x) / scale, -(cam.y - y) / scale, cam.z / scale)
      else gl.uniform3f(this.uCamera, 0, 0, 1e4)
      gl.bindVertexArray(m.vao)
      gl.drawArrays(gl.TRIANGLES, 0, m.count)
    }
    gl.bindVertexArray(null)
    gl.depthMask(true)
  }

  private createProgram(gl: WebGL2RenderingContext): void {
    const program = gl.createProgram()
    if (!program) return
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.bindAttribLocation(program, 0, 'a_pos')
    gl.bindAttribLocation(program, 1, 'a_normal')
    gl.bindAttribLocation(program, 2, 'a_color')
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`lift-mesh layer: link failed: ${gl.getProgramInfoLog(program)}`)
    }
    this.program = program
    this.uMatrix = gl.getUniformLocation(program, 'u_matrix')
    this.uCamera = gl.getUniformLocation(program, 'u_camera')
    this.uGlass = gl.getUniformLocation(program, 'u_glass')
  }

  private upload(gl: WebGL2RenderingContext, next: LiftMeshData[]): void {
    this.pending = null
    const keep = new Set(next.map((m) => m.key))
    for (const [key, m] of this.meshes) {
      if (!keep.has(key)) {
        this.free(gl, m)
        this.meshes.delete(key)
      }
    }
    for (const data of next) {
      const existing = this.meshes.get(data.key)
      if (existing && existing.data === data) continue
      if (existing) this.free(gl, existing)
      if (data.positions.length === 0) {
        this.meshes.delete(data.key)
        continue
      }
      const vao = gl.createVertexArray()
      if (!vao) continue
      gl.bindVertexArray(vao)
      const buffers: WebGLBuffer[] = []
      const attrib = (loc: number, array: Float32Array, size: number) => {
        const buf = gl.createBuffer()
        if (!buf) return
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW)
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
        buffers.push(buf)
      }
      attrib(0, data.positions, 3)
      attrib(1, data.normals, 3)
      attrib(2, data.colors, 4)
      gl.bindVertexArray(null)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      const merc = mapboxgl.MercatorCoordinate.fromLngLat(data.origin, 0)
      this.meshes.set(data.key, {
        vao,
        buffers,
        count: data.positions.length / 3,
        origin: { x: merc.x, y: merc.y, scale: merc.meterInMercatorCoordinateUnits() },
        data,
      })
    }
  }

  private free(gl: WebGL2RenderingContext, m: GpuMesh): void {
    gl.deleteVertexArray(m.vao)
    for (const b of m.buffers) gl.deleteBuffer(b)
  }
}
