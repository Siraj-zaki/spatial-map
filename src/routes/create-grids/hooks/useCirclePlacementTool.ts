import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import type { TFunction } from 'i18next'

import { apiDb } from '@/lib/api-db'
import { distanceMeters } from '@/lib/grid-generators'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type FillShapeConfig } from '@/lib/shapes'
import { type LengthUnit } from '@/lib/units'
import { queryCache } from '@/lib/useApiQuery'

/**
 * Circle placement tool. Two sub-flows depending on `circleSubMode`:
 *   - `single` — click-drag: mousedown center → drag radius →
 *     mouseup commits. `map.dragPan` is disabled during the drag so
 *     the basemap doesn't pan along with the radius preview.
 *   - `grid` — 2-click bbox, same shape as the regular grid tool. The
 *     geometry helper fills the bbox with regularly-spaced circles
 *     of `cellRadius` metres inside `cellSize`-metre cells.
 *
 * Also binds an Esc handler: cancels an in-flight draw if one is
 * live, otherwise exits the tool.
 */
export function useCirclePlacementTool({
  mapInstance,
  activeTool,
  circleSubMode,
  circleConfig,
  circleCellSize,
  circleCellRadius,
  circleDragStart,
  circleGridStart,
  configUnit,
  t,
  activeWarehouseIdRef,
  defaultFloorPlanIdRef,
  pinWarehouseCenterIfNeeded,
  setCircleDragStart,
  setCircleDragCursor,
  setCircleGridStart,
  setCircleGridCursor,
  setSelectedCircleIds,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  circleSubMode: 'single' | 'grid'
  circleConfig: FillShapeConfig
  circleCellSize: number
  circleCellRadius: number
  circleDragStart: [number, number] | null
  circleGridStart: [number, number] | null
  configUnit: LengthUnit
  t: TFunction
  activeWarehouseIdRef: MutableRefObject<number | null>
  defaultFloorPlanIdRef: MutableRefObject<number | null>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setCircleDragStart: Dispatch<SetStateAction<[number, number] | null>>
  setCircleDragCursor: Dispatch<SetStateAction<[number, number] | null>>
  setCircleGridStart: Dispatch<SetStateAction<[number, number] | null>>
  setCircleGridCursor: Dispatch<SetStateAction<[number, number] | null>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  // Mirror the latest draw start into refs so the mousedown/up handlers
  // don't capture stale state.
  const circleDragStartLatest = useRef<[number, number] | null>(null)
  useEffect(() => {
    circleDragStartLatest.current = circleDragStart
  }, [circleDragStart])
  const circleGridStartLatest = useRef<[number, number] | null>(null)
  useEffect(() => {
    circleGridStartLatest.current = circleGridStart
  }, [circleGridStart])

  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'create-circle') {
      // Reset draw state when the tool is deactivated.
      setCircleDragStart(null)
      setCircleDragCursor(null)
      setCircleGridStart(null)
      setCircleGridCursor(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    if (circleSubMode === 'single') {
      let dragging = false
      const onMouseDown = (e: MapMouseEvent) => {
        // Only act on primary button.
        if ((e.originalEvent as MouseEvent).button !== 0) return
        dragging = true
        e.preventDefault()
        map.dragPan.disable()
        setCircleDragStart([e.lngLat.lng, e.lngLat.lat])
        setCircleDragCursor([e.lngLat.lng, e.lngLat.lat])
      }
      // RAF-coalesce mousemove — Mapbox fires mousemove at pointer rate
      // (120–500 Hz on modern hardware) but we only need one update per
      // paint frame. Without this, every event triggers a React state
      // update → livePreview useMemo → buildCircleFeatures → setData.
      // Caps the cascade at 60 fps.
      let pendingLngLatSingle: [number, number] | null = null
      let moveRafSingle = 0
      const flushMoveSingle = () => {
        moveRafSingle = 0
        const c = pendingLngLatSingle
        pendingLngLatSingle = null
        if (!c) return
        setCircleDragCursor(c)
      }
      const onMouseMove = (e: MapMouseEvent) => {
        if (!dragging) return
        pendingLngLatSingle = [e.lngLat.lng, e.lngLat.lat]
        if (moveRafSingle === 0) moveRafSingle = requestAnimationFrame(flushMoveSingle)
      }
      const onMouseUp = (e: MapMouseEvent) => {
        if (!dragging) return
        dragging = false
        map.dragPan.enable()
        const start: [number, number] | null = circleDragStartLatest.current
        if (!start) {
          setCircleDragStart(null)
          setCircleDragCursor(null)
          return
        }
        const end: [number, number] = [e.lngLat.lng, e.lngLat.lat]
        const radius = distanceMeters(start, end)
        setCircleDragStart(null)
        setCircleDragCursor(null)
        if (radius < 0.5) return // too small — treat as accidental click
        const now = new Date()
        void (async () => {
          const wid = activeWarehouseIdRef.current
          const id = await apiDb.circles.add({
            name: t('circle.defaultNameSingle', { defaultValue: 'Circle' }),
            unit: configUnit,
            visible: true,
            zoneId: wid ?? undefined,
            floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
            mode: 'single',
            center: start,
            radius,
            rotation: 0,
            config: { ...circleConfig },
            createdAt: now,
            updatedAt: now,
          })
          queryCache.invalidate('circles')
          await pinWarehouseCenterIfNeeded(wid, start)
          setSelectedCircleIds(new Set([id as number]))
          setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
          setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
        })()
      }
      map.on('mousedown', onMouseDown)
      map.on('mousemove', onMouseMove)
      map.on('mouseup', onMouseUp)
      return () => {
        map.off('mousedown', onMouseDown)
        map.off('mousemove', onMouseMove)
        map.off('mouseup', onMouseUp)
        if (moveRafSingle !== 0) cancelAnimationFrame(moveRafSingle)
        pendingLngLatSingle = null
        map.dragPan.enable()
        map.getCanvas().style.cursor = ''
      }
    }

    // ---- grid sub-mode ---------------------------------------------------
    // RAF-coalesce grid mousemove too — same cascade as single mode.
    let pendingLngLatGrid: [number, number] | null = null
    let moveRafGrid = 0
    const flushMoveGrid = () => {
      moveRafGrid = 0
      const c = pendingLngLatGrid
      pendingLngLatGrid = null
      if (!c) return
      setCircleGridCursor(c)
    }
    const onMouseMove = (e: MapMouseEvent) => {
      pendingLngLatGrid = [e.lngLat.lng, e.lngLat.lat]
      if (moveRafGrid === 0) moveRafGrid = requestAnimationFrame(flushMoveGrid)
    }
    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      const point: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      const start = circleGridStartLatest.current
      if (!start) {
        // First click — anchor.
        setCircleGridStart(point)
        setCircleGridCursor(point)
        return
      }
      // Second click — commit the bbox.
      const now = new Date()
      const commitStart: [number, number] = start
      const commitEnd: [number, number] = point
      setCircleGridStart(null)
      setCircleGridCursor(null)
      // Skip degenerate clicks (same point twice).
      if (
        Math.abs(commitStart[0] - commitEnd[0]) < 1e-9 &&
        Math.abs(commitStart[1] - commitEnd[1]) < 1e-9
      ) {
        return
      }
      void (async () => {
        const wid = activeWarehouseIdRef.current
        const id = await apiDb.circles.add({
          name: t('circle.defaultNameGrid', { defaultValue: 'Circle grid' }),
          unit: configUnit,
          visible: true,
          zoneId: wid ?? undefined,
          floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
          mode: 'grid',
          start: commitStart,
          current: commitEnd,
          cellSize: circleCellSize,
          cellRadius: circleCellRadius,
          rotation: 0,
          config: { ...circleConfig },
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('circles')
        await pinWarehouseCenterIfNeeded(wid, commitStart)
        setSelectedCircleIds(new Set([id as number]))
        setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      })()
    }
    map.on('mousemove', onMouseMove)
    map.on('click', onClick)
    return () => {
      map.off('mousemove', onMouseMove)
      map.off('click', onClick)
      if (moveRafGrid !== 0) cancelAnimationFrame(moveRafGrid)
      pendingLngLatGrid = null
      map.getCanvas().style.cursor = ''
    }
  }, [
    mapInstance,
    activeTool,
    circleSubMode,
    circleConfig,
    circleCellSize,
    circleCellRadius,
    configUnit,
    t,
    pinWarehouseCenterIfNeeded,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    setCircleDragStart,
    setCircleDragCursor,
    setCircleGridStart,
    setCircleGridCursor,
    setSelectedCircleIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
  ])

  // Esc cancels any in-progress circle draw or exits the tool entirely.
  useEffect(() => {
    if (activeTool !== 'create-circle') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (circleDragStart || circleGridStart) {
        // Cancel an in-flight draw without leaving the tool.
        setCircleDragStart(null)
        setCircleDragCursor(null)
        setCircleGridStart(null)
        setCircleGridCursor(null)
      } else {
        setActiveTool('pan')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    activeTool,
    circleDragStart,
    circleGridStart,
    setCircleDragStart,
    setCircleDragCursor,
    setCircleGridStart,
    setCircleGridCursor,
    setActiveTool,
  ])
}
