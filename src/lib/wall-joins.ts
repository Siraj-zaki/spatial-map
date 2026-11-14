/**
 * Where walls and aisles meet.
 *
 * Lines are drawn one at a time, so their ends rarely land on each other:
 * a corner is left with a gap or an overshoot, a wall meant to butt into
 * another stops short or pokes through it, and every wall used to be a
 * round-capped buffer with its own outline — a disc and two crossing
 * borders at every joint.
 *
 * `joinLines` closes those joints for drawing (stored vertices are never
 * touched):
 *   1. Ends within reach of each other move to the corner their lines
 *      meet at (two ends) or to their middle (three or more).
 *   2. An end within reach of another line's side runs on, or is trimmed
 *      back, to that line's centre line (a T). When the spot it lands on
 *      is next to that line's own free end, both become one corner.
 *   3. Each wall's footprint has square ends, rounded outside corners
 *      (its own bends and a two-wall corner; the radius eases between two
 *      thicknesses), fillets in the inside corners of a T and of three or
 *      more walls meeting (rounded outside their convex gaps), a stem cut
 *      along the centre line it stops on, and loses whatever a wall that
 *      contains it in height already covers (taller first, then thicker,
 *      then older; a stem always gives way to the wall it stops on), so
 *      neighbours abut instead of overlapping. Where the two walls of a
 *      corner (or a stem and the wall it stops on) differ in height, the
 *      taller one runs through to the other's far side and the lower one
 *      butts into it: a plain step, tall wall and short wall.
 *
 * `wallOutlines` then traces the outer edge of each group of touching
 * walls of the same roof height once, so a joint draws one border. Each
 * stretch belongs to the wall whose side it runs along (its colour and
 * width).
 *
 * "Within reach": `MIN_REACH`, or 1.5 × the thicker wall — less than a
 * door gap, so a doorway left open between two wall ends stays open.
 * Lines only join lines on the same floor plan, of the same kind (wall
 * with wall, flat line with flat line) and overlapping in height.
 */

import { difference as turfDifference, featureCollection, polygon as turfPolygon, union as turfUnion } from '@turf/turf'
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson'

type LngLat = [number, number]
type XY = [number, number]

const METERS_PER_DEG = 111_320
const MIN_REACH = 0.25
const REACH_THICKNESS = 1.5
/** Closer to parallel than this (sin 8°), two lines make no corner. */
const MIN_SIN = Math.sin((8 * Math.PI) / 180)
/** A cut corner farther than this many half-widths from its joint isn't cut. */
const MITRE_LIMIT = 4
/** Vertices closer than this (m) are one point. */
const SAME_POINT = 1e-3
/** Height slack (m) when comparing wall bottoms and tops. */
const Z_EPS = 0.01

export interface JoinLine {
  id: number
  /** As drawn, rotation applied. */
  vertices: LngLat[]
  /** Half the wall thickness (m); 0 for a flat line. */
  halfWidth: number
  /** Bottom and top (absolute m); equal for a flat line. */
  low: number
  high: number
  floor?: number | null
}

export interface LineJoins {
  /** Every line's vertices with its joints closed. */
  vertices: Map<number, LngLat[]>
  /** Every wall's footprint (lines with `halfWidth > 0`). */
  footprints: Map<number, Polygon | MultiPolygon>
}

export interface OutlineWall {
  id: number
  geometry: Polygon | MultiPolygon
  /** Roof height (m): walls only share a border with walls of the same. */
  top: number
}

export interface OutlineRun {
  /** The wall this stretch of border runs along. */
  id: number
  coordinates: LngLat[]
}

// ---- Vector helpers (metres) -------------------------------------------

const add = (a: XY, b: XY): XY => [a[0] + b[0], a[1] + b[1]]
const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]]
const mul = (a: XY, k: number): XY => [a[0] * k, a[1] * k]
const dot = (a: XY, b: XY) => a[0] * b[0] + a[1] * b[1]
const cross = (a: XY, b: XY) => a[0] * b[1] - a[1] * b[0]
const len = (a: XY) => Math.hypot(a[0], a[1])
const unit = (a: XY): XY => {
  const l = len(a)
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 0]
}
/** Left-hand normal. */
const perp = (a: XY): XY => [-a[1], a[0]]

/** Where `p + s·d` meets `q + t·e`, or null when parallel. */
function meet(p: XY, d: XY, q: XY, e: XY): { pt: XY; s: number; t: number } | null {
  const c = cross(d, e)
  if (Math.abs(c) < 1e-12) return null
  const w = sub(q, p)
  const s = cross(w, e) / c
  return { pt: add(p, mul(d, s)), s, t: cross(w, d) / c }
}

function segDistance(p: XY, a: XY, b: XY): number {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0
  return len(sub(p, add(a, mul(ab, t))))
}

function convexHull(points: XY[]): XY[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const half = (list: XY[]) => {
    const h: XY[] = []
    for (const p of list) {
      while (h.length >= 2 && cross(sub(h[h.length - 1], h[h.length - 2]), sub(p, h[h.length - 2])) <= 0) h.pop()
      h.push(p)
    }
    h.pop()
    return h
  }
  return [...half(pts), ...half([...pts].reverse())]
}

function ringArea(ring: XY[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) a += cross(ring[i], ring[(i + 1) % ring.length])
  return Math.abs(a) / 2
}

/** Flat-earth metres around one origin — exact enough at building scale. */
function projector(origin: Position) {
  const [lng0, lat0] = origin
  const kx = METERS_PER_DEG * Math.cos((lat0 * Math.PI) / 180)
  return {
    to: (p: Position): XY => [(p[0] - lng0) * kx, (p[1] - lat0) * METERS_PER_DEG],
    from: (p: XY): LngLat => [lng0 + p[0] / kx, lat0 + p[1] / METERS_PER_DEG],
  }
}

type Box = [number, number, number, number]
const boxOf = (pts: XY[], pad = 0): Box => {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of pts) {
    if (x < b[0]) b[0] = x
    if (y < b[1]) b[1] = y
    if (x > b[2]) b[2] = x
    if (y > b[3]) b[3] = y
  }
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]
}
const boxesMeet = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
const boxHas = (b: Box, p: XY, pad = 0) => p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad

class Sets {
  private parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]]
    return i
  }
  join(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b)
  }
}

// ---- Joining -------------------------------------------------------------

interface Item {
  line: JoinLine
  pts: XY[]
  closed: boolean
  moved: boolean
}

type At = 0 | 1
interface EndRef {
  item: number
  at: At
}

type Joint =
  | { kind: 'pair'; item: number; at: At }
  | { kind: 'node'; pieces: XY[][] }
  | { kind: 'tee'; a: XY; b: XY; item: number }

const sameFloor = (a: JoinLine, b: JoinLine) => (a.floor ?? null) === (b.floor ?? null)

function canJoin(a: JoinLine, b: JoinLine): boolean {
  return sameFloor(a, b) && a.halfWidth > 0 === b.halfWidth > 0 && a.low <= b.high + Z_EPS && b.low <= a.high + Z_EPS
}

function reach(a: JoinLine, b: JoinLine): number {
  return Math.max(MIN_REACH, REACH_THICKNESS * 2 * Math.max(a.halfWidth, b.halfWidth))
}

function endPoint(it: Item, at: At): XY {
  return at === 0 ? it.pts[0] : it.pts[it.pts.length - 1]
}

/** The vertex next to an end — the end segment's other point. */
function endNeighbour(it: Item, at: At): XY {
  return at === 0 ? it.pts[1] : it.pts[it.pts.length - 2]
}

/** Unit direction pointing out of the line at an end, and that segment's length. */
function endRay(it: Item, at: At): { p: XY; dir: XY; seg: number } {
  const p = endPoint(it, at)
  const d = sub(p, endNeighbour(it, at))
  return { p, dir: unit(d), seg: len(d) }
}

/** Moves an end, unless that would turn its segment round. */
function canMove(it: Item, at: At, to: XY): boolean {
  const q = endNeighbour(it, at)
  return dot(sub(to, q), sub(endPoint(it, at), q)) > 0 && len(sub(to, q)) > SAME_POINT
}

function moveEnd(it: Item, at: At, to: XY) {
  it.pts[at === 0 ? 0 : it.pts.length - 1] = to
  it.moved = true
}

const keyOf = (item: number, at: At) => `${item}:${at}`

function cleanPoints(pts: XY[]): XY[] {
  const out: XY[] = []
  for (const p of pts) if (!out.length || len(sub(p, out[out.length - 1])) > SAME_POINT) out.push(p)
  return out
}

/** Closes the joints between lines and builds the walls' footprints (see the file header). */
export function joinLines(lines: ReadonlyArray<JoinLine>): LineJoins {
  const vertices = new Map<number, LngLat[]>()
  const footprints = new Map<number, Polygon | MultiPolygon>()
  for (const l of lines) vertices.set(l.id, l.vertices)
  const origin = lines.find((l) => l.vertices.length)?.vertices[0]
  if (!origin) return { vertices, footprints }
  const proj = projector(origin)

  const items: Item[] = []
  for (const line of lines) {
    const pts = cleanPoints(line.vertices.map(proj.to))
    if (pts.length < 2) continue
    const closed = pts.length >= 4 && len(sub(pts[0], pts[pts.length - 1])) <= SAME_POINT
    if (closed) pts[pts.length - 1] = pts[0]
    items.push({ line, pts, closed, moved: false })
  }
  const boxes = items.map((it) => boxOf(it.pts))
  const joints = new Map<string, Joint>()

  // 1. Ends within reach of each other: nearest pairs first. Both ends of
  //    one line only meet as a loop's closing corner (three corners or more).
  const ends: EndRef[] = []
  items.forEach((it, i) => {
    if (it.closed) return
    ends.push({ item: i, at: 0 }, { item: i, at: 1 })
  })
  const close: Array<{ a: number; b: number; d: number }> = []
  for (let a = 0; a < ends.length; a++) {
    const ea = ends[a]
    const la = items[ea.item].line
    const pa = endPoint(items[ea.item], ea.at)
    for (let b = a + 1; b < ends.length; b++) {
      const eb = ends[b]
      if (ea.item === eb.item && items[ea.item].pts.length < 4) continue
      const lb = items[eb.item].line
      if (ea.item !== eb.item && !canJoin(la, lb)) continue
      const d = len(sub(pa, endPoint(items[eb.item], eb.at)))
      if (d <= reach(la, lb)) close.push({ a, b, d })
    }
  }
  close.sort((x, y) => x.d - y.d)
  const sets = new Sets(ends.length)
  const members = new Map<number, Set<number>>(ends.map((e, i) => [i, new Set([e.item])]))
  for (const { a, b } of close) {
    const ra = sets.find(a)
    const rb = sets.find(b)
    if (ra === rb) continue
    const ma = members.get(ra)!
    const mb = members.get(rb)!
    const twice = [...ma].some((i) => mb.has(i) && items[i].pts.length < 4)
    if (twice) continue
    sets.join(ra, rb)
    const root = sets.find(ra)
    members.set(root, new Set([...ma, ...mb]))
  }
  const clusters = new Map<number, EndRef[]>()
  ends.forEach((e, i) => {
    const r = sets.find(i)
    clusters.set(r, [...(clusters.get(r) ?? []), e])
  })
  for (const group of clusters.values()) {
    if (group.length < 2) continue
    let target: XY
    if (group.length === 2) {
      const [ea, eb] = group
      const ia = items[ea.item]
      const ib = items[eb.item]
      const ra = endRay(ia, ea.at)
      const rb = endRay(ib, eb.at)
      const r = reach(ia.line, ib.line)
      const m = Math.abs(cross(ra.dir, rb.dir)) >= MIN_SIN ? meet(ra.p, ra.dir, rb.p, rb.dir) : null
      target =
        m && Math.abs(m.s) <= 2 * r && Math.abs(m.t) <= 2 * r
          ? m.pt
          : mul(add(ra.p, rb.p), 0.5)
    } else {
      target = mul(group.reduce<XY>((s, e) => add(s, endPoint(items[e.item], e.at)), [0, 0]), 1 / group.length)
    }
    if (!group.every((e) => canMove(items[e.item], e.at, target))) continue
    for (const e of group) moveEnd(items[e.item], e.at, target)
    if (group.length === 2) {
      const [ea, eb] = group
      if (ea.item === eb.item) {
        items[ea.item].closed = true
        continue
      }
      joints.set(keyOf(ea.item, ea.at), { kind: 'pair', item: eb.item, at: eb.at })
      joints.set(keyOf(eb.item, eb.at), { kind: 'pair', item: ea.item, at: ea.at })
    } else {
      const corners: XY[] = [target]
      for (const e of group) {
        const it = items[e.item]
        const n = perp(unit(sub(endNeighbour(it, e.at), target)))
        corners.push(add(target, mul(n, it.line.halfWidth)), sub(target, mul(n, it.line.halfWidth)))
      }
      // The middle, then each gap between neighbouring walls (by angle):
      // rounded outside a convex gap, filleted inside a concave one — the
      // same look as a two-wall corner, all the way round.
      const pieces: XY[][] = [convexHull(corners)]
      const arms = group
        .map((e) => {
          const toward = sub(endNeighbour(items[e.item], e.at), target)
          return { w: unit(toward), h: items[e.item].line.halfWidth, len: len(toward) }
        })
        .sort((a, b) => Math.atan2(a.w[1], a.w[0]) - Math.atan2(b.w[1], b.w[0]))
      arms.forEach((a, k) => {
        const b = arms[(k + 1) % arms.length]
        let gap = Math.atan2(b.w[1], b.w[0]) - Math.atan2(a.w[1], a.w[0])
        if (gap <= 0) gap += 2 * Math.PI
        if (gap > Math.PI + 0.05) pushRound(pieces, target, a.w, a.h, b.w, b.h)
        else if (gap < Math.PI - 0.05) {
          const c = meet(add(target, mul(perp(a.w), a.h)), a.w, sub(target, mul(perp(b.w), b.h)), b.w)
          if (c) pushFillet(pieces, c.pt, a.w, b.w, Math.min(a.h, b.h), 0.45 * Math.min(a.len, b.len))
        }
      })
      for (const e of group) joints.set(keyOf(e.item, e.at), { kind: 'node', pieces })
    }
  }

  // 2. A free end within reach of another line's side: on to its centre line.
  for (const e of ends) {
    if (joints.has(keyOf(e.item, e.at))) continue
    const it = items[e.item]
    if (it.closed) continue
    const ray = endRay(it, e.at)
    let best: { pt: XY; s: number; j: number; k: number; u: number } | null = null
    for (let j = 0; j < items.length; j++) {
      if (j === e.item) continue
      const other = items[j]
      if (!canJoin(it.line, other.line)) continue
      const r = reach(it.line, other.line)
      if (!boxHas(boxes[j], ray.p, 2 * r + other.line.halfWidth)) continue
      for (let k = 0; k + 1 < other.pts.length; k++) {
        const a = other.pts[k]
        const ab = sub(other.pts[k + 1], a)
        const l = len(ab)
        if (l <= SAME_POINT || Math.abs(cross(ray.dir, ab)) < MIN_SIN * l) continue
        const m = meet(ray.p, ray.dir, a, ab)
        if (!m || m.t < -1e-9 || m.t > 1 + 1e-9) continue
        if (m.s > r || m.s < -(r + other.line.halfWidth) || -m.s >= 0.5 * ray.seg) continue
        if (!best || Math.abs(m.s) < Math.abs(best.s)) best = { pt: m.pt, s: m.s, j, k, u: m.t }
      }
    }
    if (!best || !canMove(it, e.at, best.pt)) continue
    const other = items[best.j]
    const lastSeg = other.pts.length - 2
    // Landing next to the other line's own free end: one corner, both trimmed.
    const corner = !other.closed
      ? ([0, 1] as At[]).find(
          (at) =>
            (at === 0 ? best!.k === 0 : best!.k === lastSeg) &&
            !joints.has(keyOf(best!.j, at)) &&
            len(sub(endPoint(other, at), best!.pt)) <= reach(it.line, other.line) + it.line.halfWidth &&
            canMove(other, at, best!.pt),
        )
      : undefined
    moveEnd(it, e.at, best.pt)
    if (corner !== undefined) {
      moveEnd(other, corner, best.pt)
      joints.set(keyOf(e.item, e.at), { kind: 'pair', item: best.j, at: corner })
      joints.set(keyOf(best.j, corner), { kind: 'pair', item: e.item, at: e.at })
    } else {
      joints.set(keyOf(e.item, e.at), { kind: 'tee', a: other.pts[best.k], b: other.pts[best.k + 1], item: best.j })
    }
  }

  for (const it of items) if (it.moved) vertices.set(it.line.id, it.pts.map(proj.from))

  // 3. Footprints, then overlaps taken off the lesser wall.
  const raw = new Map<number, Polygon | MultiPolygon>()
  const walls: number[] = []
  items.forEach((it, i) => {
    if (it.line.halfWidth <= 0) return
    const rings = wallPieces(items, i, joints)
    const geom = mergeRings(rings.map((r) => r.map(proj.from)))
    if (!geom) return
    raw.set(it.line.id, geom)
    walls.push(i)
  })
  const wallBoxes = new Map(walls.map((i) => [i, boxOf(items[i].pts, items[i].line.halfWidth * MITRE_LIMIT)]))
  const order = [...walls].sort((a, b) => {
    const la = items[a].line
    const lb = items[b].line
    return lb.high - la.high || la.low - lb.low || lb.halfWidth - la.halfWidth || la.id - lb.id
  })
  // A stem always butts into the wall it stops on (same height), whatever
  // their ranks: cut the other way, the wall would lose a notch.
  const stemOn = new Map<number, Set<number>>()
  for (const [key, joint] of joints) {
    if (joint.kind !== 'tee') continue
    const i = Number(key.split(':')[0])
    if (Math.abs(items[i].line.high - items[joint.item].line.high) > Z_EPS) continue
    stemOn.set(i, (stemOn.get(i) ?? new Set()).add(joint.item))
  }
  const rankOf = new Map(order.map((i, r) => [i, r]))
  order.forEach((i) => {
    const line = items[i].line
    const own = raw.get(line.id)!
    const cutters: Feature<Polygon | MultiPolygon>[] = []
    for (const j of walls) {
      if (j === i) continue
      const o = items[j].line
      if (!sameFloor(line, o) || o.low > line.low + Z_EPS || o.high < line.high - Z_EPS) continue
      if (!boxesMeet(wallBoxes.get(i)!, wallBoxes.get(j)!)) continue
      const cuts = stemOn.get(i)?.has(j) ? true : stemOn.get(j)?.has(i) ? false : rankOf.get(j)! < rankOf.get(i)!
      if (cuts) cutters.push({ type: 'Feature', properties: {}, geometry: raw.get(o.id)! })
    }
    let geom: Polygon | MultiPolygon = own
    if (cutters.length) {
      try {
        const cut = turfDifference(featureCollection([{ type: 'Feature', properties: {}, geometry: own }, ...cutters]))
        // A wall another one swallows whole keeps its own footprint, so it
        // can still be clicked and selected.
        if (cut?.geometry) geom = cut.geometry
      } catch {
        // Turf throws on degenerate rings: keep the uncut footprint.
      }
    }
    footprints.set(line.id, geom)
  })

  return { vertices, footprints }
}

/** One wall's footprint as overlapping rings: a quad per segment plus joint fillers. */
function wallPieces(items: Item[], i: number, joints: Map<string, Joint>): XY[][] {
  const it = items[i]
  const P = it.pts
  const h = it.line.halfWidth
  const segs = P.length - 1
  const lengths = Array.from({ length: segs }, (_, k) => len(sub(P[k + 1], P[k])))
  const pieces: XY[][] = []

  /**
   * The two corners where segment `k` meets the joint at its `side` end,
   * as [left, right] of the direction pointing into the segment.
   */
  const cornersAt = (k: number, side: At): [XY, XY] => {
    const J = side === 0 ? P[k] : P[k + 1]
    const u = unit(sub(side === 0 ? P[k + 1] : P[k], J))
    const butt: [XY, XY] = [add(J, mul(perp(u), h)), sub(J, mul(perp(u), h))]
    const L = lengths[k]
    // Own corner between two segments of this line.
    const inner = side === 0 ? k > 0 || it.closed : k < segs - 1 || it.closed
    if (inner) {
      const nk = side === 0 ? (k > 0 ? k - 1 : segs - 1) : k < segs - 1 ? k + 1 : 0
      const far = side === 0 ? P[nk] : P[nk + 1]
      if (side === 0) pushRound(pieces, J, u, h, unit(sub(far, J)), h)
      return butt
    }
    const joint = joints.get(keyOf(i, side === 0 ? 0 : 1))
    if (!joint) return butt
    if (joint.kind === 'node') {
      pieces.push(...joint.pieces)
      return butt
    }
    const other = items[joint.item]
    const taller = it.line.high - other.line.high > Z_EPS
    const lower = other.line.high - it.line.high > Z_EPS
    if (joint.kind === 'tee') {
      const ab = unit(sub(joint.b, joint.a))
      if (!taller && !lower) {
        // Both inside corners where the stem meets the wall's face: filleted.
        const ht = other.line.halfWidth
        const toStem = dot(perp(ab), u) >= 0 ? perp(ab) : mul(perp(ab), -1)
        const face = add(J, mul(toStem, ht))
        for (const s of [1, -1]) {
          const c = meet(add(J, mul(perp(u), s * h)), u, face, ab)
          const along = mul(ab, dot(ab, perp(u)) * s > 0 ? 1 : -1)
          if (c) pushFillet(pieces, c.pt, along, u, Math.min(h, ht), 0.45 * L)
        }
      }
      // A taller stem runs on through the wall it stops on; otherwise it
      // stops on that wall's centre line (the rest is cut by the wall).
      const line = taller ? farSide(J, u, ab, other.line.halfWidth) : joint.a
      return cutAlong(butt, u, line, ab, Math.max(h, other.line.halfWidth), L) ?? butt
    }
    const v = unit(sub(endNeighbour(other, joint.at), J))
    if (taller) return cutAlong(butt, u, farSide(J, u, v, other.line.halfWidth), v, Math.max(h, other.line.halfWidth), L) ?? butt
    if (!lower) pushRound(pieces, J, u, h, v, other.line.halfWidth)
    return butt
  }

  for (let k = 0; k < segs; k++) {
    if (lengths[k] <= SAME_POINT) continue
    const [ls, rs] = cornersAt(k, 0)
    // At the far end "into the segment" points backwards, so left is right.
    const [re, le] = cornersAt(k, 1)
    pieces.push([rs, re, le, ls])
  }
  return pieces.filter((r) => r.length >= 3 && ringArea(r) > 1e-6)
}

/**
 * The rounded outside of a corner where a segment leaving `J` along `u`
 * (half-width `h1`) meets one leaving along `v` (`h2`): an arc round `J`
 * from one's outer side to the other's, its radius easing from `h1` to
 * `h2`. Both segments end square at `J`; their overlap on the inside is
 * cut by the overlap step, so the inside corner stays crisp. Nothing for
 * a straight run-on.
 */
function pushRound(pieces: XY[][], J: XY, u: XY, h1: number, v: XY, h2: number) {
  const c = cross(u, v)
  if (Math.abs(c) < MIN_SIN && dot(u, v) < 0) return
  // The outer sides: away from the other segment.
  const side = c >= 0 ? -1 : 1
  const from = mul(perp(u), side)
  const to = mul(perp(v), -side)
  const a0 = Math.atan2(from[1], from[0])
  const a1 = Math.atan2(to[1], to[0])
  let span = a1 - a0
  while (span > Math.PI) span -= 2 * Math.PI
  while (span < -Math.PI) span += 2 * Math.PI
  const steps = Math.max(2, Math.ceil(Math.abs(span) / (Math.PI / 16)))
  const arc: XY[] = [J]
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const a = a0 + span * t
    const r = h1 + (h2 - h1) * t
    arc.push([J[0] + Math.cos(a) * r, J[1] + Math.sin(a) * r])
  }
  pieces.push(arc)
}

/**
 * The fillet in an inside corner at `C` between two faces running off along
 * `a` and `b` (unit): a concave arc of radius `r` touching both, and the
 * corner filled up to it. The radius shrinks so neither touch point lies
 * farther than `maxT` from the corner.
 */
function pushFillet(pieces: XY[][], C: XY, a: XY, b: XY, r: number, maxT: number) {
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(a, b))))
  if (phi < 0.17 || phi > Math.PI - 0.17) return
  let t = r / Math.tan(phi / 2)
  if (t > maxT) {
    r *= maxT / t
    t = maxT
  }
  if (r < 0.02) return
  const t1 = add(C, mul(a, t))
  const t2 = add(C, mul(b, t))
  const o = add(C, mul(unit(add(a, b)), r / Math.sin(phi / 2)))
  const a0 = Math.atan2(t1[1] - o[1], t1[0] - o[0])
  let span = Math.atan2(t2[1] - o[1], t2[0] - o[0]) - a0
  while (span > Math.PI) span -= 2 * Math.PI
  while (span < -Math.PI) span += 2 * Math.PI
  const steps = Math.max(2, Math.ceil(Math.abs(span) / (Math.PI / 16)))
  const ring: XY[] = [C]
  for (let k = 0; k <= steps; k++) {
    const ang = a0 + (span * k) / steps
    ring.push([o[0] + Math.cos(ang) * r, o[1] + Math.sin(ang) * r])
  }
  pieces.push(ring)
}

/** A point on the side of a wall (through `J`, along `v`) facing away from `u`. */
function farSide(J: XY, u: XY, v: XY, h2: number): XY {
  const n = perp(v)
  return add(J, mul(n, dot(n, u) > 0 ? -h2 : h2))
}

/**
 * The butt corners slid along `u` onto the line through `q` along `v`, or
 * null when that lands too far away or eats into the segment.
 */
function cutAlong(butt: [XY, XY], u: XY, q: XY, v: XY, h: number, L: number): [XY, XY] | null {
  const l = meet(butt[0], u, q, v)
  const r = meet(butt[1], u, q, v)
  const lim = MITRE_LIMIT * h
  if (!l || !r || Math.abs(l.s) > lim || Math.abs(r.s) > lim || l.s >= 0.5 * L || r.s >= 0.5 * L) return null
  return [l.pt, r.pt]
}

function closeRing(ring: LngLat[]): LngLat[] {
  return [...ring, ring[0]]
}

function mergeRings(rings: LngLat[][]): Polygon | MultiPolygon | null {
  if (!rings.length) return null
  if (rings.length === 1) return { type: 'Polygon', coordinates: [closeRing(rings[0])] }
  try {
    const merged = turfUnion(featureCollection(rings.map((r) => turfPolygon([closeRing(r)]))))
    if (merged?.geometry) return merged.geometry
  } catch {
    // Fall through: overlapping parts still extrude correctly.
  }
  return { type: 'MultiPolygon', coordinates: rings.map((r) => [closeRing(r)]) }
}

/** One wall's footprint with square ends and rounded corners, joined to nothing. */
export function wallFootprint(vertices: LngLat[], halfWidth: number): Polygon | MultiPolygon | null {
  return joinLines([{ id: 0, vertices, halfWidth, low: 0, high: 0 }]).footprints.get(0) ?? null
}

// ---- Outlines ------------------------------------------------------------

const polygonsOf = (g: Polygon | MultiPolygon): Position[][][] => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)

/** The border of each group of touching walls, once (see the file header). */
export function wallOutlines(walls: ReadonlyArray<OutlineWall>): OutlineRun[] {
  const runs: OutlineRun[] = []
  const origin = walls.find((w) => polygonsOf(w.geometry)[0]?.[0]?.[0])
  if (!origin) return runs
  const proj = projector(polygonsOf(origin.geometry)[0][0][0])
  const shapes = walls.map((w) => {
    const rings = polygonsOf(w.geometry).flatMap((p) => p.map((r) => r.map(proj.to)))
    return { wall: w, rings, box: boxOf(rings.flat(), 0.01) }
  })
  const sets = new Sets(shapes.length)
  for (let a = 0; a < shapes.length; a++) {
    for (let b = a + 1; b < shapes.length; b++) {
      if (Math.abs(shapes[a].wall.top - shapes[b].wall.top) > Z_EPS) continue
      if (boxesMeet(shapes[a].box, shapes[b].box)) sets.join(a, b)
    }
  }
  const groups = new Map<number, number[]>()
  shapes.forEach((_, i) => groups.set(sets.find(i), [...(groups.get(sets.find(i)) ?? []), i]))

  const own = (s: (typeof shapes)[number]) => {
    for (const ring of polygonsOf(s.wall.geometry).flat()) runs.push({ id: s.wall.id, coordinates: ring as LngLat[] })
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      own(shapes[group[0]])
      continue
    }
    let merged: Polygon | MultiPolygon | null
    try {
      merged =
        turfUnion(featureCollection(group.map((i) => ({ type: 'Feature' as const, properties: {}, geometry: shapes[i].wall.geometry }))))
          ?.geometry ?? null
    } catch {
      merged = null
    }
    if (!merged) {
      for (const i of group) own(shapes[i])
      continue
    }
    /** The wall whose side the edge from `a` to `b` runs along. */
    const ownerOf = (a: XY, b: XY): number => {
      const m = mul(add(a, b), 0.5)
      let bestId = shapes[group[0]].wall.id
      let bestD = Infinity
      for (const i of group) {
        const s = shapes[i]
        if (!boxHas(s.box, m, 0.05)) continue
        for (const ring of s.rings) {
          for (let k = 0; k + 1 < ring.length; k++) {
            const d = segDistance(m, ring[k], ring[k + 1])
            if (d < bestD) {
              bestD = d
              bestId = s.wall.id
            }
          }
        }
      }
      return bestId
    }
    for (const ring of polygonsOf(merged).flat()) {
      const pts = ring.map(proj.to)
      const edges = pts.length - 1
      if (edges < 1) continue
      const owners = Array.from({ length: edges }, (_, k) => ownerOf(pts[k], pts[k + 1]))
      const start = owners.findIndex((o, k) => o !== owners[(k + edges - 1) % edges])
      if (start < 0) {
        runs.push({ id: owners[0], coordinates: ring as LngLat[] })
        continue
      }
      let run: OutlineRun | null = null
      for (let n = 0; n < edges; n++) {
        const k = (start + n) % edges
        if (!run || run.id !== owners[k]) {
          run = { id: owners[k], coordinates: [ring[k] as LngLat] }
          runs.push(run)
        }
        run.coordinates.push(ring[k + 1] as LngLat)
      }
    }
  }
  return runs
}
