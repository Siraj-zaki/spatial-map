import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'

import type { DoorShape } from '@/lib/door/types'
import { nudgeDoorVerticesLocal, resizeDoorVertices, rotateDoorVertices } from '@/lib/door/generators'
import { type Grid } from '@/lib/db'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { nudgeVerticesAlongHeading } from '@/lib/shape-nudge'
import {
  type CircleShape,
  type ImageShape,
  type LineShape,
  type MarkerShape,
  type ModelShape,
  type ModelShapeConfig,
  type PolygonShape,
  type StairShape,
  type TextLabelShape,
} from '@/lib/shapes'
import { getSpatialEntity, patchSpatialEntity, updateSpatialLatest, type CatalogEntity, type EntityKind } from '@/lib/spatial-store'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { gridHistory } from '@/lib/grid-history'
import { toast } from '@/lib/toast-store'
import i18n from '@/i18n'

/** A selected shape's latest value from the store (row + unsaved edits), falling back to the render-time copy. */
function latestOf<T extends CatalogEntity>(kind: EntityKind, shape: T): T {
  return shape.id !== undefined ? (getSpatialEntity<T>(kind, shape.id) ?? shape) : shape
}


const METERS_PER_DEG_LAT = 111320
const NUDGE_METERS_SMALL = 0.5
const NUDGE_METERS_BIG = 5

/** Meters → lng/lat delta. Good enough for warehouse-scale nudges. */
function nudgeMetersToLngLat(
  lat: number,
  dxMeters: number,
  dyMeters: number,
): [number, number] {
  const latRad = (lat * Math.PI) / 180
  const dLng = dxMeters / (METERS_PER_DEG_LAT * Math.cos(latRad))
  const dLat = dyMeters / METERS_PER_DEG_LAT
  return [dLng, dLat]
}

/**
 * Cross-kind keyboard dispatch + shortcut wiring. Owns:
 *   - `handleNudge` — arrow keys move the currently-selected shape.
 *     Point-based kinds (marker/model) move in world-frame; vertex
 *     kinds (polygon/line/stair/grid/image) rotate the delta into the
 *     shape's local frame via `nudgeVerticesAlongHeading` so arrow
 *     keys track "along the wall" instead of world north. Text has
 *     no vertices so its local frame comes from the floor plan's
 *     rotation + its own `rotation` field.
 *   - `handleRotateSelected` / `handleScaleSelected` /
 *     `handleElevationSelected` — R / T / S / D / +/- / bracket keys.
 *   - `handleDeleteAnySelected` / `handleDuplicateAnySelected` — pick
 *     the first non-empty selection set and route to the matching
 *     per-kind handler.
 *   - Three refs (`inProgressDrawRef`, `transformActiveRef`,
 *     `selectionTotalRef`) that the `useKeyboardShortcuts` internal
 *     keydown handler reads at fire time to sidestep stale closures.
 *   - The `useKeyboardShortcuts` call itself, which returns
 *     `keyboardState` (holds `shiftHeld`, `altHeld`, `cheatsheetOpen`,
 *     `setCheatsheetOpen`).
 */
export function useKeyboardDispatch({
  preview,
  drawMode,
  polygonDraftVertices,
  lineDraftVertices,
  stairDraftAnchors,
  circleDragStart,
  circleGridStart,
  imageDragStart,
  transform,
  markerTransform,
  polygonTransform,
  lineTransform,
  circleTransform,
  imageTransform,
  modelTransform,
  textLabelTransform,
  doorTransform,
  totalMapSelection,
  selectedGridIds,
  selectedMarkerIds,
  selectedCircleIds,
  selectedPolygonIds,
  selectedLineIds,
  selectedImageIds,
  selectedModelIds,
  selectedStairIds,
  selectedDoorIds,
  selectedMarker,
  selectedCircle,
  selectedPolygon,
  selectedLine,
  selectedImage,
  selectedModel,
  selectedStair,
  selectedTextLabel,
  selectedGrid,
  selectedDoorForPanel,
  savedImages,
  updateDoorInStore,
  setModelConfig,
  setModelLibraryMode,
  setModelLibraryOpen,
  setActiveTool,
  activeTool,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedStairIds,
  setSelectedDoorIds,
  setSelectedTextLabelIds,
  handleDeleteSelected,
  handleDeleteMarkerById,
  handleDeleteCircleById,
  handleDeletePolygonById,
  handleDeleteLineById,
  handleDeleteImageById,
  handleDeleteModelById,
  handleDeleteStairById,
  handleDeleteDoorById,
  handleDeleteTextLabelById,
  handleDuplicate,
  handleDuplicateMarker,
  handleDuplicateCircle,
  handleDuplicatePolygon,
  handleDuplicateDoor,
  handleDuplicateLine,
  handleDuplicateModel,
  handleDuplicateTextLabel,
  handleDuplicateStair,
  handleDuplicateImage,
  handleCancelTransform,
  handleRedraw,
  handleFitToGrid,
  handleDeselectAll,
  handleUndo,
  handleRedo,
  handleExportGeoJSON,
  exitDrawMode,
  undoGridPathVertex,
  finishGridPath,
}: {
  preview: boolean
  drawMode: boolean
  polygonDraftVertices: [number, number][]
  lineDraftVertices: [number, number][]
  stairDraftAnchors: [number, number][]
  circleDragStart: [number, number] | null
  circleGridStart: [number, number] | null
  imageDragStart: [number, number] | null
  transform: unknown
  markerTransform: unknown
  polygonTransform: unknown
  lineTransform: unknown
  circleTransform: unknown
  imageTransform: unknown
  modelTransform: unknown
  textLabelTransform: unknown
  doorTransform: unknown
  totalMapSelection: number
  selectedGridIds: Set<number>
  selectedMarkerIds: Set<number>
  selectedCircleIds: Set<number>
  selectedPolygonIds: Set<number>
  selectedLineIds: Set<number>
  selectedImageIds: Set<number>
  selectedModelIds: Set<number>
  selectedStairIds: Set<number>
  selectedDoorIds: Set<number>
  selectedMarker: MarkerShape | null
  selectedCircle: CircleShape | null
  selectedPolygon: PolygonShape | null
  selectedLine: LineShape | null
  selectedImage: ImageShape | null
  selectedModel: ModelShape | null
  selectedStair: StairShape | null
  selectedTextLabel: TextLabelShape | null
  selectedGrid: Grid | null
  selectedDoorForPanel: DoorShape | null
  savedImages: ImageShape[]
  updateDoorInStore: (id: number, patch: Partial<DoorShape>) => void
  setModelConfig: Dispatch<SetStateAction<ModelShapeConfig>>
  setModelLibraryMode: Dispatch<SetStateAction<'place' | 'swap'>>
  setModelLibraryOpen: Dispatch<SetStateAction<boolean>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
  /** Current tool, so a held Space can return to it on release. */
  activeTool: Tool
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedDoorIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedTextLabelIds: Dispatch<SetStateAction<Set<number>>>
  handleDeleteSelected: () => Promise<void>
  handleDeleteMarkerById: (id: number) => void
  handleDeleteCircleById: (id: number) => void
  handleDeletePolygonById: (id: number) => void
  handleDeleteLineById: (id: number) => void
  handleDeleteImageById: (id: number) => void
  handleDeleteModelById: (id: number) => void
  handleDeleteStairById: (id: number) => void
  handleDeleteDoorById: (id: number) => void
  handleDeleteTextLabelById: (id: number) => void
  handleDuplicate: (id: number) => Promise<void>
  handleDuplicateMarker: (id: number) => void
  handleDuplicateCircle: (id: number) => void
  handleDuplicatePolygon: (id: number) => void
  handleDuplicateDoor: (id: number) => void
  handleDuplicateLine: (id: number) => void
  handleDuplicateModel: (id: number) => void
  handleDuplicateTextLabel: (id: number) => void
  handleDuplicateStair: (id: number) => void
  handleDuplicateImage: (id: number) => void
  handleCancelTransform: () => void
  handleRedraw: (id: number) => void
  handleFitToGrid: () => void
  handleDeselectAll: () => void
  handleUndo: () => Promise<void>
  handleRedo: () => Promise<void>
  handleExportGeoJSON: () => void
  exitDrawMode: () => void
  /** Grid path drawing: drop the last clicked vertex. */
  undoGridPathVertex?: () => void
  finishGridPath?: () => void
}) {
  const handleDeleteAnySelected = useCallback(async () => {
    if (selectedGridIds.size > 0) {
      await handleDeleteSelected()
      return
    }
    if (selectedMarkerIds.size > 0) {
      await Promise.all([...selectedMarkerIds].map((id) => handleDeleteMarkerById(id)))
      setSelectedMarkerIds(new Set())
      return
    }
    if (selectedCircleIds.size > 0) {
      await Promise.all([...selectedCircleIds].map((id) => handleDeleteCircleById(id)))
      setSelectedCircleIds(new Set())
      return
    }
    if (selectedPolygonIds.size > 0) {
      await Promise.all([...selectedPolygonIds].map((id) => handleDeletePolygonById(id)))
      setSelectedPolygonIds(new Set())
      return
    }
    if (selectedLineIds.size > 0) {
      await Promise.all([...selectedLineIds].map((id) => handleDeleteLineById(id)))
      setSelectedLineIds(new Set())
      return
    }
    if (selectedImageIds.size > 0) {
      await Promise.all([...selectedImageIds].map((id) => handleDeleteImageById(id)))
      setSelectedImageIds(new Set())
      return
    }
    if (selectedModelIds.size > 0) {
      await Promise.all([...selectedModelIds].map((id) => handleDeleteModelById(id)))
      setSelectedModelIds(new Set())
      return
    }
    if (selectedStairIds.size > 0) {
      await Promise.all([...selectedStairIds].map((id) => handleDeleteStairById(id)))
      setSelectedStairIds(new Set())
      return
    }
    if (selectedDoorIds.size > 0) {
      for (const id of selectedDoorIds) handleDeleteDoorById(id)
      setSelectedDoorIds(new Set())
      return
    }
    if (selectedTextLabel && selectedTextLabel.id !== undefined) {
      handleDeleteTextLabelById(selectedTextLabel.id)
      setSelectedTextLabelIds(new Set())
      return
    }
  }, [
    selectedGridIds, selectedMarkerIds, selectedCircleIds, selectedPolygonIds,
    selectedLineIds, selectedImageIds, selectedModelIds, selectedStairIds,
    selectedDoorIds, selectedTextLabel,
    handleDeleteSelected, handleDeleteMarkerById, handleDeleteCircleById,
    handleDeletePolygonById, handleDeleteLineById, handleDeleteImageById,
    handleDeleteModelById, handleDeleteStairById, handleDeleteDoorById,
    handleDeleteTextLabelById, setSelectedTextLabelIds,
    setSelectedMarkerIds, setSelectedCircleIds, setSelectedPolygonIds,
    setSelectedLineIds, setSelectedImageIds, setSelectedModelIds,
    setSelectedStairIds, setSelectedDoorIds,
  ])

  const handleDuplicateAnySelected = useCallback(async () => {
    if (selectedGridIds.size === 1) {
      await handleDuplicate([...selectedGridIds][0])
      return
    }
    if (selectedMarkerIds.size === 1) {
      handleDuplicateMarker([...selectedMarkerIds][0])
      return
    }
    if (selectedCircleIds.size === 1) {
      handleDuplicateCircle([...selectedCircleIds][0])
      return
    }
    if (selectedPolygonIds.size === 1) {
      handleDuplicatePolygon([...selectedPolygonIds][0])
      return
    }
    if (selectedDoorIds.size === 1) {
      handleDuplicateDoor([...selectedDoorIds][0])
      return
    }
    if (selectedLineIds.size === 1) {
      handleDuplicateLine([...selectedLineIds][0])
      return
    }
    if (selectedModelIds.size === 1) {
      handleDuplicateModel([...selectedModelIds][0])
      return
    }
    if (selectedTextLabel && selectedTextLabel.id !== undefined) {
      handleDuplicateTextLabel(selectedTextLabel.id)
      return
    }
    if (selectedStairIds.size === 1) {
      handleDuplicateStair([...selectedStairIds][0])
      return
    }
    if (selectedImageIds.size === 1) {
      handleDuplicateImage([...selectedImageIds][0])
      return
    }
  }, [
    selectedGridIds, selectedMarkerIds, selectedCircleIds, selectedPolygonIds,
    selectedDoorIds, selectedLineIds, selectedModelIds, selectedTextLabel,
    selectedStairIds, selectedImageIds,
    handleDuplicate, handleDuplicateMarker, handleDuplicateCircle, handleDuplicatePolygon,
    handleDuplicateDoor, handleDuplicateLine, handleDuplicateModel, handleDuplicateTextLabel,
    handleDuplicateStair, handleDuplicateImage,
  ])

  const handleNudge = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down', big: boolean) => {
      const step = big ? NUDGE_METERS_BIG : NUDGE_METERS_SMALL
      const dxMeters = direction === 'left' ? -step : direction === 'right' ? step : 0
      const dyMeters = direction === 'up' ? step : direction === 'down' ? -step : 0
      const now = new Date()

      if (selectedMarker && selectedMarker.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('markers', selectedMarker)
        const [dLng, dLat] = nudgeMetersToLngLat(latest.position[1], dxMeters, dyMeters)
        void patchSpatialEntity('markers', selectedMarker.id, {
          position: [latest.position[0] + dLng, latest.position[1] + dLat],
          updatedAt: now,
        })
        return
      }
      if (selectedModel && selectedModel.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('models', selectedModel)
        const [dLng, dLat] = nudgeMetersToLngLat(latest.position[1], dxMeters, dyMeters)
        void patchSpatialEntity('models', selectedModel.id, {
          position: [latest.position[0] + dLng, latest.position[1] + dLat],
          updatedAt: now,
        })
        return
      }
      if (selectedTextLabel && selectedTextLabel.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('text-labels', selectedTextLabel)
        // Text has only a single position — no vertices to derive a
        // heading from — so the "local frame" comes from:
        //   1. The floor plan the text is pinned to (its `rotation`).
        //   2. The label's own `rotation` field.
        // Sum both and rotate the world-frame delta by the total.
        const floorPlan =
          latest.floorPlanId !== undefined
            ? savedImages.find((img) => img.id === latest.floorPlanId)
            : undefined
        const rot =
          (floorPlan?.rotation ?? 0) + (latest.rotation ?? 0)
        let rotDx = dxMeters
        let rotDy = dyMeters
        if (Math.abs(rot) > 1e-9) {
          const theta = (rot * Math.PI) / 180
          const cos = Math.cos(theta)
          const sin = Math.sin(theta)
          rotDx = dxMeters * cos - dyMeters * sin
          rotDy = dxMeters * sin + dyMeters * cos
        }
        const [dLng, dLat] = nudgeMetersToLngLat(
          latest.position[1],
          rotDx,
          rotDy,
        )
        void patchSpatialEntity('text-labels', selectedTextLabel.id, {
          position: [latest.position[0] + dLng, latest.position[1] + dLat],
          updatedAt: now,
        })
        return
      }
      if (selectedCircle && selectedCircle.id !== undefined && selectedCircle.center) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('circles', selectedCircle)
        const [dLng, dLat] = nudgeMetersToLngLat((latest.center ?? selectedCircle.center)[1], dxMeters, dyMeters)
        void patchSpatialEntity('circles', selectedCircle.id, {
          center: [(latest.center ?? selectedCircle.center)[0] + dLng, (latest.center ?? selectedCircle.center)[1] + dLat],
          updatedAt: now,
        })
        return
      }
      if (selectedPolygon && selectedPolygon.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('polygons', selectedPolygon)
        // Polygon's "heading" is the first edge — usually the wall the
        // user first clicked when drawing. Pass the polygon's own
        // `rotation` field so nudges track the visible heading after
        // rotation, not the original one.
        const alongM =
          direction === 'right' ? step : direction === 'left' ? -step : 0
        const perpM =
          direction === 'up' ? step : direction === 'down' ? -step : 0
        const moved = nudgeVerticesAlongHeading(
          latest.vertices,
          alongM,
          perpM,
          latest.rotation ?? 0,
        )
        void patchSpatialEntity('polygons', selectedPolygon.id, {
          vertices: moved as [number, number][],
          updatedAt: now,
        })
        return
      }
      if (selectedLine && selectedLine.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('lines', selectedLine)
        const alongM =
          direction === 'right' ? step : direction === 'left' ? -step : 0
        const perpM =
          direction === 'up' ? step : direction === 'down' ? -step : 0
        const moved = nudgeVerticesAlongHeading(
          latest.vertices,
          alongM,
          perpM,
          latest.rotation ?? 0,
        )
        void patchSpatialEntity('lines', selectedLine.id, {
          vertices: moved as [number, number][],
          updatedAt: now,
        })
        return
      }
      if (selectedImage && selectedImage.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('images', selectedImage)
        const alongM =
          direction === 'right' ? step : direction === 'left' ? -step : 0
        const perpM =
          direction === 'up' ? step : direction === 'down' ? -step : 0
        const [newStart, newCurrent] = nudgeVerticesAlongHeading(
          [latest.start, latest.current],
          alongM,
          perpM,
          latest.rotation ?? 0,
        )
        void patchSpatialEntity('images', selectedImage.id, {
          start: newStart as [number, number],
          current: newCurrent as [number, number],
          updatedAt: now,
        })
        return
      }
      if (selectedStair && selectedStair.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('stairs', selectedStair)
        const alongM =
          direction === 'right' ? step : direction === 'left' ? -step : 0
        const perpM =
          direction === 'up' ? step : direction === 'down' ? -step : 0
        const moved = nudgeVerticesAlongHeading(
          latest.vertices,
          alongM,
          perpM,
          latest.rotation ?? 0,
        )
        void patchSpatialEntity('stairs', selectedStair.id, {
          vertices: moved as [number, number][],
          updatedAt: now,
        })
        return
      }
      if (selectedDoorForPanel) {
        // Map screen-style direction to door's LOCAL frame so
        // "left/right" tracks the wall the door sits on.
        const alongM =
          direction === 'right' ? step : direction === 'left' ? -step : 0
        const perpM =
          direction === 'up' ? step : direction === 'down' ? -step : 0
        updateDoorInStore(selectedDoorForPanel.id, {
          vertices: nudgeDoorVerticesLocal(
            selectedDoorForPanel.vertices,
            alongM,
            perpM,
          ),
        })
        return
      }
      if (selectedGrid && selectedGrid.id !== undefined) {
        const alongM =
          direction === 'right' ? step : direction === 'left' ? -step : 0
        const perpM =
          direction === 'up' ? step : direction === 'down' ? -step : 0
        // From the rack's latest position, so presses made before the last
        // save lands all count; the store saves once the presses stop.
        updateSpatialLatest<Grid>('grids', selectedGrid.id, (g) => {
          const [newStart, newCurrent] = nudgeVerticesAlongHeading(
            [g.start, g.current],
            alongM,
            perpM,
            g.config?.rotation ?? 0,
          )
          return { start: newStart as [number, number], current: newCurrent as [number, number] }
        })
      }
    },
    [
      selectedMarker, selectedModel, selectedTextLabel, selectedCircle,
      selectedPolygon, selectedLine, selectedImage, selectedStair, selectedGrid,
      selectedDoorForPanel, updateDoorInStore, savedImages,
    ],
  )

  const handleRotateSelected = useCallback(
    (deltaDeg: number) => {
      const now = new Date()
      if (selectedMarker && selectedMarker.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('markers', selectedMarker)
        void patchSpatialEntity('markers', selectedMarker.id, {
          bearing: (latest.bearing ?? 0) + deltaDeg,
          updatedAt: now,
        })
        return
      }
      if (selectedModel && selectedModel.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('models', selectedModel)
        // Per-axis rotation: [pitch, yaw, roll]. Yaw (index 1) is what
        // spins the model around the vertical axis — the natural
        // "rotate" for top-down map views.
        const r = latest.config.rotation ?? [0, 0, 0]
        void patchSpatialEntity('models', selectedModel.id, {
          config: { ...latest.config, rotation: [r[0], r[1] + deltaDeg, r[2]] },
          updatedAt: now,
        })
        return
      }
      if (selectedTextLabel && selectedTextLabel.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('text-labels', selectedTextLabel)
        void patchSpatialEntity('text-labels', selectedTextLabel.id, {
          rotation: (latest.rotation ?? 0) + deltaDeg,
          updatedAt: now,
        })
        return
      }
      if (selectedPolygon && selectedPolygon.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('polygons', selectedPolygon)
        void patchSpatialEntity('polygons', selectedPolygon.id, {
          rotation: (latest.rotation ?? 0) + deltaDeg,
          updatedAt: now,
        })
        return
      }
      if (selectedLine && selectedLine.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('lines', selectedLine)
        void patchSpatialEntity('lines', selectedLine.id, {
          rotation: (latest.rotation ?? 0) + deltaDeg,
          updatedAt: now,
        })
        return
      }
      if (selectedCircle && selectedCircle.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('circles', selectedCircle)
        void patchSpatialEntity('circles', selectedCircle.id, {
          rotation: (latest.rotation ?? 0) + deltaDeg,
          updatedAt: now,
        })
        return
      }
      if (selectedImage && selectedImage.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('images', selectedImage)
        void patchSpatialEntity('images', selectedImage.id, {
          rotation: (latest.rotation ?? 0) + deltaDeg,
          updatedAt: now,
        })
        return
      }
      if (selectedStair && selectedStair.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('stairs', selectedStair)
        void patchSpatialEntity('stairs', selectedStair.id, {
          rotation: (latest.rotation ?? 0) + deltaDeg,
          updatedAt: now,
        })
        return
      }
      if (selectedDoorForPanel) {
        updateDoorInStore(selectedDoorForPanel.id, {
          vertices: rotateDoorVertices(selectedDoorForPanel.vertices, deltaDeg),
        })
        return
      }
      if (selectedGrid && selectedGrid.id !== undefined) {
        updateSpatialLatest<Grid>('grids', selectedGrid.id, (g) => ({
          config: { ...g.config, rotation: ((g.config.rotation ?? 0) + deltaDeg) % 360 },
        }))
      }
    },
    [
      selectedMarker, selectedModel, selectedTextLabel, selectedPolygon,
      selectedLine, selectedCircle, selectedImage, selectedStair, selectedGrid,
      selectedDoorForPanel, updateDoorInStore,
    ],
  )

  const handleScaleSelected = useCallback(
    (delta: number) => {
      const factor = delta > 0 ? 1.05 : 0.95
      const now = new Date()
      if (selectedMarker && selectedMarker.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('markers', selectedMarker)
        const cfg = latest.config
        void patchSpatialEntity('markers', selectedMarker.id, {
          config: { ...cfg, iconSize: Math.max(8, Math.min(64, (cfg.iconSize ?? 24) * factor)) },
          updatedAt: now,
        })
        return
      }
      if (selectedModel && selectedModel.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('models', selectedModel)
        const s = latest.config.scale ?? [1, 1, 1]
        // Multiply, then clamp to a floor low enough to accommodate the
        // bounds-normalised scales the placement tool now writes
        // (Warehouse shelving = 0.008). The old floor of 0.05 caused
        // pressing `+` on a normalised model to balloon it ~6× instead
        // of the intended +5% nudge.
        const raw = s[0] * factor
        const next = Math.max(0.001, Math.min(50, raw))
        void patchSpatialEntity('models', selectedModel.id, {
          config: { ...latest.config, scale: [next, next, next] },
          updatedAt: now,
        })
        return
      }
      if (selectedTextLabel && selectedTextLabel.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('text-labels', selectedTextLabel)
        const cfg = latest.config
        void patchSpatialEntity('text-labels', selectedTextLabel.id, {
          config: { ...cfg, size: Math.max(8, Math.min(96, (cfg.size ?? 16) * factor)) },
          updatedAt: now,
        })
        return
      }
      if (selectedCircle && selectedCircle.id !== undefined && selectedCircle.radius != null) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('circles', selectedCircle)
        void patchSpatialEntity('circles', selectedCircle.id, {
          radius: Math.max(0.1, (latest.radius ?? selectedCircle.radius) * factor),
          updatedAt: now,
        })
        return
      }
      if (selectedImage && selectedImage.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('images', selectedImage)
        const cx = (latest.start[0] + latest.current[0]) / 2
        const cy = (latest.start[1] + latest.current[1]) / 2
        const start = [
          cx + (latest.start[0] - cx) * factor,
          cy + (latest.start[1] - cy) * factor,
        ] as [number, number]
        const current = [
          cx + (latest.current[0] - cx) * factor,
          cy + (latest.current[1] - cy) * factor,
        ] as [number, number]
        void patchSpatialEntity('images', selectedImage.id, {
          start, current, updatedAt: now,
        })
        return
      }
      if (selectedDoorForPanel) {
        const widthM = Math.hypot(
          (selectedDoorForPanel.vertices[1][0] - selectedDoorForPanel.vertices[0][0]) *
            111_320 *
            Math.cos((selectedDoorForPanel.vertices[0][1] * Math.PI) / 180),
          (selectedDoorForPanel.vertices[1][1] - selectedDoorForPanel.vertices[0][1]) *
            111_320,
        )
        updateDoorInStore(selectedDoorForPanel.id, {
          vertices: resizeDoorVertices(
            selectedDoorForPanel.vertices,
            Math.max(0.1, widthM * factor),
          ),
        })
        return
      }
      if (selectedGrid && selectedGrid.id !== undefined) {
        updateSpatialLatest<Grid>('grids', selectedGrid.id, (g) => ({
          config: {
            ...g.config,
            xSize: Math.max(0.1, g.config.xSize * factor),
            ySize: Math.max(0.1, g.config.ySize * factor),
          },
        }))
      }
    },
    [
      selectedMarker, selectedModel, selectedTextLabel, selectedCircle,
      selectedImage, selectedGrid,
      selectedDoorForPanel, updateDoorInStore,
    ],
  )

  const handleElevationSelected = useCallback(
    (delta: number) => {
      const step = 0.5
      const now = new Date()
      if (selectedMarker && selectedMarker.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('markers', selectedMarker)
        const cfg = latest.config
        void patchSpatialEntity('markers', selectedMarker.id, {
          config: { ...cfg, elevation: Math.max(0, (cfg.elevation ?? 0) + step * delta) },
          updatedAt: now,
        })
        return
      }
      if (selectedModel && selectedModel.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('models', selectedModel)
        const cfg = latest.config
        void patchSpatialEntity('models', selectedModel.id, {
          config: { ...cfg, elevation: Math.max(0, (cfg.elevation ?? 0) + step * delta) },
          updatedAt: now,
        })
        return
      }
      if (selectedImage && selectedImage.id !== undefined) {
        // The latest value (row + unsaved edits): repeated presses can't drop a step.
        const latest = latestOf('images', selectedImage)
        const cfg = latest.config
        void patchSpatialEntity('images', selectedImage.id, {
          config: { ...cfg, elevation: Math.max(0, (cfg.elevation ?? 0) + step * delta) },
          updatedAt: now,
        })
        return
      }
      if (selectedGrid && selectedGrid.id !== undefined) {
        updateSpatialLatest<Grid>('grids', selectedGrid.id, (g) => ({
          config: { ...g.config, elevation: Math.max(0, (g.config.elevation ?? 0) + step * delta) },
        }))
      }
    },
    [selectedMarker, selectedModel, selectedImage, selectedGrid],
  )

  const handleFitToSelection = useCallback(() => {
    void handleFitToGrid()
  }, [handleFitToGrid])

  // Refs read by the hook's keydown handler at fire time (avoids stale
  // closures without re-binding the listener on every keystroke).
  const inProgressDrawRef = useRef(false)
  useEffect(() => {
    inProgressDrawRef.current =
      drawMode ||
      polygonDraftVertices.length > 0 ||
      lineDraftVertices.length > 0 ||
      stairDraftAnchors.length > 0 ||
      circleDragStart !== null ||
      circleGridStart !== null ||
      imageDragStart !== null
  }, [
    drawMode, polygonDraftVertices, lineDraftVertices, stairDraftAnchors,
    circleDragStart, circleGridStart, imageDragStart,
  ])

  const transformActiveRef = useRef(false)
  useEffect(() => {
    transformActiveRef.current =
      transform !== null ||
      markerTransform !== null ||
      polygonTransform !== null ||
      lineTransform !== null ||
      circleTransform !== null ||
      imageTransform !== null ||
      modelTransform !== null ||
      textLabelTransform !== null ||
      doorTransform !== null
  }, [
    transform, markerTransform, polygonTransform, lineTransform,
    circleTransform, imageTransform, modelTransform, textLabelTransform,
    doorTransform,
  ])

  const selectionTotalRef = useRef(0)
  useEffect(() => {
    selectionTotalRef.current = totalMapSelection
  }, [totalMapSelection])

  const activeToolRef = useRef(activeTool)
  useLayoutEffect(() => {
    activeToolRef.current = activeTool
  })
  const keyboardState = useKeyboardShortcuts({
    getActiveTool: () => activeToolRef.current,
    setActiveTool: (tool: Tool) => {
      // Mirror the toolbar's onActiveToolChange so pressing `B` also
      // reopens the model library dialog.
      if (tool === 'create-model') {
        setModelConfig((cfg) => ({ ...cfg, modelAssetId: undefined }))
        setModelLibraryMode('place')
        setModelLibraryOpen(true)
      }
      setActiveTool(tool)
    },
    preview,
    // Per-tool local listeners own this, except the grid path draw: its
    // mode only hears Enter while the map has focus.
    commitInProgressDraw: () => { if (drawMode) finishGridPath?.() },
    // Per-tool local listeners own this, except the grid path draw (MapboxDraw
    // keeps Backspace from its mode), handled here.
    undoLastVertex: () => { if (drawMode) undoGridPathVertex?.() },
    cancelInProgressDraw: () => {
      // Only the grid draw mode has no local listener — handle it here.
      if (drawMode) exitDrawMode()
    },
    nudge: handleNudge,
    rotate: handleRotateSelected,
    scale: handleScaleSelected,
    elevation: handleElevationSelected,
    commitTransform: () => { /* transforms commit on dragend; keyboard just cancels */ },
    cancelTransform: handleCancelTransform,
    // Delete has no confirmation, so it says what happened — with Undo
    // when the delete landed on the history stack (most kinds do).
    deleteSelected: () => {
      void (async () => {
        const before = gridHistory.peekUndo()
        await handleDeleteAnySelected()
        const undoable = gridHistory.peekUndo() !== before
        toast.success(
          i18n.t('editor.deleted', { defaultValue: 'Deleted' }),
          undoable ? { action: { label: i18n.t('common.undo', { defaultValue: 'Undo' }), onClick: () => void handleUndo() } } : undefined,
        )
      })()
    },
    duplicateSelected: () => { void handleDuplicateAnySelected() },
    redrawSelected: () => {
      if (selectedGridIds.size === 1 && selectedGrid?.id !== undefined) {
        handleRedraw(selectedGrid.id)
      }
    },
    fitToSelection: handleFitToSelection,
    deselect: handleDeselectAll,
    undo: () => { void handleUndo() },
    redo: () => { void handleRedo() },
    exportGeoJSON: handleExportGeoJSON,
    hasTransformActive: () => transformActiveRef.current,
    hasSelection: () => selectionTotalRef.current > 0,
    hasInProgressDraw: () => inProgressDrawRef.current,
  })

  return keyboardState
}
