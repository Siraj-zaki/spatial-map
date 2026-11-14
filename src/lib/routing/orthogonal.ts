/**
 * Orthogonal path post-process — turns the raw A* cell chain into the
 * route a person would draw on the plan: straight runs parallel to the
 * walls, right-angle turns, through the middle of every door and down the
 * middle of every corridor.
 *
 * Works in fractional cell coordinates ("rendered" convention: cell centre
 * = index + 0.5) on a grid that is already turned to the building's axis
 * (projection.ts), so "parallel to the walls" means "horizontal or
 * vertical" here.
 *
 *   1. Collapse the 4-connected chain to its corners.
 *   2. Smooth real staircases only — runs of tiny steps along a diagonal
 *      or curved wall become one straight segment when nothing blocks it.
 *      Everything else stays orthogonal (no any-angle shortcuts across
 *      rooms).
 *   3. Put the exact start / end on the path, keeping the first and last
 *      runs straight.
 *   4. Doors: a run that passes a door is split so the door gets its own
 *      straight piece reaching `clear` either side, and that piece is
 *      locked onto the door's centre line.
 *   5. Corridors: every other run of reasonable length moves to the middle
 *      of the free space either side of it (median of perpendicular scans),
 *      unless that space is wider than `openSpan` (a room or hall — no
 *      "middle" worth following there).
 *   6. Doors get room: a turn closer than `clear` after a door moves out
 *      to `clear`, so the route visibly walks straight through.
 *   7. Small zig-zags (two parallel runs joined by a short step) merge
 *      onto one line — the door's line when one of them is a door run.
 *
 * Every move goes through `setLane`, which keeps right angles (it moves a
 * shared corner when the neighbouring run is perpendicular, and adds a
 * perpendicular step when it is parallel or a fixed end), and is only
 * kept when the whole path stays walkable.
 */

import type { CompiledGrid } from './occupancy-grid.ts'
import { isBlocked } from './occupancy-grid.ts'
import { collapseCollinear, lineOfSight } from './postprocess.ts'

type Pt = [number, number]
type Axis = 'h' | 'v' | 'd'

export interface OrthogonalOptions {
  /** Widest space (metres) whose middle a run is pulled into. Default 8 m. */
  openSpanMeters?: number
  /** Straight walk either side of a door, past its opening (metres). Default 0.6 m. */
  doorClearMeters?: number
  /** Steps shorter than this (metres) between parallel runs are merged away
   *  (twice as long when one of the runs goes through a door). Default 1.5 m. */
  maxJogMeters?: number
}

const EPS = 1e-3

function axisOf(a: Pt, b: Pt): Axis {
  const dx = Math.abs(b[0] - a[0])
  const dy = Math.abs(b[1] - a[1])
  if (dy <= EPS) return 'h'
  if (dx <= EPS) return 'v'
  return 'd'
}

/** Across-the-run coordinate (y for a horizontal run, x for a vertical one). */
const across = (p: Pt, axis: 'h' | 'v'): number => (axis === 'h' ? p[1] : p[0])
/** Along-the-run coordinate. */
const along = (p: Pt, axis: 'h' | 'v'): number => (axis === 'h' ? p[0] : p[1])
const withAcross = (p: Pt, axis: 'h' | 'v', v: number): Pt => (axis === 'h' ? [p[0], v] : [v, p[1]])
const withAlong = (p: Pt, axis: 'h' | 'v', v: number): Pt => (axis === 'h' ? [v, p[1]] : [p[0], v])

function walkable(grid: CompiledGrid, pts: Pt[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    if (!lineOfSight(grid, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])) return false
  }
  return true
}

/** Drop repeated points and middle points of straight runs. */
function tidy(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - p[0]) < 0.02 && Math.abs(last[1] - p[1]) < 0.02) continue
    out.push([p[0], p[1]])
  }
  for (let i = 1; i + 1 < out.length; ) {
    const a = axisOf(out[i - 1], out[i])
    const b = axisOf(out[i], out[i + 1])
    if (a !== 'd' && a === b) out.splice(i, 1)
    else i++
  }
  return out
}

/**
 * Move run k (pts[k] → pts[k+1]) onto `lane` (its across coordinate) and
 * keep every turn a right angle. At each end of the run: a corner shared
 * with a perpendicular run just moves; at a fixed end (start / end of the
 * route) or next to a parallel run, a perpendicular step is added.
 * Returns the new point list, or null when the result is not walkable.
 */
function setLane(grid: CompiledGrid, pts: Pt[], k: number, lane: number): Pt[] | null {
  const a = pts[k]
  const b = pts[k + 1]
  const axis = axisOf(a, b)
  if (axis === 'd') return null
  if (Math.abs(across(a, axis) - lane) < 0.02) return pts
  const last = pts.length - 1

  const head: Pt[] = pts.slice(0, k)
  const tail: Pt[] = pts.slice(k + 2)
  const mid: Pt[] = []

  // Start of the run.
  const prevAxis = k > 0 ? axisOf(pts[k - 1], a) : null
  if (k > 0 && prevAxis !== axis && prevAxis !== 'd') {
    mid.push(withAcross(a, axis, lane))
  } else {
    mid.push(a, withAcross(a, axis, lane))
  }
  // End of the run.
  const nextAxis = k + 1 < last ? axisOf(b, pts[k + 2]) : null
  if (k + 1 < last && nextAxis !== axis && nextAxis !== 'd') {
    mid.push(withAcross(b, axis, lane))
  } else {
    mid.push(withAcross(b, axis, lane), b)
  }
  const next = tidy([...head, ...mid, ...tail])
  return walkable(grid, next) ? next : null
}

/**
 * Try `lane`, then partial moves toward it; the first walkable one wins.
 * A run that starts or ends at the route's fixed start / end stays on that
 * point's line when the lane is within `endSnap` of it — a 20 cm step out
 * of the click point reads as noise, not as centring.
 */
function moveLane(grid: CompiledGrid, pts: Pt[], k: number, lane: number, endSnap = 0): Pt[] {
  const axis = axisOf(pts[k], pts[k + 1])
  if (axis === 'd') return pts
  const from = across(pts[k], axis)
  const last = pts.length - 1
  for (const fixed of [k === 0 ? pts[0] : null, k + 1 === last ? pts[last] : null]) {
    if (fixed && Math.abs(across(fixed, axis) - lane) < endSnap) lane = across(fixed, axis)
  }
  for (const f of [1, 0.75, 0.5, 0.25]) {
    const r = setLane(grid, pts, k, from + (lane - from) * f)
    if (r) return r
  }
  return pts
}

interface Door {
  /** Axis of the runs that pass through it (perpendicular to its wall). */
  passAxis: 'h' | 'v'
  /** The door centre. */
  c: Pt
  /** Half the opening width, in cells. */
  half: number
}

function doorsOf(grid: CompiledGrid): Door[] {
  return (grid.doors ?? []).map(({ a, b }) => {
    const dx = Math.abs(b[0] - a[0])
    const dy = Math.abs(b[1] - a[1])
    return {
      // A mouth running along y sits in a vertical wall: horizontal runs pass it.
      passAxis: dy >= dx ? 'h' : 'v',
      c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Pt,
      half: Math.hypot(b[0] - a[0], b[1] - a[1]) / 2,
    }
  })
}

/** The door run k passes through, if any. */
function doorOn(pts: Pt[], k: number, doors: Door[], reach: number): Door | null {
  const a = pts[k]
  const b = pts[k + 1]
  const axis = axisOf(a, b)
  if (axis === 'd') return null
  const lo = Math.min(along(a, axis), along(b, axis))
  const hi = Math.max(along(a, axis), along(b, axis))
  const lane = across(a, axis)
  let best: Door | null = null
  let bestD = Infinity
  for (const d of doors) {
    if (d.passAxis !== axis) continue
    const t = along(d.c, axis)
    if (t < lo - 0.25 || t > hi + 0.25) continue
    // The walkable opening is a little wider than the mouth (cells are
    // filled when they touch it), so a run near a jamb still counts.
    const off = Math.abs(lane - across(d.c, axis))
    if (off > d.half + reach || off >= bestD) continue
    best = d
    bestD = off
  }
  return best
}

/**
 * Middle of the free space across run k, from perpendicular scans along
 * it (median, so a column or a door gap on one side doesn't drag it).
 * Null when the run is short, or most of it runs through open space.
 */
function corridorLane(grid: CompiledGrid, pts: Pt[], k: number, maxScan: number, openSpan: number): number | null {
  const a = pts[k]
  const b = pts[k + 1]
  const axis = axisOf(a, b)
  if (axis === 'd') return null
  const t0 = Math.min(along(a, axis), along(b, axis))
  const t1 = Math.max(along(a, axis), along(b, axis))
  if (t1 - t0 < 3) return null
  const lane = across(a, axis)
  const margin = Math.min(4, (t1 - t0) * 0.25)
  const mids: number[] = []
  let samples = 0
  const blocked = (t: number, c: number) => {
    const p = axis === 'h' ? [t, c] : [c, t]
    return isBlocked(grid, Math.floor(p[0]), Math.floor(p[1]))
  }
  for (let t = t0 + margin; t <= t1 - margin + 1e-9; t += 1) {
    samples++
    let up = -1
    let down = -1
    for (let s = 0.5; s <= maxScan; s += 0.5) {
      if (up < 0 && blocked(t, lane + s)) up = s
      if (down < 0 && blocked(t, lane - s)) down = s
      if (up >= 0 && down >= 0) break
    }
    if (up < 0 || down < 0 || up + down > openSpan) continue
    mids.push(lane + (up - down) / 2)
  }
  if (samples === 0 || mids.length < samples * 0.5) return null
  mids.sort((x, y) => x - y)
  return mids[Math.floor(mids.length / 2)]
}

/** Unit step direction of a run: [sign x, sign y]. */
function stepDir(a: Pt, b: Pt): [number, number] {
  return [Math.sign(Math.round((b[0] - a[0]) * 100)), Math.sign(Math.round((b[1] - a[1]) * 100))]
}

/**
 * A staircase is ≥ 4 runs alternating between two perpendicular
 * directions while heading steadily one way (right, up, right, up …) —
 * what a 4-connected search makes of a diagonal or curved corridor. Within
 * each staircase, straight chords replace the steps wherever nothing
 * blocks them (greedy: the farthest corner still in sight). Orthogonal
 * routes have no such runs, so they are left exactly as they are.
 */
function smoothStaircases(grid: CompiledGrid, pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]]
  let i = 0
  while (i < pts.length - 1) {
    // Extend the alternating run from i.
    let j = i + 1
    if (i + 2 < pts.length) {
      const d0 = stepDir(pts[i], pts[i + 1])
      const d1 = stepDir(pts[i + 1], pts[i + 2])
      const perpendicular = d0[0] * d1[0] + d0[1] * d1[1] === 0
      if (perpendicular) {
        j = i + 2
        while (j + 1 < pts.length) {
          const want = (j - i) % 2 === 0 ? d0 : d1
          const got = stepDir(pts[j], pts[j + 1])
          if (got[0] !== want[0] || got[1] !== want[1]) break
          j++
        }
      }
    }
    if (j - i < 4) {
      out.push(pts[i + 1])
      i++
      continue
    }
    // Greedy chords through the staircase i..j.
    let a = i
    while (a < j) {
      let b = j
      while (b > a + 1 && !lineOfSight(grid, pts[a][0], pts[a][1], pts[b][0], pts[b][1])) b--
      out.push(pts[b])
      a = b
    }
    i = j
  }
  return out
}

export function orthogonalPath(
  grid: CompiledGrid,
  cells: [number, number][],
  start: Pt,
  end: Pt,
  opts: OrthogonalOptions = {},
): Pt[] {
  const cs = grid.cellSize
  const openSpan = (opts.openSpanMeters ?? 8) / cs
  const maxScan = openSpan
  const maxJog = (opts.maxJogMeters ?? 1.5) / cs
  const endSnap = 0.5 / cs
  const clear = (grid.doorDepthCells ?? 0) + (opts.doorClearMeters ?? 0.6) / cs
  const doors = doorsOf(grid)
  const reach = 0.75 / cs

  // 1–2. Corners, real staircases smoothed.
  let pts: Pt[] = collapseCollinear(cells).map((c) => [c[0] + 0.5, c[1] + 0.5] as Pt)
  pts = smoothStaircases(grid, pts)

  // 3. Exact ends, first and last runs kept straight.
  if (pts.length < 2) return [start, end]
  pts[0] = start
  pts[pts.length - 1] = end
  pts = alignEnd(grid, pts)
  pts = alignEnd(grid, pts.slice().reverse()).reverse()

  // 4. Door runs: split, then lock onto the door centre line.
  for (let k = 0; k + 1 < pts.length; k++) {
    const d = doorOn(pts, k, doors, reach)
    if (!d) continue
    const axis = axisOf(pts[k], pts[k + 1]) as 'h' | 'v'
    const t = along(d.c, axis)
    const ta = along(pts[k], axis)
    const tb = along(pts[k + 1], axis)
    const dir = Math.sign(tb - ta)
    const inner: Pt[] = []
    for (const cut of [t - dir * clear, t + dir * clear]) {
      if ((cut - ta) * dir > 0.25 && (tb - cut) * dir > 0.25) inner.push(withAlong(pts[k], axis, cut))
    }
    if (inner.length) {
      pts = [...pts.slice(0, k + 1), ...inner, ...pts.slice(k + 1)]
      // The door piece is the one containing t.
      while (k + 1 < pts.length && (along(pts[k + 1], axis) - t) * dir < 0) k++
    }
    pts = moveLane(grid, pts, k, across(d.c, axis))
  }

  // 5. Corridor runs to the middle.
  for (let k = 0; k + 1 < pts.length; k++) {
    if (doorOn(pts, k, doors, reach)) continue
    const lane = corridorLane(grid, pts, k, maxScan, openSpan)
    if (lane !== null) pts = moveLane(grid, pts, k, lane, endSnap)
  }

  // 6. Room either side of a door before the next turn.
  for (let k = 0; k + 1 < pts.length; k++) {
    const d = doorOn(pts, k, doors, reach)
    if (!d) continue
    const axis = axisOf(pts[k], pts[k + 1]) as 'h' | 'v'
    const t = along(d.c, axis)
    for (const end of [k, k + 1]) {
      if (end === 0 || end === pts.length - 1) continue
      const p = pts[end]
      const gap = along(p, axis) - t
      if (Math.abs(gap) >= clear - 0.05) continue
      // The turn at `end` is the perpendicular run next to this one.
      const nk = end === k ? k - 1 : k + 1
      if (nk < 0 || nk + 1 >= pts.length || axisOf(pts[nk], pts[nk + 1]) === axis) continue
      const target = t + (gap >= 0 ? clear : -clear)
      pts = moveLane(grid, pts, nk, target)
    }
  }

  // 7. Small zig-zags onto one line.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    for (let k = 0; k + 3 < pts.length; k++) {
      const a1 = axisOf(pts[k], pts[k + 1])
      const a2 = axisOf(pts[k + 1], pts[k + 2])
      const a3 = axisOf(pts[k + 2], pts[k + 3])
      if (a1 === 'd' || a1 !== a3 || a2 === a1 || a2 === 'd') continue
      const step = Math.hypot(pts[k + 2][0] - pts[k + 1][0], pts[k + 2][1] - pts[k + 1][1])
      const d1 = doorOn(pts, k, doors, reach)
      const d3 = doorOn(pts, k + 2, doors, reach)
      if (d1 && d3) continue
      // Lining a run up with a door is worth a longer step.
      if (step > (d1 || d3 ? maxJog * 2 : maxJog)) continue
      // Move the run that is not a door run; else the shorter one.
      const len = (i: number) => Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
      const moveFirst = d3 ? true : d1 ? false : len(k) <= len(k + 2)
      const target = moveFirst ? across(pts[k + 2], a1) : across(pts[k], a1)
      const r = setLane(grid, pts, moveFirst ? k : k + 2, target)
      if (r && r.length < pts.length) {
        pts = r
        changed = true
      }
    }
    if (!changed) break
  }

  // 8. A sliver next to a diagonal (where a staircase chord meets the
  // orthogonal part) folds into the diagonal.
  pts = tidy(pts)
  for (let k = 1; k + 1 < pts.length - 1; ) {
    const short = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) < 0.4 / cs
    const nearDiag =
      axisOf(pts[k - 1], pts[k]) === 'd' || (k + 2 < pts.length && axisOf(pts[k + 1], pts[k + 2]) === 'd')
    if (short && nearDiag) {
      const dropA = [...pts.slice(0, k), ...pts.slice(k + 1)]
      const dropB = [...pts.slice(0, k + 1), ...pts.slice(k + 2)]
      if (walkable(grid, dropB)) { pts = tidy(dropB); continue }
      if (walkable(grid, dropA)) { pts = tidy(dropA); continue }
    }
    k++
  }
  return pts
}

/**
 * The exact start sits off the first corner's cell centre by up to half a
 * cell; line the first run up with it (move the corner, or add a short
 * step) so it stays parallel to the walls.
 */
function alignEnd(grid: CompiledGrid, pts: Pt[]): Pt[] {
  if (pts.length < 2) return pts
  const [s, p1] = pts
  const dx = Math.abs(p1[0] - s[0])
  const dy = Math.abs(p1[1] - s[1])
  if (dx <= EPS || dy <= EPS) return pts
  if (pts.length === 2) {
    // Straight start → end: one right-angle turn, whichever corner is free.
    for (const c of [[p1[0], s[1]], [s[0], p1[1]]] as Pt[]) {
      const r = [s, c, p1]
      if (walkable(grid, r)) return r
    }
    return pts
  }
  const axis: 'h' | 'v' = dx >= dy ? 'h' : 'v'
  const moved = withAcross(p1, axis, across(s, axis))
  const nextAxis = axisOf(p1, pts[2])
  const r: Pt[] =
    nextAxis !== axis && nextAxis !== 'd'
      ? [s, moved, ...pts.slice(2)]
      : [s, moved, p1, ...pts.slice(2)]
  return walkable(grid, r) ? tidy(r) : pts
}
