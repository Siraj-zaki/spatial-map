/**
 * Polygon geometry helpers.
 *
 * Polygon vertices are stored as an open ring (no duplicated first
 * vertex at the end). Rotation is applied around the vertex centroid
 * (mean of the open ring) so it matches the transform-handle pivot in
 * map-polygon-overlay, which uses the same `polygonCentroid` helper.
 * Only the rendered geometry rotates — persistent vertices stay stable.
 *
 * Live preview during a polygon draw can have anywhere from 0 to N
 * vertices. We render:
 *   - 0 vertices: nothing
 *   - 1–2 vertices: a LineString chain (no fill yet)
 *   - 3+ vertices: a full closed Polygon
 */

import {
  polygon as turfPolygon,
  transformRotate,
} from '@turf/turf'
import type {
  Feature,
  FeatureCollection,
  LineString,
  Polygon,
} from 'geojson'
import type { PolygonShape, FillShapeConfig } from './shapes'

export interface PolygonProps {
  id: string
  /** Parent `PolygonShape.id` (Dexie primary key). Undefined for live preview. */
  polygonId?: number
  /** Per-shape style stamped at build time. */
  color: string
  borderColor: string
  borderWidth: number
  /** User opacity, 0–100. Used by 2D `fill-opacity` data expression. */
  opacity: number
  /**
   * `opacity` rounded to the nearest multiple of 10 (0, 10, 20, …, 100).
   * Used by per-bucket fill-extrusion layers in the overlay — Mapbox
   * rejects ALL data expressions on `fill-extrusion-opacity`, so each
   * bucket layer carries a constant opacity and selects its features
   * via `['==', ['get', 'opacityBucket'], <bucket>]`.
   */
  opacityBucket: number
  /** RGBA equivalent of `color × opacity/100`. Legacy field, kept for compat. */
  colorRgba: string
  elevation: number
  height: number
  /**
   * Mirrors config.receiveShadows. Consumed by the overlay's
   * fill-extrusion-emissive-strength expression: when true the top
   * face drops to a low emissive so shadows visibly darken it.
   */
  receiveShadows: boolean
  showLabels: boolean
  label?: string
  labelSize?: number
  labelColor?: string
  labelAltitude?: number
  /**
   * Routes the label point to the flat-on-surface layer instead of the
   * default screen-space billboard layer. Stamped here so the overlay's
   * layer filters can partition features without a second lookup.
   */
  labelFlat?: boolean
  /** Marks live-preview polygons (no polygonId yet). */
  preview?: boolean
}

export type PolygonFeature = Feature<Polygon, PolygonProps>
export type PolygonLineFeature = Feature<LineString, PolygonProps>

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  const a = Math.max(0, Math.min(1, alpha))
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
}

function propsFor(
  id: string,
  cfg: FillShapeConfig,
  polygonId?: number,
  preview = false,
  // Kept in the signature for callsite compatibility — the on-map label
  // intentionally no longer falls back to the shape's `name`. A
  // freshly-drawn polygon stays unlabeled until the user types a label,
  // so an empty Label field really means "no label". The `name` is
  // still used in the workspace tree and side panel for identification.
  _name?: string
): PolygonProps {
  const labelText = cfg.label && cfg.label.trim() !== '' ? cfg.label : ''
  return {
    id,
    polygonId,
    color: cfg.color,
    borderColor: cfg.borderColor,
    borderWidth: cfg.borderWidth,
    opacity: cfg.opacity,
    opacityBucket: Math.max(0, Math.min(100, Math.round(cfg.opacity / 10) * 10)),
    colorRgba: hexToRgba(cfg.color, cfg.opacity / 100),
    elevation: cfg.elevation,
    height: cfg.height,
    receiveShadows: cfg.receiveShadows ?? true,
    showLabels: cfg.showLabels,
    label: labelText,
    labelSize: cfg.labelSize,
    labelColor: cfg.labelColor,
    labelAltitude: cfg.labelAltitude,
    labelFlat: cfg.labelFlat ?? false,
    preview,
  }
}

/**
 * Rotate a ring of [lng, lat] points around the open-ring vertex
 * centroid by `degrees`. Returns a fresh array — does not mutate the
 * input.
 *
 * Uses `polygonCentroid` (mean of the open vertex list) for the pivot
 * so it matches the pivot the polygon transform-handle UI uses. The
 * earlier implementation passed `turfCentroid` of the CLOSED ring,
 * which averages the duplicated first vertex twice and biases the
 * pivot toward `ring[0]` — visible as the polygon "swinging" toward
 * its first vertex under rotation.
 */
function rotateRing(
  ring: [number, number][],
  degrees: number
): [number, number][] {
  if (Math.abs(degrees) < 1e-6 || ring.length < 3) return ring.slice()
  const pivot = polygonCentroid(ring)
  if (!pivot) return ring.slice()
  const closed = [...ring, ring[0]]
  let rotated: Feature<Polygon>
  try {
    const poly = turfPolygon([closed])
    rotated = transformRotate(poly, degrees, { pivot })
  } catch {
    return ring.slice()
  }
  const out = rotated.geometry.coordinates[0] as [number, number][]
  return out.slice(0, -1)
}

/**
 * Reserved feature.id for the live-preview polygon. Dexie auto-increment
 * starts at 1, so 0 is permanently free and lets the overlay's
 * setFeatureState sync target the preview shape distinctly from any
 * saved one.
 */
export const POLYGON_PREVIEW_FEATURE_ID = 0

/**
 * Build the fill Polygon feature for a polygon shape. Requires at least
 * 3 vertices; returns null otherwise.
 *
 * `feature.id` is stamped (DB id for saved shapes, sentinel `0` for
 * live preview) so `map.setFeatureState` can drive per-shape paint —
 * the only working path for per-feature `fill-extrusion-opacity` in
 * Mapbox GL JS 3.x.
 */
export function buildPolygonFeature(
  shape: PolygonShape,
  opts?: { preview?: boolean }
): PolygonFeature | null {
  if (!shape.vertices || shape.vertices.length < 3) return null
  const rotated = rotateRing(shape.vertices, shape.rotation)
  const closed = [...rotated, rotated[0]]
  return {
    type: 'Feature',
    id: shape.id ?? POLYGON_PREVIEW_FEATURE_ID,
    properties: propsFor(
      `polygon-${shape.id ?? 'preview'}`,
      shape.config,
      shape.id,
      opts?.preview ?? false,
      shape.name
    ),
    geometry: { type: 'Polygon', coordinates: [closed] },
  }
}

/**
 * Build a live-draw LineString feature representing the in-progress
 * vertex chain. Used when there are < 3 vertices, OR when we want to
 * show the chain on top of the filled polygon during a draw.
 *
 * If `cursor` is provided, the chain extends to it (so the user sees
 * the next edge tracking the cursor).
 */
export function buildPolygonChainFeature(
  vertices: [number, number][],
  cursor: [number, number] | null,
  config: FillShapeConfig
): PolygonLineFeature | null {
  if (vertices.length === 0) return null
  const coords: [number, number][] = cursor ? [...vertices, cursor] : [...vertices]
  if (coords.length < 2) return null
  return {
    type: 'Feature',
    properties: propsFor('polygon-chain', config, undefined, true),
    geometry: { type: 'LineString', coordinates: coords },
  }
}

/**
 * Per-shape style overrides the rules engine can push in. The keys are
 * polygon ids; the values are partial paint props that supersede the
 * shape's saved config when present.
 */
export interface PolygonStyleOverride {
  fillColor?: string
  fillOpacity?: number
  borderColor?: string
  borderWidth?: number
  elevation?: number
  height?: number
  labelColor?: string
  labelText?: string
}

/** Build a Mapbox source-friendly collection from many polygon shapes. */
export function buildPolygonFeatureCollection(
  shapes: ReadonlyArray<PolygonShape>,
  livePreview?: PolygonShape | null,
  extras?: ReadonlyMap<number, PolygonStyleOverride> | null,
): FeatureCollection<Polygon, PolygonProps> {
  const features: PolygonFeature[] = []
  for (const s of shapes) {
    if (s.visible === false) continue
    const f = buildPolygonFeature(s)
    if (!f) continue
    const override = s.id !== undefined ? extras?.get(s.id) : undefined
    features.push(override ? applyPolygonOverride(f, override) : f)
  }
  if (livePreview) {
    const f = buildPolygonFeature(livePreview, { preview: true })
    if (f) features.push(f)
  }
  return { type: 'FeatureCollection', features }
}

/**
 * Merge a per-shape rule override into a built polygon feature. Returns
 * a new feature; the source feature stays untouched so the caller (or
 * a cache) can reuse it.
 */
function applyPolygonOverride(
  feat: PolygonFeature,
  override: PolygonStyleOverride,
): PolygonFeature {
  const p = { ...feat.properties }
  if (override.fillColor !== undefined) p.color = override.fillColor
  if (override.fillOpacity !== undefined) {
    p.opacity = override.fillOpacity
    p.opacityBucket = Math.max(0, Math.min(100, Math.round(override.fillOpacity / 10) * 10))
    p.colorRgba = hexToRgba(p.color, p.opacity / 100)
  }
  if (override.fillColor !== undefined && override.fillOpacity === undefined) {
    p.colorRgba = hexToRgba(override.fillColor, p.opacity / 100)
  }
  if (override.borderColor !== undefined) p.borderColor = override.borderColor
  if (override.borderWidth !== undefined) p.borderWidth = override.borderWidth
  if (override.elevation !== undefined) p.elevation = override.elevation
  if (override.height !== undefined) p.height = override.height
  if (override.labelColor !== undefined) p.labelColor = override.labelColor
  if (override.labelText !== undefined) p.label = override.labelText
  return { ...feat, properties: p }
}

/**
 * Centroid of an open ring (vertex array). Returns null for fewer than
 * 3 vertices.
 */
export function polygonCentroid(
  vertices: [number, number][]
): [number, number] | null {
  if (vertices.length < 3) return null
  let sx = 0
  let sy = 0
  for (const v of vertices) {
    sx += v[0]
    sy += v[1]
  }
  return [sx / vertices.length, sy / vertices.length]
}
