import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { apiDb } from '@/lib/api-db'
import { gridHistory } from '@/lib/grid-history'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type MarkerShape, type MarkerShapeConfig } from '@/lib/shapes'
import { patchSpatialEntity, saveSpatialEntity } from '@/lib/spatial-store'
import { queryCache } from '@/lib/useApiQuery'

import type { MarkerTransform } from '../state/useMarkerEditorState'
import { fitBoundsIfOffscreen } from './fitToShapeOnSelect'
import { copyName } from '@/lib/copy-name'

type SelectedBin =
  | { gridId: number; row: number; col: number; level: number }
  | null

/**
 * All marker CRUD + selection handlers. Grouped into one hook so
 * `sidePanelActions` in the route file can spread the returned object
 * instead of listing every handler individually.
 *
 * Sibling-clear pattern: `handleSelectMarker` / `handleMarkerClick`
 * both clear every other kind's selection because only one shape
 * kind can be the active editing target at a time. The route
 * threads all seven sibling setters through so the hook stays
 * self-contained.
 */
export function useMarkerHandlers({
  mapInstance,
  savedMarkers,
  selectedMarker,
  markerTransform,
  setSelectedMarkerIds,
  setMarkerTransform,
  setMarkerConfig,
  setSelectedBin,
  setSelectedGridIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedStairIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  savedMarkers: MarkerShape[]
  selectedMarker: MarkerShape | null
  markerTransform: MarkerTransform
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setMarkerTransform: Dispatch<SetStateAction<MarkerTransform>>
  setMarkerConfig: Dispatch<SetStateAction<MarkerShapeConfig>>
  setSelectedBin: Dispatch<SetStateAction<SelectedBin>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  const handleMarkerClick = useCallback(
    (id: number, e: MouseEvent) => {
      // If the user is placing markers, treat a click on an existing
      // marker as a re-select (the placement code would otherwise create
      // a new one slightly offset). Clearing selectedGridIds + setting
      // selectedMarkerIds is enough — the place-mode click handler bails
      // when a marker hit fired first (defaultPrevented in the overlay).
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      // Selecting any non-grid shape implicitly closes the bin editor —
      // a bin only ever belongs to a grid cell, so showing it next to
      // a marker / circle / polygon / line / image selection is wrong.
      setSelectedBin(null)
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        setSelectedMarkerIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      } else {
        setSelectedMarkerIds(new Set([id]))
      }
    },
    [
      setSelectedGridIds,
      setSelectedCircleIds,
      setSelectedPolygonIds,
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedBin,
      setSelectedMarkerIds,
    ],
  )

  const handleSelectMarker = useCallback(
    (id: number, additive: boolean) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => {
        if (additive) {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      const m = savedMarkers.find((x) => x.id === id)
      if (m && m.position) {
        fitBoundsIfOffscreen(
          mapInstance,
          [m.position[0], m.position[1], m.position[0], m.position[1]],
          { additive },
        )
      }
    },
    [
      setSelectedGridIds,
      setSelectedCircleIds,
      setSelectedPolygonIds,
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedMarkerIds,
      mapInstance,
      savedMarkers,
    ],
  )

  const handleFitToMarkerById = useCallback(
    (id: number) => {
      const m = savedMarkers.find((x) => x.id === id)
      if (!m || !mapInstance) return
      mapInstance.flyTo({
        center: m.position,
        zoom: Math.max(mapInstance.getZoom(), 16),
        essential: true,
      })
    },
    [mapInstance, savedMarkers],
  )

  const handleDeleteMarkerById = useCallback(
    (id: number) => {
      setSelectedMarkerIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      void (async () => {
        const row = await apiDb.markers.get(id)
        if (row) gridHistory.push({ type: 'delete-marker', markers: [row] })
        await apiDb.markers.delete(id)
        queryCache.invalidate('markers')
      })()
    },
    [setSelectedMarkerIds],
  )

  const handleDuplicateMarker = useCallback(
    (id: number) => {
      const original = savedMarkers.find((m) => m.id === id)
      if (!original) return
      const now = new Date()
      // Offset the copy slightly so it's not stacked exactly on top.
      const lngOffset = 0.00005
      const latOffset = 0.00005
      void (async () => {
        const newId = await apiDb.markers.add({
          name: copyName('markers', original.name),
          unit: original.unit,
          visible: true,
          position: [
            original.position[0] + lngOffset,
            original.position[1] + latOffset,
          ],
          bearing: original.bearing,
          zoneId: original.zoneId,
          config: { ...original.config },
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('markers')
        setSelectedMarkerIds(new Set([newId as number]))
      })()
    },
    [savedMarkers, setSelectedMarkerIds],
  )

  const handleExitMarkerPlacement = useCallback(() => {
    setActiveTool('pan')
  }, [setActiveTool])

  const handleStartMoveMarker = useCallback(
    (id: number) => {
      setMarkerTransform({ markerId: id, kind: 'move' })
    },
    [setMarkerTransform],
  )

  const handleCancelMarkerTransform = useCallback(() => {
    setMarkerTransform(null)
  }, [setMarkerTransform])

  // Live patch for in-flight marker drag. Commits on dragend.
  const handleMarkerTransformChange = useCallback(
    (patch: { position?: [number, number] }, commit: boolean) => {
      if (!markerTransform) return
      if (!patch.position) return
      if (!commit) return
      // Persist on dragend only — the marker's own visual position
      // tracks the drag natively (Mapbox updates the DOM marker as it
      // drags), so we don't need a "draft" override layer like circles.
      const now = new Date()
      void patchSpatialEntity('markers', markerTransform.markerId, {
        position: patch.position,
        updatedAt: now,
      })
      setMarkerTransform(null)
    },
    [markerTransform, setMarkerTransform],
  )

  // Top-level marker patch (used for bearing, name, position via sidebar).
  const handleMarkerPatch = useCallback(
    (patch: Partial<MarkerShape>) => {
      if (!selectedMarker || selectedMarker.id === undefined) return
      void patchSpatialEntity('markers', selectedMarker.id, {
        ...patch,
        updatedAt: new Date(),
      })
    },
    [selectedMarker],
  )

  const handleRenameMarker = useCallback(
    async (id: number, name: string) => {
      await saveSpatialEntity('markers', id, { name, updatedAt: new Date() } as never)
    },
    [],
  )

  const handleAssignMarkerToZone = useCallback(
    async (markerId: number, zoneId: number | null) => {
      await saveSpatialEntity('markers', markerId, { zoneId } as never)
    },
    [],
  )

  // When the sidebar edits a marker config, route it: if a marker is
  // selected, write to that marker in IndexedDB; otherwise we're in
  // placement mode and we update the in-memory draft.
  const handleMarkerConfigChange = useCallback(
    (cfg: MarkerShapeConfig) => {
      if (selectedMarker && selectedMarker.id !== undefined) {
        const id = selectedMarker.id
        const now = new Date()
        void patchSpatialEntity('markers', id, { config: { ...cfg }, updatedAt: now })
      } else {
        setMarkerConfig(cfg)
      }
    },
    [selectedMarker, setMarkerConfig],
  )

  const handleToggleMarkerVisible = useCallback(
    async (id: number, visible: boolean) => {
      await saveSpatialEntity('markers', id, { visible, updatedAt: new Date() } as never)
    },
    [],
  )

  return {
    handleMarkerClick,
    handleSelectMarker,
    handleFitToMarkerById,
    handleDeleteMarkerById,
    handleDuplicateMarker,
    handleExitMarkerPlacement,
    handleStartMoveMarker,
    handleCancelMarkerTransform,
    handleMarkerTransformChange,
    handleMarkerPatch,
    handleRenameMarker,
    handleAssignMarkerToZone,
    handleMarkerConfigChange,
    handleToggleMarkerVisible,
  }
}
