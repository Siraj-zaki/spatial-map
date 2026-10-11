import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { apiDb } from '@/lib/api-db'
import { gridHistory } from '@/lib/grid-history'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type StairShape, type StairShapeConfig } from '@/lib/shapes'
import { getSpatialEntity, patchSpatialEntity, useSpatialStore, saveSpatialEntity } from '@/lib/spatial-store'
import { queryCache } from '@/lib/useApiQuery'

import type { StairTransform, StairTransformDraft } from '../state/useStairEditorState'
import { fitBoundsIfOffscreen } from './fitToShapeOnSelect'
import { copyName } from '@/lib/copy-name'

/**
 * All stair CRUD + selection + config-draft handlers. Stairs use a
 * `draft-then-commit` pattern for sidebar edits (like grids), so
 * `handleStairPatch` and `handleStairConfigChange` write into
 * `draftStairPatch` for live preview and the actual PATCH fires
 * elsewhere on Save / auto-commit.
 *
 * `handleStairConfigChange` diffs the incoming config against the
 * saved row and only stores the changed fields — that way clicking
 * "Save" for an unchanged draft is a no-op, and undo/redo shows
 * only what the user actually touched.
 */
export function useStairHandlers({
  mapInstance,
  savedStairs,
  selectedStair,
  selectedStairIds,
  setSelectedStairIds,
  setStairConfig,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedTextLabelIds,
  setActiveTool,
  stairTransform,
  setStairTransform,
  stairTransformDraft,
  setStairTransformDraft,
}: {
  mapInstance: MapboxMapInstance | null
  savedStairs: StairShape[]
  selectedStair: StairShape | null
  selectedStairIds: Set<number>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setStairConfig: Dispatch<SetStateAction<StairShapeConfig>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedTextLabelIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
  stairTransform: StairTransform
  setStairTransform: Dispatch<SetStateAction<StairTransform>>
  stairTransformDraft: StairTransformDraft
  setStairTransformDraft: Dispatch<SetStateAction<StairTransformDraft>>
}) {
  // Edits go straight to the store, which previews them and saves when the
  // edit settles; configs merge onto the stair's latest value.
  const handleStairPatch = useCallback(
    (patch: Partial<StairShape>) => {
      if (!selectedStair || selectedStair.id === undefined) return
      const stairId = selectedStair.id
      const next: Partial<StairShape> = {}
      if (patch.name !== undefined) next.name = patch.name
      if (patch.visible !== undefined) next.visible = patch.visible
      // The side panel's rotation slider and the escalator Length field
      // patch these — they used to be dropped here, so neither did anything.
      if (patch.rotation !== undefined) next.rotation = patch.rotation
      if (patch.vertices !== undefined) next.vertices = patch.vertices
      if (patch.config) {
        const current = getSpatialEntity<StairShape>('stairs', stairId) ?? selectedStair
        next.config = { ...current.config, ...patch.config }
      }
      useSpatialStore.getState().updateLocal('stairs', stairId, next)
    },
    [selectedStair],
  )

  const handleStairConfigChange = useCallback(
    (next: StairShapeConfig) => {
      if (selectedStairIds.size === 1 && selectedStair && selectedStair.id !== undefined) {
        // Only the fields the user changed, onto the stair's latest config.
        const current = getSpatialEntity<StairShape>('stairs', selectedStair.id) ?? selectedStair
        const changed = (Object.keys(next) as (keyof StairShapeConfig)[]).filter((k) => next[k] !== current.config[k])
        if (changed.length === 0) return
        const config = { ...current.config }
        for (const k of changed) (config as Record<string, unknown>)[k] = next[k]
        useSpatialStore.getState().updateLocal('stairs', selectedStair.id, { config })
      } else {
        // Placement mode → just stash the default for the next draw.
        setStairConfig(next)
      }
    },
    [selectedStairIds, selectedStair, setStairConfig],
  )

  const handleSelectStair = useCallback(
    (id: number, additive: boolean) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedTextLabelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => {
        if (additive) {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      const st = savedStairs.find((x) => x.id === id)
      if (st && st.vertices.length > 0) {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
        for (const [lng, lat] of st.vertices) {
          if (lng < w) w = lng
          if (lng > e) e = lng
          if (lat < s) s = lat
          if (lat > n) n = lat
        }
        fitBoundsIfOffscreen(mapInstance, [w, s, e, n], { additive })
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
      setSelectedTextLabelIds,
      setSelectedStairIds,
      mapInstance,
      savedStairs,
    ],
  )

  const handleDeleteStairById = useCallback(
    (id: number) => {
      void (async () => {
        const row = await apiDb.stairs.get(id)
        if (row) {
          gridHistory.push({ type: 'delete-stair', stairs: [row] })
        }
        await apiDb.stairs.delete(id)
        queryCache.invalidate('stairs')
      })()
      setSelectedStairIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [setSelectedStairIds],
  )

  const handleFitToStairById = useCallback(
    (id: number) => {
      if (!mapInstance) return
      const s = savedStairs.find((x) => x.id === id)
      if (!s) return
      const midLng = (s.vertices[0][0] + s.vertices[1][0]) / 2
      const midLat = (s.vertices[0][1] + s.vertices[1][1]) / 2
      mapInstance.easeTo({
        center: [midLng, midLat],
        zoom: Math.max(mapInstance.getZoom(), 19),
        duration: 600,
      })
    },
    [mapInstance, savedStairs],
  )

  const handleExitStairPlacement = useCallback(() => {
    setActiveTool('pan')
  }, [setActiveTool])

  const handleRenameStair = useCallback(
    async (id: number, name: string) => {
      await saveSpatialEntity('stairs', id, { name, updatedAt: new Date() } as never)
    },
    [],
  )

  // Duplicate a stair. Mirrors the polygon / line pattern: clone every
  // field of the source row, nudge the vertices SE by a tiny offset so
  // the copy doesn't sit exactly on top of the original.
  const handleDuplicateStair = useCallback(
    (id: number) => {
      const original = savedStairs.find((s) => s.id === id)
      if (!original) return
      const now = new Date()
      const offset: [number, number] = [0.00005, 0.00005]
      const verts = original.vertices.map(
        ([lng, lat]) =>
          [lng + offset[0], lat + offset[1]] as [number, number],
      ) as [number, number][]
      void (async () => {
        const { id: _, ...rest } = original
        const newId = await apiDb.stairs.add({
          ...rest,
          name: copyName('stairs', original.name),
          vertices: verts,
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('stairs')
        setSelectedStairIds(new Set([newId as number]))
      })()
    },
    [savedStairs, setSelectedStairIds],
  )

  const handleAssignStairToZone = useCallback(
    async (stairId: number, zoneId: number | null) => {
      // Send `null` literally (not undefined) so the backend clears
      // the column. `stripServerFields` drops `undefined` so passing
      // `zoneId ?? undefined` would silently skip the field and the
      // assignment couldn't be cleared.
      await saveSpatialEntity('stairs', stairId, { zoneId, updatedAt: new Date() } as never)
    },
    [],
  )

  const handleToggleStairVisible = useCallback(
    async (id: number, visible: boolean) => {
      await saveSpatialEntity('stairs', id, { visible, updatedAt: new Date() } as never)
    },
    [],
  )

  const handleStartRotateStair = useCallback(
    (id: number) => {
      setStairTransform({ stairId: id, kind: 'rotate' })
      setStairTransformDraft(null)
    },
    [setStairTransform, setStairTransformDraft],
  )

  const handleStartMoveStair = useCallback(
    (id: number) => {
      setStairTransform({ stairId: id, kind: 'move' })
      setStairTransformDraft(null)
    },
    [setStairTransform, setStairTransformDraft],
  )

  const handleCancelStairTransform = useCallback(() => {
    setStairTransform(null)
    setStairTransformDraft(null)
  }, [setStairTransform, setStairTransformDraft])

  const handleStairTransformChange = useCallback(
    (
      patch: { vertices?: [number, number][]; rotation?: number },
      commit: boolean,
    ) => {
      setStairTransformDraft((prev) => ({ ...(prev ?? {}), ...patch }))
      if (!commit) return
      const tx = stairTransform
      if (!tx) return
      const merged = { ...(stairTransformDraft ?? {}), ...patch }
      const update: Partial<StairShape> = { updatedAt: new Date() }
      if (merged.vertices) update.vertices = merged.vertices
      if (typeof merged.rotation === 'number') update.rotation = merged.rotation
      void patchSpatialEntity('stairs', tx.stairId, update)
      setStairTransform(null)
      setStairTransformDraft(null)
    },
    [
      stairTransform,
      stairTransformDraft,
      setStairTransform,
      setStairTransformDraft,
    ],
  )

  return {
    handleStairPatch,
    handleStairConfigChange,
    handleSelectStair,
    handleDeleteStairById,
    handleFitToStairById,
    handleExitStairPlacement,
    handleRenameStair,
    handleDuplicateStair,
    handleAssignStairToZone,
    handleToggleStairVisible,
    handleStartRotateStair,
    handleStartMoveStair,
    handleCancelStairTransform,
    handleStairTransformChange,
  }
}
