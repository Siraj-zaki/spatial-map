import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import type { TFunction } from 'i18next'

import { apiDb } from '@/lib/api-db'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type StairShapeConfig } from '@/lib/shapes'
import { type LengthUnit } from '@/lib/units'

import { unprojectAtAltitude } from './unproject-at-altitude'

/**
 * Stair placement tool ("Stairs & lifts"). Click flow depends on
 * `stairConfig.stairType`:
 *   - `straight` / `u`: 2 clicks (bottom, top). U-shape auto-mirrors
 *     flight 2 so still just 2 anchors.
 *   - `l`: 3 clicks (bottom, corner, top).
 *   - `escalator`: 2 clicks (bottom landing, then towards the top).
 *   - `elevator`: 2 clicks along the door side (left, then right corner).
 *
 * Clicks are ray-cast at the tool's base elevation, so anchors drawn
 * over a raised floor plan land under the cursor rather than on the
 * ground beneath it.
 *
 * After the final click the geometry commits, the camera flies to the
 * anchor centroid at pitch 45, and the tool exits to `select` so the
 * user can immediately tweak the new stair's config.
 *
 * `stairDraftAnchorsRef` mirrors the anchor list so:
 *   - the click handler reads the freshest count on every fire
 *     (StrictMode dev double-invocation of functional updaters was
 *     creating TWO stairs per click; a plain ref avoids that);
 *   - the Esc keydown handler knows whether a chain is in-flight.
 */
export function useStairPlacementTool({
  mapInstance,
  activeTool,
  stairConfig,
  stairDraftAnchors,
  configUnit,
  t,
  activeWarehouseIdRef,
  defaultFloorPlanIdRef,
  pinWarehouseCenterIfNeeded,
  setStairDraftAnchors,
  setStairDraftCursor,
  setSelectedStairIds,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  stairConfig: StairShapeConfig
  stairDraftAnchors: [number, number][]
  configUnit: LengthUnit
  t: TFunction
  activeWarehouseIdRef: MutableRefObject<number | null>
  defaultFloorPlanIdRef: MutableRefObject<number | null>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setStairDraftAnchors: Dispatch<SetStateAction<[number, number][]>>
  setStairDraftCursor: Dispatch<SetStateAction<[number, number] | null>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  // Mirror anchors into a ref so both the click and keydown handlers
  // read the latest count without the effect having to re-bind on
  // every anchor placement (which would drop clicks mid-chain).
  const stairDraftAnchorsRef = useRef<[number, number][]>([])
  useEffect(() => {
    stairDraftAnchorsRef.current = stairDraftAnchors
  }, [stairDraftAnchors])

  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'create-stair') {
      setStairDraftAnchors([])
      setStairDraftCursor(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'
    // Number of anchors the user must place before the stair commits.
    const targetAnchors = stairConfig.stairType === 'l' ? 3 : 2

    const onClick = (e: MapMouseEvent) => {
      if (e.originalEvent?.defaultPrevented) return
      const hit = unprojectAtAltitude(map, e.point, stairConfig.baseElevation ?? 0)
      const lngLat: [number, number] = [hit.lng, hit.lat]
      // Read the freshest anchor list from the ref so we don't depend
      // on a stale closure. We must NOT do the async commit inside the
      // setStairDraftAnchors functional updater — React (especially in
      // Strict Mode) is permitted to invoke functional updaters more
      // than once for the same call, and putting the apiDb POST in
      // there caused every click to create TWO stairs.
      const next: [number, number][] = [...stairDraftAnchorsRef.current, lngLat]
      if (next.length < targetAnchors) {
        // Update ref synchronously too so the next click in the same
        // event-loop tick already sees the new length.
        stairDraftAnchorsRef.current = next
        setStairDraftAnchors(next)
        setStairDraftCursor(lngLat)
        return
      }
      // Final click — clear the draft and fire the commit exactly once.
      const finalAnchors = next
      stairDraftAnchorsRef.current = []
      setStairDraftAnchors([])
      setStairDraftCursor(null)
      void (async () => {
        const wid = activeWarehouseIdRef.current
        const now = new Date()
        const id = await apiDb.stairs.add({
          name:
            stairConfig.stairType === 'escalator'
              ? t('stair.defaultNameEscalator', { defaultValue: 'Escalator' })
              : stairConfig.stairType === 'elevator'
                ? t('stair.defaultNameElevator', { defaultValue: 'Elevator' })
                : t('stair.defaultName', { defaultValue: 'Stairs' }),
          unit: configUnit,
          visible: true,
          zoneId: wid ?? undefined,
          floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
          vertices: finalAnchors,
          rotation: 0,
          config: { ...stairConfig },
          createdAt: now,
          updatedAt: now,
        })
        await pinWarehouseCenterIfNeeded(wid, finalAnchors[0])
        setSelectedStairIds(new Set([id as number]))
        setSelectedGridIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedMarkerIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedCircleIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedPolygonIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedLineIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedImageIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedModelIds((p) => (p.size > 0 ? new Set() : p))
        // Camera fit — average all anchors so L/U mid-points land in
        // the centre of the new stair rather than the bottom.
        const cLng =
          finalAnchors.reduce((s, v) => s + v[0], 0) / finalAnchors.length
        const cLat =
          finalAnchors.reduce((s, v) => s + v[1], 0) / finalAnchors.length
        map.flyTo({
          center: [cLng, cLat],
          zoom: Math.max(map.getZoom(), 19),
          pitch: Math.max(map.getPitch(), 45),
          duration: 600,
        })
        setActiveTool('select')
      })()
    }
    // RAF-coalesce mousemove — the overlay's `previewFC` useMemo
    // rebuilds the entire staircase mesh (via `buildStairFeatures`)
    // on every cursor change, then setData on PREVIEW_SOURCE. Capping
    // at 60 fps prevents redundant tessellation between paint frames.
    let pendingLngLat: [number, number] | null = null
    let moveRafId = 0
    const flushMove = () => {
      moveRafId = 0
      const c = pendingLngLat
      pendingLngLat = null
      if (!c) return
      // Only show the live preview after the first anchor is placed.
      setStairDraftCursor((cursor) => {
        if (cursor === null && stairDraftAnchorsRef.current.length === 0) return null
        return c
      })
    }
    const onMove = (e: MapMouseEvent) => {
      const hit = unprojectAtAltitude(map, e.point, stairConfig.baseElevation ?? 0)
      pendingLngLat = [hit.lng, hit.lat]
      if (moveRafId === 0) moveRafId = requestAnimationFrame(flushMove)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (stairDraftAnchorsRef.current.length > 0) {
          setStairDraftAnchors([])
          setStairDraftCursor(null)
        } else {
          setActiveTool('pan')
        }
      }
    }
    map.on('click', onClick)
    map.on('mousemove', onMove)
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      window.removeEventListener('keydown', onKey)
      if (moveRafId !== 0) cancelAnimationFrame(moveRafId)
      pendingLngLat = null
      map.getCanvas().style.cursor = ''
    }
  }, [
    mapInstance,
    activeTool,
    stairConfig,
    configUnit,
    t,
    pinWarehouseCenterIfNeeded,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    setStairDraftAnchors,
    setStairDraftCursor,
    setSelectedStairIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedImageIds,
    setSelectedModelIds,
    setActiveTool,
  ])
}
