import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type MapboxDraw from '@mapbox/mapbox-gl-draw'
import type { Feature, LineString } from 'geojson'
import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import { unprojectOnScene } from '@/lib/unproject-at-altitude'

import { apiDb } from '@/lib/api-db'
import { DRAW_GRID_MODE_NAME } from '@/lib/grid-draw-mode'
import { type Grid } from '@/lib/db'
import { type GridConfig } from '@/lib/grid-generators'
import { isPathLayout, pathGridGeometry } from '@/lib/grid-path'
import { gridHistory } from '@/lib/grid-history'
import { updateGridGeometry, updateGridShape } from '@/lib/export'
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
  // Path layout: the vertices clicked so far (the cursor is `liveCurrent`).
  const [liveVertices, setLiveVertices] = useState<[number, number][]>([])
  // Mirror of the draw mode's vertices, written synchronously from its
  // events: re-entering the mode (a config change mid-draw) passes them
  // back in so the points clicked so far — or a re-drawn grid's existing
  // path — survive. State would lag a render behind.
  const pathVerticesRef = useRef<[number, number][]>([])

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
    setLiveVertices([])
    pathVerticesRef.current = []
  }, [mapInstance])

  // Path layout: the in-progress path (clicked vertices + cursor) as a grid
  // box and a config carrying the normalised path, so the overlay previews
  // the real cells while the user is still clicking.
  const livePath = useMemo(() => {
    if (!isPathLayout(config) || liveVertices.length === 0 || !liveCurrent) return null
    const geo = pathGridGeometry([...liveVertices, liveCurrent], config)
    if (!geo) return null
    return { line: { start: geo.start, current: geo.current }, config: { ...config, rotation: 0, path: geo.path } }
  }, [config, liveVertices, liveCurrent])

  const liveLine = useMemo<
    { start: [number, number]; current: [number, number] } | null
  >(() => {
    if (isPathLayout(config)) return livePath?.line ?? null
    if (!liveStart || !liveCurrent) return null
    if (liveStart[0] === liveCurrent[0] && liveStart[1] === liveCurrent[1]) return null
    return { start: liveStart, current: liveCurrent }
  }, [config, livePath, liveStart, liveCurrent])

  /** Config for the live preview: the path-carrying config while a path is being drawn. */
  const livePreviewConfig = livePath?.config ?? null

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
      const nextConfig = opts?.config ?? config
      setDrawMode(true)
      draw.changeMode(DRAW_GRID_MODE_NAME, {
        config: nextConfig,
        start: opts?.start,
        vertices: isPathLayout(nextConfig) ? pathVerticesRef.current.slice() : undefined,
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
    setLiveVertices([])
    pathVerticesRef.current = []
    setRedrawingGridId(null)
    // Keep the toolbar in sync — exiting the grid draw mode must
    // de-highlight the create-grid button.
    setActiveTool((t) => (t === 'create-grid' ? 'pan' : t))
  }, [drawRef, setActiveTool, setRedrawingGridId])

  /** Path layout: drop the last clicked vertex (the editor's Backspace shortcut). */
  const undoPathVertex = useCallback(() => {
    drawRef.current?.trash()
  }, [drawRef])

  /**
   * Path layout: finish the path (the editor's Enter shortcut). The mode's
   * own Enter handler only hears keys while the map has focus — after
   * clicking Re-draw, focus is still in the panel — so this fires the same
   * `draw.create` the mode would and leaves the mode.
   */
  const finishPathDraw = useCallback(() => {
    const verts = pathVerticesRef.current
    if (!mapInstance || !isPathLayout(config) || verts.length < 2) return
    const line: Feature<LineString> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: verts },
    }
    mapInstance.fire('draw.create', { features: [line] })
    drawRef.current?.changeMode('simple_select')
  }, [mapInstance, config, drawRef])

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
  // The rack's elevation, read at move time (the listener isn't re-bound
  // on config edits): the cursor point is taken on the scene at that
  // height, matching where the draw mode puts the clicks.
  const elevationRef = useRef(config.elevation ?? 0)
  useEffect(() => {
    elevationRef.current = config.elevation ?? 0
  }, [config.elevation])
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
      pending = unprojectOnScene(map, e.point, elevationRef.current)
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
      // Path layout: the whole clicked path becomes the grid's box + a
      // normalised `config.path`; rotation is baked into the path.
      const pathGeo = isPathLayout(config) ? pathGridGeometry(coords, config) : null
      if (isPathLayout(config) && !pathGeo) return
      const start = pathGeo ? pathGeo.start : coords[0]
      const current = pathGeo ? pathGeo.current : coords[coords.length - 1]
      const saveConfig: GridConfig = pathGeo ? { ...config, layout: 'path', rotation: 0, path: pathGeo.path } : config
      const now = new Date()
      setLiveVertices([])
      pathVerticesRef.current = []
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
            ...(pathGeo ? { oldConfig: orig.config, newConfig: { ...orig.config, ...saveConfig } } : {}),
          })
          if (pathGeo) void updateGridShape(redrawingGridId, start, current, { ...orig.config, ...saveConfig })
          else void updateGridGeometry(redrawingGridId, start, current)
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
          config: saveConfig,
          // Like every other draw tool: the API stores a missing `visible` as false (hidden).
          visible: true,
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
        setLiveVertices([])
        pathVerticesRef.current = []
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
      setLiveVertices([])
      pathVerticesRef.current = []
    }
    const handlePathVertices = (e: { vertices: [number, number][] }) => {
      if (!Array.isArray(e?.vertices)) return
      pathVerticesRef.current = e.vertices
      setLiveVertices(e.vertices)
    }
    const onCreate = handleCreate as MapListener
    const onModeChange = handleModeChange as MapListener
    const onFirstClick = handleFirstClick as MapListener
    const onAnchorClear = handleAnchorClear as MapListener
    const onPathVertices = handlePathVertices as MapListener
    mapInstance.on('draw.create', onCreate)
    mapInstance.on('draw.modechange', onModeChange)
    mapInstance.on('draw.firstclick', onFirstClick)
    mapInstance.on('draw.anchorclear', onAnchorClear)
    mapInstance.on('draw.pathvertices', onPathVertices)
    return () => {
      mapInstance.off('draw.pathvertices', onPathVertices)
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
    livePreviewConfig,
    setHasAnchor,
    setDrawMode,
    setLiveStart,
    setLiveCurrent,
    enterDrawMode,
    exitDrawMode,
    undoPathVertex,
    finishPathDraw,
    handleToggleDrawMode,
    drawModeSourceRef,
  }
}
