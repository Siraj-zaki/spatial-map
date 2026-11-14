import { Fragment, useMemo } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { MapCircleOverlay } from '@/components/map-circle-overlay'
import { MapGridOverlay, type CommittedLine } from '@/components/map-grid-overlay'
import { MapImageOverlay } from '@/components/map-image-overlay'
import { MapLineOverlay } from '@/components/map-line-overlay'
import { MapModelOverlay } from '@/components/map-model-overlay'
import { MapPolygonOverlay } from '@/components/map-polygon-overlay'
import { MapRouteOverlay } from '@/components/map-route-overlay'
import { MapStairOverlay } from '@/components/map-stair-overlay'
import type { LayerVisibility } from '@/components/map-toolbar'
import type { LayerKind } from '@/components/side-panel'
import type { DoorShape } from '@/lib/door/types'
import type { Grid } from '@/lib/db'
import type { GridConfig } from '@/lib/grid-generators'
import type { Tool } from '@/lib/keyboard-shortcuts'
import type { LineSnap } from '@/lib/line-snap'
import type { RouteSnap } from '@/lib/route-snap'
import type {
  CircleShape,
  FillShapeConfig,
  ImageShape,
  LineShape,
  LineShapeConfig,
  ModelShape,
  PolygonShape,
  RouteShape,
  RouteShapeConfig,
  StairShape,
  StairShapeConfig,
} from '@/lib/shapes'
import type { ResolvedStyleMaps } from '@/lib/style-rules'

/**
 * The reorderable overlay Fragment. Mapbox stacks layers by
 * `addLayer` call order, so we wrap the reorderable overlays in a
 * Fragment whose key encodes the order. Changing the key forces all
 * children to unmount and remount, re-running their `addLayer`
 * effects in the new order. Without this, React would reconcile
 * keyed children in place and the underlying Mapbox stack would
 * never restack.
 *
 * The per-kind overlays inside the switch each mount one Mapbox
 * source + N layers. Non-reorderable overlays (marker, bin, text,
 * door, image-plane, tooltip, data-link) live in
 * `<SecondaryLayers />` and always mount above these.
 */
export function OverlayStack({
  overlayMap,
  layerOrder,
  layerVisibility,
  shapeSelectionEnabled,
  activeTool,
  onMapClickEmpty,
  // ---- Images ----
  imagesForOverlay,
  imageWallLines,
  imageAlignment,
  imageLivePreview,
  selectedImageIds,
  imageTransform,
  onImageClick,
  onImageTransformChange,
  // ---- Grids ----
  liveLine,
  livePreviewConfig,
  committedLines,
  panelMode,
  selectedGrid,
  gridConfig,
  selectedGridIds,
  gridTransform,
  gridTransformDraft,
  onCellClick,
  onGridTransformChange,
  resolvedStyles,
  // ---- Circles ----
  circlesForOverlay,
  circleLivePreview,
  selectedCircleIds,
  circleTransform,
  onCircleClick,
  onCircleTransformChange,
  circleStyleOverrides,
  // ---- Polygons ----
  polygonsForOverlay,
  polygonDraftVertices,
  polygonDraftCursor,
  polygonConfig,
  selectedPolygonIds,
  polygonTransform,
  onPolygonClick,
  onPolygonTransformChange,
  polygonStyleOverrides,
  // ---- Lines ----
  linesForOverlay,
  lineDraftVertices,
  lineDraftCursor,
  lineConfig,
  lineDraftSnap,
  selectedLineIds,
  lineTransform,
  onLineClick,
  onLineTransformChange,
  lineStyleOverrides,
  attachedDoorsByLineId,
  // ---- Routes ----
  savedRoutes,
  routeDraftVertices,
  routeDraftCursor,
  routeConfig,
  routeDraftSnap,
  selectedRouteIds,
  onRouteClick,
  // ---- Stairs ----
  stairsForOverlay,
  selectedStairIds,
  stairDraftAnchors,
  stairDraftCursor,
  stairConfig,
  onStairClick,
  stairTransform,
  onStairTransformChange,
  // ---- Models ----
  modelsForOverlay,
  modelUrlMap,
  modelBoundingCenters,
  modelBounds,
  modelShapeExtras,
  modelCursor,
  modelAssetId,
  selectedModelIds,
  modelTransform,
  onModelClick,
  onModelTransformChange,
}: {
  overlayMap: MapboxMapInstance | null
  layerOrder: LayerKind[]
  layerVisibility: LayerVisibility
  shapeSelectionEnabled: boolean
  activeTool: Tool
  onMapClickEmpty: () => void
  // ---- Images ----
  imagesForOverlay: ImageShape[]
  /** Every wall in the warehouse (any floor visibility) — floor-plan "hide outside walls" mask. */
  imageWallLines?: ReadonlyArray<LineShape>
  /** Floor-plan alignment view — see `MapImageOverlay` `alignment`. */
  imageAlignment?: { activeImageId: number | null } | null
  imageLivePreview: ImageShape | null
  selectedImageIds: Set<number>
  imageTransform: unknown
  onImageClick: (id: number, e: MouseEvent) => void
  onImageTransformChange: (patch: {
    start?: [number, number]
    current?: [number, number]
    rotation?: number
  }, commit: boolean) => void
  // ---- Grids ----
  liveLine: { start: [number, number]; current: [number, number] } | null
  /** Grid config for the live preview while a path-layout grid is being drawn. */
  livePreviewConfig?: GridConfig | null
  committedLines: CommittedLine[]
  panelMode: string
  selectedGrid: Grid | null
  gridConfig: GridConfig
  selectedGridIds: Set<number>
  gridTransform: { gridId: number; kind: 'move' | 'rotate' | 'scale' } | null
  gridTransformDraft: {
    gridId: number
    start: [number, number]
    current: [number, number]
    rotation: number
  } | null
  onCellClick: (
    gridId: number,
    row: number,
    col: number,
    level: number,
    e: MouseEvent,
  ) => void
  onGridTransformChange: (
    newStart: [number, number],
    newCurrent: [number, number],
    newRotation: number,
    commit: boolean,
  ) => void
  resolvedStyles: ResolvedStyleMaps
  // ---- Circles ----
  circlesForOverlay: CircleShape[]
  circleLivePreview: CircleShape | null
  selectedCircleIds: Set<number>
  circleTransform: unknown
  onCircleClick: (id: number, e: MouseEvent) => void
  onCircleTransformChange: (patch: {
    center?: [number, number]
    start?: [number, number]
    current?: [number, number]
    rotation?: number
  }, commit: boolean) => void
  circleStyleOverrides:
    | Map<number, import('@/lib/circle-generators').CircleStyleOverride>
    | null
  // ---- Polygons ----
  polygonsForOverlay: PolygonShape[]
  polygonDraftVertices: [number, number][]
  polygonDraftCursor: [number, number] | null
  polygonConfig: FillShapeConfig
  selectedPolygonIds: Set<number>
  polygonTransform: unknown
  onPolygonClick: (id: number, e: MouseEvent) => void
  onPolygonTransformChange: (patch: {
    vertices?: [number, number][]
    rotation?: number
  }, commit: boolean) => void
  polygonStyleOverrides:
    | Map<number, import('@/lib/polygon-generators').PolygonStyleOverride>
    | null
  // ---- Lines ----
  linesForOverlay: LineShape[]
  lineDraftVertices: [number, number][]
  lineDraftCursor: [number, number] | null
  lineConfig: LineShapeConfig
  lineDraftSnap: LineSnap | null
  selectedLineIds: Set<number>
  lineTransform: unknown
  onLineClick: (id: number, e: MouseEvent) => void
  onLineTransformChange: (patch: {
    vertices?: [number, number][]
    rotation?: number
  }, commit: boolean) => void
  lineStyleOverrides:
    | Map<number, import('@/lib/line-generators').LineStyleOverride>
    | null
  attachedDoorsByLineId: Map<number, DoorShape[]> | null
  // ---- Routes ----
  savedRoutes: RouteShape[]
  routeDraftVertices: [number, number][]
  routeDraftCursor: [number, number] | null
  routeConfig: RouteShapeConfig
  routeDraftSnap: RouteSnap | null
  selectedRouteIds: Set<number>
  onRouteClick: (id: number) => void
  // ---- Stairs ----
  stairsForOverlay: StairShape[]
  selectedStairIds: Set<number>
  stairDraftAnchors: [number, number][]
  stairDraftCursor: [number, number] | null
  stairConfig: StairShapeConfig
  onStairClick: (id: number, e: MouseEvent) => void
  stairTransform: unknown
  onStairTransformChange: (patch: {
    vertices?: [number, number][]
    rotation?: number
  }, commit: boolean) => void
  // ---- Models ----
  modelsForOverlay: ModelShape[]
  modelUrlMap: Record<string, string>
  modelBoundingCenters: ReadonlyMap<string, [number, number, number]>
  modelBounds: ReadonlyMap<string, { min: [number, number, number]; max: [number, number, number] }>
  modelShapeExtras: Map<number, Record<string, unknown>>
  modelCursor: [number, number] | null
  modelAssetId: string | undefined
  selectedModelIds: Set<number>
  modelTransform: unknown
  onModelClick: (id: number, e: MouseEvent) => void
  onModelTransformChange: (
    patch: { position?: [number, number] },
    commit: boolean,
  ) => void
}) {
  // Floor-plan elevations for lifts linked to floors (see MapStairOverlay).
  const floorElevations = useMemo(
    () =>
      new Map(
        imagesForOverlay
          .filter((img) => img.id !== undefined)
          .map((img) => [img.id as number, img.config.elevation ?? 0]),
      ),
    [imagesForOverlay],
  )
  return (
    <Fragment key={layerOrder.join('-')}>
      {layerOrder.map((kind) => {
        switch (kind) {
          case 'image':
            return (
              <Fragment key="image">
                <MapImageOverlay
                  map={overlayMap}
                  images={imagesForOverlay}
                  livePreview={imageLivePreview}
                  selectedImageIds={selectedImageIds}
                  onImageClick={onImageClick}
                  onMapClickEmpty={onMapClickEmpty}
                  committedVisible={layerVisibility.image}
                  selectionEnabled={shapeSelectionEnabled}
                  transformState={imageTransform as never}
                  onTransformChange={onImageTransformChange}
                  wallLines={imageWallLines}
                  alignment={imageAlignment}
                />
              </Fragment>
            )
          case 'grid':
            return (
              <MapGridOverlay
                key="grid"
                map={overlayMap}
                bbox={null}
                line={liveLine}
                committedLines={committedLines}
                config={livePreviewConfig ?? (panelMode === 'grid-selected' && selectedGrid ? selectedGrid.config : gridConfig)}
                showBbox={liveLine !== null}
                selectedGridIds={selectedGridIds}
                onCellClick={onCellClick}
                onMapClickEmpty={onMapClickEmpty}
                committedVisible={layerVisibility.grid}
                selectionEnabled={shapeSelectionEnabled}
                transformState={
                  gridTransform && gridTransformDraft
                    ? {
                        gridId: gridTransform.gridId,
                        kind: gridTransform.kind,
                        draft: gridTransformDraft,
                      }
                    : null
                }
                onTransformChange={onGridTransformChange}
                cellStyleOverrides={
                  resolvedStyles.gridCells.size > 0
                    ? resolvedStyles.gridCells
                    : null
                }
                // v5.5 — rack cell labels fade behind floor plates,
                // walls, and OTHER rack cells (a rear cell hides a
                // label on a cell behind it). Each kind is gated on
                // its own layer toggle. `committedLines` doubles as
                // the grid-occluder source: its {id, start, current,
                // config} fields are exactly what `buildOccluders`
                // needs to re-materialise cell prisms.
                occluders={{
                  images: layerVisibility.image ? imagesForOverlay : undefined,
                  polygons: layerVisibility.polygon ? polygonsForOverlay : undefined,
                  circles: layerVisibility.circle ? circlesForOverlay : undefined,
                  lines: layerVisibility.line ? linesForOverlay : undefined,
                  stairs: layerVisibility.stair ? stairsForOverlay : undefined,
                  grids: layerVisibility.grid ? committedLines : undefined,
                }}
              />
            )
          case 'circle':
            return (
              <MapCircleOverlay
                key="circle"
                map={overlayMap}
                circles={circlesForOverlay}
                livePreview={circleLivePreview}
                selectedCircleIds={selectedCircleIds}
                onCircleClick={onCircleClick}
                onMapClickEmpty={onMapClickEmpty}
                committedVisible={layerVisibility.circle}
                selectionEnabled={shapeSelectionEnabled}
                transformState={circleTransform as never}
                onTransformChange={onCircleTransformChange}
                shapeStyleOverrides={circleStyleOverrides}
              />
            )
          case 'polygon':
            return (
              <MapPolygonOverlay
                key="polygon"
                map={overlayMap}
                polygons={polygonsForOverlay}
                liveVertices={
                  activeTool === 'create-polygon' ? polygonDraftVertices : []
                }
                liveCursor={
                  activeTool === 'create-polygon' ? polygonDraftCursor : null
                }
                liveConfig={polygonConfig}
                selectedPolygonIds={selectedPolygonIds}
                onPolygonClick={onPolygonClick}
                onMapClickEmpty={onMapClickEmpty}
                committedVisible={layerVisibility.polygon}
                selectionEnabled={shapeSelectionEnabled}
                transformState={polygonTransform as never}
                onTransformChange={onPolygonTransformChange}
                shapeStyleOverrides={polygonStyleOverrides}
              />
            )
          case 'line':
            return (
              <MapLineOverlay
                key="line"
                map={overlayMap}
                lines={linesForOverlay}
                liveVertices={
                  activeTool === 'create-line' ? lineDraftVertices : []
                }
                liveCursor={activeTool === 'create-line' ? lineDraftCursor : null}
                liveConfig={lineConfig}
                liveSnap={activeTool === 'create-line' ? lineDraftSnap : null}
                selectedLineIds={selectedLineIds}
                onLineClick={onLineClick}
                onMapClickEmpty={onMapClickEmpty}
                committedVisible={layerVisibility.line}
                selectionEnabled={shapeSelectionEnabled}
                transformState={lineTransform as never}
                onTransformChange={onLineTransformChange}
                shapeStyleOverrides={lineStyleOverrides}
                attachedDoorsByLineId={attachedDoorsByLineId}
              />
            )
          case 'route':
            return (
              <MapRouteOverlay
                key="route"
                map={overlayMap}
                routes={savedRoutes}
                liveVertices={
                  activeTool === 'create-route' ? routeDraftVertices : []
                }
                liveCursor={activeTool === 'create-route' ? routeDraftCursor : null}
                liveConfig={routeConfig}
                liveSnap={activeTool === 'create-route' ? routeDraftSnap : null}
                selectedRouteIds={selectedRouteIds}
                onRouteClick={onRouteClick}
                onMapClickEmpty={onMapClickEmpty}
                committedVisible={layerVisibility.route}
                selectionEnabled={shapeSelectionEnabled}
              />
            )
          case 'stair':
            return (
              <MapStairOverlay
                key="stair"
                map={overlayMap}
                stairs={stairsForOverlay}
                selectedStairIds={selectedStairIds}
                committedVisible={layerVisibility.stair}
                selectionEnabled={shapeSelectionEnabled}
                onStairClick={onStairClick}
                transformState={stairTransform as never}
                onTransformChange={onStairTransformChange}
                onMapClickEmpty={onMapClickEmpty}
                floorElevations={floorElevations}
                livePreview={
                  activeTool === 'create-stair' &&
                  stairDraftAnchors.length > 0 &&
                  stairDraftCursor
                    ? {
                        // Anchors placed so far + the cursor as the
                        // trailing point. Generator handles the
                        // appropriate vertex count for each stairType.
                        vertices: [...stairDraftAnchors, stairDraftCursor],
                        config: stairConfig,
                      }
                    : null
                }
              />
            )
          case 'model':
            return (
              <MapModelOverlay
                key="model"
                map={overlayMap}
                models={modelsForOverlay}
                urlMap={modelUrlMap}
                boundingCenterMap={modelBoundingCenters}
                boundsMap={modelBounds}
                shapeExtras={modelShapeExtras}
                liveCursor={
                  activeTool === 'create-model' ? modelCursor : null
                }
                liveModelId={
                  activeTool === 'create-model' ? modelAssetId || null : null
                }
                selectedModelIds={selectedModelIds}
                committedVisible={layerVisibility.model}
                selectionEnabled={shapeSelectionEnabled}
                onModelClick={onModelClick}
                transformState={modelTransform as never}
                onTransformChange={onModelTransformChange}
              />
            )
        }
      })}
    </Fragment>
  )
}
