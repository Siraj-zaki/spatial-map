import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'

import { urlForImage } from './binary-store'
import { buildCircleFeatures } from './circle-generators'
import { buildGridFromLine, type GridConfig } from './grid-generators'
import { imageBboxCenter, imageCroppedCorners } from './image-generators'
import { buildLineWallFeature } from './line-generators'
import { buildPolygonFeature } from './polygon-generators'
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
 * All math runs in Mercator space, where a constant altitude is a
 * constant `z`, making the slab clip two divisions.
 *
 * Footprints always come from the kind's own generator
 * (`buildPolygonFeature`, `buildCircleFeatures`, `buildLineWallFeature`,
 * `buildStairFeatures`, `imageCroppedCorners`) rather than being
 * re-derived from raw vertices — rotation, wall thickness, door
 * openings and image crops are all baked in there, and re-deriving them
 * is how an occluder silently drifts from what is actually painted.
 */

/**
 * Occluders whose top face is within this many metres of a marker's own
 * altitude never hide it — the marker is standing ON that surface, not
 * behind it. Without the slop a marker at `elevation: 0` would be hidden
 * by the very floor it belongs to: a slab drawn as a thin polygon sits a
 * few centimetres proud of the ground (polygons have an 11 cm minimum
 * base, see `POLYGON_MIN_BASE_M`).
 */
const SELF_SURFACE_TOLERANCE_M = 0.5

/**
 * Occluders fainter than this (percent) are treated as see-through and
 * hide nothing. Ghosting an upper floor to peek at the one below is a
 * real workflow — hiding that floor's markers would defeat it.
 */
const OCCLUDER_MIN_OPACITY = 50

/**
 * One extruded solid reduced to what the depth test needs: a footprint
 * in Mercator x/y plus the altitude band it occupies.
 */
export interface OccluderPrism {
  /** `<kind>:<id>` — diagnostics, and stable across rebuilds. */
  key: string
  /**
   * `images` row id when this prism came from a floor plan. A marker
   * whose `floorPlanId` matches is exempt: that plate is its floor.
   */
  floorPlanId?: number
  /** Bottom of the solid in metres. */
  baseM: number
  /** Top of the solid in metres. Equals `baseM` for a flat occluder. */
  topM: number
  zBottom: number
  zTop: number
  /** Footprint as Mercator x/y, open ring (first point not repeated). */
  ring: ReadonlyArray<readonly [number, number]>
  minX: number
  minY: number
  maxX: number
  maxY: number
}

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
 * Reduce every extruded shape in `input` to the prisms that can occlude
 * a marker. Rows that paint nothing (hidden, near-transparent, missing
 * bytes, degenerate footprint) are dropped here so the per-frame loop
 * stays free of guards.
 */
export function buildOccluders(input: OccluderInput): OccluderPrism[] {
  const out: OccluderPrism[] = []
  // Each row's prisms are cached by the row object (the store keeps an
  // unchanged row the same object), so dragging one rack's slider rebuilds
  // that rack's prisms only — not every wall, stair and floor plate, five
  // times over (each marker / label / door / grid overlay calls this).
  const each = <R extends object>(rows: ReadonlyArray<R> | undefined, build: (row: R, into: OccluderPrism[]) => void, sig?: (row: R) => unknown[]) => {
    for (const row of rows ?? []) out.push(...cachedPrisms(row, sig ? sig(row) : EMPTY_SIG, build))
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
    pushPolygonRings(into, `polygon:${poly.id}`, feature.geometry.coordinates, {
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
      pushPolygonRings(into, `circle:${circle.id}:${i}`, feature.geometry.coordinates, { baseM, topM })
    }
  })

  each(input.lines, (line, into) => {
    if (line.id === undefined) return
    if (!paints(line.visible, line.config.opacity)) return
    // Returns null for a flat polyline — a 2D stroke has no volume and
    // cannot hide anything, which is exactly the gate we want. Called
    // without `attachedDoors`, so the wall stays solid where its doors
    // are: a marker framed in a doorway is hidden rather than shown,
    // which is the safe direction and keeps the door store out of here.
    const wall = buildLineWallFeature(line)
    if (!wall) return
    const baseM = Math.max(0, line.config.elevation ?? 0)
    pushPolygonRings(into, `line:${line.id}`, wall.geometry.coordinates, {
      baseM,
      topM: baseM + Math.max(0, line.config.height ?? 0),
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
      pushPolygonRings(into, `stair:${stair.id}:${i}`, feature.geometry.coordinates, {
        baseM: Math.max(0, feature.properties.base_height ?? 0),
        topM: Math.max(0, feature.properties.height ?? 0),
      })
    }
  })

  // Rack inputs are often fresh wrapper objects (`CommittedLine`) around
  // the row's own config / start / current, so cache on the config object
  // and check the corner arrays too.
  for (const grid of input.grids ?? []) {
    out.push(
      ...cachedPrisms(grid.config, [grid.id, grid.start, grid.current], (cfg, into) => {
        if (grid.id === undefined) return
        if (!paints(true, cfg.opacity ?? 100)) return
        // Materialise the grid to individual cell features and emit one
        // prism per cell (row × col × level). That's what makes a rear
        // rack correctly hide a label on a rack behind it: each rack cell
        // is its own extruded box at a specific (footprint, altitude-band)
        // slice. The embedded-check in `computeOccludedIds` (with `>=` on
        // baseM) covers a label sitting AT its own cell's top face;
        // adjacent cells' footprints don't overlap the label point, so
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
          pushPolygonRings(into, `grid:${grid.id}:${props.row}:${props.col}:${props.level}`, cell.geometry.coordinates, { baseM, topM })
        }
      }),
    )
  }

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

/**
 * Emit one prism per polygon piece. Interior rings (holes) are ignored:
 * the only hole this app punches is a door opening, and those cut the
 * full wall thickness, so `buildLineWallFeature` hands back separate
 * MultiPolygon pieces rather than a ring-in-ring. Treating a rare true
 * hole as solid over-occludes slightly, which is the safe direction.
 */
function pushPolygonRings(
  out: OccluderPrism[],
  key: string,
  rings: number[][][],
  band: { baseM: number; topM: number },
): void {
  const outer = rings[0]
  if (!outer || outer.length < 3) return
  pushPrism(out, {
    key,
    lngLatRing: outer as [number, number][],
    baseM: band.baseM,
    topM: band.topM,
  })
}

function pushPrism(
  out: OccluderPrism[],
  spec: {
    key: string
    floorPlanId?: number
    lngLatRing: ReadonlyArray<readonly [number, number]>
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
  out.push({
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
  })
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
 * Ids of the markers currently hidden behind an occluder.
 *
 * Cheap enough to call on every `move`: one camera read, then per marker
 * per prism a slab clip (two divisions) behind a bbox reject, and the
 * prism loop breaks on the first hit.
 */
export function computeOccludedMarkerIds(
  map: MapboxMapInstance,
  markers: ReadonlyArray<MarkerShape>,
  occluders: ReadonlyArray<OccluderPrism>,
): Set<number> {
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
  return computeOccludedIds(map, targets, occluders)
}

/**
 * v5.4 — generalised depth test, same solver as `computeOccludedMarkerIds`
 * but takes any `OccludableTarget[]`. Feeds the text-label overlay's
 * floor-plan hiding.
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

  for (const marker of targets) {
    const altitudeM = Math.max(0, marker.elevationM ?? 0)
    const point = mapboxgl.MercatorCoordinate.fromLngLat(
      marker.position as [number, number],
      altitudeM,
    )
    const dx = point.x - camera.x
    const dy = point.y - camera.y
    const dz = point.z - camera.z

    for (const prism of occluders) {
      if (
        prism.floorPlanId !== undefined &&
        prism.floorPlanId === marker.floorPlanId
      ) {
        continue
      }
      // Standing on it (or on something above it) — not behind it.
      if (prism.topM <= altitudeM + SELF_SURFACE_TOLERANCE_M) continue

      // Clip the camera→marker segment to the prism's altitude slab.
      let tLo: number
      let tHi: number
      if (Math.abs(dz) < 1e-15) {
        // Camera level with the marker: the segment stays at one
        // altitude, so it either lies inside the slab or misses it.
        if (camera.z < prism.zBottom || camera.z > prism.zTop) continue
        tLo = 0
        tHi = 1
      } else {
        const ta = (prism.zBottom - camera.z) / dz
        const tb = (prism.zTop - camera.z) / dz
        tLo = Math.min(ta, tb)
        tHi = Math.max(ta, tb)
      }
      // Outside (0, 1) the crossing sits behind the eye or past the
      // marker — this is what makes geometry BELOW a marker fall out
      // when looking down at it.
      if (tHi <= 0 || tLo >= 1) continue
      if (tLo < 0) tLo = 0
      if (tHi > 1) tHi = 1

      const ax = camera.x + tLo * dx
      const ay = camera.y + tLo * dy
      const bx = camera.x + tHi * dx
      const by = camera.y + tHi * dy
      if (Math.max(ax, bx) < prism.minX) continue
      if (Math.min(ax, bx) > prism.maxX) continue
      if (Math.max(ay, by) < prism.minY) continue
      if (Math.min(ay, by) > prism.maxY) continue

      // A marker buried inside a solid is an authoring artifact (e.g.
      // left at elevation 0 on top of a shape extruded from 0). Hiding
      // it would make it blink in and out as the camera orbits, so the
      // solid a marker is embedded in never occludes it.
      //
      // The `>=` on `baseM` is deliberate — v5.4: text labels almost
      // always sit AT floor level (altitude 0) inside rooms whose
      // polygon extrudes UP from 0 (walls). With a strict `>` those
      // labels never satisfied the "embedded" test and every one was
      // hidden by the very room it belongs to. `>=` treats "sitting on
      // the floor of a room" as embedded too, which is what a label /
      // sensor on the floor plan is.
      if (
        altitudeM >= prism.baseM &&
        altitudeM < prism.topM &&
        containsPoint(prism.ring, point.x, point.y)
      ) {
        continue
      }

      if (segmentHitsRing(prism.ring, ax, ay, bx, by)) {
        occluded.add(marker.id)
        break
      }
    }
  }
  return occluded
}

/**
 * Does the 2D segment a→b touch the ring's area? True when either
 * endpoint is inside, or any edge is crossed (the segment passes
 * straight through).
 */
function segmentHitsRing(
  ring: ReadonlyArray<readonly [number, number]>,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  if (containsPoint(ring, ax, ay)) return true
  if (containsPoint(ring, bx, by)) return true
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (
      segmentsCross(ax, ay, bx, by, ring[j][0], ring[j][1], ring[i][0], ring[i][1])
    ) {
      return true
    }
  }
  return false
}

function cross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

/** Strict segment intersection; collinear touching doesn't count. */
function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = cross(ax, ay, bx, by, cx, cy)
  const d2 = cross(ax, ay, bx, by, dx, dy)
  const d3 = cross(cx, cy, dx, dy, ax, ay)
  const d4 = cross(cx, cy, dx, dy, bx, by)
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0
}

/** Even-odd crossing test. The ring is open (no repeated first point). */
function containsPoint(
  ring: ReadonlyArray<readonly [number, number]>,
  x: number,
  y: number,
): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}
