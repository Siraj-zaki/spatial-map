import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import {
  type BulkAssignPatch,
  type BulkAssignSelection,
} from '@/components/bulk-assign-dialog'
import { apiDb } from '@/lib/api-db'
import { apiPost } from '@/lib/api-client'
import type { DoorConfig, DoorShape } from '@/lib/door/types'
import { useDoorStore } from '@/lib/door/store'
import { gridHistory } from '@/lib/grid-history'
import {
  type CircleShape,
  type FillShapeConfig,
  type ImageShape,
  type ImageShapeConfig,
  type LineShape,
  type LineShapeConfig,
  type MarkerShape,
  type MarkerShapeConfig,
  type ModelShape,
  type ModelShapeConfig,
  type PolygonShape,
  type StairShape,
  type StairShapeConfig,
  type TextLabelConfig,
  type TextLabelShape,
} from '@/lib/shapes'
import { patchSpatialEntity, useSpatialStore } from '@/lib/spatial-store'
import { queryCache } from '@/lib/useApiQuery'

/**
 * All bulk handlers — delete / fit-to-selection / patch-config across
 * 9 shape kinds (marker, circle, polygon, line, stair, door, model,
 * text-label, image) plus `handleApplyBulkAssign` which POSTs the
 * whole selection to `/bulk-assign` in ONE round trip.
 *
 * `fitToBoundsForVertices` is the shared helper every `handleBulkFit*`
 * feeds a point list into. Padding + duration + maxZoom are the same
 * across all kinds so consolidating avoids repeating the same
 * `mapInstance.fitBounds(...)` call ten times.
 *
 * The bulk-assign body uses tri-state fields: `undefined` = skip,
 * `null` = clear, `number` = assign. The backend's
 * `parseBulkAssignField` distinguishes all three via `json.RawMessage`,
 * so an absent field never clobbers zone_id / floor_plan_id
 * unintentionally. Doors are invalidated separately via
 * `useDoorStore.loadForWarehouse` because they don't ride the
 * spatial-store's queryCache.
 */
export function useBulkHandlers({
  mapInstance,
  savedMarkers,
  savedCircles,
  savedPolygons,
  savedLines,
  savedStairs,
  savedModels,
  savedTextLabels,
  savedImages,
  doors,
  selectedMarkerIds,
  selectedCircleIds,
  selectedPolygonIds,
  selectedLineIds,
  selectedStairIds,
  selectedDoorIds,
  selectedModelIds,
  selectedTextLabelIds,
  selectedImageIds,
  activeWarehouseIdRef,
  deleteDoorInStore,
  updateDoorConfigInStore,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedStairIds,
  setSelectedDoorIds,
  setSelectedModelIds,
  setSelectedTextLabelIds,
  setSelectedImageIds,
}: {
  mapInstance: MapboxMapInstance | null
  savedMarkers: MarkerShape[]
  savedCircles: CircleShape[]
  savedPolygons: PolygonShape[]
  savedLines: LineShape[]
  savedStairs: StairShape[]
  savedModels: ModelShape[]
  savedTextLabels: TextLabelShape[]
  savedImages: ImageShape[]
  doors: DoorShape[]
  selectedMarkerIds: Set<number>
  selectedCircleIds: Set<number>
  selectedPolygonIds: Set<number>
  selectedLineIds: Set<number>
  selectedStairIds: Set<number>
  selectedDoorIds: Set<number>
  selectedModelIds: Set<number>
  selectedTextLabelIds: Set<number>
  selectedImageIds: Set<number>
  activeWarehouseIdRef: MutableRefObject<number | null>
  deleteDoorInStore: (id: number) => void
  updateDoorConfigInStore: (id: number, config: DoorConfig) => void
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedDoorIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedTextLabelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
}) {
  const fitToBoundsForVertices = useCallback(
    (allPoints: Array<[number, number]>) => {
      if (!mapInstance || allPoints.length === 0) return
      let minLng = Infinity
      let minLat = Infinity
      let maxLng = -Infinity
      let maxLat = -Infinity
      for (const p of allPoints) {
        if (p[0] < minLng) minLng = p[0]
        if (p[1] < minLat) minLat = p[1]
        if (p[0] > maxLng) maxLng = p[0]
        if (p[1] > maxLat) maxLat = p[1]
      }
      if (!isFinite(minLng)) return
      mapInstance.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 60, duration: 600, maxZoom: 18 },
      )
    },
    [mapInstance],
  )

  // ---- Markers -----------------------------------------------------------
  const handleBulkDeleteMarkers = useCallback(() => {
    const ids = [...selectedMarkerIds]
    if (ids.length === 0) return
    void (async () => {
      const rows = await Promise.all(ids.map((id) => apiDb.markers.get(id)))
      const ok = rows.filter((r): r is MarkerShape => r !== undefined)
      if (ok.length > 0) gridHistory.push({ type: 'delete-marker', markers: ok })
      await Promise.all(ids.map((id) => apiDb.markers.delete(id)))
      queryCache.invalidate('markers')
      setSelectedMarkerIds(new Set())
    })()
  }, [selectedMarkerIds, setSelectedMarkerIds])
  const handleBulkFitMarkers = useCallback(() => {
    const pts: Array<[number, number]> = []
    for (const m of savedMarkers) {
      if (m.id !== undefined && selectedMarkerIds.has(m.id)) pts.push(m.position)
    }
    fitToBoundsForVertices(pts)
  }, [selectedMarkerIds, savedMarkers, fitToBoundsForVertices])
  const handleBulkPatchMarkers = useCallback(
    (patch: Partial<MarkerShapeConfig>) => {
      if (selectedMarkerIds.size === 0) return
      const now = new Date()
      for (const m of savedMarkers) {
        if (m.id === undefined || !selectedMarkerIds.has(m.id)) continue
        void patchSpatialEntity('markers', m.id, {
          config: { ...m.config, ...patch },
          updatedAt: now,
        })
      }
    },
    [selectedMarkerIds, savedMarkers],
  )

  // ---- Circles -----------------------------------------------------------
  const handleBulkDeleteCircles = useCallback(() => {
    const ids = [...selectedCircleIds]
    if (ids.length === 0) return
    void (async () => {
      const rows = await Promise.all(ids.map((id) => apiDb.circles.get(id)))
      const ok = rows.filter((r): r is CircleShape => r !== undefined)
      if (ok.length > 0) gridHistory.push({ type: 'delete-circle', circles: ok })
      await Promise.all(ids.map((id) => apiDb.circles.delete(id)))
      queryCache.invalidate('circles')
      setSelectedCircleIds(new Set())
    })()
  }, [selectedCircleIds, setSelectedCircleIds])
  const handleBulkFitCircles = useCallback(() => {
    const pts: Array<[number, number]> = []
    for (const c of savedCircles) {
      if (c.id === undefined || !selectedCircleIds.has(c.id)) continue
      if (c.mode === 'single' && c.center) pts.push(c.center)
      else if (c.mode === 'grid' && c.start && c.current) {
        pts.push(c.start)
        pts.push(c.current)
      }
    }
    fitToBoundsForVertices(pts)
  }, [selectedCircleIds, savedCircles, fitToBoundsForVertices])
  const handleBulkPatchCircles = useCallback(
    (patch: Partial<FillShapeConfig>) => {
      if (selectedCircleIds.size === 0) return
      const now = new Date()
      for (const c of savedCircles) {
        if (c.id === undefined || !selectedCircleIds.has(c.id)) continue
        void patchSpatialEntity('circles', c.id, {
          config: { ...c.config, ...patch },
          updatedAt: now,
        })
      }
    },
    [selectedCircleIds, savedCircles],
  )

  // ---- Polygons ----------------------------------------------------------
  const handleBulkDeletePolygons = useCallback(() => {
    const ids = [...selectedPolygonIds]
    if (ids.length === 0) return
    void (async () => {
      const rows = await Promise.all(ids.map((id) => apiDb.polygons.get(id)))
      const ok = rows.filter((r): r is PolygonShape => r !== undefined)
      if (ok.length > 0) gridHistory.push({ type: 'delete-polygon', polygons: ok })
      await Promise.all(ids.map((id) => apiDb.polygons.delete(id)))
      queryCache.invalidate('polygons')
      setSelectedPolygonIds(new Set())
    })()
  }, [selectedPolygonIds, setSelectedPolygonIds])
  const handleBulkFitPolygons = useCallback(() => {
    const pts: Array<[number, number]> = []
    for (const p of savedPolygons) {
      if (p.id === undefined || !selectedPolygonIds.has(p.id)) continue
      pts.push(...p.vertices)
    }
    fitToBoundsForVertices(pts)
  }, [selectedPolygonIds, savedPolygons, fitToBoundsForVertices])
  /**
   * Apply a partial FillShapeConfig patch to every selected polygon.
   * Each polygon's config is merged with the patch — fields not in the
   * patch keep that polygon's own value. Sidebar uses this to bulk-edit
   * shared attributes (border, opacity, elevation) without flattening
   * per-shape differences.
   */
  const handleBulkPatchPolygons = useCallback(
    (patch: Partial<FillShapeConfig>) => {
      if (selectedPolygonIds.size === 0) return
      const now = new Date()
      for (const p of savedPolygons) {
        if (p.id === undefined || !selectedPolygonIds.has(p.id)) continue
        void patchSpatialEntity('polygons', p.id, {
          config: { ...p.config, ...patch },
          updatedAt: now,
        })
      }
    },
    [selectedPolygonIds, savedPolygons],
  )

  // ---- Lines -------------------------------------------------------------
  const handleBulkDeleteLines = useCallback(() => {
    const ids = [...selectedLineIds]
    if (ids.length === 0) return
    void (async () => {
      const rows = await Promise.all(ids.map((id) => apiDb.lines.get(id)))
      const ok = rows.filter((r): r is LineShape => r !== undefined)
      if (ok.length > 0) gridHistory.push({ type: 'delete-line', lines: ok })
      await Promise.all(ids.map((id) => apiDb.lines.delete(id)))
      queryCache.invalidate('lines')
      setSelectedLineIds(new Set())
    })()
  }, [selectedLineIds, setSelectedLineIds])
  const handleBulkFitLines = useCallback(() => {
    const pts: Array<[number, number]> = []
    for (const ln of savedLines) {
      if (ln.id === undefined || !selectedLineIds.has(ln.id)) continue
      pts.push(...ln.vertices)
    }
    fitToBoundsForVertices(pts)
  }, [selectedLineIds, savedLines, fitToBoundsForVertices])
  const handleBulkPatchLines = useCallback(
    (patch: Partial<LineShapeConfig>) => {
      if (selectedLineIds.size === 0) return
      const now = new Date()
      for (const ln of savedLines) {
        if (ln.id === undefined || !selectedLineIds.has(ln.id)) continue
        void patchSpatialEntity('lines', ln.id, {
          config: { ...ln.config, ...patch },
          updatedAt: now,
        })
      }
    },
    [selectedLineIds, savedLines],
  )

  // ---- Stairs ------------------------------------------------------------
  const handleBulkDeleteStairs = useCallback(() => {
    const ids = [...selectedStairIds]
    if (ids.length === 0) return
    void (async () => {
      await Promise.all(ids.map((id) => apiDb.stairs.delete(id)))
      queryCache.invalidate('stairs')
      setSelectedStairIds(new Set())
    })()
  }, [selectedStairIds, setSelectedStairIds])
  const handleBulkFitStairs = useCallback(() => {
    const pts: Array<[number, number]> = []
    for (const s of savedStairs) {
      if (s.id === undefined || !selectedStairIds.has(s.id)) continue
      pts.push(...s.vertices)
    }
    fitToBoundsForVertices(pts)
  }, [selectedStairIds, savedStairs, fitToBoundsForVertices])
  const handleBulkPatchStairs = useCallback(
    (patch: Partial<StairShapeConfig>) => {
      if (selectedStairIds.size === 0) return
      const now = new Date()
      for (const s of savedStairs) {
        if (s.id === undefined || !selectedStairIds.has(s.id)) continue
        void patchSpatialEntity('stairs', s.id, {
          config: { ...s.config, ...patch },
          updatedAt: now,
        })
      }
    },
    [selectedStairIds, savedStairs],
  )

  // ---- Doors -------------------------------------------------------------
  const handleBulkDeleteDoors = useCallback(() => {
    const ids = [...selectedDoorIds]
    if (ids.length === 0) return
    for (const id of ids) deleteDoorInStore(id)
    setSelectedDoorIds(new Set())
  }, [selectedDoorIds, deleteDoorInStore, setSelectedDoorIds])
  const handleBulkFitDoors = useCallback(() => {
    const pts: Array<[number, number]> = []
    for (const d of doors) {
      if (d.id === undefined || !selectedDoorIds.has(d.id)) continue
      pts.push(...d.vertices)
    }
    fitToBoundsForVertices(pts)
  }, [selectedDoorIds, doors, fitToBoundsForVertices])
  const handleBulkPatchDoors = useCallback(
    (patch: Partial<DoorConfig>) => {
      if (selectedDoorIds.size === 0) return
      for (const d of doors) {
        if (d.id === undefined || !selectedDoorIds.has(d.id)) continue
        // Doors live in useDoorStore (separate from spatial-store) — merge
        // the patch through its updateDoorConfig action.
        updateDoorConfigInStore(d.id, { ...d.config, ...patch })
      }
    },
    [selectedDoorIds, doors, updateDoorConfigInStore],
  )

  // ---- Models ------------------------------------------------------------
  const handleBulkDeleteModels = useCallback(() => {
    const ids = [...selectedModelIds]
    if (ids.length === 0) return
    void (async () => {
      await Promise.all(ids.map((id) => apiDb.models.delete(id)))
      queryCache.invalidate('models')
      setSelectedModelIds(new Set())
    })()
  }, [selectedModelIds, setSelectedModelIds])
  const handleBulkFitModels = useCallback(() => {
    const pts: Array<[number, number]> = []
    for (const m of savedModels) {
      if (m.id === undefined || !selectedModelIds.has(m.id)) continue
      pts.push([m.position[0], m.position[1]])
    }
    fitToBoundsForVertices(pts)
  }, [selectedModelIds, savedModels, fitToBoundsForVertices])
  const handleBulkPatchModels = useCallback(
    (patch: Partial<ModelShapeConfig>) => {
      if (selectedModelIds.size === 0) return
      const now = new Date()
      for (const m of savedModels) {
        if (m.id === undefined || !selectedModelIds.has(m.id)) continue
        void patchSpatialEntity('models', m.id, {
          config: { ...m.config, ...patch },
          updatedAt: now,
        })
      }
    },
    [selectedModelIds, savedModels],
  )

  // ---- Text labels -------------------------------------------------------
  const handleBulkDeleteTextLabels = useCallback(() => {
    const ids = [...selectedTextLabelIds]
    if (ids.length === 0) return
    void (async () => {
      await Promise.all(ids.map((id) => apiDb.textLabels.delete(id)))
      queryCache.invalidate('text-labels')
      setSelectedTextLabelIds(new Set())
    })()
  }, [selectedTextLabelIds, setSelectedTextLabelIds])
  const handleBulkFitTextLabels = useCallback(() => {
    const pts: Array<[number, number]> = []
    for (const l of savedTextLabels) {
      if (l.id === undefined || !selectedTextLabelIds.has(l.id)) continue
      pts.push([l.position[0], l.position[1]])
    }
    fitToBoundsForVertices(pts)
  }, [selectedTextLabelIds, savedTextLabels, fitToBoundsForVertices])
  const handleBulkPatchTextLabels = useCallback(
    (patch: Partial<TextLabelConfig>) => {
      if (selectedTextLabelIds.size === 0) return
      const now = new Date()
      for (const l of savedTextLabels) {
        if (l.id === undefined || !selectedTextLabelIds.has(l.id)) continue
        void patchSpatialEntity('text-labels', l.id, {
          config: { ...l.config, ...patch },
          updatedAt: now,
        })
      }
    },
    [selectedTextLabelIds, savedTextLabels],
  )

  // ---- Images ------------------------------------------------------------
  const handleBulkDeleteImages = useCallback(() => {
    const ids = [...selectedImageIds]
    if (ids.length === 0) return
    void (async () => {
      await Promise.all(ids.map((id) => apiDb.images.delete(id)))
      queryCache.invalidate('images')
      setSelectedImageIds(new Set())
    })()
  }, [selectedImageIds, setSelectedImageIds])
  const handleBulkFitImages = useCallback(() => {
    const pts: Array<[number, number]> = []
    for (const img of savedImages) {
      if (img.id === undefined || !selectedImageIds.has(img.id)) continue
      pts.push(img.start)
      pts.push(img.current)
    }
    fitToBoundsForVertices(pts)
  }, [selectedImageIds, savedImages, fitToBoundsForVertices])
  const handleBulkPatchImages = useCallback(
    (patch: Partial<ImageShapeConfig>) => {
      if (selectedImageIds.size === 0) return
      const now = new Date()
      for (const img of savedImages) {
        if (img.id === undefined || !selectedImageIds.has(img.id)) continue
        void patchSpatialEntity('images', img.id, {
          config: { ...img.config, ...patch },
          updatedAt: now,
        })
      }
    },
    [selectedImageIds, savedImages],
  )

  /**
   * Apply the user's bulk-assign patch to the dialog's checked items
   * in ONE backend round trip. `selection` is the dialog's local
   * state (independent from the map / sidebar selection); `patch`
   * names the zone and/or floor-plan destination (each field:
   * undefined = skip, null = clear, number = assign).
   *
   * The previous per-id `apiDb.X.update` loop turned a 200-item
   * selection into 200 sequential HTTP calls + 200 SSE broadcasts.
   * This hits `POST /api/v1/bulk-assign` once with the full id list
   * per kind — the backend runs a single `UPDATE ... WHERE id =
   * ANY($ids)` per kind and broadcasts one SSE per row.
   */
  const handleApplyBulkAssign = useCallback(
    async (selection: BulkAssignSelection, patch: BulkAssignPatch) => {
      const body: {
        zoneId?: number | null
        floorPlanId?: number | null
        kinds: Record<string, number[]>
      } = { kinds: {} }
      if (patch.zoneId !== undefined) body.zoneId = patch.zoneId
      if (patch.floorPlanId !== undefined) body.floorPlanId = patch.floorPlanId
      if (body.zoneId === undefined && body.floorPlanId === undefined) return

      const pushKind = (key: string, ids: ReadonlySet<number>) => {
        if (ids.size === 0) return
        body.kinds[key] = [...ids]
      }
      pushKind('polygon', selection.polygon)
      pushKind('grid', selection.grid)
      pushKind('marker', selection.marker)
      pushKind('circle', selection.circle)
      pushKind('line', selection.line)
      pushKind('model', selection.model)
      pushKind('stair', selection.stair)
      pushKind('text_label', selection.text)
      pushKind('image', selection.image)
      pushKind('door', selection.door)
      pushKind('image_plane', selection.imagePlane)

      if (Object.keys(body.kinds).length === 0) return

      try {
        await apiPost('/bulk-assign', body)
      } catch (err) {
        console.warn('[CreateGrids] bulk-assign failed', err)
        return
      }
      // Invalidate every touched kind so the next fetch picks up the
      // new zone_id / floor_plan_id. SSE will also nudge each
      // subscribed client, but this keeps the current tab responsive
      // without waiting for the round trip.
      const invalidations: string[] = []
      if (selection.grid.size > 0) invalidations.push('grids')
      if (selection.marker.size > 0) invalidations.push('markers')
      if (selection.circle.size > 0) invalidations.push('circles')
      if (selection.polygon.size > 0) invalidations.push('polygons')
      if (selection.line.size > 0) invalidations.push('lines')
      if (selection.model.size > 0) invalidations.push('models')
      if (selection.stair.size > 0) invalidations.push('stairs')
      if (selection.text.size > 0) invalidations.push('text-labels')
      if (selection.image.size > 0) invalidations.push('images')
      if (selection.door.size > 0) invalidations.push('doors')
      if (selection.imagePlane.size > 0) invalidations.push('image-planes')
      for (const key of invalidations) queryCache.invalidate(key)
      // Doors don't ride the spatial-store's queryCache — the door
      // store keeps its own copy in localStorage, so kick a reload
      // for the current warehouse so its cache picks up the moved
      // rows.
      if (selection.door.size > 0) {
        const wid = activeWarehouseIdRef.current
        if (wid !== null) {
          void useDoorStore.getState().loadForWarehouse(wid)
        }
      }
      // Image planes ride the spatial store (not queryCache), so
      // queryCache.invalidate alone doesn't refresh them. Kick a
      // full kind reload so the updated floor_plan_id shows up
      // immediately.
      if (selection.imagePlane.size > 0) {
        void useSpatialStore.getState().loadKind('image-planes')
      }
    },
    [activeWarehouseIdRef],
  )

  return {
    fitToBoundsForVertices,
    handleBulkDeleteMarkers,
    handleBulkFitMarkers,
    handleBulkPatchMarkers,
    handleBulkDeleteCircles,
    handleBulkFitCircles,
    handleBulkPatchCircles,
    handleBulkDeletePolygons,
    handleBulkFitPolygons,
    handleBulkPatchPolygons,
    handleBulkDeleteLines,
    handleBulkFitLines,
    handleBulkPatchLines,
    handleBulkDeleteStairs,
    handleBulkFitStairs,
    handleBulkPatchStairs,
    handleBulkDeleteDoors,
    handleBulkFitDoors,
    handleBulkPatchDoors,
    handleBulkDeleteModels,
    handleBulkFitModels,
    handleBulkPatchModels,
    handleBulkDeleteTextLabels,
    handleBulkFitTextLabels,
    handleBulkPatchTextLabels,
    handleBulkDeleteImages,
    handleBulkFitImages,
    handleBulkPatchImages,
    handleApplyBulkAssign,
  }
}
