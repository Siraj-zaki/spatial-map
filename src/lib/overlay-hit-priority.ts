/**
 * Click-priority hit testing across map overlays.
 *
 * Why this exists: Mapbox dispatches `map.on('click', layerId, ...)` handlers
 * in REGISTRATION order, not in layer-stack order. Since the editor mounts
 * overlays in render order (image → grid → polygon → line → … → model),
 * the polygon overlay's click handler registers BEFORE the model's and
 * fires first — claiming the click via `preventDefault()` even when a
 * model is rendered on top.
 *
 * The fix: every area-fill overlay calls `higherPriorityAt()` before
 * claiming. If a feature belonging to a more-specific kind exists at the
 * same click point, the overlay defers — its handler returns without
 * preventDefault, and the higher-priority overlay (which queries the
 * canvas at click time) gets to claim.
 *
 * Priority is "smaller/more specific shapes beat large area shapes":
 *   marker > text > model > stair > door > line > polygon > circle > grid > image
 *
 * Markers are DOM-based (mapboxgl.Marker), not Mapbox layers, so they
 * never appear in `queryRenderedFeatures` results. They handle clicks
 * via their own DOM event path and don't need this protocol.
 */

import type { Map as MapboxMapInstance, Point } from 'mapbox-gl'

export type OverlayHitKind =
  | 'text'
  | 'model'
  | 'stair'
  | 'door'
  | 'route'
  | 'line'
  | 'polygon'
  | 'circle'
  | 'grid'
  | 'image'

const PRIORITY: OverlayHitKind[] = [
  'text',
  'model',
  'stair',
  'door',
  // Routes sit above walls in click priority — a wayfinding path
  // drawn on top of an aisle should be selectable even where they
  // visually cross. Both have similar thin geometry.
  'route',
  'line',
  'polygon',
  'circle',
  'grid',
  'image',
]

/**
 * Map a Mapbox layer id to the overlay kind that owns it. Returns null for
 * non-interactive layers (labels, clip, selection highlights, etc.) so they
 * don't tip the priority comparison.
 *
 * Layer id conventions (kept in sync with each overlay's source/layer
 * constants):
 *   polygon-extrude-layer-op<N>
 *   circle-fill-layer, circle-extrude-layer-op<N>
 *   line-line-layer, line-wall-extrude-layer-op<N>
 *   stair-fill-layer, stair-extrude-layer
 *   door-fill-layer, door-outline-layer (NOT door-tool-preview-* which are
 *     draft layers)
 *   model-shapes-shape-<id>
 *   grid-fill-layer-op<N>, grid-cell-layer
 *   image-raster-layer-<id>, image-hit-test-layer
 *   text-label-symbol-layer
 *
 * If a new overlay adds a layer that should participate in hit priority,
 * extend this function — don't add per-overlay logic.
 */
function kindOfLayer(layerId: string): OverlayHitKind | null {
  if (!layerId) return null
  // Preview / draft / selection-outline / label layers must NOT block
  // selection — they're either tool ghosts (drawing) or visual outlines on
  // top of the real shape (selection rings, text labels for shapes).
  if (layerId.includes('preview')) return null
  if (layerId.endsWith('-selection-layer')) return null
  // Door uses `door-tool-*` for ALL its layers (legacy naming) — the
  // `preview` / `transform` ones are non-interactive, but `fill`,
  // `outline`, `arc`, `label` ARE the live door.
  if (layerId.startsWith('door-tool-preview-')) return null
  if (layerId === 'door-tool-transform-layer') return null

  if (layerId.startsWith('model-shapes-layer-')) return 'model'
  if (
    layerId === 'door-tool-fill-layer' ||
    layerId === 'door-tool-outline-layer' ||
    layerId === 'door-tool-arc-layer'
  ) {
    return 'door'
  }
  if (
    layerId === 'stair-step-layer' ||
    layerId === 'stair-step-border-layer'
  ) {
    return 'stair'
  }
  if (layerId === 'text-label-layer' || layerId.startsWith('text-label-layer-')) {
    return 'text'
  }
  if (
    layerId === 'line-stroke-layer' ||
    layerId.startsWith('line-wall-layer-op')
  ) {
    return 'line'
  }
  if (
    layerId === 'route-stroke-layer' ||
    layerId === 'route-waypoint-layer'
  ) {
    return 'route'
  }
  if (layerId.startsWith('polygon-extrude-layer-op')) {
    return 'polygon'
  }
  if (
    layerId === 'circle-fill-layer' ||
    layerId.startsWith('circle-extrude-layer-op')
  ) {
    return 'circle'
  }
  if (
    layerId === 'grid-fill-layer' ||
    layerId === 'grid-line-layer' ||
    layerId.startsWith('grid-extrude-layer')
  ) {
    return 'grid'
  }
  if (layerId === 'image-hit-layer' || layerId.startsWith('image-raster-layer')) {
    return 'image'
  }
  return null
}

const DEFAULT_HIT_BUFFER_PX = 4

/**
 * Returns true when a feature with higher click priority than `myKind`
 * exists at `point`. Area-fill overlays call this and bail when true so
 * the more specific overlay can claim the click.
 *
 * `hitBufferPx` widens the query box slightly so the user doesn't need
 * a pixel-perfect click on thin geometry (lines, model outlines). Default
 * 4 px matches what the model overlay uses internally.
 */
export function higherPriorityAt(
  map: MapboxMapInstance,
  point: Point,
  myKind: OverlayHitKind,
  hitBufferPx = DEFAULT_HIT_BUFFER_PX,
): boolean {
  const myIdx = PRIORITY.indexOf(myKind)
  if (myIdx <= 0) return false
  const bbox: [[number, number], [number, number]] = [
    [point.x - hitBufferPx, point.y - hitBufferPx],
    [point.x + hitBufferPx, point.y + hitBufferPx],
  ]
  let features
  try {
    features = map.queryRenderedFeatures(bbox)
  } catch {
    return false
  }
  for (const f of features) {
    const layerId = (f as { layer?: { id?: string } }).layer?.id ?? ''
    const k = kindOfLayer(layerId)
    if (!k) continue
    const idx = PRIORITY.indexOf(k)
    if (idx >= 0 && idx < myIdx) return true
  }
  return false
}
