import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'

import { urlForImage } from './binary-store'
import { buildCircleFeatures } from './circle-generators'
import { buildGridFromLine, type GridConfig } from './grid-generators'
import { imageBboxCenter, imageCroppedCorners } from './image-generators'
import { buildLineWallFeature, rotateLine } from './line-generators'
import {
  occluderIndexFor,
  queryOccluder,
  registerOccluderGroups,
  type OccluderPrism,
} from './occluder-index'
import { buildPolygonFeature } from './polygon-generators'
import { leaningWallSlices, wallLeans } from './sloped-mesh'
import { stairToFeatureCollection } from './stair-generators'
import type {
  CircleShape,
  ImageShape,
  LineShape,
  MarkerShape,
  PolygonShape,
  StairShape,
} from './shapes'

/**
 * Depth occlusion for HTML markers.
 *
 * Markers are `mapboxgl.Marker` DOM nodes composited above the canvas,
 * so they live outside the GL depth buffer entirely: a marker on the
 * ground floor keeps drawing over every slab, wall and staircase stacked
 * above it, and a top-down camera shows all floors' markers at once with
 * nothing to tell them apart. Mapbox's own `occludedOpacity` only covers
 * 3D *terrain*, never custom layers, so there is no built-in knob.
 *
 * We recover the missing depth test analytically instead of reading
 * pixels back off the GPU. Everything this app extrudes is a **prism**:
 * a footprint ring swept between two altitudes (`elevation` →
 * `elevation + height`). So "is this marker behind something?" reduces
 * to clipping the camera→marker segment to each prism's altitude slab
 * and asking whether the surviving span crosses the footprint. One
 * uniform test covers both cases that matter:
 *
 *  - **under a slab** — the span crosses the footprint of a floor above.
 *  - **behind a wall** — the span crosses a thin footprint spanning the
 *    camera's own altitude band.
 *
 * A flat occluder (floor-plan raster, or a polygon with `height: 0`) is
 * just the degenerate prism where base and top coincide, so the flat
 * case stays a single plane solve.
 *
 * A footprint keeps its holes. A closed-loop wall's buffer is a band
 * around an open middle, and a leaning roof's plan is a ring over the
 * pitch: the prism carries the interior rings (`OccluderPrism.holes`) and
 * every footprint test reads them with even-odd parity, so nothing behind
 * the opening counts as hidden. (Dropping the hole once turned a stadium
 * canopy into a 49,000 m² lid that hid 191 of 194 markers.)
 *
 * All math runs in Mercator space, where a constant altitude is a
 * constant `z`, making the slab clip two divisions.
 *
 * Footprints always come from the kind's own generator
 * (`buildPolygonFeature`, `buildCircleFeatures`, `buildLineWallFeature`,
 * `leaningWallSlices`, `buildStairFeatures`, `imageCroppedCorners`)
 * rather than being re-derived from raw vertices — rotation, wall
 * thickness, lean and image crops are all baked in there, and
 * re-deriving them is how an occluder silently drifts from what is
 * actually painted. A leaning wall occludes as up to 8 stacked slices
 * that follow its drawn profile (the mesh overhangs its base strip by
 * `lean`); every slice keeps the key `line:<id>`.
 *
 * Cost. A stadium is ~30k prisms (one per seat cell) × ~440 targets on
 * every camera move, so the per-prism test runs behind a two-level BVH
 * (`occluder-index.ts`) that skips prisms the segment provably misses —
 * same verdicts as the plain loop, ~100× less work. `buildOccluders`
 * hands every overlay with the same inputs the same list (so one index),
 * and `updateOcclusion` lets an overlay skip unchanged cameras and write
 * only the ids whose occluded flag flipped.
 */

/**
 * Occluders fainter than this (percent) are treated as see-through and
 * hide nothing. Ghosting an upper floor to peek at the one below is a
 * real workflow — hiding that floor's markers would defeat it.
 */
const OCCLUDER_MIN_OPACITY = 50

// The prism type and the per-prism test live with the spatial index that
// drives them (`occluder-index.ts`); re-exported so callers keep one import.
export type { OccluderPrism } from './occluder-index'

/**
 * The shape lists a marker can hide behind. Pass the SAME arrays handed
 * to each shape overlay, gated on that layer's visibility — the
 * warehouse filter and hidden-floor cascade are already applied there,
 * and geometry the user hid must stop occluding. Omit a kind to exclude
 * it entirely.
 */
export interface OccluderInput {
  images?: ReadonlyArray<ImageShape>
  polygons?: ReadonlyArray<PolygonShape>
  circles?: ReadonlyArray<CircleShape>
  lines?: ReadonlyArray<LineShape>
  stairs?: ReadonlyArray<StairShape>
  /**
   * Rack grids. Each row is materialised into one prism per cell (row ×
   * col × level) using the same `buildGridFromLine` the overlay uses,
   * so a rear rack cell correctly hides labels sitting on cells behind
   * it. Accepts the persisted `Grid` shape as well as the lightweight
   * `CommittedLine` the editor already carries — only start/current/
   * config/id are required.
   */
  grids?: ReadonlyArray<GridOccluderInput>
}

/**
 * Light shape that both the persisted `Grid` (`lib/db.ts`) and the
 * overlay's `CommittedLine` satisfy. Keeps `marker-occlusion.ts` from
 * having to import Dexie types.
 */
export interface GridOccluderInput {
  id?: number
  start: [number, number]
  current: [number, number]
  config: GridConfig
  /** Same self-floor exemption other kinds use. Optional. */
  floorPlanId?: number
}

/** Shared visibility / see-through gate for every kind. */
function paints(visible: boolean | undefined, opacityPercent: number): boolean {
  return visible !== false && opacityPercent >= OCCLUDER_MIN_OPACITY
}

/**
 * Recent `buildOccluders` results keyed by the identity of the six input
 * arrays, most recent first. The marker, text-label, door and grid
 * overlays are handed the same arrays, so they get back the SAME list —
 * and with it one shared spatial index (`occluderIndexFor` caches by list
 * identity) instead of four or five copies. Same assumption the overlays'
 * `useMemo` deps already make: input arrays are never mutated in place.
 */
const RECENT_OCCLUDER_SETS = 8
const recentOccluderSets: { key: unknown[]; prisms: OccluderPrism[] }[] = []

/**
 * Reduce every extruded shape in `input` to the prisms that can occlude
 * a marker. Rows that paint nothing (hidden, near-transparent, missing
 * bytes, degenerate footprint) are dropped here so the per-frame loop
 * stays free of guards.
 *
 * Calls with the same input arrays return the same list instance; treat
 * it as read-only (it is shared between overlays).
 */
export function buildOccluders(input: OccluderInput): OccluderPrism[] {
  const key: unknown[] = [input.images, input.polygons, input.circles, input.lines, input.stairs, input.grids]
  for (let i = 0; i < recentOccluderSets.length; i++) {
    const entry = recentOccluderSets[i]
    if (entry.key.every((v, k) => v === key[k])) {
      if (i > 0) {
        recentOccluderSets.splice(i, 1)
        recentOccluderSets.unshift(entry)
      }
      return entry.prisms
    }
  }

  // One array per source row, in input order. The flat list is their
  // concatenation, and the index builds one bottom-level tree per group.
  const groups: OccluderPrism[][] = []
  // Each row's prisms are cached by the row object (the store keeps an
  // unchanged row the same object), so dragging one rack's slider rebuilds
  // that rack's prisms only — not every wall, stair and floor plate, five
  // times over (each marker / label / door / grid overlay calls this).
  const each = <R extends object>(rows: ReadonlyArray<R> | undefined, build: (row: R, into: OccluderPrism[]) => void, sig?: (row: R) => unknown[]) => {
    for (const row of rows ?? []) {
      const prisms = cachedPrisms(row, sig ? sig(row) : EMPTY_SIG, build)
      if (prisms.length > 0) groups.push(prisms)
    }
  }

  each(input.images, (img, into) => {
    if (img.id === undefined) return
    if (!paints(img.visible, img.config.opacity)) return
    if (urlForImage(img) === '') return
    // The raster paints the CROPPED quad, so that — not the full bbox —
    // is the surface a marker can hide behind.
    const corners = imageCroppedCorners(img)
    const center = imageBboxCenter(img)
    if (!corners || !center) return
    const altitudeM = Math.max(0, img.config.elevation ?? 0)
    pushPrism(into, {
      key: `image:${img.id}`,
      floorPlanId: img.id,
      lngLatRing: corners,
      baseM: altitudeM,
      topM: altitudeM,
      // Mercator z is latitude-scaled, so take it once at the plate's
      // center rather than per corner: over a warehouse footprint the
      // per-corner difference is far below the metre we care about, and
      // a single z keeps the plate a true horizontal plane.
      refLngLat: center,
    })
  })

  each(input.polygons, (poly, into) => {
    if (poly.id === undefined) return
    if (!paints(poly.visible, poly.config.opacity)) return
    const feature = buildPolygonFeature(poly)
    if (!feature) return
    const baseM = Math.max(0, poly.config.elevation ?? 0)
    pushPolygonGeometry(into, `polygon:${poly.id}`, feature.geometry.coordinates, {
      baseM,
      topM: baseM + Math.max(0, poly.config.height ?? 0),
    })
  })

  each(input.circles, (circle, into) => {
    if (circle.id === undefined) return
    if (!paints(circle.visible, circle.config.opacity)) return
    const baseM = Math.max(0, circle.config.elevation ?? 0)
    const topM = baseM + Math.max(0, circle.config.height ?? 0)
    // `grid` mode materializes one circle per cell, so a single row can
    // contribute many prisms.
    for (const [i, feature] of buildCircleFeatures(circle).entries()) {
      pushPolygonGeometry(into, `circle:${circle.id}:${i}`, feature.geometry.coordinates, { baseM, topM })
    }
  })

  each(input.lines, (line, into) => {
    if (line.id === undefined) return
    if (!paints(line.visible, line.config.opacity)) return
    const baseM = Math.max(0, line.config.elevation ?? 0)
    const height = Math.max(0, line.config.height ?? 0)
    if (line.vertices && line.vertices.length >= 2 && wallLeans(line.config, line.config.height)) {
      // Drawn as a mesh that overhangs its base by `lean`: occlude as the
      // stacked slices of the drawn profile (a closed loop's slices are
      // bands with the opening as their hole), all under one key.
      const slices = leaningWallSlices(rotateLine(line.vertices, line.rotation ?? 0), line.config, baseM, height)
      for (const slice of slices) {
        pushPolygonGeometry(into, `line:${line.id}`, slice.rings, { baseM: slice.baseM, topM: slice.topM })
      }
      return
    }
    // Returns null for a flat polyline — a 2D stroke has no volume and
    // cannot hide anything, which is exactly the gate we want. Called
    // without `attachedDoors`, so the wall stays solid where its doors
    // are: a marker framed in a doorway is hidden rather than shown,
    // which is the safe direction and keeps the door store out of here.
    // A closed loop's buffer keeps its hole (the room inside is open).
    const wall = buildLineWallFeature(line)
    if (!wall) return
    pushPolygonGeometry(into, `line:${line.id}`, wall.geometry.coordinates, {
      baseM,
      topM: baseM + height,
    })
  })

  each(input.stairs, (stair, into) => {
    if (stair.id === undefined) return
    if (!paints(stair.visible, stair.config.opacity ?? 100)) return
    // Every tread and landing is its own feature carrying its own
    // altitude band, so the staircase occludes as the stepped solid it
    // actually is rather than as one coarse box. Rotation included (it
    // used to be skipped, so a rotated stair occluded where it would
    // have been unrotated); lift glass is see-through and never hides.
    const steps = stairToFeatureCollection(stair)
    for (const [i, feature] of steps.features.entries()) {
      if (feature.properties.glass || feature.properties.seeThrough) continue
      pushPolygonGeometry(into, `stair:${stair.id}:${i}`, feature.geometry.coordinates, {
        baseM: Math.max(0, feature.properties.base_height ?? 0),
        topM: Math.max(0, feature.properties.height ?? 0),
      })
    }
  })

  // Rack inputs are often fresh wrapper objects (`CommittedLine`) around
  // the row's own config / start / current, so cache on the config object
  // and check the corner arrays too.
  for (const grid of input.grids ?? []) {
    const prisms = cachedPrisms(grid.config, [grid.id, grid.start, grid.current], (cfg, into) => {
      if (grid.id === undefined) return
      if (!paints(true, cfg.opacity ?? 100)) return
      // Materialise the grid to individual cell features and emit one
      // prism per cell (row × col × level). That's what makes a rear
      // rack correctly hide a label on a rack behind it: each rack cell
      // is its own extruded box at a specific (footprint, altitude-band)
      // slice. The embedded-check in `prismHides` (`occluder-index.ts`,
      // with `>=` on baseM) covers a label sitting AT its own cell's top
      // face; adjacent cells' footprints don't overlap the label point, so
      // they occlude only when the camera-to-label ray actually crosses
      // them. Multi-level stacks work the same way as long as levels are
      // contiguous — the label of level 0 sits at exactly level 1's
      // baseM, which the `>=` embed check treats as "on the floor of the
      // room above" and skips.
      const { cells } = buildGridFromLine(grid.start, grid.current, cfg, {
        committed: true,
        gridId: grid.id,
      })
      for (const cell of cells) {
        const props = cell.properties
        const baseM = Math.max(0, props.elevation ?? 0)
        const topM = baseM + Math.max(0, props.height ?? 0)
        // Flat cells (height 0) contribute nothing — a 2D fill can't
        // hide a 3D label.
        if (topM <= baseM) continue
        pushPolygonGeometry(into, `grid:${grid.id}:${props.row}:${props.col}:${props.level}`, cell.geometry.coordinates, { baseM, topM })
      }
    })
    if (prisms.length > 0) groups.push(prisms)
  }

  // Plain loop, not `out.push(...group)`: a spread passes every prism as a
  // call argument, which throws a RangeError past ~120k for one big grid.
  const out: OccluderPrism[] = []
  for (const group of groups) {
    for (const prism of group) out.push(prism)
  }
  registerOccluderGroups(out, groups)
  recentOccluderSets.unshift({ key, prisms: out })
  if (recentOccluderSets.length > RECENT_OCCLUDER_SETS) recentOccluderSets.pop()
  return out
}

const EMPTY_SIG: unknown[] = []
const prismCache = new WeakMap<object, { sig: unknown[]; prisms: OccluderPrism[] }>()

/** One row's prisms, rebuilt only when the row object (or its signature) changes. */
function cachedPrisms<R extends object>(row: R, sig: unknown[], build: (row: R, into: OccluderPrism[]) => void): OccluderPrism[] {
  const hit = prismCache.get(row)
  if (hit && hit.sig.length === sig.length && hit.sig.every((v, i) => v === sig[i])) return hit.prisms
  const prisms: OccluderPrism[] = []
  build(row, prisms)
  prismCache.set(row, { sig, prisms })
  return prisms
}

type LngLatRing = ReadonlyArray<readonly [number, number]>

/**
 * Emit one prism per polygon piece of a GeoJSON Polygon (`number[][][]`)
 * or MultiPolygon (`number[][][][]`) coordinate array: the piece's first
 * ring is the outline, the rest are its holes. Holes are kept — a closed
 * wall loop's buffer and a leaning roof's band are rings around an open
 * middle, and treating that middle as solid hides everything inside it.
 * (Door openings would arrive as MultiPolygon pieces, but walls are
 * passed here without their doors, so they stay solid at doorways — the
 * safe direction.)
 */
function pushPolygonGeometry(
  out: OccluderPrism[],
  key: string,
  coords: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>> | ReadonlyArray<ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>>,
  band: { baseM: number; topM: number },
): void {
  if (!coords || coords.length === 0) return
  const pieces = (typeof coords[0]?.[0]?.[0] === 'number' ? [coords] : coords) as ReadonlyArray<
    ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>
  >
  for (const piece of pieces) {
    const outer = piece?.[0]
    if (!outer || outer.length < 3) continue
    pushPrism(out, {
      key,
      lngLatRing: outer as unknown as LngLatRing,
      lngLatHoles: piece.length > 1 ? (piece.slice(1) as unknown as LngLatRing[]) : undefined,
      baseM: band.baseM,
      topM: band.topM,
    })
  }
}

/** Open Mercator copy of a closed or open [lng, lat] ring (closing vertex dropped). */
function mercatorRing(src: LngLatRing): [number, number][] {
  const last = src.length - 1
  const closed = src.length > 3 && src[0][0] === src[last][0] && src[0][1] === src[last][1]
  const ring: [number, number][] = []
  for (let i = 0; i < (closed ? last : src.length); i++) {
    const mc = mapboxgl.MercatorCoordinate.fromLngLat([src[i][0], src[i][1]], 0)
    ring.push([mc.x, mc.y])
  }
  return ring
}

function pushPrism(
  out: OccluderPrism[],
  spec: {
    key: string
    floorPlanId?: number
    lngLatRing: ReadonlyArray<readonly [number, number]>
    /** Interior rings (closed or open); any with fewer than 3 vertices are dropped. */
    lngLatHoles?: ReadonlyArray<LngLatRing>
    baseM: number
    topM: number
    refLngLat?: [number, number]
  },
): void {
  // Generators hand back closed rings (first point repeated); the
  // crossing tests below want it open.
  const src = spec.lngLatRing
  const last = src.length - 1
  const closed =
    src.length > 3 && src[0][0] === src[last][0] && src[0][1] === src[last][1]
  const ring: [number, number][] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < (closed ? last : src.length); i++) {
    const mc = mapboxgl.MercatorCoordinate.fromLngLat(
      [src[i][0], src[i][1]],
      0,
    )
    ring.push([mc.x, mc.y])
    if (mc.x < minX) minX = mc.x
    if (mc.x > maxX) maxX = mc.x
    if (mc.y < minY) minY = mc.y
    if (mc.y > maxY) maxY = mc.y
  }
  if (ring.length < 3) return
  const ref = spec.refLngLat ?? [src[0][0], src[0][1]]
  const prism: OccluderPrism = {
    key: spec.key,
    floorPlanId: spec.floorPlanId,
    baseM: spec.baseM,
    topM: spec.topM,
    zBottom: mapboxgl.MercatorCoordinate.fromLngLat(ref, spec.baseM).z,
    zTop: mapboxgl.MercatorCoordinate.fromLngLat(ref, spec.topM).z,
    ring,
    minX,
    minY,
    maxX,
    maxY,
  }
  if (spec.lngLatHoles) {
    const holes: [number, number][][] = []
    for (const h of spec.lngLatHoles) {
      const m = mercatorRing(h)
      if (m.length >= 3) holes.push(m)
    }
    // Only set when there is one: a hole-free prism keeps the old shape.
    if (holes.length > 0) prism.holes = holes
  }
  out.push(prism)
}

/**
 * Minimal shape the occlusion pass reads. Extracted so callers other
 * than markers (text labels, image labels, …) can reuse the same test
 * without having to synthesise fake `MarkerShape`s.
 */
export interface OccludableTarget {
  id: number
  /** [lng, lat]. */
  position: readonly [number, number]
  /** Metres above ground. Clamped to 0 inside the test. */
  elevationM: number
  /** When set, prisms belonging to the same floor plan are skipped. */
  floorPlanId?: number
}

/**
 * The occlusion targets for a marker list — exactly the targets
 * `computeOccludedMarkerIds` derives on each call. Build once per
 * `markers` change and hand the array to `updateOcclusion`, instead of
 * re-deriving it on every camera move.
 */
export function markerOcclusionTargets(
  markers: ReadonlyArray<MarkerShape>,
): OccludableTarget[] {
  const targets: OccludableTarget[] = []
  for (const m of markers) {
    if (m.id === undefined) continue
    targets.push({
      id: m.id,
      position: m.position,
      elevationM: m.config.elevation ?? 0,
      floorPlanId: m.floorPlanId,
    })
  }
  return targets
}

/**
 * Ids of the markers currently hidden behind an occluder.
 *
 * Cheap enough to call on every `move`: one camera read, then per marker
 * a walk of the occluder index (`occluder-index.ts`) that runs the exact
 * per-prism test only on prisms the camera→marker segment can reach.
 */
export function computeOccludedMarkerIds(
  map: MapboxMapInstance,
  markers: ReadonlyArray<MarkerShape>,
  occluders: ReadonlyArray<OccluderPrism>,
): Set<number> {
  return computeOccludedIds(map, markerOcclusionTargets(markers), occluders)
}

/**
 * v5.4 — generalised depth test, same solver as `computeOccludedMarkerIds`
 * but takes any `OccludableTarget[]`. Feeds the text-label overlay's
 * floor-plan hiding.
 *
 * Stateless: projects every target and returns a fresh set on each call.
 * Per-frame callers should prefer `updateOcclusion`, which returns the
 * same set plus only what changed, and skips repeat camera positions.
 */
export function computeOccludedIds(
  map: MapboxMapInstance,
  targets: ReadonlyArray<OccludableTarget>,
  occluders: ReadonlyArray<OccluderPrism>,
): Set<number> {
  const occluded = new Set<number>()
  if (occluders.length === 0 || targets.length === 0) return occluded
  const camera = map.getFreeCameraOptions().position
  if (!camera) return occluded

  const index = occluderIndexFor(occluders)
  for (const target of targets) {
    const altitudeM = Math.max(0, target.elevationM ?? 0)
    const point = mapboxgl.MercatorCoordinate.fromLngLat(
      target.position as [number, number],
      altitudeM,
    )
    const hit = queryOccluder(
      index,
      camera.x,
      camera.y,
      camera.z,
      point.x,
      point.y,
      point.z,
      altitudeM,
      target.floorPlanId,
      null,
    )
    if (hit) occluded.add(target.id)
  }
  return occluded
}

// ---------------------------------------------------------------------------
// Per-overlay incremental state

/**
 * One overlay's running occlusion pass. Create one per subscription
 * owner (`useRef(createOcclusionState())`) and feed every `move` through
 * `updateOcclusion`. Fields are internal — read results from the
 * returned `OcclusionUpdate`, never from here.
 */
export interface OcclusionState {
  /** Prism list the hints / cached result belong to. */
  prisms: ReadonlyArray<OccluderPrism> | null
  /** Target list the projections / hints / cached result belong to. */
  targets: ReadonlyArray<OccludableTarget> | null
  /** Per target (by index): Mercator x / y / z and clamped altitude. */
  px: Float64Array
  py: Float64Array
  pz: Float64Array
  alt: Float64Array
  /**
   * Per target (by index): the prism that hid it last pass. Tried first
   * next pass — the same prism usually still hides it. Always a member of
   * `prisms`; dropped whenever the prism or target list changes (a hole
   * reads as "no hint").
   */
  hints: (OccluderPrism | null)[]
  /** Camera position `last` was computed for (valid only when `fresh`). */
  cx: number
  cy: number
  cz: number
  /** `last` is the exact result for (prisms, targets, cx/cy/cz). */
  fresh: boolean
  /** The occluded set as last reported — what the caller has written. */
  last: Set<number>
}

/**
 * What changed since the previous `updateOcclusion` on the same state.
 * `entered` / `left` are exactly `occluded − previous` / `previous −
 * occluded`, so a caller that writes `true` for `entered` and `false` for
 * `left` keeps its written state equal to `occluded`.
 */
export interface OcclusionUpdate {
  /** Every currently occluded id. Shared with the state — do not mutate. */
  occluded: ReadonlySet<number>
  /** Ids that became occluded (all occluded ids after create / reset). */
  entered: ReadonlyArray<number>
  /** Ids that stopped being occluded, including ids no longer targeted. */
  left: ReadonlyArray<number>
}

const NO_IDS: ReadonlyArray<number> = Object.freeze([])
const NO_COORDS = new Float64Array(0)

export function createOcclusionState(): OcclusionState {
  return {
    prisms: null,
    targets: null,
    px: NO_COORDS,
    py: NO_COORDS,
    pz: NO_COORDS,
    alt: NO_COORDS,
    hints: [],
    cx: 0,
    cy: 0,
    cz: 0,
    fresh: false,
    last: new Set(),
  }
}

/**
 * Forget everything the state reported. The next `updateOcclusion`
 * returns every occluded id in `entered` and nothing in `left`.
 *
 * Call it whenever the state the caller wrote was wiped behind its back
 * — a style / basemap swap re-creates the source (feature-state gone),
 * `removeFeatureState`, or DOM nodes re-created without `data-occluded`.
 *
 * Returns the set it forgets (what was last reported as occluded), for a
 * caller that wants to un-write it while the target still exists.
 */
export function resetOcclusionState(state: OcclusionState): ReadonlySet<number> {
  const forgotten = state.last
  state.prisms = null
  state.targets = null
  state.px = state.py = state.pz = state.alt = NO_COORDS
  state.hints = []
  state.fresh = false
  state.last = new Set()
  return forgotten
}

/**
 * Incremental `computeOccludedIds`: same occluded set, plus the ids that
 * entered / left it since the previous call, so callers only write state
 * on change.
 *
 * - Returns the previous result untouched (empty diffs, no math) when the
 *   prism list, target list and camera position are all unchanged — e.g.
 *   duplicate `move`s from `setPadding`, `resize` or re-entrant `jumpTo`.
 *   Only the camera's position matters: the test is a segment from the
 *   eye to each target, independent of where the camera looks.
 * - Projects targets once per `targets` array, and tries each target's
 *   last hiding prism before walking the index.
 *
 * `targets` and `occluders` are keyed by identity: build a new array
 * when their content changes, never mutate one in place.
 */
export function updateOcclusion(
  map: MapboxMapInstance,
  targets: ReadonlyArray<OccludableTarget>,
  occluders: ReadonlyArray<OccluderPrism>,
  state: OcclusionState,
): OcclusionUpdate {
  if (state.prisms !== occluders) {
    // Hints must come from the current list, or a prism of a layer the
    // user just hid could keep hiding a marker.
    state.prisms = occluders
    state.hints = []
    state.fresh = false
  }
  if (state.targets !== targets) {
    state.targets = null
    state.hints = []
    state.fresh = false
  }

  let next: Set<number>
  if (occluders.length === 0 || targets.length === 0) {
    next = new Set()
    state.fresh = false
  } else {
    const camera = map.getFreeCameraOptions().position
    if (!camera) {
      next = new Set()
      state.fresh = false
    } else if (
      state.fresh &&
      camera.x === state.cx &&
      camera.y === state.cy &&
      camera.z === state.cz
    ) {
      return { occluded: state.last, entered: NO_IDS, left: NO_IDS }
    } else {
      if (state.targets !== targets) projectTargets(state, targets)
      next = new Set()
      const index = occluderIndexFor(occluders)
      const { px, py, pz, alt, hints } = state
      const cx = camera.x
      const cy = camera.y
      const cz = camera.z
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i]
        const hit = queryOccluder(
          index,
          cx,
          cy,
          cz,
          px[i],
          py[i],
          pz[i],
          alt[i],
          target.floorPlanId,
          hints[i] ?? null,
        )
        hints[i] = hit
        if (hit) next.add(target.id)
      }
      state.cx = cx
      state.cy = cy
      state.cz = cz
      state.fresh = true
    }
  }

  const prev = state.last
  let entered: number[] | null = null
  let left: number[] | null = null
  for (const id of next) if (!prev.has(id)) (entered ??= []).push(id)
  for (const id of prev) if (!next.has(id)) (left ??= []).push(id)
  state.last = next
  return { occluded: next, entered: entered ?? NO_IDS, left: left ?? NO_IDS }
}

/**
 * Project `targets` into the state — the same `fromLngLat` per target
 * `computeOccludedIds` runs each call, done once per array. State is only
 * adopted after every target projected, so a throw leaves it untouched.
 */
function projectTargets(state: OcclusionState, targets: ReadonlyArray<OccludableTarget>): void {
  const n = targets.length
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const pz = new Float64Array(n)
  const alt = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const target = targets[i]
    const altitudeM = Math.max(0, target.elevationM ?? 0)
    const point = mapboxgl.MercatorCoordinate.fromLngLat(
      target.position as [number, number],
      altitudeM,
    )
    px[i] = point.x
    py[i] = point.y
    pz[i] = point.z
    alt[i] = altitudeM
  }
  state.px = px
  state.py = py
  state.pz = pz
  state.alt = alt
  state.hints = []
  state.targets = targets
}
