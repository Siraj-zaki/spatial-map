import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import { saveSpatialEntity } from '@/lib/spatial-store'
import type MapboxDraw from '@mapbox/mapbox-gl-draw'
import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { apiDb, deleteBinsForGrid } from '@/lib/api-db'
import { type Grid } from '@/lib/db'
import {
  duplicateGrid,
  exportGridsAsGeoJSON,
  exportMapAsPNG,
  fitMapToGrids,
  gridBbox,
  renameGrid as renameGridInDb,
  updateGridConfig,
  updateGridGeometry,
} from '@/lib/export'
import { fitBoundsIfOffscreen } from './fitToShapeOnSelect'
import { DRAW_GRID_MODE_NAME } from '@/lib/grid-draw-mode'
import { type GridConfig } from '@/lib/grid-generators'
import { gridHistory } from '@/lib/grid-history'
import { queryCache } from '@/lib/useApiQuery'

import type {
  GridTransform,
  GridTransformDraft,
} from '../state/useGridEditorState'

type SelectedBin =
  | { gridId: number; row: number; col: number; level: number }
  | null

/**
 * All grid (rack) CRUD + selection + transform handlers. Grids are
 * the most complex kind because they combine:
 *   - the map-click bin editor (`handleCellClick`)
 *   - a MapboxDraw-based redraw path (`handleRedraw`)
 *   - three transform modes (move / rotate / scale) with a shared
 *     draft (`handleTransformMove`) that persists geometry + rotation
 *     on commit
 *   - a delete cascade that also purges linked bins
 *   - undo history via `gridHistory.push({ type: 'delete', ... })`
 *
 * `handleRedraw` seeds the grid-draw hook's state directly through
 * the setters exposed by `useGridDrawTool` — the ref `drawRef` +
 * `queueMicrotask` dance is preserved so the mode change fires
 * AFTER React commits the state.
 */
export function useGridHandlers({
  mapInstance,
  drawRef,
  savedGrids,
  selectedGrid,
  selectedGridIds,
  transform,
  transformDraft,
  setSelectedGridIds,
  setSelectedBin,
  setRedrawingGridId,
  setConfig,
  setLiveStart,
  setLiveCurrent,
  setHasAnchor,
  setDrawMode,
  setTransform,
  setTransformDraft,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedStairIds,
  setSelectedDoorIds,
  setSelectedTextLabelIds,
}: {
  mapInstance: MapboxMapInstance | null
  drawRef: MutableRefObject<MapboxDraw | null>
  savedGrids: ReadonlyArray<Grid>
  selectedGrid: Grid | null
  selectedGridIds: Set<number>
  transform: GridTransform
  transformDraft: GridTransformDraft
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedBin: Dispatch<SetStateAction<SelectedBin>>
  setRedrawingGridId: Dispatch<SetStateAction<number | null>>
  setConfig: Dispatch<SetStateAction<GridConfig>>
  setLiveStart: Dispatch<SetStateAction<[number, number] | null>>
  setLiveCurrent: Dispatch<SetStateAction<[number, number] | null>>
  setHasAnchor: Dispatch<SetStateAction<boolean>>
  setDrawMode: Dispatch<SetStateAction<boolean>>
  setTransform: Dispatch<SetStateAction<GridTransform>>
  setTransformDraft: Dispatch<SetStateAction<GridTransformDraft>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedDoorIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedTextLabelIds: Dispatch<SetStateAction<Set<number>>>
}) {
  const handleCellClick = useCallback(
    (gridId: number, row: number, col: number, level: number, e: MouseEvent) => {
      // Selecting a grid clears any other-kind selection — only one
      // kind of shape can be the active editing target at a time.
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        // Shift / Cmd / Ctrl-click is a multi-select gesture on grids,
        // not a bin click. Keep the bin editor closed.
        setSelectedBin(null)
        setSelectedGridIds((prev) => {
          const next = new Set(prev)
          if (next.has(gridId)) next.delete(gridId)
          else next.add(gridId)
          return next
        })
        return
      }
      // Plain click: select the grid AND open the bin editor for the
      // clicked cell. If we have valid row/col, the BinEditor renders
      // a floating card over the map. `level` defaults to 0 for
      // single-level grids and is read off the clicked feature for
      // multi-level pallet racks.
      setSelectedGridIds(new Set([gridId]))
      if (row >= 0 && col >= 0) {
        setSelectedBin({ gridId, row, col, level })
      }
    },
    [
      setSelectedMarkerIds,
      setSelectedCircleIds,
      setSelectedPolygonIds,
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedBin,
      setSelectedGridIds,
    ],
  )

  const handleMapClickEmpty = useCallback(() => {
    setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
    setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
    setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
    setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
    setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
    setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
    setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
    setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
    setSelectedDoorIds((prev) => (prev.size > 0 ? new Set() : prev))
    setSelectedTextLabelIds((prev) => (prev.size > 0 ? new Set() : prev))
    // Empty clicks dismiss the bin editor too — otherwise it stays
    // open after the user clicks blank canvas to deselect a rack.
    setSelectedBin(null)
  }, [
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedImageIds,
    setSelectedModelIds,
    setSelectedStairIds,
    setSelectedDoorIds,
    setSelectedTextLabelIds,
    setSelectedBin,
  ])

  const handleDeselect = useCallback(() => {
    setSelectedGridIds(new Set())
  }, [setSelectedGridIds])

  const handleDeleteSelected = useCallback(async () => {
    const ids = [...selectedGridIds]
    if (ids.length === 0) return
    // Snapshot for undo.
    const grids = await Promise.all(ids.map((id) => apiDb.grids.get(id)))
    const ok = grids.filter((g): g is Grid => g !== undefined)
    gridHistory.push({ type: 'delete', grids: ok })
    await Promise.all(ids.map((id) => apiDb.grids.delete(id)))
    queryCache.invalidate('grids')
    setSelectedGridIds(new Set())
  }, [selectedGridIds, setSelectedGridIds])

  const handleDuplicate = useCallback(
    async (id: number) => {
      const newId = await duplicateGrid(id)
      if (newId !== null) setSelectedGridIds(new Set([newId]))
    },
    [setSelectedGridIds],
  )

  const handleRedraw = useCallback(
    (id: number) => {
      const orig = savedGrids.find((g) => g.id === id)
      if (!orig) return
      setRedrawingGridId(id)
      setConfig(orig.config)
      setLiveStart(orig.start)
      setLiveCurrent(orig.current)
      setHasAnchor(true)
      setDrawMode(true)
      setSelectedGridIds(new Set())
      // Defer the mode change so the state is committed first.
      queueMicrotask(() => {
        const draw = drawRef.current
        if (draw)
          draw.changeMode(DRAW_GRID_MODE_NAME, {
            config: orig.config,
            start: orig.start,
          })
      })
    },
    [
      savedGrids,
      drawRef,
      setRedrawingGridId,
      setConfig,
      setLiveStart,
      setLiveCurrent,
      setHasAnchor,
      setDrawMode,
      setSelectedGridIds,
    ],
  )

  const handleRename = useCallback(async (id: number, name: string) => {
    await renameGridInDb(id, name)
  }, [])

  const handleFitToGrid = useCallback(() => {
    if (!mapInstance) return
    const ids = [...selectedGridIds]
    const grids = savedGrids.filter(
      (g): g is Grid => g.id !== undefined && ids.includes(g.id),
    )
    fitMapToGrids(mapInstance, grids)
  }, [mapInstance, selectedGridIds, savedGrids])

  // ---- Move/rotate/scale transform ---------------------------------------
  const handleStartMove = useCallback(
    (id: number) => {
      const g = savedGrids.find((x) => x.id === id)
      if (!g) return
      setTransform({ gridId: id, kind: 'move' })
      setTransformDraft({
        gridId: id,
        start: g.start,
        current: g.current,
        rotation: g.config.rotation,
      })
    },
    [savedGrids, setTransform, setTransformDraft],
  )

  const handleStartRotate = useCallback(
    (id: number) => {
      const g = savedGrids.find((x) => x.id === id)
      if (!g) return
      setTransform({ gridId: id, kind: 'rotate' })
      setTransformDraft({
        gridId: id,
        start: g.start,
        current: g.current,
        rotation: g.config.rotation,
      })
    },
    [savedGrids, setTransform, setTransformDraft],
  )

  const handleStartScale = useCallback(
    (id: number) => {
      const g = savedGrids.find((x) => x.id === id)
      if (!g) return
      setTransform({ gridId: id, kind: 'scale' })
      setTransformDraft({
        gridId: id,
        start: g.start,
        current: g.current,
        rotation: g.config.rotation,
      })
    },
    [savedGrids, setTransform, setTransformDraft],
  )

  const handleCancelTransform = useCallback(() => {
    setTransform(null)
    setTransformDraft(null)
  }, [setTransform, setTransformDraft])

  const handleTransformMove = useCallback(
    async (
      newStart: [number, number],
      newCurrent: [number, number],
      newRotation: number,
      commit: boolean,
    ) => {
      if (!transformDraft) return
      // Snapshot the kind so we know if this is a rotate or move.
      // We commit rotation changes whenever the new rotation differs
      // from the original — the optimization to skip the update when
      // the value matches the draft rotation is tricky because the
      // draft is overwritten on every mousemove.
      const kind = transform?.kind
      setTransformDraft({
        ...transformDraft,
        start: newStart,
        current: newCurrent,
        rotation: newRotation,
      })
      if (commit) {
        const id = transformDraft.gridId
        await updateGridGeometry(id, newStart, newCurrent)
        // For rotate transforms, always persist the rotation. For
        // move-only transforms, the rotation never changes so skip.
        if (kind === 'rotate') {
          const g = savedGrids.find((x) => x.id === id)
          if (g) {
            await updateGridConfig(id, { ...g.config, rotation: newRotation })
          }
        }
        setTransform(null)
        setTransformDraft(null)
      }
    },
    [transformDraft, transform, savedGrids, setTransform, setTransformDraft],
  )

  const handleExportGeoJSON = useCallback(() => {
    const ids = [...selectedGridIds]
    const grids = savedGrids.filter(
      (g): g is Grid => g.id !== undefined && ids.includes(g.id),
    )
    exportGridsAsGeoJSON(grids)
  }, [selectedGridIds, savedGrids])

  const handleExportPNG = useCallback(() => {
    if (!mapInstance) return
    const name = selectedGrid?.name ?? `map-${Date.now()}`
    exportMapAsPNG(mapInstance, name)
  }, [mapInstance, selectedGrid])

  // ---- Per-grid list actions (from the Saved Grids panel section) --------
  const handleSelectGrid = useCallback(
    (id: number, additive: boolean) => {
      // Selecting a grid clears any other-kind selection so the sidebar
      // mode switches to grid-selected.
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedImageIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedGridIds((prev) => {
        if (additive) {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      // Sidebar list selection often happens when the user is looking at a
      // different location or is zoomed out — the map click path never lands
      // here since that goes through handleCellClick. Fly to the rack unless
      // any corner is already on screen so the user isn't stranded staring
      // at the wrong location.
      const g = savedGrids.find((x) => x.id === id)
      if (g) {
        fitBoundsIfOffscreen(mapInstance, gridBbox(g), { additive })
      }
    },
    [
      setSelectedMarkerIds,
      setSelectedCircleIds,
      setSelectedPolygonIds,
      setSelectedLineIds,
      setSelectedImageIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedGridIds,
      mapInstance,
      savedGrids,
    ],
  )

  const handleFitToGridById = useCallback(
    (id: number) => {
      if (!mapInstance) return
      const g = savedGrids.find((x) => x.id === id)
      if (!g) return
      fitMapToGrids(mapInstance, [g])
    },
    [mapInstance, savedGrids],
  )

  const handleDeleteGridById = useCallback(
    async (id: number) => {
      const g = await apiDb.grids.get(id)
      if (!g) return
      gridHistory.push({ type: 'delete', grids: [g] })
      await apiDb.grids.delete(id)
      queryCache.invalidate('grids')
      // Cascade the bins so we don't leak rows referencing a deleted grid.
      // The undo path for grid delete doesn't restore bins — that's a known
      // tradeoff; the bin data is user-entered and "should be re-applied"
      // by the user after a delete-undo cycle if it matters to them.
      await deleteBinsForGrid(id)
      queryCache.invalidate('bins')
      setSelectedGridIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setSelectedBin((prev) => (prev && prev.gridId === id ? null : prev))
    },
    [setSelectedGridIds, setSelectedBin],
  )

  const handleAssignGridToZone = useCallback(
    async (gridId: number, zoneId: number | null) => {
      await saveSpatialEntity('grids', gridId, { zoneId } as never)
    },
    [],
  )

  /**
   * Per-rack layer visibility toggle. Mirrors handleToggleImageVisible on
   * the image side: hides bins + labels + selection outline for one rack
   * without touching the row so the user can flip it back on later.
   */
  const handleToggleGridVisible = useCallback(
    async (id: number, visible: boolean) => {
      await saveSpatialEntity('grids', id, { visible, updatedAt: new Date() } as never)
    },
    [],
  )

  return {
    handleCellClick,
    handleMapClickEmpty,
    handleDeselect,
    handleDeleteSelected,
    handleDuplicate,
    handleRedraw,
    handleRename,
    handleFitToGrid,
    handleStartMove,
    handleStartRotate,
    handleStartScale,
    handleCancelTransform,
    handleTransformMove,
    handleExportGeoJSON,
    handleExportPNG,
    handleSelectGrid,
    handleFitToGridById,
    handleDeleteGridById,
    handleToggleGridVisible,
    handleAssignGridToZone,
  }
}
