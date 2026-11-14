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
  multiLineString as turfMultiLineString,
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
/** Wall outline closing distance (m): seals small gaps and wall joints. */
const CLOSE_M = 1.5
/** Widest opening bridged as a doorway (m) — main entrances, loading bays.
 *  Openings wider than 2 × CLOSE_M aren't sealed by the closing step, and
 *  an unsealed opening lets "outside" leak into the room behind it. */
const MAX_OPENING_M = 8
/** A wall end faces an opening when the gap runs within this angle (°) of
 *  the wall's own direction — i.e. the two ends sit on one wall line. */
const OPENING_ALIGN_DEG = 15
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

/**
 * Union with a fallback. The one-shot union can throw on many overlapping
 * buffers with exactly collinear edges ("Unable to complete output ring");
 * returning one part then would shrink a whole floor to a single wall. So
 * on failure merge part by part, nudging a part that still won't merge by
 * a couple of centimetres, and only skip it if that fails too.
 */
function unionAll(parts: Area[]): Area | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  try {
    return (turfUnion(turfFC(parts)) as Area | null) ?? null
  } catch {
    let acc: Area = parts[0]
    for (const p of parts.slice(1)) {
      try {
        acc = (turfUnion(turfFC([acc, p])) as Area | null) ?? acc
      } catch {
        try {
          const nudged = turfBuffer(p, 0.02, { units: 'meters' }) as Area | undefined
          if (nudged) acc = (turfUnion(turfFC([acc, nudged])) as Area | null) ?? acc
        } catch {
          /* skip a part that can't be merged */
        }
      }
    }
    return acc
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
  if (walls.length === 0) return null
  // Building an outline costs 50–250 ms. Callers re-run whenever any shape
  // in the facility changes (new arrays, same walls), so cache by the
  // walls' geometry: an opacity tweak or an area drag must not rebuild it.
  const key = walls.map((l) => `${l.config.wallThickness ?? 0.3}:${l.vertices.flat().join(',')}`).join('|')
  const hit = outlineCache.get(key)
  if (hit !== undefined) return hit
  const out = wallFootprint(walls)
  outlineCache.set(key, out)
  if (outlineCache.size > OUTLINE_CACHE_MAX) outlineCache.delete(outlineCache.keys().next().value as string)
  return out
}

const OUTLINE_CACHE_MAX = 16
const outlineCache = new Map<string, Area | null>()

interface WallSegment {
  vertices: [number, number][]
  /** Wall thickness, metres. */
  thickness: number
}

/**
 * Door openings as extra wall segments. A doorway is a gap between two
 * wall ends that point at each other along one wall line (both ends'
 * directions within OPENING_ALIGN_DEG of the gap) and no wider than
 * MAX_OPENING_M. Each end bridges to its nearest such partner only.
 *
 * Without this, a main entrance wider than 2 × CLOSE_M stays open: the
 * outline's outer ring runs in through it and the hall behind the door
 * counts as outside the building.
 */
function doorwayBridges(walls: WallSegment[]): WallSegment[] {
  if (walls.length === 0) return []
  // Local metres around the first vertex — plenty accurate across a building.
  const [lng0, lat0] = walls[0].vertices[0]
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180)
  const ky = 110_540
  const toM = ([lng, lat]: [number, number]) => [(lng - lng0) * kx, (lat - lat0) * ky]

  interface End { wall: number; at: [number, number]; m: number[]; dir: number[]; thickness: number }
  const ends: End[] = []
  walls.forEach((w, i) => {
    const v = w.vertices
    if (v.length < 2) return
    for (const [tip, prev] of [[v[0], v[1]], [v[v.length - 1], v[v.length - 2]]] as const) {
      const a = toM(tip), b = toM(prev)
      const len = Math.hypot(a[0] - b[0], a[1] - b[1])
      if (len < 1e-6) continue
      ends.push({ wall: i, at: tip, m: a, dir: [(a[0] - b[0]) / len, (a[1] - b[1]) / len], thickness: w.thickness })
    }
  })

  const cosMax = Math.cos((OPENING_ALIGN_DEG * Math.PI) / 180)
  const bridges: WallSegment[] = []
  const seen = new Set<string>()
  for (let i = 0; i < ends.length; i++) {
    const a = ends[i]
    let best = -1
    let bestDist = Infinity
    for (let j = 0; j < ends.length; j++) {
      const b = ends[j]
      if (j === i || b.wall === a.wall) continue
      const dx = b.m[0] - a.m[0], dy = b.m[1] - a.m[1]
      const dist = Math.hypot(dx, dy)
      // Touching ends are already one wall; too wide isn't a door.
      if (dist < 0.05 || dist > MAX_OPENING_M || dist >= bestDist) continue
      const ux = dx / dist, uy = dy / dist
      if (a.dir[0] * ux + a.dir[1] * uy < cosMax) continue
      if (-(b.dir[0] * ux + b.dir[1] * uy) < cosMax) continue
      best = j
      bestDist = dist
    }
    if (best < 0) continue
    const key = i < best ? `${i}:${best}` : `${best}:${i}`
    if (seen.has(key)) continue
    seen.add(key)
    bridges.push({ vertices: [a.at, ends[best].at], thickness: Math.min(a.thickness, ends[best].thickness) })
  }
  return bridges
}

function wallFootprint(lines: LineShape[]): Area | null {
  const walls: WallSegment[] = lines
    .filter((l) => l.vertices.length >= 2)
    .map((l) => ({ vertices: l.vertices as [number, number][], thickness: Math.max(0.05, l.config.wallThickness ?? 0.3) }))
  // One buffer per wall thickness, over a MultiLineString of all its walls:
  // the buffer merges its own lines robustly, so only a handful of parts
  // reach the union. Buffering wall by wall and union-ing ~100 parts took
  // >1 s on an 87-wall floor (the one-shot union throws on collinear
  // edges and the part-by-part fallback is slow).
  const groups = new Map<number, [number, number][][]>()
  for (const w of [...walls, ...doorwayBridges(walls)]) {
    const t = Math.round(w.thickness * 1000) / 1000
    const g = groups.get(t)
    if (g) g.push(w.vertices)
    else groups.set(t, [w.vertices])
  }
  const parts: Area[] = []
  for (const [thickness, lines] of groups) {
    const radius = thickness / 2 + CLOSE_M
    try {
      const b = turfBuffer(turfMultiLineString(lines), radius, { units: 'meters' }) as Area | undefined
      if (b) parts.push(b)
    } catch {
      // A degenerate line can sink the whole group — fall back to one by one.
      for (const l of lines) {
        try {
          const b = turfBuffer(turfLineString(l), radius, { units: 'meters' }) as Area | undefined
          if (b) parts.push(b)
        } catch {
          /* degenerate line */
        }
      }
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
