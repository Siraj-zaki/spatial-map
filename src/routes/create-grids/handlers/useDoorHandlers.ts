import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import type { DoorConfig, DoorShape } from '@/lib/door/types'
import { gridHistory } from '@/lib/grid-history'
import { type Tool } from '@/lib/keyboard-shortcuts'

import type { DoorTransform } from '../state/useDoorEditorState'
import { fitBoundsIfOffscreen } from './fitToShapeOnSelect'

/**
 * All door CRUD + selection + transform handlers. Doors persist via
 * `useDoorStore` (not the spatial store) so edits are relayed through
 * the store's action functions rather than the generic
 * `patchSpatialEntity` used by every other shape kind.
 *
 * `handleDoorTransformChange` writes on EVERY tick — not just the
 * dragend commit — because the door store is in-memory and the cost
 * is one React re-render, not a debounced PATCH.
 */
export function useDoorHandlers({
  mapInstance,
  doors,
  selectedDoorForPanel,
  doorTransform,
  updateDoorConfigInStore,
  renameDoorInStore,
  setDoorVisibleInStore,
  updateDoorInStore,
  deleteDoorInStore,
  duplicateDoorInStore,
  setDoorPendingConfig,
  setSelectedDoorIds,
  setDoorTransform,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedStairIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  doors: DoorShape[]
  selectedDoorForPanel: DoorShape | null
  doorTransform: DoorTransform
  updateDoorConfigInStore: (id: number, config: DoorConfig) => void
  renameDoorInStore: (id: number, name: string) => void
  setDoorVisibleInStore: (id: number, visible: boolean) => void
  updateDoorInStore: (id: number, patch: Partial<DoorShape>) => void
  deleteDoorInStore: (id: number) => void
  duplicateDoorInStore: (id: number) => DoorShape | null
  setDoorPendingConfig: (config: DoorConfig) => void
  setSelectedDoorIds: Dispatch<SetStateAction<Set<number>>>
  setDoorTransform: Dispatch<SetStateAction<DoorTransform>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  // Edits write straight to `useDoorStore` (localStorage) so there's no
  // optimistic-draft layer. The store's zustand subscription re-renders
  // the route, and `selectedDoorForPanel` reads the freshest row.
  const handleDoorPatch = useCallback(
    (patch: {
      config?: DoorConfig
      name?: string
      visible?: boolean
      vertices?: [[number, number], [number, number]]
    }) => {
      const id = selectedDoorForPanel?.id
      if (id === undefined) return
      if (patch.config) updateDoorConfigInStore(id, patch.config)
      if (patch.name !== undefined) renameDoorInStore(id, patch.name)
      if (patch.visible !== undefined) setDoorVisibleInStore(id, patch.visible)
      if (patch.vertices) updateDoorInStore(id, { vertices: patch.vertices })
    },
    [
      selectedDoorForPanel,
      updateDoorConfigInStore,
      renameDoorInStore,
      setDoorVisibleInStore,
      updateDoorInStore,
    ],
  )

  const handleDoorConfigChange = useCallback(
    (cfg: DoorConfig) => {
      // When a door is selected the slider edits that door; otherwise
      // they tune the placement defaults the next-drawn door will use.
      const id = selectedDoorForPanel?.id
      if (id !== undefined) {
        updateDoorConfigInStore(id, cfg)
      } else {
        setDoorPendingConfig(cfg)
      }
    },
    [selectedDoorForPanel, updateDoorConfigInStore, setDoorPendingConfig],
  )

  const handleSelectDoor = useCallback(
    (id: number, additive: boolean) => {
      if (!additive) {
        setSelectedGridIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedMarkerIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedCircleIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedPolygonIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedLineIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedImageIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedModelIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedStairIds((p) => (p.size > 0 ? new Set() : p))
      }
      setSelectedDoorIds((prev) => {
        const next = new Set(additive ? prev : [])
        if (additive && prev.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        return next
      })
      const d = doors.find((x) => x.id === id)
      if (d && d.vertices && d.vertices.length >= 2) {
        const [v0, v1] = d.vertices
        fitBoundsIfOffscreen(
          mapInstance,
          [
            Math.min(v0[0], v1[0]),
            Math.min(v0[1], v1[1]),
            Math.max(v0[0], v1[0]),
            Math.max(v0[1], v1[1]),
          ],
          { additive },
        )
      }
    },
    [
      setSelectedGridIds,
      setSelectedMarkerIds,
      setSelectedCircleIds,
      setSelectedPolygonIds,
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedDoorIds,
      mapInstance,
      doors,
    ],
  )

  const handleDeleteDoorById = useCallback(
    (id: number) => {
      const row = doors.find((d) => d.id === id)
      if (row) {
        gridHistory.push({ type: 'delete-door', doors: [row] })
      }
      deleteDoorInStore(id)
      setSelectedDoorIds((p) => {
        if (!p.has(id)) return p
        const next = new Set(p)
        next.delete(id)
        return next
      })
    },
    [deleteDoorInStore, setSelectedDoorIds, doors],
  )

  const handleFitToDoorById = useCallback(
    (id: number) => {
      const door = doors.find((d) => d.id === id)
      if (!door || !mapInstance) return
      const [a, b] = door.vertices
      const cLng = (a[0] + b[0]) / 2
      const cLat = (a[1] + b[1]) / 2
      mapInstance.flyTo({
        center: [cLng, cLat],
        zoom: Math.max(mapInstance.getZoom(), 20),
        pitch: Math.max(mapInstance.getPitch(), 45),
        duration: 600,
      })
    },
    [doors, mapInstance],
  )

  const handleExitDoorPlacement = useCallback(() => {
    setActiveTool('pan')
  }, [setActiveTool])

  const handleRenameDoor = useCallback(
    (id: number, name: string) => renameDoorInStore(id, name),
    [renameDoorInStore],
  )

  const handleDuplicateDoor = useCallback(
    (id: number) => {
      const dup = duplicateDoorInStore(id)
      if (dup) setSelectedDoorIds(new Set([dup.id]))
    },
    [duplicateDoorInStore, setSelectedDoorIds],
  )

  const handleSetDoorVisible = useCallback(
    (id: number, visible: boolean) => setDoorVisibleInStore(id, visible),
    [setDoorVisibleInStore],
  )

  // ---- Door transform handlers -------------------------------------------
  const handleStartMoveDoor = useCallback(
    (id: number) => setDoorTransform({ doorId: id, kind: 'move' }),
    [setDoorTransform],
  )
  const handleStartRotateDoor = useCallback(
    (id: number) => setDoorTransform({ doorId: id, kind: 'rotate' }),
    [setDoorTransform],
  )
  const handleStartScaleDoor = useCallback(
    (id: number) => setDoorTransform({ doorId: id, kind: 'scale' }),
    [setDoorTransform],
  )
  const handleCancelDoorTransform = useCallback(
    () => setDoorTransform(null),
    [setDoorTransform],
  )
  const handleDoorTransformChange = useCallback(
    (
      next: [[number, number], [number, number]],
      _commit: boolean,
    ) => {
      if (!doorTransform) return
      // Every tick (and the final mouseup commit) writes to the store.
      // The door store is local-only so there's no debounced PATCH to
      // worry about — the cost is just a React re-render.
      updateDoorInStore(doorTransform.doorId, { vertices: next })
    },
    [doorTransform, updateDoorInStore],
  )

  return {
    handleDoorPatch,
    handleDoorConfigChange,
    handleSelectDoor,
    handleDeleteDoorById,
    handleFitToDoorById,
    handleExitDoorPlacement,
    handleRenameDoor,
    handleDuplicateDoor,
    handleSetDoorVisible,
    handleStartMoveDoor,
    handleStartRotateDoor,
    handleStartScaleDoor,
    handleCancelDoorTransform,
    handleDoorTransformChange,
  }
}
