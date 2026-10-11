import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { apiDb } from '@/lib/api-db'
import { gridHistory } from '@/lib/grid-history'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type FillShapeConfig, type PolygonShape } from '@/lib/shapes'
import { patchSpatialEntity, saveSpatialEntity } from '@/lib/spatial-store'
import { queryCache } from '@/lib/useApiQuery'

import type {
  PolygonTransform,
  PolygonTransformDraft,
} from '../state/usePolygonEditorState'
import { fitBoundsIfOffscreen } from './fitToShapeOnSelect'
import { copyName } from '@/lib/copy-name'

type SelectedBin =
  | { gridId: number; row: number; col: number; level: number }
  | null

/**
 * All polygon CRUD + selection + transform handlers. Polygon has
 * three transform modes: `move` (drag the whole ring), `rotate`
 * (spin around centroid), and `edit` (per-vertex handles + edge-
 * midpoint insert handles).
 *
 * `edit` mode is sticky: after each vertex commit the draft is
 * reseeded from the just-committed vertices so subsequent drags start
 * from a stable baseline. The mode exits only via Esc or clicking the
 * Edit button again — matches the sculpting UX users expect from
 * CAD-style tools.
 *
 * `handlePolygonClick` reads the latest selection through
 * `selectedPolygonIdsRef` because `useCallback([])` freezes the
 * first-render snapshot and functional setters can double-fire under
 * StrictMode — the ref is the escape hatch that both problems share.
 */
export function usePolygonHandlers({
  mapInstance,
  savedPolygons,
  selectedPolygon,
  polygonTransform,
  polygonTransformDraft,
  selectedPolygonIdsRef,
  setSelectedPolygonIds,
  setPolygonTransform,
  setPolygonTransformDraft,
  setPolygonConfig,
  setSelectedBin,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedStairIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  savedPolygons: PolygonShape[]
  selectedPolygon: PolygonShape | null
  polygonTransform: PolygonTransform
  polygonTransformDraft: PolygonTransformDraft
  selectedPolygonIdsRef: MutableRefObject<Set<number>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setPolygonTransform: Dispatch<SetStateAction<PolygonTransform>>
  setPolygonTransformDraft: Dispatch<SetStateAction<PolygonTransformDraft>>
  setPolygonConfig: Dispatch<SetStateAction<FillShapeConfig>>
  setSelectedBin: Dispatch<SetStateAction<SelectedBin>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  const handlePolygonClick = useCallback(
    (id: number, e: MouseEvent) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedBin(null)
      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      if (additive) {
        const current = selectedPolygonIdsRef.current
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setSelectedPolygonIds(next)
      } else {
        setSelectedPolygonIds(new Set([id]))
      }
    },
    [
      setSelectedGridIds,
      setSelectedMarkerIds,
      setSelectedCircleIds,
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedBin,
      selectedPolygonIdsRef,
      setSelectedPolygonIds,
    ],
  )

  const handleSelectPolygon = useCallback(
    (id: number, additive: boolean) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => {
        if (additive) {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      const p = savedPolygons.find((x) => x.id === id)
      if (p && p.vertices.length > 0) {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
        for (const [lng, lat] of p.vertices) {
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
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedPolygonIds,
      mapInstance,
      savedPolygons,
    ],
  )

  const handleFitToPolygonById = useCallback(
    (id: number) => {
      const p = savedPolygons.find((x) => x.id === id)
      if (!p || !mapInstance || p.vertices.length === 0) return
      let sx = 0
      let sy = 0
      for (const v of p.vertices) {
        sx += v[0]
        sy += v[1]
      }
      const center: [number, number] = [
        sx / p.vertices.length,
        sy / p.vertices.length,
      ]
      mapInstance.flyTo({
        center,
        zoom: Math.max(mapInstance.getZoom(), 16),
        essential: true,
      })
    },
    [mapInstance, savedPolygons],
  )

  const handleDeletePolygonById = useCallback(
    (id: number) => {
      setSelectedPolygonIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      void (async () => {
        const row = await apiDb.polygons.get(id)
        if (row) gridHistory.push({ type: 'delete-polygon', polygons: [row] })
        await apiDb.polygons.delete(id)
        queryCache.invalidate('polygons')
      })()
    },
    [setSelectedPolygonIds],
  )

  const handleDuplicatePolygon = useCallback(
    (id: number) => {
      const original = savedPolygons.find((p) => p.id === id)
      if (!original) return
      const now = new Date()
      const offset: [number, number] = [0.00005, 0.00005]
      const verts = original.vertices.map(
        ([lng, lat]) =>
          [lng + offset[0], lat + offset[1]] as [number, number],
      )
      void (async () => {
        const { id: _, ...rest } = original
        const newId = await apiDb.polygons.add({
          ...rest,
          name: copyName('polygons', original.name),
          vertices: verts,
          createdAt: now,
          updatedAt: now,
        })
        queryCache.invalidate('polygons')
        setSelectedPolygonIds(new Set([newId as number]))
      })()
    },
    [savedPolygons, setSelectedPolygonIds],
  )

  const handleExitPolygonPlacement = useCallback(() => {
    setActiveTool('pan')
  }, [setActiveTool])

  const handleRenamePolygon = useCallback(
    async (id: number, name: string) => {
      await saveSpatialEntity('polygons', id, { name, updatedAt: new Date() } as never)
    },
    [],
  )

  const handleAssignPolygonToZone = useCallback(
    async (polygonId: number, zoneId: number | null) => {
      await saveSpatialEntity('polygons', polygonId, { zoneId } as never)
    },
    [],
  )

  const handlePolygonConfigChange = useCallback(
    (cfg: FillShapeConfig) => {
      if (selectedPolygon && selectedPolygon.id !== undefined) {
        const id = selectedPolygon.id
        void patchSpatialEntity('polygons', id, {
          config: { ...cfg },
          updatedAt: new Date(),
        })
      } else {
        setPolygonConfig(cfg)
      }
    },
    [selectedPolygon, setPolygonConfig],
  )

  const handlePolygonPatch = useCallback(
    (patch: Partial<PolygonShape>) => {
      if (!selectedPolygon || selectedPolygon.id === undefined) return
      void patchSpatialEntity('polygons', selectedPolygon.id, {
        ...patch,
        updatedAt: new Date(),
      })
    },
    [selectedPolygon],
  )

  const handleStartMovePolygon = useCallback(
    (id: number) => {
      const p = savedPolygons.find((x) => x.id === id)
      if (!p) return
      setPolygonTransform({ polygonId: id, kind: 'move' })
      setPolygonTransformDraft({ vertices: p.vertices })
    },
    [savedPolygons, setPolygonTransform, setPolygonTransformDraft],
  )

  const handleStartRotatePolygon = useCallback(
    (id: number) => {
      const p = savedPolygons.find((x) => x.id === id)
      if (!p) return
      setPolygonTransform({ polygonId: id, kind: 'rotate' })
      setPolygonTransformDraft({ rotation: p.rotation })
    },
    [savedPolygons, setPolygonTransform, setPolygonTransformDraft],
  )

  /**
   * Enter per-vertex edit mode. The overlay renders a draggable circle
   * on every vertex + a smaller "insert" handle at each edge midpoint.
   * Vertex drag flows through the same `onTransformChange` path used
   * by move/rotate — the patch replaces `vertices` outright with the
   * edited ring on every mousemove (preview) and once on commit.
   */
  const handleStartEditPolygon = useCallback(
    (id: number) => {
      const p = savedPolygons.find((x) => x.id === id)
      if (!p) return
      setPolygonTransform({ polygonId: id, kind: 'edit' })
      setPolygonTransformDraft({ vertices: p.vertices })
    },
    [savedPolygons, setPolygonTransform, setPolygonTransformDraft],
  )

  const handleCancelPolygonTransform = useCallback(() => {
    setPolygonTransform(null)
    setPolygonTransformDraft(null)
  }, [setPolygonTransform, setPolygonTransformDraft])

  const handlePolygonTransformChange = useCallback(
    (
      patch: { vertices?: [number, number][]; rotation?: number },
      commit: boolean,
    ) => {
      setPolygonTransformDraft((prev) => ({ ...(prev ?? {}), ...patch }))
      if (!commit) return
      const tx = polygonTransform
      if (!tx) return
      const merged = { ...(polygonTransformDraft ?? {}), ...patch }
      // Capture the pre-commit polygon so undo can restore it.
      const prevPolygon = savedPolygons.find((p) => p.id === tx.polygonId)
      const update: Partial<PolygonShape> = { updatedAt: new Date() }
      if (merged.vertices) update.vertices = merged.vertices
      if (typeof merged.rotation === 'number') update.rotation = merged.rotation
      if (prevPolygon && (update.vertices || update.rotation !== undefined)) {
        gridHistory.push({
          type: 'polygon-transform',
          polygonId: tx.polygonId,
          prevVertices: update.vertices ? prevPolygon.vertices : undefined,
          newVertices: update.vertices,
          prevRotation:
            update.rotation !== undefined ? (prevPolygon.rotation ?? 0) : undefined,
          newRotation: update.rotation,
        })
      }
      void patchSpatialEntity('polygons', tx.polygonId, update)
      // `edit` mode persists across per-vertex drags — the user drops a
      // vertex, the new geometry commits to the store, but the vertex
      // handles stay on the map so they can keep reshaping. The mode
      // exits only via Esc or clicking the Edit button again. `move`
      // and `rotate` are single-gesture and exit immediately after
      // commit (their previous behaviour is preserved).
      if (tx.kind === 'edit') {
        // Reseed the draft from the just-committed vertices so the next
        // drag starts from a stable baseline instead of stale draft
        // state that no longer matches the persisted row.
        setPolygonTransformDraft({ vertices: merged.vertices })
        return
      }
      setPolygonTransform(null)
      setPolygonTransformDraft(null)
    },
    [
      polygonTransform,
      polygonTransformDraft,
      setPolygonTransform,
      setPolygonTransformDraft,
    ],
  )

  const handleTogglePolygonVisible = useCallback(
    async (id: number, visible: boolean) => {
      await saveSpatialEntity('polygons', id, { visible, updatedAt: new Date() } as never)
    },
    [],
  )

  return {
    handlePolygonClick,
    handleSelectPolygon,
    handleFitToPolygonById,
    handleDeletePolygonById,
    handleDuplicatePolygon,
    handleExitPolygonPlacement,
    handleRenamePolygon,
    handleAssignPolygonToZone,
    handlePolygonConfigChange,
    handlePolygonPatch,
    handleStartMovePolygon,
    handleStartRotatePolygon,
    handleStartEditPolygon,
    handleCancelPolygonTransform,
    handlePolygonTransformChange,
    handleTogglePolygonVisible,
  }
}
