/**
 * MapAIDetectionOverlay — renders the pending detections from an AI
 * Map job as dashed, kind-colored draft shapes on top of the placed
 * floor plan. Clicks emit `onDetectionClick(id)` so the review dialog
 * can scroll to / focus that row.
 *
 * Deliberately simpler than the shape overlays:
 *   - One GeoJSON source, four layers (fill / stroke / point / label).
 *   - No transform handles (drag-to-nudge lands in Phase 3.4).
 *   - No opacity bucketing — all pending features are drawn at the
 *     same alpha; the accepted / rejected state is handled at the
 *     data level by removing the detection from the feature collection.
 *   - Mounted OUTSIDE the layer-order fragment (like the transform
 *     handles) so a warehouse re-order doesn't unmount / remount the
 *     entire preview mid-review.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { GeoJSONSource, Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import type { AIDetection } from '@/lib/ai-client'
import { AI_KIND_COLORS, buildAIDetectionFeatureCollection } from '@/lib/ai-detection-generator'

interface Props {
  map: MapboxMapInstance | null
  /** Only PENDING detections should be passed here. Accepted/rejected
   *  ones are handled elsewhere. Empty array is fine — the layers stay
   *  mounted but idle so a mid-flight job doesn't churn setup/teardown. */
  detections: ReadonlyArray<AIDetection>
  /** Highlighted id — matches the review-dialog selection so clicking a
   *  detection row visually pops the shape on the map. */
  selectedId?: string | null
  onDetectionClick?: (id: string) => void
}

const SOURCE_ID = 'ai-detection-source'
const FILL_LAYER = 'ai-detection-fill-layer'
const STROKE_LAYER = 'ai-detection-stroke-layer'
const POINT_LAYER = 'ai-detection-point-layer'
const LABEL_LAYER = 'ai-detection-label-layer'

// Reused by multiple layers.
const KIND_COLOR_EXPR: mapboxgl.ExpressionSpecification = [
  'match',
  ['get', 'kind'],
  'aisle', AI_KIND_COLORS.aisle,
  'area', AI_KIND_COLORS.area,
  'door', AI_KIND_COLORS.door,
  'stair', AI_KIND_COLORS.stair,
  '#999999',
] as mapboxgl.ExpressionSpecification

export function MapAIDetectionOverlay({ map, detections, selectedId, onDetectionClick }: Props) {
  const [styleLoaded, setStyleLoaded] = useState(false)

  // Wait for the map style to be ready. Existing overlays all do this
  // dance — see map-polygon-overlay.tsx for the canonical pattern with
  // style.load + a polling fallback for the initial load race.
  useEffect(() => {
    if (!map) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStyleLoaded(false)
      return
    }
    const setReady = () => setStyleLoaded(true)
    if (map.isStyleLoaded()) {
      setReady()
      return
    }
    const iv = setInterval(() => {
      if (map.isStyleLoaded()) {
        setReady()
        clearInterval(iv)
      }
    }, 100)
    map.on('style.load', setReady)
    map.on('load', setReady)
    return () => {
      clearInterval(iv)
      map.off('style.load', setReady)
      map.off('load', setReady)
    }
  }, [map])

  const featureCollection = useMemo(
    () => buildAIDetectionFeatureCollection(detections),
    [detections],
  )

  // Setup source + layers exactly once per style. Idempotent: source /
  // layer adds are guarded by `getSource`/`getLayer` because Mapbox
  // throws on duplicate ids.
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: 'geojson', data: featureCollection })
    }
    if (!map.getLayer(FILL_LAYER)) {
      map.addLayer({
        id: FILL_LAYER,
        type: 'fill',
        source: SOURCE_ID,
        // Fill is only meaningful for polygons; the line + point layers
        // handle the other geometries. `$type` filters the input to the
        // matching primitive at render time — cheaper than pre-splitting
        // into multiple sources.
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': KIND_COLOR_EXPR,
          'fill-opacity': 0.18,
        },
      })
    }
    if (!map.getLayer(STROKE_LAYER)) {
      map.addLayer({
        id: STROKE_LAYER,
        type: 'line',
        source: SOURCE_ID,
        // Includes polygons (drawing their outline) AND line-type
        // detections (LineString primitives).
        filter: [
          'any',
          ['==', ['geometry-type'], 'Polygon'],
          ['==', ['geometry-type'], 'LineString'],
        ],
        paint: {
          'line-color': KIND_COLOR_EXPR,
          'line-width': [
            'case',
            ['==', ['get', 'detectionId'], selectedId ?? '__none__'], 3.5,
            2,
          ],
          // Dashed = "not yet accepted, review me". The selected
          // detection gets a slightly denser dash so it pops against
          // the rest of the pending set without changing color.
          'line-dasharray': [
            'case',
            ['==', ['get', 'detectionId'], selectedId ?? '__none__'], ['literal', [3, 2]],
            ['literal', [4, 3]],
          ],
        },
      })
    }
    if (!map.getLayer(POINT_LAYER)) {
      map.addLayer({
        id: POINT_LAYER,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'detectionId'], selectedId ?? '__none__'], 10,
            7,
          ],
          'circle-color': KIND_COLOR_EXPR,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      })
    }
    if (!map.getLayer(LABEL_LAYER)) {
      map.addLayer({
        id: LABEL_LAYER,
        type: 'symbol',
        source: SOURCE_ID,
        layout: {
          'text-field': ['get', 'displayLabel'],
          'text-size': 11,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': KIND_COLOR_EXPR,
          'text-halo-width': 2,
        },
      })
    }
    return () => {
      // Only tear down when the map is being disposed. Style-swap
      // handling would re-add on the next effect run anyway. Wrap in
      // try/catch because on route unmount the map's internal style is
      // torn down before this cleanup runs — `getLayer` then throws
      // "Cannot read properties of undefined (reading 'getOwnLayer')".
      for (const id of [LABEL_LAYER, POINT_LAYER, STROKE_LAYER, FILL_LAYER]) {
        try { if (map.getLayer(id)) map.removeLayer(id) } catch { /* map disposed */ }
      }
      try { if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID) } catch { /* map disposed */ }
    }
  }, [map, styleLoaded, featureCollection, selectedId])

  // Update source data whenever detections change. Cheap — the layers
  // stay mounted; only the source data mutates.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined
    if (src) src.setData(featureCollection)
  }, [map, styleLoaded, featureCollection])

  // Click delegation. Fires only for pointer events on the AI layers;
  // clicks on the map background pass through as usual so tool-select
  // + pan interactions are unaffected.
  const clickRef = useRef(onDetectionClick)
  useEffect(() => { clickRef.current = onDetectionClick })
  useEffect(() => {
    if (!map || !styleLoaded) return
    const handle = (e: MapMouseEvent) => {
      const features = e.features
      if (!features || features.length === 0) return
      const id = features[0].properties?.detectionId
      if (typeof id !== 'string') return
      // Steal the click so the underlying image overlay's click
      // handler bails (it checks originalEvent.defaultPrevented at
      // the top). Without this, clicking a draft aisle-detection
      // sitting on top of the floor plan would ALSO fire the image
      // click and start a fresh detection job.
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      clickRef.current?.(id)
    }
    map.on('click', FILL_LAYER, handle)
    map.on('click', STROKE_LAYER, handle)
    map.on('click', POINT_LAYER, handle)
    return () => {
      map.off('click', FILL_LAYER, handle)
      map.off('click', STROKE_LAYER, handle)
      map.off('click', POINT_LAYER, handle)
    }
  }, [map, styleLoaded])

  return null
}
