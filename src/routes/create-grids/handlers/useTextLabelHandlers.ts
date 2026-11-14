import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { apiDb } from '@/lib/api-db'
import { gridHistory } from '@/lib/grid-history'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type TextLabelShape } from '@/lib/shapes'
import { patchSpatialEntity, saveSpatialEntity } from '@/lib/spatial-store'
import { queryCache } from '@/lib/useApiQuery'

import type {
  TextLabelTransform,
  TextLabelTransformDraft,
} from '../state/useTextLabelEditorState'
import { fitBoundsIfOffscreen } from './fitToShapeOnSelect'

/**
 * All text-label CRUD + selection + transform handlers. Text labels
 * support move / rotate / scale transforms — scale writes into the
 * config's font-size / offset fields (via the transform draft) rather
 * than resizing a bbox like image or grid does.
 *
 * `handleToggleTextLabelVisible` uses the `text-labels` (hyphenated)
 * key for both `patchSpatialEntity` and `queryCache.invalidate` — the
 * spatial-store's kind literal is `text-labels`, matching CONTEXT.md's
 * pluralised-hyphenated convention.
 */
export function useTextLabelHandlers({
  mapInstance,
  savedTextLabels,
  setSelectedTextLabelIds,
  setTextLabelTransform,
  setTextLabelTransformDraft,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  savedTextLabels: TextLabelShape[]
  setSelectedTextLabelIds: Dispatch<SetStateAction<Set<number>>>
  setTextLabelTransform: Dispatch<SetStateAction<TextLabelTransform>>
  setTextLabelTransformDraft: Dispatch<SetStateAction<TextLabelTransformDraft>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  const handleFitToTextLabelById = useCallback(
    (id: number) => {
      const l = savedTextLabels.find((x) => x.id === id)
      if (!l || !mapInstance) return
      mapInstance.flyTo({
        center: l.position,
        zoom: Math.max(mapInstance.getZoom(), 16),
        essential: true,
      })
    },
    [mapInstance, savedTextLabels],
  )

  const handleSelectTextLabel = useCallback(
    (id: number, additive: boolean) => {
      setSelectedTextLabelIds((prev) => {
        const next = new Set(additive ? prev : [])
        if (additive && prev.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      const t = savedTextLabels.find((x) => x.id === id)
      if (t && t.position) {
        fitBoundsIfOffscreen(
          mapInstance,
          [t.position[0], t.position[1], t.position[0], t.position[1]],
          { additive },
        )
      }
    },
    [setSelectedTextLabelIds, mapInstance, savedTextLabels],
  )

  const handleDeleteTextLabelById = useCallback(
    (id: number) => {
      void (async () => {
        const row = await apiDb.textLabels.get(id)
        if (row) {
          gridHistory.push({ type: 'delete-text-label', textLabels: [row] })
        }
        await apiDb.textLabels.delete(id)
        queryCache.invalidate('textLabels')
        setSelectedTextLabelIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      })()
    },
    [setSelectedTextLabelIds],
  )

  const handleDuplicateTextLabel = useCallback(
    (id: number) => {
      void (async () => {
        const src = await apiDb.textLabels.get(id)
        if (!src) return
        const now = new Date()
        // Offset the clone slightly so the user can see both.
        const offset = 0.00005
        const { id: _, ...rest } = src
        const newId = await apiDb.textLabels.add({
          ...rest,
          position: [src.position[0] + offset, src.position[1] + offset],
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('textLabels')
        setSelectedTextLabelIds(new Set([newId as number]))
      })()
    },
    [setSelectedTextLabelIds],
  )

  const handleRenameTextLabel = useCallback(
    (id: number, name: string) => {
      void patchSpatialEntity('text-labels', id, {
        name,
        updatedAt: new Date(),
      })
    },
    [],
  )

  const handleExitTextLabelPlacement = useCallback(
    () => setActiveTool('pan'),
    [setActiveTool],
  )

  const handleStartMoveTextLabel = useCallback(
    (id: number) => {
      const lbl = savedTextLabels.find((x) => x.id === id)
      if (!lbl) return
      setTextLabelTransform({ textLabelId: id, kind: 'move' })
      setTextLabelTransformDraft({ position: lbl.position })
    },
    [savedTextLabels, setTextLabelTransform, setTextLabelTransformDraft],
  )

  const handleStartRotateTextLabel = useCallback(
    (id: number) => {
      const lbl = savedTextLabels.find((x) => x.id === id)
      if (!lbl) return
      setTextLabelTransform({ textLabelId: id, kind: 'rotate' })
      setTextLabelTransformDraft({ rotation: lbl.rotation ?? 0 })
    },
    [savedTextLabels, setTextLabelTransform, setTextLabelTransformDraft],
  )

  const handleStartScaleTextLabel = useCallback(
    (id: number) => {
      const lbl = savedTextLabels.find((x) => x.id === id)
      if (!lbl) return
      setTextLabelTransform({ textLabelId: id, kind: 'scale' })
      setTextLabelTransformDraft({ config: lbl.config })
    },
    [savedTextLabels, setTextLabelTransform, setTextLabelTransformDraft],
  )

  const handleCancelTextLabelTransform = useCallback(() => {
    setTextLabelTransform(null)
    setTextLabelTransformDraft(null)
  }, [setTextLabelTransform, setTextLabelTransformDraft])

  const handleToggleTextLabelVisible = useCallback(
    async (id: number, visible: boolean) => {
      await saveSpatialEntity('text-labels', id, { visible, updatedAt: new Date() })
    },
    [],
  )

  return {
    handleFitToTextLabelById,
    handleSelectTextLabel,
    handleDeleteTextLabelById,
    handleDuplicateTextLabel,
    handleRenameTextLabel,
    handleExitTextLabelPlacement,
    handleStartMoveTextLabel,
    handleStartRotateTextLabel,
    handleStartScaleTextLabel,
    handleCancelTextLabelTransform,
    handleToggleTextLabelVisible,
  }
}
