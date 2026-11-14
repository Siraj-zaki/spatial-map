/**
 * Focus mode's pulse ring: one DOM `mapboxgl.Marker` (`.sgv-focus-ring`,
 * index.css) at the focused item's anchor and altitude.
 *
 * A DOM marker rather than a map layer: it sits outside the GL depth
 * buffer (so no slab or wall can hide the very thing focus mode is
 * pointing at), animates in CSS only (no paint-property timer, no source
 * writes, the map stays idle), and costs nothing when there is no focus.
 * `aria-hidden` and `pointer-events: none` — it never takes a click from
 * the item under it.
 *
 * Render it INSIDE the host's focus providers: in DEV, while an item is
 * focused, it publishes `window.__sgvFocusDebug = { map, key, resolved,
 * blockersKey, blockers, pierce, nearKey, near, prisms, nearMs, plan,
 * cutRegion(kind, id) }` for verification scripts, and deletes it
 * (undefined) as soon as nothing is.
 */

import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'
import { useEffect, useRef } from 'react'

import { lastFocusCameraPlan } from '@/lib/focus/focus-camera'
import { focusCutRegion } from '@/lib/focus/focus-cutaway'
import { lastFocusNearComputeMs } from '@/lib/focus/focus-near'
import { useFocusBlockers, useFocusScene } from '@/lib/focus/focus-scene'
import type { FocusShapeKind, ResolvedFocus } from '@/lib/focus/focus-target'
import type { OccluderPrism } from '@/lib/occluder-index'

export interface MapFocusOverlayProps {
  map: MapboxMapInstance | null
  focus: ResolvedFocus | null
  /** 'pulse' (viewer / reports): pulses while focused. 'brief' (editor): 3 pulses, then fades out. */
  variant?: 'pulse' | 'brief'
  /** The host's focus prism list — DEV debug output only. */
  prisms?: ReadonlyArray<OccluderPrism>
}

interface FocusDebugWindow {
  __sgvFocusDebug?: unknown
}

export function MapFocusOverlay({ map, focus, variant = 'pulse', prisms }: MapFocusOverlayProps): null {
  const scene = useFocusScene()
  const blockers = useFocusBlockers()
  const markerRef = useRef<mapboxgl.Marker | null>(null)

  const key = focus?.key ?? ''
  const lng = focus?.position[0]
  const lat = focus?.position[1]
  const altitude = focus ? Math.max(0, focus.altitudeM) : 0

  // One ring per focused item: a new key re-creates it (and restarts the
  // brief variant's pulses); a moved anchor only updates it (below).
  useEffect(() => {
    if (!map || key === '' || lng === undefined || lat === undefined) return
    const el = document.createElement('div')
    el.className = variant === 'brief' ? 'sgv-focus-ring sgv-focus-ring--brief' : 'sgv-focus-ring'
    el.setAttribute('aria-hidden', 'true')
    el.style.pointerEvents = 'none'
    const marker = new mapboxgl.Marker({
      element: el,
      anchor: 'center',
      // `altitude` is a GL JS 3.x Marker option the bundled typings lack
      // (same cast as map-marker-overlay.tsx).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ altitude } as any),
    })
      .setLngLat([lng, lat])
      .addTo(map)
    markerRef.current = marker
    return () => {
      marker.remove()
      if (markerRef.current === marker) markerRef.current = null
    }
    // Position / altitude changes are applied by the effect below without
    // re-creating the ring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key, variant])

  useEffect(() => {
    const marker = markerRef.current
    if (!marker || lng === undefined || lat === undefined) return
    const ll = marker.getLngLat()
    if (!ll || ll.lng !== lng || ll.lat !== lat) marker.setLngLat([lng, lat])
    // `setAltitude` returns early for an unchanged value.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setAlt = (marker as any).setAltitude
    if (typeof setAlt === 'function') setAlt.call(marker, altitude)
  }, [key, lng, lat, altitude])

  const near = scene.near
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') return
    const w = window as unknown as FocusDebugWindow
    // Present only while something is focused: undefined when focus is off.
    if (key === '') {
      delete w.__sgvFocusDebug
      return
    }
    w.__sgvFocusDebug = {
      map,
      key,
      resolved: focus,
      blockersKey: blockers.key,
      blockers,
      // Where the line of sight pierces each blocker (cut-away disc centres).
      pierce: blockers.pierce,
      nearKey: near.key,
      near,
      prisms: prisms ?? null,
      // Timing of the last NEAR computation (computed during render, so
      // already fresh here).
      nearMs: lastFocusNearComputeMs(),
      // Live: the plan is recorded when the host's flyToFocus runs, which
      // can be after this effect.
      get plan() {
        return map ? lastFocusCameraPlan(map) : null
      },
      // The cut-away region a shape fades by (null: whole fade or none).
      cutRegion: (kind: FocusShapeKind, id: number) => focusCutRegion(scene, blockers, kind, id),
    }
  }, [map, key, focus, blockers, near, prisms, scene])

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') return
    return () => {
      delete (window as unknown as FocusDebugWindow).__sgvFocusDebug
    }
  }, [])

  return null
}
