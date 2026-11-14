/**
 * Circle geometry helpers.
 *
 * Two flavors of circle live in this app:
 *  - **Single circle** — one center + radius (meters).
 *  - **Circle grid**   — a bbox of square cells, each cell renders as a
 *                       circle inscribed at the cell's center. Reuses the
 *                       existing grid pipeline so rotation, MAX_CELLS
 *                       capping, and cell-size auto-fit all behave the
 *                       same as the square-grid tool.
 *
 * Output here is plain GeoJSON features so the overlay can drop them
 * straight into a Mapbox `geojson` source.
 */

import { circle as turfCircle } from '@turf/turf'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import {
  buildGridFromLine,
  type GridConfig,
} from './grid-generators'
import type { CircleShape, FillShapeConfig } from './shapes'
import { fillTapers } from './sloped-mesh'

/** Approximate sides for the polygonal circle approximation. 64 is smooth at all zoom levels we care about. */
const CIRCLE_STEPS = 64

export interface CirclePolygonProps {
  /** Stable cross-render id for tooltips / clicks. */
  id: string
  /** Parent `CircleShape.id` (Dexie primary key). Undefined for live preview. */
  circleId?: number
  /** Row/col only set for the grid sub-mode; undefined for single. */
  row?: number
  col?: number
  /** Per-shape style fields, stamped at build time so paint expressions
   *  can read them via `['get', ...]` (mirrors the grid overlay pattern). */
  color: string
  borderColor: string
  borderWidth: number
  opacity: number
  /**
   * `opacity` rounded to the nearest multiple of 10 (0, 10, 20, …, 100).
   * The overlay pre-creates one constant-opacity fill-extrusion layer per
   * bucket; `fill-extrusion-opacity` rejects ALL data expressions in
   * Mapbox GL JS 3.x so this bucketing replaces per-feature paint
   * expressions.
   */
  opacityBucket: number
  /** RGBA equivalent of `color × opacity/100`. Legacy field, kept for compat. */
  colorRgba: string
  elevation: number
  height: number
  /**
   * Mirrors config.receiveShadows — drives the overlay's
   * fill-extrusion-emissive-strength expression.
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
  /**
   * Label world-space offset — read by the overlay's labelPointData
   * to position the label symbol. `shapeRotation` is the CircleShape's
   * own rotation, stamped here so the offset math (offset lives in the
   * shape's local unrotated frame) can rotate the offset into world
   * space without a second lookup back to the raw shape list.
   */
  labelOffsetX?: number
  labelOffsetY?: number
  shapeRotation?: number
  /** Marks live-preview polygons (no circleId yet). */
  /**
   * Tapered / dome solid (sloped-mesh.ts): the overlay draws it as a mesh,
   * and this feature sits in the zero-opacity bucket as its click target.
   */
  meshed?: boolean
  preview?: boolean
}

export type CirclePolygon = Feature<Polygon, CirclePolygonProps>

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  const a = Math.max(0, Math.min(1, alpha))
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
}

/**
 * Build a polygon ring approximating a circle of `radius` meters around
 * `center`. Always returns a closed ring (first point repeated last).
 */
export function buildCirclePolygonRing(
  center: [number, number],
  radiusMeters: number,
  steps = CIRCLE_STEPS
): [number, number][] {
  const feature = turfCircle(center, Math.max(0.01, radiusMeters), {
    steps,
    units: 'meters',
  })
  // turf returns a Polygon; the outer ring is index 0.
  return feature.geometry.coordinates[0] as [number, number][]
}

function propsFor(
  id: string,
  cfg: FillShapeConfig,
  circleId?: number,
  preview = false,
  // Falls back as the on-map label when the user hasn't set `cfg.label`,
  // so renaming the circle from the list updates its label automatically.
  name?: string,
  // Shape's own rotation — stamped so the label point's offset math
  // (in the overlay's labelPointData) can rotate a local-frame offset
  // into world space without a second lookup. Defaults to 0 for cell /
  // grid features (they inherit the parent grid's rotation via the
  // callsite).
  shapeRotation = 0,
): CirclePolygonProps {
  const labelText = cfg.label && cfg.label.trim() !== '' ? cfg.label : (name ?? '')
  return {
    id,
    circleId,
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
    labelOffsetX: cfg.labelOffsetX ?? 0,
    labelOffsetY: cfg.labelOffsetY ?? 0,
    shapeRotation,
    preview,
  }
}

/**
 * Convert one single-mode circle into a Polygon feature.
 */
/**
 * Reserved feature.id for the live-preview circle. Dexie auto-increment
 * starts at 1; `0` is permanently free and lets the overlay's
 * setFeatureState sync target the preview shape distinctly. Circle-grid
 * cells multiply this by 10000 and add the cell index to keep ids unique
 * within the source while still grouping by parent shape via the
 * `divides-by-10000` trick (see `circleFeatureIdFor` below).
 */
export const CIRCLE_PREVIEW_FEATURE_ID = 0

/**
 * Compute the unique feature.id for a circle feature. For single-mode
 * circles, the id is the shape's DB id (or 0 for preview). For
 * grid-mode cells, ids are spread across `shapeId * 10000 + cellIndex`
 * so each cell has its own id but all cells of one shape share an
 * easy-to-find prefix.
 */
export function circleFeatureIdFor(
  shapeId: number | undefined,
  cellIndex?: number,
): number {
  const base = shapeId ?? CIRCLE_PREVIEW_FEATURE_ID
  if (cellIndex === undefined) return base
  // 10000 = max reasonable cells per circle-grid (MAX_CELLS in
  // grid-generators is currently 5000) plus headroom.
  return base * 10000 + cellIndex
}

export function buildSingleCircleFeature(
  shape: CircleShape,
  opts?: { preview?: boolean }
): CirclePolygon | null {
  if (shape.mode !== 'single') return null
  if (!shape.center || !shape.radius || shape.radius <= 0) return null
  const ring = buildCirclePolygonRing(shape.center, shape.radius)
  return {
    type: 'Feature',
    id: circleFeatureIdFor(shape.id),
    properties: propsFor(
      `circle-${shape.id ?? 'preview'}`,
      shape.config,
      shape.id,
      opts?.preview ?? false,
      shape.name,
      shape.rotation,
    ),
    geometry: { type: 'Polygon', coordinates: [ring] },
  }
}

/**
 * Convert one circle-grid shape into a FeatureCollection of N circle
 * polygons — one per cell of the underlying square grid. Reuses
 * `buildGridFromLine` so the rotation, anchoring, and MAX_CELLS auto-fit
 * behave exactly like the regular grid tool.
 */
export function buildCircleGridFeatures(
  shape: CircleShape,
  opts?: { preview?: boolean }
): CirclePolygon[] {
  if (shape.mode !== 'grid') return []
  if (!shape.start || !shape.current || !shape.cellSize || !shape.cellRadius) {
    return []
  }
  // Drive `buildGridFromLine` with a synthetic GridConfig — we just need
  // the cell centroids it computes. The rendering values (color, etc.)
  // come from our own `shape.config`, not this temp config.
  const tempGridConfig: GridConfig = {
    type: 'square',
    xSize: shape.cellSize,
    ySize: shape.cellSize,
    cellGap: 0,
    unit: shape.unit,
    rotation: shape.rotation,
    color: shape.config.color,
    borderColor: shape.config.borderColor,
    borderWidth: shape.config.borderWidth,
    opacity: shape.config.opacity,
    elevation: shape.config.elevation,
    height: shape.config.height,
    hexOrientation: 'pointy',
    showLabels: false,
    visible: true,
    labelStart: 1,
    labelDirection: 'x',
    labelPrefix: '',
    labelSize: 12,
    labelColor: '#000000',
    labelAltitude: 0,
    // Circle-grid cells are always single-level — we only use this
    // synthetic config to pull cell footprints from `buildGridFromLine`,
    // and the vertical-racking path doesn't apply to circle layouts.
    levels: 1,
    levelHeight: 1.5,
    levelGap: 0,
  }
  let cells: ReturnType<typeof buildGridFromLine>['cells']
  try {
    const result = buildGridFromLine(shape.start, shape.current, tempGridConfig, {
      committed: true,
      gridId: shape.id,
    })
    cells = result.cells
  } catch {
    return []
  }
  const out: CirclePolygon[] = []
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    const ring = cell.geometry.coordinates[0] as [number, number][]
    // Cell centroid (closing point excluded).
    let sx = 0
    let sy = 0
    const n = ring.length - 1
    for (let k = 0; k < n; k++) {
      sx += ring[k][0]
      sy += ring[k][1]
    }
    const center: [number, number] = [sx / n, sy / n]
    // Clamp cellRadius so it doesn't exceed half the cell size — keeps
    // adjacent circles from overlapping confusingly.
    const maxRadius = shape.cellSize * 0.5
    const r = Math.min(shape.cellRadius, maxRadius)
    const circleRing = buildCirclePolygonRing(center, r)
    out.push({
      type: 'Feature',
      id: circleFeatureIdFor(shape.id, i),
      properties: {
        ...propsFor(
          `circle-${shape.id ?? 'preview'}-${i}`,
          shape.config,
          shape.id,
          opts?.preview ?? false,
          shape.name,
          shape.rotation,
        ),
        row: cell.properties.row,
        col: cell.properties.col,
      },
      geometry: { type: 'Polygon', coordinates: [circleRing] },
    })
  }
  return out
}

/**
 * One-stop helper: convert any CircleShape (single OR grid) to a list of
 * polygon features. Returns an empty array if the shape isn't drawable
 * yet (e.g. live preview with a 0-radius drag).
 */
export function buildCircleFeatures(
  shape: CircleShape,
  opts?: { preview?: boolean }
): CirclePolygon[] {
  if (shape.mode === 'single') {
    const f = buildSingleCircleFeature(shape, opts)
    return f ? [f] : []
  }
  return buildCircleGridFeatures(shape, opts)
}

/** Per-shape paint override pushed in by the style-rules engine. */
export interface CircleStyleOverride {
  fillColor?: string
  fillOpacity?: number
  borderColor?: string
  borderWidth?: number
  elevation?: number
  height?: number
  labelColor?: string
  labelText?: string
}

/** Merge many shapes into one FeatureCollection for a Mapbox geojson source. */
export function buildCircleFeatureCollection(
  shapes: ReadonlyArray<CircleShape>,
  liveShape?: CircleShape | null,
  extras?: ReadonlyMap<number, CircleStyleOverride> | null,
): FeatureCollection<Polygon, CirclePolygonProps> {
  const features: CirclePolygon[] = []
  for (const s of shapes) {
    if (s.visible === false) continue
    const built = buildCircleFeatures(s)
    const override = s.id !== undefined ? extras?.get(s.id) : undefined
    const out = override ? built.map((f) => applyCircleOverride(f, override)) : built
    // A single tapered / dome circle is drawn as a mesh by the overlay; its
    // feature moves to the zero-opacity bucket as the click target.
    if (s.mode === 'single' && out.length === 1 && fillTapers(s.config, out[0].properties.height)) {
      features.push({ ...out[0], properties: { ...out[0].properties, meshed: true, opacityBucket: 0 } })
    } else {
      features.push(...out)
    }
  }
  if (liveShape) {
    features.push(...buildCircleFeatures(liveShape, { preview: true }))
  }
  return { type: 'FeatureCollection', features }
}

/**
 * Merge a style override into a circle polygon feature. Returns a
 * fresh feature so the source one (or a cache hit) stays untouched.
 */
function applyCircleOverride(
  feat: CirclePolygon,
  override: CircleStyleOverride,
): CirclePolygon {
  const p = { ...feat.properties }
  if (override.fillColor !== undefined) p.color = override.fillColor
  if (override.fillOpacity !== undefined) {
    p.opacity = override.fillOpacity
    p.opacityBucket = Math.max(0, Math.min(100, Math.round(override.fillOpacity / 10) * 10))
    p.colorRgba = hexToRgba(p.color, p.opacity / 100)
  } else if (override.fillColor !== undefined) {
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
