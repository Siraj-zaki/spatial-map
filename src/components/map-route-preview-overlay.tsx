/**
 * Route-preview overlay — draws the computed wayfinding path on the map.
 *
 * Structure is a deliberate copy of the working `MapRouteOverlay`:
 *
 *   - Style readiness gated by `whenStyleLoaded` (race-safe against
 *     cold-start / style-swap sequences).
 *   - `styleGen` counter re-runs the install effect after every style
 *     load so a `setStyle` mid-session re-adds our source + layers.
 *   - Install effect is IDEMPOTENT (checks `!getLayer(...)` per layer)
 *     and depends on `[map, styleLoaded, styleGen, featureCollection]`
 *     so it re-runs whenever data changes, guaranteeing the layers
 *     exist when we push new data.
 *   - Data push effect uses the same deps + calls `setData` on the
 *     source — plain and pushable.
 *   - `line-elevation-reference: 'sea'` + `line-z-offset` driven by
 *     the feature property (defaulting to 0) matches exactly how the
 *     user-drawn routes render — the same paint that already works
 *     for `RouteShape`. We don't invent new elevation math.
 *
 * The overlay also drops two DOM markers for start / end so the user
 * always sees where the path begins and ends.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import mapboxgl, { type GeoJSONSource, type Map as MapboxMapInstance } from 'mapbox-gl'

import { whenStyleLoaded } from '@/lib/mapbox-style-ready'
import type { RouteStatus } from '@/lib/routing'

const STROKE_SOURCE = 'route-preview-stroke-source'
const STROKE_LAYER = 'route-preview-stroke-layer'
const HALO_LAYER = 'route-preview-halo-layer'

/** A walkable polygon with a raised top surface. */
export interface ElevatedRoutePolygon {
  vertices: [number, number][]
  /** Metres above sea level for the polygon's TOP surface. */
  topZ: number
}

interface Props {
  map: MapboxMapInstance | null
  start: [number, number] | null
  end: [number, number] | null
  path: [number, number][] | null
  status: RouteStatus | null
  /**
   * Walkable polygons with height/elevation > 0. When the route
   * crosses one of these, the segment inside is lifted to the
   * polygon's top surface so the line stays visible over the
   * extrusion instead of being clipped underneath.
   */
  elevatedPolygons?: ElevatedRoutePolygon[]
}

/** Even-odd point-in-polygon on a lng/lat ring. */
function pointInRing(p: [number, number], ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersect =
      yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Return the maximum `topZ` of any elevated polygon that contains `p`.
 * Zero when the point is on open ground (no covering polygon).
 */
function elevationAt(
  p: [number, number],
  polys: ReadonlyArray<ElevatedRoutePolygon>,
): number {
  let best = 0
  for (const poly of polys) {
    if (poly.topZ > best && pointInRing(p, poly.vertices)) best = poly.topZ
  }
  return best
}

/**
 * Slice a route path into contiguous LineString features grouped by
 * elevation zone. Where the path crosses a polygon boundary we
 * densify at 0.5 m intervals so the elevation "step" lands near the
 * actual boundary, then emit adjacent features with a shared endpoint
 * — the shared lng/lat with two elevations shows as a clean vertical
 * step-up in the pitched 3D view.
 *
 * The densification is coarse (0.5 m) because Mapbox interpolates
 * `line-z-offset` per-vertex; sub-half-metre precision at boundaries
 * isn't visible at typical zoom levels. Bumping this finer would just
 * add vertex count without visible benefit.
 */
function segmentPathByElevation(
  path: ReadonlyArray<[number, number]>,
  polys: ReadonlyArray<ElevatedRoutePolygon>,
): Array<{ coordinates: [number, number][]; elevation: number }> {
  if (path.length < 2) return []
  if (polys.length === 0) {
    return [{ coordinates: path.map((p) => [p[0], p[1]]), elevation: 0 }]
  }

  const R = 6378137
  const DEG = (Math.PI * R) / 180
  // Fine sample all coordinates along the input path in lng/lat, then
  // walk them assigning elevations.
  const samples: Array<{ p: [number, number]; z: number }> = []
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]
    const b = path[i + 1]
    const cosLat = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180))
    const dx = (b[0] - a[0]) * DEG * cosLat
    const dy = (b[1] - a[1]) * DEG
    const segLen = Math.hypot(dx, dy)
    const steps = Math.max(1, Math.ceil(segLen / 0.5))
    for (let k = 0; k <= steps; k++) {
      // Skip the endpoint of the previous sub-segment (it's the start
      // of this one) to avoid duplicating vertices.
      if (i > 0 && k === 0) continue
      const t = k / steps
      const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      samples.push({ p, z: elevationAt(p, polys) })
    }
  }

  // Group into runs of same elevation; on transition, emit two features
  // sharing the boundary lng/lat but at different elevations to make
  // the step visible.
  const out: Array<{ coordinates: [number, number][]; elevation: number }> = []
  let run: [number, number][] = [samples[0].p]
  let runZ = samples[0].z
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]
    if (s.z === runZ) {
      run.push(s.p)
      continue
    }
    // Transition: close the current run at THIS sample's lng/lat (with
    // the old Z), open a new run at THE SAME lng/lat (with the new Z).
    run.push(s.p)
    out.push({ coordinates: run, elevation: runZ })
    run = [s.p]
    runZ = s.z
  }
  out.push({ coordinates: run, elevation: runZ })
  return out
}

function strokeColorFor(status: RouteStatus | null): string {
  if (status === 'ok') return '#10b981'
  if (status === 'unreachable') return '#f59e0b'
  if (status === 'start-blocked' || status === 'end-blocked') return '#ef4444'
  return '#10b981'
}

export function MapRoutePreviewOverlay({
  map,
  start,
  end,
  path,
  status,
  elevatedPolygons,
}: Props) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  const [styleGen, setStyleGen] = useState(0)

  // ---- Style readiness ---------------------------------------------------
  useEffect(() => {
    if (!map) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStyleLoaded(false)
      return
    }
    return whenStyleLoaded(
      map,
      () => {
        setStyleLoaded(true)
        setStyleGen((g) => g + 1)
      },
      '[route-preview]',
    )
  }, [map])

  // ---- Feature collection -----------------------------------------------
  // The path is sliced at every crossing into/out of an elevated
  // walkable polygon so each slice carries its own `elevation`
  // property. `line-z-offset` reads that per-feature and lifts the
  // slice above the polygon extrusion, keeping the line visible in a
  // pitched 3D view instead of clipping under the extrusion.
  const featureCollection = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!path || path.length < 2) {
      return { type: 'FeatureCollection', features: [] }
    }
    const color = strokeColorFor(status)
    const zones = segmentPathByElevation(path, elevatedPolygons ?? [])
    return {
      type: 'FeatureCollection',
      features: zones.map((zone) => ({
        type: 'Feature',
        properties: {
          color,
          // 5 cm above the polygon top so the line sits visibly ON the
          // surface rather than z-fighting the roof plane.
          elevation: zone.elevation > 0 ? zone.elevation + 0.05 : 0,
        },
        geometry: { type: 'LineString', coordinates: zone.coordinates },
      })),
    }
  }, [path, status, elevatedPolygons])

  // ---- Install sources + layers (idempotent) ----------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return

    if (!map.getSource(STROKE_SOURCE)) {
      map.addSource(STROKE_SOURCE, {
        type: 'geojson',
        data: featureCollection,
        lineMetrics: true,
      })
      console.log('[route-preview] source installed', { id: STROKE_SOURCE })
    }

    // White halo underneath for contrast on any basemap.
    // `slot: 'top'` (Mapbox v3) forces the layer to render AFTER all
    // 3D fill-extrusions in the pipeline, regardless of layer array
    // order. Without it, a line at `line-z-offset` above a
    // fill-extrusion still gets occluded by the extrusion's top face
    // in top-down view — the fill-extrusion depth-writes at the roof
    // z and the line's fragments fail the depth test even though the
    // line is nominally 5 cm above. The `top` slot side-steps this
    // by putting the line in the "on-top-of-3D" render pass.
    if (!map.getLayer(HALO_LAYER)) {
      map.addLayer({
        id: HALO_LAYER,
        type: 'line',
        source: STROKE_SOURCE,
        slot: 'top',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-elevation-reference': 'sea',
          'line-z-offset': ['coalesce', ['get', 'elevation'], 0],
        },
        paint: {
          'line-color': '#ffffff',
          'line-width': 12,
          'line-opacity': 0.9,
          'line-emissive-strength': 1,
        },
      })
      console.log('[route-preview] halo layer installed', { id: HALO_LAYER })
    }

    // Coloured stroke on top.
    if (!map.getLayer(STROKE_LAYER)) {
      map.addLayer({
        id: STROKE_LAYER,
        type: 'line',
        source: STROKE_SOURCE,
        slot: 'top',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-elevation-reference': 'sea',
          'line-z-offset': ['coalesce', ['get', 'elevation'], 0],
        },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#10b981'],
          'line-width': 6,
          'line-opacity': 1,
          'line-emissive-strength': 1,
        },
      })
      console.log('[route-preview] stroke layer installed', { id: STROKE_LAYER })
    }
  }, [map, styleLoaded, styleGen, featureCollection])

  // ---- Data refresh -----------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(STROKE_SOURCE) as GeoJSONSource | undefined
    if (!src || typeof src.setData !== 'function') {
      console.warn('[route-preview] source not found on data push', {
        hasSource: !!src,
      })
      return
    }
    src.setData(featureCollection)
    const coords =
      featureCollection.features[0]?.geometry?.type === 'LineString'
        ? (featureCollection.features[0].geometry.coordinates as [number, number][])
        : []
    console.log('[route-preview] data pushed', {
      featureCount: featureCollection.features.length,
      waypointCount: coords.length,
      firstWaypoint: coords[0] ?? null,
      lastWaypoint: coords[coords.length - 1] ?? null,
      allWaypoints: coords,
      status,
      // What Mapbox now reports as present in the style — settles the
      // "is the layer actually there?" question definitively.
      strokeLayerPresent: !!map.getLayer(STROKE_LAYER),
      haloLayerPresent: !!map.getLayer(HALO_LAYER),
      sourcePresent: !!map.getSource(STROKE_SOURCE),
    })
  }, [map, styleLoaded, styleGen, featureCollection, status])

  // ---- DOM markers for endpoints ----------------------------------------
  const startMarkerRef = useRef<mapboxgl.Marker | null>(null)
  const endMarkerRef = useRef<mapboxgl.Marker | null>(null)

  // Marker visibility rule:
  //   - Start marker always shown when a start point is placed (even
  //     if no end yet, so the user sees where they clicked).
  //   - End marker ONLY shown when the pathfinder produced a valid
  //     route (`status === 'ok'`). For unreachable / blocked statuses
  //     we hide the end dot so the UI doesn't look like a successful
  //     route with two pins and no line.
  useEffect(() => {
    if (!map) return
    if (!start) {
      startMarkerRef.current?.remove()
      startMarkerRef.current = null
      return
    }
    if (!startMarkerRef.current) {
      const el = document.createElement('div')
      el.className = 'sgv-route-endpoint sgv-route-endpoint--start'
      el.setAttribute('aria-label', 'Route start')
      startMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat(start)
        .addTo(map)
    } else {
      startMarkerRef.current.setLngLat(start)
    }
    return () => {
      startMarkerRef.current?.remove()
      startMarkerRef.current = null
    }
  }, [map, start])

  useEffect(() => {
    if (!map) return
    const showEnd = end !== null && status === 'ok'
    if (!showEnd) {
      endMarkerRef.current?.remove()
      endMarkerRef.current = null
      return
    }
    if (!endMarkerRef.current) {
      const el = document.createElement('div')
      el.className = 'sgv-route-endpoint sgv-route-endpoint--end'
      el.setAttribute('aria-label', 'Route end')
      endMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat(end!)
        .addTo(map)
    } else {
      endMarkerRef.current.setLngLat(end!)
    }
    return () => {
      endMarkerRef.current?.remove()
      endMarkerRef.current = null
    }
  }, [map, end, status])

  return null
}
