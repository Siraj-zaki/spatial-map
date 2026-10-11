import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import type { TFunction } from 'i18next'

import { apiDb } from '@/lib/api-db'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type MarkerShapeConfig } from '@/lib/shapes'
import { type LengthUnit } from '@/lib/units'
import { queryCache } from '@/lib/useApiQuery'

/**
 * Marker placement tool. While `activeTool === 'create-marker'`, the
 * map shows a ghost icon at the cursor and a single click commits a
 * new marker to `apiDb.markers`. The user stays in placement mode
 * after a click so they can drop multiple markers in a row; switching
 * to any other tool (or pressing Esc) exits.
 *
 * Also binds an Esc handler that flips the tool back to `pan`.
 */
export function useMarkerPlacementTool({
  mapInstance,
  activeTool,
  markerConfig,
  configUnit,
  t,
  activeWarehouseIdRef,
  defaultFloorPlanIdRef,
  pinWarehouseCenterIfNeeded,
  setMarkerCursor,
  setSelectedMarkerIds,
  setSelectedGridIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  markerConfig: MarkerShapeConfig
  configUnit: LengthUnit
  t: TFunction
  activeWarehouseIdRef: MutableRefObject<number | null>
  defaultFloorPlanIdRef: MutableRefObject<number | null>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setMarkerCursor: Dispatch<SetStateAction<[number, number] | null>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'create-marker') {
      setMarkerCursor(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    const onMove = (e: MapMouseEvent) => {
      setMarkerCursor([e.lngLat.lng, e.lngLat.lat])
    }
    const onClick = (e: MapMouseEvent) => {
      // Don't double-fire if the click was on an existing marker — the
      // MapMarkerOverlay calls preventDefault() in that path.
      if (e.defaultPrevented) return
      const now = new Date()
      void (async () => {
        const wid = activeWarehouseIdRef.current
        const pos: [number, number] = [e.lngLat.lng, e.lngLat.lat]
        const id = await apiDb.markers.add({
          name: t('marker.defaultName', { defaultValue: 'Marker' }),
          unit: configUnit,
          visible: true,
          zoneId: wid ?? undefined,
          floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
          position: pos,
          bearing: 0,
          config: { ...markerConfig },
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('markers')
        await pinWarehouseCenterIfNeeded(wid, pos)
        // Highlight the newly placed marker so the user can immediately
        // tweak its config without losing context.
        setSelectedMarkerIds(new Set([id as number]))
        setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      })()
    }

    map.on('mousemove', onMove)
    map.on('click', onClick)
    return () => {
      map.off('mousemove', onMove)
      map.off('click', onClick)
      map.getCanvas().style.cursor = ''
      setMarkerCursor(null)
    }
  }, [
    mapInstance,
    activeTool,
    markerConfig,
    configUnit,
    t,
    pinWarehouseCenterIfNeeded,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    setMarkerCursor,
    setSelectedMarkerIds,
    setSelectedGridIds,
  ])

  // Esc exits marker placement mode (parallel to grid-draw Esc handling).
  useEffect(() => {
    if (activeTool !== 'create-marker') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveTool('pan')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTool, setActiveTool])
}
