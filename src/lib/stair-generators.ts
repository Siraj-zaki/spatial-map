/**
 * Procedural stair geometry.
 *
 * Renders a parametric staircase as a `FeatureCollection<Polygon>` —
 * each Polygon feature carries `base_height` and `height` properties
 * that drive Mapbox's `fill-extrusion-base` and `fill-extrusion-height`
 * paint via `['to-number', ['get', …]]`. This is the same single-
 * source / single-layer pattern Mapbox's own indoor-mapping example
 * uses, which avoids the z-fighting seam glitches that the multi-layer
 * stacked approach hits (see mapbox-gl-js#7766).
 *
 * The generator supports three stair types via `config.stairType`:
 *   - `'straight'` — single flight (2 vertices: bottom, top).
 *   - `'l'`        — two perpendicular flights with a square landing
 *                    at the corner (3 vertices: bottom, corner, top).
 *   - `'u'`        — two parallel flights going opposite directions
 *                    with a landing at the top of the first flight.
 *                    2 vertices (flight 2 is auto-mirrored).
 *
 * Each step is its own non-overlapping rectangular extrusion. Step i in
 * a flight occupies elevation [baseElev + i·riser, baseElev +
 * (i+1)·riser] with footprint width × treadDepth. Consecutive steps
 * touch at edges but never overlap. Landings are a single flat
 * extrusion at the elevation where the two flights meet.
 */

import type { Feature, FeatureCollection, Point, Polygon } from 'geojson'
import { polygon as turfPolygon, transformRotate } from '@turf/turf'
import { isLiftType, type StairShape, type StairShapeConfig, type StairType } from './shapes'
import { placeMesh, type LiftMeshData } from './lift-mesh-layer'
import { buildStairMesh, type StairMeshPlan } from './stair-mesh'
import {
  type LiftPart,
  type LocalMesh,
  buildEscalatorMesh,
  buildElevatorMesh,
  buildElevatorParts,
  buildEscalatorParts,
  liftIconAnchors,
  resolveLiftLevels,
} from './vertical-transport-generators'

export interface StairFeatureProps {
  shapeId?: number
  /** 0-based step index within its flight; undefined for landings. */
  stepIndex?: number
  /** 0-based flight index. Landings carry the flight they belong to (1 for the lower landing). */
  flightIndex: number
  /** True for landing polygons (one flat slab at the turn). */
  isLanding: boolean
  /** Bottom elevation in meters above ground. */
  base_height: number
  /** Top elevation in meters above ground. */
  height: number
  color: string
  borderColor: string
  /**
   * Border line width in pixels. Stamped per-feature so the border
   * layer can render a data-driven `line-width`. Undefined =
   * overlay's `coalesce` fallback (1.2 px) kicks in.
   */
  borderWidth?: number
  riserColor: string
  /** 0..1 (Mapbox-friendly). */
  opacity: number
  /** Lift glass (shaft, balustrade) — the overlay's translucent layer. */
  glass?: boolean
  /** Escalator tread (moves when the escalator is animated). */
  tread?: boolean
  /** Lift piece (escalator / elevator); undefined for stairs. */
  part?: LiftPart
  /** Invisible click / occlusion prism (elevators). */
  hit?: boolean
  /** Occluder markers can be seen through (glass elevator shafts). */
  seeThrough?: boolean
}

/**
 * Extra inputs for lifts. Stairs ignore them.
 *  - `floorElevations`: ImageShape id → elevation, so linked lifts meet
 *    their floors exactly even after a floor is raised or lowered.
 *  - `motion` / `phase`: split moving escalator treads from the rest
 *    (see `buildEscalatorParts`).
 */
export interface StairBuildOptions {
  floorElevations?: ReadonlyMap<number, number>
  motion?: 'all' | 'static' | 'treads'
  phase?: number
}

const METERS_PER_DEG_LAT = 111_320

function metersToLngDelta(meters: number, lat: number): number {
  return meters / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
}

function metersToLatDelta(meters: number): number {
  return meters / METERS_PER_DEG_LAT
}

function lngLatDistanceMeters(
  a: [number, number],
  b: [number, number],
): number {
  // Equirectangular approximation — accurate to <0.5% for stair-scale
  // distances (≤ ~100 m) and avoids the cost of Haversine.
  const midLat = (a[1] + b[1]) / 2
  const dx = (b[0] - a[0]) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
  const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Stair-type-aware run resolver. Returns the effective vertices the
 * geometry should be built against and the per-flight tread depth.
 *
 * For 'straight' and 'u' the input is treated as 2 anchors. For 'l' the
 * input must be 3 anchors. Tread depth honours `treadMode`: in manual
 * mode the second anchor of each flight is clamped to
 * `stepCount/flights × treadDepth` so changing the values rebuilds the
 * geometry instantly.
 */
function asStairType(t: StairType | undefined): StairType {
  return t ?? 'straight'
}

/**
 * Steps per flight. `config.stepCount` is interpreted as PER-FLIGHT
 * for L-shape and U-shape, so switching a 10-step straight stair to
 * U-shape gives you two 10-step flights (total 20 steps), not two
 * 5-step flights. That matches the user's expectation that "the
 * second flight shouldn't be shorter than the first" — both flights
 * end up the same length as the straight stair they would replace.
 */
function stepsPerFlight(config: StairShapeConfig): number {
  return Math.max(1, Math.floor(config.stepCount))
}

/**
 * Build one flight as a list of step polygons.
 *
 * `start` is the geographic anchor of the flight's first riser (the
 * bottom of step 0). The flight extends `runMeters` along `u =
 * (ux, uy)` (a unit vector in the planar meter frame) at the given
 * `midLat` (used for meters→lng conversion). Each step is `treadDepth`
 * deep, `width` wide (perpendicular to u), and rises `riser` from the
 * previous step.
 */
interface FlightFrame {
  start: [number, number]
  ux: number
  uy: number
  /** Perpendicular unit (left of run). */
  px: number
  py: number
  /** Latitude used for meters→deg conversion. Pass the run midpoint. */
  midLat: number
}

function buildFlightSteps(
  frame: FlightFrame,
  flightIndex: number,
  stepCount: number,
  treadDepth: number,
  width: number,
  riser: number,
  baseElev: number,
  props: {
    color: string
    borderColor: string
    borderWidth?: number
    riserColor: string
    opacity: number
    shapeId?: number
  },
): Feature<Polygon, StairFeatureProps>[] {
  const halfW = width / 2
  const out: Feature<Polygon, StairFeatureProps>[] = []
  const localToLngLat = (forward: number, side: number): [number, number] => {
    const east = forward * frame.ux + side * frame.px
    const north = forward * frame.uy + side * frame.py
    return [
      frame.start[0] + metersToLngDelta(east, frame.midLat),
      frame.start[1] + metersToLatDelta(north),
    ]
  }
  // Per-step extrusion that forms a CONNECTED stair when viewed in 3D:
  //
  //   Top of step i     = baseElev + (i + 1) * riser   (sawtooth slope)
  //   Bottom of step i  = baseElev + (i - 1) * riser   (parallel slope)
  //
  // Each step is `2 * riser` thick, and adjacent steps overlap in
  // elevation by exactly one riser at their shared plan boundary — so
  // the 3D union is a single solid block whose top reads as a normal
  // sawtooth tread sequence and whose underside is a continuous slope
  // running parallel to the tops at the same angle.
  //
  // The earlier `base_height = baseElev + i * riser` formula made every
  // step exactly one riser tall and only touched the next step at a
  // single edge — the camera saw daylight under each step and the
  // staircase looked like a row of disconnected hovering tiles.
  for (let i = 0; i < stepCount; i++) {
    const fStart = i * treadDepth
    const fEnd = (i + 1) * treadDepth
    const p1 = localToLngLat(fStart, -halfW)
    const p2 = localToLngLat(fEnd, -halfW)
    const p3 = localToLngLat(fEnd, halfW)
    const p4 = localToLngLat(fStart, halfW)
    out.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[p1, p2, p3, p4, p1]] },
      properties: {
        shapeId: props.shapeId,
        stepIndex: i,
        flightIndex,
        isLanding: false,
        base_height: baseElev + (i - 1) * riser,
        height: baseElev + (i + 1) * riser,
        color: props.color,
        borderColor: props.borderColor,
        borderWidth: props.borderWidth,
        riserColor: props.riserColor,
        opacity: props.opacity,
        // Stairs are drawn as meshes (stair-mesh.ts); the step boxes are
        // the invisible click / hover / occlusion targets.
        hit: true,
      },
    })
  }
  return out
}

/**
 * Build a landing slab between two flights. The landing is a rectangle
 * in local coordinates whose forward axis is `u` and side axis `p`.
 *
 * `forwardRange` is the [fStart, fEnd] in meters along u relative to
 * `start`. `sideRange` is [sStart, sEnd] in meters along p. `baseElev`
 * is the bottom of the slab; `height` is its top (so thickness =
 * height - baseElev).
 */
function buildLanding(
  frame: FlightFrame,
  flightIndex: number,
  forwardRange: [number, number],
  sideRange: [number, number],
  baseElev: number,
  topElev: number,
  props: {
    color: string
    borderColor: string
    borderWidth?: number
    riserColor: string
    opacity: number
    shapeId?: number
  },
): Feature<Polygon, StairFeatureProps> {
  const localToLngLat = (forward: number, side: number): [number, number] => {
    const east = forward * frame.ux + side * frame.px
    const north = forward * frame.uy + side * frame.py
    return [
      frame.start[0] + metersToLngDelta(east, frame.midLat),
      frame.start[1] + metersToLatDelta(north),
    ]
  }
  const p1 = localToLngLat(forwardRange[0], sideRange[0])
  const p2 = localToLngLat(forwardRange[1], sideRange[0])
  const p3 = localToLngLat(forwardRange[1], sideRange[1])
  const p4 = localToLngLat(forwardRange[0], sideRange[1])
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[p1, p2, p3, p4, p1]] },
    properties: {
      shapeId: props.shapeId,
      flightIndex,
      isLanding: true,
      base_height: baseElev,
      height: topElev,
      color: props.color,
      borderColor: props.borderColor,
      borderWidth: props.borderWidth,
      riserColor: props.riserColor,
      opacity: props.opacity,
      hit: true,
    },
  }
}

/** (forward, left) metres in a flight frame → lng/lat. */
function localFrameToLngLat(frame: FlightFrame): (f: number, s: number) => [number, number] {
  return (forward, side) => {
    const east = forward * frame.ux + side * frame.px
    const north = forward * frame.uy + side * frame.py
    return [
      frame.start[0] + metersToLngDelta(east, frame.midLat),
      frame.start[1] + metersToLatDelta(north),
    ]
  }
}

/**
 * Compute the local frame (meter-space unit vectors + mid-latitude) for
 * a flight from `start` to `end` in lng/lat. Returns null for a
 * zero-length input.
 */
function frameFromVertices(
  start: [number, number],
  end: [number, number],
): { frame: FlightFrame; runMeters: number } {
  const midLat = (start[1] + end[1]) / 2
  const dxMeters =
    (end[0] - start[0]) *
    METERS_PER_DEG_LAT *
    Math.cos((midLat * Math.PI) / 180)
  const dyMeters = (end[1] - start[1]) * METERS_PER_DEG_LAT
  const runMeters = Math.sqrt(dxMeters * dxMeters + dyMeters * dyMeters)
  let ux: number
  let uy: number
  if (runMeters === 0) {
    ux = 0
    uy = 1
  } else {
    ux = dxMeters / runMeters
    uy = dyMeters / runMeters
  }
  // Perpendicular unit (left of run).
  const px = -uy
  const py = ux
  return {
    frame: { start, ux, uy, px, py, midLat },
    runMeters,
  }
}

/**
 * Main entry point — returns the FeatureCollection that drives the
 * fill-extrusion layer. The MapStairOverlay just calls this and pumps
 * the result into a single source via setData.
 */
export function buildStairFeatures(
  vertices: [number, number][],
  config: StairShapeConfig,
  shapeId?: number,
  options?: StairBuildOptions,
): FeatureCollection<Polygon, StairFeatureProps> {
  const stairType = asStairType(config.stairType)
  if (isLiftType(stairType)) {
    if (vertices.length < 2) return { type: 'FeatureCollection', features: [] }
    const { frame, runMeters } = frameFromVertices(vertices[0], vertices[1])
    const toLngLat = localFrameToLngLat(frame)
    const levels = resolveLiftLevels(config, options?.floorElevations)
    const features =
      stairType === 'elevator'
        ? buildElevatorParts(toLngLat, config, levels, runMeters, shapeId)
        : buildEscalatorParts(toLngLat, config, levels, runMeters, shapeId, options?.motion ?? 'all', options?.phase ?? 0)
    return { type: 'FeatureCollection', features }
  }
  const layout = stairLayout(vertices, config)
  if (!layout) return { type: 'FeatureCollection', features: [] }
  const props = {
    color: config.color,
    borderColor: config.borderColor,
    // Undefined is intentional when the config field is missing (legacy
    // stair rows). The overlay paint expression falls back to 1.2 px so
    // the visual is unchanged for anything that hasn't opted in yet.
    borderWidth: config.borderWidth,
    riserColor: config.riserColor ?? config.borderColor,
    opacity: Math.max(0, Math.min(1, (config.opacity ?? 100) / 100)),
    shapeId,
  }
  const flight = (fl: FlightPlan) =>
    buildFlightSteps(fl.frame, fl.flightIndex, fl.steps, fl.tread, layout.width, layout.riser, fl.base, props)
  const [first, second] = layout.flights
  const features = [...flight(first)]
  if (layout.landing) {
    const l = layout.landing
    features.push(buildLanding(l.frame, 1, l.f, l.s, l.base, l.top, props))
  }
  if (second) features.push(...flight(second))
  return { type: 'FeatureCollection', features }
}

interface FlightPlan {
  frame: FlightFrame
  flightIndex: number
  steps: number
  tread: number
  /** Elevation the first riser starts from. */
  base: number
}

interface LandingPlan {
  frame: FlightFrame
  f: [number, number]
  s: [number, number]
  base: number
  top: number
}

/**
 * Flights and landing of a straight / L / U stair — the one layout both
 * the extruded click targets (`buildStairFeatures`) and the built mesh
 * (`stairMeshes`) are made from. Null with fewer than 2 vertices.
 */
interface StairLayout {
  type: 'straight' | 'l' | 'u'
  width: number
  riser: number
  flights: FlightPlan[]
  landing?: LandingPlan
  gap: number
}

function stairLayout(vertices: [number, number][], config: StairShapeConfig): StairLayout | null {
  if (vertices.length < 2) return null
  const stairType = asStairType(config.stairType)
  const width = Math.max(0.01, config.width)
  const riser = Math.max(0.001, config.riserHeight)
  const baseElev = config.baseElevation
  // Landing thickness — match a riser so the slab visually steps up
  // exactly once between the two flights.
  const landingThickness = riser
  const autoTread = (run: number, steps: number) =>
    config.treadMode === 'manual' ? Math.max(0.01, config.treadDepth) : Math.max(0.01, run) / steps

  if (stairType === 'straight' || stairType === 'escalator' || stairType === 'elevator') {
    const { frame, runMeters } = frameFromVertices(vertices[0], vertices[1])
    const steps = Math.max(1, Math.floor(config.stepCount))
    return {
      type: 'straight',
      width,
      riser,
      flights: [{ frame, flightIndex: 0, steps, tread: autoTread(runMeters, steps), base: baseElev }],
      gap: 0,
    }
  }

  // Effective landing depth — defaults to a generous 2 × width when
  // not provided so the turn space reads as a real landing rather
  // than a one-step ledge.
  const landingDepth = Math.max(0.05, config.landingDepth ?? width * 2)
  const stepsPer = stepsPerFlight(config)

  if (stairType === 'l') {
    if (vertices.length < 3) {
      // Mid-draw: only 2 anchors so far — render flight 1 as a preview
      // until the user places the third anchor.
      const { frame, runMeters } = frameFromVertices(vertices[0], vertices[1])
      return {
        type: 'straight',
        width,
        riser,
        flights: [{ frame, flightIndex: 0, steps: stepsPer, tread: autoTread(runMeters, stepsPer), base: baseElev }],
        gap: 0,
      }
    }
    // Full L: flight 1 (start → corner), landing at corner, flight 2
    // (corner → top). Flight 2 starts `landingDepth` past the corner
    // along its run direction so the landing actually has depth.
    const [v0, v1, v2] = vertices
    const f1 = frameFromVertices(v0, v1)
    const f2 = frameFromVertices(v1, v2)
    const flight1Top = baseElev + stepsPer * riser
    const landingTop = flight1Top + landingThickness
    // Flight 2 starts at the far edge of the landing — translate the
    // frame's start forward by `landingDepth` along u2.
    const flight2Start: [number, number] = [
      v1[0] + metersToLngDelta(landingDepth * f2.frame.ux, f2.frame.midLat),
      v1[1] + metersToLatDelta(landingDepth * f2.frame.uy),
    ]
    return {
      type: 'l',
      width,
      riser,
      flights: [
        { frame: f1.frame, flightIndex: 0, steps: stepsPer, tread: autoTread(f1.runMeters, stepsPer), base: baseElev },
        {
          frame: { ...f2.frame, start: flight2Start },
          flightIndex: 2,
          steps: stepsPer,
          tread: autoTread(Math.max(0.01, f2.runMeters - landingDepth), stepsPer),
          base: landingTop,
        },
      ],
      // Landing sits at the corner, oriented along flight 2. Forward
      // range [0, landingDepth] gives the user control over how big the
      // turn space is. Side range [-width/2, width/2] keeps it the same
      // width as the flights.
      landing: { frame: f2.frame, f: [0, landingDepth], s: [-width / 2, width / 2], base: flight1Top, top: landingTop },
      gap: 0,
    }
  }

  // U-shape: vertices = [bottom, topOfFlight1]. Flight 2 runs PARALLEL
  // to flight 1 in plan view, occupying the SAME forward range
  // [0, run1] but offset perpendicular by `width + flightGap` so an
  // open well sits between them. Flight 2 starts at flight 1's TOP
  // (forward = run1, perpendicular offset = -(width + gap)) and runs
  // BACKWARDS along -u1 to forward = 0 — so both flights' footprints
  // line up vertex-for-vertex in plan view.
  //
  // The landing is the connector platform that lets you cross from
  // flight 1's top to flight 2's bottom: it extends FORWARD past the
  // flights from forward = run1 to forward = run1 + landingDepth, and
  // spans the full perpendicular width [-3W/2 - gap, W/2] so both
  // flights AND the open well sit underneath it.
  //
  // In flight 1's local frame:
  //   - Flight 1: forward [0, run1], side [-W/2, W/2]
  //   - Flight 2: forward [0, run1], side [-3W/2 - gap, -W/2 - gap]
  //   - Landing:  forward [run1, run1 + landingDepth],
  //               side    [-3W/2 - gap, W/2]
  const { frame: f1, runMeters: run1 } = frameFromVertices(vertices[0], vertices[1])
  const tread = autoTread(run1, stepsPer)
  const flightGap = Math.max(0, config.flightGap ?? 0)
  const flight1Top = baseElev + stepsPer * riser
  const landingTop = flight1Top + landingThickness
  // Flight 2 frame: starts at flight 1's TOP (forward = run1) on the
  // opposite side of the well (perpendicular offset = -(width + gap)),
  // runs in -u1 so its last step lands at forward = 0 — same forward
  // position as flight 1's bottom anchor.
  const fSide = -(width + flightGap)
  const east = run1 * f1.ux + fSide * f1.px
  const north = run1 * f1.uy + fSide * f1.py
  const flight2Frame: FlightFrame = {
    start: [vertices[0][0] + metersToLngDelta(east, f1.midLat), vertices[0][1] + metersToLatDelta(north)],
    ux: -f1.ux,
    uy: -f1.uy,
    // Flipping both axes keeps `(p) = perpendicular-left-of-u` invariant
    // — flight 2's "left" is on the same physical side as flight 1's
    // "left" so the polygon orientation stays consistent.
    px: -f1.px,
    py: -f1.py,
    midLat: f1.midLat,
  }
  return {
    type: 'u',
    width,
    riser,
    flights: [
      { frame: f1, flightIndex: 0, steps: stepsPer, tread, base: baseElev },
      { frame: flight2Frame, flightIndex: 2, steps: stepsPer, tread, base: landingTop },
    ],
    landing: { frame: f1, f: [run1, run1 + landingDepth], s: [-1.5 * width - flightGap, 0.5 * width], base: flight1Top, top: landingTop },
    gap: flightGap,
  }
}

function centroidOf(coords: [number, number][]): [number, number] {
  return [coords.reduce((s, c) => s + c[0], 0) / coords.length, coords.reduce((s, c) => s + c[1], 0) / coords.length]
}

/** Stairs rotate about the centroid of every step corner (rings included). */
function stairCentroid(fc: FeatureCollection<Polygon, StairFeatureProps>): [number, number] | null {
  const all: [number, number][] = []
  for (const f of fc.features) for (const ring of f.geometry.coordinates) for (const c of ring) all.push(c as [number, number])
  return all.length < 3 ? null : centroidOf(all)
}

/**
 * Rotate all polygon features around their collective centroid.
 * Returns a new FeatureCollection — does not mutate the input.
 */
function rotateStairFeatures(
  fc: FeatureCollection<Polygon, StairFeatureProps>,
  degrees: number,
  fixedPivot?: [number, number],
): FeatureCollection<Polygon, StairFeatureProps> {
  if (Math.abs(degrees) < 1e-6 || fc.features.length === 0) return fc
  // Collect all coordinates to compute a collective centroid.
  const allCoords: [number, number][] = []
  for (const f of fc.features) {
    for (const ring of f.geometry.coordinates) {
      for (const c of ring) allCoords.push(c as [number, number])
    }
  }
  if (allCoords.length < 3) return fc
  const pivot: [number, number] = fixedPivot ?? centroidOf(allCoords)
  const features = fc.features.map((f) => {
    const closed = [...f.geometry.coordinates[0], f.geometry.coordinates[0][0]]
    try {
      const poly = turfPolygon([closed])
      const rotated = transformRotate(poly, degrees, { pivot })
      return {
        ...f,
        geometry: {
          type: 'Polygon' as const,
          coordinates: [rotated.geometry.coordinates[0].slice(0, -1) as [number, number][]],
        },
      }
    } catch {
      return f
    }
  })
  return { type: 'FeatureCollection', features }
}

/**
 * Lifts rotate around the drawn run's midpoint — fixed, so the static
 * parts, the moving treads (built separately every frame) and the icons
 * all turn about the same point. Stairs keep their historical pivot
 * (centroid of every step corner).
 */
function liftPivot(shape: StairShape): [number, number] | undefined {
  if (!isLiftType(shape.config.stairType) || shape.vertices.length < 2) return undefined
  const [a, b] = shape.vertices
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

/** Convenience wrapper that pulls vertices straight off a StairShape row. */
export function stairToFeatureCollection(
  shape: StairShape,
  options?: StairBuildOptions,
): FeatureCollection<Polygon, StairFeatureProps> {
  const fc = buildStairFeatures(shape.vertices, shape.config, shape.id, options)
  return rotateStairFeatures(fc, shape.rotation ?? 0, liftPivot(shape))
}

export interface LiftIconProps {
  shapeId?: number
  icon: 'escalator-up' | 'escalator-down' | 'elevator'
  /** Metres above sea level — the symbol's z-offset. */
  z: number
  outOfService: boolean
  label: string
}

/**
 * Wayfinding icons for a lift: each escalator end (with its travel
 * direction) and the elevator's door at every stop. Empty for stairs.
 */
export function liftIconFeatures(
  shape: StairShape,
  floorElevations?: ReadonlyMap<number, number>,
): Feature<Point, LiftIconProps>[] {
  const config = shape.config
  if (!isLiftType(config.stairType) || shape.vertices.length < 2) return []
  const { frame, runMeters } = frameFromVertices(shape.vertices[0], shape.vertices[1])
  const toLngLat = localFrameToLngLat(frame)
  const levels = resolveLiftLevels(config, floorElevations)
  const pivot = liftPivot(shape)!
  const rotation = shape.rotation ?? 0
  const rad = (-rotation * Math.PI) / 180
  const cosLat = Math.cos((pivot[1] * Math.PI) / 180)
  // Same clockwise-degrees rotation turf applies to the polygons, done in
  // a locally isotropic metre frame around the pivot.
  const rotate = ([lng, lat]: [number, number]): [number, number] => {
    if (Math.abs(rotation) < 1e-6) return [lng, lat]
    const x = (lng - pivot[0]) * cosLat
    const y = lat - pivot[1]
    return [pivot[0] + (x * Math.cos(rad) - y * Math.sin(rad)) / cosLat, pivot[1] + x * Math.sin(rad) + y * Math.cos(rad)]
  }
  const label = config.showLabels ? config.label : ''
  return liftIconAnchors(config, levels, runMeters).map((a) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: rotate(toLngLat(a.f, a.s)) },
    properties: {
      shapeId: shape.id,
      icon: a.icon,
      z: a.z,
      outOfService: config.status === 'out-of-service',
      label,
    },
  }))
}

// ---------------------------------------------------------------------------
// Code-compliance + ergonomic checks (Blondel / IBC / OSHA)
// ---------------------------------------------------------------------------

export type StairComplianceSeverity = 'ok' | 'warning' | 'violation'

export interface StairComplianceIssue {
  severity: 'warning' | 'violation'
  message: string
  rule: string
}

export interface StairCompliance {
  severity: StairComplianceSeverity
  issues: StairComplianceIssue[]
  /** 2·R + T in meters of the WORST flight. */
  blondelMeters: number
  treadDepth: number
  riserHeight: number
}

/**
 * Evaluate stair geometry against three layered checks:
 *   1. Blondel ergonomic formula: 2·R + T ∈ [0.60, 0.63] m
 *   2. IBC public-building limits: R ∈ [0.10, 0.18] m, T ≥ 0.28 m
 *   3. OSHA industrial limits:    R ∈ [0.15, 0.19] m, T ≥ 0.24 m
 *
 * `flightRunMeters` is the total drag length the user defined — for
 * L/U shapes we divide by `stepsPerFlight(config)` to get the
 * per-flight tread depth, then evaluate. (For 'auto' tread mode that
 * matches reality; for 'manual' the user's config.treadDepth wins.)
 */
export function evaluateStairCompliance(
  config: StairShapeConfig,
  runLengthMeters: number,
): StairCompliance {
  const riser = config.riserHeight
  const tread =
    config.treadMode === 'manual'
      ? config.treadDepth
      : runLengthMeters / Math.max(1, stepsPerFlight(config))
  const blondel = 2 * riser + tread
  const issues: StairComplianceIssue[] = []

  if (blondel < 0.6 || blondel > 0.63) {
    issues.push({
      severity: 'warning',
      rule: 'blondel',
      message: `2·R+T = ${(blondel * 100).toFixed(1)} cm is outside the 60–63 cm comfort range.`,
    })
  }
  if (riser > 0.178) {
    issues.push({
      severity: 'violation',
      rule: 'ibc.riserMax',
      message: `Riser ${(riser * 100).toFixed(1)} cm exceeds the 17.8 cm (7 in) IBC limit.`,
    })
  }
  if (riser < 0.1) {
    issues.push({
      severity: 'violation',
      rule: 'ibc.riserMin',
      message: `Riser ${(riser * 100).toFixed(1)} cm is below the 10 cm (4 in) IBC minimum.`,
    })
  }
  if (tread < 0.279) {
    issues.push({
      severity: 'violation',
      rule: 'ibc.treadMin',
      message: `Tread ${(tread * 100).toFixed(1)} cm is below the 27.9 cm (11 in) IBC minimum.`,
    })
  }
  if (riser > 0.19) {
    issues.push({
      severity: 'violation',
      rule: 'osha.riserMax',
      message: `Riser ${(riser * 100).toFixed(1)} cm exceeds the 19 cm OSHA industrial limit.`,
    })
  }
  const severity: StairComplianceSeverity = issues.some((i) => i.severity === 'violation')
    ? 'violation'
    : issues.length > 0
      ? 'warning'
      : 'ok'
  return {
    severity,
    issues,
    blondelMeters: blondel,
    treadDepth: tread,
    riserHeight: riser,
  }
}

// Kept as a public helper for compat — the old single-flight resolver.
// The MapStairOverlay's live preview still calls this for the straight
// case via the new buildStairFeatures dispatch, but the legacy 2-arg
// form is occasionally referenced by sidebar copy.
export function resolveStairRun(
  start: [number, number],
  end: [number, number],
  config: StairShapeConfig,
): {
  effectiveEnd: [number, number]
  treadDepth: number
  runLength: number
} {
  const stepCount = stepsPerFlight(config)
  const dist = lngLatDistanceMeters(start, end)
  if (config.treadMode === 'manual') {
    const len = stepCount * Math.max(0.01, config.treadDepth)
    if (dist === 0) {
      const dLat = metersToLatDelta(len)
      return {
        effectiveEnd: [start[0], start[1] + dLat],
        treadDepth: config.treadDepth,
        runLength: len,
      }
    }
    const t = len / dist
    return {
      effectiveEnd: [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ],
      treadDepth: config.treadDepth,
      runLength: len,
    }
  }
  const len = Math.max(0.01, dist)
  return { effectiveEnd: end, treadDepth: len / stepCount, runLength: len }
}

/**
 * World-space meshes for a lift: the escalator's sloped parts, or the
 * whole elevator (shaft, entrances, machinery, cabin). Positions are (east, north, up)
 * metres from `vertices[0]`, rotated about the same pivot the extruded
 * parts and icons use; normals are flat per triangle.
 */
export function liftMeshes(
  shape: StairShape,
  floorElevations?: ReadonlyMap<number, number>,
): { solid: LiftMeshData; glass: LiftMeshData } | null {
  const config = shape.config
  if (!isLiftType(config.stairType) || shape.vertices.length < 2 || shape.id === undefined) return null
  const { frame, runMeters } = frameFromVertices(shape.vertices[0], shape.vertices[1])
  const levels = resolveLiftLevels(config, floorElevations)
  const { solid, glass } =
    config.stairType === 'elevator'
      ? buildElevatorMesh(config, levels, runMeters)
      : buildEscalatorMesh(config, levels, runMeters)
  // Local (forward, left) → (east, north) metres from vertices[0].
  const toEN = (mesh: LocalMesh) => {
    const src = mesh.positions
    const out = new Float32Array(src.length)
    for (let i = 0; i < src.length; i += 3) {
      out[i] = src[i] * frame.ux + src[i + 1] * frame.px
      out[i + 1] = src[i] * frame.uy + src[i + 1] * frame.py
      out[i + 2] = src[i + 2]
    }
    return out
  }
  // Pivot = drawn run's midpoint.
  const pivot: [number, number] = [(runMeters / 2) * frame.ux, (runMeters / 2) * frame.uy]
  const rotation = shape.rotation ?? 0
  const origin = shape.vertices[0]
  return {
    solid: placeMesh(toEN(solid), solid.colors, origin, pivot, rotation, `${shape.id}:solid`),
    glass: placeMesh(toEN(glass), glass.colors, origin, pivot, rotation, `${shape.id}:glass`),
  }
}

/**
 * Built-stair plan in metres from the first vertex (see stair-mesh.ts).
 * Exported for tests.
 */
export function stairMeshPlan(vertices: [number, number][], config: StairShapeConfig): StairMeshPlan | null {
  const layout = stairLayout(vertices, config)
  if (!layout) return null
  const v0 = vertices[0]
  const lat0 = layout.flights[0].frame.midLat
  const toM = (ll: [number, number]): [number, number] => [
    (ll[0] - v0[0]) * METERS_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180),
    (ll[1] - v0[1]) * METERS_PER_DEG_LAT,
  ]
  const frameM = (fr: FlightFrame) => ({ o: toM(fr.start), u: [fr.ux, fr.uy] as [number, number], p: [fr.px, fr.py] as [number, number] })
  return {
    type: layout.type,
    width: layout.width,
    riser: layout.riser,
    floor: config.baseElevation,
    gap: layout.gap,
    flights: layout.flights.map((fl) => ({ ...frameM(fl.frame), steps: fl.steps, tread: fl.tread, base: fl.base })),
    landing: layout.landing && { ...frameM(layout.landing.frame), f: layout.landing.f, s: layout.landing.s, top: layout.landing.top },
  }
}

/**
 * Meshes for any stair-tool shape: lifts (`liftMeshes`) and built stairs
 * — flights with treads, risers and soffits, landings, columns and
 * railings (`buildStairMesh`). Same keys and frame as `liftMeshes`;
 * stairs turn about the centroid their extruded click targets use.
 */
export function stairMeshes(
  shape: StairShape,
  floorElevations?: ReadonlyMap<number, number>,
): { solid: LiftMeshData; glass: LiftMeshData } | null {
  if (isLiftType(shape.config.stairType)) return liftMeshes(shape, floorElevations)
  if (shape.vertices.length < 2 || shape.id === undefined) return null
  const plan = stairMeshPlan(shape.vertices, shape.config)
  if (!plan) return null
  const { solid, glass } = buildStairMesh(plan, shape.config)
  const v0 = shape.vertices[0]
  const lat0 = (shape.vertices[0][1] + shape.vertices[1][1]) / 2
  const c = stairCentroid(buildStairFeatures(shape.vertices, shape.config, shape.id)) ?? v0
  const pivot: [number, number] = [
    (c[0] - v0[0]) * METERS_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180),
    (c[1] - v0[1]) * METERS_PER_DEG_LAT,
  ]
  const rotation = shape.rotation ?? 0
  return {
    solid: placeMesh(solid.positions, solid.colors, v0, pivot, rotation, `${shape.id}:solid`),
    glass: placeMesh(glass.positions, glass.colors, v0, pivot, rotation, `${shape.id}:glass`),
  }
}
