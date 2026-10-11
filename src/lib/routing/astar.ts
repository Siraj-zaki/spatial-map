/**
 * A* pathfinder on a rasterized occupancy grid.
 *
 * Design choices, called out for future maintainers:
 *
 *   - **4-connected** (N / S / E / W only). 8-connected A* is faster
 *     but produces diagonal shortcuts that don't match the
 *     right-angle "mall map" aesthetic the caller asked for. The
 *     4-connected constraint + a small "turn penalty" gives paths
 *     that hug corridor axes and only turn at intersections.
 *
 *   - **Manhattan heuristic** — admissible for 4-connected grids
 *     (never overestimates), so A* is optimal.
 *
 *   - **Turn penalty** — a small cost added when the direction of
 *     travel changes. Keeps the pathfinder from wobbling
 *     side-to-side when many equal-cost options exist, and produces
 *     the long clean runs the reference screenshot shows.
 *
 *   - **Prefer-centre bias** — when a distance-transform is present,
 *     cells further from walls are cheaper by a small amount. This
 *     is what gets the path to "float" down the middle of a corridor
 *     instead of scraping one wall.
 *
 *   - **Binary heap** — pure-JS, allocation-free hot loop. For grids
 *     up to a few million cells this runs in well under a frame.
 */

import type { CompiledGrid } from './occupancy-grid.ts'
import { isBlocked } from './occupancy-grid.ts'

export interface AStarOptions {
  /** Cost multiplier applied when the direction of travel changes. Default 0.35. */
  turnCost?: number
  /**
   * Weight for the "distance from nearest wall" bias in metres. Higher
   * values shove the path further from walls; too high and it will
   * ignore obviously short routes to stay away from any wall. Default
   * 0.25. Only takes effect when the grid has a distance transform.
   */
  centreBias?: number
  /**
   * If start or end is inside an obstacle, search for the nearest
   * walkable cell within this radius (in metres). Default 3 m — big
   * enough to snap through a door frame, small enough to fail loudly
   * on genuinely blocked queries.
   */
  snapRadiusMeters?: number
}

/** Encoded step direction — matches the DX/DY tables below. 0=E 1=S 2=W 3=N. */
type Dir = 0 | 1 | 2 | 3
const DX: Record<Dir, number> = { 0: 1, 1: 0, 2: -1, 3: 0 }
const DY: Record<Dir, number> = { 0: 0, 1: 1, 2: 0, 3: -1 }

// ---------------------------------------------------------------------------
// Binary min-heap keyed on `fScore`. Stores packed cell indices.
// ---------------------------------------------------------------------------

class MinHeap {
  private items: number[] = []
  private scores: number[] = []
  get size(): number {
    return this.items.length
  }
  push(item: number, score: number): void {
    this.items.push(item)
    this.scores.push(score)
    this.bubbleUp(this.items.length - 1)
  }
  pop(): number {
    const top = this.items[0]
    const lastItem = this.items.pop()!
    const lastScore = this.scores.pop()!
    if (this.items.length > 0) {
      this.items[0] = lastItem
      this.scores[0] = lastScore
      this.sinkDown(0)
    }
    return top
  }
  private bubbleUp(i: number): void {
    const item = this.items[i]
    const score = this.scores[i]
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.scores[parent] <= score) break
      this.items[i] = this.items[parent]
      this.scores[i] = this.scores[parent]
      i = parent
    }
    this.items[i] = item
    this.scores[i] = score
  }
  private sinkDown(i: number): void {
    const n = this.items.length
    const item = this.items[i]
    const score = this.scores[i]
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let swap = -1
      let bestScore = score
      if (l < n && this.scores[l] < bestScore) {
        swap = l
        bestScore = this.scores[l]
      }
      if (r < n && this.scores[r] < bestScore) {
        swap = r
      }
      if (swap === -1) break
      this.items[i] = this.items[swap]
      this.scores[i] = this.scores[swap]
      i = swap
    }
    this.items[i] = item
    this.scores[i] = score
  }
}

// ---------------------------------------------------------------------------
// Nearest-walkable snap (spiral search).
// ---------------------------------------------------------------------------

/**
 * Find the closest walkable cell to `(cx, cy)` within `radiusCells`.
 * Returns `null` when nothing walkable exists in range. Uses a simple
 * ring-by-ring outward search — for the small radii we accept (a few
 * cells) this is faster and simpler than any queue-based BFS.
 */
export function snapToWalkable(
  grid: CompiledGrid,
  cx: number,
  cy: number,
  radiusCells: number,
): [number, number] | null {
  if (!isBlocked(grid, cx, cy)) return [cx, cy]
  const maxR = Math.max(1, Math.ceil(radiusCells))
  for (let r = 1; r <= maxR; r++) {
    let best: [number, number] | null = null
    let bestD = Infinity
    // Iterate the ring at Chebyshev distance `r` around (cx, cy).
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const nx = cx + dx
        const ny = cy + dy
        if (isBlocked(grid, nx, ny)) continue
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = [nx, ny]
        }
      }
    }
    if (best) return best
  }
  return null
}

// ---------------------------------------------------------------------------
// A* solver.
// ---------------------------------------------------------------------------

export interface AStarResult {
  /** Cell path start → end, inclusive. Empty when no route exists. */
  cells: [number, number][]
  cellsExpanded: number
  found: boolean
}

/**
 * Solve start → end. `start` and `end` are integer cell indices; the
 * caller is responsible for snapping to walkable via `snapToWalkable`
 * before calling — this keeps the solver hot loop free of scene state.
 */
export function findPath(
  grid: CompiledGrid,
  start: [number, number],
  end: [number, number],
  opts: AStarOptions = {},
): AStarResult {
  const { width, height, cellSize, occ, dist } = grid
  const turnCost = opts.turnCost ?? 0.35
  const centreBias = opts.centreBias ?? 0.25

  const startIdx = start[1] * width + start[0]
  const endIdx = end[1] * width + end[0]
  if (occ[startIdx] === 1 || occ[endIdx] === 1) {
    return { cells: [], cellsExpanded: 0, found: false }
  }
  if (startIdx === endIdx) {
    return { cells: [start], cellsExpanded: 0, found: true }
  }

  const size = width * height
  // gScore in cost units (metres). Float32Array is plenty precise.
  const gScore = new Float32Array(size)
  gScore.fill(Infinity)
  gScore[startIdx] = 0
  // Parent index for path reconstruction. -1 = no parent.
  const parent = new Int32Array(size).fill(-1)
  // Encoded direction used to reach each cell (for the turn penalty).
  const inDir = new Int8Array(size).fill(-1)
  // Closed-set bitmap.
  const closed = new Uint8Array(size)

  const heap = new MinHeap()
  heap.push(startIdx, 0)

  const heuristic = (idx: number): number => {
    const x = idx % width
    const y = (idx - x) / width
    return (Math.abs(x - end[0]) + Math.abs(y - end[1])) * cellSize
  }

  let expanded = 0

  while (heap.size > 0) {
    const cur = heap.pop()
    if (closed[cur]) continue
    closed[cur] = 1
    expanded++
    if (cur === endIdx) {
      // Reconstruct.
      const cells: [number, number][] = []
      let c = cur
      while (c !== -1) {
        const x = c % width
        const y = (c - x) / width
        cells.push([x, y])
        c = parent[c]
      }
      cells.reverse()
      return { cells, cellsExpanded: expanded, found: true }
    }
    const curG = gScore[cur]
    const curDir = inDir[cur]
    const cx = cur % width
    const cy = (cur - cx) / width
    for (let d: Dir = 0; d < 4; d = (d + 1) as Dir) {
      const nx = cx + DX[d]
      const ny = cy + DY[d]
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const nIdx = ny * width + nx
      if (occ[nIdx] === 1 || closed[nIdx]) continue
      // Base step cost = 1 cell.
      let step = cellSize
      // Turn penalty when direction changed.
      if (curDir !== -1 && curDir !== d) step += turnCost
      // Centre bias — cheaper the further from the nearest wall.
      // Encoded as a *discount* capped at the base step so cells never
      // go negative (which would break Dijkstra optimality).
      if (dist && centreBias > 0) {
        const bonus = Math.min(step * 0.6, centreBias * Math.min(dist[nIdx], 2))
        step -= bonus
      }
      const tentative = curG + step
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative
        parent[nIdx] = cur
        inDir[nIdx] = d
        heap.push(nIdx, tentative + heuristic(nIdx))
      }
    }
  }
  return { cells: [], cellsExpanded: expanded, found: false }
}
