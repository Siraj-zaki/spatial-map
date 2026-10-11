import { useEffect, useMemo, useState } from 'react'
import type { GeoJSONSource, Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import {
  area as turfArea,
  distance,
  length,
  lineString as turfLineString,
  point as turfPoint,
  polygon as turfPolygon,
} from '@turf/turf'

interface ViewMeasureToolProps {
  map: MapboxMapInstance | null
  active: boolean
  onClose: () => void
  /** Drives the distance formatter — metric (m/km) vs imperial (ft/mi). */
  scaleUnit: 'metric' | 'imperial'
}

const SRC_LINE = 'viewer-measure-line-source'
const SRC_POINTS = 'viewer-measure-points-source'
const SRC_PREVIEW = 'viewer-measure-preview-source'
const SRC_AREA = 'viewer-measure-area-source'
const LAYER_LINE = 'viewer-measure-line-layer'
const LAYER_PREVIEW = 'viewer-measure-preview-layer'
const LAYER_POINTS = 'viewer-measure-points-layer'
const LAYER_AREA = 'viewer-measure-area-layer'

/** Pretty-print a distance in meters into the active unit system. */
function formatDistance(meters: number, scaleUnit: 'metric' | 'imperial'): string {
  if (scaleUnit === 'imperial') {
    const feet = meters * 3.28084
    if (feet < 1000) return `${feet.toFixed(feet < 10 ? 2 : 1)} ft`
    const miles = feet / 5280
    return `${miles.toFixed(miles < 10 ? 2 : 1)} mi`
  }
  if (meters < 1000) return `${meters.toFixed(meters < 10 ? 2 : 1)} m`
  return `${(meters / 1000).toFixed(meters / 1000 < 10 ? 2 : 1)} km`
}

/** Pretty-print an area in square meters. Crosses unit boundaries
 * automatically: m² → km² past 1M sq m, ft² → acres past ~10k sq ft. */
function formatArea(sqMeters: number, scaleUnit: 'metric' | 'imperial'): string {
  if (scaleUnit === 'imperial') {
    const sqft = sqMeters * 10.7639
    if (sqft < 10_000) return `${sqft.toFixed(sqft < 100 ? 1 : 0)} ft²`
    const acres = sqft / 43_560
    if (acres < 640) return `${acres.toFixed(acres < 10 ? 2 : 1)} ac`
    return `${(acres / 640).toFixed(2)} mi²`
  }
  if (sqMeters < 1_000_000) return `${sqMeters.toFixed(sqMeters < 100 ? 1 : 0)} m²`
  return `${(sqMeters / 1_000_000).toFixed(2)} km²`
}

/**
 * Click-to-measure tool. Pro indoor viewers (ArcGIS Indoors, MapIndoors
 * kiosk) ship a ruler — warehouse users in particular need to eyeball
 * aisle widths and rack spans. We render the running line + per-vertex
 * dots + a single floating total label near the cursor.
 *
 * Lifecycle:
 *   - `active = true` installs sources/layers, binds map handlers, and
 *     swaps the cursor to crosshair.
 *   - Click adds a vertex; mousemove updates the preview segment.
 *   - Double-click or Esc fires `onClose()` (parent clears the toggle).
 *   - `active = false` (re-render) removes layers and bindings, so we
 *     don't leak Mapbox sources between sessions.
 */
export function ViewMeasureTool({ map, active, onClose, scaleUnit }: ViewMeasureToolProps) {
  // Vertices accumulate on click; preview point is the live cursor.
  const [vertices, setVertices] = useState<[number, number][]>([])
  const [cursor, setCursor] = useState<[number, number] | null>(null)

  // Clear on deactivate so a fresh activation starts blank.
  useEffect(() => {
    if (!active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVertices([])
      setCursor(null)
    }
  }, [active])

  // Install sources and layers once when the tool becomes active.
  useEffect(() => {
    if (!map || !active) return
    const install = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(map as any).style) return
      for (const id of [SRC_LINE, SRC_POINTS, SRC_PREVIEW, SRC_AREA]) {
        if (!map.getSource(id)) {
          map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
      }
      // Area fill renders first so the dashed preview line and the
      // committed solid line both sit on top of it.
      if (!map.getLayer(LAYER_AREA)) {
        map.addLayer({
          id: LAYER_AREA,
          type: 'fill',
          source: SRC_AREA,
          paint: {
            'fill-color': '#22d3ee',
            'fill-opacity': 0.12,
          },
        })
      }
      if (!map.getLayer(LAYER_LINE)) {
        map.addLayer({
          id: LAYER_LINE,
          type: 'line',
          source: SRC_LINE,
          paint: {
            'line-color': '#22d3ee',
            'line-width': 2.5,
            'line-opacity': 0.95,
            'line-emissive-strength': 1,
          },
        })
      }
      if (!map.getLayer(LAYER_PREVIEW)) {
        map.addLayer({
          id: LAYER_PREVIEW,
          type: 'line',
          source: SRC_PREVIEW,
          paint: {
            'line-color': '#22d3ee',
            'line-width': 2,
            'line-opacity': 0.55,
            'line-dasharray': [2, 2],
            'line-emissive-strength': 1,
          },
        })
      }
      if (!map.getLayer(LAYER_POINTS)) {
        map.addLayer({
          id: LAYER_POINTS,
          type: 'circle',
          source: SRC_POINTS,
          paint: {
            'circle-color': '#0e7490',
            'circle-radius': 4,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.5,
            'circle-emissive-strength': 1,
          },
        })
      }
    }
    if (map.isStyleLoaded()) install()
    else map.once('style.load', install)

    const prevCursor = map.getCanvas().style.cursor
    map.getCanvas().style.cursor = 'crosshair'
    // Default Mapbox doubleclick zoom would race the measurement-finalize
    // double-click, so we suspend it for the duration.
    map.doubleClickZoom.disable()

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((map as any).style) {
        try {
          if (map.getLayer(LAYER_LINE)) map.removeLayer(LAYER_LINE)
          if (map.getLayer(LAYER_PREVIEW)) map.removeLayer(LAYER_PREVIEW)
          if (map.getLayer(LAYER_POINTS)) map.removeLayer(LAYER_POINTS)
          if (map.getLayer(LAYER_AREA)) map.removeLayer(LAYER_AREA)
          if (map.getSource(SRC_LINE)) map.removeSource(SRC_LINE)
          if (map.getSource(SRC_PREVIEW)) map.removeSource(SRC_PREVIEW)
          if (map.getSource(SRC_POINTS)) map.removeSource(SRC_POINTS)
          if (map.getSource(SRC_AREA)) map.removeSource(SRC_AREA)
        } catch { /* style mid-tear-down */ }
      }
      map.getCanvas().style.cursor = prevCursor
      map.doubleClickZoom.enable()
    }
  }, [map, active])

  // Click + mousemove + keyboard bindings. We tear them down whenever
  // `active` flips so a freshly re-activated tool reattaches cleanly.
  useEffect(() => {
    if (!map || !active) return
    const onClick = (e: MapMouseEvent) => {
      const c: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      setVertices((v) => [...v, c])
    }
    const onMove = (e: MapMouseEvent) => {
      setCursor([e.lngLat.lng, e.lngLat.lat])
    }
    const onDblClick = (e: MapMouseEvent) => {
      e.preventDefault()
      onClose()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose()
      else if (ev.key === 'Backspace' || ev.key === 'Delete') {
        setVertices((v) => v.slice(0, -1))
      }
    }
    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.on('dblclick', onDblClick)
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('dblclick', onDblClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [map, active, onClose])

  // Push the geometry into the sources. We compute the cursor preview
  // line separately so it can be dashed without rebuilding the
  // committed source on every mousemove.
  useEffect(() => {
    if (!map) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(map as any).style) return
    const lineSrc = map.getSource(SRC_LINE) as GeoJSONSource | undefined
    const ptsSrc = map.getSource(SRC_POINTS) as GeoJSONSource | undefined
    const prevSrc = map.getSource(SRC_PREVIEW) as GeoJSONSource | undefined
    if (!lineSrc || !ptsSrc || !prevSrc) return
    lineSrc.setData(
      vertices.length >= 2
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: vertices }, properties: {} }
        : { type: 'FeatureCollection', features: [] },
    )
    ptsSrc.setData({
      type: 'FeatureCollection',
      features: vertices.map((v) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: v }, properties: {},
      })),
    })
    if (vertices.length >= 1 && cursor) {
      prevSrc.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [vertices[vertices.length - 1], cursor] },
        properties: {},
      })
    } else {
      prevSrc.setData({ type: 'FeatureCollection', features: [] })
    }
    // Area polygon: include the cursor as a tentative final vertex
    // while the user is still drawing so the fill grows under the
    // mouse and previews the closed shape.
    const areaSrc = map.getSource(SRC_AREA) as GeoJSONSource | undefined
    if (areaSrc) {
      const ring = cursor ? [...vertices, cursor] : vertices
      if (ring.length >= 3) {
        // turf needs the ring closed.
        const closed = [...ring, ring[0]]
        areaSrc.setData({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [closed] },
          properties: {},
        })
      } else {
        areaSrc.setData({ type: 'FeatureCollection', features: [] })
      }
    }
  }, [map, vertices, cursor])

  // Running total (committed segments + live cursor leg if present).
  const totalMeters = useMemo(() => {
    if (vertices.length === 0) return 0
    const path = cursor ? [...vertices, cursor] : vertices
    if (path.length < 2) return 0
    // turf.length returns kilometers; we want meters.
    return length(turfLineString(path), { units: 'kilometers' }) * 1000
  }, [vertices, cursor])

  const lastSegmentMeters = useMemo(() => {
    if (vertices.length === 0 || !cursor) return null
    const a = vertices[vertices.length - 1]
    return distance(turfPoint(a), turfPoint(cursor), { units: 'kilometers' }) * 1000
  }, [vertices, cursor])

  // Spherical area of the implicit polygon (vertices + live cursor +
  // close). Only meaningful at 3+ points; turf returns square meters.
  const totalSqMeters = useMemo(() => {
    const ring = cursor ? [...vertices, cursor] : vertices
    if (ring.length < 3) return 0
    const closed = [...ring, ring[0]]
    try {
      return turfArea(turfPolygon([closed]))
    } catch {
      // Self-intersecting / degenerate ring while the user draws.
      return 0
    }
  }, [vertices, cursor])

  if (!active) return null

  return (
    <div
      className="pointer-events-none fixed top-12 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 rounded-md bg-card/95 backdrop-blur border shadow-md text-xs flex items-center gap-3"
      role="status"
    >
      <span className="font-mono tabular-nums">
        <span className="text-muted-foreground me-1">Σ</span>
        {formatDistance(totalMeters, scaleUnit)}
      </span>
      {totalSqMeters > 0 && (
        <span className="font-mono tabular-nums">
          <span className="text-muted-foreground me-1">▱</span>
          {formatArea(totalSqMeters, scaleUnit)}
        </span>
      )}
      {lastSegmentMeters !== null && (
        <span className="font-mono tabular-nums text-muted-foreground">
          +{formatDistance(lastSegmentMeters, scaleUnit)}
        </span>
      )}
      <span className="text-[10px] text-muted-foreground">
        Click to add · Dbl-click to finish · Esc cancel · ⌫ undo
      </span>
    </div>
  )
}
