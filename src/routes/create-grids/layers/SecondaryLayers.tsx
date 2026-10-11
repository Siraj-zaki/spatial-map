import { type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { AlertsPanel } from '@/components/data-link/alerts-panel'
import { ReplayBanner } from '@/components/data-link/replay-banner'
import { MapDoorOverlay } from '@/components/door/map-door-overlay'
import { ImagePlaneTool } from '@/components/image-plane-tool'
import { MapBinOverlay } from '@/components/map-bin-overlay'
import { MapDataLinkedOverlay } from '@/components/map-data-linked-overlay'
import { type CommittedLine } from '@/components/map-grid-overlay'
import { MapImagePlaneOverlay } from '@/components/map-image-plane-overlay'
import { MapMarkerOverlay, type MarkerStyleOverride } from '@/components/map-marker-overlay'
import { MapShapeTooltip } from '@/components/map-shape-tooltip'
import { MapTextLabelOverlay } from '@/components/map-text-label-overlay'
import type { LayerVisibility } from '@/components/map-toolbar'
import type { Bin, DataLinkConfig, Grid } from '@/lib/db'
import type { DoorConfig, DoorShape } from '@/lib/door/types'
import type { Tool } from '@/lib/keyboard-shortcuts'
import type {
  CircleShape,
  ImagePlaneShape,
  ImageShape,
  LineShape,
  MarkerShape,
  MarkerShapeConfig,
  ModelShape,
  PolygonShape,
  StairShape,
  TextLabelConfig,
  TextLabelShape,
} from '@/lib/shapes'
import { patchSpatialEntity } from '@/lib/spatial-store'
import type { StyleRule } from '@/lib/style-rules'

import type { DoorCursorPreview } from '../state/useDoorEditorState'
import type {
  TextLabelTransform,
  TextLabelTransformDraft,
} from '../state/useTextLabelEditorState'

type PositionalTransform<Id extends string> =
  | { [k in Id]: number } & { kind: 'move' | 'rotate' | 'scale' }
  | null

/**
 * Non-reorderable overlays that mount above the `<OverlayStack />`.
 * These render on top of the reorderable layers regardless of
 * `layerOrder` because their semantics require it: doors punch holes
 * in walls (must draw after walls), markers/labels are
 * screen-oriented (readable at any camera angle), tooltips are UI
 * chrome, and the data-link overlay is a virtual root that manages
 * its own sub-renderer stack.
 *
 * Text-label and image-plane click handlers use inline lambdas
 * because their sibling-clear + additive-toggle patterns don't cleanly
 * factor into shared per-kind selection handlers — they'd need every
 * setSelectedXIds threaded through, and the routes we already ship
 * that pattern with (`useMarkerHandlers`, etc.) can't own image-plane
 * or text-label because those kinds also have inline transform-commit
 * lambdas that are non-trivial.
 */
export function SecondaryLayers({
  overlayMap,
  activeTool,
  shapeSelectionEnabled,
  layerVisibility,
  onMapClickEmpty,
  preview,
  activeWarehouseId,
  defaultFloorPlanId,
  defaultFloorPlanElevation,
  configUnit,
  // ---- Image plane ----
  imagePlanesForOverlay,
  selectedImagePlaneIds,
  imagePlaneTransform,
  onImagePlaneTransformChange,
  setSelectedImagePlaneIds,
  setActiveTool,
  // ---- Door ----
  scopedDoors,
  selectedDoorIds,
  doorTransform,
  doorConfig,
  doorDraftAnchors,
  doorDraftCursor,
  doorCursorPreview,
  onDoorTransformChange,
  setSelectedDoorIds,
  // ---- Marker ----
  savedMarkers,
  markerConfig,
  markerCursor,
  selectedMarkerIds,
  markerTransform,
  onMarkerClick,
  onMarkerTransformChange,
  markerStyleOverrides,
  // ---- Bin ----
  binCommittedLines,
  savedBins,
  gridsVisible,
  // ---- Text label ----
  textLabelsForOverlay,
  textLabelCursor,
  textLabelConfig,
  selectedTextLabelIds,
  textLabelTransform,
  textLabelTransformDraft,
  setTextLabelTransform,
  setTextLabelTransformDraft,
  setSelectedTextLabelIds,
  textLabelStyleOverrides,
  // ---- Data link ----
  savedDataLinks,
  savedPolygons,
  savedCircles,
  savedLines,
  savedModels,
  savedStairs,
  savedGrids,
  savedStyleRules,
  savedImages,
  // ---- Sibling clears (used by inline door / image-plane click lambdas) ----
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedStairIds,
}: {
  overlayMap: MapboxMapInstance | null
  activeTool: Tool
  shapeSelectionEnabled: boolean
  layerVisibility: LayerVisibility
  onMapClickEmpty: () => void
  preview: boolean
  activeWarehouseId: number | null
  defaultFloorPlanId: number | null
  defaultFloorPlanElevation: number
  configUnit: import('@/lib/units').LengthUnit
  // Image plane
  imagePlanesForOverlay: ImagePlaneShape[]
  selectedImagePlaneIds: Set<number>
  imagePlaneTransform: PositionalTransform<'imagePlaneId'>
  onImagePlaneTransformChange: (
    patch: { position?: [number, number] },
    commit: boolean,
  ) => void
  setSelectedImagePlaneIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
  // Door
  scopedDoors: DoorShape[]
  selectedDoorIds: Set<number>
  doorTransform: PositionalTransform<'doorId'>
  doorConfig: DoorConfig
  doorDraftAnchors: [number, number][]
  doorDraftCursor: [number, number] | null
  doorCursorPreview: DoorCursorPreview
  onDoorTransformChange: (
    next: [[number, number], [number, number]],
    commit: boolean,
  ) => void
  setSelectedDoorIds: Dispatch<SetStateAction<Set<number>>>
  // Marker
  savedMarkers: MarkerShape[]
  markerConfig: MarkerShapeConfig
  markerCursor: [number, number] | null
  selectedMarkerIds: Set<number>
  markerTransform: PositionalTransform<'markerId'>
  onMarkerClick: (id: number, e: MouseEvent) => void
  onMarkerTransformChange: (
    patch: { position?: [number, number] },
    commit: boolean,
  ) => void
  markerStyleOverrides: Map<number, MarkerStyleOverride> | null
  // Bin
  binCommittedLines: CommittedLine[]
  savedBins: Bin[]
  gridsVisible: boolean
  // Text label
  textLabelsForOverlay: TextLabelShape[]
  textLabelCursor: [number, number] | null
  textLabelConfig: TextLabelConfig
  selectedTextLabelIds: Set<number>
  textLabelTransform: TextLabelTransform
  textLabelTransformDraft: TextLabelTransformDraft
  setTextLabelTransform: Dispatch<SetStateAction<TextLabelTransform>>
  setTextLabelTransformDraft: Dispatch<SetStateAction<TextLabelTransformDraft>>
  setSelectedTextLabelIds: Dispatch<SetStateAction<Set<number>>>
  textLabelStyleOverrides: Map<
    number,
    {
      labelText?: string
      labelColor?: string
      fillColor?: string
      fillOpacity?: number
    }
  > | null
  // Data link
  savedDataLinks: DataLinkConfig[]
  savedPolygons: PolygonShape[]
  savedCircles: CircleShape[]
  savedLines: LineShape[]
  savedModels: ModelShape[]
  /** Marker-occlusion only — stairs render from OverlayStack. */
  savedStairs: StairShape[]
  /** Rack grids — used as OCCLUDERS for door/marker/text labels. */
  savedGrids: Grid[]
  savedStyleRules: ReadonlyArray<StyleRule>
  savedImages: ImageShape[]
  // Sibling clears
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
}) {
  return (
    <>
      {/*
       * Image-plane overlay + placement tool. Renders user images as
       * textured planes in 3D space (elevation + 3-axis rotation) via
       * Mapbox's model layer.
       */}
      <MapImagePlaneOverlay
        map={overlayMap}
        imagePlanes={imagePlanesForOverlay}
        selectedImagePlaneIds={selectedImagePlaneIds}
        committedVisible={layerVisibility.imagePlane}
        selectionEnabled={activeTool !== 'create-image-plane' && shapeSelectionEnabled}
        transformState={imagePlaneTransform as never}
        onTransformChange={onImagePlaneTransformChange}
        onImagePlaneClick={(id, e) => {
          const additive = e.shiftKey || e.metaKey || e.ctrlKey
          setSelectedImagePlaneIds((prev) => {
            const next = new Set(additive ? prev : [])
            if (additive && prev.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
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
        }}
        onMapClickEmpty={() => {
          setSelectedImagePlaneIds((p) => (p.size > 0 ? new Set() : p))
        }}
      />
      <ImagePlaneTool
        map={overlayMap}
        active={activeTool === 'create-image-plane'}
        zoneId={activeWarehouseId ?? undefined}
        floorPlanId={defaultFloorPlanId ?? undefined}
        elevation={defaultFloorPlanElevation}
        unit={configUnit}
        onCreated={(id) => {
          setSelectedImagePlaneIds(new Set([id]))
        }}
        onDone={() => {
          setActiveTool('select')
        }}
      />

      {/*
       * Door overlay — committed doors + live placement preview.
       * Doors persist via `useDoorStore` (localStorage); the side panel
       * surfaces the editor through the standard polygon/stair pattern.
       */}
      <MapDoorOverlay
        map={overlayMap}
        doors={scopedDoors}
        selectedDoorIds={selectedDoorIds}
        committedVisible={layerVisibility.door}
        selectionEnabled={activeTool !== 'create-door'}
        transformState={doorTransform as never}
        onTransformChange={onDoorTransformChange}
        onMapClickEmpty={onMapClickEmpty}
        // v5.5 — door labels fade behind floor plates and walls same
        // as markers + text-labels. Same gating: hidden layers occlude
        // nothing.
        occluders={{
          images: layerVisibility.image ? savedImages : undefined,
          polygons: layerVisibility.polygon ? savedPolygons : undefined,
          circles: layerVisibility.circle ? savedCircles : undefined,
          lines: layerVisibility.line ? savedLines : undefined,
          stairs: layerVisibility.stair ? savedStairs : undefined,
          grids: layerVisibility.grid ? savedGrids : undefined,
        }}
        onDoorClick={(id, e) => {
          const additive = e.shiftKey || e.metaKey || e.ctrlKey
          setSelectedDoorIds((prev) => {
            const next = new Set(additive ? prev : [])
            if (additive && prev.has(id)) {
              next.delete(id)
            } else {
              next.add(id)
            }
            return next
          })
          // Clear sibling selections to land cleanly in door-selected.
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
        }}
        livePreview={
          activeTool !== 'create-door'
            ? null
            : doorDraftAnchors.length > 0 && doorDraftCursor
              // Between clicks: chain-style preview from anchor to cursor.
              ? { vertices: [...doorDraftAnchors, doorDraftCursor], config: doorConfig }
              // Pre-first-click: cursor preview (wall-snapped or free-space).
              : doorCursorPreview
                ? {
                    vertices: doorCursorPreview.vertices,
                    // When snapped to a wall, stamp the attach id on
                    // the preview config so users see the "attached"
                    // treatment before committing.
                    config: doorCursorPreview.attachedToLineId !== undefined
                      ? { ...doorConfig, attachedToLineId: doorCursorPreview.attachedToLineId }
                      : doorConfig,
                  }
                : null
        }
      />

      <MapMarkerOverlay
        map={overlayMap}
        markers={savedMarkers}
        liveCursor={activeTool === 'create-marker' ? markerCursor : null}
        liveIcon={markerConfig.icon}
        liveColor={markerConfig.iconColor}
        liveSize={markerConfig.iconSize}
        liveElevation={markerConfig.elevation}
        liveHeight={markerConfig.height}
        selectedMarkerIds={selectedMarkerIds}
        onMarkerClick={onMarkerClick}
        committedVisible={layerVisibility.marker}
        selectionEnabled={shapeSelectionEnabled}
        transformState={markerTransform as never}
        onTransformChange={onMarkerTransformChange}
        shapeStyleOverrides={markerStyleOverrides}
        // Slabs, walls and staircases hide the markers standing behind
        // them. Each kind is gated on its own layer toggle — geometry the
        // user hid paints nothing and so must occlude nothing.
        occluders={{
          images: layerVisibility.image ? savedImages : undefined,
          polygons: layerVisibility.polygon ? savedPolygons : undefined,
          circles: layerVisibility.circle ? savedCircles : undefined,
          lines: layerVisibility.line ? savedLines : undefined,
          stairs: layerVisibility.stair ? savedStairs : undefined,
          grids: layerVisibility.grid ? savedGrids : undefined,
        }}
      />

      {/*
       * Bin-status tint layer — paints occupied / reserved cells over
       * the rack fill so the user can see which bins are in use at a
       * glance. Sits above the grid overlay in render order so the tint
       * always wins. Click handling intentionally lives in MapGridOverlay
       * (this layer is non-interactive).
       */}
      <MapBinOverlay
        map={overlayMap}
        committedLines={binCommittedLines}
        bins={savedBins}
        visible={gridsVisible}
      />

      {/*
       * Text-label overlay — pure-text annotations rendered through a
       * native Mapbox `symbol` layer. Lives outside the reorderable
       * Fragment because labels should always render on top of geometry
       * so the user can read them at any camera angle.
       */}
      <MapTextLabelOverlay
        map={overlayMap}
        labels={textLabelsForOverlay}
        liveCursor={activeTool === 'create-text' ? textLabelCursor : null}
        liveConfig={
          activeTool === 'create-text' ? textLabelConfig : undefined
        }
        selectedLabelIds={selectedTextLabelIds}
        committedVisible={layerVisibility.text}
        selectionEnabled={shapeSelectionEnabled}
        shapeStyleOverrides={textLabelStyleOverrides}
        // v5.4 — labels are 3D-occluded by the same geometry markers
        // are: floor plates above (image), and walls / racks / stairs
        // the camera looks through on a tilt. The `>=` embed check in
        // `computeOccludedIds` recognises "label sitting on the floor
        // of the room it belongs to" so a room's own polygon doesn't
        // hide its own label. Each kind still gates on its own layer
        // toggle — hidden geometry can't paint or occlude.
        occluders={{
          images: layerVisibility.image ? savedImages : undefined,
          polygons: layerVisibility.polygon ? savedPolygons : undefined,
          circles: layerVisibility.circle ? savedCircles : undefined,
          lines: layerVisibility.line ? savedLines : undefined,
          stairs: layerVisibility.stair ? savedStairs : undefined,
          grids: layerVisibility.grid ? savedGrids : undefined,
        }}
        onLabelClick={(id, e) => {
          const additive = e.shiftKey || e.metaKey || e.ctrlKey
          setSelectedTextLabelIds((prev) => {
            const next = new Set(additive ? prev : [])
            if (additive && prev.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }}
        onMapClickEmpty={onMapClickEmpty}
        transformState={textLabelTransform}
        onTransformChange={(patch, commit) => {
          setTextLabelTransformDraft((prev) => ({ ...(prev ?? {}), ...patch }))
          if (!commit) return
          const tx = textLabelTransform
          if (!tx) return
          const merged = { ...(textLabelTransformDraft ?? {}), ...patch }
          // Persist whichever facet of the label the user just dragged.
          // Each kind only sends the field it owns, so we forward
          // exactly that subset.
          const update: Partial<TextLabelShape> = { updatedAt: new Date() }
          if (merged.position) update.position = merged.position
          if (merged.rotation !== undefined) update.rotation = merged.rotation
          if (merged.config) update.config = merged.config
          if (Object.keys(update).length > 1) {
            void patchSpatialEntity('text-labels', tx.textLabelId, update)
          }
          setTextLabelTransform(null)
          setTextLabelTransformDraft(null)
        }}
      />

      {/*
       * Tooltips are gated to the Pan tool — the read-only "inspect"
       * mode of the editor. Select swallows clicks for selection,
       * Create-* swallows clicks for placement.
       */}
      <MapShapeTooltip
        map={overlayMap}
        enabled={activeTool === 'pan'}
      />

      {/*
       * Replay banner + alerts panel — the correlation-engine's UI
       * surface. Only mounted in preview mode.
       */}
      {preview && <ReplayBanner />}
      {preview && <AlertsPanel />}

      {/*
       * Generic data-link overlay. Renders every enabled
       * DataLinkConfig for the active warehouse as user-configured
       * points / badges / etc. Fed with the live floor plan id set so
       * the overlay's floor gate recognises orphan references and
       * shows those entities on the current floor instead of dropping
       * them.
       */}
      {/*
       * Data-link overlay. `configs` is filtered by the layer toggles so
       * a tint / marker / gauge whose base shape kind is hidden also
       * disappears (before this filter, hiding "Racks" left the tinted
       * bin fills painted by config 26 still on-screen because the
       * data-link overlay renders its OWN Mapbox layer, independent of
       * MapGridOverlay's committedVisible toggle).
       */}
      <MapDataLinkedOverlay
        map={overlayMap}
        activeZoneId={activeWarehouseId ?? null}
        configs={savedDataLinks.filter((c) => {
          switch (c.targetKind) {
            case 'grid-cell': return layerVisibility.grid
            case 'polygon':   return layerVisibility.polygon
            case 'circle':    return layerVisibility.circle
            case 'line':      return layerVisibility.line
            case 'marker':    return layerVisibility.marker
            case 'stair':     return layerVisibility.stair
            case 'text-label':return layerVisibility.text
            default:          return true
          }
        })}
        enabled={preview}
        polygons={savedPolygons}
        circles={savedCircles}
        markers={savedMarkers}
        lines={savedLines}
        models={savedModels}
        styleRules={savedStyleRules}
        liveFloorPlanIds={savedImages
          .map((img) => img.id)
          .filter((id): id is number => id !== undefined)}
      />
    </>
  )
}
