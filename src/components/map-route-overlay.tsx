/**
 * Route (wayfinding path) map overlay.
 *
 * Renders every visible RouteShape as: a coloured polyline stroke, waypoint
 * dots at each vertex, directional arrows along the path, and an optional
 * label. Also renders the in-flight draw preview from `liveVertices` +
 * `liveCursor` + `liveConfig` while the user is placing a new route.
 *
 * Kept smaller than `map-line-overlay.tsx` because routes don't have a 3D
 * wall extrusion, don't need transform handles (v1), and don't do
 * snap-to-endpoint / axis snapping (the line snap engine already blocked
 * users into straight lines — routes are naturally curvy so we intentionally
 * skip that).
 *
 * Click priority (see `overlay-hit-priority.ts`): routes sit above walls so
 * a wayfinding path drawn on top of an aisle stays clickable where they
 * cross.
 */

import { useEffect, useMemo, useState } from 'react'
import type { GeoJSONSource, Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'

import { buildRouteFeatureCollections } from '@/lib/route-generators'
import { higherPriorityAt } from '@/lib/overlay-hit-priority'
import {
  readThemePrimaryHex,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import type { RouteShape, RouteShapeConfig } from '@/lib/shapes'
import type { RouteSnap } from '@/lib/route-snap'
import { whenStyleLoaded } from '@/lib/mapbox-style-ready'

interface MapRouteOverlayProps {
  map: MapboxMapInstance | null
  routes?: ReadonlyArray<RouteShape>
  /** In-progress draw vertices (already committed). */
  liveVertices?: ReadonlyArray<[number, number]>
  /** Cursor position — appended as the trailing vertex of the preview. */
  liveCursor?: [number, number] | null
  /** Config for the in-progress route — drives preview paint. */
  liveConfig?: RouteShapeConfig
  /**
   * Snap decision for the current live-draw cursor (see
   * `@/lib/route-snap`). Drives the trailing chain colour (green when
   * snapped) + a highlight ring around the target vertex the cursor is
   * locking onto. `null` = tool not active OR no snap.
   */
  liveSnap?: RouteSnap | null
  selectedRouteIds?: ReadonlySet<number>
  onRouteClick?: (id: number, originalEvent: MouseEvent) => void
  onMapClickEmpty?: () => void
  committedVisible?: boolean
  selectionEnabled?: boolean
}

const STROKE_SOURCE = 'route-stroke-source'
const STROKE_LAYER = 'route-stroke-layer'
const SELECTION_LAYER = 'route-selection-layer'
const WAYPOINT_SOURCE = 'route-waypoint-source'
const WAYPOINT_LAYER = 'route-waypoint-layer'
const ARROW_SOURCE = 'route-arrow-source'
const ARROW_LAYER = 'route-arrow-layer'
const LABEL_SOURCE = 'route-label-source'
const LABEL_LAYER = 'route-label-layer'
// Live-draw snap indicators — a green ring around the endpoint the
// cursor has snapped to, so users get an unambiguous "release here to
// connect" signal.
const SNAP_TARGET_SOURCE = 'route-snap-target-source'
const SNAP_TARGET_HALO_LAYER = 'route-snap-target-halo-layer'
const SNAP_TARGET_DOT_LAYER = 'route-snap-target-dot-layer'

/**
 * Dash pattern presets, in stroke-widths units per Mapbox convention.
 * `'solid'` uses no line-dasharray so the paint stays fully drawn.
 */
const DASH_PRESETS: Record<RouteShapeConfig['dash'], number[] | null> = {
  solid: null,
  dashed: [2, 2],
  dotted: [0.4, 1.4],
}

export function MapRouteOverlay({
  map,
  routes,
  liveVertices,
  liveCursor,
  liveConfig,
  liveSnap,
  selectedRouteIds,
  onRouteClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
}: MapRouteOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  const [styleGen, setStyleGen] = useState(0)

  // ---- Style readiness (same idiom as the polygon / line overlays) -------
  useEffect(() => {
    if (!map) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStyleLoaded(false)
      return
    }
    const setReady = () => {
      setStyleLoaded(true)
      setStyleGen((g) => g + 1)
    }
    return whenStyleLoaded(
      map,
      setReady,
      '[map-route]',
    ) as unknown as (() => void)
  }, [map])

  // Snap-aware trailing cursor: when the resolver reports a snap, the
  // preview's trailing edge + vertex should sit on the SNAP position
  // (the target vertex), not the raw cursor. Otherwise users see the
  // trailing dot hover a few pixels off the ring they're locking onto.
  const effectiveLiveCursor = useMemo<[number, number] | null>(() => {
    if (liveSnap && liveSnap.kind !== 'none') return liveSnap.position
    return liveCursor ?? null
  }, [liveSnap, liveCursor])

  // ---- Feature collections ----------------------------------------------
  const isSnapping = liveSnap ? liveSnap.kind !== 'none' : false
  const featureCollections = useMemo(
    () =>
      buildRouteFeatureCollections(
        routes ?? [],
        liveConfig && liveVertices && liveVertices.length > 0
          ? {
              vertices: [...liveVertices],
              cursor: effectiveLiveCursor,
              config: liveConfig,
              snapped: isSnapping,
            }
          : null,
      ),
    [routes, liveVertices, effectiveLiveCursor, liveConfig, isSnapping],
  )

  // Snap-target ring feature — a single Point at the target vertex,
  // stamped with the tool's current elevation so it sits at the right
  // altitude on multi-floor sites.
  const snapTargetData = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!liveSnap || liveSnap.kind === 'none' || !liveSnap.targetVertex) {
      return null
    }
    const elev = liveConfig?.elevation ?? 0
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: liveSnap.targetVertex },
          properties: { elevation: elev },
        },
      ],
    }
  }, [liveSnap, liveConfig?.elevation])

  // ---- Sources + layers install ------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    // Install sources. The stroke source hosts a `line` layer whose
    // paint indirectly triggers Mapbox's line-progress evaluator, so it
    // needs `lineMetrics: true` to silence the per-tile-parse warning.
    // The waypoint / arrow / label sources are pure Point features so
    // they don't need it — kept without the flag for a tiny worker
    // memory saving.
    for (const [sourceId, data, needsLineMetrics] of [
      [STROKE_SOURCE, featureCollections.strokes, true],
      [WAYPOINT_SOURCE, featureCollections.waypoints, false],
      [ARROW_SOURCE, featureCollections.arrows, false],
      [LABEL_SOURCE, featureCollections.labels, false],
    ] as const) {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: 'geojson',
          data,
          ...(needsLineMetrics ? { lineMetrics: true } : {}),
        })
      }
    }
    // Snap-target source — a 1-feature GeoJSON that flips between empty
    // and a Point at the target vertex when the resolver reports a
    // snap. Kept separate so the trailing chain source stays hot on
    // every mousemove without churning the snap ring.
    if (!map.getSource(SNAP_TARGET_SOURCE)) {
      map.addSource(SNAP_TARGET_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
    }
    // Stroke layer — coloured polyline with dash pattern from the
    // shape's config. Preview strokes render translucent so users can
    // tell in-progress from committed at a glance.
    if (!map.getLayer(STROKE_LAYER)) {
      map.addLayer({
        id: STROKE_LAYER,
        type: 'line',
        source: STROKE_SOURCE,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-elevation-reference': 'sea',
          'line-z-offset': ['coalesce', ['get', 'elevation'], 0],
        },
        paint: {
          // Snap-aware colour: a preview stroke flips to green-500 the
          // moment the cursor is snapping onto another route's vertex,
          // so the user sees an unambiguous "you're connecting" signal.
          // Committed strokes ignore the `snapped` flag (it stays 0 on
          // saved routes) and paint their config colour as normal.
          'line-color': [
            'case',
            ['==', ['coalesce', ['get', 'snapped'], 0], 1],
            '#22c55e',
            ['coalesce', ['get', 'color'], '#3b82f6'],
          ],
          'line-width': ['coalesce', ['get', 'width'], 3],
          'line-opacity': [
            'case',
            ['==', ['coalesce', ['get', 'preview'], 0], 1],
            0.6,
            ['/', ['coalesce', ['get', 'opacity'], 100], 100],
          ],
          'line-emissive-strength': 1,
        },
      })
    }
    // Selection halo — thicker + translucent white ring, only for
    // selected ids. Filter reads `selected` stamped later via
    // setFeatureState — but v1 doesn't need it; skip until routes are
    // in the transform/select loop.
    if (!map.getLayer(SELECTION_LAYER)) {
      map.addLayer({
        id: SELECTION_LAYER,
        type: 'line',
        source: STROKE_SOURCE,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-elevation-reference': 'sea',
          'line-z-offset': ['coalesce', ['get', 'elevation'], 0],
        },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['+', ['coalesce', ['get', 'width'], 3], 4],
          'line-opacity': 0.35,
          'line-emissive-strength': 1,
        },
        filter: ['==', ['literal', false], true],
      })
    }
    // Waypoint dots — symbols so we can `symbol-z-offset` onto the
    // floor plan altitude (same rationale as line overlay's chain
    // vertices). Bigger at endpoints.
    if (!map.getLayer(WAYPOINT_LAYER)) {
      map.addLayer({
        id: WAYPOINT_LAYER,
        type: 'symbol',
        source: WAYPOINT_SOURCE,
        layout: {
          'text-field': '●',
          'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
          'text-size': [
            'case',
            ['==', ['coalesce', ['get', 'endpoint'], 'middle'], 'middle'],
            8,
            14,
          ],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-z-elevate': false,
        },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], '#3b82f6'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
          'text-emissive-strength': 1,
          'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
        },
      })
    }
    // Directional arrows — a triangle glyph (▲) rotated per feature's
    // `bearing`. Text symbols render fast + let us drive color / size
    // from feature properties without shipping a raster sprite atlas.
    if (!map.getLayer(ARROW_LAYER)) {
      map.addLayer({
        id: ARROW_LAYER,
        type: 'symbol',
        source: ARROW_SOURCE,
        layout: {
          'text-field': '▲',
          'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
          'text-size': ['coalesce', ['get', 'size'], 14],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          // Mapbox rotates symbol text by `text-rotate` (degrees, cw
          // from up). Turf's `bearing` is cw from north, so the values
          // line up 1:1 — the ▲ glyph "points up" in its box and
          // rotates onto the segment direction.
          'text-rotate': ['coalesce', ['get', 'bearing'], 0],
          'symbol-z-elevate': false,
        },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], '#3b82f6'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
          'text-emissive-strength': 1,
          'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
        },
      })
    }
    // Snap target — outer halo ring + inner solid dot around the vertex
    // the cursor is about to lock onto. Both circles are lifted to the
    // tool's elevation so they anchor to the right floor plan on
    // multi-storey sites. Colour is the same #22c55e used by the line
    // tool's snap indicators so users can rely on a consistent "green
    // means connected" signal across tools.
    if (!map.getLayer(SNAP_TARGET_HALO_LAYER)) {
      map.addLayer({
        id: SNAP_TARGET_HALO_LAYER,
        type: 'circle',
        source: SNAP_TARGET_SOURCE,
        paint: {
          'circle-radius': 16,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#22c55e',
          'circle-stroke-width': 3,
          'circle-opacity': 0.9,
          'circle-emissive-strength': 1,
        },
      })
    }
    if (!map.getLayer(SNAP_TARGET_DOT_LAYER)) {
      map.addLayer({
        id: SNAP_TARGET_DOT_LAYER,
        type: 'circle',
        source: SNAP_TARGET_SOURCE,
        paint: {
          'circle-radius': 4,
          'circle-color': '#22c55e',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-opacity': 0.95,
          'circle-emissive-strength': 1,
        },
      })
    }
    if (!map.getLayer(LABEL_LAYER)) {
      map.addLayer({
        id: LABEL_LAYER,
        type: 'symbol',
        source: LABEL_SOURCE,
        layout: {
          'text-field': ['get', 'text'],
          'text-size': ['coalesce', ['get', 'size'], 12],
          'text-offset': [0, -1.2],
          'text-anchor': 'bottom',
          'text-allow-overlap': false,
          'symbol-z-elevate': false,
        },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], '#111827'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
          'text-emissive-strength': 1,
          'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
        },
      })
    }

    // Update dash pattern per group of features. Mapbox's line-dasharray
    // is a paint property that doesn't accept a data expression, so we
    // pick the pattern from the FIRST feature in the collection each
    // paint tick and apply it globally. Works because we don't mix dash
    // styles per source — every route strokes with its own dash but
    // they read from the same paint. This is a simplification we can
    // revisit if per-route dash mixing is important. For now, users
    // pick a dash on the tool config and it applies to the whole
    // in-progress route.
    const firstStroke = featureCollections.strokes.features[0]
    const dash = firstStroke?.properties?.dash as RouteShapeConfig['dash'] | undefined
    const dashArr = dash ? DASH_PRESETS[dash] : null
    try {
      if (dashArr) {
        map.setPaintProperty(STROKE_LAYER, 'line-dasharray', dashArr)
      } else {
        // Solid — clear dasharray by setting to a single segment.
        map.setPaintProperty(STROKE_LAYER, 'line-dasharray', [1, 0])
      }
    } catch {
      /* mid-teardown */
    }
  }, [map, styleLoaded, styleGen, featureCollections])

  // ---- Data refresh ------------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const [sourceId, data] of [
      [STROKE_SOURCE, featureCollections.strokes],
      [WAYPOINT_SOURCE, featureCollections.waypoints],
      [ARROW_SOURCE, featureCollections.arrows],
      [LABEL_SOURCE, featureCollections.labels],
    ] as const) {
      const src = map.getSource(sourceId) as GeoJSONSource | undefined
      if (src && typeof src.setData === 'function') {
        src.setData(data)
      }
    }
  }, [map, styleLoaded, styleGen, featureCollections])

  // Theme-tinted selection outline. Routes have no transform state
  // (v1) so no handle work; just retint the "which route am I
  // picking?" halo when the palette / mode changes.
  const [primaryHex, setPrimaryHex] = useState<string>(() =>
    readThemePrimaryHex(),
  )
  useEffect(() => {
    const refresh = () => setPrimaryHex(readThemePrimaryHex())
    refresh()
    return subscribeThemeChanges(refresh)
  }, [])
  useEffect(() => {
    if (!map || !styleLoaded) return
    try {
      if (map.getLayer(SELECTION_LAYER)) {
        map.setPaintProperty(SELECTION_LAYER, 'line-color', primaryHex)
      }
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, primaryHex])

  // Snap-target ring data refresh — decoupled from the main feature
  // collections so it can update every mousemove tick without churning
  // the strokes/arrows/labels sources.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(SNAP_TARGET_SOURCE) as GeoJSONSource | undefined
    if (!src || typeof src.setData !== 'function') return
    src.setData(
      snapTargetData ?? { type: 'FeatureCollection', features: [] },
    )
  }, [map, styleLoaded, styleGen, snapTargetData])

  // ---- Selection filter --------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const ids = Array.from(selectedRouteIds ?? [])
    try {
      if (ids.length === 0) {
        map.setFilter(SELECTION_LAYER, ['==', ['literal', false], true])
      } else {
        map.setFilter(SELECTION_LAYER, [
          'in',
          ['coalesce', ['get', 'id'], -1],
          ['literal', ids],
        ])
      }
    } catch {
      /* mid-teardown */
    }
  }, [map, styleLoaded, styleGen, selectedRouteIds])

  // ---- Committed visibility toggle --------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const value = committedVisible ? 'visible' : 'none'
    for (const layerId of [STROKE_LAYER, WAYPOINT_LAYER, ARROW_LAYER, LABEL_LAYER]) {
      try {
        map.setLayoutProperty(layerId, 'visibility', value)
      } catch {
        /* mid-teardown */
      }
    }
  }, [map, styleLoaded, styleGen, committedVisible])

  // ---- Click handler -----------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded || !selectionEnabled) return
    const onLayerClick = (e: MapMouseEvent) => {
      // Defer to higher-priority overlays. See overlay-hit-priority.
      if (higherPriorityAt(map, e.point, 'route')) return
      const feature = e.features?.[0]
      if (!feature) return
      const id = feature.properties?.id
      if (typeof id !== 'number') return
      e.preventDefault?.()
      onRouteClick?.(id, e.originalEvent as MouseEvent)
    }
    const onEmpty = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      onMapClickEmpty?.()
    }
    map.on('click', STROKE_LAYER, onLayerClick)
    map.on('click', WAYPOINT_LAYER, onLayerClick)
    map.on('click', onEmpty)
    return () => {
      map.off('click', STROKE_LAYER, onLayerClick)
      map.off('click', WAYPOINT_LAYER, onLayerClick)
      map.off('click', onEmpty)
    }
  }, [map, styleLoaded, styleGen, selectionEnabled, onRouteClick, onMapClickEmpty])

  return null
}
