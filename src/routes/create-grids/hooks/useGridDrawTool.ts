import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type MapboxDraw from '@mapbox/mapbox-gl-draw'
import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'

import { apiDb } from '@/lib/api-db'
import { DRAW_GRID_MODE_NAME } from '@/lib/grid-draw-mode'
import { type Grid } from '@/lib/db'
import { type GridConfig } from '@/lib/grid-generators'
import { gridHistory } from '@/lib/grid-history'
import { updateGridGeometry } from '@/lib/export'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { queryCache } from '@/lib/useApiQuery'

type MapListener = (object?: object) => unknown

/**
 * Grid (rack) draw tool. Unlike the other create-* tools, the grid
 * tool piggybacks on `MapboxDraw`'s event system (draw.create,
 * draw.modechange, draw.firstclick, draw.anchorclear) instead of the
 * raw map click/mousemove bus. That gives us the "two-click bbox with
 * a rubber-banded rectangle" gesture the tool needs, plus a re-draw
 * path where an existing grid's geometry seeds the mode's initial
 * state.
 *
 * Two-way sync with `activeTool`:
 *   - toolbar's Create Grid button → `activeTool = 'create-grid'` →
 *     this hook enters draw mode
 *   - side panel's "Draw new grid" button → this hook enters draw
 *     mode → sync effect flips `activeTool` to `'create-grid'` so
 *     the toolbar highlights it
 * To avoid a feedback loop, every write to `drawMode` tags a source
 * (`toolbar` or `panel`) in `drawModeSourceRef`. The sync effect only
 * writes to `activeTool` when the last change came from the panel.
 *
 * `enterDrawMode` / `exitDrawMode` / `handleToggleDrawMode` are
 * returned so `handleRedraw` in the route can seed the draw with an
 * existing row's geometry, and the side panel's toggle button can
 * flip draw mode with proper source-tagging.
 *
 * State ownership: `hasAnchor`, `drawMode`, `liveStart`, `liveCurrent`
 * were previously kept in the route so the map-lifecycle destroy path
 * could reset them; now the hook watches for `mapInstance` going
 * `null` and resets internally.
 */
export function useGridDrawTool({
  mapInstance,
  drawRef,
  activeTool,
  config,
  savedGrids,
  redrawingGridId,
  activeWarehouseIdRef,
  defaultFloorPlanIdRef,
  pinWarehouseCenterIfNeeded,
  setActiveTool,
  setRedrawingGridId,
}: {
  mapInstance: MapboxMapInstance | null
  drawRef: MutableRefObject<MapboxDraw | null>
  activeTool: Tool
  config: GridConfig
  savedGrids: ReadonlyArray<Grid>
  redrawingGridId: number | null
  activeWarehouseIdRef: MutableRefObject<number | null>
  defaultFloorPlanIdRef: MutableRefObject<number | null>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setActiveTool: Dispatch<SetStateAction<Tool>>
  setRedrawingGridId: Dispatch<SetStateAction<number | null>>
}) {
  const [hasAnchor, setHasAnchor] = useState(false)
  const [drawMode, setDrawMode] = useState(false)
  const [liveStart, setLiveStart] = useState<[number, number] | null>(null)
  const [liveCurrent, setLiveCurrent] = useState<[number, number] | null>(null)

  // If the map instance disappears (style swap, unmount), reset any
  // in-flight draw state. Was previously handled by
  // `handleMapDestroyReset` passed into `useMapLifecycle`; now
  // self-contained so the two hooks don't need to coordinate.
  useEffect(() => {
    if (mapInstance !== null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasAnchor(false)
    setDrawMode(false)
    setLiveStart(null)
    setLiveCurrent(null)
  }, [mapInstance])

  const liveLine = useMemo<
    { start: [number, number]; current: [number, number] } | null
  >(() => {
    if (!liveStart || !liveCurrent) return null
    if (liveStart[0] === liveCurrent[0] && liveStart[1] === liveCurrent[1]) return null
    return { start: liveStart, current: liveCurrent }
  }, [liveStart, liveCurrent])

  // ---- Toolbar ↔ side-panel sync ---------------------------------------
  const drawModeSourceRef = useRef<'toolbar' | 'panel' | null>(null)
  const lastActiveToolRef = useRef<Tool>(activeTool)
  const toggleDrawModeRef = useRef<() => void>(() => { })
  useEffect(() => {
    // Toolbar → draw mode (only when activeTool actually changed)
    if (activeTool !== lastActiveToolRef.current) {
      lastActiveToolRef.current = activeTool
      if (activeTool === 'create-grid' && !drawMode) {
        drawModeSourceRef.current = 'toolbar'
        toggleDrawModeRef.current()
      } else if (activeTool !== 'create-grid' && drawMode) {
        drawModeSourceRef.current = 'toolbar'
        toggleDrawModeRef.current()
      }
    }
    // Panel → toolbar highlight (one-way; only acts on panel-driven changes)
    if (drawModeSourceRef.current === 'panel' && drawMode && activeTool !== 'create-grid') {
      setActiveTool('create-grid')
    } else if (drawModeSourceRef.current === 'panel' && !drawMode && activeTool === 'create-grid') {
      setActiveTool('pan')
    }
    drawModeSourceRef.current = null
  }, [activeTool, drawMode, setActiveTool])

  const enterDrawMode = useCallback(
    (opts?: { start?: [number, number]; config?: GridConfig }) => {
      const draw = drawRef.current
      if (!draw) return
      setDrawMode(true)
      draw.changeMode(DRAW_GRID_MODE_NAME, {
        config: opts?.config ?? config,
        start: opts?.start,
      })
    },
    [config, drawRef],
  )

  const exitDrawMode = useCallback(() => {
    const draw = drawRef.current
    if (draw) draw.changeMode('simple_select')
    setDrawMode(false)
    setHasAnchor(false)
    setLiveStart(null)
    setLiveCurrent(null)
    setRedrawingGridId(null)
    // Keep the toolbar in sync — exiting the grid draw mode must
    // de-highlight the create-grid button.
    setActiveTool((t) => (t === 'create-grid' ? 'pan' : t))
  }, [drawRef, setActiveTool, setRedrawingGridId])

  const handleToggleDrawMode = useCallback(() => {
    if (drawMode) exitDrawMode()
    else enterDrawMode()
  }, [drawMode, enterDrawMode, exitDrawMode])

  // Keep the toolbar's toggle ref pointed at the latest
  // `handleToggleDrawMode` so the source-tracking effect above always
  // calls the freshest one.
  useEffect(() => {
    toggleDrawModeRef.current = handleToggleDrawMode
  }, [handleToggleDrawMode])

  // Re-enter draw mode when the config changes mid-draw so the
  // snapshot stored in the mode state is fresh.
  useEffect(() => {
    if (!drawMode) return
    enterDrawMode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, drawMode])

  // ---- Live preview (mousemove after anchor) ---------------------------
  useEffect(() => {
    if (!mapInstance || !drawMode || !hasAnchor) return
    const map = mapInstance
    let pending: { lng: number; lat: number } | null = null
    let rafId: number | null = null
    const flush = () => {
      rafId = null
      if (pending) {
        setLiveCurrent([pending.lng, pending.lat])
        pending = null
      }
    }
    const handleMove = (e: MapMouseEvent) => {
      pending = { lng: e.lngLat.lng, lat: e.lngLat.lat }
      if (rafId === null) rafId = requestAnimationFrame(flush)
    }
    map.on('mousemove', handleMove)
    return () => {
      map.off('mousemove', handleMove)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [mapInstance, drawMode, hasAnchor])

  // ---- MapboxDraw event listeners --------------------------------------
  useEffect(() => {
    if (!mapInstance) return
    const draw = drawRef.current
    if (!draw) return
    const handleCreate = (e: { features: GeoJSON.Feature[] }) => {
      const feature = e.features[0]
      if (!feature || feature.geometry.type !== 'LineString') {
        return
      }
      const coords = feature.geometry.coordinates as [number, number][]
      if (coords.length < 2) return
      const start = coords[0]
      const current = coords[coords.length - 1]
      const now = new Date()
      if (redrawingGridId !== null) {
        // Re-draw: update the existing grid's geometry.
        const orig = savedGrids.find((g) => g.id === redrawingGridId)
        if (orig) {
          gridHistory.push({
            type: 'redraw',
            gridId: redrawingGridId,
            oldStart: orig.start,
            oldCurrent: orig.current,
            newStart: start,
            newCurrent: current,
          })
          void updateGridGeometry(redrawingGridId, start, current).then(() => {
          })
        }
        setRedrawingGridId(null)
        setDrawMode(false)
        setHasAnchor(false)
        setLiveStart(null)
        setLiveCurrent(null)
        setActiveTool((t) => (t === 'create-grid' ? 'pan' : t))
        return
      }
      const name = `Grid ${now.toISOString().slice(0, 16)}`
      const wid = activeWarehouseIdRef.current
      void apiDb.grids
        .add({
          name,
          start,
          current,
          config,
          zoneId: wid ?? undefined,
          floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
          createdAt: now,
          updatedAt: now,
        })
        .then(() => {
          void pinWarehouseCenterIfNeeded(wid, start)
          queryCache.invalidate('grids')
        })
        .catch((err) => {
          console.warn('[CreateGrids] save failed', err)
        })
        .finally(() => {
          setDrawMode(false)
          setHasAnchor(false)
          setLiveStart(null)
          setLiveCurrent(null)
          setActiveTool((t) => (t === 'create-grid' ? 'pan' : t))
        })
    }
    const handleModeChange = () => {
      const mode = draw.getMode()
      if (mode !== DRAW_GRID_MODE_NAME) {
        setDrawMode(false)
        setHasAnchor(false)
        setLiveStart(null)
        setLiveCurrent(null)
        setRedrawingGridId(null)
        setActiveTool((t) => (t === 'create-grid' ? 'pan' : t))
      }
    }
    const handleFirstClick = (e: { start: [number, number] }) => {
      if (e?.start) {
        setHasAnchor(true)
        setLiveStart(e.start)
        setLiveCurrent(e.start)
      }
    }
    const handleAnchorClear = () => {
      setHasAnchor(false)
      setLiveStart(null)
      setLiveCurrent(null)
    }
    const onCreate = handleCreate as MapListener
    const onModeChange = handleModeChange as MapListener
    const onFirstClick = handleFirstClick as MapListener
    const onAnchorClear = handleAnchorClear as MapListener
    mapInstance.on('draw.create', onCreate)
    mapInstance.on('draw.modechange', onModeChange)
    mapInstance.on('draw.firstclick', onFirstClick)
    mapInstance.on('draw.anchorclear', onAnchorClear)
    return () => {
      mapInstance.off('draw.create', onCreate)
      mapInstance.off('draw.modechange', onModeChange)
      mapInstance.off('draw.firstclick', onFirstClick)
      mapInstance.off('draw.anchorclear', onAnchorClear)
    }
  }, [
    mapInstance,
    config,
    redrawingGridId,
    savedGrids,
    pinWarehouseCenterIfNeeded,
    drawRef,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    setActiveTool,
    setRedrawingGridId,
  ])

  return {
    hasAnchor,
    drawMode,
    liveStart,
    liveCurrent,
    liveLine,
    setHasAnchor,
    setDrawMode,
    setLiveStart,
    setLiveCurrent,
    enterDrawMode,
    exitDrawMode,
    handleToggleDrawMode,
    drawModeSourceRef,
  }
}
