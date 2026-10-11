import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { apiDb } from '@/lib/api-db'
import { gridHistory } from '@/lib/grid-history'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type CircleShape, type FillShapeConfig } from '@/lib/shapes'
import { patchSpatialEntity, saveSpatialEntity } from '@/lib/spatial-store'
import { queryCache } from '@/lib/useApiQuery'

import type {
  CircleTransform,
  CircleTransformDraft,
} from '../state/useCircleEditorState'
import { fitBoundsIfOffscreen } from './fitToShapeOnSelect'
import { copyName } from '@/lib/copy-name'

type SelectedBin =
  | { gridId: number; row: number; col: number; level: number }
  | null

/**
 * All circle CRUD + selection + transform handlers. Circles come in
 * two flavours (`single` — center + radius; `grid` — bbox filled
 * with regularly-spaced circles) and every handler that reads or
 * writes geometry branches on `mode`.
 *
 * `handleStartMoveCircle` seeds the transform draft with the
 * mode-appropriate fields (single: `center`; grid: `start` + `current`)
 * so the overlay's on-map drag has an initial baseline to move from.
 * `handleStartRotateCircle` is a no-op on single-mode circles — there
 * is no meaningful rotation for a lone disc.
 *
 * `handleCircleTransformChange` reads the fresh draft on every drag
 * tick and only PATCHes when `commit` is true (dragend / keyboard
 * confirm). Uncommitted intermediate ticks stay in React state so
 * the overlay redraws in real time without hitting IndexedDB.
 */
export function useCircleHandlers({
  mapInstance,
  savedCircles,
  selectedCircle,
  circleTransform,
  circleTransformDraft,
  setSelectedCircleIds,
  setCircleTransform,
  setCircleTransformDraft,
  setCircleConfig,
  setSelectedBin,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedStairIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  savedCircles: CircleShape[]
  selectedCircle: CircleShape | null
  circleTransform: CircleTransform
  circleTransformDraft: CircleTransformDraft
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setCircleTransform: Dispatch<SetStateAction<CircleTransform>>
  setCircleTransformDraft: Dispatch<SetStateAction<CircleTransformDraft>>
  setCircleConfig: Dispatch<SetStateAction<FillShapeConfig>>
  setSelectedBin: Dispatch<SetStateAction<SelectedBin>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  const handleCircleClick = useCallback(
    (id: number, e: MouseEvent) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedBin(null)
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        setSelectedCircleIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      } else {
        setSelectedCircleIds(new Set([id]))
      }
    },
    [
      setSelectedGridIds,
      setSelectedMarkerIds,
      setSelectedPolygonIds,
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedBin,
      setSelectedCircleIds,
    ],
  )

  const handleSelectCircle = useCallback(
    (id: number, additive: boolean) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => {
        if (additive) {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      const c = savedCircles.find((x) => x.id === id)
      if (c) {
        // Single-mode: use center + radius (roughly ±0.0001 deg per 10 m,
        // but here we just use the center point — the "any corner visible"
        // check falls back to a point-in-viewport test so a small circle
        // with only its center on screen still counts as visible).
        // Grid-mode: two opposite corners are stored directly.
        let bbox: [number, number, number, number] | null = null
        if (c.mode === 'single' && c.center) {
          bbox = [c.center[0], c.center[1], c.center[0], c.center[1]]
        } else if (c.start && c.current) {
          bbox = [
            Math.min(c.start[0], c.current[0]),
            Math.min(c.start[1], c.current[1]),
            Math.max(c.start[0], c.current[0]),
            Math.max(c.start[1], c.current[1]),
          ]
        }
        fitBoundsIfOffscreen(mapInstance, bbox, { additive })
      }
    },
    [
      setSelectedGridIds,
      setSelectedMarkerIds,
      setSelectedPolygonIds,
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedCircleIds,
      mapInstance,
      savedCircles,
    ],
  )

  const handleFitToCircleById = useCallback(
    (id: number) => {
      const c = savedCircles.find((x) => x.id === id)
      if (!c || !mapInstance) return
      const center =
        c.mode === 'single' && c.center
          ? c.center
          : c.mode === 'grid' && c.start && c.current
            ? ([
                (c.start[0] + c.current[0]) / 2,
                (c.start[1] + c.current[1]) / 2,
              ] as [number, number])
            : null
      if (!center) return
      mapInstance.flyTo({
        center,
        zoom: Math.max(mapInstance.getZoom(), 16),
        essential: true,
      })
    },
    [mapInstance, savedCircles],
  )

  const handleDeleteCircleById = useCallback(
    (id: number) => {
      setSelectedCircleIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      void (async () => {
        const row = await apiDb.circles.get(id)
        if (row) gridHistory.push({ type: 'delete-circle', circles: [row] })
        await apiDb.circles.delete(id)
        queryCache.invalidate('circles')
      })()
    },
    [setSelectedCircleIds],
  )

  const handleDuplicateCircle = useCallback(
    (id: number) => {
      const original = savedCircles.find((c) => c.id === id)
      if (!original) return
      const now = new Date()
      const offset: [number, number] = [0.00005, 0.00005]
      const copy: CircleShape = {
        ...original,
        id: undefined,
        name: copyName('circles', original.name),
        createdAt: now,
        updatedAt: now,
      }
      if (copy.mode === 'single' && copy.center) {
        copy.center = [copy.center[0] + offset[0], copy.center[1] + offset[1]]
      } else if (copy.mode === 'grid' && copy.start && copy.current) {
        copy.start = [copy.start[0] + offset[0], copy.start[1] + offset[1]]
        copy.current = [copy.current[0] + offset[0], copy.current[1] + offset[1]]
      }
      void (async () => {
        const newId = await apiDb.circles.add(copy)
        queryCache.invalidate('circles')
        setSelectedCircleIds(new Set([newId as number]))
      })()
    },
    [savedCircles, setSelectedCircleIds],
  )

  const handleExitCirclePlacement = useCallback(() => {
    setActiveTool('pan')
  }, [setActiveTool])

  // ---- Circle transform (move / rotate) -----------------------------------
  const handleStartMoveCircle = useCallback(
    (id: number) => {
      const c = savedCircles.find((x) => x.id === id)
      if (!c) return
      setCircleTransform({ circleId: id, kind: 'move' })
      setCircleTransformDraft(
        c.mode === 'single' && c.center
          ? { center: c.center }
          : c.mode === 'grid' && c.start && c.current
            ? { start: c.start, current: c.current }
            : {},
      )
    },
    [savedCircles, setCircleTransform, setCircleTransformDraft],
  )

  const handleStartRotateCircle = useCallback(
    (id: number) => {
      const c = savedCircles.find((x) => x.id === id)
      if (!c || c.mode !== 'grid') return
      setCircleTransform({ circleId: id, kind: 'rotate' })
      setCircleTransformDraft({ rotation: c.rotation })
    },
    [savedCircles, setCircleTransform, setCircleTransformDraft],
  )

  const handleCancelCircleTransform = useCallback(() => {
    setCircleTransform(null)
    setCircleTransformDraft(null)
  }, [setCircleTransform, setCircleTransformDraft])

  // Apply a live drag update. `commit=true` persists to apiDb.circles and
  // exits transform mode; otherwise just updates the in-memory draft so
  // the overlay redraws at the new position.
  const handleCircleTransformChange = useCallback(
    (
      patch: {
        center?: [number, number]
        start?: [number, number]
        current?: [number, number]
        rotation?: number
      },
      commit: boolean,
    ) => {
      setCircleTransformDraft((prev) => ({ ...(prev ?? {}), ...patch }))
      if (!commit) return
      const tx = circleTransform
      if (!tx) return
      const merged = { ...(circleTransformDraft ?? {}), ...patch }
      const update: Partial<CircleShape> = { updatedAt: new Date() }
      if (merged.center) update.center = merged.center
      if (merged.start) update.start = merged.start
      if (merged.current) update.current = merged.current
      if (typeof merged.rotation === 'number') update.rotation = merged.rotation
      void patchSpatialEntity('circles', tx.circleId, update)
      setCircleTransform(null)
      setCircleTransformDraft(null)
    },
    [
      circleTransform,
      circleTransformDraft,
      setCircleTransform,
      setCircleTransformDraft,
    ],
  )

  const handleCircleConfigChange = useCallback(
    (cfg: FillShapeConfig) => {
      if (selectedCircle && selectedCircle.id !== undefined) {
        const id = selectedCircle.id
        void patchSpatialEntity('circles', id, {
          config: { ...cfg },
          updatedAt: new Date(),
        })
      } else {
        setCircleConfig(cfg)
      }
    },
    [selectedCircle, setCircleConfig],
  )

  // Patch geometry fields (radius for single, cellSize/cellRadius/start/current
  // for grid) on the currently-selected circle.
  const handleCirclePatch = useCallback(
    (patch: Partial<CircleShape>) => {
      if (!selectedCircle || selectedCircle.id === undefined) return
      void patchSpatialEntity('circles', selectedCircle.id, {
        ...patch,
        updatedAt: new Date(),
      })
    },
    [selectedCircle],
  )

  const handleRenameCircle = useCallback(
    async (id: number, name: string) => {
      await saveSpatialEntity('circles', id, { name, updatedAt: new Date() } as never)
    },
    [],
  )

  const handleAssignCircleToZone = useCallback(
    async (circleId: number, zoneId: number | null) => {
      await saveSpatialEntity('circles', circleId, { zoneId } as never)
    },
    [],
  )

  const handleToggleCircleVisible = useCallback(
    async (id: number, visible: boolean) => {
      await saveSpatialEntity('circles', id, { visible, updatedAt: new Date() } as never)
    },
    [],
  )

  return {
    handleCircleClick,
    handleSelectCircle,
    handleFitToCircleById,
    handleDeleteCircleById,
    handleDuplicateCircle,
    handleExitCirclePlacement,
    handleStartMoveCircle,
    handleStartRotateCircle,
    handleCancelCircleTransform,
    handleCircleTransformChange,
    handleCircleConfigChange,
    handleCirclePatch,
    handleRenameCircle,
    handleAssignCircleToZone,
    handleToggleCircleVisible,
  }
}
