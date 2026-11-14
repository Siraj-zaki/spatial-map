/**
 * Procedural escalators and elevators ("lifts"), drawn by the stair
 * tool as `stairType: 'escalator' | 'elevator'`.
 *
 * Same output contract as the stair generator: Polygon features with
 * `base_height` / `height` (metres) for one fill-extrusion pass, plus a
 * `glass` flag the overlay routes to a translucent layer. Built in a
 * local frame — `f` metres forward along the drawn run (vertices[0] →
 * vertices[1]), `s` metres to the LEFT of it — then converted to lng/lat
 * by the caller-supplied `toLngLat`.
 *
 * Escalator (2 clicks: bottom landing → top landing):
 *   flat entry landing · inclined section of moving treads (EN 115:
 *   30° standard, 35° allowed up to 6 m rise) · flat exit landing. Each
 *   tread rides a truss body; side decks, glass balustrades and black
 *   handrails follow the incline. `layout: 'pair'` adds a second unit
 *   to the right running the other way.
 *
 * Elevator (2 clicks along the DOOR side, left corner then right, as
 * seen standing in front of it): a shaft extending `depth` metres
 * behind that line from the lowest stop to above the highest, with a
 * pair of door leaves at every stop, a car parked at `carStop`, and a
 * roof. Glass shafts show the car; solid ones hide it.
 *
 * Heights come from the linked floor plans when the overlay knows
 * their elevations (`floorElevations`), so a lift always meets its
 * floors exactly; otherwise from the stored config values.
 */

import type { Feature, Polygon } from 'geojson'
import type { StairShapeConfig } from './shapes'

/** Standard escalator incline (EN 115 / ASME A17.1). */
export const ESCALATOR_STANDARD_ANGLE = 30
/** EN 115 allows 35° only up to this rise (and ≤ 0.5 m/s). */
export const ESCALATOR_STEEP_MAX_RISE_M = 6
/** Default flat landing zone at each end (comb plate + flat steps). */
export const ESCALATOR_LANDING_M = 1.2

/** Flat landing length at each end (config `landingLength`, 0.6–5 m). */
export function escalatorLanding(config: StairShapeConfig): number {
  return Math.min(5, Math.max(0.6, config.landingLength ?? ESCALATOR_LANDING_M))
}
/** Step riser of a real escalator — drives how many treads we draw. */
const ESCALATOR_STEP_RISE_M = 0.2
/** Side deck (skirt + cladding) width on each side of the treads. */
const DECK_M = 0.3
/** Gap between the two units of a pair. */
const PAIR_GAP_M = 0.3
/** Truss depth below the treads. */
const TRUSS_DEPTH_M = 1.1
/** Default floor-to-floor height when nothing is linked (malls ≈ 4.5–5 m). */
export const DEFAULT_LIFT_RISE_M = 4.5

const ELEVATOR_DOOR_H_M = 2.1
const ELEVATOR_CAR_H_M = 2.4
/** Shaft headroom above the top stop (car height + overrun). */
const ELEVATOR_HEADROOM_M = 3.4

/** `config.liftScale` clamped to the range the panel offers (0.4–1). */
export function liftScaleOf(config: Pick<StairShapeConfig, 'liftScale'>): number {
  const k = config.liftScale
  return typeof k === 'number' && Number.isFinite(k) ? Math.max(0.4, Math.min(1, k)) : 1
}

// Part colours that aren't user-configurable. They're shape materials
// (steel, rubber, glass), stored as data like the default shape colours
// in shapes.ts — not UI theme colours.
const STEEL = '#9ca3af'
const RUBBER = '#111827'
// Clear glass: faint green-cyan, nearly transparent face-on — the mesh
// shader adds Fresnel opacity and reflections at grazing angles. Pane
// edges are the tell-tale of real (tempered, iron-bearing) glass: a
// darker teal, much more opaque.
const GLASS = '#bfe3e6'
const GLASS_ALPHA = 0.12
const GLASS_EDGE = '#5f9f96'
const GLASS_EDGE_ALPHA = 0.6
/** Length of one balustrade glass panel and the joint between panels. */
const BALUSTRADE_PANEL_M = 1.25
const PANEL_JOINT_M = 0.012
const DEMARCATION = '#facc15'
const OUT_OF_SERVICE = '#a1a1aa'

export interface LiftPartProps {
  shapeId?: number
  /** Kept for compatibility with stair consumers. */
  flightIndex: number
  isLanding: boolean
  base_height: number
  height: number
  color: string
  borderColor: string
  borderWidth?: number
  riserColor: string
  opacity: number
  /** Drawn by the translucent glass layer, ignored by occlusion. */
  glass?: boolean
  /** Moving escalator tread (drawn by the motion source when animated). */
  tread?: boolean
  /** What this piece is — for styling, hit-testing and tests. */
  part?: LiftPart
  /** Invisible click / occlusion prism (elevators are drawn as meshes). */
  hit?: boolean
  /** Occluder that markers can be seen through (glass shafts). */
  seeThrough?: boolean
}

export type LiftPart =
  | 'landing' | 'truss' | 'deck' | 'balustrade' | 'handrail' | 'tread'
  | 'wall' | 'frame' | 'door' | 'post' | 'roof' | 'car'
  | 'band' | 'portal' | 'sill' | 'call' | 'cabin' | 'car-door' | 'hit'

export type LocalToLngLat = (f: number, s: number) => [number, number]

export interface ResolvedLift {
  /** Escalator: bottom / top floor elevation. */
  base: number
  rise: number
  /** Elevator: every stop's elevation, ascending. */
  stops: number[]
}

/** Floor elevations from links (when known) or the stored values. */
export function resolveLiftLevels(
  config: StairShapeConfig,
  floorElevations?: ReadonlyMap<number, number>,
): ResolvedLift {
  const lookup = (id: number | undefined) =>
    id !== undefined && floorElevations ? floorElevations.get(id) : undefined
  if (config.stairType === 'elevator') {
    const linked = (config.servedFloorPlanIds ?? [])
      .map((id) => lookup(id))
      .filter((e): e is number => typeof e === 'number' && Number.isFinite(e))
    let stops: number[]
    if (linked.length >= 1 && linked.length === (config.servedFloorPlanIds ?? []).length) {
      stops = linked
    } else if (config.stops && config.stops.length > 0) {
      stops = config.stops
    } else {
      const n = Math.max(2, Math.floor(config.stopCount ?? 2))
      const h = Math.max(0.5, config.floorHeight ?? DEFAULT_LIFT_RISE_M)
      stops = Array.from({ length: n }, (_, i) => config.baseElevation + i * h)
    }
    stops = [...new Set(stops.map((e) => Math.round(e * 1000) / 1000))].sort((a, b) => a - b)
    return { base: stops[0], rise: stops[stops.length - 1] - stops[0], stops }
  }
  const from = lookup(config.fromFloorPlanId)
  const to = lookup(config.toFloorPlanId)
  if (from !== undefined && to !== undefined && to !== from) {
    const base = Math.min(from, to)
    return { base, rise: Math.abs(to - from), stops: [base, Math.max(from, to)] }
  }
  const base = config.baseElevation
  const rise = Math.max(0.3, config.rise ?? DEFAULT_LIFT_RISE_M)
  return { base, rise, stops: [base, base + rise] }
}

export interface EscalatorGeometry {
  /** Total footprint length along the run (m). */
  length: number
  /** Effective incline (degrees). */
  angle: number
  inclineLength: number
  steps: number
}

/**
 * Footprint length and incline. With `inclineFit` (the default) the
 * length follows from rise + angle and the drawn run only gives the
 * direction; otherwise the drawn length is used and the angle follows.
 */
export function escalatorGeometry(
  config: StairShapeConfig,
  rise: number,
  drawnLength: number,
): EscalatorGeometry {
  const angle = Math.min(60, Math.max(10, config.inclineAngle ?? ESCALATOR_STANDARD_ANGLE))
  const steps = Math.max(2, Math.round(rise / ESCALATOR_STEP_RISE_M))
  const landing = escalatorLanding(config)
  if (config.inclineFit !== false) {
    const inclineLength = rise / Math.tan((angle * Math.PI) / 180)
    return { length: inclineLength + 2 * landing, angle, inclineLength, steps }
  }
  const inclineLength = Math.max(0.5, drawnLength - 2 * landing)
  return {
    length: inclineLength + 2 * landing,
    angle: (Math.atan2(rise, inclineLength) * 180) / Math.PI,
    inclineLength,
    steps,
  }
}

/** EN 115 check: 30° standard, 35° tolerated up to 6 m rise. */
export function escalatorInclineIssue(angle: number, rise: number): 'ok' | 'steep' | 'too-steep' | 'shallow' {
  if (angle > 35.05) return 'too-steep'
  if (angle > 30.05 && rise > ESCALATOR_STEEP_MAX_RISE_M) return 'steep'
  if (angle < 27) return 'shallow'
  return 'ok'
}

function makeRect(
  toLngLat: LocalToLngLat,
  f0: number,
  f1: number,
  s0: number,
  s1: number,
  base: number,
  top: number,
  props: Omit<LiftPartProps, 'base_height' | 'height'>,
): Feature<Polygon, LiftPartProps> {
  const a = toLngLat(f0, s0)
  const b = toLngLat(f1, s0)
  const c = toLngLat(f1, s1)
  const d = toLngLat(f0, s1)
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[a, b, c, d, a]] },
    properties: { ...props, base_height: base, height: Math.max(top, base + 0.005) },
  }
}

interface PartStyle {
  shapeId?: number
  body: string
  accent: string
  borderColor: string
  borderWidth?: number
  opacity: number
  outOfService: boolean
}

function styleOf(config: StairShapeConfig, shapeId?: number): PartStyle {
  return {
    shapeId,
    body: config.color,
    accent: config.riserColor ?? config.borderColor,
    borderColor: config.borderColor,
    borderWidth: config.borderWidth,
    opacity: Math.max(0, Math.min(1, (config.opacity ?? 100) / 100)),
    outOfService: config.status === 'out-of-service',
  }
}

function part(st: PartStyle, color: string, extra?: Partial<LiftPartProps>): Omit<LiftPartProps, 'base_height' | 'height'> {
  return {
    shapeId: st.shapeId,
    flightIndex: 0,
    isLanding: false,
    color,
    borderColor: st.borderColor,
    borderWidth: st.borderWidth,
    riserColor: st.accent,
    opacity: st.opacity,
    ...extra,
  }
}

/** Side offsets of each escalator unit's centreline (unit 0 on the drawn line). */
export function escalatorUnitOffsets(config: StairShapeConfig): number[] {
  const width = Math.max(0.4, config.width)
  return config.escalatorLayout === 'pair' ? [0, -(width + 2 * DECK_M + PAIR_GAP_M)] : [0]
}

/** Travel direction of a unit: the pair's second unit runs the other way. */
export function escalatorUnitDirection(config: StairShapeConfig, unit: number): 'up' | 'down' {
  const dir = config.direction ?? 'up'
  return unit === 0 ? dir : dir === 'up' ? 'down' : 'up'
}

/**
 * Escalator parts. `motion` selects what to emit: `'all'` (static
 * drawing), `'static'` (everything except the moving treads) or
 * `'treads'` (only the treads, shifted by `phase` ∈ [0,1)).
 */
export function buildEscalatorParts(
  toLngLat: LocalToLngLat,
  config: StairShapeConfig,
  levels: ResolvedLift,
  drawnLength: number,
  shapeId?: number,
  motion: 'all' | 'static' | 'treads' = 'all',
  phase = 0,
): Feature<Polygon, LiftPartProps>[] {
  const st = styleOf(config, shapeId)
  const width = Math.max(0.4, config.width)
  const { base: B, rise: R } = levels
  const geo = escalatorGeometry(config, R, drawnLength)
  const L = geo.length
  const Ld = escalatorLanding(config)
  const runStep = geo.inclineLength / geo.steps
  const riseStep = R / geo.steps
  const treadColor = st.outOfService ? OUT_OF_SERVICE : st.accent
  const out: Feature<Polygon, LiftPartProps>[] = []
  const rect = (f0: number, f1: number, s0: number, s1: number, b: number, t: number, p: Omit<LiftPartProps, 'base_height' | 'height'>) =>
    out.push(makeRect(toLngLat, f0, f1, s0, s1, b, t, p))

  for (const [unit, off] of escalatorUnitOffsets(config).entries()) {
    const sL = off + width / 2
    const sR = off - width / 2
    const treadProps = part(st, treadColor, {
      tread: true,
      part: 'tread',
      borderColor: config.stepEdgeColor ?? DEMARCATION,
      borderWidth: Math.max(0, config.stepEdgeWidth ?? 1),
      flightIndex: unit,
    })
    if (motion !== 'treads') {
      // Flat comb / floor plates at each end. The sloped parts (truss,
      // cladding, glass, handrails) are real meshes — buildEscalatorMesh —
      // because extrusions can only be vertical boxes.
      const plate = part(st, STEEL, { isLanding: true, flightIndex: unit, part: 'landing' })
      rect(0, Ld, sR, sL, B, B + 0.03, plate)
      rect(L - Ld, L, sR, sL, B + R, B + R + 0.03, plate)
    }

    if (motion === 'static') continue
    // Treads. Static drawing = integer positions; motion = shifted by
    // the phase along the incline (down-running units move backwards)
    // and clipped to the inclined section.
    const dir = escalatorUnitDirection(config, unit)
    const shift = motion === 'treads' ? (dir === 'up' ? phase : 1 - phase) : 0
    for (let k = -1; k < geo.steps; k++) {
      const pos = k + shift
      const f0 = Math.max(Ld, Ld + pos * runStep)
      const f1 = Math.min(L - Ld, Ld + (pos + 1) * runStep)
      if (f1 - f0 < 0.01) continue
      const top = Math.min(B + R, Math.max(B + riseStep, B + (pos + 1) * riseStep))
      rect(f0, f1, sR, sL, top - riseStep, top, treadProps)
    }
  }
  return out
}

/** Shaft footprint for an elevator: (front width, depth) in metres. */
function elevatorSize(config: StairShapeConfig, frontWidth: number): { W: number; D: number } {
  return { W: Math.max(1.4, frontWidth), D: Math.max(1.4, config.depth ?? 2.2) }
}

/**
 * The only extruded part of an elevator: one invisible prism over the
 * shaft (`part: 'hit'`). The overlay draws it with zero opacity so the
 * lift can be clicked and outlined when selected (custom mesh layers are
 * invisible to queryRenderedFeatures), and marker occlusion uses it —
 * `seeThrough` for glass shafts, so markers inside stay visible.
 * Everything you see is the mesh from `buildElevatorMesh`.
 */
export function buildElevatorParts(
  toLngLat: LocalToLngLat,
  config: StairShapeConfig,
  levels: ResolvedLift,
  frontWidth: number,
  shapeId?: number,
): Feature<Polygon, LiftPartProps>[] {
  const st = styleOf(config, shapeId)
  const { W, D } = elevatorSize(config, frontWidth)
  const { stops } = levels
  const top = stops[stops.length - 1] + ELEVATOR_HEADROOM_M * liftScaleOf(config)
  return [
    makeRect(toLngLat, 0, W, 0, D, stops[0], top, {
      ...part(st, st.body, { part: 'hit', borderWidth: 0 }),
      hit: true,
      seeThrough: (config.shaftStyle ?? 'glass') === 'glass',
    }),
  ]
}

/**
 * Elevator as meshes — a panoramic mall lift built like the real thing.
 * Local frame: f along the drawn door side (0 → W), s back into the shaft
 * (0 → D), s < 0 is the landing in front of the doors.
 *
 *  Structure  round steel columns at the corners, profiled ring beams at
 *             every upper floor and under the cap, a plinth, glass (or
 *             solid) panels per floor between them, a cap with a fascia.
 *  Entrances  per stop: stainless portal (jambs + header) with a floor
 *             indicator display, two brushed leaves with a centre split,
 *             an aluminium sill, a call station with up/down buttons.
 *  Machinery  two guide rails, the car sling (stiles + crosshead), hoist
 *             ropes, a counterweight on its own rails riding opposite the
 *             car, and the drive machine under the cap.
 *  Cabin      platform, glass (or solid) walls on slim posts, ceiling with
 *             a light panel, car doors, a round handrail on brackets.
 */
export function buildElevatorMesh(
  config: StairShapeConfig,
  levels: ResolvedLift,
  frontWidth: number,
): { solid: LocalMesh; glass: LocalMesh; parts: Record<string, number>; carBase: number; top: number } {
  const { W, D } = elevatorSize(config, frontWidth)
  const glassShaft = (config.shaftStyle ?? 'glass') === 'glass'
  const oos = config.status === 'out-of-service'
  const { stops } = levels
  const bottom = stops[0]
  // Vertical size factor: car, doors, fittings and headroom (not plan sizes).
  const k = liftScaleOf(config)
  const top = stops[stops.length - 1] + ELEVATOR_HEADROOM_M * k
  const solid = new MeshBuilder()
  const glass = new MeshBuilder()
  const frameC = config.color
  const cabinC = config.riserColor ?? '#e2e8f0'
  const stainless = oos ? OUT_OF_SERVICE : '#c3c8ce'
  const dark = '#1f2937'
  const r = 0.075 // column radius
  const inset = 0.09 // column centre from the outer face
  const beamH = 0.2
  const capH = 0.22
  const capZ = top - capH

  // A panel between two heights on one face: glass, or cladding.
  const panel = (f0: number, f1: number, s0: number, s1: number, z0: number, z1: number) => {
    if (glassShaft) glass.mark('pane').pane(f0, f1, s0, s1, z0, z1)
    else solid.color(frameC).mark('pane').box(f0, f1, s0, s1, z0, z1)
  }

  // ---- Structure ----------------------------------------------------------
  solid.color(frameC)
  for (const [cf, cs] of [[inset, inset], [W - inset, inset], [inset, D - inset], [W - inset, D - inset]] as const) {
    solid.mark('column').cylZ(cf, cs, r, bottom, capZ)
  }
  const ringZ = [...stops.slice(1), capZ]
  for (const z of ringZ) {
    solid.mark('beam')
    solid.box(inset, W - inset, 0.02, 0.15, z - beamH, z) // front
    solid.box(inset, W - inset, D - 0.15, D - 0.02, z - beamH, z) // back
    solid.box(0.02, 0.15, inset, D - inset, z - beamH, z) // sides
    solid.box(W - 0.15, W - 0.02, inset, D - inset, z - beamH, z)
    // Drip edge — a thin lip that reads as a profiled slab edge.
    solid.box(0, W, -0.01, 0.03, z - beamH, z - beamH + 0.03)
  }
  solid.mark('plinth').box(0, W, 0, D, bottom, bottom + 0.06)
  // Cap: roof slab with a fascia overhang and a raised centre.
  solid.color(frameC).mark('cap').box(-0.05, W + 0.05, -0.05, D + 0.05, capZ, capZ + 0.14)
  solid.box(0.2, W - 0.2, 0.2, D - 0.2, capZ + 0.14, top)

  // Side and back panels, one per storey band.
  const bandTops = ringZ.map((z) => z - beamH)
  const bandBases = [bottom + 0.06, ...ringZ.slice(0, -1)]
  for (let i = 0; i < bandTops.length; i++) {
    const z0 = bandBases[i]
    const z1 = bandTops[i]
    panel(inset + r, W - inset - r, D - 0.1, D - 0.07, z0, z1)
    panel(0.07, 0.1, inset + r, D - inset - r, z0, z1)
    panel(W - 0.1, W - 0.07, inset + r, D - inset - r, z0, z1)
  }

  // ---- Front: entrances ----------------------------------------------------
  const doorW = Math.max(0.7, Math.min(config.doorWidth ?? 1.1, W - 2 * (inset + r) - 0.5))
  const d0 = (W - doorW) / 2
  const d1 = (W + doorW) / 2
  const jamb = 0.1
  const headerH = 0.28 * k
  const proud = 0.07
  const doorH = ELEVATOR_DOOR_H_M * k
  // Front glass either side of the door column, per storey.
  for (let i = 0; i < bandTops.length; i++) {
    panel(inset + r, d0 - jamb, 0.07, 0.1, bandBases[i], bandTops[i])
    panel(d1 + jamb, W - inset - r, 0.07, 0.1, bandBases[i], bandTops[i])
  }
  let colFrom = bottom + 0.06
  for (const z of stops) {
    // Door-column glass below this portal (between floors).
    if (z - beamH - colFrom > 0.05) panel(d0 - jamb, d1 + jamb, 0.07, 0.1, colFrom, z - beamH)
    // Portal frame, stainless, standing proud.
    solid.color(stainless).mark('portal')
    solid.box(d0 - jamb, d0, -proud, 0.12, z, z + doorH + headerH)
    solid.box(d1, d1 + jamb, -proud, 0.12, z, z + doorH + headerH)
    solid.box(d0 - jamb, d1 + jamb, -proud, 0.12, z + doorH, z + doorH + headerH)
    // Floor indicator display in the header.
    solid.color('#0f172a').mark('display').box((d0 + d1) / 2 - 0.18, (d0 + d1) / 2 + 0.18, -proud - 0.012, -proud, z + doorH + 0.08 * k, z + doorH + 0.2 * k)
    // Two brushed leaves with a centre split, recessed in the frame.
    const mid = (d0 + d1) / 2
    solid.color(stainless).mark('door')
    solid.box(d0, mid - 0.006, 0.0, 0.04, z, z + doorH)
    solid.mark('door').box(mid + 0.006, d1, 0.0, 0.04, z, z + doorH)
    // Sill plate and the call station with up / down buttons.
    solid.color('#9ca3af').mark('sill').box(d0 - 0.05, d1 + 0.05, -0.18, 0.05, z, z + 0.015)
    const cf = d1 + jamb + 0.13
    solid.color(stainless).mark('call').box(cf - 0.06, cf + 0.06, -0.025, 0.0, z + 0.98 * k, z + 1.3 * k)
    solid.color(oos ? OUT_OF_SERVICE : '#e5e7eb')
    solid.cylS(cf, z + 1.19 * k, 0.022, -0.04, -0.025)
    solid.cylS(cf, z + 1.09 * k, 0.022, -0.04, -0.025)
    colFrom = z + doorH + headerH
  }
  if (capZ - beamH - colFrom > 0.05) panel(d0 - jamb, d1 + jamb, 0.07, 0.1, colFrom, capZ - beamH)

  // ---- Machinery -------------------------------------------------------------
  const stopIndex = Math.min(stops.length - 1, Math.max(0, Math.floor(config.carStop ?? 0)))
  const c = stops[stopIndex]
  const x0 = inset + r + 0.12
  const x1 = W - inset - r - 0.12
  const y0 = 0.22
  const y1 = D - 0.42 // room behind the car for the counterweight
  const ym = (y0 + y1) / 2
  const cabinH = ELEVATOR_CAR_H_M * k
  // Guide rails either side of the car.
  solid.color(dark).mark('rail')
  solid.box(x0 - 0.1, x0 - 0.06, ym - 0.04, ym + 0.04, bottom, capZ)
  solid.mark('rail').box(x1 + 0.06, x1 + 0.1, ym - 0.04, ym + 0.04, bottom, capZ)
  // Counterweight on its own rails, riding opposite the car.
  const cwH = 1.4 * k
  const travel = stops[stops.length - 1] - bottom
  const cwZ = Math.min(capZ - 1.2 * k - cwH, bottom + 0.3 * k + (travel - (c - bottom)))
  const cw0 = W / 2 - 0.35
  const cw1 = W / 2 + 0.35
  solid.color(dark).mark('cw-rail')
  solid.box(cw0 - 0.06, cw0 - 0.03, D - 0.3, D - 0.25, bottom, capZ)
  solid.box(cw1 + 0.03, cw1 + 0.06, D - 0.3, D - 0.25, bottom, capZ)
  solid.color('#4b5563').mark('counterweight').box(cw0, cw1, D - 0.34, D - 0.2, cwZ, cwZ + cwH)
  // Drive machine under the cap, ropes down to the car and counterweight.
  const machineH = 0.55 * k
  solid.color(dark).mark('machine').box(W / 2 - 0.4, W / 2 + 0.4, ym, D - 0.15, capZ - machineH, capZ - 0.05)
  solid.color('#111827')
  for (const df of [-0.09, -0.03, 0.03, 0.09]) {
    solid.mark('rope').cylZ(W / 2 + df, ym, 0.008, c + cabinH + 0.35 * k, capZ - machineH, 6)
    solid.cylZ(W / 2 + df, D - 0.27, 0.008, cwZ + cwH, capZ - machineH, 6)
  }

  // ---- Cabin -------------------------------------------------------------------
  // Car sling: stiles up the sides, crosshead over the top, plank below.
  solid.color(dark).mark('sling')
  solid.box(x0 - 0.06, x0 - 0.01, ym - 0.06, ym + 0.06, c - 0.25, c + cabinH + 0.35 * k)
  solid.box(x1 + 0.01, x1 + 0.06, ym - 0.06, ym + 0.06, c - 0.25, c + cabinH + 0.35 * k)
  solid.box(x0 - 0.06, x1 + 0.06, ym - 0.08, ym + 0.08, c + cabinH + 0.2 * k, c + cabinH + 0.35 * k)
  solid.box(x0 - 0.06, x1 + 0.06, ym - 0.1, ym + 0.1, c - 0.25, c - 0.15)
  // Platform: the car floor is flush with the stop.
  solid.color('#374151').mark('car').box(x0, x1, y0, y1, c - 0.15, c)
  // Ceiling with a light panel.
  solid.color(cabinC).mark('ceiling').box(x0, x1, y0, y1, c + cabinH, c + cabinH + 0.1)
  solid.color('#fefce8').mark('light').box(x0 + 0.15, x1 - 0.15, y0 + 0.2, y1 - 0.15, c + cabinH - 0.015, c + cabinH)
  // Slim corner posts.
  solid.color(cabinC)
  for (const [pf, ps] of [[x0 + 0.03, y0 + 0.03], [x1 - 0.03, y0 + 0.03], [x0 + 0.03, y1 - 0.03], [x1 - 0.03, y1 - 0.03]] as const) {
    solid.mark('cabin-post').cylZ(pf, ps, 0.025, c, c + cabinH, 10)
  }
  // Walls: panoramic glass, or solid cabin panels.
  const wall = (f0: number, f1: number, s0: number, s1: number) => {
    if (glassShaft) glass.mark('cabin-wall').pane(f0, f1, s0, s1, c, c + cabinH)
    else solid.color(cabinC).mark('cabin-wall').box(f0, f1, s0, s1, c, c + cabinH)
  }
  wall(x0 + 0.05, x1 - 0.05, y1 - 0.02, y1)
  wall(x0, x0 + 0.02, y0 + 0.05, y1 - 0.05)
  wall(x1 - 0.02, x1, y0 + 0.05, y1 - 0.05)
  // Car doors behind the landing doors, front returns and transom.
  const cd0 = Math.max(x0 + 0.06, d0)
  const cd1 = Math.min(x1 - 0.06, d1)
  const cmid = (cd0 + cd1) / 2
  solid.color(stainless).mark('car-door')
  solid.box(cd0, cmid - 0.005, y0, y0 + 0.03, c, c + doorH)
  solid.mark('car-door').box(cmid + 0.005, cd1, y0, y0 + 0.03, c, c + doorH)
  solid.color(cabinC)
  solid.box(x0, cd0, y0, y0 + 0.03, c, c + cabinH)
  solid.box(cd1, x1, y0, y0 + 0.03, c, c + cabinH)
  solid.box(cd0, cd1, y0, y0 + 0.03, c + doorH, c + cabinH)
  // Handrail on brackets along the back wall.
  solid.color('#d1d5db').mark('handrail').cylF(x0 + 0.15, x1 - 0.15, y1 - 0.07, c + 0.92 * k, 0.02)
  for (const bf of [x0 + 0.25, x1 - 0.25]) solid.box(bf - 0.015, bf + 0.015, y1 - 0.07, y1 - 0.02, c + 0.9 * k, c + 0.94 * k)

  return { solid: solid.mesh, glass: glass.mesh, parts: { ...solid.parts, ...glass.parts }, carBase: c, top }
}

/** Where the wayfinding icons go, in the local frame (f, s, z). */
export function liftIconAnchors(
  config: StairShapeConfig,
  levels: ResolvedLift,
  drawnLength: number,
): { f: number; s: number; z: number; icon: 'escalator-up' | 'escalator-down' | 'elevator' }[] {
  if (config.stairType === 'elevator') {
    const W = Math.max(1.2, drawnLength)
    return levels.stops.map((z) => ({ f: W / 2, s: -0.7, z: z + 0.05, icon: 'elevator' as const }))
  }
  const geo = escalatorGeometry(config, levels.rise, drawnLength)
  const anchors: { f: number; s: number; z: number; icon: 'escalator-up' | 'escalator-down' | 'elevator' }[] = []
  for (const [unit, off] of escalatorUnitOffsets(config).entries()) {
    const icon = escalatorUnitDirection(config, unit) === 'up' ? 'escalator-up' : 'escalator-down'
    // In front of each entrance, on the floor — where a wayfinding sign
    // stands, and clear of the glass newels (glass drawn over an icon
    // made it look faded).
    anchors.push({ f: -0.7, s: off, z: levels.base + 0.05, icon })
    anchors.push({ f: geo.length + 0.7, s: off, z: levels.base + levels.rise + 0.05, icon })
  }
  return anchors
}

// ---------------------------------------------------------------------------
// Escalator mesh — the sloped parts extrusions can't draw
// ---------------------------------------------------------------------------

/**
 * Triangles in the escalator's local frame: `positions` holds
 * (f forward, s left, z up) metre triples, `colors` one RGBA (0–1) per
 * vertex. The overlay turns them into world metres and draws them with
 * a custom layer (lift-mesh-layer.ts).
 */
export interface LocalMesh {
  positions: number[]
  colors: number[]
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0.6, 0.6, 0.6]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export class MeshBuilder {
  readonly mesh: LocalMesh = { positions: [], colors: [] }
  /**
   * Optional point transform applied to every vertex — lets a caller
   * build each part in its own local frame (stair flights run in
   * different directions) while writing one mesh.
   */
  xf: ((p: number[]) => number[]) | null = null
  /** Named components added (for tests and diagnostics). */
  readonly parts: Record<string, number> = {}
  private rgba: number[] = [1, 1, 1, 1]
  mark(part: string): this {
    this.parts[part] = (this.parts[part] ?? 0) + 1
    return this
  }
  /** Axis-aligned box in the local frame. */
  box(f0: number, f1: number, s0: number, s1: number, z0: number, z1: number): void {
    if (f1 - f0 < 0.002 || s1 - s0 < 0.002 || z1 - z0 < 0.002) return
    this.band([{ f: f0, lo: z0, hi: z1 }, { f: f1, lo: z0, hi: z1 }], s0, s1)
  }
  /** Vertical cylinder (columns, rope, posts). */
  cylZ(cf: number, cs: number, r: number, z0: number, z1: number, seg = 14): void {
    const ring = Array.from({ length: seg }, (_, i) => {
      const a = (i / seg) * Math.PI * 2
      return [cf + r * Math.cos(a), cs + r * Math.sin(a)]
    })
    for (let i = 0; i < seg; i++) {
      const [af, as] = ring[i]
      const [bf, bs] = ring[(i + 1) % seg]
      this.quad([af, as, z0], [bf, bs, z0], [bf, bs, z1], [af, as, z1])
      this.tri([cf, cs, z1], [af, as, z1], [bf, bs, z1])
      this.tri([cf, cs, z0], [bf, bs, z0], [af, as, z0])
    }
  }
  /** Round pipe between two arbitrary points (sloped handrails), open ends. */
  pipe(a: number[], b: number[], r: number, seg = 10): void {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const len = Math.hypot(d[0], d[1], d[2])
    if (len < 1e-4) return
    const n = d.map((v) => v / len)
    // Any axis not parallel to the pipe gives the ring basis.
    const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const e1raw = cross(n, ref)
    const e1len = Math.hypot(e1raw[0], e1raw[1], e1raw[2])
    const e1 = e1raw.map((v) => v / e1len)
    const e2 = cross(n, e1)
    const ring = (c: number[]) =>
      Array.from({ length: seg }, (_, i) => {
        const t = (i / seg) * Math.PI * 2
        const ca = Math.cos(t) * r
        const sa = Math.sin(t) * r
        return [c[0] + e1[0] * ca + e2[0] * sa, c[1] + e1[1] * ca + e2[1] * sa, c[2] + e1[2] * ca + e2[2] * sa]
      })
    const ra = ring(a)
    const rb = ring(b)
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg
      this.quad(ra[i], ra[j], rb[j], rb[i])
    }
  }
  /** Small sphere-ish knuckle (handrail joints, post caps). */
  ball(c: number[], r: number): void {
    const seg = 8
    const rings = 4
    const pt = (i: number, k: number) => {
      const th = (i / seg) * Math.PI * 2
      const ph = (k / rings) * Math.PI - Math.PI / 2
      return [c[0] + r * Math.cos(ph) * Math.cos(th), c[1] + r * Math.cos(ph) * Math.sin(th), c[2] + r * Math.sin(ph)]
    }
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < seg; i++) this.quad(pt(i, k), pt(i + 1, k), pt(i + 1, k + 1), pt(i, k + 1))
    }
  }
  /** Cylinder running along f (handrails). */
  cylF(f0: number, f1: number, cs: number, cz: number, r: number, seg = 12): void {
    const ring = Array.from({ length: seg }, (_, i) => {
      const a = (i / seg) * Math.PI * 2
      return [cs + r * Math.cos(a), cz + r * Math.sin(a)]
    })
    for (let i = 0; i < seg; i++) {
      const [as, az] = ring[i]
      const [bs, bz] = ring[(i + 1) % seg]
      this.quad([f0, as, az], [f1, as, az], [f1, bs, bz], [f0, bs, bz])
      this.tri([f0, cs, cz], [f0, bs, bz], [f0, as, az])
      this.tri([f1, cs, cz], [f1, as, az], [f1, bs, bz])
    }
  }
  /** Short cylinder facing −s (buttons on a front face). */
  cylS(cf: number, cz: number, r: number, s0: number, s1: number, seg = 12): void {
    const ring = Array.from({ length: seg }, (_, i) => {
      const a = (i / seg) * Math.PI * 2
      return [cf + r * Math.cos(a), cz + r * Math.sin(a)]
    })
    for (let i = 0; i < seg; i++) {
      const [af, az] = ring[i]
      const [bf, bz] = ring[(i + 1) % seg]
      this.quad([af, s0, az], [bf, s0, bz], [bf, s1, bz], [af, s1, az])
      this.tri([cf, s0, cz], [bf, s0, bz], [af, s0, az])
    }
  }
  /** Clear glass face colour (see `pane`). */
  glassFace(): this {
    return this.color(GLASS, GLASS_ALPHA)
  }
  /** Glass edge colour (see `pane`). */
  glassEdge(): this {
    return this.color(GLASS_EDGE, GLASS_EDGE_ALPHA)
  }
  color(hex: string, alpha = 1): this {
    const [r, g, b] = hexToRgb(hex)
    this.rgba = [r, g, b, alpha]
    return this
  }
  tri(a: number[], b: number[], c: number[]): void {
    const xf = this.xf
    if (xf) this.mesh.positions.push(...xf(a), ...xf(b), ...xf(c))
    else this.mesh.positions.push(...a, ...b, ...c)
    for (let i = 0; i < 3; i++) this.mesh.colors.push(...this.rgba)
  }
  quad(a: number[], b: number[], c: number[], d: number[]): void {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }
  /**
   * Prism swept along a path of (f, zLo, zHi) cross-sections between two
   * side planes s0 < s1: top, bottom, both sides and end caps.
   */
  band(rows: { f: number; lo: number; hi: number }[], s0: number, s1: number): void {
    if (rows.length < 2) return
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]
      const b = rows[i + 1]
      this.quad([a.f, s0, a.hi], [b.f, s0, b.hi], [b.f, s1, b.hi], [a.f, s1, a.hi])
      this.quad([a.f, s0, a.lo], [a.f, s1, a.lo], [b.f, s1, b.lo], [b.f, s0, b.lo])
      this.quad([a.f, s0, a.lo], [b.f, s0, b.lo], [b.f, s0, b.hi], [a.f, s0, a.hi])
      this.quad([a.f, s1, a.lo], [a.f, s1, a.hi], [b.f, s1, b.hi], [b.f, s1, b.lo])
    }
    const first = rows[0]
    const last = rows[rows.length - 1]
    this.quad([first.f, s0, first.lo], [first.f, s0, first.hi], [first.f, s1, first.hi], [first.f, s1, first.lo])
    this.quad([last.f, s0, last.lo], [last.f, s1, last.lo], [last.f, s1, last.hi], [last.f, s0, last.hi])
  }
  /**
   * Glass pane swept along f between s0 < s1 (thin in s): the two broad
   * faces in clear glass, the four edges in opaque-ish edge glass.
   */
  paneBand(rows: { f: number; lo: number; hi: number }[], s0: number, s1: number): void {
    if (rows.length < 2) return
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]
      const b = rows[i + 1]
      this.color(GLASS, GLASS_ALPHA)
      this.quad([a.f, s0, a.lo], [b.f, s0, b.lo], [b.f, s0, b.hi], [a.f, s0, a.hi])
      this.quad([a.f, s1, a.lo], [a.f, s1, a.hi], [b.f, s1, b.hi], [b.f, s1, b.lo])
      this.color(GLASS_EDGE, GLASS_EDGE_ALPHA)
      this.quad([a.f, s0, a.hi], [b.f, s0, b.hi], [b.f, s1, b.hi], [a.f, s1, a.hi])
      this.quad([a.f, s0, a.lo], [a.f, s1, a.lo], [b.f, s1, b.lo], [b.f, s0, b.lo])
    }
    const first = rows[0]
    const last = rows[rows.length - 1]
    this.quad([first.f, s0, first.lo], [first.f, s0, first.hi], [first.f, s1, first.hi], [first.f, s1, first.lo])
    this.quad([last.f, s0, last.lo], [last.f, s1, last.lo], [last.f, s1, last.hi], [last.f, s0, last.hi])
  }
  /** Axis-aligned glass pane; its thinnest horizontal axis is the thickness. */
  pane(f0: number, f1: number, s0: number, s1: number, z0: number, z1: number): void {
    if (f1 - f0 < 0.002 || s1 - s0 < 0.002 || z1 - z0 < 0.002) return
    if (s1 - s0 <= f1 - f0) {
      this.paneBand([{ f: f0, lo: z0, hi: z1 }, { f: f1, lo: z0, hi: z1 }], s0, s1)
      return
    }
    // Thin in f: broad faces at f0 / f1, edges on the s sides, top, bottom.
    this.color(GLASS, GLASS_ALPHA)
    this.quad([f0, s0, z0], [f0, s0, z1], [f0, s1, z1], [f0, s1, z0])
    this.quad([f1, s0, z0], [f1, s1, z0], [f1, s1, z1], [f1, s0, z1])
    this.color(GLASS_EDGE, GLASS_EDGE_ALPHA)
    this.quad([f0, s0, z0], [f1, s0, z0], [f1, s0, z1], [f0, s0, z1])
    this.quad([f0, s1, z0], [f0, s1, z1], [f1, s1, z1], [f1, s1, z0])
    this.quad([f0, s0, z1], [f1, s0, z1], [f1, s1, z1], [f0, s1, z1])
    this.quad([f0, s0, z0], [f0, s1, z0], [f1, s1, z0], [f1, s0, z0])
  }
  /**
   * Bar of `thickness` swept along a curve in the (f, z) plane — the
   * handrail, including its loops round the newels.
   */
  tube(path: [number, number][], s0: number, s1: number, thickness: number): void {
    const rows = path.map((p, i) => {
      const prev = path[Math.max(0, i - 1)]
      const next = path[Math.min(path.length - 1, i + 1)]
      const tf = next[0] - prev[0]
      const tz = next[1] - prev[1]
      const len = Math.hypot(tf, tz) || 1
      const nf = -tz / len
      const nz = tf / len
      const h = thickness / 2
      return { inner: [p[0] - nf * h, p[1] - nz * h], outer: [p[0] + nf * h, p[1] + nz * h] }
    })
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]
      const b = rows[i + 1]
      this.quad([a.outer[0], s0, a.outer[1]], [b.outer[0], s0, b.outer[1]], [b.outer[0], s1, b.outer[1]], [a.outer[0], s1, a.outer[1]])
      this.quad([a.inner[0], s0, a.inner[1]], [a.inner[0], s1, a.inner[1]], [b.inner[0], s1, b.inner[1]], [b.inner[0], s0, b.inner[1]])
      this.quad([a.inner[0], s0, a.inner[1]], [b.inner[0], s0, b.inner[1]], [b.outer[0], s0, b.outer[1]], [a.outer[0], s0, a.outer[1]])
      this.quad([a.inner[0], s1, a.inner[1]], [a.outer[0], s1, a.outer[1]], [b.outer[0], s1, b.outer[1]], [b.inner[0], s1, b.inner[1]])
    }
  }
}

/**
 * Height of the step-nosing line along the run: flat entry, smooth
 * concave bend, straight incline, smooth convex bend, flat exit — the
 * profile a real escalator truss follows (quadratic fillets at the
 * bends).
 */
export function escalatorProfile(config: StairShapeConfig, levels: ResolvedLift, drawnLength: number): (f: number) => number {
  const { base: B, rise: R } = levels
  const geo = escalatorGeometry(config, R, drawnLength)
  const Ld = escalatorLanding(config)
  const f1 = Ld
  const f2 = geo.length - Ld
  const t = R / Math.max(0.01, geo.inclineLength)
  const w = Math.min(1, geo.inclineLength * 0.25, Ld * 0.8)
  return (f: number) => {
    if (f <= f1 - w) return B
    if (f < f1 + w) {
      const u = (f - (f1 - w)) / (2 * w)
      return B + u * u * w * t
    }
    if (f <= f2 - w) return B + (f - f1) * t
    if (f < f2 + w) {
      const u = (f - (f2 - w)) / (2 * w)
      return B + R - (1 - u) * (1 - u) * w * t
    }
    return B + R
  }
}

/** Sample positions along [a, b] every `step` metres, ends included. */
function samples(a: number, b: number, step: number): number[] {
  const n = Math.max(1, Math.ceil((b - a) / step))
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n)
}

/**
 * Sloped escalator parts as meshes: truss body, side cladding/decks,
 * glass balustrades and handrails looping round the newels. Solid and
 * glass parts come back separately (glass is drawn translucent, last).
 */
export function buildEscalatorMesh(
  config: StairShapeConfig,
  levels: ResolvedLift,
  drawnLength: number,
): { solid: LocalMesh; glass: LocalMesh } {
  const width = Math.max(0.4, config.width)
  const { base: B } = levels
  const geo = escalatorGeometry(config, levels.rise, drawnLength)
  const L = geo.length
  const h = escalatorProfile(config, levels, drawnLength)
  const solid = new MeshBuilder()
  const glass = new MeshBuilder()
  const fs = samples(0, L, 0.15)
  // Balustrade / handrail span and newel loop radius.
  const newelR = 0.46
  const fa = Math.min(newelR + 0.1, L / 4)
  const fb = L - fa
  const railZ = 0.97
  for (const off of escalatorUnitOffsets(config)) {
    const sL = off + width / 2
    const sR = off - width / 2
    // Truss: the sloped body under the treads (only where it clears the
    // bottom floor — the rest sits in the pit).
    const truss = fs
      .map((f) => ({ f, lo: Math.max(B, h(f) - TRUSS_DEPTH_M), hi: h(f) - 0.22 }))
      .filter((r) => r.hi - r.lo > 0.02)
    solid.color(config.color).band(truss, sR - DECK_M, sL + DECK_M)
    // Side decks / skirt cladding, flush with the floor at the landings.
    const deck = fs.map((f) => ({ f, lo: Math.max(B, h(f) - 0.22), hi: h(f) + 0.1 }))
    solid.band(deck, sL, sL + DECK_M)
    solid.band(deck, sR - DECK_M, sR)
    // Glass balustrades: separate panels with thin joints, lifted 5 mm
    // off the deck so the bottom edge isn't coplanar with it.
    const nPanels = Math.max(1, Math.round((fb - fa) / BALUSTRADE_PANEL_M))
    for (let i = 0; i < nPanels; i++) {
      const pa = fa + ((fb - fa) * i) / nPanels + (i > 0 ? PANEL_JOINT_M / 2 : 0)
      const pb = fa + ((fb - fa) * (i + 1)) / nPanels - (i < nPanels - 1 ? PANEL_JOINT_M / 2 : 0)
      const rows = samples(pa, pb, 0.15).map((f) => ({ f, lo: h(f) + 0.105, hi: h(f) + railZ - 0.05 }))
      glass.mark('balustrade').paneBand(rows, sL + 0.1, sL + 0.12)
      glass.paneBand(rows, sR - 0.12, sR - 0.1)
    }
    // Handrail: up round the bottom newel, along the incline, down round
    // the top newel.
    const arc = (cf: number, cz: number, from: number, to: number): [number, number][] =>
      samples(0, 1, 1 / 16).map((u) => {
        const a = ((from + (to - from) * u) * Math.PI) / 180
        return [cf + newelR * Math.cos(a), cz + newelR * Math.sin(a)]
      })
    const za = h(fa) + railZ - newelR
    const zb = h(fb) + railZ - newelR
    const path: [number, number][] = [
      ...arc(fa, za, 270, 90),
      ...samples(fa, fb, 0.15).slice(1, -1).map((f): [number, number] => [f, h(f) + railZ]),
      ...arc(fb, zb, 90, -90),
    ]
    solid.color(RUBBER)
    solid.tube(path, sL + 0.06, sL + 0.16, 0.09)
    solid.tube(path, sR - 0.16, sR - 0.06, 0.09)
    solid.color(config.color)
  }
  return { solid: solid.mesh, glass: glass.mesh }
}
