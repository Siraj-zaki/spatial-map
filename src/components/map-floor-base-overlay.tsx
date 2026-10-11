/**
 * Building base under a raised floor shown on its own — see
 * src/lib/floor-base.ts for the geometry.
 *
 * Styles (graphics setting `floorBase`):
 *   solid  opaque block in the floor's exterior wall colour, darker bands at each
 *          lower storey
 *   ghost  see-through block, footprint outlined at the ground and each
 *          storey, the hidden floors' walls drawn as faint lines
 *   off    nothing
 *
 * Display-only: no layer here is in any hit-test list, nothing is saved.
 */

import type { GeoJSONSource, Map as MapboxMapInstance } from 'mapbox-gl'
import { useEffect, useMemo, useState } from 'react'

import { buildFloorBase, EMPTY_FLOOR_BASE, type FloorBaseInput } from '@/lib/floor-base'
import { useGraphicsSettings } from '@/lib/graphics-settings'

const BASE_SOURCE = 'floor-base-source'
const BAND_SOURCE = 'floor-base-band-source'
const OUTLINE_SOURCE = 'floor-base-outline-source'
const GHOST_SOURCE = 'floor-base-ghost-source'
const BASE_LAYER = 'floor-base-fill-layer'
const BAND_LAYER = 'floor-base-band-layer'
const OUTLINE_LAYER = 'floor-base-outline-layer'
const GHOST_LAYER = 'floor-base-ghost-wall-layer'
const LAYERS = [BASE_LAYER, BAND_LAYER, OUTLINE_LAYER, GHOST_LAYER]
const SOURCES = [BASE_SOURCE, BAND_SOURCE, OUTLINE_SOURCE, GHOST_SOURCE]

const GHOST_OPACITY = 0.3

/** Darken a hex colour by `t` (0–1). */
function shade(hex: string, t: number): string {
  const v = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t)))
  return `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

/** Base colours from the floor's own wall colour, so the base matches
 *  the building in every theme (not UI chrome — shape material). */
function colours(body: string) {
  return { body, band: shade(body, 0.14), line: shade(body, 0.55) }
}

export function MapFloorBaseOverlay({ map, input }: { map: MapboxMapInstance | null; input: FloorBaseInput }) {
  const style = useGraphicsSettings((s) => s.floorBase)
  const [ready, setReady] = useState(false)
  const [styleGen, setStyleGen] = useState(0)

  useEffect(() => {
    if (!map) return
    const onLoad = () => {
      setReady(true)
      setStyleGen((g) => g + 1)
    }
    // `isStyleLoaded()` is also false while any source is still loading,
    // and `style.load` won't fire again for a style that already loaded —
    // so poll until it's true, like map-polygon-overlay. Without this the
    // base never appeared when it mounted next to loading overlays (the
    // report explorer map), depending on timing.
    let interval: ReturnType<typeof setInterval> | null = null
    if (map.isStyleLoaded()) queueMicrotask(onLoad)
    else {
      interval = setInterval(() => {
        if (map.isStyleLoaded()) {
          if (interval) clearInterval(interval)
          interval = null
          onLoad()
        }
      }, 100)
    }
    map.on('style.load', onLoad)
    return () => {
      if (interval) clearInterval(interval)
      map.off('style.load', onLoad)
    }
  }, [map])

  const data = useMemo(() => (style === 'off' ? null : buildFloorBase(input)), [style, input])
  const tone = useMemo(() => colours(data?.color ?? '#e5e7eb'), [data?.color])

  // Mount sources + layers.
  useEffect(() => {
    if (!map || !ready) return
    try {
      for (const id of SOURCES) {
        if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      }
      if (!map.getLayer(BASE_LAYER)) {
        map.addLayer({
          id: BASE_LAYER,
          type: 'fill-extrusion',
          source: BASE_SOURCE,
          paint: {
            'fill-extrusion-color': tone.body,
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            'fill-extrusion-opacity': 1,
            // Same shading as walls (map-line-overlay): no vertical
            // gradient — on an 8 m block it darkens the lower half
            // towards black.
            'fill-extrusion-vertical-gradient': false,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-ambient-occlusion-intensity' as any]: 0.35,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-ambient-occlusion-radius' as any]: 2.5,
          },
        })
      }
      if (!map.getLayer(BAND_LAYER)) {
        map.addLayer({
          id: BAND_LAYER,
          type: 'fill-extrusion',
          source: BAND_SOURCE,
          paint: {
            'fill-extrusion-color': tone.band,
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            'fill-extrusion-opacity': 1,
            'fill-extrusion-vertical-gradient': false,
          },
        })
      }
      for (const [id, source, width, opacity] of [
        [OUTLINE_LAYER, OUTLINE_SOURCE, 2, 0.95],
        [GHOST_LAYER, GHOST_SOURCE, 1.5, 0.75],
      ] as const) {
        if (map.getLayer(id)) continue
        map.addLayer({
          id,
          type: 'line',
          source,
          paint: { 'line-color': tone.line, 'line-width': width, 'line-opacity': opacity, 'line-emissive-strength': 1 },
          layout: { 'line-elevation-reference': 'sea', 'line-z-offset': ['to-number', ['get', 'z']] },
        })
      }
    } catch (err) {
      console.warn('[floor-base] layer setup failed', err)
    }
  }, [map, ready, styleGen, tone])

  // Data + style.
  useEffect(() => {
    if (!map || !ready) return
    const d = data ?? EMPTY_FLOOR_BASE
    const ghost = style === 'ghost'
    const set = (id: string, fc: unknown) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(fc as Parameters<GeoJSONSource['setData']>[0])
    set(BASE_SOURCE, d.base)
    set(BAND_SOURCE, ghost ? EMPTY_FLOOR_BASE.bands : d.bands)
    set(OUTLINE_SOURCE, ghost ? d.outlines : EMPTY_FLOOR_BASE.outlines)
    set(GHOST_SOURCE, ghost ? d.ghostWalls : EMPTY_FLOOR_BASE.ghostWalls)
    try {
      if (map.getLayer(BASE_LAYER)) {
        map.setPaintProperty(BASE_LAYER, 'fill-extrusion-opacity', ghost ? GHOST_OPACITY : 1)
        map.setPaintProperty(BASE_LAYER, 'fill-extrusion-color', tone.body)
      }
      if (map.getLayer(BAND_LAYER)) map.setPaintProperty(BAND_LAYER, 'fill-extrusion-color', tone.band)
      for (const id of [OUTLINE_LAYER, GHOST_LAYER]) if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', tone.line)
    } catch {
      /* style swapping */
    }
  }, [map, ready, styleGen, data, style, tone])

  // Remove with the overlay.
  useEffect(() => {
    return () => {
      if (!map) return
      const live = (map as unknown as { style?: unknown; _removed?: boolean })
      if (!live.style || live._removed) return
      for (const id of LAYERS) {
        try {
          if (map.getLayer(id)) map.removeLayer(id)
        } catch { /* gone */ }
      }
      for (const id of SOURCES) {
        try {
          if (map.getSource(id)) map.removeSource(id)
        } catch { /* gone */ }
      }
    }
  }, [map])

  return null
}
