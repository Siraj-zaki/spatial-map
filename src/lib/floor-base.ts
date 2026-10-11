/**
 * Building base under a raised floor shown on its own.
 *
 * When the lowest floor on screen sits above the ground and the floors
 * beneath it are hidden, it would float in the air. This builds a solid
 * block from the ground to the bottom of that floor (plus thin bands at
 * every storey level and, for the ghost style, the hidden floors' walls
 * as faint outlines) so it reads as the top of a building.
 *
 * Footprint, in order of preference:
 *   1. the floor's slab — area shapes with role `floor-area` and a height
 *      on that floor (already shaped round the lift well);
 *   2. the floor's walls — buffered, merged and closed into one outline,
 *      with the stair / lift footprints cut out;
 *   3. the floor-plan image rectangle.
 *
 * Display-only: nothing here is saved or clickable.
 */

import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from 'geojson'
import {
  buffer as turfBuffer,
  difference as turfDifference,
  featureCollection as turfFC,
  lineString as turfLineString,
  polygon as turfPolygon,
  union as turfUnion,
} from '@turf/turf'

import { imageCroppedCorners } from './image-generators'
import { stairToFeatureCollection } from './stair-generators'
import type { ImageShape, LineShape, PolygonShape, StairShape } from './shapes'

/** A floor counts as raised above this elevation (m). */
const RAISED_MIN_M = 0.5
/** Floors closer than this (m) count as the same level. */
const SAME_LEVEL_M = 0.5
/** Gap kept under the floor image (m) — closer and the base covers the
 *  image at grazing angles (the image draws pushed back in depth). */
const IMAGE_CLEARANCE_M = 0.3
/** Wall outline closing distance (m): bridges door gaps in exterior walls. */
const CLOSE_M = 1.5
/** Band thickness and outset (m). */
const BAND_HALF_M = 0.06
const BAND_OUTSET_M = 0.05

export interface FloorBaseInput {
  floors: ReadonlyArray<ImageShape>
  /** Floors currently shown. */
  visibleFloorIds: ReadonlySet<number>
  polygons: ReadonlyArray<PolygonShape>
  lines: ReadonlyArray<LineShape>
  stairs: ReadonlyArray<StairShape>
  floorElevations?: ReadonlyMap<number, number>
}

export interface FloorBaseProps {
  base_height: number
  height: number
}

export interface FloorBase {
  /** Floor the base sits under. */
  floorId: number
  /** Where the footprint came from. */
  source: 'slab' | 'walls' | 'image'
  /** Body colour: the floor's exterior wall colour (thickest walls), so
   *  the base reads as the same building. */
  color: string
  top: number
  base: FeatureCollection<Polygon | MultiPolygon, FloorBaseProps>
  /** Thin extruded bands at each lower storey. */
  bands: FeatureCollection<Polygon | MultiPolygon, FloorBaseProps>
  /** Footprint outline at the ground and each storey (ghost style). */
  outlines: FeatureCollection<LineString, { z: number }>
  /** Walls of the hidden floors below (ghost style), at their floor height. */
  ghostWalls: FeatureCollection<LineString, { z: number }>
}

const EMPTY = <T>(): FeatureCollection<never, T> => ({ type: 'FeatureCollection', features: [] })

function elevationOf(f: ImageShape): number {
  return Math.max(0, f.config.elevation ?? 0)
}

type Area = Feature<Polygon | MultiPolygon>

function unionAll(parts: Area[]): Area | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  try {
    return (turfUnion(turfFC(parts)) as Area | null) ?? null
  } catch {
    return parts[0]
  }
}

/** Outer ring(s) only — the base is solid, interior holes don't matter. */
function fillHoles(a: Area): Area {
  const g = a.geometry
  if (g.type === 'Polygon') return turfPolygon([g.coordinates[0]])
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => [p[0]]) } }
}

/**
 * Outer outline of a floor's walls: buffered, merged, door gaps closed
 * (CLOSE_M), holes filled, largest part kept. Null without walls.
 * Shared with the floor-plan "hide outside walls" mask.
 */
export function wallOutline(lines: ReadonlyArray<LineShape>): Feature<Polygon | MultiPolygon> | null {
  const walls = lines.filter((l) => l.visible !== false && ((l.config.height ?? 0) > 0 || (l.config.elevation ?? 0) > 0))
  return walls.length > 0 ? wallFootprint(walls) : null
}

function wallFootprint(lines: LineShape[]): Area | null {
  const parts: Area[] = []
  for (const l of lines) {
    if (l.vertices.length < 2) continue
    try {
      const half = Math.max(0.05, l.config.wallThickness ?? 0.3) / 2
      const b = turfBuffer(turfLineString(l.vertices), half + CLOSE_M, { units: 'meters' }) as Area | undefined
      if (b) parts.push(b)
    } catch {
      /* degenerate line */
    }
  }
  const merged = unionAll(parts)
  if (!merged) return null
  // Close: grow by CLOSE_M (above), fill, shrink back.
  const filled = fillHoles(merged)
  let shrunk: Area | undefined
  try {
    shrunk = turfBuffer(filled, -CLOSE_M, { units: 'meters' }) as Area | undefined
  } catch {
    shrunk = undefined
  }
  if (!shrunk) return null
  // Keep the building, not stray partitions far outside it: largest part.
  if (shrunk.geometry.type === 'MultiPolygon') {
    const polys = shrunk.geometry.coordinates.map((c) => turfPolygon(c))
    let best = polys[0]
    let bestArea = -1
    for (const p of polys) {
      const a = ringArea(p.geometry.coordinates[0])
      if (a > bestArea) {
        bestArea = a
        best = p
      }
    }
    return best
  }
  return shrunk
}

function ringArea(ring: number[][]): number {
  let s = 0
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  return Math.abs(s / 2)
}

/** Stair / lift footprints (any vertical circulation inside the base). */
function circulationFootprint(stairs: ReadonlyArray<StairShape>, floorElevations?: ReadonlyMap<number, number>): Area | null {
  const parts: Area[] = []
  for (const s of stairs) {
    if (s.visible === false || s.vertices.length < 2) continue
    try {
      for (const f of stairToFeatureCollection(s, { floorElevations }).features) {
        const b = turfBuffer(f as Feature<Polygon>, 0.25, { units: 'meters' }) as Area | undefined
        if (b) parts.push(b)
      }
    } catch {
      /* skip */
    }
  }
  return unionAll(parts)
}

function outset(a: Area, m: number): Area {
  try {
    return (turfBuffer(a, m, { units: 'meters' }) as Area | undefined) ?? a
  } catch {
    return a
  }
}

function rings(a: Area): number[][][] {
  const g = a.geometry
  return g.type === 'Polygon' ? g.coordinates : g.coordinates.flat()
}

/** Light concrete, used when the floor has no walls to take a colour from. */
const DEFAULT_COLOUR = '#e5e7eb'

/** Colour of the thickest walls on the floor (the exterior shell). */
function wallColour(lines: LineShape[]): string | null {
  const walls = lines.filter((l) => (l.config.height ?? 0) > 0 && /^#[0-9a-f]{6}$/i.test(l.config.color ?? ''))
  if (walls.length === 0) return null
  const thickest = Math.max(...walls.map((l) => l.config.wallThickness ?? 0.3))
  const shell = walls.filter((l) => (l.config.wallThickness ?? 0.3) >= thickest - 1e-6)
  return shell[0].config.color
}

export function buildFloorBase(input: FloorBaseInput): FloorBase | null {
  const floors = input.floors.filter((f): f is ImageShape & { id: number } => f.id !== undefined)
  const visible = floors.filter((f) => input.visibleFloorIds.has(f.id))
  if (visible.length === 0) return null
  const lowest = visible.reduce((a, b) => (elevationOf(b) < elevationOf(a) ? b : a))
  const E = elevationOf(lowest)
  if (E < RAISED_MIN_M) return null

  let source: FloorBase['source'] = 'image'
  let top = E - IMAGE_CLEARANCE_M
  let base: Area[]

  const slabs = input.polygons.filter(
    (p) => p.floorPlanId === lowest.id && p.role === 'floor-area' && (p.config.height ?? 0) > 0 && p.vertices.length >= 3 && p.visible !== false,
  )
  if (slabs.length > 0) {
    source = 'slab'
    top = Math.min(...slabs.map((p) => p.config.elevation ?? E))
    base = slabs.map((p) => turfPolygon([[...p.vertices, p.vertices[0]]]) as Area)
  } else {
    const walls = input.lines.filter(
      (l) => l.floorPlanId === lowest.id && l.visible !== false && ((l.config.height ?? 0) > 0 || (l.config.elevation ?? 0) > 0),
    )
    const outline = walls.length > 0 ? wallFootprint(walls) : null
    if (outline) {
      source = 'walls'
      const well = circulationFootprint(input.stairs, input.floorElevations)
      let cut: Area | null = outline
      if (well) {
        try {
          cut = (turfDifference(turfFC([outline, well])) as Area | null) ?? outline
        } catch {
          cut = outline
        }
      }
      base = cut ? [cut] : [outline]
    } else {
      const c = imageCroppedCorners(lowest)
      if (!c) return null
      base = [turfPolygon([[...c, c[0]]]) as Area]
    }
  }
  if (top < RAISED_MIN_M * 0.5) return null

  const levels = floors
    .map(elevationOf)
    .filter((e) => e > RAISED_MIN_M && e < E - SAME_LEVEL_M)
    .sort((a, b) => a - b)
  const footprint = unionAll(base) ?? base[0]
  const color = wallColour(input.lines.filter((l) => l.floorPlanId === lowest.id)) ?? DEFAULT_COLOUR
  const banded = outset(footprint, BAND_OUTSET_M)

  const prop = (b: number, h: number): FloorBaseProps => ({ base_height: b, height: h })
  const hiddenBelow = new Set(
    floors.filter((f) => !input.visibleFloorIds.has(f.id) && elevationOf(f) < E - SAME_LEVEL_M).map((f) => f.id),
  )
  const elevById = new Map(floors.map((f) => [f.id, elevationOf(f)]))

  return {
    floorId: lowest.id,
    source,
    color,
    top,
    base: { type: 'FeatureCollection', features: base.map((a) => ({ ...a, properties: prop(0, top) })) },
    bands: {
      type: 'FeatureCollection',
      features: levels.map((z) => ({ ...banded, properties: prop(Math.max(0, z - BAND_HALF_M), Math.min(top, z + BAND_HALF_M)) })),
    },
    outlines: {
      type: 'FeatureCollection',
      features: [0.02, ...levels, top].flatMap((z) =>
        rings(footprint).map((ring) => ({ type: 'Feature' as const, properties: { z }, geometry: { type: 'LineString' as const, coordinates: ring } })),
      ),
    },
    ghostWalls: {
      type: 'FeatureCollection',
      features: input.lines
        .filter((l) => l.floorPlanId !== undefined && hiddenBelow.has(l.floorPlanId) && l.vertices.length >= 2)
        .map((l) => ({
          type: 'Feature' as const,
          properties: { z: (elevById.get(l.floorPlanId!) ?? 0) + 0.05 },
          geometry: { type: 'LineString' as const, coordinates: l.vertices },
        })),
    },
  }
}

export const EMPTY_FLOOR_BASE = {
  base: EMPTY<FloorBaseProps>(),
  bands: EMPTY<FloorBaseProps>(),
  outlines: EMPTY<{ z: number }>(),
  ghostWalls: EMPTY<{ z: number }>(),
}
