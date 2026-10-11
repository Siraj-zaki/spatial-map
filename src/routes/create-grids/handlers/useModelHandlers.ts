import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { apiDb } from '@/lib/api-db'
import { gridHistory } from '@/lib/grid-history'
import { type ModelShape, type ModelShapeConfig } from '@/lib/shapes'
import { getSpatialEntity, patchSpatialEntity, useSpatialStore, saveSpatialEntity } from '@/lib/spatial-store'
import { queryCache } from '@/lib/useApiQuery'

import type {
  ModelTransform,
  ModelTransformDraft,
} from '../state/useModelEditorState'
import { copyName } from '@/lib/copy-name'

/**
 * All model (glTF/GLB) CRUD + selection + transform + config-draft
 * handlers. Model editing follows the grid draft pattern:
 * `handleModelPatch` accumulates edits into `draftModelPatch` for
 * live map/sidebar preview, and the backend PATCH fires on Save (or
 * auto-commit when selection changes).
 *
 * Position changes DON'T pass through `handleModelPatch` — they
 * happen via the move handle (`handleModelTransformChange`) and
 * commit directly on dragend. Users expect the spatial position to
 * persist immediately, not wait behind a Save click.
 *
 * `handleDeleteModelById` also cascades any bins linked to the model
 * (`(targetKind, shapeId) = ('model', id)`) since a deleted model
 * leaves orphaned bins that only surface later as broken references.
 */
export function useModelHandlers({
  mapInstance,
  savedModels,
  selectedModel,
  modelTransform,
  setSelectedModelIds,
  setModelTransform,
  setModelTransformDraft,
  setModelLibraryMode,
  setModelLibraryOpen,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
}: {
  mapInstance: MapboxMapInstance | null
  savedModels: ModelShape[]
  selectedModel: ModelShape | null
  modelTransform: ModelTransform
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setModelTransform: Dispatch<SetStateAction<ModelTransform>>
  setModelTransformDraft: Dispatch<SetStateAction<ModelTransformDraft>>
  setModelLibraryMode: Dispatch<SetStateAction<'place' | 'swap'>>
  setModelLibraryOpen: Dispatch<SetStateAction<boolean>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
}) {
  /**
   * Single entry point for ModelEditor edits. The store previews the change
   * at once and saves it when the edit settles; the config patch is merged
   * onto the model's latest value (not a render-time copy) so two quick
   * edits can't overwrite each other.
   */
  const handleModelPatch = useCallback(
    (patch: {
      config?: Partial<ModelShapeConfig>
      name?: string
      visible?: boolean
    }) => {
      if (!selectedModel || selectedModel.id === undefined) return
      const modelId = selectedModel.id
      const next: Partial<ModelShape> = {}
      if (patch.name !== undefined) next.name = patch.name
      if (patch.visible !== undefined) next.visible = patch.visible
      if (patch.config) {
        const current = getSpatialEntity<ModelShape>('models', modelId) ?? selectedModel
        next.config = { ...current.config, ...patch.config }
      }
      useSpatialStore.getState().updateLocal('models', modelId, next)
    },
    [selectedModel],
  )

  const handleModelSwapAsset = useCallback(() => {
    setModelLibraryMode('swap')
    setModelLibraryOpen(true)
  }, [setModelLibraryMode, setModelLibraryOpen])

  /**
   * Enter move mode for the selected model. The overlay listens for
   * `modelTransform.kind === 'move'` and attaches a draggable handle
   * at the model's lng/lat; the user drags it to relocate.
   */
  const handleStartMoveModel = useCallback(() => {
    if (!selectedModel || selectedModel.id === undefined) return
    setModelTransform({ modelId: selectedModel.id, kind: 'move' })
    setModelTransformDraft(null)
  }, [selectedModel, setModelTransform, setModelTransformDraft])

  const handleCancelModelTransform = useCallback(() => {
    setModelTransform(null)
    setModelTransformDraft(null)
  }, [setModelTransform, setModelTransformDraft])

  const handleDuplicateModel = useCallback(
    (id: number) => {
      const original = savedModels.find((m) => m.id === id)
      if (!original) return
      const now = new Date()
      const lngOffset = 0.00005
      const latOffset = 0.00005
      void (async () => {
        const newId = await apiDb.models.add({
          name: copyName('models', original.name),
          unit: original.unit,
          visible: true,
          position: [
            original.position[0] + lngOffset,
            original.position[1] + latOffset,
          ],
          zoneId: original.zoneId,
          config: { ...original.config },
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('models')
        setSelectedModelIds(new Set([newId as number]))
      })()
    },
    [savedModels, setSelectedModelIds],
  )

  /**
   * Forward drag events from the overlay's move handle. `commit` is
   * false on `drag` (just refresh the live draft so the rendered
   * model follows) and true on `dragend` (write the new position
   * to Dexie and exit move mode).
   */
  const handleModelTransformChange = useCallback(
    (patch: { position?: [number, number] }, commit: boolean) => {
      if (!modelTransform) return
      if (!commit) {
        setModelTransformDraft(patch)
        return
      }
      if (patch.position) {
        const now = new Date()
        void patchSpatialEntity('models', modelTransform.modelId, {
          position: patch.position,
          updatedAt: now,
        })
      }
      setModelTransform(null)
      setModelTransformDraft(null)
    },
    [modelTransform, setModelTransform, setModelTransformDraft],
  )

  const handleSelectModel = useCallback(
    (id: number, additive: boolean) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => {
        if (additive) {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      // Center the map on the picked model so the user actually sees
      // what they selected. Models are placed at a single lng/lat
      // point, so a `flyTo` at the existing zoom (clamped to a useful
      // minimum) is enough — no bbox math needed. We do this for
      // non-additive selection only; multi-select shouldn't yank the
      // camera around.
      if (!additive && mapInstance) {
        const m = savedModels.find((x) => x.id === id)
        if (m) {
          mapInstance.flyTo({
            center: m.position,
            zoom: Math.max(mapInstance.getZoom(), 19),
            duration: 600,
          })
        }
      }
    },
    [
      mapInstance,
      savedModels,
      setSelectedGridIds,
      setSelectedMarkerIds,
      setSelectedCircleIds,
      setSelectedPolygonIds,
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
    ],
  )

  const handleFitToModelById = useCallback(
    (id: number) => {
      if (!mapInstance) return
      const m = savedModels.find((x) => x.id === id)
      if (!m) return
      mapInstance.easeTo({
        center: m.position,
        zoom: Math.max(mapInstance.getZoom(), 19),
        duration: 600,
      })
    },
    [mapInstance, savedModels],
  )

  const handleDeleteModelById = useCallback(
    (id: number) => {
      void (async () => {
        // Push into the undo stack BEFORE the delete lands so Ctrl+Z
        // can restore the row verbatim (name, position, config, etc.).
        // Bin cascade below is not undone yet — matches how polygon
        // delete leaves attached bins to the redo path.
        const row = await apiDb.models.get(id)
        if (row) gridHistory.push({ type: 'delete-model', models: [row] })
        await apiDb.models.delete(id)
        queryCache.invalidate('models')
        const rows = await apiDb.bins
          .where('[targetKind+shapeId]')
          .equals(['model', id])
          .toArray()
        await Promise.all(
          rows.map((row) =>
            row.id !== undefined ? apiDb.bins.delete(row.id) : Promise.resolve(),
          ),
        )
        queryCache.invalidate('bins')
      })()
      setSelectedModelIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      // Drop any pending sidebar edits for the deleted model — committing
      // them would PATCH a row that no longer exists.
    },
    [setSelectedModelIds],
  )

  const handleRenameModel = useCallback(
    async (id: number, name: string) => {
      await saveSpatialEntity('models', id, { name, updatedAt: new Date() } as never)
    },
    [],
  )

  const handleAssignModelToZone = useCallback(
    async (modelId: number, zoneId: number | null) => {
      await saveSpatialEntity('models', modelId, { zoneId, updatedAt: new Date() } as never)
    },
    [],
  )

  const handleToggleModelVisible = useCallback(
    async (id: number, visible: boolean) => {
      await saveSpatialEntity('models', id, { visible, updatedAt: new Date() } as never)
    },
    [],
  )

  return {
    handleModelPatch,
    handleModelSwapAsset,
    handleStartMoveModel,
    handleCancelModelTransform,
    handleDuplicateModel,
    handleModelTransformChange,
    handleSelectModel,
    handleFitToModelById,
    handleDeleteModelById,
    handleRenameModel,
    handleAssignModelToZone,
    handleToggleModelVisible,
  }
}
