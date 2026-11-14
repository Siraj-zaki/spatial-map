/**
 * Route-preview overlay — draws the planned route on the map, on every
 * floor it uses.
 *
 *   - Each walking leg is drawn at its floor's height, and lifted onto the
 *     top of any raised walkable polygon on that floor (rooms drawn as
 *     blocks, a floor-area slab) so the line isn't hidden inside it.
 *   - A floor change through stairs or an escalator draws as a line that
 *     climbs in short steps from the landing on one floor to the landing on
 *     the next; every change also gets a small label at both ends
 *     ("Stairs 1 ↑", "Lift ↓").
 *   - Start / end pins are symbols at their floor's height (a DOM marker
 *     can't be lifted off the ground, so on an upper floor it drifted).
 *
 * Structure follows `MapRouteOverlay`: style readiness via
 * `whenStyleLoaded`, a `styleGen` counter re-running the idempotent install
 * after a style swap, `line-elevation-reference: 'sea'` + per-feature
 * `line-z-offset`. The layers are unslotted and kept last in the stack
 * (see the keep-on-top effect below).
 */

import { useEffect, useMemo, useState } from 'react'
import type { GeoJSONSource, Map as MapboxMapInstance } from 'mapbox-gl'

import { whenStyleLoaded } from '@/lib/mapbox-style-ready'
import type { Floor, RouteOption } from '@/lib/routing/floors'
import { legRuns, surfacesOnFloor, type ElevatedPolygon } from '@/lib/routing/surface'
import type { RoutePin, RoutePlanStatus } from '@/routes/create-grids/hooks/useRoutePreviewTool'

const STROKE_SOURCE = 'route-preview-stroke-source'
const STROKE_LAYER = 'route-preview-stroke-layer'
const HALO_LAYER = 'route-preview-halo-layer'
const POINT_SOURCE = 'route-preview-point-source'
const PIN_LAYER = 'route-preview-pin-layer'
const LABEL_LAYER = 'route-preview-label-layer'

/** Route colours: the same as before the multi-floor rework. */
const OK = '#10b981'
const FAIL = '#ef4444'
const START = '#10b981'
const END = '#ef4444'

interface Props {
  map: MapboxMapInstance | null
  start: RoutePin | null
  end: RoutePin | null
  /** The chosen route option, when the planner found one. */
  option: RouteOption | null
  status: RoutePlanStatus | null
  floors: Floor[]
  elevatedPolygons?: ElevatedPolygon[]
  /** Label at a floor change: "Stairs 1 ↑" where it is taken, "Stairs 1"
   *  where it arrives (`dir` null). */
  portalLabel: (kind: 'stairs' | 'escalator' | 'lift', name: string, dir: 'up' | 'down' | null) => string
}

/** A floor change drawn as a line climbing in short steps. */
function climb(a: [number, number], b: [number, number], za: number, zb: number) {
  const n = 12
  const out: Array<{ coordinates: [number, number][]; z: number }> = []
  for (let i = 0; i < n; i++) {
    const t0 = i / n
    const t1 = (i + 1) / n
    out.push({
      coordinates: [
        [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0],
        [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1],
      ],
      z: za + (zb - za) * ((t0 + t1) / 2),
    })
  }
  return out
}

export function MapRoutePreviewOverlay({ map, start, end, option, status, floors, elevatedPolygons, portalLabel }: Props) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  const [styleGen, setStyleGen] = useState(0)

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

  const floorZ = useMemo(() => new Map(floors.map((f) => [f.id, f.elevation])), [floors])

  const lines = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = []
    if (option && status === 'ok') {
      const lowestZ = floors[0]?.elevation ?? 0
      for (const leg of option.legs) {
        const z = leg.floorId == null ? lowestZ : (floorZ.get(leg.floorId) ?? 0)
        // Lifted onto the raised areas on this floor (routing/surface.ts).
        const polys = surfacesOnFloor(elevatedPolygons ?? [], z)
        for (const r of legRuns(leg.waypoints, z, polys)) {
          features.push({
            type: 'Feature',
            properties: { color: OK, elevation: r.z + 0.05 },
            geometry: { type: 'LineString', coordinates: r.coordinates },
          })
        }
      }
      option.transitions.forEach((t, i) => {
        if (t.portal.kind === 'lift') return // a lift goes straight up: its labels show it
        const a = t.portal.at.get(t.fromFloor.id)
        const b = t.portal.at.get(t.toFloor.id)
        if (!a || !b) return
        // Stairs: up the treads and across the landing, as built. Escalators:
        // a steady incline from landing to landing.
        const pieces = t.portal.climb?.length ? t.portal.climb : climb(a, b, t.fromFloor.elevation, t.toFloor.elevation)
        for (const r of pieces) {
          features.push({
            type: 'Feature',
            properties: { color: OK, elevation: r.z + 0.05 },
            geometry: { type: 'LineString', coordinates: r.coordinates },
          })
        }
        // The walks stop at the edge of the stair's footprint (it blocks
        // walking); join each to its end of the climb so the line is unbroken.
        const first = pieces[0].coordinates[0]
        const lastPiece = pieces[pieces.length - 1]
        const last = lastPiece.coordinates[lastPiece.coordinates.length - 1]
        const near = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1])
        const join = (from: [number, number] | undefined, z: number) => {
          if (!from) return
          const to = near(from, first) <= near(from, last) ? first : last
          if (near(from, to) < 1e-9) return
          features.push({
            type: 'Feature',
            properties: { color: OK, elevation: z + 0.05 },
            geometry: { type: 'LineString', coordinates: [from, to] },
          })
        }
        const before = option.legs[i]?.waypoints
        const after = option.legs[i + 1]?.waypoints
        join(before?.[before.length - 1], t.fromFloor.elevation)
        join(after?.[0], t.toFloor.elevation)
      })
    }
    return { type: 'FeatureCollection', features }
  }, [option, status, floors, floorZ, elevatedPolygons])

  const points = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = []
    const pin = (p: RoutePin, color: string) =>
      features.push({
        type: 'Feature',
        properties: { kind: 'pin', color, elevation: p.z + 0.1 },
        geometry: { type: 'Point', coordinates: p.coord },
      })
    if (start) pin(start, START)
    // The end pin only with a route: a lone red dot reads as success.
    if (end && status === 'ok') pin(end, END)
    if (end && status && status !== 'ok') pin(end, FAIL)
    if (option && status === 'ok') {
      for (const t of option.transitions) {
        const dir = t.toFloor.elevation > t.fromFloor.elevation ? 'up' : 'down'
        for (const [floor, d] of [
          [t.fromFloor, dir],
          [t.toFloor, null],
        ] as const) {
          const at = t.portal.at.get(floor.id)
          if (!at) continue
          features.push({
            type: 'Feature',
            properties: { kind: 'label', text: portalLabel(t.portal.kind, t.portal.name, d), elevation: floor.elevation + 0.6 },
            geometry: { type: 'Point', coordinates: at },
          })
        }
      }
    }
    return { type: 'FeatureCollection', features }
  }, [start, end, status, option, portalLabel])

  // ---- Install sources + layers (idempotent) ----------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    try {
      if (!map.getSource(STROKE_SOURCE)) map.addSource(STROKE_SOURCE, { type: 'geojson', data: lines, lineMetrics: true })
      if (!map.getSource(POINT_SOURCE)) map.addSource(POINT_SOURCE, { type: 'geojson', data: points })
      if (!map.getLayer(HALO_LAYER)) {
        map.addLayer({
          id: HALO_LAYER,
          type: 'line',
          source: STROKE_SOURCE,
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            'line-z-offset': ['coalesce', ['get', 'elevation'], 0],
          },
          // The route always draws in full, over walls, slabs and floors —
          // a route you can't see is no route. Partial values (0.35 / 0.55)
          // looked right on the ground floor, but Mapbox counted an upper
          // floor's line (z ≈ 7 m) as occluded even with nothing above it,
          // so it faded or vanished there.
          paint: {
            'line-color': '#ffffff',
            'line-width': 12,
            'line-opacity': 0.9,
            'line-emissive-strength': 1,
            'line-occlusion-opacity': 1,
          },
        })
      }
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
            'line-color': ['coalesce', ['get', 'color'], OK],
            'line-width': 6,
            'line-opacity': 1,
            'line-emissive-strength': 1,
            'line-occlusion-opacity': 1,
          },
        })
      }
      // Pins: a bullet glyph — `circle` has no z-offset in Mapbox 3.25,
      // `symbol` does (same trick as the draw tools' vertex dots).
      if (!map.getLayer(PIN_LAYER)) {
        map.addLayer({
          id: PIN_LAYER,
          type: 'symbol',
          source: POINT_SOURCE,
          filter: ['==', ['get', 'kind'], 'pin'],
          layout: {
            'text-field': '●',
            'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
            'text-size': 26,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'symbol-z-elevate': false,
          },
          paint: {
            // Paint property in Mapbox 3.25 (in layout it is ignored and the
            // pin sits on the ground under an upper floor).
            'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
            'text-color': ['coalesce', ['get', 'color'], OK],
            'text-halo-color': '#ffffff',
            'text-halo-width': 3,
            'text-emissive-strength': 1,
            'text-occlusion-opacity': 1,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
      }
      if (!map.getLayer(LABEL_LAYER)) {
        map.addLayer({
          id: LABEL_LAYER,
          type: 'symbol',
          source: POINT_SOURCE,
          filter: ['==', ['get', 'kind'], 'label'],
          layout: {
            'text-field': ['get', 'text'],
            'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
            'text-size': 12,
            'text-anchor': 'bottom',
            'text-offset': ['literal', [0, -0.6]],
            'text-allow-overlap': true,
            'symbol-z-elevate': false,
          },
          paint: {
            'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
            'text-color': '#065f46',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
            'text-emissive-strength': 1,
            'text-occlusion-opacity': 1,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
      }
    } catch (err) {
      console.warn('[route-preview] install failed', err)
    }
  }, [map, styleLoaded, styleGen, lines, points])

  // ---- Keep on top -------------------------------------------------------
  // Not `slot: 'top'`: Mapbox draws every unslotted overlay layer (floor
  // plans, polygon slabs, walls) after the basemap's slots. An elevated line
  // writes no depth, so an upper floor's sheet or slab drawn later painted
  // straight over a route a few cm above it — most visibly in the flat
  // (orthographic) top-down view. Last in the stack, the route draws after
  // them; the occlusion pass still covers anything really in front of it.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const ORDER = [HALO_LAYER, STROKE_LAYER, PIN_LAYER, LABEL_LAYER]
    const raise = () => {
      try {
        const layers = map.getStyle()?.layers ?? []
        if (layers[layers.length - 1]?.id === LABEL_LAYER) return
        for (const id of ORDER) if (map.getLayer(id)) map.moveLayer(id)
      } catch { /* style torn down */ }
    }
    raise()
    // An overlay that mounts or re-adds its layers later lands above ours.
    map.on('styledata', raise)
    return () => {
      map.off('styledata', raise)
    }
  }, [map, styleLoaded, styleGen])

  // ---- Data refresh -----------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    try {
      ;(map.getSource(STROKE_SOURCE) as GeoJSONSource | undefined)?.setData(lines)
      ;(map.getSource(POINT_SOURCE) as GeoJSONSource | undefined)?.setData(points)
    } catch { /* style torn down */ }
  }, [map, styleLoaded, styleGen, lines, points])

  // ---- Teardown: the route vanishes with the tool ------------------------
  useEffect(() => {
    if (!map) return
    return () => {
      for (const id of [LABEL_LAYER, PIN_LAYER, STROKE_LAYER, HALO_LAYER]) {
        try { if (map.getLayer(id)) map.removeLayer(id) } catch { /* map disposed */ }
      }
      for (const id of [POINT_SOURCE, STROKE_SOURCE]) {
        try { if (map.getSource(id)) map.removeSource(id) } catch { /* map disposed */ }
      }
    }
  }, [map])

  return null
}
