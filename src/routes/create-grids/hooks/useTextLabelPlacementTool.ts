import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import type { TFunction } from 'i18next'

import { apiDb } from '@/lib/api-db'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type TextLabelConfig } from '@/lib/shapes'
import { type LengthUnit } from '@/lib/units'
import { queryCache } from '@/lib/useApiQuery'

/**
 * Text-label placement tool. While `activeTool === 'create-text'`, the
 * map shows a ghost label at the cursor and a single click commits a
 * new `TextLabelShape` to `apiDb.textLabels`. The user stays in
 * placement mode after a click so they can drop multiple labels in a
 * row; switching tools (or Esc) exits.
 */
export function useTextLabelPlacementTool({
  mapInstance,
  activeTool,
  textLabelConfig,
  configUnit,
  t,
  activeWarehouseIdRef,
  defaultFloorPlanIdRef,
  pinWarehouseCenterIfNeeded,
  setTextLabelCursor,
  setSelectedTextLabelIds,
  setSelectedGridIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  textLabelConfig: TextLabelConfig
  configUnit: LengthUnit
  t: TFunction
  activeWarehouseIdRef: MutableRefObject<number | null>
  defaultFloorPlanIdRef: MutableRefObject<number | null>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setTextLabelCursor: Dispatch<SetStateAction<[number, number] | null>>
  setSelectedTextLabelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'create-text') {
      setTextLabelCursor(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    const onMove = (e: MapMouseEvent) => {
      setTextLabelCursor([e.lngLat.lng, e.lngLat.lat])
    }
    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      const now = new Date()
      void (async () => {
        const wid = activeWarehouseIdRef.current
        const pos: [number, number] = [e.lngLat.lng, e.lngLat.lat]
        const id = await apiDb.textLabels.add({
          name: t('textLabel.defaultName', { defaultValue: 'Text' }),
          unit: configUnit,
          visible: true,
          zoneId: wid ?? undefined,
          floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
          position: pos,
          rotation: 0,
          config: { ...textLabelConfig },
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('textLabels')
        await pinWarehouseCenterIfNeeded(wid, pos)
        setSelectedTextLabelIds(new Set([id as number]))
        setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      })()
    }

    map.on('mousemove', onMove)
    map.on('click', onClick)
    return () => {
      map.off('mousemove', onMove)
      map.off('click', onClick)
      map.getCanvas().style.cursor = ''
      setTextLabelCursor(null)
    }
  }, [
    mapInstance,
    activeTool,
    textLabelConfig,
    configUnit,
    t,
    pinWarehouseCenterIfNeeded,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    setTextLabelCursor,
    setSelectedTextLabelIds,
    setSelectedGridIds,
  ])

  // Esc exits text-label placement.
  useEffect(() => {
    if (activeTool !== 'create-text') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveTool('pan')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTool, setActiveTool])
}
