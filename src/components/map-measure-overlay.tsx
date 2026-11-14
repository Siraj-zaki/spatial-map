/**
 * Measurement overlay — the drafting layer of the editor.
 *
 * Draws, on top of everything else:
 *   - the in-flight chain of the wall / polygon / Measure tools with a
 *     length label on every segment (and the area once it encloses one),
 *   - kept guides (dashed), with the same labels,
 *   - image-calibration marks, each labelled with its real value and how
 *     far off the image currently is,
 *   - a cursor readout (segment, total, angle, typed length).
 *
 * Generic on purpose: the route builds `MeasureItem`s (already formatted,
 * already translated) and this file only paints them. Every line / dot /
 * label is lifted to its floor with `line-z-offset` / `symbol-z-offset`
 * (see docs/pitfalls-frontend.md — `circle` has no z-offset, so dots are
 * a '●' glyph). Colours come from the theme tokens and follow palette and
 * light/dark swaps. Layers stay last in the stack like the route preview.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GeoJSONSource, Map as MapboxMapInstance } from 'mapbox-gl'

import { readThemeTokenHex, subscribeThemeChanges } from '@/lib/map-transform-handles'
import { whenStyleLoaded } from '@/lib/mapbox-style-ready'
import { midpoint, polygonCentroid, type LngLat } from '@/lib/measure/geometry'
import { cn } from '@/lib/utils'

export type MeasureTone = 'draft' | 'guide' | 'calibration' | 'calibration-off' | 'pending'

export interface MeasureItem {
  id: string
  vertices: LngLat[]
  closed: boolean
  /** Floor altitude, metres. */
  elevation: number
  tone: MeasureTone
  /** One label per segment (index i = vertices[i] → vertices[i+1], closing segment last). */
  segmentLabels?: string[]
  /** Label at the centre (area, or a calibration mark's value / error). */
  centerLabel?: string
  /** Where `centerLabel` sits; defaults to the centroid (closed) or first segment's midpoint. */
  centerAt?: LngLat
  /** Labels only — the shape's own overlay already draws its geometry (wall / polygon drafts). */
  labelsOnly?: boolean
}

export interface MeasureHud {
  cursor: LngLat
  rows: Array<{ label: string; value: string }>
  /** Typed-length buffer, shown as an input-looking chip. */
  typed?: string
  /** Highlight the frame (snapped onto a corner, angle locked). */
  emphasis?: boolean
  footer?: string
}

const LINE_SOURCE = 'measure-line-source'
const POINT_SOURCE = 'measure-point-source'
const HALO_LAYER = 'measure-halo-layer'
const LINE_LAYER = 'measure-line-layer'
const VERTEX_LAYER = 'measure-vertex-layer'
const LABEL_LAYER = 'measure-label-layer'
const LAYERS = [HALO_LAYER, LINE_LAYER, VERTEX_LAYER, LABEL_LAYER]
const FONT = ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']]

/** Theme token behind each tone. */
const TONE_TOKEN: Record<MeasureTone, [string, string]> = {
  draft: ['primary', '#2563eb'],
  guide: ['info', '#0ea5e9'],
  calibration: ['warning', '#f59e0b'],
  'calibration-off': ['muted-foreground', '#71717a'],
  pending: ['success', '#16a34a'],
}

function readPalette() {
  const tones = {} as Record<MeasureTone, string>
  for (const [tone, [token, fallback]] of Object.entries(TONE_TOKEN) as Array<[MeasureTone, [string, string]]>) {
    tones[tone] = readThemeTokenHex(token, fallback)
  }
  return {
    tones,
    text: readThemeTokenHex('foreground', '#18181b'),
    halo: readThemeTokenHex('background', '#ffffff'),
  }
}

function toneColorExpr(tones: Record<MeasureTone, string>) {
  return [
    'match',
    ['get', 'tone'],
    'draft', tones.draft,
    'guide', tones.guide,
    'calibration', tones.calibration,
    'calibration-off', tones['calibration-off'],
    'pending', tones.pending,
    tones.draft,
  ]
}

interface Props {
  map: MapboxMapInstance | null
  items: MeasureItem[]
  hud: MeasureHud | null
}

export function MapMeasureOverlay({ map, items, hud }: Props) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  const [styleGen, setStyleGen] = useState(0)
  const [themeGen, setThemeGen] = useState(0)

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
      '[measure]',
    )
  }, [map])

  useEffect(() => subscribeThemeChanges(() => setThemeGen((g) => g + 1)), [])

  const lines = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = []
    for (const it of items) {
      if (it.vertices.length < 2 || it.labelsOnly) continue
      const coords = it.closed ? [...it.vertices, it.vertices[0]] : it.vertices
      features.push({
        type: 'Feature',
        properties: { tone: it.tone, elevation: it.elevation + 0.03, dashed: it.tone === 'guide' || it.tone === 'calibration-off' ? 1 : 0 },
        geometry: { type: 'LineString', coordinates: coords },
      })
    }
    return { type: 'FeatureCollection', features }
  }, [items])

  const points = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = []
    for (const it of items) {
      const z = it.elevation + 0.04
      if (!it.labelsOnly) for (const v of it.vertices) {
        features.push({
          type: 'Feature',
          properties: { kind: 'vertex', tone: it.tone, elevation: z },
          geometry: { type: 'Point', coordinates: v },
        })
      }
      const n = it.vertices.length
      it.segmentLabels?.forEach((text, i) => {
        if (!text) return
        const a = it.vertices[i]
        const b = it.vertices[(i + 1) % n]
        if (!a || !b) return
        features.push({
          type: 'Feature',
          properties: { kind: 'label', text, elevation: z },
          geometry: { type: 'Point', coordinates: midpoint(a, b) },
        })
      })
      if (it.centerLabel && n > 0) {
        const at = it.centerAt ?? (it.closed && n >= 3 ? polygonCentroid(it.vertices) : n >= 2 ? midpoint(it.vertices[0], it.vertices[1]) : it.vertices[0])
        features.push({
          type: 'Feature',
          properties: { kind: 'label', text: it.centerLabel, elevation: z, center: 1 },
          geometry: { type: 'Point', coordinates: at },
        })
      }
    }
    return { type: 'FeatureCollection', features }
  }, [items])

  // ---- Install sources + layers (idempotent) ----------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const palette = readPalette()
    try {
      if (!map.getSource(LINE_SOURCE)) map.addSource(LINE_SOURCE, { type: 'geojson', data: lines })
      if (!map.getSource(POINT_SOURCE)) map.addSource(POINT_SOURCE, { type: 'geojson', data: points })
      if (!map.getLayer(HALO_LAYER)) {
        map.addLayer({
          id: HALO_LAYER,
          type: 'line',
          source: LINE_SOURCE,
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            'line-z-offset': ['coalesce', ['get', 'elevation'], 0],
          },
          paint: {
            'line-color': palette.halo,
            'line-width': 5,
            'line-opacity': 0.85,
            'line-emissive-strength': 1,
            'line-occlusion-opacity': 1,
          },
        })
      }
      if (!map.getLayer(LINE_LAYER)) {
        map.addLayer({
          id: LINE_LAYER,
          type: 'line',
          source: LINE_SOURCE,
          layout: {
            'line-cap': 'butt',
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            'line-z-offset': ['coalesce', ['get', 'elevation'], 0],
          },
          paint: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            'line-color': toneColorExpr(palette.tones) as any,
            'line-width': 2,
            'line-emissive-strength': 1,
            'line-occlusion-opacity': 1,
            'line-dasharray': ['match', ['get', 'dashed'], 1, ['literal', [3, 2]], ['literal', [1, 0]]],
          },
        })
      }
      if (!map.getLayer(VERTEX_LAYER)) {
        map.addLayer({
          id: VERTEX_LAYER,
          type: 'symbol',
          source: POINT_SOURCE,
          filter: ['==', ['get', 'kind'], 'vertex'],
          layout: {
            'text-field': '●',
            'text-font': FONT,
            'text-size': 11,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'symbol-z-elevate': false,
          },
          paint: {
            'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
            'text-color': toneColorExpr(palette.tones),
            'text-halo-color': palette.halo,
            'text-halo-width': 1.5,
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
            'text-font': FONT,
            'text-size': ['case', ['==', ['get', 'center'], 1], 13, 11],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-max-width': 14,
            'symbol-z-elevate': false,
          },
          paint: {
            'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
            'text-color': palette.text,
            'text-halo-color': palette.halo,
            'text-halo-width': 2,
            'text-emissive-strength': 1,
            'text-occlusion-opacity': 1,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
      }
    } catch (err) {
      console.warn('[measure] install failed', err)
    }
  }, [map, styleLoaded, styleGen, lines, points])

  // ---- Theme swap: re-tint ---------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded || themeGen === 0) return
    const palette = readPalette()
    try {
      if (map.getLayer(HALO_LAYER)) map.setPaintProperty(HALO_LAYER, 'line-color', palette.halo)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (map.getLayer(LINE_LAYER)) map.setPaintProperty(LINE_LAYER, 'line-color', toneColorExpr(palette.tones) as any)
      if (map.getLayer(VERTEX_LAYER)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setPaintProperty(VERTEX_LAYER, 'text-color', toneColorExpr(palette.tones) as any)
        map.setPaintProperty(VERTEX_LAYER, 'text-halo-color', palette.halo)
      }
      if (map.getLayer(LABEL_LAYER)) {
        map.setPaintProperty(LABEL_LAYER, 'text-color', palette.text)
        map.setPaintProperty(LABEL_LAYER, 'text-halo-color', palette.halo)
      }
    } catch { /* style torn down */ }
  }, [map, styleLoaded, themeGen])

  // ---- Keep on top -------------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const raise = () => {
      try {
        const layers = map.getStyle()?.layers ?? []
        if (layers[layers.length - 1]?.id === LABEL_LAYER) return
        for (const id of LAYERS) if (map.getLayer(id)) map.moveLayer(id)
      } catch { /* style torn down */ }
    }
    raise()
    map.on('styledata', raise)
    return () => {
      map.off('styledata', raise)
    }
  }, [map, styleLoaded, styleGen])

  // ---- Data refresh -----------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    try {
      ;(map.getSource(LINE_SOURCE) as GeoJSONSource | undefined)?.setData(lines)
      ;(map.getSource(POINT_SOURCE) as GeoJSONSource | undefined)?.setData(points)
    } catch { /* style torn down */ }
  }, [map, styleLoaded, styleGen, lines, points])

  // ---- Teardown ------------------------------------------------------------
  useEffect(() => {
    if (!map) return
    return () => {
      for (const id of [...LAYERS].reverse()) {
        try { if (map.getLayer(id)) map.removeLayer(id) } catch { /* map disposed */ }
      }
      for (const id of [POINT_SOURCE, LINE_SOURCE]) {
        try { if (map.getSource(id)) map.removeSource(id) } catch { /* map disposed */ }
      }
    }
  }, [map])

  return <MeasureCursorHud map={map} hud={hud} />
}

/**
 * Cursor readout — a DOM card portalled into the map container and
 * repositioned on Mapbox's `render` event (once per paint), so it tracks
 * pan / zoom without a React render per frame.
 */
function MeasureCursorHud({ map, hud }: { map: MapboxMapInstance | null; hud: MeasureHud | null }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const cursor = hud?.cursor ?? null

  useEffect(() => {
    if (!map || !cursor) return
    let raf = 0
    const reposition = () => {
      raf = 0
      const el = ref.current
      if (!el) return
      const pt = map.project(cursor)
      // Up and to the inline-end of the cursor, clear of the vertex dot.
      el.style.transform = `translate(${Math.round(pt.x + 18)}px, ${Math.round(pt.y - 18)}px) translateY(-100%)`
    }
    reposition()
    const onRender = () => {
      if (raf === 0) raf = requestAnimationFrame(reposition)
    }
    map.on('render', onRender)
    return () => {
      map.off('render', onRender)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [map, cursor])

  if (!map || !hud || (hud.rows.length === 0 && !hud.typed && !hud.footer)) return null

  return createPortal(
    <div
      ref={ref}
      className={cn(
        'pointer-events-none absolute left-0 top-0 z-[5] min-w-[9rem] select-none whitespace-nowrap',
        'rounded-lg border bg-card/95 px-2.5 py-1.5 font-mono text-[11px] text-card-foreground shadow-lg backdrop-blur-sm',
        hud.emphasis ? 'border-primary ring-1 ring-primary/40' : 'border-border',
      )}
      style={{ transform: 'translate(-9999px, -9999px)' }}
      dir="ltr"
    >
      {hud.rows.map((r) => (
        <div key={r.label} className="flex justify-between gap-3">
          <span className="font-sans text-muted-foreground">{r.label}</span>
          <span className="font-semibold">{r.value}</span>
        </div>
      ))}
      {hud.typed !== undefined && hud.typed !== '' && (
        <div className="mt-1 rounded border border-primary/60 bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
          {hud.typed}
          <span className="ms-0.5 animate-pulse">▏</span>
        </div>
      )}
      {hud.footer && (
        <div className="mt-1 max-w-[16rem] whitespace-normal font-sans text-[10px] text-muted-foreground">{hud.footer}</div>
      )}
    </div>,
    map.getContainer(),
  )
}
