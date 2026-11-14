/**
 * Triangle-mesh data in metres (escalator trusses, sloped walls, …) and
 * `placeMesh`, which positions one. Pure — no mapbox-gl — so the geometry
 * generators that build meshes (stair-generators, sloped-mesh) stay usable
 * outside the browser (the mobile app's shared core). The custom layer
 * that draws them is lift-mesh-layer.ts.
 */

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
