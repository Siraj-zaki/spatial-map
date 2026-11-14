import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import type { TFunction } from 'i18next'

import { apiDb } from '@/lib/api-db'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { resolveRouteSnap, type RouteSnap } from '@/lib/route-snap'
import { type RouteShape, type RouteShapeConfig } from '@/lib/shapes'
import { type LengthUnit } from '@/lib/units'
import { queryCache } from '@/lib/useApiQuery'

import { unprojectOnScene } from '@/lib/unproject-at-altitude'

/**
 * Route (wayfinding path) draw tool. Click N times to add waypoints,
 * double-click / Enter commits (min 2 vertices); Backspace removes
 * the last; Esc cancels the chain then exits the tool. Intentionally
 * simpler than the line tool: no axis snap since paths are naturally
 * curvy — matches the "free-hand always" guidance.
 *
 * The snap engine here reports junction hits against every visible
 * saved route's vertex catalog + this chain's own start. On a snap
 * hit the committed waypoint lands on the EXACT coordinate of the
 * target so coincident vertices across two routes create a shared
 * graph node the future pathfinding solver will treat as a junction.
 */
export function useRouteDrawTool({
  mapInstance,
  activeTool,
  routeConfig,
  configUnit,
  t,
  savedRoutes,
  activeWarehouseIdRef,
  defaultFloorPlanIdRef,
  routeVerticesRef,
  pinWarehouseCenterIfNeeded,
  setRouteDraftVertices,
  setRouteDraftCursor,
  setRouteDraftSnap,
  setSelectedRouteIds,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  routeConfig: RouteShapeConfig
  configUnit: LengthUnit
  t: TFunction
  savedRoutes: RouteShape[]
  activeWarehouseIdRef: MutableRefObject<number | null>
  defaultFloorPlanIdRef: MutableRefObject<number | null>
  routeVerticesRef: MutableRefObject<[number, number][]>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setRouteDraftVertices: Dispatch<SetStateAction<[number, number][]>>
  setRouteDraftCursor: Dispatch<SetStateAction<[number, number] | null>>
  setRouteDraftSnap: Dispatch<SetStateAction<RouteSnap | null>>
  setSelectedRouteIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  // Mirror `savedRoutes` into a ref so the draw effect doesn't tear
  // down + re-bind its `map.on('click', ...)` handlers on every store
  // update. Same pattern used by the line-draw hook for `savedLines`.
  const savedRoutesRef = useRef<RouteShape[]>(savedRoutes)
  useEffect(() => {
    savedRoutesRef.current = savedRoutes
  }, [savedRoutes])

  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'create-route') {
      setRouteDraftVertices([])
      setRouteDraftCursor(null)
      setRouteDraftSnap(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    const commit = (vertices: [number, number][]) => {
      if (vertices.length < 2) return
      const now = new Date()
      void (async () => {
        const wid = activeWarehouseIdRef.current
        const id = await apiDb.routes.add({
          name: t('route.defaultName', { defaultValue: 'Route' }),
          unit: configUnit,
          visible: true,
          zoneId: wid ?? undefined,
          floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
          vertices,
          rotation: 0,
          config: { ...routeConfig },
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('routes')
        await pinWarehouseCenterIfNeeded(wid, vertices[0])
        setSelectedRouteIds(new Set([id as number]))
        setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      })()
      setRouteDraftVertices([])
      setRouteDraftCursor(null)
      setRouteDraftSnap(null)
    }

    // Compute the current snap decision against every visible saved
    // route's vertex catalog + this chain's own start. Reused by
    // mousemove (for preview) and click (for the committed vertex).
    const computeSnap = (rawHit: [number, number]) =>
      resolveRouteSnap({
        map,
        cursor: rawHit,
        chainVertices: routeVerticesRef.current,
        savedRoutes: savedRoutesRef.current,
      })

    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      // Cast against the tool's elevation plane so the vertex lands at
      // the same altitude the preview sits at — same trick the polygon
      // + line placement handlers use.
      const hit = unprojectOnScene(map, e.point, routeConfig.elevation ?? 0)
      const rawHit: [number, number] = [hit.lng, hit.lat]
      // When the snap engine reports a hit, the committed vertex lands
      // on the EXACT coordinate of the snap target. Coincident vertices
      // across two routes create a shared graph node — the pathfinding
      // solver later reads coordinate equality to build the traversable
      // graph, so this exact match is what makes junctions work.
      const snap = computeSnap(rawHit)
      const committed: [number, number] =
        snap.kind === 'none' ? rawHit : snap.position
      setRouteDraftVertices((prev) => [...prev, committed])
      // Refresh snap against the new chain on the next paint (the
      // chain-relative close-loop test depends on which vertex was
      // just placed).
      setRouteDraftSnap(null)
    }
    const onDblClick = (e: MapMouseEvent) => {
      e.preventDefault?.()
      commit(routeVerticesRef.current)
    }
    // RAF-coalesce mousemove — Mapbox fires mousemove at pointer rate
    // (120–500 Hz on modern hardware) but we only need one update per
    // paint frame. Without this, every event triggers a React state
    // update → route overlay's featureCollections useMemo re-runs →
    // setData on 4 sources. Caps the cascade at 60 fps.
    let pendingMove: MapMouseEvent | null = null
    let moveRafId = 0
    const flushMouseMove = () => {
      moveRafId = 0
      const e = pendingMove
      pendingMove = null
      if (!e) return
      const hit = unprojectOnScene(map, e.point, routeConfig.elevation ?? 0)
      const rawHit: [number, number] = [hit.lng, hit.lat]
      const snap = computeSnap(rawHit)
      // Preview cursor tracks the raw pointer; the snap object carries
      // the target vertex for the overlay ring, and its `position`
      // drives the trailing chain edge / vertex so the user sees the
      // dot "lock" onto the target the moment they get close.
      setRouteDraftCursor(rawHit)
      setRouteDraftSnap(snap)
    }
    const onMouseMove = (e: MapMouseEvent) => {
      pendingMove = e
      if (moveRafId === 0) moveRafId = requestAnimationFrame(flushMouseMove)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        setRouteDraftVertices((prev) => prev.slice(0, -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        commit(routeVerticesRef.current)
      } else if (e.key === 'Escape') {
        if (routeVerticesRef.current.length > 0) {
          setRouteDraftVertices([])
          setRouteDraftCursor(null)
          setRouteDraftSnap(null)
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
    routeConfig,
    configUnit,
    t,
    pinWarehouseCenterIfNeeded,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    routeVerticesRef,
    setRouteDraftVertices,
    setRouteDraftCursor,
    setRouteDraftSnap,
    setSelectedRouteIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setActiveTool,
  ])
}
