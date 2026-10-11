import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'

import MapboxDraw from '@mapbox/mapbox-gl-draw'
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css'
import type { Map as MapboxMapInstance } from 'mapbox-gl'

import {
  DEFAULT_MAP_STYLE,
  normalizeStyleId,
  type MapStyleId,
} from '@/components/mapbox-map'
import DrawGridMode, { DRAW_GRID_MODE_NAME } from '@/lib/grid-draw-mode'
import { useHeaderControls } from '@/lib/header-controls'

/**
 * Static config handed to `new MapboxDraw()`. Registered once at
 * module scope so the mode table isn't rebuilt on every render.
 * Includes every built-in Mapbox Draw mode plus the custom
 * `DrawGridMode` used for two-click rack placement.
 */
const DRAW_CONTROLS = {
  displayControlsDefault: false,
  controls: {},
  modes: {
    ...MapboxDraw.modes,
    [DRAW_GRID_MODE_NAME]: DrawGridMode,
  },
} as const

/**
 * Map lifecycle: the `mapInstance` state, the `MapboxDraw` control,
 * per-user basemap style + localStorage sync, style-swap gate
 * (`loadedStyleId` vs `mapStyle`), `overlayMap` derivation, viewport
 * display via rAF, browser fullscreen state + toggle, and the
 * `useHeaderControls` publish/cleanup that hydrates the app header's
 * zoom / fullscreen buttons.
 *
 * `initialViewportSetRef` is owned by `useEditorBootstrap` (kept there
 * so the warehouse-switch reset lives next to the rest of warehouse
 * state) and threaded in so `handleMapDestroy` can clear it. The
 * initial-viewport auto-fit effect itself stays in the route file for
 * now — moving it in requires the saved-image + zone memos, which
 * belong to a later phase.
 *
 * `onMapDestroy` lets the caller reset draw-mode / live-line state
 * that isn't owned by this hook. Grid-draw state (`hasAnchor`,
 * `liveStart`, `liveCurrent`) currently lives in the route; when the
 * grid-draw hook lands, that resetter moves into it and this arg
 * disappears.
 */
export function useMapLifecycle({
  initialViewportSetRef,
  onMapDestroy,
}: {
  initialViewportSetRef: MutableRefObject<boolean>
  onMapDestroy?: () => void
}) {
  const [mapInstance, setMapInstance] = useState<MapboxMapInstance | null>(null)
  const drawRef = useRef<MapboxDraw | null>(null)
  const [viewport, setViewport] = useState({ lng: 0, lat: 20, zoom: 2 })

  // ---- Map style ---------------------------------------------------------
  // Defaults to the JSON's `main` entry (see `/map-styles.json` and
  // `mapbox-map.ts`), but a per-user choice is persisted to
  // localStorage so a refresh keeps the last-picked basemap.
  const [mapStyle, setMapStyle] = useState<MapStyleId>(() => {
    try {
      const fromLocal = typeof window !== 'undefined'
        ? window.localStorage.getItem('editorMapStyle')
        : null
      if (fromLocal) return normalizeStyleId(fromLocal)
    } catch {
      /* private-mode storage — fall through to default */
    }
    return DEFAULT_MAP_STYLE
  })
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return
      window.localStorage.setItem('editorMapStyle', mapStyle)
    } catch {
      /* ignore — non-critical */
    }
  }, [mapStyle])

  // ---- Style-swap gate ---------------------------------------------------
  // `loadedStyleId` is the id of the basemap that is currently fully
  // loaded. Same role as in `view.tsx`: gate overlay rendering on
  // `loadedStyleId === mapStyle` so the overlay tree only mounts (and
  // calls `addSource`/`addLayer`) once the new style has actually
  // finished swapping in. Without this, switching the basemap leaves
  // most overlays invisible because they raced against `setStyle()`.
  const [loadedStyleId, setLoadedStyleId] = useState<MapStyleId | null>(null)
  // Tracks whether the initial `style.load` has ever completed. Used to
  // distinguish the first-time setup (where `isStyleLoaded()` is true
  // because the map finished loading during `handleMapLoad`) from
  // subsequent style swaps (where `isStyleLoaded()` is still true
  // because `setStyle()` in MapboxMap hasn't run yet — it runs in a
  // later effect). Without this guard, Effect 2 below would re-raise
  // the gate during a style swap immediately after Effect 1 drops it,
  // so overlays never unmount and their layers get wiped by `setStyle()`
  // without re-initializing.
  const initialStyleLoadedRef = useRef(false)

  const handleMapLoad = useCallback((map: MapboxMapInstance) => {
    setMapInstance(map)
    const draw = new MapboxDraw(DRAW_CONTROLS)
    drawRef.current = draw
    map.addControl(draw)
  }, [])

  // Drop the gate the moment the user picks a new style — overlays
  // unmount before `setStyle()` runs, so they never add layers to the
  // outgoing basemap (which would just get wiped a few ms later).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadedStyleId((prev) => (prev === mapStyle ? prev : null))
  }, [mapStyle])

  // Bring the gate back up once the new style finishes loading. The
  // listener captures the current `mapStyle` via the dep, so the next
  // `style.load` always tags the right id.
  //
  // The `isStyleLoaded()` fast-path ONLY fires on the initial mount
  // (first time `mapInstance` becomes available after `handleMapLoad`).
  // On subsequent style swaps we wait for `style.load` because at the
  // time this effect runs the old basemap is still mounted — `setStyle()`
  // runs later in MapboxMap's own effect. Raising the gate early would
  // keep the overlay tree mounted through the wipe and they'd never
  // re-initialize their sources/layers.
  useEffect(() => {
    if (!mapInstance) return
    const onStyleLoad = () => {
      initialStyleLoadedRef.current = true
      setLoadedStyleId(mapStyle)
    }
    mapInstance.on('style.load', onStyleLoad)
    if (!initialStyleLoadedRef.current && mapInstance.isStyleLoaded() && loadedStyleId !== mapStyle) {
      initialStyleLoadedRef.current = true
      setLoadedStyleId(mapStyle)
    }
    return () => {
      mapInstance.off('style.load', onStyleLoad)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInstance, mapStyle])

  const handleMapDestroy = useCallback(() => {
    drawRef.current = null
    setMapInstance(null)
    setLoadedStyleId(null)
    initialViewportSetRef.current = false
    onMapDestroy?.()
  }, [initialViewportSetRef, onMapDestroy])

  const handleZoomIn = useCallback(() => mapInstance?.zoomIn(), [mapInstance])
  const handleZoomOut = useCallback(() => mapInstance?.zoomOut(), [mapInstance])

  // Gated map reference handed to every overlay component. Returns
  // null whenever the basemap is mid-swap (loadedStyleId out of sync
  // with mapStyle), which unmounts the overlays from React's tree and
  // stops them from calling `addSource`/`addLayer` against a style
  // that's about to be wiped. Non-overlay map consumers (e.g. the
  // PlaceSearcher geocoder, MapboxDraw, viewport listeners) continue
  // to use `mapInstance` directly because they don't paint into the
  // style layer stack.
  const overlayMap = loadedStyleId === mapStyle ? mapInstance : null

  // ---- Fullscreen --------------------------------------------------------
  // `isFullscreen` mirrors the actual element state so the header's icon
  // swap (Maximize ↔ Minimize) stays in sync, including with Esc-key
  // exits driven by the browser.
  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== 'undefined' && document.fullscreenElement != null,
  )
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement != null)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const handleToggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void document.documentElement.requestFullscreen()
    }
  }, [])

  // Publish the zoom + fullscreen handlers to the header. Cleared on
  // unmount so the header buttons render disabled when the user is on
  // a non-editor route (dashboard / integrations).
  useEffect(() => {
    const setControls = useHeaderControls.getState().setControls
    setControls({
      onZoomIn: handleZoomIn,
      onZoomOut: handleZoomOut,
      onToggleFullscreen: handleToggleFullscreen,
      isFullscreen,
    })
    return () => {
      setControls({
        onZoomIn: null,
        onZoomOut: null,
        onToggleFullscreen: null,
        isFullscreen: false,
      })
    }
  }, [handleZoomIn, handleZoomOut, handleToggleFullscreen, isFullscreen])

  // Viewport display via rAF.
  useEffect(() => {
    if (!mapInstance) return
    let rafId: number | null = null
    const update = () => {
      rafId = null
      const c = mapInstance.getCenter()
      setViewport({ lng: c.lng, lat: c.lat, zoom: mapInstance.getZoom() })
    }
    const schedule = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(update)
    }
    mapInstance.on('moveend', schedule)
    mapInstance.on('zoomend', schedule)
    mapInstance.on('rotateend', schedule)
    mapInstance.on('pitchend', schedule)
    update()
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      mapInstance.off('moveend', schedule)
      mapInstance.off('zoomend', schedule)
      mapInstance.off('rotateend', schedule)
      mapInstance.off('pitchend', schedule)
    }
  }, [mapInstance])

  return {
    mapInstance,
    drawRef,
    mapStyle,
    setMapStyle,
    viewport,
    overlayMap,
    isFullscreen,
    handleMapLoad,
    handleMapDestroy,
    handleZoomIn,
    handleZoomOut,
    handleToggleFullscreen,
  }
}
