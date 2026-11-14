/**
 * Heat that stops at walls — the density behind the viewer heatmap
 * (`map-dl-heatmap-overlay.tsx`) when the host passes the facility's shapes.
 *
 * What is solid comes from the route planner (`routing/floors.ts`
 * `routingScene`): walls (only real ones — lines with a height), racks,
 * raised objects, columns, 3D models and climbing stairs; open / ajar door
 * mouths are open, closed doors are walls. Each floor is compiled once into a 0.5 m occupancy grid (with a wall
 * mask and a distance transform) and cached.
 *
 * - Spread: every row's heat travels outward through open cells only
 *   (8-neighbour Dijkstra, no corner cutting), fading as a Gaussian of the
 *   distance walked. A wall stops it, an open door lets it through, it
 *   wraps round a column. A row far from anything solid takes the plain
 *   disc stamp (same result, cheaper).
 * - A row inside a rack / object starts at its own position and may cross
 *   that object's cells (never a wall's) for up to 1.5 m, so its heat shows
 *   in the aisles either side; solid cells never get heat painted on them.
 * - Blobs: where a 1 m blob (3.4 m wide) can't reach anything solid, 2×2
 *   cells merge into one; elsewhere each 0.5 m cell is its own blob, shrunk
 *   so it ends at the wall face (`s` = blob scale against the 1 m blob).
 * - Rows go to the floor at or below their height (+0.5 m). A floor with
 *   nothing solid on it uses the plain grid.
 */

import type { FacilityRoutingInput } from '@/lib/routing/floors'
import { floorsOf, routingScene } from '@/lib/routing/floors'
import { cellToLl, compileScene, llToCell, type CompiledGrid } from '@/lib/routing/occupancy-grid'

/** The facility's shapes, as the route planner reads them (memoise it). */
export type HeatBarriers = FacilityRoutingInput

export interface HeatRow {
  lng: number
  lat: number
  elev: number
  w: number
}

/** One blob before normalisation: `d` density, `zk` Σ kernel × height. */
export interface RawHeatCell {
  lng: number
  lat: number
  d: number
  zk: number
  /** Blob scale against the 1 m blob (absent = 1). */
  s?: number
}

export interface HeatKernel {
  sigmaM: number
  reachM: number
  /** Plain grid cell (m) and the 1 m blob's radius (m). */
  cellM: number
  blobRadiusM: number
}

const SPREAD_CELL_M = 0.5
/** Thin walls are rasterised at least this thick: the rasteriser samples
 *  the segment every half cell, so a thinner strip can miss a cell. */
const MIN_WALL_M = 0.7
/** How far a row inside a rack / object may travel through it to an aisle. */
const ESCAPE_M = 1.5
/** Smallest blob radius at a wall face (m). */
const MIN_BLOB_M = 0.35
/** Lines lower than this are floor markings, not walls. */
const MIN_WALL_HEIGHT_M = 0.2
/** Extent lattice for the grid cache (~50 m). */
const EXTENT_Q = 0.0005
const M_PER_DEG_LAT = 110_540

// ---- inputs / grids (cached)

const solidInputs = new WeakMap<HeatBarriers, { open: FacilityRoutingInput; closed: FacilityRoutingInput }>()

/**
 * The input with floor markings (flat lines) taken out of the walls, split
 * by doors: `open` keeps the open / ajar doors (their mouths are punched);
 * `closed` holds only the closed doors, which become walls across their
 * mouth — a closed door is shut to heat even where the wall has a gap.
 */
function solidInput(input: HeatBarriers): { open: FacilityRoutingInput; closed: FacilityRoutingInput } {
  let out = solidInputs.get(input)
  if (!out) {
    const isClosed = (d: HeatBarriers['doors'][number]) => d.config?.state === 'closed'
    const lines = input.lines.filter((l) => Number(l.config?.height ?? 0) >= MIN_WALL_HEIGHT_M)
    out = {
      open: { ...input, lines, doors: input.doors.filter((d) => !isClosed(d)) },
      closed: { images: input.images, lines: [], doors: input.doors.filter(isClosed), polygons: [], grids: [], stairs: [] },
    }
    solidInputs.set(input, out)
  }
  return out
}

const gridCache = new WeakMap<FacilityRoutingInput, Map<string, CompiledGrid | null>>()

function floorGrid(
  inputs: { open: FacilityRoutingInput; closed: FacilityRoutingInput },
  floorId: number | null,
  rows: readonly HeatRow[],
  reachM: number,
): CompiledGrid | null {
  const input = inputs.open
  const scene = routingScene(input, floorId)
  const closedDoors = routingScene(inputs.closed, floorId).doors ?? []
  if (!scene.walls?.length && !scene.obstacles?.length && !closedDoors.length) return null
  let minLng = Infinity
  let maxLng = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const r of rows) {
    if (r.lng < minLng) minLng = r.lng
    if (r.lng > maxLng) maxLng = r.lng
    if (r.lat < minLat) minLat = r.lat
    if (r.lat > maxLat) maxLat = r.lat
  }
  // Snap the rows' extent out to a lattice, so live updates reuse the grid.
  minLng = Math.floor(minLng / EXTENT_Q) * EXTENT_Q
  minLat = Math.floor(minLat / EXTENT_Q) * EXTENT_Q
  maxLng = Math.ceil(maxLng / EXTENT_Q) * EXTENT_Q
  maxLat = Math.ceil(maxLat / EXTENT_Q) * EXTENT_Q
  const key = `${floorId}|${minLng.toFixed(4)}|${minLat.toFixed(4)}|${maxLng.toFixed(4)}|${maxLat.toFixed(4)}`
  let byKey = gridCache.get(input)
  if (!byKey) gridCache.set(input, (byKey = new Map()))
  if (byKey.has(key)) return byKey.get(key)!
  if (byKey.size > 16) byKey.clear()
  const walls = [
    ...(scene.walls ?? []).map((w) => ({ ...w, thicknessMeters: Math.max(w.thicknessMeters ?? 0.3, MIN_WALL_M) })),
    ...closedDoors.map((d) => ({ vertices: [...d.vertices], thicknessMeters: MIN_WALL_M })),
  ]
  const grid = compileScene(
    { ...scene, walls },
    {
      agentRadiusMeters: 0,
      cellSizeMeters: SPREAD_CELL_M,
      paddingMeters: reachM + 1,
      start: [minLng, minLat],
      end: [maxLng, maxLat],
      include: [[minLng, maxLat], [maxLng, minLat]],
      withDistanceTransform: true,
      withWallMask: true,
    },
  )
  byKey.set(key, grid)
  return grid
}

/** The floor at or below `elev` (+0.5 m), else the lowest; null without floors. */
function floorOfRow(floors: ReadonlyArray<{ id: number; elevation: number }>, elev: number): number | null {
  if (!floors.length) return null
  let pick = floors[0]!
  for (const f of floors) if (f.elevation <= elev + 0.5) pick = f
  return pick.id
}

// ---- plain grid (nothing solid)

/** Every row adds a Gaussian to the `cellM` cells around it (local metres round the rows' centre). */
export function plainHeat(rows: readonly HeatRow[], k: HeatKernel): RawHeatCell[] {
  if (rows.length === 0) return []
  const lat0 = rows.reduce((sum, r) => sum + r.lat, 0) / rows.length
  const lng0 = rows.reduce((sum, r) => sum + r.lng, 0) / rows.length
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180)
  const reach = Math.ceil(k.reachM / k.cellM)
  const cells = new Map<string, { i: number; j: number; d: number; zk: number }>()
  for (const r of rows) {
    const x = (r.lng - lng0) * mPerDegLng
    const y = (r.lat - lat0) * M_PER_DEG_LAT
    const ci = Math.floor(x / k.cellM)
    const cj = Math.floor(y / k.cellM)
    for (let di = -reach; di <= reach; di++) {
      for (let dj = -reach; dj <= reach; dj++) {
        const i = ci + di
        const j = cj + dj
        const dx = (i + 0.5) * k.cellM - x
        const dy = (j + 0.5) * k.cellM - y
        const d2 = dx * dx + dy * dy
        if (d2 > k.reachM * k.reachM) continue
        const v = r.w * Math.exp(-d2 / (2 * k.sigmaM * k.sigmaM))
        const key = `${i}:${j}`
        const c = cells.get(key)
        if (c) {
          c.zk += v * r.elev
          c.d += v
        } else cells.set(key, { i, j, d: v, zk: v * r.elev })
      }
    }
  }
  const out: RawHeatCell[] = []
  for (const c of cells.values()) {
    out.push({ lng: lng0 + ((c.i + 0.5) * k.cellM) / mPerDegLng, lat: lat0 + ((c.j + 0.5) * k.cellM) / M_PER_DEG_LAT, d: c.d, zk: c.zk })
  }
  return out
}

// ---- spread on a floor grid

/** Binary min-heap of (key, cell) pairs, reused across sources. */
class MinHeap {
  private keys: number[] = []
  private vals: number[] = []
  get size(): number {
    return this.keys.length
  }
  clear(): void {
    this.keys.length = 0
    this.vals.length = 0
  }
  push(key: number, val: number): void {
    const { keys, vals } = this
    let i = keys.length
    keys.push(key)
    vals.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p]! <= key) break
      keys[i] = keys[p]!
      vals[i] = vals[p]!
      i = p
    }
    keys[i] = key
    vals[i] = val
  }
  /** Pops the smallest; returns its key, writes its value to `out[0]`. */
  pop(out: number[]): number {
    const { keys, vals } = this
    const top = keys[0]!
    out[0] = vals[0]!
    const lastK = keys.pop()!
    const lastV = vals.pop()!
    const n = keys.length
    if (n > 0) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= n) break
        const r = l + 1
        const c = r < n && keys[r]! < keys[l]! ? r : l
        if (keys[c]! >= lastK) break
        keys[i] = keys[c]!
        vals[i] = vals[c]!
        i = c
      }
      keys[i] = lastK
      vals[i] = lastV
    }
    return top
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
]

function spreadOnGrid(grid: CompiledGrid, rows: readonly HeatRow[], k: HeatKernel): RawHeatCell[] {
  const { width, height, cellSize, occ } = grid
  const wall = grid.wall!
  const dist = grid.dist!
  const n = width * height
  const dens = new Float32Array(n)
  const zk = new Float32Array(n)
  const twoSigma2 = 2 * k.sigmaM * k.sigmaM

  // Rows sharing a cell spread once.
  const sources = new Map<number, { w: number; ze: number }>()
  for (const r of rows) {
    const [cx, cy] = llToCell(grid, [r.lng, r.lat])
    const i = cy * width + cx
    const s = sources.get(i)
    if (s) {
      s.w += r.w
      s.ze += r.w * r.elev
    } else sources.set(i, { w: r.w, ze: r.w * r.elev })
  }

  const reachCells = Math.ceil(k.reachM / cellSize)
  // Float64, like the heap keys: a Float32 copy rounds diagonal distances
  // down, the pop's `g > best` check then drops the cell, and the heat
  // only travels along the grid axes (a cross).
  const best = new Float64Array(n)
  const seen = new Int32Array(n)
  let gen = 0
  const heap = new MinHeap()
  const popped = [0]

  for (const [start, s] of sources) {
    const elev = s.ze / s.w
    const sx = start % width
    const sy = (start - sx) / width

    // Nothing solid within reach: the plain disc.
    if (!occ[start] && dist[start]! >= k.reachM + cellSize) {
      for (let dy = -reachCells; dy <= reachCells; dy++) {
        const y = sy + dy
        if (y < 0 || y >= height) continue
        for (let dx = -reachCells; dx <= reachCells; dx++) {
          const x = sx + dx
          if (x < 0 || x >= width) continue
          const d2 = (dx * dx + dy * dy) * cellSize * cellSize
          if (d2 > k.reachM * k.reachM) continue
          const v = s.w * Math.exp(-d2 / twoSigma2)
          const i = y * width + x
          dens[i] += v
          zk[i] += v * elev
        }
      }
      continue
    }

    // Walk the open floor (and, from inside an object, out of it).
    gen++
    const inside = occ[start] === 1
    /** Whether the walk may step from `from` into `to` having come `g` metres. */
    const canEnter = (from: number, to: number, g: number): boolean => {
      if (!occ[to]) return true
      return inside && occ[from] === 1 && !wall[to] && g <= ESCAPE_M
    }
    heap.clear()
    best[start] = 0
    seen[start] = gen
    heap.push(0, start)
    while (heap.size > 0) {
      const g = heap.pop(popped)
      const i = popped[0]!
      if (g > best[i]!) continue
      if (!occ[i]) {
        const v = s.w * Math.exp(-(g * g) / twoSigma2)
        dens[i] += v
        zk[i] += v * elev
      }
      const x = i % width
      const y = (i - x) / width
      for (const [ox, oy] of NEIGHBOURS) {
        const nx = x + ox
        const ny = y + oy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const diag = ox !== 0 && oy !== 0
        const ng = g + (diag ? Math.SQRT2 : 1) * cellSize
        if (ng > k.reachM) continue
        const j = ny * width + nx
        if (!canEnter(i, j, ng)) continue
        // No corner cutting: a diagonal step needs both sides passable.
        if (diag && (!canEnter(i, y * width + nx, ng) || !canEnter(i, ny * width + x, ng))) continue
        if (seen[j] === gen && ng >= best[j]!) continue
        seen[j] = gen
        best[j] = ng
        heap.push(ng, j)
      }
    }
  }

  // Blobs: merged 2×2 where a 1 m blob can't reach anything solid.
  const out: RawHeatCell[] = []
  const coarseClear = k.blobRadiusM + cellSize / 2
  const fineMax = (k.blobRadiusM * cellSize) / k.cellM
  const fine = (i: number, x: number, y: number) => {
    if (occ[i] || dens[i]! <= 0) return
    // `dist` runs to the nearest solid cell's centre; the faint rim may
    // reach a quarter cell past the face, the visible blob stops at it.
    const r = Math.min(fineMax, Math.max(MIN_BLOB_M, dist[i]! - cellSize / 4))
    const [lng, lat] = cellToLl(grid, x, y)
    out.push({ lng, lat, d: dens[i]!, zk: zk[i]!, s: r / k.blobRadiusM })
  }
  for (let by = 0; by < height; by += 2) {
    for (let bx = 0; bx < width; bx += 2) {
      const i00 = by * width + bx
      const whole = bx + 1 < width && by + 1 < height
      const quad = whole ? [i00, i00 + 1, i00 + width, i00 + width + 1] : null
      if (quad && quad.every((i) => !occ[i] && dist[i]! >= coarseClear)) {
        let d = 0
        let z = 0
        for (const i of quad) {
          d += dens[i]!
          z += zk[i]!
        }
        if (d <= 0) continue
        const [lng, lat] = cellToLl(grid, bx + 0.5, by + 0.5)
        out.push({ lng, lat, d: d / 4, zk: z / 4 })
        continue
      }
      for (let y = by; y < Math.min(by + 2, height); y++) {
        for (let x = bx; x < Math.min(bx + 2, width); x++) fine(y * width + x, x, y)
      }
    }
  }
  return out
}

/**
 * The raw heat of `rows` with the facility's walls and objects in the way:
 * per floor, spread on that floor's grid, or the plain grid when the floor
 * has nothing solid on it.
 */
export function spreadHeat(rows: readonly HeatRow[], barriers: HeatBarriers, k: HeatKernel): RawHeatCell[] {
  if (rows.length === 0) return []
  const inputs = solidInput(barriers)
  const floors = floorsOf(inputs.open)
  const byFloor = new Map<number | null, HeatRow[]>()
  for (const r of rows) {
    const f = floorOfRow(floors, r.elev)
    const list = byFloor.get(f)
    if (list) list.push(r)
    else byFloor.set(f, [r])
  }
  const out: RawHeatCell[] = []
  for (const [floorId, floorRows] of byFloor) {
    const grid = floorGrid(inputs, floorId, floorRows, k.reachM)
    for (const c of grid ? spreadOnGrid(grid, floorRows, k) : plainHeat(floorRows, k)) out.push(c)
  }
  return out
}
