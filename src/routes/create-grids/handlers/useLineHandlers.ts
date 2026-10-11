import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { apiDb } from '@/lib/api-db'
import { gridHistory } from '@/lib/grid-history'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type LineShape, type LineShapeConfig } from '@/lib/shapes'
import { patchSpatialEntity, saveSpatialEntity } from '@/lib/spatial-store'
import { queryCache } from '@/lib/useApiQuery'

import type {
  LineTransform,
  LineTransformDraft,
} from '../state/useLineEditorState'
import { fitBoundsIfOffscreen } from './fitToShapeOnSelect'
import { copyName } from '@/lib/copy-name'

type SelectedBin =
  | { gridId: number; row: number; col: number; level: number }
  | null

/**
 * All line (wall) CRUD + selection + transform handlers. Lines share
 * the move/rotate transform pattern with polygons but don't have a
 * per-vertex `edit` mode — walls are almost always straight and the
 * per-vertex handles were a source of accidental deformation.
 *
 * `handleLineTransformChange` draft-patches on every mousemove and
 * commits only when `commit === true` (dragend), matching the
 * polygon/circle pattern.
 */
export function useLineHandlers({
  mapInstance,
  savedLines,
  selectedLine,
  lineTransform,
  lineTransformDraft,
  setSelectedLineIds,
  setLineTransform,
  setLineTransformDraft,
  setLineConfig,
  setSelectedBin,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedStairIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  savedLines: LineShape[]
  selectedLine: LineShape | null
  lineTransform: LineTransform
  lineTransformDraft: LineTransformDraft
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setLineTransform: Dispatch<SetStateAction<LineTransform>>
  setLineTransformDraft: Dispatch<SetStateAction<LineTransformDraft>>
  setLineConfig: Dispatch<SetStateAction<LineShapeConfig>>
  setSelectedBin: Dispatch<SetStateAction<SelectedBin>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  const handleLineClick = useCallback(
    (id: number, e: MouseEvent) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedBin(null)
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        setSelectedLineIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      } else {
        setSelectedLineIds(new Set([id]))
      }
    },
    [
      setSelectedGridIds,
      setSelectedMarkerIds,
      setSelectedCircleIds,
      setSelectedPolygonIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedBin,
      setSelectedLineIds,
    ],
  )

  const handleSelectLine = useCallback(
    (id: number, additive: boolean) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => {
        if (additive) {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      const ln = savedLines.find((x) => x.id === id)
      if (ln && ln.vertices.length > 0) {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
        for (const [lng, lat] of ln.vertices) {
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
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedLineIds,
      mapInstance,
      savedLines,
    ],
  )

  const handleFitToLineById = useCallback(
    (id: number) => {
      const ln = savedLines.find((x) => x.id === id)
      if (!ln || !mapInstance || ln.vertices.length < 2) return
      // Use the midpoint of the vertex extent as the fly target.
      let sx = 0
      let sy = 0
      for (const v of ln.vertices) {
        sx += v[0]
        sy += v[1]
      }
      const center: [number, number] = [
        sx / ln.vertices.length,
        sy / ln.vertices.length,
      ]
      mapInstance.flyTo({
        center,
        zoom: Math.max(mapInstance.getZoom(), 16),
        essential: true,
      })
    },
    [mapInstance, savedLines],
  )

  const handleDeleteLineById = useCallback(
    (id: number) => {
      setSelectedLineIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      void (async () => {
        const row = await apiDb.lines.get(id)
        if (row) gridHistory.push({ type: 'delete-line', lines: [row] })
        await apiDb.lines.delete(id)
        queryCache.invalidate('lines')
      })()
    },
    [setSelectedLineIds],
  )

  const handleDuplicateLine = useCallback(
    (id: number) => {
      const original = savedLines.find((l) => l.id === id)
      if (!original) return
      const now = new Date()
      const offset: [number, number] = [0.00005, 0.00005]
      const verts = original.vertices.map(
        ([lng, lat]) =>
          [lng + offset[0], lat + offset[1]] as [number, number],
      )
      void (async () => {
        const { id: _, ...rest } = original
        const newId = await apiDb.lines.add({
          ...rest,
          name: copyName('lines', original.name),
          vertices: verts,
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('lines')
        setSelectedLineIds(new Set([newId as number]))
      })()
    },
    [savedLines, setSelectedLineIds],
  )

  const handleExitLinePlacement = useCallback(() => {
    setActiveTool('pan')
  }, [setActiveTool])

  const handleRenameLine = useCallback(
    async (id: number, name: string) => {
      await saveSpatialEntity('lines', id, { name, updatedAt: new Date() } as never)
    },
    [],
  )

  const handleAssignLineToZone = useCallback(
    async (lineId: number, zoneId: number | null) => {
      await saveSpatialEntity('lines', lineId, { zoneId } as never)
    },
    [],
  )

  const handleLineConfigChange = useCallback(
    (cfg: LineShapeConfig) => {
      if (selectedLine && selectedLine.id !== undefined) {
        const id = selectedLine.id
        void patchSpatialEntity('lines', id, {
          config: { ...cfg },
          updatedAt: new Date(),
        })
      } else {
        setLineConfig(cfg)
      }
    },
    [selectedLine, setLineConfig],
  )

  const handleLinePatch = useCallback(
    (patch: Partial<LineShape>) => {
      if (!selectedLine || selectedLine.id === undefined) return
      void patchSpatialEntity('lines', selectedLine.id, {
        ...patch,
        updatedAt: new Date(),
      })
    },
    [selectedLine],
  )

  const handleStartMoveLine = useCallback(
    (id: number) => {
      const ln = savedLines.find((x) => x.id === id)
      if (!ln) return
      setLineTransform({ lineId: id, kind: 'move' })
      setLineTransformDraft({ vertices: ln.vertices })
    },
    [savedLines, setLineTransform, setLineTransformDraft],
  )

  const handleStartRotateLine = useCallback(
    (id: number) => {
      const ln = savedLines.find((x) => x.id === id)
      if (!ln) return
      setLineTransform({ lineId: id, kind: 'rotate' })
      setLineTransformDraft({ rotation: ln.rotation })
    },
    [savedLines, setLineTransform, setLineTransformDraft],
  )

  const handleCancelLineTransform = useCallback(() => {
    setLineTransform(null)
    setLineTransformDraft(null)
  }, [setLineTransform, setLineTransformDraft])

  const handleLineTransformChange = useCallback(
    (
      patch: { vertices?: [number, number][]; rotation?: number },
      commit: boolean,
    ) => {
      setLineTransformDraft((prev) => ({ ...(prev ?? {}), ...patch }))
      if (!commit) return
      const tx = lineTransform
      if (!tx) return
      const merged = { ...(lineTransformDraft ?? {}), ...patch }
      const update: Partial<LineShape> = { updatedAt: new Date() }
      if (merged.vertices) update.vertices = merged.vertices
      if (typeof merged.rotation === 'number') update.rotation = merged.rotation
      void patchSpatialEntity('lines', tx.lineId, update)
      setLineTransform(null)
      setLineTransformDraft(null)
    },
    [lineTransform, lineTransformDraft, setLineTransform, setLineTransformDraft],
  )

  const handleToggleLineVisible = useCallback(
    async (id: number, visible: boolean) => {
      await saveSpatialEntity('lines', id, { visible, updatedAt: new Date() } as never)
    },
    [],
  )

  return {
    handleLineClick,
    handleSelectLine,
    handleFitToLineById,
    handleDeleteLineById,
    handleDuplicateLine,
    handleExitLinePlacement,
    handleRenameLine,
    handleAssignLineToZone,
    handleLineConfigChange,
    handleLinePatch,
    handleStartMoveLine,
    handleStartRotateLine,
    handleCancelLineTransform,
    handleLineTransformChange,
    handleToggleLineVisible,
  }
}
