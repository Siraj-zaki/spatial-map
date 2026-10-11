/**
 * Line geometry helpers.
 *
 * LineString vertices are stored as an ordered array of [lng, lat]
 * points (minimum 2). Rotation is applied around the vertex centroid
 * (mean of the open vertex list) so it matches the pivot the line
 * transform-handle UI uses (`lineCentroid`).
 *
 * Live-draw mirrors the polygon flow — chain LineString + per-vertex
 * dots while the user adds points.
 */

import {
  lineString as turfLineString,
  distance as turfDistance,
  transformRotate,
  buffer as turfBuffer,
  polygon as turfPolygon,
  difference as turfDifference,
  featureCollection as turfFC,
} from '@turf/turf'
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
} from 'geojson'
import type { LineShape, LineShapeConfig } from './shapes'
import type { DoorShape } from './door/types'

const METERS_PER_DEG_LAT = 111_320

export interface LineProps {
  id: string
  lineId?: number
  /** Per-shape style stamped at build time for paint-driven expressions. */
  color: string
  width: number
  /**
   * Border color + width for the casing layer + wall base outline.
   * `borderWidth` is in pixels and applied additively on both sides of
   * the stroke; the casing layer draws with `width + 2 × borderWidth`
   * below the main stroke so the border reads as an outline.
   * Omitted / 0 = no border.
   */
  borderColor?: string
  borderWidth?: number
  opacity: number
  /**
   * `opacity` rounded to the nearest multiple of 10 (0, 10, …, 100).
   * The wall renderer pre-creates one constant-opacity fill-extrusion
   * layer per bucket and routes each feature into the matching bucket
   * via filter, because Mapbox 3.x rejects data expressions on
   * `fill-extrusion-opacity` (it's a per-layer property).
   */
  opacityBucket: number
  /** Dash pattern code: 0 = solid, 1 = dashed, 2 = dotted. Used by a `match` paint expression. */
  dashCode: 0 | 1 | 2
  elevation: number
  height: number
  showLabels: boolean
  label?: string
  labelSize?: number
  labelColor?: string
  /** Where the label anchors along the line. */
  labelPosition?: 'start' | 'middle' | 'end'
  preview?: boolean
}

export type LineFeature = Feature<LineString, LineProps>
export type LineWallFeature = Feature<Polygon, LineProps>

function dashCodeFor(dash: LineShapeConfig['dash']): 0 | 1 | 2 {
  if (dash === 'dashed') return 1
  if (dash === 'dotted') return 2
  return 0
}

function opacityBucketFor(opacity: number): number {
  return Math.max(0, Math.min(100, Math.round((opacity ?? 100) / 10) * 10))
}


function propsFor(
  id: string,
  cfg: LineShapeConfig,
  lineId?: number,
  preview = false
): LineProps {
  return {
    id,
    lineId,
    color: cfg.color,
    width: cfg.width,
    borderColor: cfg.borderColor,
    borderWidth: cfg.borderWidth,
    opacity: cfg.opacity,
    opacityBucket: opacityBucketFor(cfg.opacity),
    dashCode: dashCodeFor(cfg.dash),
    elevation: cfg.elevation,
    height: cfg.height,
    showLabels: cfg.showLabels,
    label: cfg.label,
    labelSize: cfg.labelSize,
    labelColor: cfg.labelColor,
    labelPosition: cfg.labelPosition,
    preview,
  }
}

/**
 * Rotate a LineString's coordinates around the open-list vertex
 * centroid by `degrees`. Uses `lineCentroid` so the pivot matches the
 * line transform-handle UI in map-line-overlay.
 */
function rotateLine(
  vertices: [number, number][],
  degrees: number
): [number, number][] {
  if (Math.abs(degrees) < 1e-6 || vertices.length < 2) return vertices.slice()
  const pivot = lineCentroid(vertices)
  if (!pivot) return vertices.slice()
  let rotated: Feature<LineString>
  try {
    const ls = turfLineString(vertices)
    rotated = transformRotate(ls, degrees, { pivot })
  } catch {
    return vertices.slice()
  }
  return rotated.geometry.coordinates as [number, number][]
}

/**
 * Build the rendered LineString feature for a line shape. Returns null
 * when there are fewer than 2 vertices.
 */
export function buildLineFeature(
  shape: LineShape,
  opts?: { preview?: boolean }
): LineFeature | null {
  if (!shape.vertices || shape.vertices.length < 2) return null
  const rotated = rotateLine(shape.vertices, shape.rotation)
  return {
    type: 'Feature',
    properties: propsFor(
      `line-${shape.id ?? 'preview'}`,
      shape.config,
      shape.id,
      opts?.preview ?? false
    ),
    geometry: { type: 'LineString', coordinates: rotated },
  }
}

/**
 * Buffer the line into a thin polygon used for 3D wall rendering. The
 * buffer width is proportional to the configured stroke width so the
 * wall feels visually consistent with the 2D line. Returns null when
 * height + elevation are both 0 (no wall needed).
 *
 * When `opts.attachedDoors` is provided, every door's opening
 * footprint (a rectangle covering the wall thickness × door width) is
 * subtracted from the buffered polygon via `@turf/difference`, so the
 * fill-extrusion renders with a real hole where each door sits.
 * Mapbox `fill-extrusion` handles polygons-with-inner-rings (and
 * MultiPolygons) natively, so the resulting geometry drops straight
 * into the paint pipeline with no downstream changes.
 */
export function buildLineWallFeature(
  shape: LineShape,
  opts?: { preview?: boolean; attachedDoors?: ReadonlyArray<DoorShape> },
): LineWallFeature | null {
  if (!shape.vertices || shape.vertices.length < 2) return null
  if ((shape.config.height ?? 0) === 0 && (shape.config.elevation ?? 0) === 0) {
    return null
  }
  const rotated = rotateLine(shape.vertices, shape.rotation)
  // Wall thickness comes from the explicit `wallThickness` config (in
  // METERS) so the rendered solid actually reads as a wall — a visible
  // top face, side faces, and a real shadow. The old stroke-derived
  // formula (`width × 0.05`) was tied to the 2D pixel stroke width and
  // produced near-zero thickness at typical zooms, so walls looked like
  // paper sheets at 3D pitch. Default 0.3 m matches a typical interior
  // partition; existing rows without the field get that default.
  const fullThickness = Math.max(0.05, shape.config.wallThickness ?? 0.3)
  const halfWidth = fullThickness / 2
  let buffered: Feature<Polygon> | null
  try {
    const ls = turfLineString(rotated)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = turfBuffer(ls, halfWidth, { units: 'meters' }) as any
    if (!result || !result.geometry) return null
    if (result.geometry.type !== 'Polygon') return null
    buffered = result as Feature<Polygon>
  } catch {
    return null
  }
  if (!buffered) return null

  // Subtract each attached door's opening footprint. Iterative
  // `difference` — each call replaces `buffered` with a possibly
  // punched polygon. If the difference nullifies the wall entirely
  // (which shouldn't happen at reasonable door widths but is possible
  // in pathological cases), we bail and skip further subtractions so
  // the wall stays visible.
  let punched: Feature<Polygon | MultiPolygon> = buffered
  if (opts?.attachedDoors && opts.attachedDoors.length > 0) {
    for (const door of opts.attachedDoors) {
      const footprint = buildDoorOpeningFootprint(door, fullThickness)
      if (!footprint) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const diff = turfDifference(turfFC([punched as any, footprint as any])) as any
        if (!diff || !diff.geometry) continue
        if (diff.geometry.type !== 'Polygon' && diff.geometry.type !== 'MultiPolygon') continue
        punched = diff as Feature<Polygon | MultiPolygon>
      } catch {
        // Turf can throw on self-intersecting or degenerate rings.
        // Skip this door — its own extrusion will still render on top
        // of the un-cut wall, so the visual glitch is a lightly-double-
        // extruded jamb rather than a missing wall.
        continue
      }
    }
  }

  return {
    type: 'Feature',
    properties: propsFor(
      `line-wall-${shape.id ?? 'preview'}`,
      shape.config,
      shape.id,
      opts?.preview ?? false,
    ),
    // fill-extrusion accepts both Polygon and MultiPolygon geometries.
    // Cast is safe because the earlier check narrowed to those two.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geometry: punched.geometry as any,
  }
}

/**
 * Build the rectangular footprint for a door's opening — a polygon
 * that covers the wall's thickness (perpendicular to the door) and the
 * door's full opening width (parallel to the door). Used as the
 * subtractor when cutting a hole in the wall.
 *
 * Geometry:
 *   - centre = midpoint of door.vertices
 *   - axis  = v0 → v1 direction (the door's own local +x)
 *   - width  along axis = distance(v0, v1) — the opening
 *   - height perpendicular = wallThickness + 0.05 m of overshoot on
 *     each side so the subtract has clean, gap-free borders (Turf's
 *     boolean ops can leave hairline slivers at exactly-touching
 *     edges; the overshoot avoids that).
 *
 * Returns `null` when the door is degenerate (zero-length) — the caller
 * skips that door and the wall stays intact.
 */
function buildDoorOpeningFootprint(
  door: DoorShape,
  wallThickness: number,
): Feature<Polygon> | null {
  const [v0, v1] = door.vertices
  const midLat = (v0[1] + v1[1]) / 2
  const cosLat = Math.cos((midLat * Math.PI) / 180)
  const dxM = (v1[0] - v0[0]) * METERS_PER_DEG_LAT * cosLat
  const dyM = (v1[1] - v0[1]) * METERS_PER_DEG_LAT
  const openingMeters = Math.sqrt(dxM * dxM + dyM * dyM)
  if (openingMeters < 1e-6) return null
  // Unit vectors along + perpendicular to the opening, in meters.
  const ux = dxM / openingMeters
  const uy = dyM / openingMeters
  const px = -uy
  const py = ux
  const halfOpening = openingMeters / 2
  // 5 cm overshoot each side of the wall centreline — enough to punch
  // cleanly through even after floating-point rounding.
  const halfPerp = wallThickness / 2 + 0.05
  const midLng = (v0[0] + v1[0]) / 2
  const midLatLL = (v0[1] + v1[1]) / 2
  // Convert each local (along, perp) offset to lng/lat around the
  // midpoint using flat-earth math (exact at warehouse scale).
  const cornerLngLat = (along: number, perp: number): [number, number] => {
    const eastM = along * ux + perp * px
    const northM = along * uy + perp * py
    return [
      midLng + eastM / (METERS_PER_DEG_LAT * cosLat),
      midLatLL + northM / METERS_PER_DEG_LAT,
    ]
  }
  const ring: [number, number][] = [
    cornerLngLat(-halfOpening, -halfPerp),
    cornerLngLat(+halfOpening, -halfPerp),
    cornerLngLat(+halfOpening, +halfPerp),
    cornerLngLat(-halfOpening, +halfPerp),
  ]
  // Close the ring.
  ring.push(ring[0])
  try {
    return turfPolygon([ring])
  } catch {
    return null
  }
}

/**
 * Chain feature shown during a live draw. Same role as the polygon
 * chain — connects committed vertices and extends to the cursor.
 *
 * The optional `snapKind` stamps a property Mapbox paint expressions
 * consume to swap the chain colour + dash while the cursor is snapped
 * to another wall's endpoint or a floor-plan cardinal axis. Legacy
 * callers that pass no snapKind get the original amber-dashed guide.
 */
export function buildLineChainFeature(
  vertices: [number, number][],
  cursor: [number, number] | null,
  config: LineShapeConfig,
  snapKind: 'none' | 'endpoint' | 'axis-horizontal' | 'axis-vertical' = 'none',
): LineFeature | null {
  if (vertices.length === 0) return null
  const coords: [number, number][] = cursor ? [...vertices, cursor] : [...vertices]
  if (coords.length < 2) return null
  const props = propsFor('line-chain', config, undefined, true) as LineProps & {
    snapKind?: string
    snapped?: number
  }
  props.snapKind = snapKind
  // Store as 0/1 int so a Mapbox `case` expression can key off it
  // cheaply (`['==', ['get', 'snapped'], 1]`). Booleans work too but
  // ints round-trip through GeoJSON serialisation more predictably.
  props.snapped = snapKind === 'none' ? 0 : 1
  return {
    type: 'Feature',
    properties: props,
    geometry: { type: 'LineString', coordinates: coords },
  }
}

/**
 * The "axis guide" — a thin dashed ray extending along the cardinal
 * axis the cursor is snapped to, so the user sees WHICH axis they're
 * being pulled onto. Returns null when the snap is not axis-aligned.
 * Start = last committed vertex, End = a point 5× the drawn distance
 * further along the same bearing.
 */
export function buildAxisGuideFeature(
  from: [number, number],
  to: [number, number] | null,
  snapKind: 'axis-horizontal' | 'axis-vertical',
): Feature<LineString> | null {
  if (!to) return null
  return {
    type: 'Feature',
    properties: { snapKind },
    geometry: { type: 'LineString', coordinates: [from, to] },
  }
}

/**
 * The "snap target" — a Point feature at the endpoint the cursor is
 * snapped to, rendered as a solid green ring around the target vertex
 * so the user knows "release here to connect". Null when not endpoint-
 * snapped.
 */
export function buildSnapTargetFeature(
  target: [number, number] | null,
): Feature<{ type: 'Point'; coordinates: [number, number] }, { kind: 'endpoint' }> | null {
  if (!target) return null
  return {
    type: 'Feature',
    properties: { kind: 'endpoint' },
    // The Feature<> generic wants a full geometry — cast keeps the
    // return type expressive at the call site.
    geometry: {
      type: 'Point',
      coordinates: target,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  }
}

/**
 * Build a FeatureCollection of LineStrings ready for a Mapbox geojson
 * source. Skips invisible shapes.
 */
/** Per-line paint override pushed in by the style-rules engine. */
export interface LineStyleOverride {
  /** Stroke color hex (`color` on LineProps). */
  fillColor?: string
  /** Opacity 0-100. */
  fillOpacity?: number
  /** Stroke width in px. */
  borderWidth?: number
  elevation?: number
  height?: number
  labelColor?: string
  labelText?: string
}

export function buildLineFeatureCollection(
  shapes: ReadonlyArray<LineShape>,
  extras?: ReadonlyMap<number, LineStyleOverride> | null,
): FeatureCollection<LineString, LineProps> {
  const features: LineFeature[] = []
  for (const s of shapes) {
    if (s.visible === false) continue
    const f = buildLineFeature(s)
    if (!f) continue
    const override = s.id !== undefined ? extras?.get(s.id) : undefined
    features.push(override ? applyLineOverride(f, override) : f)
  }
  return { type: 'FeatureCollection', features }
}

/**
 * Build a FeatureCollection of wall polygons (for 3D extrusion). Each
 * entry is the buffered line of a shape with elevation/height > 0.
 *
 * The Mappedin-style "darker shadow at the wall base" effect is NOT
 * baked into the geometry — it's produced by the Mapbox GL JS v3 light
 * + shadow pipeline (directional `setLights`, `fill-extrusion-cast-shadows`,
 * `fill-extrusion-vertical-gradient`). See `components/mapbox-map.tsx`
 * for the light setup and `components/map-line-overlay.tsx` for the
 * paint properties that opt the wall in.
 */
export function buildLineWallCollection(
  shapes: ReadonlyArray<LineShape>,
  extras?: ReadonlyMap<number, LineStyleOverride> | null,
  attachedDoorsByLineId?: ReadonlyMap<number, ReadonlyArray<DoorShape>> | null,
): FeatureCollection<Polygon, LineProps> {
  const features: LineWallFeature[] = []
  for (const s of shapes) {
    if (s.visible === false) continue
    const attachedDoors = s.id !== undefined
      ? attachedDoorsByLineId?.get(s.id)
      : undefined
    const f = buildLineWallFeature(s, { attachedDoors })
    if (!f) continue
    const override = s.id !== undefined ? extras?.get(s.id) : undefined
    features.push(
      override ? ({ ...f, properties: applyLineOverrideProps(f.properties, override) } as LineWallFeature) : f,
    )
  }
  return { type: 'FeatureCollection', features }
}

/** Spread the override into a feature's properties; returns a new feature. */
function applyLineOverride(feat: LineFeature, override: LineStyleOverride): LineFeature {
  return { ...feat, properties: applyLineOverrideProps(feat.properties, override) }
}

function applyLineOverrideProps(base: LineProps, override: LineStyleOverride): LineProps {
  const p = { ...base }
  if (override.fillColor !== undefined) p.color = override.fillColor
  if (override.fillOpacity !== undefined) {
    p.opacity = override.fillOpacity
    // Re-bucket so the wall extrusion routes to the correct
    // constant-opacity layer (see LineProps.opacityBucket docstring).
    p.opacityBucket = opacityBucketFor(override.fillOpacity)
  }
  if (override.borderWidth !== undefined) p.width = override.borderWidth
  if (override.elevation !== undefined) p.elevation = override.elevation
  if (override.height !== undefined) p.height = override.height
  if (override.labelColor !== undefined) p.labelColor = override.labelColor
  if (override.labelText !== undefined) p.label = override.labelText
  return p
}

/** Total polyline length in METERS (sum of segment lengths). */
export function lineLengthMeters(vertices: [number, number][]): number {
  if (vertices.length < 2) return 0
  let total = 0
  for (let i = 1; i < vertices.length; i++) {
    total += turfDistance(vertices[i - 1], vertices[i], { units: 'meters' })
  }
  return total
}

/** Centroid of a line's vertex list, or null for <2 vertices. */
export function lineCentroid(
  vertices: [number, number][]
): [number, number] | null {
  if (vertices.length < 2) return null
  let sx = 0
  let sy = 0
  for (const v of vertices) {
    sx += v[0]
    sy += v[1]
  }
  return [sx / vertices.length, sy / vertices.length]
}

/** Point on the line for label placement. */
export function lineLabelAnchor(
  vertices: [number, number][],
  position: 'start' | 'middle' | 'end'
): [number, number] | null {
  if (vertices.length < 2) return null
  if (position === 'start') return vertices[0]
  if (position === 'end') return vertices[vertices.length - 1]
  // Middle = midpoint of the cumulative length.
  const segments: number[] = []
  let total = 0
  for (let i = 1; i < vertices.length; i++) {
    const d = turfDistance(vertices[i - 1], vertices[i], { units: 'meters' })
    segments.push(d)
    total += d
  }
  let target = total / 2
  for (let i = 0; i < segments.length; i++) {
    if (target <= segments[i]) {
      const t = segments[i] === 0 ? 0 : target / segments[i]
      const a = vertices[i]
      const b = vertices[i + 1]
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    target -= segments[i]
  }
  return vertices[vertices.length - 1]
}
