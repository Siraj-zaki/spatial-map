import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import { unprojectOnScene } from '@/lib/unproject-at-altitude'
import type { TFunction } from 'i18next'
import { invalidateUploadLibrary } from '@/lib/upload-library'

import { apiDb } from '@/lib/api-db'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { useModelAssets } from '@/lib/model-assets'
import { type ModelShapeConfig } from '@/lib/shapes'
import { type LengthUnit } from '@/lib/units'
import { queryCache } from '@/lib/useApiQuery'

/**
 * Model (glTF/GLB) placement tool. Tool flow: clicking the "Add 3D
 * model" toolbar button opens the `ModelLibraryDialog`. The user picks
 * an asset → modal closes → cursor goes crosshair → the next map click
 * drops a `ModelShape` at that point. The user stays in placement mode
 * after a drop so they can place several copies in a row (same as the
 * marker tool). Esc exits.
 */
export function useModelPlacementTool({
  mapInstance,
  activeTool,
  modelConfig,
  configUnit,
  t,
  activeWarehouseIdRef,
  defaultFloorPlanIdRef,
  pinWarehouseCenterIfNeeded,
  setModelCursor,
  setModelLibraryOpen,
  setSelectedModelIds,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  modelConfig: ModelShapeConfig
  configUnit: LengthUnit
  t: TFunction
  activeWarehouseIdRef: MutableRefObject<number | null>
  defaultFloorPlanIdRef: MutableRefObject<number | null>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setModelCursor: Dispatch<SetStateAction<[number, number] | null>>
  setModelLibraryOpen: Dispatch<SetStateAction<boolean>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  const assets = useModelAssets()
  // Mirror the asset catalogue into a ref so the click handler below
  // reads the latest labels without forcing the whole draw effect to
  // rebind on every catalogue change (e.g. after a fresh upload).
  const assetsRef = useRef(assets)
  useEffect(() => {
    assetsRef.current = assets
  }, [assets])
  useEffect(() => {
    if (activeTool !== 'create-model') {
      setModelCursor(null)
      return
    }
    // Auto-open the library only when no asset is queued. Once the
    // user picks one, `modelConfig.modelAssetId` is set and the click
    // handler below takes over.
    if (!modelConfig.modelAssetId) {
      setModelLibraryOpen(true)
    }
    if (!mapInstance) return
    const map = mapInstance
    map.getCanvas().style.cursor = modelConfig.modelAssetId ? 'crosshair' : ''
    // Where the cursor touches the scene (at the model tool's elevation) —
    // not the ground under it, which is off by the floor's height at pitch.
    const at = (e: MapMouseEvent): [number, number] => {
      const p = unprojectOnScene(map, e.point, modelConfig.elevation ?? 0)
      return [p.lng, p.lat]
    }

    // RAF-coalesce mousemove — every cursor tick triggers a preview
    // model source update in the overlay (setSourceModel on
    // PREVIEW_SOURCE). Capping at 60 fps avoids redundant model-source
    // updates between paints.
    let pendingLngLat: [number, number] | null = null
    let moveRafId = 0
    const flushMove = () => {
      moveRafId = 0
      const c = pendingLngLat
      pendingLngLat = null
      if (!c) return
      setModelCursor(c)
    }
    const onMove = (e: MapMouseEvent) => {
      if (!modelConfig.modelAssetId) return
      pendingLngLat = at(e)
      if (moveRafId === 0) moveRafId = requestAnimationFrame(flushMove)
    }
    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      if (!modelConfig.modelAssetId) return
      const now = new Date()
      void (async () => {
        const wid = activeWarehouseIdRef.current
        const pos: [number, number] = at(e)
        // Derive a friendlier default name from the picked asset — so
        // placing three different models yields three distinguishable
        // rows in the sidebar instead of three identical "Model" rows.
        // Fall back to the generic label only when the asset can't be
        // resolved.
        const picked = modelConfig.modelAssetId
          ? assetsRef.current.find((a) => a.id === modelConfig.modelAssetId)
          : undefined
        const derivedName =
          picked?.label ?? t('model.defaultName', { defaultValue: 'Model' })
        const id = await apiDb.models.add({
          name: derivedName,
          unit: configUnit,
          visible: true,
          zoneId: wid ?? undefined,
          floorPlanId: defaultFloorPlanIdRef.current ?? undefined,
          position: pos,
          config: { ...modelConfig },
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('models')
        invalidateUploadLibrary()
        await pinWarehouseCenterIfNeeded(wid, pos)
        setSelectedModelIds(new Set([id as number]))
        // Clear other selections so the side panel shows the new model.
        setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      })()
    }

    map.on('mousemove', onMove)
    map.on('click', onClick)
    return () => {
      map.off('mousemove', onMove)
      map.off('click', onClick)
      if (moveRafId !== 0) cancelAnimationFrame(moveRafId)
      pendingLngLat = null
      map.getCanvas().style.cursor = ''
      setModelCursor(null)
    }
  }, [
    mapInstance,
    activeTool,
    modelConfig,
    configUnit,
    t,
    pinWarehouseCenterIfNeeded,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    setModelCursor,
    setModelLibraryOpen,
    setSelectedModelIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
  ])

  // Esc exits model placement mode.
  useEffect(() => {
    if (activeTool !== 'create-model') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveTool('pan')
        setModelLibraryOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTool, setActiveTool, setModelLibraryOpen])
}
