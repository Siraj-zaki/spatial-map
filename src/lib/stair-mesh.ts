/**
 * Built stairs (straight / L / U) as triangle meshes — what the stair
 * tool draws instead of one extruded box per step.
 *
 * Each flight is one closed solid: a tread slab per step with a small
 * nosing overhang, a riser per step, stringer side faces and a smooth
 * sloped soffit (the underside) parallel to the pitch line, resting on
 * the floor at the bottom. Landings are thick slabs with a tread-colour
 * cap, held up by columns where no flight is underneath. Railings run
 * along every open side: a round handrail 0.9 m above the nosing line on
 * posts, with metal balusters or glass panes (`config.railing`).
 *
 * Geometry is built per flight / landing in its own local frame
 * (f forward along the run, s to the left, z up — metres) and placed
 * with `MeshBuilder.xf` into (east, north, up) metres from the stair's
 * first vertex. The overlay draws it with the lift mesh layers; the
 * stair's extruded step boxes stay as invisible click targets.
 */

import { DEFAULT_RAILING_COLOR, type StairRailing, type StairShapeConfig } from './shapes'
import { MeshBuilder, type LocalMesh } from './vertical-transport-generators'

/** A flight in metres: origin + unit run / left vectors (east, north). */
export interface StairMeshFlight {
  o: [number, number]
  u: [number, number]
  p: [number, number]
  steps: number
  tread: number
  /** Elevation the first riser starts from. */
  base: number
}

export interface StairMeshLanding {
  o: [number, number]
  u: [number, number]
  p: [number, number]
  f: [number, number]
  s: [number, number]
  /** Walking surface. */
  top: number
}

export interface StairMeshPlan {
  type: 'straight' | 'l' | 'u'
  width: number
  riser: number
  /** Floor the stair stands on (config.baseElevation). */
  floor: number
  flights: StairMeshFlight[]
  landing?: StairMeshLanding
  /** U-shape open well between the flights. */
  gap: number
}

/** Tread slab thickness and nosing overhang (m). */
const TREAD_T = 0.035
const NOSING = 0.025
/** Structural waist under the pitch line, measured perpendicular (m). */
const WAIST = 0.16
/** Landing slab depth (m). */
const LANDING_T = 0.22
/** Handrail height above the nosing line / landing (IBC 34–38 in). */
const RAIL_H = 0.9
const POST_SPACING = 1.2
const BALUSTER_SPACING = 0.11
const POST_R = 0.022
const RAIL_R = 0.026
const BALUSTER_R = 0.008
/** Metal railings stand this far in from the edge; glass hangs this far out. */
const METAL_INSET = 0.06
const GLASS_OUT = 0.03
const GLASS_T = 0.012

type V2 = [number, number]

interface Frame {
  o: V2
  u: V2
  p: V2
}

const place = (fr: Frame) => (q: number[]) => [
  fr.o[0] + q[0] * fr.u[0] + q[1] * fr.p[0],
  fr.o[1] + q[0] * fr.u[1] + q[1] * fr.p[1],
  q[2],
]

/** World (east, north) → a frame's local (f, s). */
const toLocal = (fr: Frame, e: number, n: number): V2 => {
  const de = e - fr.o[0]
  const dn = n - fr.o[1]
  return [de * fr.u[0] + dn * fr.u[1], de * fr.p[0] + dn * fr.p[1]]
}

interface RailStyle {
  kind: Exclude<StairRailing, 'none'>
  color: string
}

/**
 * One straight run of railing between plan points `a` → `b` (local
 * frame of the current `xf`), on the edge whose outward normal is `out`.
 * `floorAt(t)` is the walking surface under the rail, `railAt(t)` the
 * handrail centre height, `lowAt(t)` how far down glass may hang;
 * `bends` are the t values where `railAt` changes slope.
 */
function railing(
  solid: MeshBuilder,
  glass: MeshBuilder,
  style: RailStyle,
  a: V2,
  b: V2,
  out: V2,
  floorAt: (t: number) => number,
  railAt: (t: number) => number,
  lowAt: (t: number) => number,
  bends: number[] = [],
): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (len < 0.2) return
  const off = style.kind === 'glass' ? GLASS_OUT : -METAL_INSET
  const pa: V2 = [a[0] + out[0] * off, a[1] + out[1] * off]
  const pb: V2 = [b[0] + out[0] * off, b[1] + out[1] * off]
  const at = (t: number): V2 => [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t]
  // Ends pulled in a little so neighbouring runs don't collide at corners.
  const t0 = Math.min(0.4, 0.07 / len)
  const t1 = 1 - t0
  const nPosts = Math.max(2, Math.ceil(((t1 - t0) * len) / POST_SPACING) + 1)
  const postTs = Array.from({ length: nPosts }, (_, i) => t0 + ((t1 - t0) * i) / (nPosts - 1))

  solid.color(style.color).mark('handrail')
  const knots = [t0, ...bends.filter((b) => b > t0 && b < t1).sort((x, y) => x - y), t1]
  const P3 = (t: number) => {
    const q = at(t)
    return [q[0], q[1], railAt(t)]
  }
  for (let i = 0; i < knots.length - 1; i++) solid.pipe(P3(knots[i]), P3(knots[i + 1]), RAIL_R)
  for (const k of knots) solid.ball(P3(k), RAIL_R * 1.15)

  if (style.kind === 'metal') {
    for (const t of postTs) {
      const q = at(t)
      solid.mark('post').cylZ(q[0], q[1], POST_R, floorAt(t), railAt(t), 10)
    }
    const nBal = Math.floor(((t1 - t0) * len) / BALUSTER_SPACING)
    for (let i = 1; i < nBal; i++) {
      const t = t0 + ((t1 - t0) * i) / nBal
      if (postTs.some((pt) => Math.abs(pt - t) * len < 0.045)) continue
      const q = at(t)
      solid.cylZ(q[0], q[1], BALUSTER_R, floorAt(t), railAt(t) - RAIL_R * 0.6, 6)
    }
    return
  }

  // Glass: one pane per post bay, hung outside the edge, handrail on top.
  const nrm: V2 = [out[0] * (GLASS_T / 2), out[1] * (GLASS_T / 2)]
  for (let i = 0; i < postTs.length - 1; i++) {
    const ta = postTs[i] + (i > 0 ? 0.006 / len : 0)
    const tb = postTs[i + 1] - (i < postTs.length - 2 ? 0.006 / len : 0)
    const rows = 6
    const pts = Array.from({ length: rows + 1 }, (_, k) => ta + ((tb - ta) * k) / rows)
    glass.mark('balustrade')
    for (let k = 0; k < rows; k++) {
      const u0 = pts[k]
      const u1 = pts[k + 1]
      const q0 = at(u0)
      const q1 = at(u1)
      const lo0 = lowAt(u0)
      const lo1 = lowAt(u1)
      const hi0 = railAt(u0) - RAIL_R
      const hi1 = railAt(u1) - RAIL_R
      const P = (q: V2, side: number, z: number) => [q[0] + nrm[0] * side, q[1] + nrm[1] * side, z]
      glass.glassFace()
      glass.quad(P(q0, 1, lo0), P(q1, 1, lo1), P(q1, 1, hi1), P(q0, 1, hi0))
      glass.quad(P(q0, -1, lo0), P(q0, -1, hi0), P(q1, -1, hi1), P(q1, -1, lo1))
      glass.glassEdge()
      glass.quad(P(q0, 1, hi0), P(q1, 1, hi1), P(q1, -1, hi1), P(q0, -1, hi0))
      glass.quad(P(q0, 1, lo0), P(q0, -1, lo0), P(q1, -1, lo1), P(q1, 1, lo1))
    }
    for (const [u, sgn] of [[ta, 1], [tb, -1]] as const) {
      const q = at(u)
      const lo = lowAt(u)
      const hi = railAt(u) - RAIL_R
      const P = (side: number, z: number) => [q[0] + nrm[0] * side, q[1] + nrm[1] * side, z]
      if (sgn > 0) glass.quad(P(1, lo), P(1, hi), P(-1, hi), P(-1, lo))
      else glass.quad(P(1, lo), P(-1, lo), P(-1, hi), P(1, hi))
    }
  }
}

/** Build the mesh for a planned stair. */
export function buildStairMesh(plan: StairMeshPlan, config: StairShapeConfig): { solid: LocalMesh; glass: LocalMesh; parts: Record<string, number> } {
  const solid = new MeshBuilder()
  const glass = new MeshBuilder()
  const W = plan.width
  const r = plan.riser
  const treadC = config.color
  const bodyC = config.riserColor ?? config.color
  const riserC = config.riserColor ?? config.color
  const railKind = config.railing ?? 'metal'
  const style: RailStyle | null = railKind === 'none' ? null : { kind: railKind, color: config.railingColor ?? DEFAULT_RAILING_COLOR }
  const landingUnderside = plan.landing ? plan.landing.top - Math.max(LANDING_T, r + 0.04) : plan.floor

  plan.flights.forEach((fl, idx) => {
    const n = fl.steps
    const t = fl.tread
    const slope = r / t
    // Lowest the soffit may go: the floor for the first flight, the
    // landing's underside for a flight that starts on a landing.
    const floor = idx === 0 ? plan.floor : landingUnderside
    const hw = WAIST * Math.sqrt(1 + slope * slope)
    const zu = (f: number) => Math.max(floor, fl.base + f * slope - hw)
    const fc = (floor - fl.base + hw) / slope // where the soffit leaves the floor
    const topOf = (k: number) => fl.base + (k + 1) * r
    const hs = W / 2
    solid.xf = place(fl)
    solid.mark('flight')
    for (let k = 0; k < n; k++) {
      const f0 = k * t
      const f1 = (k + 1) * t
      const T = topOf(k) - TREAD_T
      const cuts = [f0, ...(fc > f0 && fc < f1 ? [fc] : []), f1]
      solid.color(bodyC)
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i]
        const b = cuts[i + 1]
        // Stringer faces (left, right) and the soffit.
        solid.quad([a, hs, zu(a)], [b, hs, zu(b)], [b, hs, T], [a, hs, T])
        solid.quad([a, -hs, zu(a)], [a, -hs, T], [b, -hs, T], [b, -hs, zu(b)])
        solid.quad([a, -hs, zu(a)], [b, -hs, zu(b)], [b, hs, zu(b)], [a, hs, zu(a)])
      }
      // Riser: from the tread below (or the soffit at the foot) up to this tread.
      const from = k === 0 ? zu(0) : topOf(k - 1)
      solid.color(riserC).mark('riser')
      solid.quad([f0, -hs, from], [f0, hs, from], [f0, hs, T], [f0, -hs, T])
      // Tread slab with its nosing.
      solid.color(treadC).mark('tread')
      solid.box(f0 - NOSING, f1, -hs, hs, T, topOf(k))
    }
    // Back of the flight.
    solid.color(bodyC)
    const fe = n * t
    solid.quad([fe, -hs, zu(fe)], [fe, -hs, topOf(n - 1) - TREAD_T], [fe, hs, topOf(n - 1) - TREAD_T], [fe, hs, zu(fe)])
  })

  // Landing slab with a tread-colour cap, and columns where nothing holds it.
  const L = plan.landing
  if (L) {
    solid.xf = place(L)
    solid.color(bodyC).mark('landing')
    solid.box(L.f[0], L.f[1], L.s[0], L.s[1], landingUnderside, L.top - TREAD_T)
    solid.color(treadC)
    solid.box(L.f[0], L.f[1], L.s[0], L.s[1], L.top - TREAD_T, L.top)
    const f1 = plan.flights[0]
    const fl1Len = f1.steps * f1.tread
    if (landingUnderside - plan.floor > 0.4) {
      const inset = 0.16
      const corners: V2[] = [
        [L.f[0] + inset, L.s[0] + inset],
        [L.f[1] - inset, L.s[0] + inset],
        [L.f[1] - inset, L.s[1] - inset],
        [L.f[0] + inset, L.s[1] - inset],
      ]
      for (const [cf, cs] of corners) {
        const w = place(L)([cf, cs, 0])
        const [lf, ls] = toLocal(f1, w[0], w[1])
        // Over the first flight's footprint the flight carries it.
        if (lf > -0.05 && lf < fl1Len + 0.05 && Math.abs(ls) < W / 2 + 0.05) continue
        solid.color(bodyC).mark('column')
        solid.box(cf - 0.1, cf + 0.1, cs - 0.1, cs + 0.1, plan.floor, landingUnderside)
      }
    }
  }

  if (style) {
    // Flight sides. Rail height follows the nosing line.
    plan.flights.forEach((fl, idx) => {
      const n = fl.steps
      const t = fl.tread
      const slope = r / t
      const fe = n * t
      // The pitch line runs through the tread nosings. A flight that ends
      // on a landing climbs to the landing edge (the landing is one
      // riser above its last tread); one that arrives at a floor levels
      // off over its top tread, like a real handrail extension.
      const fTop = idx === 0 && plan.landing ? fe : (n - 1) * t
      const nosing = (f: number) => fl.base + r + Math.min(f, fTop) * slope
      const floor = idx === 0 ? plan.floor : landingUnderside
      solid.xf = place(fl)
      glass.xf = place(fl)
      for (const side of [1, -1] as const) {
        let to = fe
        // L-shape: the landing laps over the top half of flight 1 on the
        // side it turns towards — stop that rail where the landing starts.
        if (plan.type === 'l' && idx === 0 && plan.flights[1]) {
          const u2 = plan.flights[1].u
          const towards = Math.sign(fl.p[0] * u2[0] + fl.p[1] * u2[1])
          if (towards === side) to = Math.max(t, fe - W / 2)
        }
        const a: V2 = [0, side * (W / 2)]
        const b: V2 = [to, side * (W / 2)]
        const fAt = (tt: number) => to * tt
        railing(
          solid,
          glass,
          style,
          a,
          b,
          [0, side],
          (tt) => fl.base + (Math.min(n - 1, Math.max(0, Math.floor(fAt(tt) / t))) + 1) * r,
          (tt) => nosing(fAt(tt)) + RAIL_H,
          (tt) => Math.max(floor, fl.base + fAt(tt) * slope - 0.12),
          fTop < to ? [fTop / to] : [],
        )
      }
    })
    // Open landing edges.
    if (L) {
      solid.xf = place(L)
      glass.xf = place(L)
      const top = L.top
      const run = (a: V2, b: V2, out: V2) =>
        railing(solid, glass, style, a, b, out, () => top, () => top + RAIL_H, () => top - 0.16)
      if (plan.type === 'u') {
        run([L.f[1], L.s[0]], [L.f[1], L.s[1]], [1, 0])
        run([L.f[0], L.s[1]], [L.f[1], L.s[1]], [0, 1])
        run([L.f[0], L.s[0]], [L.f[1], L.s[0]], [0, -1])
        if (plan.gap > 0.15) run([L.f[0], -W / 2 - plan.gap], [L.f[0], -W / 2], [-1, 0])
      } else if (plan.type === 'l') {
        // Which side of the landing flight 1 arrives from.
        const v0 = plan.flights[0].o
        const [, s0] = toLocal(L, v0[0], v0[1])
        const outer = s0 > 0 ? -1 : 1
        const so = (outer * W) / 2
        run([L.f[0], so], [L.f[1], so], [0, outer])
        run([L.f[0], 0], [L.f[0], so], [-1, 0])
        run([Math.min(L.f[1], L.f[0] + W / 2), -so], [L.f[1], -so], [0, -outer])
      }
    }
  }
  solid.xf = null
  glass.xf = null
  return { solid: solid.mesh, glass: glass.mesh, parts: { ...solid.parts, ...glass.parts } }
}
