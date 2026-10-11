import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import type { TFunction } from 'i18next'

import { apiDb } from '@/lib/api-db'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type FillShapeConfig } from '@/lib/shapes'
import { type LengthUnit } from '@/lib/units'
import { queryCache } from '@/lib/useApiQuery'

import { unprojectAtAltitude } from './unproject-at-altitude'

/**
 * Polygon draw tool. Click N times to add vertices, double-click (or
 * press Enter) to close — minimum 3 vertices. Backspace removes the
 * last vertex. Esc cancels an in-flight chain; Esc again exits the
 * tool. Ray-casts clicks against the tool's configured elevation
 * plane so vertices land on the raster the user is pointing at, not
 * on the ground under it.
 */
export function usePolygonDrawTool({
  mapInstance,
  activeTool,
  polygonConfig,
  configUnit,
  t,
  activeWarehouseIdRef,
  defaultFloorPlanIdRef,
  polygonVerticesRef,
  pinWarehouseCenterIfNeeded,
  setPolygonDraftVertices,
  setPolygonDraftCursor,
  setSelectedPolygonIds,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  polygonConfig: FillShapeConfig
  configUnit: LengthUnit
  t: TFunction
  activeWarehouseIdRef: MutableRefObject<number | null>
  defaultFloorPlanIdRef: MutableRefObject<number | null>
  polygonVerticesRef: MutableRefObject<[number, number][]>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setPolygonDraftVertices: Dispatch<SetStateAction<[number, number][]>>
  setPolygonDraftCursor: Dispatch<SetStateAction<[number, number] | null>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'create-polygon') {
      setPolygonDraftVertices([])
      setPolygonDraftCursor(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    const commit = (vertices: [number, number][]) => {
      if (vertices.length < 3) return
      const now = new Date()
      void (async () => {
        const wid = activeWarehouseIdRef.current
        const id = await apiDb.polygons.add({
          name: t('polygon.defaultName', { defaultValue: 'Polygon' }),
          unit: configUnit,
          visible: true,
          zoneId: wid ?? undefined,
          floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
          vertices,
          rotation: 0,
          config: { ...polygonConfig },
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('polygons')
        await pinWarehouseCenterIfNeeded(wid, vertices[0])
        setSelectedPolygonIds(new Set([id as number]))
        setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      })()
      setPolygonDraftVertices([])
      setPolygonDraftCursor(null)
    }

    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      // Ray-cast against the tool's configured elevation plane so a
      // click on top of an elevated floor plan lands on the raster,
      // not on the ground under it. Without this, the vertex we store
      // is the ground point (`e.lngLat`), but the vertex dot we
      // render is lifted to `elevation` — the parallax at pitch means
      // the dot visibly drifts away from the cursor.
      const hit = unprojectAtAltitude(map, e.point, polygonConfig.elevation ?? 0)
      setPolygonDraftVertices((prev) => [
        ...prev,
        [hit.lng, hit.lat] as [number, number],
      ])
    }
    const onDblClick = (e: MapMouseEvent) => {
      // Mapbox fires `dblclick` AFTER the two underlying `click` events,
      // so by the time we get here `polygonDraftVertices` already has
      // both clicks recorded — we just need to commit. We use the ref
      // to read the latest vertex list (state closure would be stale).
      e.preventDefault?.()
      const verts = polygonVerticesRef.current
      commit(verts)
    }
    // RAF-coalesce mousemove — Mapbox fires mousemove at pointer rate
    // (120–500 Hz on modern hardware) but we only need one update per
    // paint frame. Without this, every event triggers a React state
    // update → chain data useMemo re-runs → setData on CHAIN_SOURCE.
    // Caps the cascade at 60 fps.
    let pendingHit: [number, number] | null = null
    let moveRafId = 0
    const flushMove = () => {
      moveRafId = 0
      const hit = pendingHit
      pendingHit = null
      if (!hit) return
      setPolygonDraftCursor(hit)
    }
    const onMouseMove = (e: MapMouseEvent) => {
      const hit = unprojectAtAltitude(map, e.point, polygonConfig.elevation ?? 0)
      pendingHit = [hit.lng, hit.lat]
      if (moveRafId === 0) moveRafId = requestAnimationFrame(flushMove)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        setPolygonDraftVertices((prev) => prev.slice(0, -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        commit(polygonVerticesRef.current)
      } else if (e.key === 'Escape') {
        if (polygonVerticesRef.current.length > 0) {
          setPolygonDraftVertices([])
          setPolygonDraftCursor(null)
        } else {
          setActiveTool('pan')
        }
      }
    }

    map.on('click', onClick)
    map.on('dblclick', onDblClick)
    map.on('mousemove', onMouseMove)
    // Mapbox interprets dblclick as a zoom gesture by default — disable
    // while the polygon tool is active so commit isn't followed by a zoom.
    map.doubleClickZoom.disable()
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      map.off('dblclick', onDblClick)
      map.off('mousemove', onMouseMove)
      map.doubleClickZoom.enable()
      window.removeEventListener('keydown', onKey)
      if (moveRafId !== 0) cancelAnimationFrame(moveRafId)
      pendingHit = null
      map.getCanvas().style.cursor = ''
    }
  }, [
    mapInstance,
    activeTool,
    polygonConfig,
    configUnit,
    t,
    pinWarehouseCenterIfNeeded,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    polygonVerticesRef,
    setPolygonDraftVertices,
    setPolygonDraftCursor,
    setSelectedPolygonIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setActiveTool,
  ])
}
