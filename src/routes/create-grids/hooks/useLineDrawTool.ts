import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import type { TFunction } from 'i18next'

import { apiDb } from '@/lib/api-db'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { resolveLineSnap, type LineSnap } from '@/lib/line-snap'
import { type LineShapeConfig, type ImageShape, type LineShape } from '@/lib/shapes'
import { type LengthUnit } from '@/lib/units'
import { queryCache } from '@/lib/useApiQuery'

import { unprojectAtAltitude } from './unproject-at-altitude'

/**
 * Line/wall draw tool. Click N times to add vertices, double-click
 * / Enter to commit (min 2 vertices). Backspace removes the last;
 * Esc cancels an in-flight chain then exits the tool.
 *
 * Snap-aware: every mousemove runs `resolveLineSnap` against the
 * current chain, every saved wall's endpoints, and the
 * floor-plan-relative cardinal axes. The overlay reads the snap
 * object to swap chain colour + render the green ring / axis guide.
 * The committed vertex is always the RAW cursor — the snap engine is
 * a visual hint, not a position lock — which lets users draw at any
 * angle without a modifier key. This matches the "free-hand always"
 * decision documented in ARCHITECTURE.md.
 *
 * `savedLines` + `defaultFloorPlanId` / `savedImagesRawAll` are
 * mirrored into refs internally so the draw effect doesn't tear down
 * its map handlers on every store update.
 */
export function useLineDrawTool({
  mapInstance,
  activeTool,
  lineConfig,
  configUnit,
  t,
  savedLines,
  defaultFloorPlanId,
  savedImagesRawAll,
  activeWarehouseIdRef,
  defaultFloorPlanIdRef,
  lineVerticesRef,
  pinWarehouseCenterIfNeeded,
  setLineDraftVertices,
  setLineDraftCursor,
  setLineDraftSnap,
  setSelectedLineIds,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  lineConfig: LineShapeConfig
  configUnit: LengthUnit
  t: TFunction
  savedLines: LineShape[]
  defaultFloorPlanId: number | null
  savedImagesRawAll: ImageShape[] | undefined
  activeWarehouseIdRef: MutableRefObject<number | null>
  defaultFloorPlanIdRef: MutableRefObject<number | null>
  lineVerticesRef: MutableRefObject<[number, number][]>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setLineDraftVertices: Dispatch<SetStateAction<[number, number][]>>
  setLineDraftCursor: Dispatch<SetStateAction<[number, number] | null>>
  setLineDraftSnap: Dispatch<SetStateAction<LineSnap | null>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  // Mirror `savedLines` into a ref so the draw effect doesn't tear
  // down `map.on('click', ...)` bindings on every store update
  // (which would break drag-select mid-draw).
  const savedLinesRef = useRef<LineShape[]>(savedLines)
  useEffect(() => {
    savedLinesRef.current = savedLines
  }, [savedLines])

  // Mirror the active floor plan's rotation so the snap engine can
  // report axis-aligned vertices relative to the plan the user is
  // drawing on, not to world north.
  const activeFloorPlanRotationRef = useRef<number>(0)
  useEffect(() => {
    if (defaultFloorPlanId === null) {
      activeFloorPlanRotationRef.current = 0
      return
    }
    const img = savedImagesRawAll?.find((x) => x.id === defaultFloorPlanId)
    activeFloorPlanRotationRef.current = img?.rotation ?? 0
  }, [defaultFloorPlanId, savedImagesRawAll])

  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'create-line') {
      setLineDraftVertices([])
      setLineDraftCursor(null)
      setLineDraftSnap(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    const commit = (vertices: [number, number][]) => {
      if (vertices.length < 2) return
      const now = new Date()
      void (async () => {
        const wid = activeWarehouseIdRef.current
        const id = await apiDb.lines.add({
          name: t('line.defaultName', { defaultValue: 'Line' }),
          unit: configUnit,
          visible: true,
          zoneId: wid ?? undefined,
          floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
          vertices,
          rotation: 0,
          config: { ...lineConfig },
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('lines')
        await pinWarehouseCenterIfNeeded(wid, vertices[0])
        setSelectedLineIds(new Set([id as number]))
        setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      })()
      setLineDraftVertices([])
      setLineDraftCursor(null)
      setLineDraftSnap(null)
    }

    const computeSnap = (rawHit: [number, number]) =>
      resolveLineSnap({
        map,
        cursor: rawHit,
        chainVertices: lineVerticesRef.current,
        savedLines: savedLinesRef.current,
        floorPlanRotationDeg: activeFloorPlanRotationRef.current,
      })

    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      // Cast the click against the tool's `elevation` plane — see the
      // matching comment in the polygon draw handler. The committed
      // vertex is always the raw cursor: the snap engine paints green
      // as a visual hint but never overrides where the vertex lands.
      // This keeps hand-drawn walls truly free-hand at every angle.
      const hit = unprojectAtAltitude(map, e.point, lineConfig.elevation ?? 0)
      const rawHit: [number, number] = [hit.lng, hit.lat]
      setLineDraftVertices((prev) => [...prev, rawHit])
      // Refresh the snap state against the NEW chain (so the guide
      // recomputes from the just-placed vertex on the next paint,
      // before the mouse actually moves).
      setLineDraftSnap(null)
    }
    const onDblClick = (e: MapMouseEvent) => {
      e.preventDefault?.()
      commit(lineVerticesRef.current)
    }
    // RAF-coalesce mousemove — Mapbox fires mousemove at pointer rate
    // (120–500 Hz on modern hardware) but we only need one update per
    // paint frame. Without this, every event triggers a React state
    // update → `previewWallData` useMemo re-runs → `buildLineWallFeature`
    // runs `turf.buffer` per event → dropped frames on any wall with
    // vertical span. With coalescing, we cap the work at 60 fps.
    let pendingMove: MapMouseEvent | null = null
    let moveRafId = 0
    const flushMouseMove = () => {
      moveRafId = 0
      const e = pendingMove
      pendingMove = null
      if (!e) return
      const hit = unprojectAtAltitude(map, e.point, lineConfig.elevation ?? 0)
      const rawHit: [number, number] = [hit.lng, hit.lat]
      const snap = computeSnap(rawHit)
      // Free-hand semantics: the chain / trailing vertex ALWAYS follow
      // the raw cursor so users can draw at any angle. The snap kind
      // is preserved so the overlay still shows the "you're near an
      // axis" or "you're near an endpoint" visuals (green chain paint,
      // dashed axis ray, endpoint ring) — but the position never
      // locks. Users learn the geometry hint without being forced
      // onto it.
      setLineDraftCursor(rawHit)
      setLineDraftSnap({ ...snap, position: rawHit })
    }
    const onMouseMove = (e: MapMouseEvent) => {
      pendingMove = e
      if (moveRafId === 0) moveRafId = requestAnimationFrame(flushMouseMove)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        setLineDraftVertices((prev) => prev.slice(0, -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        commit(lineVerticesRef.current)
      } else if (e.key === 'Escape') {
        if (lineVerticesRef.current.length > 0) {
          setLineDraftVertices([])
          setLineDraftCursor(null)
          setLineDraftSnap(null)
        } else {
          setActiveTool('pan')
        }
      }
    }

    map.on('click', onClick)
    map.on('dblclick', onDblClick)
    map.on('mousemove', onMouseMove)
    map.doubleClickZoom.disable()
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      map.off('dblclick', onDblClick)
      map.off('mousemove', onMouseMove)
      map.doubleClickZoom.enable()
      window.removeEventListener('keydown', onKey)
      if (moveRafId !== 0) cancelAnimationFrame(moveRafId)
      pendingMove = null
      map.getCanvas().style.cursor = ''
    }
  }, [
    mapInstance,
    activeTool,
    lineConfig,
    configUnit,
    t,
    pinWarehouseCenterIfNeeded,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    lineVerticesRef,
    setLineDraftVertices,
    setLineDraftCursor,
    setLineDraftSnap,
    setSelectedLineIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setActiveTool,
  ])
}
