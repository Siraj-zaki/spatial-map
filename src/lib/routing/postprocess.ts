/**
 * Path post-processing helpers. The default route shape now comes from
 * `orthogonal.ts` (right angles along the building, door centres,
 * corridor middles); the passes below are the `pathStyle: 'any-angle'`
 * pipeline and shared helpers (`lineOfSight`, `collapseCollinear`, the
 * lng/lat conversions).
 *
 * The A* output has one waypoint per grid cell along the route — for
 * a 20 m walk at 25 cm resolution that's 80 vertices. Two passes clean
 * it up:
 *
 *   1. **Collinear collapse** — remove any waypoint whose incoming
 *      and outgoing direction are identical. Since A* is 4-connected,
 *      "direction" is one of 4 discrete values and this test is a
 *      cheap integer compare.
 *
 *   2. **Corridor centring** — walk each straight run and pull it
 *      toward the local corridor centre using the distance transform.
 *      For a run parallel to the X axis, the two endpoints slide in
 *      Y until they sit at the max-distance cell in a small window;
 *      the whole run then moves as a unit, preserving the right-angle
 *      turns. Same trick for Y-parallel runs.
 *
 * A third optional pass smooths the two endpoints where they meet
 * the user-clicked start/end — the A* endpoints snap to a grid cell,
 * so without this step the path looks slightly off from the actual
 * click position.
 */

import type { CompiledGrid } from './occupancy-grid.ts'
import { cellToLl, isBlocked } from './occupancy-grid.ts'

/**
 * Line-of-sight test. Returns true when the straight segment from
 * cell (ax,ay) to cell (bx,by) doesn't cross a single blocked cell.
 *
 * We do NOT use Bresenham here — Bresenham visits ONE cell per axis
 * step even for diagonals, so a segment can pass through a diagonal
 * "seam" of blocked cells that Bresenham silently skips over. The
 * downstream renderer draws the segment as an ACTUAL straight line,
 * not a Bresenham approximation, so the walkability test has to
 * match that reality.
 *
 * Instead we oversample the segment at a fine sub-cell rate (4×
 * per cell length) and check the cell containing each sample. This
 * gives a genuinely conservative test — every cell the drawn line
 * visually enters is checked, so a shortcut can never sneak the
 * path through an obstacle.
 */
export function lineOfSight(
  grid: CompiledGrid,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len === 0) return !isBlocked(grid, ax, ay)
  const steps = Math.max(1, Math.ceil(len * 4))
  let lastCx = -1
  let lastCy = -1
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const x = ax + dx * t
    const y = ay + dy * t
    const cx = Math.floor(x)
    const cy = Math.floor(y)
    if (cx === lastCx && cy === lastCy) continue
    lastCx = cx
    lastCy = cy
    if (isBlocked(grid, cx, cy)) return false
  }
  return true
}

/**
 * Collapse the raw A* cell chain to the smallest set of waypoints
 * that describes the same walkable route. Classic "string-pulling"
 * / "funnel" simplification used by every modern navmesh:
 *
 *   1. Anchor = path[0].
 *   2. Walk forward; while `lineOfSight(anchor, path[i])` holds,
 *      keep going.
 *   3. When it fails, commit path[i-1] as a waypoint and reset
 *      anchor to path[i-1].
 *   4. Always commit the final vertex.
 *
 * On a warehouse with 34°-rotated racks this turns a 60-step
 * staircase along a diagonal aisle into two waypoints (aisle start,
 * aisle end), because line-of-sight holds down the full aisle.
 */
export function simplifyByLineOfSight(
  grid: CompiledGrid,
  cells: [number, number][],
): [number, number][] {
  if (cells.length <= 2) return cells.slice()
  const out: [number, number][] = [cells[0]]
  let anchor = 0
  for (let i = 2; i < cells.length; i++) {
    // The rendered polyline goes cell CENTRE to cell CENTRE (i.e.
    // (cx+0.5, cy+0.5) in fractional cell coords), NOT corner to
    // corner. Test the actual line the renderer will draw so we
    // never accept a shortcut that visually crosses a rack even
    // though the corner-space Bresenham said it was fine.
    const ax = cells[anchor][0] + 0.5
    const ay = cells[anchor][1] + 0.5
    const bx = cells[i][0] + 0.5
    const by = cells[i][1] + 0.5
    if (!lineOfSight(grid, ax, ay, bx, by)) {
      out.push(cells[i - 1])
      anchor = i - 1
    }
  }
  out.push(cells[cells.length - 1])
  return out
}

/**
 * Same string-pull as `simplifyByLineOfSight` but for FRACTIONAL cell
 * coordinates — used after `centreOnCorridor` shifts waypoints off
 * integer cells. No +0.5 offset added; the input coordinates are
 * already at their rendered positions.
 */
export function simplifyByLineOfSightFractional(
  grid: CompiledGrid,
  points: [number, number][],
): [number, number][] {
  if (points.length <= 2) return points.slice()
  const out: [number, number][] = [points[0]]
  let anchor = 0
  for (let i = 2; i < points.length; i++) {
    const [ax, ay] = points[anchor]
    const [bx, by] = points[i]
    if (!lineOfSight(grid, ax, ay, bx, by)) {
      out.push(points[i - 1])
      anchor = i - 1
    }
  }
  out.push(points[points.length - 1])
  return out
}

/** Encoded direction: 0=E, 1=S, 2=W, 3=N. Matches astar.ts DX/DY. */
function dirBetween(a: [number, number], b: [number, number]): 0 | 1 | 2 | 3 | -1 {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 1 && dy === 0) return 0
  if (dx === -1 && dy === 0) return 2
  if (dx === 0 && dy === 1) return 1
  if (dx === 0 && dy === -1) return 3
  return -1
}

/** Pass 1: collapse runs of consecutive identical direction into single segments. */
export function collapseCollinear(cells: [number, number][]): [number, number][] {
  if (cells.length < 3) return cells.slice()
  const out: [number, number][] = [cells[0]]
  let prevDir = dirBetween(cells[0], cells[1])
  for (let i = 1; i < cells.length - 1; i++) {
    const nextDir = dirBetween(cells[i], cells[i + 1])
    if (nextDir !== prevDir) {
      out.push(cells[i])
      prevDir = nextDir
    }
  }
  out.push(cells[cells.length - 1])
  return out
}

/**
 * Sample the distance transform at a fractional cell position via
 * bilinear interpolation. Returns 0 (worst) for out-of-bounds or
 * blocked cells. Used by the centring pass to score candidate
 * waypoint positions along the perpendicular sweep — bilinear is
 * enough smoother than nearest-neighbour that the "hill climb" for
 * the corridor midline lands on the true maximum, not on cell edges.
 */
function distAt(grid: CompiledGrid, x: number, y: number): number {
  if (!grid.dist) return 0
  const w = grid.width
  const h = grid.height
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 0
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = x0 + 1
  const y1 = y0 + 1
  const tx = x - x0
  const ty = y - y0
  const d = grid.dist
  const d00 = d[y0 * w + x0]
  const d10 = d[y0 * w + x1]
  const d01 = d[y1 * w + x0]
  const d11 = d[y1 * w + x1]
  return (
    d00 * (1 - tx) * (1 - ty) +
    d10 * tx * (1 - ty) +
    d01 * (1 - tx) * ty +
    d11 * tx * ty
  )
}

/**
 * Push every INTERIOR waypoint perpendicular to its local flow
 * direction, landing on the local maximum of the distance transform
 * — i.e. the middle of the corridor.
 *
 * This is what MazeMap / Situm / MapWize do to get the professional
 * "path floats down the corridor centre with sharp turns" look. The
 * DT already tells us, for each cell, how far it is to the nearest
 * obstacle; the corridor midline is exactly the ridge of that field.
 *
 * Algorithm per waypoint W_i:
 *   1. Compute normalized flow direction d = (W_{i+1} - W_{i-1}).
 *   2. Compute perpendicular unit vector p = (-d.y, d.x).
 *   3. Sweep offset α ∈ [-maxShift, +maxShift] at sub-cell resolution.
 *      Candidate C = W_i + α·p.
 *   4. Reject C if the line-of-sight from W_{i-1} → C or C → W_{i+1}
 *      is blocked (the shift can't create a path that crosses a rack).
 *   5. Score C by the bilinearly-sampled DT value at C.
 *   6. Keep the offset with the highest score.
 *
 * The endpoint waypoints (index 0 and length-1) are LEFT ALONE — they
 * are the user's click positions, moving them would be wrong.
 *
 * Operates in fractional cell coordinates. The output can have
 * non-integer cell positions; that's fine because the downstream
 * lng/lat conversion is via `fromLocal(frame, origin + (cx+0.5, cy+0.5)*cellSize)`
 * which handles fractional values.
 */
export function centreOnCorridor(
  grid: CompiledGrid,
  path: [number, number][],
  maxShiftCells = 8,
): [number, number][] {
  if (path.length < 3 || !grid.dist) return path.slice()
  // Convert integer cell coords → fractional "rendered position"
  // (cell centre = idx + 0.5). All shifts happen in this space, and
  // the downstream `cellsToLngLatFractional` expects the same
  // convention.
  const out = path.map((p) => [p[0] + 0.5, p[1] + 0.5] as [number, number])

  const STEP = 0.25

  for (let i = 1; i + 1 < out.length; i++) {
    const prev = out[i - 1]
    const cur = out[i]
    const next = out[i + 1]
    const dx = next[0] - prev[0]
    const dy = next[1] - prev[1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    const px = -dy / len
    const py = dx / len

    let bestOffset = 0
    let bestScore = distAt(grid, cur[0], cur[1])

    for (let sign = -1; sign <= 1; sign += 2) {
      let lastScoreThisDir = bestScore
      for (let step = STEP; step <= maxShiftCells; step += STEP) {
        const alpha = sign * step
        const cx = cur[0] + alpha * px
        const cy = cur[1] + alpha * py
        if (!lineOfSight(grid, prev[0], prev[1], cx, cy)) break
        if (!lineOfSight(grid, cx, cy, next[0], next[1])) break
        const score = distAt(grid, cx, cy)
        if (score > bestScore + 1e-6) {
          bestScore = score
          bestOffset = alpha
        }
        // Unimodal-DT optimisation: once the score drops noticeably
        // in this direction, stop — we've passed the local max.
        if (score < lastScoreThisDir - 0.15) break
        lastScoreThisDir = score
      }
    }

    if (bestOffset !== 0) {
      out[i] = [cur[0] + bestOffset * px, cur[1] + bestOffset * py]
    }
  }

  return out
}

/**
 * Pass 2 (deprecated, kept for compat): axis-aligned run centring.
 *
 * For every internal edge of the corner-only polyline we look at the
 * distance transform along the run and shift the run perpendicular
 * to itself so the run sits at the deepest walkable strip. In
 * practice this pushes the path from "1 cell off the wall" to "in
 * the middle of the aisle".
 *
 * The pass is conservative: it only accepts a shift when every cell
 * along the shifted run is walkable AND the shift never exceeds
 * `maxShiftCells` (so we don't reroute an obviously good path via
 * some far-away corridor).
 */
export function centreInCorridors(
  grid: CompiledGrid,
  cells: [number, number][],
  maxShiftCells = 6,
): [number, number][] {
  if (cells.length < 2 || !grid.dist) return cells.slice()
  const out = cells.map((c) => [c[0], c[1]] as [number, number])

  for (let i = 0; i + 1 < out.length; i++) {
    const [ax, ay] = out[i]
    const [bx, by] = out[i + 1]
    const dx = Math.sign(bx - ax)
    const dy = Math.sign(by - ay)
    if (dx !== 0 && dy !== 0) continue // diagonal shouldn't happen with 4-conn A*
    if (dx === 0 && dy === 0) continue // zero-length

    // Perpendicular axis to test shifts along.
    const perpAxis: 'x' | 'y' = dx === 0 ? 'x' : 'y'

    // Score a candidate offset by summing the distance-transform value
    // at every cell along the shifted run — higher = further from
    // walls. Reject if any cell along the run is blocked (this handles
    // the case where the corridor narrows partway).
    const scoreShift = (offset: number): number | null => {
      let sum = 0
      let x = ax
      let y = ay
      // Walk from A to B in unit steps.
      const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay))
      for (let s = 0; s <= steps; s++) {
        const cx = perpAxis === 'x' ? x + offset : x
        const cy = perpAxis === 'y' ? y + offset : y
        if (isBlocked(grid, cx, cy)) return null
        sum += grid.dist![cy * grid.width + cx]
        if (perpAxis === 'x') y += dy
        else x += dx
      }
      return sum / (steps + 1)
    }

    // Constrain the perpendicular endpoints. If they're corners
    // between two non-parallel edges we can only shift the middle,
    // not the endpoints — otherwise the neighbouring edges would
    // stop being right angles. So: figure out which endpoints are
    // "free to move" and only shift the whole run when BOTH are
    // free (or if this is the only segment).
    const canShiftStart =
      i === 0 || dirBetween(out[i - 1], out[i]) === dirBetween(out[i], out[i + 1])
    const canShiftEnd =
      i + 2 >= out.length || dirBetween(out[i + 1], out[i + 2]) === dirBetween(out[i], out[i + 1])
    if (!(canShiftStart && canShiftEnd)) continue

    let bestOffset = 0
    let bestScore = scoreShift(0) ?? -Infinity
    for (let off = -maxShiftCells; off <= maxShiftCells; off++) {
      if (off === 0) continue
      const s = scoreShift(off)
      if (s === null) continue
      if (s > bestScore + 1e-6) {
        bestScore = s
        bestOffset = off
      }
    }
    if (bestOffset !== 0) {
      if (perpAxis === 'x') {
        out[i] = [ax + bestOffset, ay]
        out[i + 1] = [bx + bestOffset, by]
      } else {
        out[i] = [ax, ay + bestOffset]
        out[i + 1] = [bx, by + bestOffset]
      }
    }
  }
  return out
}

/**
 * Convert an integer cell polyline back into a lng/lat polyline,
 * additionally snapping the two endpoint waypoints exactly to the
 * user-supplied lng/lat so the path renders precisely where the user
 * clicked (the A* endpoints are always cell centres).
 */
export function cellsToLngLat(
  grid: CompiledGrid,
  cells: [number, number][],
  startLL: [number, number],
  endLL: [number, number],
): [number, number][] {
  if (cells.length === 0) return [startLL, endLL]
  const out: [number, number][] = cells.map((c) => cellToLl(grid, c[0], c[1]))
  out[0] = startLL
  out[out.length - 1] = endLL
  return out
}

/**
 * Convert a FRACTIONAL cell polyline (points in the "rendered
 * position" convention, i.e. cell centre = idx + 0.5) back into a
 * lng/lat polyline. Used after the corridor-centring pass, which
 * produces sub-cell positions we need to preserve.
 */
export function cellsToLngLatFractional(
  grid: CompiledGrid,
  points: [number, number][],
  startLL: [number, number],
  endLL: [number, number],
): [number, number][] {
  if (points.length === 0) return [startLL, endLL]
  const out: [number, number][] = points.map((p) => {
    // The "rendered position" convention says a point at (x, y) sits
    // at (originX + x * cellSize, originY + y * cellSize) in local
    // metric. cellToLl adds an internal +0.5 offset (integer cell →
    // centre), so we compensate by subtracting 0.5 here.
    return cellToLl(grid, p[0] - 0.5, p[1] - 0.5)
  })
  out[0] = startLL
  out[out.length - 1] = endLL
  return out
}

/** Sum of great-circle-ish distances along a lng/lat polyline, in metres. */
export function polylineLengthMeters(pts: [number, number][]): number {
  if (pts.length < 2) return 0
  const R = 6378137
  const toRad = Math.PI / 180
  let total = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const [lng1, lat1] = pts[i]
    const [lng2, lat2] = pts[i + 1]
    const dLat = (lat2 - lat1) * toRad
    const dLng = (lng2 - lng1) * toRad
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2
    total += 2 * R * Math.asin(Math.sqrt(a))
  }
  return total
}
