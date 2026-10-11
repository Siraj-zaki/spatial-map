/**
 * ai-detection-generator — turns AIDetection[] (as returned by the
 * backend, coords already in Mapbox lng/lat) into a GeoJSON
 * FeatureCollection the AI Detection overlay renders.
 *
 * The overlay is intentionally simple compared to the shape overlays:
 * it only draws PENDING detections. Accepted ones are committed into
 * the real spatial store and rendered by the normal polygon/door/stair
 * overlays; rejected ones disappear. This function is therefore called
 * with only the pending subset — no status filtering is done here.
 *
 * Rects are expanded to 4-vertex closed polygons at build time so the
 * overlay stays polygon-oriented. Lines stay LineString, points stay
 * Point. Every feature carries `properties.kind` so the paint expressions
 * can color-match without extra layers per kind.
 */

import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'
import type { AIDetection } from './ai-client'

/** Per-feature properties the overlay reads with `['get', 'kind']` etc. */
export interface AIDetectionProps {
  detectionId: string
  kind: AIDetection['kind']
  confidence: number
  /** Empty string when the model didn't provide a label — treated as
   *  no-label by the symbol layer's text-field expression. */
  label: string
  /**
   * "{{label}} {{conf%}}" when a label is present, otherwise just the
   * confidence. Precomputed so the symbol layer's text-field is a
   * simple `['get', 'displayLabel']` — the expression alternative
   * would need `concat + upcase + slice` which is slow to compile in
   * Mapbox's expression evaluator.
   */
  displayLabel: string
}

export type AIDetectionFeature =
  | Feature<Polygon, AIDetectionProps>
  | Feature<LineString, AIDetectionProps>
  | Feature<Point, AIDetectionProps>

export function buildAIDetectionFeatureCollection(
  detections: ReadonlyArray<AIDetection>,
): FeatureCollection<Polygon | LineString | Point, AIDetectionProps> {
  const features: AIDetectionFeature[] = []
  for (const d of detections) {
    const feat = featureForDetection(d)
    if (feat) features.push(feat)
  }
  return { type: 'FeatureCollection', features }
}

function featureForDetection(d: AIDetection): AIDetectionFeature | null {
  const props: AIDetectionProps = {
    detectionId: d.id,
    kind: d.kind,
    confidence: d.confidence,
    label: d.label ?? '',
    displayLabel: formatLabel(d.label, d.confidence),
  }
  const coords = d.geometry.coords
  switch (d.geometry.type) {
    case 'rect': {
      if (coords.length < 2) return null
      // rect is [[minLng, maxLat], [maxLng, minLat]] per prompt contract.
      // But the model occasionally re-orders these; normalize to bbox.
      const [a, b] = coords
      const minLng = Math.min(a[0], b[0])
      const maxLng = Math.max(a[0], b[0])
      const minLat = Math.min(a[1], b[1])
      const maxLat = Math.max(a[1], b[1])
      const ring: [number, number][] = [
        [minLng, maxLat],
        [maxLng, maxLat],
        [maxLng, minLat],
        [minLng, minLat],
        [minLng, maxLat], // closing point required by GeoJSON polygon spec
      ]
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: props,
      }
    }
    case 'polygon': {
      if (coords.length < 3) return null
      const ring: [number, number][] = [...coords]
      // Close the ring for GeoJSON if the caller didn't.
      const first = ring[0]
      const last = ring[ring.length - 1]
      if (first[0] !== last[0] || first[1] !== last[1]) {
        ring.push([first[0], first[1]])
      }
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: props,
      }
    }
    case 'line': {
      if (coords.length < 2) return null
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords as [number, number][] },
        properties: props,
      }
    }
    case 'point': {
      if (coords.length < 1) return null
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords[0] as [number, number] },
        properties: props,
      }
    }
  }
}

function formatLabel(label: string | undefined, confidence: number): string {
  const pct = Math.round(confidence * 100)
  const l = (label ?? '').trim()
  return l ? `${l} · ${pct}%` : `${pct}%`
}

/**
 * Per-kind display color. Chosen for good contrast against a typical
 * grayscale floor plan raster and distinguishable from the theme's
 * primary tint used by real shapes' selection outlines. Hardcoded
 * rather than sourced from Tailwind because these need to stay
 * legible across all 46 palettes; theme tokens would drift.
 */
export const AI_KIND_COLORS: Record<AIDetection['kind'], string> = {
  aisle: '#3b82f6', // blue-500
  area: '#10b981', // emerald-500
  door: '#f97316', // orange-500
  stair: '#8b5cf6', // violet-500
}
