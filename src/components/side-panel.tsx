import { BinPopupContent } from '@/components/bin-popup-content'
import { DataLinkPanel } from '@/components/data-link/data-link-panel'
import { DataSourcesSection } from '@/components/data-link/data-sources-section'
import { ModelEditor } from '@/components/model-editor'
import { StyleRulesSection } from '@/components/style-rules/style-rules-section'
import { Button } from '@/components/ui/button'
import { ColorPicker } from '@/components/ui/color-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MixedBadge } from '@/components/ui/mixed-badge'
import { NumberInput } from '@/components/ui/number-input'
import { Slider } from '@/components/ui/slider'
import { StretchSlider } from '@/components/ui/stretch-slider'
import {
  Choice,
  ElevatorFields,
  EscalatorFields,
  configForStairType,
  type LiftFloorOption,
} from '@/components/lift-properties'
import {
  LIMIT_ELEVATION_M,
  LIMIT_DOOR_WIDTH_M,
  LIMIT_DOOR_HEIGHT_M,
  LIMIT_DOOR_FRAME_M,
  LIMIT_DOOR_LEAF_M,
  LIMIT_STAIR_STEPS,
  LIMIT_RACK_LEVELS,
  LIMIT_MARKER_SIZE_PX,
  LIMIT_WALL_THICKNESS_M,
  LIMIT_SYMBOL_SIZE_PX,
  LIMIT_STROKE_PX,
  LIMIT_HALO_PX,
} from '@/lib/input-limits'
import { BulkSliderRow, SliderRow } from '@/components/ui/slider-row'
import { Switch } from '@/components/ui/switch'
import { TextField } from '@/components/ui/text-field'
import { VirtualList } from '@/components/ui/virtual-list'
import { useSpatialBins } from '@/hooks/useSpatialShapes'
import { hasAnyContent } from '@/lib/rich-data'
import { type Grid, type Zone } from '@/lib/db'
import type {
  GridConfig,
  GridType,
  HexOrientation,
  LabelDirection,
} from '@/lib/grid-generators'
import {
  imageBboxCenter,
  imageBboxSizeMeters,
  resizeImageBboxHeightMeters,
  resizeImageBboxWidthMeters,
  scaleImageBbox,
} from '@/lib/image-generators'
import { urlForImage, rewriteFilesUrlSameOrigin } from '@/lib/binary-store'
import { lineLengthMeters } from '@/lib/line-generators'
import { useModelAssets } from '@/lib/model-assets'
import { DEFAULT_RAILING_COLOR, ROUTE_TYPE_COLORS, isLiftType } from '@/lib/shapes'
import { MarkerIconGlyph } from '@/lib/marker-icons'
import { MarkerIconPicker } from '@/components/marker-icon-picker'
import type {
  CircleShape,
  FillShapeConfig,
  ImageCrop,
  ImageShape,
  ImageShapeConfig,
  LineDash,
  LineShape,
  LineShapeConfig,
  RouteShape,
  RouteShapeConfig,
  RouteType,
  MarkerLabelPosition,
  MarkerShape,
  MarkerShapeConfig,
  ModelShape,
  ModelShapeConfig,
  PolygonShape,
  StairShape,
  StairShapeConfig,
  TextLabelConfig,
  TooltipTrigger,
} from '@/lib/shapes'
import { evaluateStairCompliance } from '@/lib/stair-generators'
import type { DoorConfig, DoorShape } from '@/lib/door/types'
import { sharedValue } from '@/lib/bulk-edit'
import { roleLabel, vocabularyFor } from '@/lib/role-vocabulary'
import {
  doorWidthMeters,
  nudgeDoorVerticesLocal,
  resizeDoorVertices,
  rotateDoorVertices,
} from '@/lib/door/generators'
import {
  LENGTH_UNITS,
  UNIT_SUFFIX,
  formatLength,
  type LengthUnit,
} from '@/lib/units'
import { useGraphicsSettings } from '@/lib/graphics-settings'
import { cn } from '@/lib/utils'
import {
  AlignCenter,
  ArrowRight,
  ArrowRightLeft,
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  Crop,
  Crosshair,
  DoorOpen,
  Download,
  Eye,
  EyeOff,
  FileText,
  Footprints,
  Frame,
  Grid3X3,
  GripVertical,
  Hash,
  Hexagon,
  Image as ImageIcon,
  Layers as LayersIcon,
  Link2,
  Lock,
  MapPin,
  Maximize2,
  MousePointerClick,
  Move,
  Package,
  Palette,
  ArrowUpDown,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pentagon,
  Plus,
  Minus,
  RotateCcw,
  RotateCw,
  Route,
  Ruler,
  Save,
  Scan,
  Search,
  Settings2,
  Sparkles,
  Spline,
  Tag,
  Trash2,
  Triangle,
  Type,
  Loader2,
  Replace,
  Wand2,
  Warehouse,
  Wrench,
  X,
} from 'lucide-react'
import { ImageLibraryDialog, ImageLibraryPicker, LibrarySourceTabs, UploadDropzone } from '@/components/upload-library'
import { useImageLibrary, type LibraryImage } from '@/lib/upload-library'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { saveSpatialEntity, useSpatialStore, type EntityKind } from '@/lib/spatial-store'

/**
 * The set of overlay types whose stacking order the user can rearrange.
 * `marker` is intentionally excluded — markers are HTML DOM nodes
 * (mapboxgl.Marker) and always render above the map canvas, so they
 * stay locked at the top of the visual stack.
 */
export type LayerKind =
  | 'image'
  | 'grid'
  | 'circle'
  | 'polygon'
  | 'line'
  | 'route'
  | 'stair'
  | 'model'
  | 'imagePlane'

/**
 * Default bottom→top order. Images go on the bottom so an uploaded
 * floor plan / site photo acts as a backdrop for the drawn geometry.
 * 3D models go on top by default so they're visible above floor plans
 * and other ground-level shapes — the user can still drag the row down
 * in the LAYERS section if they want to occlude a model with a wall
 * polygon, etc.
 */
export const DEFAULT_LAYER_ORDER: LayerKind[] = [
  'image',
  'grid',
  'circle',
  'polygon',
  'line',
  'route',
  'stair',
  'model',
  'imagePlane',
]

export type SidePanelMode =
  | 'idle'
  | 'live-draw'
  | 'grid-selected'
  | 'bulk-select'
  | 'marker-placement'
  | 'marker-selected'
  | 'marker-bulk'
  | 'circle-placement'
  | 'circle-selected'
  | 'circle-bulk'
  | 'polygon-placement'
  | 'polygon-selected'
  | 'polygon-bulk'
  | 'line-placement'
  | 'line-selected'
  | 'line-bulk'
  | 'route-placement'
  | 'route-selected'
  | 'image-placement'
  | 'image-selected'
  | 'image-bulk'
  | 'model-placement'
  | 'model-selected'
  | 'model-bulk'
  | 'text-placement'
  | 'text-selected'
  | 'text-bulk'
  | 'stair-placement'
  | 'stair-selected'
  | 'stair-bulk'
  | 'door-placement'
  | 'door-selected'
  | 'door-bulk'
  | 'image-plane-placement'
  | 'image-plane-selected'
  | 'magic-wall'
  | 'ai-map'
  | 'cross-kind-bulk'

export interface SidePanelActions {
  onRedraw?: (id: number) => void
  onDuplicate?: (id: number) => void
  onDeleteSelected?: () => void
  onRename?: (id: number, name: string) => void
  onFitToGrid?: () => void
  onExportGeoJSON?: () => void
  onExportPNG?: () => void
  onDeselect?: () => void
  /** Per-grid actions driven by the saved-grids list. */
  onSelectGrid?: (id: number, additive: boolean) => void
  onFitToGridById?: (id: number) => void
  onDeleteGridById?: (id: number) => void
  /** Per-row eye toggle in the saved-racks list. Hiding a rack hides
   *  every bin attached to it too (the bin overlay reads the grid's
   *  `config.visible` flag). */
  onToggleGridVisible?: (id: number, visible: boolean) => void
  /** Zone management actions. */
  onAssignGridToZone?: (gridId: number, zoneId: number | null) => void
  onAddZone?: (name: string, color: string) => void
  onDeleteZone?: (id: number) => void | Promise<void>
  /** Enter interactive move/rotate mode for the selected grid. */
  onStartMove?: (id: number) => void
  onStartRotate?: (id: number) => void
  onStartScale?: (id: number) => void
  onCancelTransform?: () => void
  /** Open the BinEditor dialog for the currently clicked cell. */
  onOpenBinEditor?: () => void
  /**
   * Open the linked-data editor for a non-grid shape. The host route
   * (`create-grids.tsx`) mounts `ShapeDataEditor` and toggles it via
   * the target state seeded here.
   */
  onEditShapeData?: (
    target: {
      kind: 'polygon' | 'circle' | 'line' | 'marker' | 'image' | 'model'
      shapeId: number
      shapeName?: string
    },
  ) => void
  // ---- Text-label actions ----
  onSelectTextLabel?: (id: number, additive: boolean) => void
  onFitToTextLabelById?: (id: number) => void
  onDeleteTextLabelById?: (id: number) => void
  onDuplicateTextLabel?: (id: number) => void
  onRenameTextLabel?: (id: number, name: string) => void
  onExitTextLabelPlacement?: () => void
  onStartMoveTextLabel?: (id: number) => void
  onStartRotateTextLabel?: (id: number) => void
  onStartScaleTextLabel?: (id: number) => void
  onCancelTextLabelTransform?: () => void
  textLabelTransformActive?: boolean
  textLabelTransformKind?: 'move' | 'rotate' | 'scale' | null
  /** Per-row eye toggle in the saved-text-labels list. */
  onToggleTextLabelVisible?: (id: number, visible: boolean) => void
  /** True while the user is dragging the grid or rotating it. */
  transformActive?: boolean
  transformKind?: 'move' | 'rotate' | 'scale' | null
  // ---- Marker actions ----
  onSelectMarker?: (id: number, additive: boolean) => void
  onFitToMarkerById?: (id: number) => void
  onDeleteMarkerById?: (id: number) => void
  onDuplicateMarker?: (id: number) => void
  onRenameMarker?: (id: number, name: string) => void
  onExitMarkerPlacement?: () => void
  onAssignMarkerToZone?: (markerId: number, zoneId: number | null) => void
  onStartMoveMarker?: (id: number) => void
  onCancelMarkerTransform?: () => void
  markerTransformActive?: boolean
  markerTransformKind?: 'move' | null
  onBulkDeleteMarkers?: () => void
  onBulkFitMarkers?: () => void
  onBulkPatchMarkers?: (patch: Partial<import('@/lib/shapes').MarkerShapeConfig>) => void
  /** Per-row eye toggle in the saved-markers list. */
  onToggleMarkerVisible?: (id: number, visible: boolean) => void
  // ---- Circle actions ----
  onSelectCircle?: (id: number, additive: boolean) => void
  onFitToCircleById?: (id: number) => void
  onDeleteCircleById?: (id: number) => void
  onDuplicateCircle?: (id: number) => void
  onRenameCircle?: (id: number, name: string) => void
  onExitCirclePlacement?: () => void
  onAssignCircleToZone?: (circleId: number, zoneId: number | null) => void
  onBulkDeleteCircles?: () => void
  onBulkFitCircles?: () => void
  onBulkPatchCircles?: (patch: Partial<import('@/lib/shapes').FillShapeConfig>) => void
  /** Per-row eye toggle in the saved-circles list. */
  onToggleCircleVisible?: (id: number, visible: boolean) => void
  // ---- Polygon actions ----
  onSelectPolygon?: (id: number, additive: boolean) => void
  onFitToPolygonById?: (id: number) => void
  onDeletePolygonById?: (id: number) => void
  onDuplicatePolygon?: (id: number) => void
  onRenamePolygon?: (id: number, name: string) => void
  onExitPolygonPlacement?: () => void
  onAssignPolygonToZone?: (polygonId: number, zoneId: number | null) => void
  onStartMovePolygon?: (id: number) => void
  onStartRotatePolygon?: (id: number) => void
  onStartEditPolygon?: (id: number) => void
  onCancelPolygonTransform?: () => void
  polygonTransformActive?: boolean
  polygonTransformKind?: 'move' | 'rotate' | 'edit' | null
  onBulkDeletePolygons?: () => void
  onBulkFitPolygons?: () => void
  /**
   * Apply a partial FillShapeConfig patch to every selected polygon. Only
   * the fields present in `patch` overwrite each shape's config — other
   * fields stay at each shape's individual value, so the user can change
   * e.g. just the border color without flattening everyone's opacity.
   */
  onBulkPatchPolygons?: (patch: Partial<import('@/lib/shapes').FillShapeConfig>) => void
  /** Per-row eye toggle in the saved-polygons list. Lets the user hide a
   *  single polygon (e.g. an upper-floor area) so they can interact with
   *  shapes beneath it without removing the row from persistence. */
  onTogglePolygonVisible?: (id: number, visible: boolean) => void
  // ---- Magic-wall actions ----
  /** Generate walls from the current magic-wall polygon selection.
   *  Deduped against each other (shared "party walls") and against any
   *  existing walls that already cover an edge. */
  onGenerateMagicWall?: () => void
  /** Exit magic-wall mode and clear its polygon selection. */
  onExitMagicWall?: () => void
  // ---- AI Map actions ----
  /** Fire an AI detection job on the given placed floor plan. The user
   *  can also trigger this by clicking the floor plan on the map while
   *  the AI Map tool is active. */
  onDetectFloorPlan?: (imageId: number) => void
  /** Change which floor plan the AI Map tool is targeting. Passing null
   *  clears the target (only meaningful when the facility has multiple
   *  placed floors — for a single-floor facility the target is fixed). */
  onSetAIMapTarget?: (imageId: number | null) => void
  /** Exit AI Map mode (matches magicWallExit semantics). */
  onExitAIMap?: () => void
  // ---- Line actions ----
  onSelectLine?: (id: number, additive: boolean) => void
  onFitToLineById?: (id: number) => void
  onDeleteLineById?: (id: number) => void
  onDuplicateLine?: (id: number) => void
  onRenameLine?: (id: number, name: string) => void
  onExitLinePlacement?: () => void
  onAssignLineToZone?: (lineId: number, zoneId: number | null) => void
  onStartMoveLine?: (id: number) => void
  onStartRotateLine?: (id: number) => void
  // ---- Route actions ----
  onSelectRoute?: (id: number, additive: boolean) => void
  onFitToRouteById?: (id: number) => void
  onDeleteRouteById?: (id: number) => void
  onRenameRoute?: (id: number, name: string) => void
  onExitRoutePlacement?: () => void
  onCancelLineTransform?: () => void
  lineTransformActive?: boolean
  lineTransformKind?: 'move' | 'rotate' | null
  onBulkDeleteLines?: () => void
  onBulkFitLines?: () => void
  onBulkPatchLines?: (patch: Partial<import('@/lib/shapes').LineShapeConfig>) => void
  /** Per-row eye toggle in the saved-lines list (covers aisles too). */
  onToggleLineVisible?: (id: number, visible: boolean) => void
  // ---- Stair actions ----
  onSelectStair?: (id: number, additive: boolean) => void
  onFitToStairById?: (id: number) => void
  onDeleteStairById?: (id: number) => void
  onDuplicateStair?: (id: number) => void
  onRenameStair?: (id: number, name: string) => void
  onAssignStairToZone?: (stairId: number, zoneId: number | null) => void
  onExitStairPlacement?: () => void
  /** Per-row eye toggle in the saved-stairs list. */
  onToggleStairVisible?: (id: number, visible: boolean) => void
  /** Bulk actions for stairs when multiple are selected. */
  onBulkDeleteStairs?: () => void
  onBulkFitStairs?: () => void
  onBulkPatchStairs?: (patch: Partial<import('@/lib/shapes').StairShapeConfig>) => void
  onStartRotateStair?: (id: number) => void
  onStartMoveStair?: (id: number) => void
  onCancelStairTransform?: () => void
  stairTransformKind?: 'move' | 'rotate' | null
  // ---- Door actions ----
  onSelectDoor?: (id: number, additive: boolean) => void
  onFitToDoorById?: (id: number) => void
  onDeleteDoorById?: (id: number) => void
  onDuplicateDoor?: (id: number) => void
  onRenameDoor?: (id: number, name: string) => void
  onExitDoorPlacement?: () => void
  onSetDoorVisible?: (id: number, visible: boolean) => void
  /** Enter / exit interactive transform mode for a single selected door. */
  onStartMoveDoor?: (id: number) => void
  onStartRotateDoor?: (id: number) => void
  onStartScaleDoor?: (id: number) => void
  onCancelDoorTransform?: () => void
  /** True while the user is dragging the orange handle on the map. */
  doorTransformActive?: boolean
  doorTransformKind?: 'move' | 'rotate' | 'scale' | null
  /** Bulk actions for doors when multiple are selected. */
  onBulkDeleteDoors?: () => void
  onBulkFitDoors?: () => void
  onBulkPatchDoors?: (patch: Partial<import('@/lib/door/types').DoorConfig>) => void
  /** Enter interactive move/rotate mode for the selected circle. */
  onStartMoveCircle?: (id: number) => void
  onStartRotateCircle?: (id: number) => void
  onCancelCircleTransform?: () => void
  /** True while the user is dragging the circle handle. */
  circleTransformActive?: boolean
  circleTransformKind?: 'move' | 'rotate' | null
  // ---- Image actions ----
  onSelectImage?: (id: number, additive: boolean) => void
  onFitToImageById?: (id: number) => void
  onDeleteImageById?: (id: number) => void
  onDuplicateImage?: (id: number) => void
  onRenameImage?: (id: number, name: string) => void
  onExitImagePlacement?: () => void
  onAssignImageToZone?: (imageId: number, zoneId: number | null) => void
  onStartMoveImage?: (id: number) => void
  onStartRotateImage?: (id: number) => void
  onStartScaleImage?: (id: number) => void
  onCancelImageTransform?: () => void
  imageTransformActive?: boolean
  imageTransformKind?: 'move' | 'rotate' | 'scale' | null
  onBulkDeleteImages?: () => void
  onBulkFitImages?: () => void
  onBulkPatchImages?: (patch: Partial<import('@/lib/shapes').ImageShapeConfig>) => void
  /** Upload a new image file — used by the placement panel's picker. */
  onPickImageFile?: (file: File) => void
  /** Reuse a file from the workspace's upload library as the draft. */
  onPickLibraryImage?: (item: LibraryImage) => void
  /** Swap a placed floor plan's picture for a library file. */
  onReplaceImageFile?: (imageId: number, item: LibraryImage) => void | Promise<void>
  /** Clear the in-flight placement draft. */
  onClearImageDraft?: () => void
  /**
   * Toggle a single floor-plan / image's visibility from the saved-
   * images list. Hiding cascades to every shape with
   * `floorPlanId === id` — that's what lets the user dim the ground
   * floor while drawing on a higher floor without removing data.
   */
  onToggleImageVisible?: (id: number, visible: boolean) => void
  /**
   * Persist a new floor-plan order (top → bottom). The first entry
   * becomes the "default" floor plan the viewer opens on when no
   * share-link lock is set, and dictates the order of entries in the
   * viewer's floor dropdown. Sent as an array of image ids so ordering
   * can be inferred even when a plan is temporarily missing from the
   * live list.
   */
  onReorderFloorPlans?: (orderedIds: number[]) => void
  // ---- Image-plane actions ----
  onSelectImagePlane?: (id: number, additive: boolean) => void
  onFitToImagePlaneById?: (id: number) => void
  onDeleteImagePlaneById?: (id: number) => void
  onDuplicateImagePlane?: (id: number) => void
  onRenameImagePlane?: (id: number, name: string) => void
  onToggleImagePlaneVisible?: (id: number, visible: boolean) => void
  onStartMoveImagePlane?: (id: number) => void
  onCancelImagePlaneTransform?: () => void
  imagePlaneTransformActive?: boolean
  // ---- Model (glTF / GLB) actions ----
  onSelectModel?: (id: number, additive: boolean) => void
  onFitToModelById?: (id: number) => void
  onDeleteModelById?: (id: number) => void
  onDuplicateModel?: (id: number) => void
  onRenameModel?: (id: number, name: string) => void
  onAssignModelToZone?: (modelId: number, zoneId: number | null) => void
  /** Enter move mode for the selected model — the overlay attaches a draggable handle. */
  onStartMoveModel?: () => void
  /** Cancel an in-flight move. */
  onCancelModelTransform?: () => void
  modelTransformActive?: boolean
  /** Per-row eye toggle in the saved-models list. */
  onToggleModelVisible?: (id: number, visible: boolean) => void
  /** Bulk actions for models when multiple are selected. */
  onBulkDeleteModels?: () => void
  onBulkFitModels?: () => void
  onBulkPatchModels?: (patch: Partial<import('@/lib/shapes').ModelShapeConfig>) => void
  // ---- Text-label bulk actions ----
  onBulkDeleteTextLabels?: () => void
  onBulkFitTextLabels?: () => void
  onBulkPatchTextLabels?: (patch: Partial<import('@/lib/shapes').TextLabelConfig>) => void
  // Cross-kind bulk actions — fired from the marquee-produced
  // cross-kind bulk view. Each fans out to whichever per-kind
  // handlers apply (see `handleCrossKindDelete` etc in create-grids).
  onCrossKindDelete?: () => void
  onCrossKindSetVisibility?: (visible: boolean) => void
  onCrossKindChangeFloor?: () => void
  onCrossKindClear?: () => void
}

interface SidePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: SidePanelMode
  config: GridConfig
  onConfigChange: (config: GridConfig) => void
  selectedGrid?: Grid | null
  /** The grid cell the user clicked (drives the "Edit bin" button's enabled state). */
  selectedBin?: { gridId: number; row: number; col: number; level: number } | null
  bulkSelectedCount?: number
  drawMode: boolean
  onToggleDrawMode: () => void
  /**
   * True while the panel has buffered edits that haven't been auto-
   * committed yet (the debounced auto-save fires ~700 ms after the
   * last change). Rendered as a small "•" next to the shape name so
   * the user has a visible pulse while typing / dragging sliders.
   */
  isDirty?: boolean
  hasDrawLine: boolean
  /** All saved grids (used to render the Saved Grids list). */
  grids?: ReadonlyArray<Grid>
  /** All zones (used to render the Zones list + per-grid zone picker). */
  zones?: ReadonlyArray<Zone>
  /**
   * Active warehouse id — drives lookups against the per-warehouse
   * role vocabulary so the role pickers on polygon / circle editors
   * speak the right vocabulary for THIS building.
   */
  activeWarehouseId?: number | null
  /** IDs that are part of the current multi-selection. */
  selectedGridIds?: ReadonlySet<number>
  /** When false, hide the Zones section entirely (toolbar's toggle). */
  zonesVisible?: boolean
  /**
   * Called when the user picks a unit from the footer picker while no grid
   * is selected. The parent should persist this as the new global default
   * (via `setDisplayUnit`).
   */
  onPersistDefaultUnit?: (unit: LengthUnit) => void
  // ---- Marker props ----
  markers?: ReadonlyArray<MarkerShape>
  selectedMarker?: MarkerShape | null
  selectedMarkerIds?: ReadonlySet<number>
  /** Default marker config used during placement (live-edit while placing). */
  markerConfig?: MarkerShapeConfig
  /** Update the marker draft (placement) or the selected marker's config. */
  onMarkerConfigChange?: (config: MarkerShapeConfig) => void
  /** Patch top-level marker fields (bearing, position, ...) on the selected marker. */
  onMarkerPatch?: (patch: Partial<MarkerShape>) => void
  // ---- Circle props ----
  circles?: ReadonlyArray<CircleShape>
  selectedCircle?: CircleShape | null
  selectedCircleIds?: ReadonlySet<number>
  /** Style config used for the next placed circle / edits to the selected one. */
  circleConfig?: FillShapeConfig
  onCircleConfigChange?: (config: FillShapeConfig) => void
  /** Single vs. grid-of-circles sub-mode for the placement panel. */
  circleSubMode?: 'single' | 'grid'
  onCircleSubModeChange?: (mode: 'single' | 'grid') => void
  /** Cell size (meters) for the grid-of-circles sub-mode. */
  circleCellSize?: number
  onCircleCellSizeChange?: (meters: number) => void
  /** Circle radius (meters) inscribed in each cell for the grid sub-mode. */
  circleCellRadius?: number
  onCircleCellRadiusChange?: (meters: number) => void
  /** Patch geometry fields on the currently-selected circle. */
  onCirclePatch?: (patch: Partial<CircleShape>) => void
  // ---- Polygon props ----
  polygons?: ReadonlyArray<PolygonShape>
  selectedPolygon?: PolygonShape | null
  selectedPolygonIds?: ReadonlySet<number>
  polygonConfig?: FillShapeConfig
  onPolygonConfigChange?: (config: FillShapeConfig) => void
  onPolygonPatch?: (patch: Partial<PolygonShape>) => void
  /** Live vertex count during polygon placement. */
  polygonDraftVertexCount?: number
  // ---- Magic-wall props ----
  /** Polygons currently marked in the magic-wall selection set. This is a
   *  distinct set from `selectedPolygonIds` — the magic-wall mode manages
   *  its own selection so entering the mode doesn't disturb the user's
   *  prior polygon selection. */
  magicWallSelectedPolygonIds?: ReadonlySet<number>
  /** True while a batch Generate is in flight. Disables the Generate
   *  button and swaps the label to a spinner-style busy state. */
  magicWallBusy?: boolean
  /** True while an AI detection job is starting or running. Disables
   *  the per-image Detect buttons so the user can't fire a second job
   *  before the first returns (server also enforces via the hourly
   *  rate limiter, but disabling client-side reads more responsive). */
  aiMapBusy?: boolean
  /** The floor plan the AI Map tool is currently targeting. Starts as
   *  the editor's `defaultFloorPlanId`; the sidebar's picker overrides
   *  it when the facility has more than one placed floor. Only meaningful
   *  when the AI Map tool is active. */
  aiMapTargetImageId?: number | null
  // ---- Line props ----
  lines?: ReadonlyArray<LineShape>
  selectedLine?: LineShape | null
  selectedLineIds?: ReadonlySet<number>
  lineConfig?: LineShapeConfig
  onLineConfigChange?: (config: LineShapeConfig) => void
  onLinePatch?: (patch: Partial<LineShape>) => void
  /** Live vertex count during line placement. */
  lineDraftVertexCount?: number
  // ---- Route props ----
  routes?: ReadonlyArray<RouteShape>
  selectedRoute?: RouteShape | null
  selectedRouteIds?: ReadonlySet<number>
  routeConfig?: RouteShapeConfig
  onRouteConfigChange?: (config: RouteShapeConfig) => void
  onRoutePatch?: (patch: Partial<RouteShape>) => void
  routeDraftVertexCount?: number
  // ---- Stair props ----
  stairs?: ReadonlyArray<StairShape>
  selectedStair?: StairShape | null
  selectedStairIds?: ReadonlySet<number>
  stairConfig?: StairShapeConfig
  onStairConfigChange?: (config: StairShapeConfig) => void
  onStairPatch?: (patch: Partial<StairShape>) => void
  /** Whether the user has placed the bottom anchor and is dragging to the top. */
  /** Number of placement anchors the user has clicked so far. */
  stairPlacementAnchorCount?: number
  // ---- Door props ----
  doors?: ReadonlyArray<DoorShape>
  selectedDoor?: DoorShape | null
  selectedDoorIds?: ReadonlySet<number>
  doorConfig?: DoorConfig
  onDoorConfigChange?: (config: DoorConfig) => void
  onDoorPatch?: (patch: Partial<DoorShape>) => void
  /** Number of placement anchors the user has clicked so far (0 or 1). */
  doorPlacementAnchorCount?: number
  /**
   * Default opening width (m) applied to the next-drawn door. Drives
   * the pre-first-click cursor ghost + the single-click wall-snap
   * commit width. The free 2-click flow is unaffected — the width
   * there is defined by the two click points themselves.
   */
  doorPendingWidthMeters?: number
  onDoorPendingWidthMetersChange?: (widthMeters: number) => void
  // ---- Image props ----
  images?: ReadonlyArray<ImageShape>
  selectedImage?: ImageShape | null
  selectedImageIds?: ReadonlySet<number>
  /**
   * Per-warehouse floor-plan order (top → bottom, top = default).
   * Missing / partial arrays are self-healed by the list — images NOT
   * in the list fall to the end. Empty / undefined = fall back to
   * id-sort. Persisted at the host via `onReorderFloorPlans`.
   */
  floorPlanOrder?: ReadonlyArray<number>
  /** Style config used for the next placed image / edits to the selected one. */
  imageConfig?: ImageShapeConfig
  onImageConfigChange?: (config: ImageShapeConfig) => void
  /** Patch top-level image fields (position, width, height, rotation, ...). */
  onImagePatch?: (patch: Partial<ImageShape>) => void
  /**
   * In-flight upload state shown in the placement panel — set when the
   * user has picked a file but not yet drawn the bbox on the map. The
   * panel renders a thumbnail + filename so the user can confirm the
   * upload before placing.
   */
  imageDraft?: {
    fileName: string
    dataUrl: string
    naturalWidth: number
    naturalHeight: number
    /** Set for a rasterized PDF sheet so the panel can say so. */
    sourceKind?: 'pdf' | 'dwg'
    /** Chosen plot scale denominator (N in 1:N), absent when uncalibrated. */
    scaleDenominator?: number
    /** Set only for a scaled PDF sheet — the bbox is snapped to it. */
    realWidthMeters?: number
    realHeightMeters?: number
    /** Set while a fresh upload is still in flight. */
    pendingUpload?: Promise<string | undefined>
  } | null
  /**
   * Current bottom→top stacking order of the reorderable overlay types.
   * Mirrors React's mount order in the parent, so dragging here re-renders
   * the overlays in a new order and Mapbox's `addLayer` calls fire in
   * matching order. Markers are not part of this list.
   */
  layerOrder?: LayerKind[]
  onLayerOrderChange?: (order: LayerKind[]) => void
  // ---- Model (glTF / GLB) props ----
  /**
   * Placed 3D model instances. Surfaced in the side panel as a "3D
   * models" list (one row per placed model) with click-to-select +
   * delete. The full editor renders inline below the list when a
   * single model is selected (mode === 'model-selected').
   */
  models?: ReadonlyArray<ModelShape>
  selectedModel?: ModelShape | null
  selectedModelIds?: ReadonlySet<number>
  /** Patch handler for the selected model — top-level + config fields. */
  onModelPatch?: (patch: {
    config?: Partial<import('@/lib/shapes').ModelShapeConfig>
    name?: string
    visible?: boolean
  }) => void
  /** Open the asset-swap library dialog. */
  onModelSwapAsset?: () => void
  // ---- Image plane (3D image) props ----
  imagePlanes?: ReadonlyArray<import('@/lib/shapes').ImagePlaneShape>
  selectedImagePlane?: import('@/lib/shapes').ImagePlaneShape | null
  selectedImagePlaneIds?: ReadonlySet<number>
  onImagePlanePatch?: (patch: {
    config?: Partial<import('@/lib/shapes').ImagePlaneShapeConfig>
    name?: string
    visible?: boolean
  }) => void
  // ---- Text label props ----
  textLabels?: ReadonlyArray<import('@/lib/shapes').TextLabelShape>
  selectedTextLabel?: import('@/lib/shapes').TextLabelShape | null
  selectedTextLabelIds?: ReadonlySet<number>
  textLabelConfig?: import('@/lib/shapes').TextLabelConfig
  onTextLabelConfigChange?: (cfg: import('@/lib/shapes').TextLabelConfig) => void
  onTextLabelPatch?: (
    patch: Partial<import('@/lib/shapes').TextLabelShape>,
  ) => void
  actions?: SidePanelActions
  /**
   * Data-link catalog + edit callbacks. When both `dataLinks` and the
   * three callbacks are passed, every shape-selected panel gets a
   * DataLinkPanel section listing configs bound to the current shape
   * with edit / delete / add controls. Optional so headless usages
   * (bulk-editor, stateless preview) skip the section entirely.
   */
  dataLinks?: ReadonlyArray<import('@/lib/db').DataLinkConfig>
  onDataLinkNew?: () => void
  onDataLinkEdit?: (configId: number) => void
  onDataLinkDelete?: (configId: number) => void
}

export const SIDE_PANEL_DEFAULT_CONFIG: GridConfig = {
  type: 'square',
  xSize: 10,
  ySize: 10,
  cellGap: 0,
  unit: 'm',
  rotation: 0,
  color: '#6366f1',
  borderColor: '#4338ca',
  borderWidth: 1,
  opacity: 50,
  elevation: 0,
  height: 0,
  hexOrientation: 'pointy',
  showLabels: true,
  visible: true,
  labelStart: 1,
  labelDirection: 'x',
  labelPrefix: '',
  labelSize: 11,
  labelColor: '#000000',
  labelAltitude: 0,
  // Single-level by default — keeps new grids backwards-compatible with
  // the pre-racking renderer. Users opt into multi-level pallet racks
  // from the side-panel Vertical section.
  levels: 1,
  levelHeight: 1.5,
  levelGap: 0,
}

/**
 * Context the *workspace* (idle) side panel installs so its child
 * sections gain two behaviours without each component having to opt
 * in:
 *
 *   1. Item-level search — each list reads `query` via
 *      `useWorkspaceQuery()` and filters its items by their visible
 *      label (e.g. a Grid's name, a Marker's name, a Style Rule's
 *      name, a layer-kind's translated label). A list with zero
 *      matches returns `null` from its render so the whole section —
 *      header included — drops out of the layout. The user's intent
 *      ("find Rack 12") matches everyday list-search behaviour
 *      instead of forcing them to think in section names.
 *   2. Collapse — title becomes a button that toggles its `collapsed`
 *      entry. State is keyed by the section's translated title so it
 *      survives unrelated re-renders. While a query is active every
 *      section auto-expands so matching items aren't hidden behind a
 *      collapsed chevron; the prior collapsed state restores the
 *      moment the query is cleared.
 *
 * Outside the workspace (selected-shape editors, placement panels,
 * etc.) no provider is mounted, the context is `null`, `Section`
 * falls back to its original static header, and `useWorkspaceQuery()`
 * returns an empty string. That way the same Section component is
 * reusable everywhere without leaking workspace-only UI into
 * shape-editing flows.
 */
interface WorkspaceSidebarCtx {
  query: string
  collapsed: ReadonlySet<string>
  toggleCollapsed: (title: string) => void
}
const WorkspaceSidebarContext = createContext<WorkspaceSidebarCtx | null>(null)

/**
 * Read the active workspace search query. Returns `''` outside the
 * workspace provider so any list component using this hook becomes a
 * no-op (no filtering) in shape editors and other non-workspace
 * surfaces that happen to render saved-list components.
 */
export function useWorkspaceQuery(): string {
  return useContext(WorkspaceSidebarContext)?.query ?? ''
}

/**
 * True when the given label matches the active search query. Used by
 * each list component to filter its items. Case-insensitive
 * substring match; empty query matches everything. Centralised so the
 * matching rule stays consistent across every list — if the rule
 * needs to become fuzzy or tokenised later, this is the one place to
 * change it.
 */
export function matchesWorkspaceQuery(label: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return label.toLowerCase().includes(q)
}

export function Section({
  title,
  icon: Icon,
  children,
  dataAttribute,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  /** Optional `data-*` attribute name added to the title row, useful for
   * `document.querySelector` from outside (e.g. scrolling the section
   * into view from the toolbar). */
  dataAttribute?: string
}) {
  const ws = useContext(WorkspaceSidebarContext)
  // Outside workspace mode → render the original static header.
  // Icon is nested inside a small tinted chip so it reads as a
  // section badge, matching the design language of the app header.
  if (!ws) {
    return (
      <section className="space-y-2.5">
        <div
          className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
          {...(dataAttribute ? { [dataAttribute]: '' } : {})}
        >
          <span
            className="flex items-center justify-center w-5 h-5 rounded-md bg-primary/10 text-primary ring-1 ring-primary/15 flex-shrink-0"
            aria-hidden
          >
            <Icon className="w-3 h-3" />
          </span>
          <span className="min-w-0 truncate">{title}</span>
        </div>
        {children}
      </section>
    )
  }
  // Workspace mode. While the user is typing a query we force every
  // remaining section open: list-level filtering already hid the
  // sections that had no matches, so any section that still renders
  // has at least one matching item that the user needs to see.
  // Clearing the query restores whatever collapsed state was there
  // before, since we never mutate `ws.collapsed` here.
  const searching = ws.query.trim().length > 0
  const isCollapsed = !searching && ws.collapsed.has(title)
  return (
    <section className="space-y-2.5">
      <button
        type="button"
        onClick={() => {
          if (!searching) ws.toggleCollapsed(title)
        }}
        className={cn(
          'group flex items-center gap-2 w-full -mx-2 px-2 py-1 rounded-md',
          'text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground',
          'hover:text-foreground hover:bg-muted/60 transition-colors',
          'disabled:cursor-default disabled:hover:text-muted-foreground disabled:hover:bg-transparent',
        )}
        aria-expanded={!isCollapsed}
        disabled={searching}
        {...(dataAttribute ? { [dataAttribute]: '' } : {})}
      >
        <span
          className={cn(
            'flex items-center justify-center w-5 h-5 rounded-md ring-1 flex-shrink-0 transition-colors',
            'bg-primary/10 text-primary ring-primary/15',
            'group-hover:bg-primary/15 group-hover:ring-primary/25',
          )}
          aria-hidden
        >
          <Icon className="w-3 h-3" />
        </span>
        <span className="flex-1 text-start truncate">{title}</span>
        {/* Hide the chevron while searching — there's no toggle
            behaviour to communicate when every section is forced
            open. Rotate the same chevron instead of swapping icons
            so the transition animates smoothly. */}
        {!searching && (
          <ChevronRight
            className={cn(
              'w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/70 transition-transform duration-150',
              !isCollapsed && 'rotate-90',
            )}
          />
        )}
      </button>
      {!isCollapsed && children}
    </section>
  )
}

/**
 * Normalize a user-typed hex string into the canonical `#rrggbb` form.
 * Accepts:
 *   - `#abc` or `abc` (3-char shorthand — expanded to `#aabbcc`)
 *   - `#abcdef` or `abcdef` (6-char full)
 *   - Mixed case (lowercased)
 *   - Stray whitespace
 * Returns null when the input doesn't match any of those.
 */
function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs">{label}</Label>
      <ColorPicker value={value} onChange={onChange} ariaLabel={label} />
    </div>
  )
}

/**
 * Compact dropdown that switches the active display unit. Renders the
 * current unit as a pill — clicking opens a popover listing all units.
 * The list closes on outside-click.
 */
function UnitPicker({
  value,
  onChange,
}: {
  value: LengthUnit
  onChange: (unit: LengthUnit) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('sidePanel.unitPickerTitle')}
        aria-label={t('sidePanel.unitPickerTitle')}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1 h-8 px-2.5 rounded-md border text-xs font-mono transition-colors',
          open
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-input hover:bg-accent'
        )}
      >
        <Ruler className="w-3 h-3 opacity-70" />
        {UNIT_SUFFIX[value]}
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div
          className="absolute end-0 bottom-full mb-1 z-30 min-w-[140px] bg-popover border rounded-md shadow-lg p-1 text-xs"
          role="listbox"
        >
          {LENGTH_UNITS.map((u) => (
            <button
              key={u}
              type="button"
              role="option"
              aria-selected={u === value}
              onClick={() => {
                onChange(u)
                setOpen(false)
              }}
              className={cn(
                'w-full flex items-center justify-between px-2 py-1.5 rounded text-start hover:bg-accent',
                u === value && 'bg-accent'
              )}
            >
              <span>{t(`sidePanel.unit_${u}`)}</span>
              <span className="font-mono text-muted-foreground">{UNIT_SUFFIX[u]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function GridNameEditor({
  initial,
  onCommit,
  onCancel,
  className,
}: {
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = value.trim()
        if (trimmed) onCommit(trimmed)
        else onCancel()
      }}
      className={cn('flex items-center gap-1', className)}
    >
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        onBlur={() => {
          const trimmed = value.trim()
          if (trimmed && trimmed !== initial) onCommit(trimmed)
          else onCancel()
        }}
        className="text-sm h-7"
        aria-label={t('sidePanel.gridName')}
      />
    </form>
  )
}

export function SidePanel({
  open,
  onOpenChange,
  mode,
  config,
  onConfigChange,
  selectedGrid,
  selectedBin,
  bulkSelectedCount = 0,
  drawMode,
  onToggleDrawMode,
  isDirty = false,
  hasDrawLine,
  grids,
  zones,
  activeWarehouseId,
  selectedGridIds,
  zonesVisible = true,
  onPersistDefaultUnit,
  markers,
  selectedMarker,
  selectedMarkerIds,
  markerConfig,
  onMarkerConfigChange,
  onMarkerPatch,
  circles,
  selectedCircle,
  selectedCircleIds,
  circleConfig,
  onCircleConfigChange,
  circleSubMode = 'single',
  onCircleSubModeChange,
  circleCellSize = 20,
  onCircleCellSizeChange,
  circleCellRadius = 8,
  onCircleCellRadiusChange,
  onCirclePatch,
  polygons,
  selectedPolygon,
  selectedPolygonIds,
  polygonConfig,
  onPolygonConfigChange,
  onPolygonPatch,
  polygonDraftVertexCount = 0,
  magicWallSelectedPolygonIds,
  magicWallBusy = false,
  aiMapBusy = false,
  aiMapTargetImageId = null,
  lines,
  selectedLine,
  selectedLineIds,
  lineConfig,
  onLineConfigChange,
  onLinePatch,
  lineDraftVertexCount = 0,
  selectedRoute,
  selectedRouteIds,
  routeConfig,
  onRouteConfigChange,
  onRoutePatch,
  routeDraftVertexCount = 0,
  stairs,
  selectedStair,
  selectedStairIds,
  stairConfig,
  onStairConfigChange,
  onStairPatch,
  stairPlacementAnchorCount = 0,
  doors,
  selectedDoor,
  selectedDoorIds,
  doorConfig,
  onDoorConfigChange,
  onDoorPatch,
  doorPlacementAnchorCount = 0,
  doorPendingWidthMeters,
  onDoorPendingWidthMetersChange,
  images,
  selectedImage,
  selectedImageIds,
  floorPlanOrder,
  imageConfig,
  onImageConfigChange,
  onImagePatch,
  imageDraft,
  layerOrder,
  onLayerOrderChange,
  models,
  selectedModel,
  selectedModelIds,
  onModelPatch,
  onModelSwapAsset,
  imagePlanes,
  selectedImagePlane,
  selectedImagePlaneIds,
  onImagePlanePatch,
  textLabels,
  selectedTextLabel,
  selectedTextLabelIds,
  textLabelConfig,
  onTextLabelConfigChange,
  onTextLabelPatch,
  actions,
  dataLinks,
  onDataLinkNew,
  onDataLinkEdit,
  onDataLinkDelete,
}: SidePanelProps) {
  const { t, i18n } = useTranslation()
  const isRTL = i18n.dir() === 'rtl'
  // Floor plans a lift (escalator / elevator) can link to.
  const liftFloors = useMemo<LiftFloorOption[]>(
    () =>
      (images ?? [])
        .filter((img) => img.id !== undefined)
        .map((img) => ({ id: img.id as number, name: img.name, elevation: img.config.elevation ?? 0 }))
        .sort((a, b) => a.elevation - b.elevation),
    [images],
  )
  // Idle view: a skeleton until every shape kind has loaded, then the
  // empty state only if the facility really has nothing — it used to say
  // "empty" while the first load was still running.
  const shapesLoaded = useSpatialStore((s) =>
    (['grids', 'markers', 'circles', 'polygons', 'lines', 'images', 'models', 'stairs', 'text-labels', 'doors', 'image-planes', 'routes'] as const).every(
      (k) => s.loadedFor[k] !== undefined,
    ),
  )
  const facilityEmpty = useSpatialStore(
    (s) =>
      s.grids.length + s.markers.length + s.circles.length + s.polygons.length + s.lines.length + s.images.length +
        s.models.length + s.stairs.length + s.textLabels.length + s.doors.length + s.imagePlanes.length + s.routes.length ===
      0,
  )
  const [editingName, setEditingName] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  /**
   * Render the per-shape DataLinkPanel — only when both the catalog
   * and the required callbacks were supplied by the host. The panel
   * appears at the bottom of each shape-selected content block; the
   * host owns the editor-open state so this stays purely presentational.
   */
  const renderDataLinkPanel = (
    kind: import('@/lib/db').DataLinkConfig['targetKind'],
    shapeId: number | undefined,
  ) => {
    if (
      shapeId === undefined ||
      dataLinks === undefined ||
      onDataLinkNew === undefined ||
      onDataLinkEdit === undefined ||
      onDataLinkDelete === undefined
    ) {
      return null
    }
    // v2: include kind-wide configs (attribute-join / external-code)
    // even though they don't set targetShapeId. Any of them COULD paint
    // on this shape at runtime, so the side-panel needs to surface
    // them. Explicit-shape configs still filter by shapeId as before.
    const forShape = dataLinks.filter((c) => {
      if (c.targetKind !== kind) return false
      const mode = c.fieldMapping?.match?.mode
      if (mode === 'attribute-join' || mode === 'external-code') return true
      return c.targetShapeId === shapeId
    })
    return (
      <DataLinkPanel
        configs={forShape}
        onNew={onDataLinkNew}
        onEdit={onDataLinkEdit}
        onDelete={onDataLinkDelete}
      />
    )
  }

  // Workspace-mode sidebar state — the search query the user has
  // typed and which sections they've collapsed. Stored at the panel
  // level so it survives the panel re-rendering as data updates
  // arrive (each `useLiveQuery` change reruns the whole tree). Each
  // collapsed entry is keyed by the section's translated title, which
  // is what `Section` sees as its `title` prop.
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('sgv-panel-collapsed')
      if (!raw) return new Set()
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? new Set(parsed) : new Set()
    } catch {
      return new Set()
    }
  })
  const toggleCollapsed = useCallback((title: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      try {
        localStorage.setItem('sgv-panel-collapsed', JSON.stringify([...next]))
      } catch {
        /* ignore quota / disabled storage */
      }
      return next
    })
  }, [])
  const workspaceCtx = useMemo(
    () => ({
      query: workspaceQuery,
      collapsed: collapsedSections,
      toggleCollapsed,
    }),
    [workspaceQuery, collapsedSections, toggleCollapsed],
  )

  const update = <K extends keyof GridConfig>(key: K, value: GridConfig[K]) => {
    onConfigChange({ ...config, [key]: value })
  }

  // The "active" config is whichever one the user is currently editing —
  // the selected grid's config when one grid is selected, otherwise the
  // default config from props. The footer's unit picker mutates this.
  const activeConfig: GridConfig =
    mode === 'grid-selected' && selectedGrid ? selectedGrid.config : config

  // Resolve the active warehouse so role pickers can read its
  // vocabulary. Memoised so the role-picker dropdown doesn't re-render
  // every keystroke in an unrelated field.
  const activeWarehouse = useMemo(
    () =>
      activeWarehouseId != null
        ? zones?.find((z) => z.id === activeWarehouseId) ?? null
        : null,
    [activeWarehouseId, zones],
  )
  // For selected shapes the unit is sourced from the shape itself
  // (markers and circles store their own `unit` like grids do); other
  // modes fall back to the grid config's unit, which mirrors the
  // global preference.
  const activeUnit: LengthUnit =
    mode === 'marker-selected' && selectedMarker
      ? selectedMarker.unit
      : mode === 'circle-selected' && selectedCircle
        ? selectedCircle.unit
        : mode === 'polygon-selected' && selectedPolygon
          ? selectedPolygon.unit
          : mode === 'line-selected' && selectedLine
            ? selectedLine.unit
            : mode === 'image-selected' && selectedImage
              ? selectedImage.unit
              : mode === 'model-selected' && selectedModel
                ? selectedModel.unit
                : activeConfig.unit ?? 'm'

  const gridTypes: { id: GridType; icon: typeof Grid3X3; label: string }[] = [
    { id: 'square', icon: Grid3X3, label: t('sidePanel.shapeSquare') },
    { id: 'triangle', icon: Triangle, label: t('sidePanel.shapeTriangle') },
    { id: 'hexagon', icon: Hexagon, label: t('sidePanel.shapeHexagon') },
  ]

  // ---- Header content (varies by mode) ------------------------------------
  const headerIcon =
    mode === 'grid-selected' || mode === 'bulk-select' ? (
      <div
        className="flex-shrink-0 w-4 h-4 border-2 rounded"
        style={{ backgroundColor: selectedGrid?.config.color ?? '#6366f1' }}
        aria-hidden="true"
      />
    ) : mode === 'marker-selected' && selectedMarker ? (
      <MarkerIconGlyph
        icon={selectedMarker.config.icon}
        className="flex-shrink-0 w-4 h-4"
        style={{ color: selectedMarker.config.iconColor ?? '#6366f1' }}
        aria-hidden="true"
      />
    ) : mode === 'marker-placement' ? (
      <MapPin className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'circle-selected' && selectedCircle ? (
      <div
        className="flex-shrink-0 w-4 h-4 border-2 rounded-full"
        style={{
          backgroundColor: selectedCircle.config.color,
          borderColor: selectedCircle.config.borderColor,
        }}
        aria-hidden="true"
      />
    ) : mode === 'circle-placement' ? (
      <Circle className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'polygon-selected' && selectedPolygon ? (
      <div
        className="flex-shrink-0 w-4 h-4 border-2 rounded-sm"
        style={{
          backgroundColor: selectedPolygon.config.color,
          borderColor: selectedPolygon.config.borderColor,
        }}
        aria-hidden="true"
      />
    ) : mode === 'polygon-placement' ? (
      <Pentagon className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'magic-wall' ? (
      <Wand2 className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'ai-map' ? (
      <Sparkles className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'line-selected' && selectedLine ? (
      <div
        className="w-4 h-1.5 rounded-sm flex-shrink-0"
        style={{ backgroundColor: selectedLine.config.color }}
        aria-hidden="true"
      />
    ) : mode === 'line-placement' ? (
      <Spline className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'image-selected' && selectedImage ? (
      <img
        src={urlForImage(selectedImage)}
        alt=""
        className="flex-shrink-0 object-cover w-4 h-4 border rounded-sm"
        aria-hidden="true"
      />
    ) : mode === 'image-placement' ? (
      <ImageIcon className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'model-selected' && selectedModel ? (
      <div
        className="flex items-center justify-center flex-shrink-0 w-4 h-4 border-2 rounded border-primary/40 bg-primary/15"
        aria-hidden="true"
      >
        <Box className="w-2.5 h-2.5 text-primary" />
      </div>
    ) : mode === 'model-placement' ? (
      <Box className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'text-selected' && selectedTextLabel ? (
      <span
        className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded border bg-background"
        style={{
          color: selectedTextLabel.config.color,
          borderColor: selectedTextLabel.config.haloColor,
        }}
        aria-hidden="true"
      >
        T
      </span>
    ) : mode === 'text-placement' ? (
      <Type className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'stair-selected' && selectedStair ? (
      <div
        className="flex items-center justify-center flex-shrink-0 w-4 h-4 border-2 rounded border-primary/40"
        style={{ backgroundColor: selectedStair.config.color }}
        aria-hidden="true"
      >
        <Footprints className="w-2.5 h-2.5 text-primary" />
      </div>
    ) : mode === 'stair-placement' ? (
      <Footprints className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : mode === 'door-selected' && selectedDoor ? (
      <div
        className="flex items-center justify-center flex-shrink-0 w-4 h-4 border-2 rounded border-primary/40"
        style={{ backgroundColor: selectedDoor.config.leafColor }}
        aria-hidden="true"
      >
        <DoorOpen className="w-2.5 h-2.5 text-primary" />
      </div>
    ) : mode === 'door-placement' ? (
      <DoorOpen className="flex-shrink-0 w-4 h-4 text-primary" />
    ) : (
      <Settings2 className="flex-shrink-0 w-4 h-4 text-primary" />
    )

  let headerTitle: React.ReactNode = (
    <span className="text-sm font-semibold leading-tight truncate">
      {t('sidePanel.title')}
    </span>
  )
  let headerSubtitle: React.ReactNode = (
    <span className="text-xs leading-tight text-muted-foreground">
      {t('sidePanel.subtitle')}
    </span>
  )

  if (mode === 'live-draw') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.drawingTitle')}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {hasDrawLine ? t('sidePanel.drawHintCommit') : t('sidePanel.drawHint')}
      </span>
    )
  } else if (mode === 'grid-selected' && selectedGrid) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedGrid.name}
          onCommit={(name) => {
            actions?.onRename?.(selectedGrid.id!, name)
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename')}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedGrid.name}
            {isDirty && (
              <span
                className="ms-1 text-primary"
                aria-label={t('sidePanel.unsavedChanges', { defaultValue: 'Unsaved changes' })}
                title={t('sidePanel.unsavedChanges', { defaultValue: 'Unsaved changes' })}
              >
                •
              </span>
            )}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedGrid.id}
      </span>
    )
  } else if (mode === 'bulk-select') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.bulkSelectedTitle', { count: bulkSelectedCount })}
        {isDirty && (
          <span
            className="ms-1 text-primary"
            aria-label={t('sidePanel.unsavedChanges', { defaultValue: 'Unsaved changes' })}
            title={t('sidePanel.unsavedChanges', { defaultValue: 'Unsaved changes' })}
          >
            •
          </span>
        )}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {t('sidePanel.bulkSelectedSubtitle')}
      </span>
    )
  } else if (
    mode === 'marker-bulk' ||
    mode === 'circle-bulk' ||
    mode === 'polygon-bulk' ||
    mode === 'line-bulk' ||
    mode === 'image-bulk'
  ) {
    const kindCount =
      mode === 'marker-bulk'
        ? selectedMarkerIds?.size ?? 0
        : mode === 'circle-bulk'
          ? selectedCircleIds?.size ?? 0
          : mode === 'polygon-bulk'
            ? selectedPolygonIds?.size ?? 0
            : mode === 'line-bulk'
              ? selectedLineIds?.size ?? 0
              : selectedImageIds?.size ?? 0
    const kindKey =
      mode === 'marker-bulk'
        ? 'sidePanel.bulkSelectedMarkers'
        : mode === 'circle-bulk'
          ? 'sidePanel.bulkSelectedCircles'
          : mode === 'polygon-bulk'
            ? 'sidePanel.bulkSelectedPolygons'
            : mode === 'line-bulk'
              ? 'sidePanel.bulkSelectedLines'
              : 'sidePanel.bulkSelectedImages'
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t(kindKey, { count: kindCount })}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {t('sidePanel.bulkSelectedSubtitle')}
      </span>
    )
  } else if (mode === 'marker-placement') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.markerPlacementTitle')}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {t('sidePanel.markerPlacementSubtitle')}
      </span>
    )
  } else if (mode === 'marker-selected' && selectedMarker) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedMarker.name}
          onCommit={(name) => {
            actions?.onRenameMarker?.(selectedMarker.id!, name)
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename')}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedMarker.name}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedMarker.id}
      </span>
    )
  } else if (mode === 'circle-placement') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.circlePlacementTitle')}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {circleSubMode === 'single'
          ? t('sidePanel.circlePlacementSubtitleSingle')
          : t('sidePanel.circlePlacementSubtitleGrid')}
      </span>
    )
  } else if (mode === 'circle-selected' && selectedCircle) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedCircle.name}
          onCommit={(name) => {
            actions?.onRenameCircle?.(selectedCircle.id!, name)
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename')}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedCircle.name}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    // Friendly role takes precedence over the geometry tag — most
    // users care about "Office" much more than "single circle" once
    // a role is assigned.
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedCircle.id} ·{' '}
        {selectedCircle.role
          ? roleLabel(activeWarehouse, 'circle', selectedCircle.role)
          : selectedCircle.mode === 'single'
            ? t('sidePanel.circleModeSingle')
            : t('sidePanel.circleModeGrid')}
      </span>
    )
  } else if (mode === 'polygon-placement') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.polygonPlacementTitle')}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {polygonDraftVertexCount === 0
          ? t('sidePanel.polygonPlacementSubtitleEmpty')
          : polygonDraftVertexCount < 3
            ? t('sidePanel.polygonPlacementSubtitlePartial', {
              count: polygonDraftVertexCount,
            })
            : t('sidePanel.polygonPlacementSubtitleReady', {
              count: polygonDraftVertexCount,
            })}
      </span>
    )
  } else if (mode === 'polygon-selected' && selectedPolygon) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedPolygon.name}
          onCommit={(name) => {
            actions?.onRenamePolygon?.(selectedPolygon.id!, name)
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename')}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedPolygon.name}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedPolygon.id} ·{' '}
        {selectedPolygon.role
          ? roleLabel(activeWarehouse, 'polygon', selectedPolygon.role)
          : t('sidePanel.polygonVerticesCount', {
              count: selectedPolygon.vertices.length,
            })}
      </span>
    )
  } else if (mode === 'magic-wall') {
    const count = magicWallSelectedPolygonIds?.size ?? 0
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.magicWallTitle')}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {count === 0
          ? t('sidePanel.magicWallSubtitleEmpty')
          : t('sidePanel.magicWallSubtitleCount', { count })}
      </span>
    )
  } else if (mode === 'ai-map') {
    const imgCount = (images ?? []).length
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.aiMapTitle', { defaultValue: 'AI Map' })}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {imgCount === 0
          ? t('sidePanel.aiMapSubtitleEmpty', { defaultValue: 'Draw or upload a floor plan first.' })
          : t('sidePanel.aiMapSubtitleCount', { count: imgCount, defaultValue: `${imgCount} placed floor plan${imgCount === 1 ? '' : 's'}` })}
      </span>
    )
  } else if (mode === 'line-placement') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.linePlacementTitle')}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {lineDraftVertexCount === 0
          ? t('sidePanel.linePlacementSubtitleEmpty')
          : lineDraftVertexCount < 2
            ? t('sidePanel.linePlacementSubtitlePartial', {
              count: lineDraftVertexCount,
            })
            : t('sidePanel.linePlacementSubtitleReady', {
              count: lineDraftVertexCount,
            })}
      </span>
    )
  } else if (mode === 'line-selected' && selectedLine) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={getLineDisplayName(selectedLine, t)}
          onCommit={(name) => {
            actions?.onRenameLine?.(selectedLine.id!, name)
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename')}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {getLineDisplayName(selectedLine, t)}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedLine.id} ·{' '}
        {formatLength(lineLengthMeters(selectedLine.vertices), selectedLine.unit)}
      </span>
    )
  } else if (mode === 'route-placement') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.routePlacementTitle', { defaultValue: 'New route' })}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {routeDraftVertexCount === 0
          ? t('sidePanel.routePlacementSubtitleEmpty', {
              defaultValue: 'Click on the map to add the first waypoint. Esc cancels.',
            })
          : routeDraftVertexCount < 2
            ? t('sidePanel.routePlacementSubtitlePartial', {
                defaultValue: '1 waypoint — click again to add the next.',
              })
            : t('sidePanel.routePlacementSubtitleReady', {
                count: routeDraftVertexCount,
                defaultValue:
                  '{{count}} waypoints — double-click or Enter to commit.',
              })}
      </span>
    )
  } else if (mode === 'route-selected' && selectedRoute) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedRoute.name}
          onCommit={(name) => {
            actions?.onRenameRoute?.(selectedRoute.id!, name)
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename')}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedRoute.name}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedRoute.id} · {selectedRoute.config.type}
      </span>
    )
  } else if (mode === 'image-placement') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.imagePlacementTitle')}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {!imageDraft
          ? t('sidePanel.imagePlacementSubtitleEmpty')
          : imageDraft.realWidthMeters && imageDraft.realHeightMeters
            ? t('sidePanel.imagePlacementSubtitleScaled')
            : t('sidePanel.imagePlacementSubtitleReady')}
      </span>
    )
  } else if (mode === 'image-selected' && selectedImage) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedImage.name}
          onCommit={(name) => {
            actions?.onRenameImage?.(selectedImage.id!, name)
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename')}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedImage.name}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    const size = imageBboxSizeMeters(selectedImage)
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedImage.id} ·{' '}
        {formatLength(size.width, selectedImage.unit, { withSuffix: false })}×
        {formatLength(size.height, selectedImage.unit)}
      </span>
    )
  } else if (mode === 'model-placement') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.modelPlacementTitle', { defaultValue: 'Placing 3D model' })}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {t('sidePanel.modelPlacementSubtitle', {
          defaultValue:
            'Pick an asset from the library, then click the map to drop it.',
        })}
      </span>
    )
  } else if (mode === 'model-selected' && selectedModel) {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {selectedModel.name}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedModel.id}
      </span>
    )
  } else if (mode === 'image-plane-selected' && selectedImagePlane) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedImagePlane.name}
          onCommit={(name) => {
            if (selectedImagePlane.id !== undefined) {
              actions?.onRenameImagePlane?.(selectedImagePlane.id, name)
            }
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename', { defaultValue: 'Rename' })}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedImagePlane.name}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedImagePlane.id} ·{' '}
        {selectedImagePlane.config.width.toFixed(1)} ×{' '}
        {selectedImagePlane.config.height.toFixed(1)} m
      </span>
    )
  } else if (mode === 'stair-selected' && selectedStair) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedStair.name}
          onCommit={(name) => {
            if (selectedStair.id !== undefined) {
              actions?.onRenameStair?.(selectedStair.id, name)
            }
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename', { defaultValue: 'Rename' })}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedStair.name}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    const typeLabel = stairTypeLabel(selectedStair.config.stairType, t)
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedStair.id} · {typeLabel}
      </span>
    )
  } else if (mode === 'door-placement') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.doorPlacementTitle', { defaultValue: 'Placing door' })}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {doorPlacementAnchorCount === 0
          ? t('sidePanel.doorPlacementSubtitle0', {
              defaultValue: 'Click the map to place the first jamb.',
            })
          : t('sidePanel.doorPlacementSubtitle1', {
              defaultValue: 'Click the opposite jamb to set the opening width.',
            })}
      </span>
    )
  } else if (mode === 'door-selected' && selectedDoor) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedDoor.name}
          onCommit={(name) => {
            actions?.onRenameDoor?.(selectedDoor.id, name)
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename', { defaultValue: 'Rename' })}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedDoor.name}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    const kindLabel =
      selectedDoor.config.kind === 'double'
        ? t('sidePanel.doorKindDouble', { defaultValue: 'Double' })
        : selectedDoor.config.kind === 'sliding'
          ? t('sidePanel.doorKindSliding', { defaultValue: 'Sliding' })
          : selectedDoor.config.kind === 'revolving'
            ? t('sidePanel.doorKindRevolving', { defaultValue: 'Revolving' })
            : t('sidePanel.doorKindSingle', { defaultValue: 'Single' })
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedDoor.id} · {kindLabel}
      </span>
    )
  } else if (mode === 'text-placement') {
    headerTitle = (
      <span className="text-sm font-semibold leading-tight truncate">
        {t('sidePanel.textPlacementTitle', { defaultValue: 'Placing text' })}
      </span>
    )
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        {t('sidePanel.textPlacementSubtitle', {
          defaultValue: 'Click the map to drop the label.',
        })}
      </span>
    )
  } else if (mode === 'text-selected' && selectedTextLabel) {
    if (editingName) {
      headerTitle = (
        <GridNameEditor
          initial={selectedTextLabel.name}
          onCommit={(name) => {
            if (selectedTextLabel.id !== undefined) {
              actions?.onRenameTextLabel?.(selectedTextLabel.id, name)
            }
            setEditingName(false)
          }}
          onCancel={() => setEditingName(false)}
          className="flex-1 min-w-0"
        />
      )
    } else {
      headerTitle = (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          className="flex items-center gap-1.5 min-w-0 group w-full"
          aria-label={t('sidePanel.rename')}
        >
          <span className="text-sm font-semibold leading-tight truncate">
            {selectedTextLabel.name}
          </span>
          <Pencil className="flex-shrink-0 w-3 h-3 transition-opacity opacity-0 text-muted-foreground group-hover:opacity-100" />
        </button>
      )
    }
    const previewBody = selectedTextLabel.config.text || ''
    const subtitleBody =
      previewBody.length > 24 ? `${previewBody.slice(0, 24)}…` : previewBody
    headerSubtitle = (
      <span className="text-xs leading-tight text-muted-foreground">
        #{selectedTextLabel.id} ·{' '}
        <span className="italic">{subtitleBody}</span>
      </span>
    )
  }

  return (
    <>
      <div
        onClick={() => onOpenChange(false)}
        className={cn(
          'absolute inset-0 z-30 bg-foreground/30 backdrop-blur-sm transition-opacity duration-300 md:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
        aria-hidden="true"
      />

      <aside
        role="complementary"
        aria-label={t('sidePanel.ariaLabel')}
        // Closed = translated off-screen; inert keeps Tab / find-in-page
        // from focusing into it, which scrolled the overflow-hidden editor
        // sideways and left the panel half off-screen when it reopened.
        inert={!open}
        className={cn(
          'sgv-mesh-overlay',
          'absolute top-0 end-0 z-40 h-full w-[360px] sm:w-[400px] max-w-[calc(100vw-0.5rem)] min-w-0',
          // Solid card background so the map underneath never bleeds
          // through, layered with the sgv-mesh-overlay class above
          // which adds the palette-tinted radial gradients matching
          // the dashboard treatment. Refined shadow stack + inner
          // ring for depth against the map canvas.
          'bg-card border-s border-border/60',
          'shadow-2xl',
          'flex flex-col',
          'transition-transform duration-300 ease-in-out',
          open ? 'translate-x-0' : isRTL ? '-translate-x-full' : 'translate-x-full',
        )}
      >
        {/* Header — matches the dashboard Plan tile treatment: gradient
            wash from primary/10 → transparent, decorative dot pattern
            in the corner, icon chip with ring + primary tint, isDirty
            pulse next to the title. The whole block reads as a
            "hero card" for the selected shape or the workspace. */}
        <div className="relative flex items-start justify-between flex-shrink-0 gap-2 px-4 py-3.5 border-b border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent overflow-hidden">
          {/* Decorative dot pattern in the far corner — pure CSS, uses
              the primary token so it retints with the palette. */}
          <div
            className="pointer-events-none absolute -top-8 -end-8 w-32 h-32 opacity-40 dark:opacity-30"
            style={{
              backgroundImage:
                'radial-gradient(hsl(var(--primary) / 0.35) 1px, transparent 1px)',
              backgroundSize: '14px 14px',
              maskImage: 'radial-gradient(circle at 100% 0%, black 20%, transparent 60%)',
              WebkitMaskImage: 'radial-gradient(circle at 100% 0%, black 20%, transparent 60%)',
            }}
            aria-hidden
          />

          <div className="relative flex items-start flex-1 min-w-0 gap-2.5">
            <div className="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20 shadow-sm">
              {headerIcon}
            </div>
            <div className="min-w-0 flex-1 flex flex-col gap-1 pt-0.5">
              <div className="min-w-0 flex items-center gap-1.5">
                {headerTitle}
                {isDirty && (
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse flex-shrink-0 shadow-[0_0_6px_hsl(var(--primary))]"
                    title={t('sidePanel.dirtyHint', { defaultValue: 'Unsaved changes — auto-saving…' })}
                    aria-label={t('sidePanel.dirtyHint', { defaultValue: 'Unsaved changes — auto-saving…' })}
                  />
                )}
              </div>
              <div className="min-w-0">{headerSubtitle}</div>
            </div>
          </div>
          <div className="relative flex items-center flex-shrink-0 gap-0.5">
            {(mode === 'grid-selected' ||
              mode === 'bulk-select' ||
              mode === 'marker-selected' ||
              mode === 'circle-selected' ||
              mode === 'polygon-selected' ||
              mode === 'line-selected' ||
              mode === 'image-selected' ||
              mode === 'model-selected' ||
              mode === 'image-plane-selected' ||
              mode === 'stair-selected' ||
              mode === 'text-selected' ||
              mode === 'marker-bulk' ||
              mode === 'circle-bulk' ||
              mode === 'polygon-bulk' ||
              mode === 'line-bulk' ||
              mode === 'image-bulk') && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={actions?.onDeselect}
                  title={t('sidePanel.deselect')}
                  aria-label={t('sidePanel.deselect')}
                  className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-background/60"
                >
                  <X className="w-4 h-4" />
                </Button>
              )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
              title={t('sidePanel.close')}
              aria-label={t('sidePanel.close')}
              className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-background/60"
            >
              <PanelLeftClose className={cn('w-4 h-4', isRTL && 'rotate-180')} />
            </Button>
          </div>
        </div>

        <div className="flex-1 px-4 py-4 space-y-5 overflow-y-auto">
          {mode === 'idle' && !shapesLoaded && (
            <div className="space-y-3" aria-busy aria-label={t('sidePanel.loadingShapes', { defaultValue: 'Loading this facility…' })}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="space-y-2 rounded-lg border p-3">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ))}
            </div>
          )}
          {mode === 'idle' && shapesLoaded && facilityEmpty && (
            <IdleEmptyState onStartDraw={onToggleDrawMode} />
          )}

          {mode === 'idle' && (
            <WorkspaceSidebarContext.Provider value={workspaceCtx}>
              {/* Sticky search header — stays pinned at the top of the
                  scrollable area as the user scrolls through long
                  workspace lists. Negative margins compensate for the
                  parent's `px-4 py-4` so the bar reads as a top edge
                  rather than a card sitting inside the body padding. */}
              <div className="sticky top-[-20px] z-10 -mx-4 -mt-4 px-4 pt-4 pb-3 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border">
                <div className="relative">
                  <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    type="search"
                    value={workspaceQuery}
                    onChange={(e) => setWorkspaceQuery(e.target.value)}
                    placeholder={t('sidePanel.searchPlaceholder', {
                      defaultValue: 'Search sections…',
                    })}
                    className="h-8 text-xs ps-7"
                    aria-label={t('sidePanel.searchAriaLabel', {
                      defaultValue: 'Search sidebar sections',
                    })}
                  />
                </div>
              </div>

              {layerOrder && onLayerOrderChange && (
                <LayersSection
                  order={layerOrder}
                  onChange={onLayerOrderChange}
                />
              )}

              <GraphicsSection />


              <SavedGridsContent
                grids={grids}
                selectedGridIds={selectedGridIds}
                actions={actions}
              />
              <SavedMarkersContent
                markers={markers}
                selectedMarkerIds={selectedMarkerIds}
                actions={actions}
              />
              <SavedCirclesContent
                circles={circles}
                selectedCircleIds={selectedCircleIds}
                actions={actions}
                warehouse={activeWarehouse}
              />
              <SavedPolygonsContent
                polygons={polygons}
                selectedPolygonIds={selectedPolygonIds}
                actions={actions}
                warehouse={activeWarehouse}
              />
              <SavedLinesContent
                lines={lines}
                selectedLineIds={selectedLineIds}
                actions={actions}
              />
              <SavedImagesContent
                images={images}
                selectedImageIds={selectedImageIds}
                floorPlanOrder={floorPlanOrder}
                actions={actions}
              />
              <SavedModelsContent
                models={models}
                selectedModelIds={selectedModelIds}
                actions={actions}
              />
              <SavedImagePlanesContent
                imagePlanes={imagePlanes}
                selectedImagePlaneIds={selectedImagePlaneIds}
                actions={actions}
              />
              <SavedStairsContent
                stairs={stairs}
                selectedStairIds={selectedStairIds}
                actions={actions}
              />
              <SavedDoorsContent
                doors={doors}
                selectedDoorIds={selectedDoorIds}
                actions={actions}
              />
              <SavedTextLabelsContent
                textLabels={textLabels}
                selectedTextLabelIds={selectedTextLabelIds}
                actions={actions}
              />
              {zonesVisible && (
                <ZonesContent zones={zones} grids={grids} actions={actions} />
              )}
              <StyleRulesSection />
              <DataSourcesSection zoneId={activeWarehouseId ?? null} />
            </WorkspaceSidebarContext.Provider>
          )}

          {mode === 'grid-selected' && selectedGrid && (
            <SelectedGridContent
              grid={selectedGrid}
              onConfigChange={onConfigChange}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              actions={actions}
              selectedBin={selectedBin}
            />
          )}

          {mode === 'bulk-select' && (
            <BulkSelectedContent
              count={bulkSelectedCount}
              config={config}
              onConfigChange={onConfigChange}
              actions={actions}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
            />
          )}

          {mode === 'live-draw' && (
            <DefaultConfigContent
              config={config}
              update={update}
              drawMode={drawMode}
              hasDrawLine={hasDrawLine}
              onToggleDrawMode={onToggleDrawMode}
              gridTypes={gridTypes}
            />
          )}

          {mode === 'marker-placement' && markerConfig && onMarkerConfigChange && (
            <MarkerPlacementContent
              config={markerConfig}
              unit={activeUnit}
              onConfigChange={onMarkerConfigChange}
              onExit={actions?.onExitMarkerPlacement}
            />
          )}

          {mode === 'marker-selected' && selectedMarker && (
            <MarkerSelectedContent
              marker={selectedMarker}
              onConfigChange={(cfg) => onMarkerConfigChange?.(cfg)}
              onPatch={onMarkerPatch}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              actions={actions}
            />
          )}
          {mode === 'marker-selected' && renderDataLinkPanel('marker', selectedMarker?.id)}

          {mode === 'circle-placement' && circleConfig && onCircleConfigChange && (
            <CirclePlacementContent
              config={circleConfig}
              onConfigChange={onCircleConfigChange}
              unit={activeUnit}
              subMode={circleSubMode}
              onSubModeChange={onCircleSubModeChange}
              cellSize={circleCellSize}
              onCellSizeChange={onCircleCellSizeChange}
              cellRadius={circleCellRadius}
              onCellRadiusChange={onCircleCellRadiusChange}
              onExit={actions?.onExitCirclePlacement}
            />
          )}

          {mode === 'circle-selected' && selectedCircle && onCircleConfigChange && (
            <CircleSelectedContent
              circle={selectedCircle}
              onConfigChange={onCircleConfigChange}
              onPatch={onCirclePatch}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              actions={actions}
              warehouse={activeWarehouse}
            />
          )}
          {mode === 'circle-selected' && renderDataLinkPanel('circle', selectedCircle?.id)}

          {mode === 'polygon-placement' && polygonConfig && onPolygonConfigChange && (
            <PolygonPlacementContent
              config={polygonConfig}
              unit={activeUnit}
              vertexCount={polygonDraftVertexCount}
              onConfigChange={onPolygonConfigChange}
              onExit={actions?.onExitPolygonPlacement}
            />
          )}

          {mode === 'polygon-selected' && selectedPolygon && onPolygonConfigChange && (
            <PolygonSelectedContent
              polygon={selectedPolygon}
              onConfigChange={onPolygonConfigChange}
              onPatch={onPolygonPatch}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              actions={actions}
              warehouse={activeWarehouse}
            />
          )}
          {mode === 'polygon-selected' && renderDataLinkPanel('polygon', selectedPolygon?.id)}

          {mode === 'magic-wall' && lineConfig && onLineConfigChange && (
            <MagicWallContent
              polygons={polygons ?? []}
              selectedIds={magicWallSelectedPolygonIds ?? new Set()}
              lineConfig={lineConfig}
              unit={activeUnit}
              onLineConfigChange={onLineConfigChange}
              busy={magicWallBusy}
              onGenerate={actions?.onGenerateMagicWall}
              onExit={actions?.onExitMagicWall}
            />
          )}

          {mode === 'ai-map' && (
            <AIMapContent
              images={images ?? []}
              targetId={aiMapTargetImageId}
              busy={aiMapBusy}
              onSetTarget={actions?.onSetAIMapTarget}
              onDetect={actions?.onDetectFloorPlan}
              onExit={actions?.onExitAIMap}
            />
          )}

          {mode === 'line-placement' && lineConfig && onLineConfigChange && (
            <LinePlacementContent
              config={lineConfig}
              unit={activeUnit}
              vertexCount={lineDraftVertexCount}
              onConfigChange={onLineConfigChange}
              onExit={actions?.onExitLinePlacement}
            />
          )}

          {mode === 'line-selected' && selectedLine && onLineConfigChange && (
            <LineSelectedContent
              line={selectedLine}
              onConfigChange={onLineConfigChange}
              onPatch={onLinePatch}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              actions={actions}
            />
          )}
          {mode === 'line-selected' && renderDataLinkPanel('line', selectedLine?.id)}

          {mode === 'route-placement' && routeConfig && onRouteConfigChange && (
            <RouteConfigContent
              config={routeConfig}
              vertexCount={routeDraftVertexCount}
              onConfigChange={onRouteConfigChange}
              onExit={actions?.onExitRoutePlacement}
              hint={t('sidePanel.routePlacementHint', {
                defaultValue:
                  'Click to add waypoints. Double-click or Enter commits. Backspace removes the last. Esc cancels.',
              })}
            />
          )}
          {mode === 'route-selected' && selectedRoute && (
            <RouteSelectedContent
              route={selectedRoute}
              onPatch={onRoutePatch}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              actions={actions}
            />
          )}

          {mode === 'marker-bulk' && (
            <BulkMarkerShapeContent
              shapes={(markers ?? []).filter(
                (m) => m.id !== undefined && (selectedMarkerIds?.has(m.id) ?? false),
              )}
              countKey="sidePanel.bulkSelectedMarkers"
              confirmDeleteAllKey="sidePanel.confirmDeleteAllHint"
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDeleteAll={actions?.onBulkDeleteMarkers}
              onFitAll={actions?.onBulkFitMarkers}
              onPatchAll={actions?.onBulkPatchMarkers}
            />
          )}
          {mode === 'circle-bulk' && (
            <BulkFillShapeContent
              shapes={(circles ?? []).filter(
                (c) => c.id !== undefined && (selectedCircleIds?.has(c.id) ?? false),
              )}
              countKey="sidePanel.bulkSelectedCircles"
              confirmDeleteAllKey="sidePanel.confirmDeleteAllHint"
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDeleteAll={actions?.onBulkDeleteCircles}
              onFitAll={actions?.onBulkFitCircles}
              onPatchAll={actions?.onBulkPatchCircles}
            />
          )}
          {mode === 'polygon-bulk' && (
            <BulkFillShapeContent
              shapes={(polygons ?? []).filter(
                (p) => p.id !== undefined && (selectedPolygonIds?.has(p.id) ?? false),
              )}
              countKey="sidePanel.bulkSelectedPolygons"
              confirmDeleteAllKey="sidePanel.confirmDeleteAllHint"
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDeleteAll={actions?.onBulkDeletePolygons}
              onFitAll={actions?.onBulkFitPolygons}
              onPatchAll={actions?.onBulkPatchPolygons}
            />
          )}
          {mode === 'line-bulk' && (
            <BulkLineShapeContent
              shapes={(lines ?? []).filter(
                (ln) => ln.id !== undefined && (selectedLineIds?.has(ln.id) ?? false),
              )}
              countKey="sidePanel.bulkSelectedLines"
              confirmDeleteAllKey="sidePanel.confirmDeleteAllHint"
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDeleteAll={actions?.onBulkDeleteLines}
              onFitAll={actions?.onBulkFitLines}
              onPatchAll={actions?.onBulkPatchLines}
            />
          )}

          {mode === 'image-placement' && imageConfig && onImageConfigChange && (
            <ImagePlacementContent
              config={imageConfig}
              unit={activeUnit}
              draft={imageDraft ?? null}
              zoneId={activeWarehouseId ?? null}
              onConfigChange={onImageConfigChange}
              onPickFile={actions?.onPickImageFile}
              onPickLibrary={actions?.onPickLibraryImage}
              onClearDraft={actions?.onClearImageDraft}
              onExit={actions?.onExitImagePlacement}
            />
          )}

          {mode === 'image-selected' && selectedImage && onImageConfigChange && (
            <ImageSelectedContent
              key={selectedImage.id}
              image={selectedImage}
              onConfigChange={onImageConfigChange}
              onPatch={onImagePatch}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              actions={actions}
            />
          )}
          {mode === 'image-selected' && renderDataLinkPanel('image', selectedImage?.id)}

          {mode === 'image-bulk' && (
            <BulkImageShapeContent
              shapes={(images ?? []).filter(
                (img) => img.id !== undefined && (selectedImageIds?.has(img.id) ?? false),
              )}
              countKey="sidePanel.bulkSelectedImages"
              confirmDeleteAllKey="sidePanel.confirmDeleteAllHint"
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDeleteAll={actions?.onBulkDeleteImages}
              onFitAll={actions?.onBulkFitImages}
              onPatchAll={actions?.onBulkPatchImages}
            />
          )}

          {mode === 'stair-bulk' && (
            <BulkStairShapeContent
              shapes={(stairs ?? []).filter(
                (s) => s.id !== undefined && (selectedStairIds?.has(s.id) ?? false),
              )}
              countKey="sidePanel.bulkSelectedStairs"
              confirmDeleteAllKey="sidePanel.confirmDeleteAllHint"
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDeleteAll={actions?.onBulkDeleteStairs}
              onFitAll={actions?.onBulkFitStairs}
              onPatchAll={actions?.onBulkPatchStairs}
            />
          )}
          {mode === 'door-bulk' && (
            <BulkDoorShapeContent
              shapes={(doors ?? []).filter(
                (d) => d.id !== undefined && (selectedDoorIds?.has(d.id) ?? false),
              )}
              countKey="sidePanel.bulkSelectedDoors"
              confirmDeleteAllKey="sidePanel.confirmDeleteAllHint"
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDeleteAll={actions?.onBulkDeleteDoors}
              onFitAll={actions?.onBulkFitDoors}
              onPatchAll={actions?.onBulkPatchDoors}
            />
          )}
          {mode === 'model-bulk' && (
            <BulkModelShapeContent
              shapes={(models ?? []).filter(
                (m) => m.id !== undefined && (selectedModelIds?.has(m.id) ?? false),
              )}
              countKey="sidePanel.bulkSelectedModels"
              confirmDeleteAllKey="sidePanel.confirmDeleteAllHint"
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDeleteAll={actions?.onBulkDeleteModels}
              onFitAll={actions?.onBulkFitModels}
              onPatchAll={actions?.onBulkPatchModels}
            />
          )}
          {mode === 'text-bulk' && (
            <BulkTextLabelContent
              shapes={(textLabels ?? []).filter(
                (l) => l.id !== undefined && (selectedTextLabelIds?.has(l.id) ?? false),
              )}
              countKey="sidePanel.bulkSelectedTextLabels"
              confirmDeleteAllKey="sidePanel.confirmDeleteAllHint"
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDeleteAll={actions?.onBulkDeleteTextLabels}
              onFitAll={actions?.onBulkFitTextLabels}
              onPatchAll={actions?.onBulkPatchTextLabels}
            />
          )}

          {mode === 'cross-kind-bulk' && (
            <BulkCrossKindContent
              counts={{
                grid: selectedGridIds?.size ?? 0,
                marker: selectedMarkerIds?.size ?? 0,
                circle: selectedCircleIds?.size ?? 0,
                polygon: selectedPolygonIds?.size ?? 0,
                line: selectedLineIds?.size ?? 0,
                route: selectedRouteIds?.size ?? 0,
                stair: selectedStairIds?.size ?? 0,
                door: selectedDoorIds?.size ?? 0,
                image: selectedImageIds?.size ?? 0,
                model: selectedModelIds?.size ?? 0,
                'image-plane': selectedImagePlaneIds?.size ?? 0,
                'text-label': selectedTextLabelIds?.size ?? 0,
              }}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDelete={actions?.onCrossKindDelete}
              onHide={() => actions?.onCrossKindSetVisibility?.(false)}
              onShow={() => actions?.onCrossKindSetVisibility?.(true)}
              onChangeFloor={actions?.onCrossKindChangeFloor}
              onClear={actions?.onCrossKindClear}
            />
          )}

          {mode === 'model-selected' && selectedModel && onModelPatch && (
            <ModelSelectedContent
              key={selectedModel.id}
              model={selectedModel}
              onPatch={onModelPatch}
              onSwapAsset={onModelSwapAsset}
              onDelete={() =>
                selectedModel.id !== undefined &&
                actions?.onDeleteModelById?.(selectedModel.id)
              }
              onDuplicate={
                selectedModel.id !== undefined && actions?.onDuplicateModel
                  ? () => actions.onDuplicateModel!(selectedModel.id!)
                  : undefined
              }
              onMoveMode={actions?.onStartMoveModel}
              moveActive={actions?.modelTransformActive ?? false}
              onCancelMove={actions?.onCancelModelTransform}
              onEditLinkedData={
                selectedModel.id !== undefined
                  ? () =>
                    actions?.onEditShapeData?.({
                      kind: 'model',
                      shapeId: selectedModel.id!,
                      shapeName: selectedModel.name,
                    })
                  : undefined
              }
            />
          )}
          {mode === 'model-selected' && renderDataLinkPanel('model', selectedModel?.id)}

          {mode === 'image-plane-selected' && selectedImagePlane && onImagePlanePatch && (
            <ImagePlaneSelectedContent
              key={selectedImagePlane.id}
              plane={selectedImagePlane}
              onPatch={onImagePlanePatch}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDelete={() =>
                selectedImagePlane.id !== undefined &&
                actions?.onDeleteImagePlaneById?.(selectedImagePlane.id)
              }
              onFit={
                selectedImagePlane.id !== undefined && actions?.onFitToImagePlaneById
                  ? () => actions.onFitToImagePlaneById!(selectedImagePlane.id!)
                  : undefined
              }
              onDuplicate={
                selectedImagePlane.id !== undefined && actions?.onDuplicateImagePlane
                  ? () => actions.onDuplicateImagePlane!(selectedImagePlane.id!)
                  : undefined
              }
              onMoveMode={actions?.onStartMoveImagePlane}
              moveActive={actions?.imagePlaneTransformActive ?? false}
              onCancelMove={actions?.onCancelImagePlaneTransform}
            />
          )}
          {/* Image-plane kind targets `image` in DataLinkConfig (both
              use the same BindingKind slot in the schema). The manager
              treats them as one target. */}
          {mode === 'image-plane-selected' && renderDataLinkPanel('image', selectedImagePlane?.id)}

          {mode === 'image-plane-placement' && (
            <div className="px-3 py-4">
              <p className="text-xs text-muted-foreground">
                {t('imagePlane.placementHint', {
                  defaultValue:
                    'Pick an image, then click on the map to place it as a textured plane.',
                })}
              </p>
            </div>
          )}

          {mode === 'text-placement' && textLabelConfig && onTextLabelConfigChange && (
            <TextLabelPlacementContent
              config={textLabelConfig}
              unit={activeUnit}
              onConfigChange={onTextLabelConfigChange}
              onExit={actions?.onExitTextLabelPlacement}
            />
          )}

          {mode === 'text-selected' && selectedTextLabel && onTextLabelConfigChange && (
            <TextLabelSelectedContent
              key={selectedTextLabel.id}
              label={selectedTextLabel}
              onConfigChange={onTextLabelConfigChange}
              onPatch={onTextLabelPatch}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              actions={actions}
            />
          )}
          {mode === 'text-selected' && renderDataLinkPanel('text-label', selectedTextLabel?.id)}

          {mode === 'stair-placement' && stairConfig && onStairConfigChange && (
            <StairPlacementContent
              config={stairConfig}
              onConfigChange={onStairConfigChange}
              anchorCount={stairPlacementAnchorCount}
              onExit={actions?.onExitStairPlacement}
              floors={liftFloors}
            />
          )}

          {mode === 'stair-selected' && selectedStair && onStairPatch && onStairConfigChange && (
            <StairSelectedContent
              key={selectedStair.id}
              stair={selectedStair}
              floors={liftFloors}
              onVerticesChange={(vertices, config) => onStairPatch({ vertices, config })}
              onConfigChange={(config) =>
                onStairPatch({ config })
              }
              onRotationChange={(rotation) =>
                onStairPatch({ rotation })
              }
              onStartRotate={
                selectedStair.id !== undefined
                  ? () => actions?.onStartRotateStair?.(selectedStair.id!)
                  : undefined
              }
              onStartMove={
                selectedStair.id !== undefined
                  ? () => actions?.onStartMoveStair?.(selectedStair.id!)
                  : undefined
              }
              isRotating={actions?.stairTransformKind === 'rotate'}
              isMoving={actions?.stairTransformKind === 'move'}
              defaultConfig={stairConfig}
              onDefaultChange={onStairConfigChange}
              onDelete={() =>
                selectedStair.id !== undefined &&
                actions?.onDeleteStairById?.(selectedStair.id)
              }
              onDuplicate={() =>
                selectedStair.id !== undefined &&
                actions?.onDuplicateStair?.(selectedStair.id)
              }
            />
          )}
          {mode === 'stair-selected' && renderDataLinkPanel('stair', selectedStair?.id)}

          {mode === 'door-placement' && doorConfig && onDoorConfigChange && (
            <DoorPlacementContent
              config={doorConfig}
              onConfigChange={onDoorConfigChange}
              anchorCount={doorPlacementAnchorCount}
              onExit={actions?.onExitDoorPlacement}
              widthMeters={doorPendingWidthMeters}
              onWidthMetersChange={onDoorPendingWidthMetersChange}
            />
          )}

          {mode === 'door-selected' && selectedDoor && onDoorPatch && onDoorConfigChange && (
            <DoorSelectedContent
              key={selectedDoor.id}
              door={selectedDoor}
              onConfigChange={(config) => onDoorPatch({ config })}
              onVerticesChange={(vertices) => onDoorPatch({ vertices })}
              onDuplicate={() => actions?.onDuplicateDoor?.(selectedDoor.id)}
              onFit={() => actions?.onFitToDoorById?.(selectedDoor.id)}
              defaultConfig={doorConfig}
              onDefaultChange={onDoorConfigChange}
              onDelete={() => actions?.onDeleteDoorById?.(selectedDoor.id)}
              actions={actions}
            />
          )}
          {mode === 'door-selected' && renderDataLinkPanel('door', selectedDoor?.id)}
        </div>

        {/*
         * Footer — the Save + Reset button pair was removed. Every
         * sidebar edit now auto-commits: single-shape edits go through
         * `patchSpatialEntity` (optimistic + 400 ms batched flush), and
         * grid/model/stair bulk drafts are auto-committed 700 ms after
         * the last change OR on component unmount, whichever fires
         * first. The unit picker stays because the active display unit
         * has no persist target — flipping it doesn't create a draft.
         */}
        {/* Footer — glass strip matching the header. Same border color
            + light gradient wash for visual balance with the top hero
            block. Only owns the unit picker so it stays visually light. */}
        <div className="flex items-center justify-between flex-shrink-0 gap-2 px-4 py-2.5 border-t border-border/60 bg-gradient-to-tr from-primary/[0.03] via-transparent to-transparent backdrop-blur-sm">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t('sidePanel.footerUnit', { defaultValue: 'Units' })}
          </span>
          <UnitPicker
            value={activeUnit}
            onChange={(unit) => {
              // A selected marker / circle / area / line / image / model
              // carries its own unit — that's what this picker shows, so
              // that's what it changes (it used to set the draw default
              // and look like it did nothing).
              const own: Array<[string, { id?: number } | null | undefined, EntityKind]> = [
                ['marker-selected', selectedMarker, 'markers'],
                ['circle-selected', selectedCircle, 'circles'],
                ['polygon-selected', selectedPolygon, 'polygons'],
                ['line-selected', selectedLine, 'lines'],
                ['image-selected', selectedImage, 'images'],
                ['model-selected', selectedModel, 'models'],
              ]
              const hit = own.find(([m, shape]) => m === mode && shape?.id !== undefined)
              if (hit) {
                void saveSpatialEntity(hit[2], hit[1]!.id!, { unit } as never)
                return
              }
              onConfigChange({ ...activeConfig, unit })
              if (mode === 'idle' || mode === 'live-draw') {
                onPersistDefaultUnit?.(unit)
              }
            }}
          />
        </div>
      </aside>

      {!open && (
        <Button
          variant="default"
          size="icon"
          onClick={() => onOpenChange(true)}
          className="absolute z-30 shadow-lg top-4 end-4 h-9 w-9 hover:shadow-xl transition-shadow"
          title={t('sidePanel.open')}
          aria-label={t('sidePanel.open')}
        >
          <PanelLeftOpen className={cn('w-4 h-4', isRTL && 'rotate-180')} />
        </Button>
      )}
    </>
  )
}

// ---- Saved Grids + Zones (always visible) -------------------------------

/** Per-cell size shown in the saved-grids list, in the grid's own unit. */
function cellCountLabel(grid: Grid): string {
  const c = grid.config
  const unit = c.unit ?? 'm'
  const x = formatLength(c.xSize, unit, { withSuffix: false })
  const y = formatLength(c.ySize, unit, { withSuffix: false })
  return `${x}×${y} ${UNIT_SUFFIX[unit]}`
}

/**
 * Switches wired to the global graphics-settings store. Shadows + AO
 * default to OFF (performance-first): enabling shadows re-instates the
 * directional light's `cast-shadows` at the scene level so every
 * fill-extrusion + model layer casts a real shadow; enabling ambient
 * occlusion turns the screen-space AO pass back on for extrusions. Each
 * is a measurable GPU cost — the copy under each switch says so, so
 * users understand the trade before flipping it.
 *
 * Marker occlusion is the odd one out: it defaults to ON and costs
 * nothing on the GPU. It's here because it's the other knob that changes
 * how the 3D scene reads.
 */
function GraphicsSection() {
  const { t } = useTranslation()
  const shadows = useGraphicsSettings((s) => s.shadows)
  const ambientOcclusion = useGraphicsSettings((s) => s.ambientOcclusion)
  const markerOcclusion = useGraphicsSettings((s) => s.markerOcclusion)
  const setShadows = useGraphicsSettings((s) => s.setShadows)
  const setAmbientOcclusion = useGraphicsSettings((s) => s.setAmbientOcclusion)
  const setMarkerOcclusion = useGraphicsSettings((s) => s.setMarkerOcclusion)
  const liftIcons = useGraphicsSettings((s) => s.liftIcons)
  const setLiftIcons = useGraphicsSettings((s) => s.setLiftIcons)
  const floorBase = useGraphicsSettings((s) => s.floorBase)
  const setFloorBase = useGraphicsSettings((s) => s.setFloorBase)
  return (
    <Section
      title={t('sidePanel.graphicsTitle', { defaultValue: 'Graphics quality' })}
      icon={Sparkles}
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium">
              {t('sidePanel.graphicsShadows', { defaultValue: '3D shadows' })}
            </div>
            <div className="text-[10px] text-muted-foreground leading-tight">
              {t('sidePanel.graphicsShadowsHint', {
                defaultValue: 'Realistic wall & rack shadows. Higher GPU cost.',
              })}
            </div>
          </div>
          <Switch
            checked={shadows}
            onCheckedChange={setShadows}
            aria-label={t('sidePanel.graphicsShadows', { defaultValue: '3D shadows' })}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium">
              {t('sidePanel.graphicsAO', { defaultValue: 'Ambient occlusion' })}
            </div>
            <div className="text-[10px] text-muted-foreground leading-tight">
              {t('sidePanel.graphicsAOHint', {
                defaultValue: 'Soft shading in corners. Screen-space GPU pass.',
              })}
            </div>
          </div>
          <Switch
            checked={ambientOcclusion}
            onCheckedChange={setAmbientOcclusion}
            aria-label={t('sidePanel.graphicsAO', { defaultValue: 'Ambient occlusion' })}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium">
              {t('sidePanel.graphicsMarkerOcclusion', {
                defaultValue: 'Hide markers under floors',
              })}
            </div>
            <div className="text-[10px] text-muted-foreground leading-tight">
              {t('sidePanel.graphicsMarkerOcclusionHint', {
                defaultValue:
                  'Markers behind a floor plan are hidden, like real 3D geometry.',
              })}
            </div>
          </div>
          <Switch
            checked={markerOcclusion}
            onCheckedChange={setMarkerOcclusion}
            aria-label={t('sidePanel.graphicsMarkerOcclusion', {
              defaultValue: 'Hide markers under floors',
            })}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium">
              {t('sidePanel.graphicsLiftIcons', { defaultValue: 'Lift icons' })}
            </div>
            <div className="text-[10px] text-muted-foreground leading-tight">
              {t('sidePanel.graphicsLiftIconsHint', {
                defaultValue: 'Escalator and elevator icons and labels on the map.',
              })}
            </div>
          </div>
          <Switch
            checked={liftIcons}
            onCheckedChange={setLiftIcons}
            aria-label={t('sidePanel.graphicsLiftIcons', { defaultValue: 'Lift icons' })}
          />
        </div>
        <div className="space-y-1.5">
          <div>
            <div className="text-xs font-medium">
              {t('sidePanel.graphicsFloorBase', { defaultValue: 'Building base' })}
            </div>
            <div className="text-[10px] text-muted-foreground leading-tight">
              {t('sidePanel.graphicsFloorBaseHint', {
                defaultValue: 'Fills the space under an upper floor shown on its own.',
              })}
            </div>
          </div>
          <Choice
            value={floorBase}
            options={[
              ['solid', t('sidePanel.graphicsFloorBaseSolid', { defaultValue: 'Solid' })],
              ['ghost', t('sidePanel.graphicsFloorBaseGhost', { defaultValue: 'Ghost' })],
              ['off', t('sidePanel.graphicsFloorBaseOff', { defaultValue: 'Off' })],
            ]}
            onChange={setFloorBase}
          />
        </div>
      </div>
    </Section>
  )
}

/**
 * Drag-to-reorder list of overlay types. Displayed top→bottom in the
 * canvas-stacking convention (top = front-most), while the parent stores
 * `order` bottom→top. Markers render via HTML DOM markers (above the
 * canvas), so they sit at the top of the list as a locked, non-draggable
 * row — not part of the reorderable array.
 */
function LayersSection({
  order,
  onChange,
}: {
  order: LayerKind[]
  onChange: (next: LayerKind[]) => void
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const displayOrder = [...order].reverse()

  const ICON: Record<LayerKind, React.ComponentType<{ className?: string }>> = {
    image: ImageIcon,
    grid: Grid3X3,
    circle: Circle,
    polygon: Pentagon,
    line: Spline,
    route: Route,
    stair: Footprints,
    model: Box,
    imagePlane: Frame,
  }

  // Filter draggable layer rows by translated label so the workspace
  // search matches what the user sees ("Grid", "Marker", etc.). The
  // locked marker row participates in the same filter so it doesn't
  // sit alone above an empty list.
  const markerLabel = t('sidePanel.layer_marker')
  const markerMatches = matchesWorkspaceQuery(markerLabel, query)
  const filteredDisplayOrder = displayOrder.filter((kind) =>
    matchesWorkspaceQuery(t(`sidePanel.layer_${kind}`), query),
  )
  // If neither the locked marker nor any draggable kind matches, drop
  // the whole section — Section's own header isn't worth surfacing
  // when there's no body.
  if (!markerMatches && filteredDisplayOrder.length === 0) return null

  const handleDrop = (toDisplayIdx: number) => {
    if (dragIdx === null || dragIdx === toDisplayIdx) return
    const next = [...displayOrder]
    const [moved] = next.splice(dragIdx, 1)
    next.splice(toDisplayIdx, 0, moved)
    onChange([...next].reverse())
  }

  return (
    <Section title={t('sidePanel.layersTitle')} icon={LayersIcon}>
      <ul className="space-y-1">
        {markerMatches && (
          <li className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground">
            <Lock className="w-3.5 h-3.5 opacity-60" />
            <MapPin className="w-4 h-4" />
            <span className="flex-1">{markerLabel}</span>
            <span className="text-[10px] uppercase tracking-wider">
              {t('sidePanel.layersLockedTop')}
            </span>
          </li>
        )}
        {filteredDisplayOrder.map((kind) => {
          const idx = displayOrder.indexOf(kind)
          const Icon = ICON[kind]
          const isDragging = dragIdx === idx
          const isOver =
            overIdx === idx && dragIdx !== null && dragIdx !== idx
          return (
            <li
              key={kind}
              draggable
              onDragStart={(e) => {
                setDragIdx(idx)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', kind)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (overIdx !== idx) setOverIdx(idx)
              }}
              onDragLeave={() => {
                if (overIdx === idx) setOverIdx(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                handleDrop(idx)
                setDragIdx(null)
                setOverIdx(null)
              }}
              onDragEnd={() => {
                setDragIdx(null)
                setOverIdx(null)
              }}
              className={cn(
                'flex items-center gap-2 rounded-md border bg-background/60 px-2.5 py-2 text-sm cursor-grab select-none transition-colors',
                isDragging && 'opacity-40',
                isOver && 'border-primary bg-primary/10'
              )}
            >
              <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
              <Icon className="w-4 h-4" />
              <span className="flex-1">{t(`sidePanel.layer_${kind}`)}</span>
            </li>
          )
        })}
      </ul>
      <p className="text-[10px] text-muted-foreground px-1 mt-2">
        {t('sidePanel.layersHint')}
      </p>
    </Section>
  )
}

/**
 * Name + subtitle column for a saved-items row, with inline rename.
 * Renders the name as a button (clicking selects the item / fits to it
 * per the parent's `onSelect`). Hovering the row reveals a pencil icon
 * — clicking it (or double-clicking the name) swaps in an input so the
 * user can rename without first navigating into the selected-item
 * panel.
 *
 * The parent `<li>` is expected to have the Tailwind `group` class so
 * the pencil icon can fade in on row hover.
 */
/**
 * Eye-icon button used by every per-shape row to flip the row's
 * `visible` flag. Shared so the saved-polygons / -circles / -lines /
 * -stairs / -markers / -models / -text-labels lists all render the
 * exact same affordance. The host passes a tiny callback that swaps
 * the row's `visible` boolean — the overlay layer filters by it on
 * the next render, which lets the user dim out upper-floor shapes to
 * interact with what's underneath (the use case that prompted this
 * control).
 */
function EyeToggleButton({
  visible,
  onToggle,
}: {
  /** Current visibility. Treat `undefined` as `true` so legacy rows
   *  saved before the `visible` field existed still read as visible. */
  visible: boolean | undefined
  onToggle: (next: boolean) => void
}) {
  const { t } = useTranslation()
  const isHidden = visible === false
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('h-6 w-6', isHidden && 'opacity-50')}
      onClick={() => onToggle(isHidden)}
      title={
        isHidden
          ? t('sidePanel.showLayer', { defaultValue: 'Show' })
          : t('sidePanel.hideLayer', { defaultValue: 'Hide' })
      }
      aria-label={
        isHidden
          ? t('sidePanel.showLayer', { defaultValue: 'Show' })
          : t('sidePanel.hideLayer', { defaultValue: 'Hide' })
      }
    >
      {isHidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
    </Button>
  )
}

function InlineNameCell({
  name,
  subtitle,
  onSelect,
  onCommit,
  titleAttr,
}: {
  name: string
  subtitle: React.ReactNode
  onSelect: (e: React.MouseEvent) => void
  onCommit: (next: string) => void
  /** Full tooltip shown on hover of the name button. */
  titleAttr?: string
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <div className="flex-1 min-w-0">
        <GridNameEditor
          initial={name}
          onCommit={(next) => {
            onCommit(next)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
    </div>
  )
}

  return (
    <div className="flex items-center flex-1 min-w-0 gap-1">
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => setEditing(true)}
        className="flex-1 min-w-0 text-start"
        title={titleAttr ?? name}
        aria-label={titleAttr ?? name}
      >
        <div className="text-xs font-medium truncate">{name}</div>
        <div className="text-[10px] text-muted-foreground">{subtitle}</div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setEditing(true)
        }}
        className="flex-shrink-0 p-1 transition-opacity rounded opacity-0 group-hover:opacity-70 hover:opacity-100 hover:bg-accent"
        title={t('sidePanel.renameItem')}
        aria-label={t('sidePanel.renameItem')}
      >
        <Pencil className="w-3 h-3 text-muted-foreground" />
      </button>
    </div>
  )
}

// ---- Linked data block ----------------------------------------------------
// Shows bin attribute values inline using the same rich UI as BinPopupContent.
// Used in every shape's SelectedContent section so the side panel mirrors the
// map tooltip's display.

function LinkedDataBlock({
  kind,
  shapeId,
}: {
  kind: 'polygon' | 'circle' | 'line' | 'marker' | 'image' | 'model'
  shapeId: number | undefined
}) {
  const { t } = useTranslation()
  const { data: bins = [] } = useSpatialBins()
  if (shapeId === undefined) return null
  const bin = bins.find(
    (b) => b.targetKind === kind && b.shapeId === shapeId,
  )
  if (!bin) return null
  if (!hasAnyContent(bin)) return null
  return (
    <Section title={t('sidePanel.linkedData', { defaultValue: 'Linked data' })} icon={Boxes}>
      <div className="overflow-hidden rounded-lg border border-border/60 bg-card/50 backdrop-blur-sm shadow-sm">
        <BinPopupContent bin={bin} compact withReferences={false} />
      </div>
    </Section>
  )
}

/**
 * List of every saved grid with a "fit" button (zoom-to-grid), a "select"
 * button (sets the grid as the current selection — supports additive
 * multi-select via Shift+click), a zone picker, and a delete button.
 */
function SavedGridsContent({
  grids,
  selectedGridIds,
  actions,
}: {
  grids?: ReadonlyArray<Grid>
  selectedGridIds?: ReadonlySet<number>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (grids ?? []).filter((g) => matchesWorkspaceQuery(g.name, query))
  // Hide the whole section when the active query matches no items —
  // mirrors the original "empty list → return null" behaviour but
  // applies to the post-filter list so a non-empty source can still
  // collapse to nothing during search.
  if (list.length === 0) {
    return null
  }
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectGrid?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section title={t('sidePanel.savedGridsTitle')} icon={Grid3X3}>
      <VirtualList
        items={list}
        keyFor={(g) => g.id!}
        renderItem={(g) => {
          const id = g.id!
          const isSelected = selectedGridIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30'
              )}
            >
              <span
                className="flex-shrink-0 w-3 h-3 border rounded"
                style={{ backgroundColor: g.config.color }}
                aria-hidden="true"
              />
              <InlineNameCell
                name={g.name}
                subtitle={<>#{id} · {cellCountLabel(g)}</>}
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRename?.(id, next)}
                titleAttr={`#${id} ${g.name}`}
              />
              <EyeToggleButton
                visible={g.visible}
                onToggle={(next) => actions?.onToggleGridVisible?.(id, next)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToGridById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm && 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteGridById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(() => setConfirmDeleteId((v) => (v === id ? null : v)), 3000)
                  }
                }}
                title={showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
                aria-label={showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

// ---- Saved markers list --------------------------------------------------

function SavedMarkersContent({
  markers,
  selectedMarkerIds,
  actions,
}: {
  markers?: ReadonlyArray<MarkerShape>
  selectedMarkerIds?: ReadonlySet<number>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (markers ?? []).filter((m) => matchesWorkspaceQuery(m.name, query))
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectMarker?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section title={t('sidePanel.savedMarkersTitle')} icon={MapPin}>
      <VirtualList
        items={list}
        keyFor={(m) => m.id!}
        renderItem={(m) => {
          const id = m.id!
          const isSelected = selectedMarkerIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30'
              )}
            >
              <MarkerIconGlyph
                icon={m.config.icon}
                className="w-3.5 h-3.5 flex-shrink-0"
                style={{ color: m.config.iconColor }}
                aria-hidden="true"
              />
              <InlineNameCell
                name={m.name}
                subtitle={
                  <span className="font-mono">
                    {m.position[1].toFixed(4)}, {m.position[0].toFixed(4)}
                  </span>
                }
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenameMarker?.(id, next)}
                titleAttr={`#${id} ${m.name}`}
              />
              <EyeToggleButton
                visible={m.visible}
                onToggle={(next) => actions?.onToggleMarkerVisible?.(id, next)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToMarkerById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteMarkerById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () =>
                        setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000
                    )
                  }
                }}
                title={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

// ---- Shared marker properties form ---------------------------------------

function MarkerPropertiesForm({
  config,
  unit,
  onChange,
}: {
  config: MarkerShapeConfig
  /** Display unit for elevation / height fields. */
  unit: LengthUnit
  onChange: (next: MarkerShapeConfig) => void
}) {
  const { t } = useTranslation()
  const update = <K extends keyof MarkerShapeConfig>(
    key: K,
    value: MarkerShapeConfig[K]
  ) => onChange({ ...config, [key]: value })
  const positions: MarkerLabelPosition[] = ['top', 'right', 'bottom', 'left']

  return (
    <>
      <Section title={t('sidePanel.markerIcon')} icon={MapPin}>
        <div className="p-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <MarkerIconPicker
            value={config.icon}
            onChange={(id) => update('icon', id)}
          />
        </div>
      </Section>

      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.markerColor')}
            value={config.iconColor}
            onChange={(v) => update('iconColor', v)}
          />
          <SliderRow
            label={t('sidePanel.markerSize')}
            value={config.iconSize}
            onChange={(v) => update('iconSize', v)}
            min={12}
            max={64}
            limitMax={LIMIT_MARKER_SIZE_PX}
            step={0.1}
            suffix="px"
          />
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={10}
            max={100}
            step={0.1}
            suffix="%"
          />
        </div>
      </Section>

      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.elevation')}</span>
              <span className="font-mono text-muted-foreground">
                {config.elevation === 0
                  ? t('sidePanel.flat')
                  : formatLength(config.elevation, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.elevation}
              unit={unit}
              min={0}
              max={LIMIT_ELEVATION_M}
              onChange={(meters) => update('elevation', Math.max(0, meters))}
              ariaLabel={t('sidePanel.elevation')}
            />
            <StretchSlider
              value={config.elevation}
              onValueChange={(v) => update('elevation', v)}
              min={0}
              max={500}
              limitMax={LIMIT_ELEVATION_M}
              step={0.1}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.markerPoleHeight')}</span>
              <span className="font-mono text-muted-foreground">
                {config.height === 0
                  ? t('sidePanel.markerPoleOff')
                  : formatLength(config.height, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.height}
              unit={unit}
              min={0}
              onChange={(meters) => update('height', Math.max(0, meters))}
              ariaLabel={t('sidePanel.markerPoleHeight')}
            />
            <p className="text-[10px] text-muted-foreground">
              {t('sidePanel.markerPoleHint')}
            </p>
          </div>
        </div>
      </Section>

      <Section title={t('sidePanel.sectionLabels')} icon={Type}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('sidePanel.markerLabel')}</Label>
            <TextField
              value={config.label}
              onCommit={(text) => {
                onChange({
                  ...config,
                  label: text,
                  // Auto-enable showLabels the first time the user types
                  // a non-empty label; auto-disable when they clear it.
                  showLabels: text.trim() !== '',
                })
              }}
              placeholder={t('sidePanel.markerLabelPlaceholder')}
              className="h-8 text-sm"
            />
          </div>
          {config.label.trim() !== '' && (
            <>
              <ColorRow
                label={t('sidePanel.labelColor')}
                value={config.labelColor}
                onChange={(v) => update('labelColor', v)}
              />
              <SliderRow
                label={t('sidePanel.labelSize')}
                value={config.labelSize}
                onChange={(v) => update('labelSize', v)}
                min={8}
                max={32}
                limitMax={LIMIT_SYMBOL_SIZE_PX}
                step={0.1}
                suffix="px"
              />
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('sidePanel.markerLabelPosition')}
                </Label>
                <div className="grid grid-cols-4 gap-1.5">
                  {positions.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => update('labelPosition', p)}
                      className={cn(
                        'py-1.5 rounded-md border text-xs capitalize transition-colors',
                        config.labelPosition === p
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-accent'
                      )}
                    >
                      {t(`sidePanel.markerLabelPos_${p}`)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </Section>

      <TooltipTriggerSection
        value={config.tooltipTrigger}
        onChange={(v) => update('tooltipTrigger', v)}
      />
    </>
  )
}

// ---- Marker placement (toolbar tool active, no marker selected) ---------

function MarkerPlacementContent({
  config,
  unit,
  onConfigChange,
  onExit,
}: {
  config: MarkerShapeConfig
  unit: LengthUnit
  onConfigChange: (next: MarkerShapeConfig) => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={Crosshair}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <p className="text-[11px] text-muted-foreground">
            {t('sidePanel.markerPlacementHint')}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onExit}
          >
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.markerPlacementExit')}
          </Button>
        </div>
      </Section>
      <MarkerPropertiesForm
        config={config}
        unit={unit}
        onChange={onConfigChange}
      />
    </>
  )
}

// ---- Marker selected -----------------------------------------------------

function MarkerSelectedContent({
  marker,
  onConfigChange,
  onPatch,
  confirmDelete,
  setConfirmDelete,
  actions,
}: {
  marker: MarkerShape
  onConfigChange: (next: MarkerShapeConfig) => void
  onPatch?: (patch: Partial<MarkerShape>) => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const isMoving =
    actions?.markerTransformActive && actions?.markerTransformKind === 'move'
  return (
    <>
      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant={isMoving ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isMoving) actions?.onCancelMarkerTransform?.()
                else actions?.onStartMoveMarker?.(marker.id!)
              }}
              title={t('sidePanel.move')}
            >
              <Move className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.move')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onFitToMarkerById?.(marker.id!)}
              title={t('sidePanel.fit')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
          </div>
          {isMoving && (
            <p className="text-[11px] text-muted-foreground px-1">
              {t('sidePanel.moveHint')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions?.onDuplicateMarker?.(marker.id!)}
              title={t('sidePanel.duplicate')}
            >
              <Copy className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.duplicate')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  actions?.onDeleteMarkerById?.(marker.id!)
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
              title={t('sidePanel.delete')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t('sidePanel.confirmDeleteHint')}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() =>
              actions?.onEditShapeData?.({
                kind: 'marker',
                shapeId: marker.id!,
                shapeName: marker.name,
              })
            }
            title={t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          >
            <Boxes className="w-3.5 h-3.5 me-1.5" />
            {t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          </Button>
        </div>
      </Section>

      <LinkedDataBlock kind="marker" shapeId={marker.id} />

      <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <SliderRow
            label={
              <span className="flex items-center gap-1.5">
                <RotateCw className="w-3 h-3" />
                {t('sidePanel.markerBearing')}
              </span>
            }
            labelExtra={
              <button
                type="button"
                onClick={() => onPatch?.({ bearing: 0 })}
                className="font-mono transition-colors text-muted-foreground hover:text-foreground"
                title={t('sidePanel.rotationReset')}
              >
                {marker.bearing.toFixed(1).replace(/\.0$/, '')}°
              </button>
            }
            value={marker.bearing}
            onChange={(v) => onPatch?.({ bearing: v })}
            min={-180}
            max={180}
            step={0.5}
            suffix="°"
          />
        </div>
      </Section>

      <MarkerPropertiesForm
        config={marker.config}
        unit={marker.unit}
        onChange={onConfigChange}
      />

      <Section title={t('sidePanel.markerPosition')} icon={MapPin}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('sidePanel.markerLat')}
              </Label>
              <div className="mt-1 font-mono text-xs">
                {marker.position[1].toFixed(6)}
              </div>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('sidePanel.markerLng')}
              </Label>
              <div className="mt-1 font-mono text-xs">
                {marker.position[0].toFixed(6)}
              </div>
            </div>
          </div>
        </div>
      </Section>
    </>
  )
}

// ---- Saved circles list --------------------------------------------------

function SavedCirclesContent({
  circles,
  selectedCircleIds,
  actions,
  warehouse,
}: {
  circles?: ReadonlyArray<CircleShape>
  selectedCircleIds?: ReadonlySet<number>
  actions?: SidePanelActions
  warehouse?: Zone | null
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (circles ?? []).filter((c) => matchesWorkspaceQuery(c.name, query))
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectCircle?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section title={t('sidePanel.savedCirclesTitle')} icon={Circle}>
      <VirtualList
        items={list}
        keyFor={(c) => c.id!}
        renderItem={(c) => {
          const id = c.id!
          const isSelected = selectedCircleIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          const summary = c.role
            ? roleLabel(warehouse, 'circle', c.role)
            : c.mode === 'single'
              ? `${formatLength(c.radius ?? 0, c.unit)} ${t('sidePanel.circleSummaryRadius')}`
              : `${formatLength(c.cellSize ?? 0, c.unit, { withSuffix: false })} / ${formatLength(
                c.cellRadius ?? 0,
                c.unit
              )}`
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30'
              )}
            >
              <span
                className="flex-shrink-0 w-3 h-3 border-2 rounded-full"
                style={{
                  backgroundColor: c.config.color,
                  borderColor: c.config.borderColor,
                }}
                aria-hidden="true"
              />
              <InlineNameCell
                name={c.name}
                subtitle={<>#{id} · {summary}</>}
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenameCircle?.(id, next)}
                titleAttr={`#${id} ${c.name}`}
              />
              <EyeToggleButton
                visible={c.visible}
                onToggle={(next) => actions?.onToggleCircleVisible?.(id, next)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToCircleById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteCircleById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () =>
                        setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000
                    )
                  }
                }}
                title={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

// ---- Shared circle appearance + 3D + label form -------------------------

function CirclePropertiesForm({
  config,
  unit,
  onChange,
}: {
  config: FillShapeConfig
  unit: LengthUnit
  onChange: (next: FillShapeConfig) => void
}) {
  const { t } = useTranslation()
  const update = <K extends keyof FillShapeConfig>(
    key: K,
    value: FillShapeConfig[K]
  ) => onChange({ ...config, [key]: value })
  return (
    <>
      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.color')}
            value={config.color}
            onChange={(v) => update('color', v)}
          />
          <ColorRow
            label={t('sidePanel.borderColor')}
            value={config.borderColor}
            onChange={(v) => update('borderColor', v)}
          />
          <SliderRow
            label={t('sidePanel.borderWidth')}
            value={config.borderWidth}
            onChange={(v) => update('borderWidth', v)}
            min={0}
            max={6}
            limitMax={LIMIT_STROKE_PX}
            step={0.5}
            suffix="px"
          />
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
          />
        </div>
      </Section>

      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.elevation')}</span>
              <span className="font-mono text-muted-foreground">
                {config.elevation === 0
                  ? t('sidePanel.flat')
                  : formatLength(config.elevation, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.elevation}
              unit={unit}
              min={0}
              max={LIMIT_ELEVATION_M}
              onChange={(meters) => update('elevation', Math.max(0, meters))}
              ariaLabel={t('sidePanel.elevation')}
            />
            <StretchSlider
              value={config.elevation}
              onValueChange={(v) => update('elevation', v)}
              min={0}
              max={500}
              limitMax={LIMIT_ELEVATION_M}
              step={0.1}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.height')}</span>
              <span className="font-mono text-muted-foreground">
                {config.height === 0
                  ? t('sidePanel.flat')
                  : formatLength(config.height, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.height}
              unit={unit}
              min={0}
              onChange={(meters) => update('height', Math.max(0, meters))}
              ariaLabel={t('sidePanel.height')}
            />
            <Slider
              value={[config.height]}
              onValueChange={(v) => update('height', v[0])}
              min={0}
              max={500}
              step={0.1}
            />
          </div>
          <div className="flex items-center justify-between gap-2 pt-1 border-t">
            <div className="min-w-0">
              <Label className="text-xs">
                {t('sidePanel.receiveShadows', { defaultValue: 'Receive shadows' })}
              </Label>
              <p className="text-[10px] text-muted-foreground leading-tight">
                {t('sidePanel.receiveShadowsHint', {
                  defaultValue: 'Let shadows from taller shapes darken this surface. Enable on floor slabs. May darken at low zoom.',
                })}
              </p>
            </div>
            <Switch
              checked={config.receiveShadows ?? true}
              onCheckedChange={(v) => update('receiveShadows', v)}
            />
          </div>
        </div>
      </Section>

      <Section title={t('sidePanel.sectionLabels')} icon={Type}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('sidePanel.circleLabel')}</Label>
            <TextField
              value={config.label}
              onCommit={(text) => {
                onChange({
                  ...config,
                  label: text,
                  showLabels: text.trim() !== '',
                })
              }}
              placeholder={t('sidePanel.circleLabelPlaceholder')}
              className="h-8 text-sm"
            />
          </div>
          {config.label.trim() !== '' && (
            <>
              <ColorRow
                label={t('sidePanel.labelColor')}
                value={config.labelColor}
                onChange={(v) => update('labelColor', v)}
              />
              <SliderRow
                label={t('sidePanel.labelSize')}
                value={config.labelSize}
                onChange={(v) => update('labelSize', v)}
                min={8}
                max={32}
                limitMax={LIMIT_SYMBOL_SIZE_PX}
                step={0.1}
                suffix="px"
              />
              <div className="flex items-center justify-between">
                <Label htmlFor="labelFlat" className="text-xs">
                  {t('sidePanel.labelFlat')}
                </Label>
                <Switch
                  id="labelFlat"
                  checked={config.labelFlat ?? false}
                  onCheckedChange={(v) => update('labelFlat', v)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('sidePanel.labelOffsetX')}
                  </Label>
                  <NumberInput
                    value={config.labelOffsetX ?? 0}
                    unit={unit}
                    onChange={(m) => update('labelOffsetX', m)}
                    ariaLabel={t('sidePanel.labelOffsetX')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('sidePanel.labelOffsetY')}
                  </Label>
                  <NumberInput
                    value={config.labelOffsetY ?? 0}
                    unit={unit}
                    onChange={(m) => update('labelOffsetY', m)}
                    ariaLabel={t('sidePanel.labelOffsetY')}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </Section>

      <TooltipTriggerSection
        value={config.tooltipTrigger}
        onChange={(v) => update('tooltipTrigger', v)}
      />
    </>
  )
}

// ---- Circle placement panel ---------------------------------------------

function CirclePlacementContent({
  config,
  unit,
  onConfigChange,
  subMode,
  onSubModeChange,
  cellSize,
  onCellSizeChange,
  cellRadius,
  onCellRadiusChange,
  onExit,
}: {
  config: FillShapeConfig
  unit: LengthUnit
  onConfigChange: (next: FillShapeConfig) => void
  subMode: 'single' | 'grid'
  onSubModeChange?: (mode: 'single' | 'grid') => void
  cellSize: number
  onCellSizeChange?: (meters: number) => void
  cellRadius: number
  onCellRadiusChange?: (meters: number) => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={Crosshair}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            {(['single', 'grid'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onSubModeChange?.(m)}
                className={cn(
                  'py-2 rounded-md border text-xs transition-colors',
                  subMode === m
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:bg-accent'
                )}
              >
                {t(`sidePanel.circleSubMode_${m}`)}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {subMode === 'single'
              ? t('sidePanel.circlePlacementHintSingle')
              : t('sidePanel.circlePlacementHintGrid')}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onExit}
          >
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.circlePlacementExit')}
          </Button>
        </div>
      </Section>

      {subMode === 'grid' && (
        <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
          <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
            <div className="space-y-1.5">
              <Label className="flex items-center justify-between text-xs">
                <span>{t('sidePanel.circleCellSize')}</span>
                <span className="font-mono text-muted-foreground">
                  {formatLength(cellSize, unit)}
                </span>
              </Label>
              <NumberInput
                value={cellSize}
                unit={unit}
                min={0.5}
                onChange={(m) => onCellSizeChange?.(Math.max(0.5, m))}
                ariaLabel={t('sidePanel.circleCellSize')}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center justify-between text-xs">
                <span>{t('sidePanel.circleCellRadius')}</span>
                <span className="font-mono text-muted-foreground">
                  {formatLength(cellRadius, unit)}
                </span>
              </Label>
              <NumberInput
                value={cellRadius}
                unit={unit}
                min={0.1}
                max={cellSize / 2}
                onChange={(m) =>
                  onCellRadiusChange?.(
                    Math.max(0.1, Math.min(cellSize / 2, m))
                  )
                }
                ariaLabel={t('sidePanel.circleCellRadius')}
              />
              <p className="text-[10px] text-muted-foreground">
                {t('sidePanel.circleCellRadiusHint')}
              </p>
            </div>
          </div>
        </Section>
      )}

      <CirclePropertiesForm
        config={config}
        unit={unit}
        onChange={onConfigChange}
      />
    </>
  )
}

// ---- Circle selected panel ----------------------------------------------

function CircleSelectedContent({
  circle,
  onConfigChange,
  onPatch,
  confirmDelete,
  setConfirmDelete,
  actions,
  warehouse,
}: {
  circle: CircleShape
  onConfigChange: (next: FillShapeConfig) => void
  onPatch?: (patch: Partial<CircleShape>) => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  actions?: SidePanelActions
  warehouse?: Zone | null
}) {
  const { t } = useTranslation()
  const isMoving =
    actions?.circleTransformActive && actions?.circleTransformKind === 'move'
  const isRotating =
    actions?.circleTransformActive && actions?.circleTransformKind === 'rotate'
  const canRotate = circle.mode === 'grid'
  return (
    <>
      <RolePicker
        kind="circle"
        warehouse={warehouse}
        value={circle.role}
        onChange={(role) => onPatch?.({ role })}
      />
      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className={cn('grid gap-1.5', canRotate ? 'grid-cols-3' : 'grid-cols-2')}>
            <Button
              variant={isMoving ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isMoving) actions?.onCancelCircleTransform?.()
                else actions?.onStartMoveCircle?.(circle.id!)
              }}
              title={t('sidePanel.move')}
              aria-label={t('sidePanel.move')}
            >
              <Move className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.move')}
            </Button>
            {canRotate && (
              <Button
                variant={isRotating ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  if (isRotating) actions?.onCancelCircleTransform?.()
                  else actions?.onStartRotateCircle?.(circle.id!)
                }}
                title={t('sidePanel.rotate')}
                aria-label={t('sidePanel.rotate')}
              >
                <RotateCw className="w-3.5 h-3.5 me-1.5" />
                {t('sidePanel.rotate')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onFitToCircleById?.(circle.id!)}
              title={t('sidePanel.fit')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
          </div>
          {(isMoving || isRotating) && (
            <p className="text-[11px] text-muted-foreground px-1">
              {isMoving ? t('sidePanel.moveHint') : t('sidePanel.rotateHint')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions?.onDuplicateCircle?.(circle.id!)}
              title={t('sidePanel.duplicate')}
            >
              <Copy className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.duplicate')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  actions?.onDeleteCircleById?.(circle.id!)
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
              title={t('sidePanel.delete')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t('sidePanel.confirmDeleteHint')}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() =>
              actions?.onEditShapeData?.({
                kind: 'circle',
                shapeId: circle.id!,
                shapeName: circle.name,
              })
            }
            title={t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          >
            <Boxes className="w-3.5 h-3.5 me-1.5" />
            {t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          </Button>
        </div>
      </Section>

      <LinkedDataBlock kind="circle" shapeId={circle.id} />

      <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          {circle.mode === 'single' ? (
            <div className="space-y-1.5">
              <Label className="flex items-center justify-between text-xs">
                <span>{t('sidePanel.circleRadius')}</span>
                <span className="font-mono text-muted-foreground">
                  {formatLength(circle.radius ?? 0, circle.unit)}
                </span>
              </Label>
              <NumberInput
                value={circle.radius ?? 0}
                unit={circle.unit}
                min={0.1}
                onChange={(m) => onPatch?.({ radius: Math.max(0.1, m) })}
                ariaLabel={t('sidePanel.circleRadius')}
              />
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label className="flex items-center justify-between text-xs">
                  <span>{t('sidePanel.circleCellSize')}</span>
                  <span className="font-mono text-muted-foreground">
                    {formatLength(circle.cellSize ?? 0, circle.unit)}
                  </span>
                </Label>
                <NumberInput
                  value={circle.cellSize ?? 0}
                  unit={circle.unit}
                  min={0.5}
                  onChange={(m) => {
                    const next = Math.max(0.5, m)
                    const maxR = next / 2
                    onPatch?.({
                      cellSize: next,
                      // Keep the radius inside the new cell.
                      cellRadius: Math.min(circle.cellRadius ?? maxR, maxR),
                    })
                  }}
                  ariaLabel={t('sidePanel.circleCellSize')}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="flex items-center justify-between text-xs">
                  <span>{t('sidePanel.circleCellRadius')}</span>
                  <span className="font-mono text-muted-foreground">
                    {formatLength(circle.cellRadius ?? 0, circle.unit)}
                  </span>
                </Label>
                <NumberInput
                  value={circle.cellRadius ?? 0}
                  unit={circle.unit}
                  min={0.1}
                  max={(circle.cellSize ?? 1) / 2}
                  onChange={(m) =>
                    onPatch?.({
                      cellRadius: Math.max(
                        0.1,
                        Math.min((circle.cellSize ?? 1) / 2, m)
                      ),
                    })
                  }
                  ariaLabel={t('sidePanel.circleCellRadius')}
                />
              </div>
            </>
          )}
          <SliderRow
            label={
              <span className="flex items-center gap-1.5">
                <RotateCw className="w-3 h-3" />
                {t('sidePanel.rotation')}
              </span>
            }
            labelExtra={
              <button
                type="button"
                onClick={() => onPatch?.({ rotation: 0 })}
                className="font-mono transition-colors text-muted-foreground hover:text-foreground"
                title={t('sidePanel.rotationReset')}
              >
                {circle.rotation.toFixed(1).replace(/\.0$/, '')}°
              </button>
            }
            value={circle.rotation}
            onChange={(v) => onPatch?.({ rotation: v })}
            min={-180}
            max={180}
            step={0.5}
            suffix="°"
          />
        </div>
      </Section>

      <CirclePropertiesForm
        config={circle.config}
        unit={circle.unit}
        onChange={onConfigChange}
      />
    </>
  )
}

// ---- Saved polygons list -------------------------------------------------

function SavedPolygonsContent({
  polygons,
  selectedPolygonIds,
  actions,
  warehouse,
}: {
  polygons?: ReadonlyArray<PolygonShape>
  selectedPolygonIds?: ReadonlySet<number>
  actions?: SidePanelActions
  warehouse?: Zone | null
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (polygons ?? []).filter((p) => matchesWorkspaceQuery(p.name, query))
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectPolygon?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section title={t('sidePanel.savedPolygonsTitle')} icon={Pentagon}>
      <VirtualList
        items={list}
        keyFor={(p) => p.id!}
        renderItem={(p) => {
          const id = p.id!
          const isSelected = selectedPolygonIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30'
              )}
            >
              <span
                className="flex-shrink-0 w-3 h-3 border-2 rounded-sm"
                style={{
                  backgroundColor: p.config.color,
                  borderColor: p.config.borderColor,
                }}
                aria-hidden="true"
              />
              <InlineNameCell
                name={p.name}
                subtitle={
                  <>
                    #{id} ·{' '}
                    {p.role
                      ? roleLabel(warehouse, 'polygon', p.role)
                      : t('sidePanel.polygonVerticesCount', { count: p.vertices.length })}
                  </>
                }
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenamePolygon?.(id, next)}
                titleAttr={`#${id} ${p.name}`}
              />
              <EyeToggleButton
                visible={p.visible}
                onToggle={(next) => actions?.onTogglePolygonVisible?.(id, next)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToPolygonById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeletePolygonById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () =>
                        setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000
                    )
                  }
                }}
                title={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

// ---- Polygon placement panel --------------------------------------------

function PolygonPlacementContent({
  config,
  unit,
  vertexCount,
  onConfigChange,
  onExit,
}: {
  config: FillShapeConfig
  unit: LengthUnit
  vertexCount: number
  onConfigChange: (next: FillShapeConfig) => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={Crosshair}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <p className="text-[11px] text-muted-foreground">
            {t('sidePanel.polygonPlacementHint')}
          </p>
          <div className="text-[11px] text-muted-foreground">
            {t('sidePanel.polygonPlacementVertices', { count: vertexCount })}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onExit}
          >
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.polygonPlacementExit')}
          </Button>
        </div>
      </Section>
      <CirclePropertiesForm
        config={config}
        unit={unit}
        onChange={onConfigChange}
      />
    </>
  )
}

// ---- Magic-wall panel ---------------------------------------------------
//
// Two-part layout: (1) the standard wall properties form (same
// LinePropertiesForm that line-placement uses) so the user configures
// colour / width / thickness / height / elevation before generating;
// (2) a small instruction + polygon-selection list + Generate / Cancel
// buttons. The wall config bound to LinePropertiesForm IS the same
// `lineConfig` state the line-draw tool reads, so whatever the user
// tweaks here is snapshotted into every generated wall on Generate.

function MagicWallContent({
  polygons,
  selectedIds,
  lineConfig,
  unit,
  onLineConfigChange,
  busy,
  onGenerate,
  onExit,
}: {
  polygons: ReadonlyArray<PolygonShape>
  selectedIds: ReadonlySet<number>
  lineConfig: LineShapeConfig
  unit: LengthUnit
  onLineConfigChange: (next: LineShapeConfig) => void
  busy: boolean
  onGenerate?: () => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  const count = selectedIds.size
  const selectedList = polygons.filter(
    (p) => p.id !== undefined && selectedIds.has(p.id),
  )
  return (
    <>
      <Section title={t('sidePanel.magicWallSectionTitle')} icon={Wand2}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <p className="text-[11px] text-muted-foreground">
            {t('sidePanel.magicWallHint')}
          </p>
          <div className="text-[11px] text-muted-foreground">
            {count === 0
              ? t('sidePanel.magicWallSubtitleEmpty')
              : t('sidePanel.magicWallSubtitleCount', { count })}
          </div>
          {selectedList.length > 0 && (
            <ul className="max-h-40 overflow-auto space-y-1 border rounded-md p-2 bg-background">
              {selectedList.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 text-[11px] leading-tight"
                >
                  <span
                    className="flex-shrink-0 w-2.5 h-2.5 border rounded-sm"
                    style={{
                      backgroundColor: p.config.color,
                      borderColor: p.config.borderColor,
                    }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{p.name}</span>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="default"
            size="sm"
            className="w-full"
            onClick={onGenerate}
            disabled={count === 0 || busy || !onGenerate}
          >
            <Wand2 className="w-3.5 h-3.5 me-2" />
            {busy
              ? t('sidePanel.magicWallGenerating', {
                  defaultValue: 'Generating…',
                })
              : t('sidePanel.magicWallGenerate', { count })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onExit}
            disabled={busy}
          >
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.magicWallExit')}
          </Button>
        </div>
      </Section>
      <LinePropertiesForm
        config={lineConfig}
        unit={unit}
        onChange={onLineConfigChange}
      />
    </>
  )
}

// ---- AI Map sidebar ----------------------------------------------------
//
// Focused, one-floor-at-a-time UX (matches how the editor treats "the
// current floor plan" everywhere else — bulk-assign, drawing-inherits-
// default, saved-shapes lists all target the active floor). Buildings
// have multiple floors but a user only ever detects on ONE at a time,
// so we pre-select the toolbar's default floor and let them swap via a
// small picker when the facility has more than one.
//
// Layout mirrors MagicWallContent for visual consistency: `Section`
// wrapper, rounded card with `bg-card/50 backdrop-blur`, ~11px
// muted-foreground copy, full-width primary + outline exit button.

function AIMapContent({
  images,
  targetId,
  busy,
  onSetTarget,
  onDetect,
  onExit,
}: {
  images: ReadonlyArray<ImageShape>
  /** Currently-selected floor plan for detection. Starts as the
   *  editor's `defaultFloorPlanId`; user can override via the picker
   *  when the facility has multiple floors. */
  targetId: number | null
  busy: boolean
  onSetTarget?: (imageId: number | null) => void
  onDetect?: (imageId: number) => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  const visibleImages = images.filter((i): i is ImageShape & { id: number } => typeof i.id === 'number')
  const target = visibleImages.find((i) => i.id === targetId) ?? null
  return (
    <>
      <Section title={t('sidePanel.aiMapSectionTitle', { defaultValue: 'AI Map' })} icon={Sparkles}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          {visibleImages.length === 0 ? (
            <div className="text-[11px] text-muted-foreground italic">
              {t('sidePanel.aiMapEmpty', {
                defaultValue: 'No floor plans in this facility yet. Upload one first.',
              })}
            </div>
          ) : (
            <>
              {/* Target floor row — auto-selected, swappable when the
                  facility has more than one placed floor. Compact card
                  matches how selected-shape headers render in this
                  sidebar (icon + name + id, tight typography). */}
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  {t('sidePanel.aiMapTargetLabel', { defaultValue: 'Floor plan' })}
                </div>
                {visibleImages.length === 1 ? (
                  <div className="flex items-center gap-2 p-2 border rounded-md bg-background">
                    <ImageIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {visibleImages[0].name}
                      </div>
                    </div>
                  </div>
                ) : (
                  // Native select — matches how other multi-choice pickers
                  // in this sidebar (RolePicker etc.) render.
                  <select
                    value={target?.id ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      onSetTarget?.(v === '' ? null : Number(v))
                    }}
                    className="w-full h-8 px-2 text-xs border rounded-md bg-background"
                  >
                    <option value="">
                      {t('sidePanel.aiMapTargetPickPlaceholder', { defaultValue: '— pick a floor —' })}
                    </option>
                    {visibleImages.map((img) => (
                      <option key={img.id} value={img.id}>
                        #{img.id} {img.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Primary action + drag hint. Both routes end in the same
                  detection flow; the button is the discoverable path,
                  the drag is the power-user path. */}
              <Button
                variant="default"
                size="sm"
                className="w-full"
                disabled={busy || !target || !onDetect}
                onClick={() => target && onDetect?.(target.id)}
              >
                <Sparkles className="w-3.5 h-3.5 me-2" />
                {busy
                  ? t('sidePanel.aiMapDetecting', { defaultValue: 'Detecting…' })
                  : t('sidePanel.aiMapDetectFull', { defaultValue: 'Detect entire floor' })}
              </Button>
              <p className="text-[11px] text-muted-foreground text-center leading-tight">
                {t('sidePanel.aiMapDragHint', {
                  defaultValue: 'Or drag a rectangle on the floor plan to detect only that area.',
                })}
              </p>
            </>
          )}

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onExit}
            disabled={busy}
          >
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.aiMapExit', { defaultValue: 'Cancel' })}
          </Button>
        </div>
      </Section>
    </>
  )
}

// ---- Role picker --------------------------------------------------------
// Small dropdown that lets the user assign a per-warehouse role to a
// polygon / circle. Rendered above the Actions section on both shape
// editors. Reads the warehouse's `roleVocabulary` (with the default
// starter set as fallback) so options match whichever building the
// shape lives in. The "—" entry lets the user clear the role.

function RolePicker({
  kind,
  warehouse,
  value,
  onChange,
}: {
  kind: 'polygon' | 'circle'
  warehouse?: Zone | null
  value: string | undefined
  onChange: (role: string | undefined) => void
}) {
  const { t } = useTranslation()
  const list = vocabularyFor(warehouse, kind)
  return (
    <Section title={t('sidePanel.sectionRole', { defaultValue: 'Role' })} icon={Tag}>
      <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
        <label className="block text-[11px] text-muted-foreground">
          {t('sidePanel.rolePickerHint', {
            defaultValue:
              'What this shape represents in this facility. Edit the list in the facility settings.',
          })}
        </label>
        <div className="flex items-center gap-2">
          <select
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value || undefined)}
            className="flex-1 h-8 px-2 text-xs rounded border bg-background"
          >
            <option value="">{t('sidePanel.roleNone', { defaultValue: '— None —' })}</option>
            {list.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          {/* Colour swatch of the picked role — quick visual cue. */}
          {value && (
            <span
              className="w-5 h-5 rounded border flex-shrink-0"
              style={{
                backgroundColor:
                  list.find((r) => r.key === value)?.color ?? 'transparent',
              }}
              aria-hidden
            />
          )}
        </div>
      </div>
    </Section>
  )
}

// ---- Polygon selected panel ---------------------------------------------

function PolygonSelectedContent({
  polygon,
  onConfigChange,
  onPatch,
  confirmDelete,
  setConfirmDelete,
  actions,
  warehouse,
}: {
  polygon: PolygonShape
  onConfigChange: (next: FillShapeConfig) => void
  onPatch?: (patch: Partial<PolygonShape>) => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  actions?: SidePanelActions
  warehouse?: Zone | null
}) {
  const { t } = useTranslation()
  const isMoving =
    actions?.polygonTransformActive && actions?.polygonTransformKind === 'move'
  const isRotating =
    actions?.polygonTransformActive && actions?.polygonTransformKind === 'rotate'
  const isEditing =
    actions?.polygonTransformActive && actions?.polygonTransformKind === 'edit'
  return (
    <>
      <RolePicker
        kind="polygon"
        warehouse={warehouse}
        value={polygon.role}
        onChange={(role) => onPatch?.({ role })}
      />
      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-4 gap-1.5">
            <Button
              variant={isMoving ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isMoving) actions?.onCancelPolygonTransform?.()
                else actions?.onStartMovePolygon?.(polygon.id!)
              }}
              title={t('sidePanel.move')}
            >
              <Move className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.move')}
            </Button>
            <Button
              variant={isRotating ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isRotating) actions?.onCancelPolygonTransform?.()
                else actions?.onStartRotatePolygon?.(polygon.id!)
              }}
              title={t('sidePanel.rotate')}
            >
              <RotateCw className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.rotate')}
            </Button>
            <Button
              variant={isEditing ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isEditing) actions?.onCancelPolygonTransform?.()
                else actions?.onStartEditPolygon?.(polygon.id!)
              }}
              title={t('sidePanel.editVertices', { defaultValue: 'Edit vertices' })}
            >
              <Pencil className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.editVertices', { defaultValue: 'Edit' })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onFitToPolygonById?.(polygon.id!)}
              title={t('sidePanel.fit')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
          </div>
          {(isMoving || isRotating || isEditing) && (
            <p className="text-[11px] text-muted-foreground px-1">
              {isMoving
                ? t('sidePanel.moveHint')
                : isRotating
                  ? t('sidePanel.rotateHint')
                  : t('sidePanel.editVerticesHint', {
                      defaultValue:
                        'Drag a vertex to reshape. Click an edge midpoint to insert. Alt-click a vertex to remove.',
                    })}
            </p>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions?.onDuplicatePolygon?.(polygon.id!)}
              title={t('sidePanel.duplicate')}
            >
              <Copy className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.duplicate')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  actions?.onDeletePolygonById?.(polygon.id!)
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
              title={t('sidePanel.delete')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t('sidePanel.confirmDeleteHint')}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() =>
              actions?.onEditShapeData?.({
                kind: 'polygon',
                shapeId: polygon.id!,
                shapeName: polygon.name,
              })
            }
            title={t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          >
            <Boxes className="w-3.5 h-3.5 me-1.5" />
            {t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          </Button>
        </div>
      </Section>

      <LinkedDataBlock kind="polygon" shapeId={polygon.id} />

      <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="text-[11px] text-muted-foreground font-mono">
            {t('sidePanel.polygonVerticesCount', {
              count: polygon.vertices.length,
            })}
          </div>
          <SliderRow
            label={
              <span className="flex items-center gap-1.5">
                <RotateCw className="w-3 h-3" />
                {t('sidePanel.rotation')}
              </span>
            }
            labelExtra={
              <button
                type="button"
                onClick={() => onPatch?.({ rotation: 0 })}
                className="font-mono transition-colors text-muted-foreground hover:text-foreground"
                title={t('sidePanel.rotationReset')}
              >
                {polygon.rotation.toFixed(1).replace(/\.0$/, '')}°
              </button>
            }
            value={polygon.rotation}
            onChange={(v) => onPatch?.({ rotation: v })}
            min={-180}
            max={180}
            step={0.5}
            suffix="°"
          />
        </div>
      </Section>

      <CirclePropertiesForm
        config={polygon.config}
        unit={polygon.unit}
        onChange={onConfigChange}
      />
    </>
  )
}

// ---- Saved lines list ----------------------------------------------------

/**
 * Rebrand the auto-generated "Aisle" name to "Wall" once the shape has
 * been extruded (height > 0 or elevation > 0). Only rewrites the
 * default-named rows and their (copy) descendants; if the user typed a
 * custom name we keep it verbatim. Matches the same wall/aisle split the
 * bottom status bar shows so both places agree.
 */
function getLineDisplayName(
  ln: LineShape,
  t: TFunction,
): string {
  const isWall = (ln.config.height ?? 0) > 0 || (ln.config.elevation ?? 0) > 0
  if (!isWall) return ln.name
  const defaultAisle = t('line.defaultName', { defaultValue: 'Aisle' })
  const defaultWall = t('line.defaultWallName', { defaultValue: 'Wall' })
  if (ln.name === defaultAisle) return defaultWall
  if (ln.name.startsWith(defaultAisle + ' (copy)')) {
    return defaultWall + ln.name.substring(defaultAisle.length)
  }
  return ln.name
}

function SavedLinesContent({
  lines,
  selectedLineIds,
  actions,
}: {
  lines?: ReadonlyArray<LineShape>
  selectedLineIds?: ReadonlySet<number>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (lines ?? []).filter((l) => matchesWorkspaceQuery(l.name, query))
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectLine?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section title={t('sidePanel.savedLinesTitle')} icon={Spline}>
      <VirtualList
        items={list}
        keyFor={(ln) => ln.id!}
        renderItem={(ln) => {
          const id = ln.id!
          const isSelected = selectedLineIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          const length = lineLengthMeters(ln.vertices)
          const displayName = getLineDisplayName(ln, t)
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30'
              )}
            >
              <span
                className="w-4 h-1.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: ln.config.color }}
                aria-hidden="true"
              />
              <InlineNameCell
                name={displayName}
                subtitle={<>#{id} · {formatLength(length, ln.unit)}</>}
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenameLine?.(id, next)}
                titleAttr={`#${id} ${displayName}`}
              />
              <EyeToggleButton
                visible={ln.visible}
                onToggle={(next) => actions?.onToggleLineVisible?.(id, next)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToLineById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteLineById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () =>
                        setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000
                    )
                  }
                }}
                title={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

// ---- Line properties form (shared between placement + selected) ----------

function LinePropertiesForm({
  config,
  unit,
  onChange,
}: {
  config: LineShapeConfig
  unit: LengthUnit
  onChange: (next: LineShapeConfig) => void
}) {
  const { t } = useTranslation()
  const update = <K extends keyof LineShapeConfig>(
    key: K,
    value: LineShapeConfig[K]
  ) => onChange({ ...config, [key]: value })
  const dashes: LineDash[] = ['solid', 'dashed', 'dotted']
  const positions: Array<'start' | 'middle' | 'end'> = ['start', 'middle', 'end']
  return (
    <>
      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.lineColor')}
            value={config.color}
            onChange={(v) => update('color', v)}
          />
          <SliderRow
            label={t('sidePanel.lineWidth')}
            value={config.width}
            onChange={(v) => update('width', v)}
            min={1}
            max={16}
            limitMax={LIMIT_STROKE_PX}
            step={0.5}
            suffix="px"
          />
          <div className="space-y-1.5">
            <Label className="text-xs">{t('sidePanel.lineDash')}</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {dashes.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => update('dash', d)}
                  className={cn(
                    'py-1.5 rounded-md border text-xs capitalize transition-colors',
                    config.dash === d
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:bg-accent'
                  )}
                >
                  {t(`sidePanel.lineDash_${d}`)}
                </button>
              ))}
            </div>
          </div>
          <ColorRow
            label={t('sidePanel.borderColor')}
            value={config.borderColor ?? '#000000'}
            onChange={(v) => update('borderColor', v)}
          />
          <SliderRow
            label={t('sidePanel.borderWidth')}
            value={config.borderWidth ?? 0}
            onChange={(v) => update('borderWidth', v)}
            min={0}
            max={8}
            limitMax={LIMIT_STROKE_PX}
            step={0.5}
            suffix="px"
          />
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={10}
            max={100}
            step={0.1}
            suffix="%"
          />
        </div>
      </Section>

      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.elevation')}</span>
              <span className="font-mono text-muted-foreground">
                {config.elevation === 0
                  ? t('sidePanel.flat')
                  : formatLength(config.elevation, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.elevation}
              unit={unit}
              min={0}
              max={LIMIT_ELEVATION_M}
              onChange={(meters) => update('elevation', Math.max(0, meters))}
              ariaLabel={t('sidePanel.elevation')}
            />
            <StretchSlider
              value={config.elevation}
              onValueChange={(v) => update('elevation', v)}
              min={0}
              max={500}
              limitMax={LIMIT_ELEVATION_M}
              step={0.1}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.lineWallHeight')}</span>
              <span className="font-mono text-muted-foreground">
                {config.height === 0
                  ? t('sidePanel.flat')
                  : formatLength(config.height, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.height}
              unit={unit}
              min={0}
              onChange={(meters) => update('height', Math.max(0, meters))}
              ariaLabel={t('sidePanel.lineWallHeight')}
            />
            <p className="text-[10px] text-muted-foreground">
              {t('sidePanel.lineWallHint')}
            </p>
          </div>
          {/* Wall thickness — only meaningful when a wall is being
              extruded. Hidden for flat lines (height === 0) to keep
              the panel tight. */}
          {config.height > 0 && (
            <div className="space-y-1.5">
              <Label className="flex items-center justify-between text-xs">
                <span>
                  {t('sidePanel.lineWallThickness', {
                    defaultValue: 'Wall thickness',
                  })}
                </span>
                <span className="font-mono text-muted-foreground">
                  {formatLength(config.wallThickness ?? 0.3, unit)}
                </span>
              </Label>
              <NumberInput
                value={config.wallThickness ?? 0.3}
                unit={unit}
                min={0.05}
                max={LIMIT_WALL_THICKNESS_M}
                onChange={(meters) =>
                  update('wallThickness', Math.max(0.05, meters))
                }
                ariaLabel={t('sidePanel.lineWallThickness', {
                  defaultValue: 'Wall thickness',
                })}
              />
              <StretchSlider
                value={config.wallThickness ?? 0.3}
                onValueChange={(v) => update('wallThickness', Math.max(0.05, v))}
                min={0.05}
                max={2}
                limitMax={LIMIT_WALL_THICKNESS_M}
                step={0.05}
              />
            </div>
          )}
        </div>
      </Section>

      <Section title={t('sidePanel.sectionLabels')} icon={Type}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('sidePanel.lineLabel')}</Label>
            <TextField
              value={config.label}
              onCommit={(text) => {
                onChange({
                  ...config,
                  label: text,
                  showLabels: text.trim() !== '',
                })
              }}
              placeholder={t('sidePanel.lineLabelPlaceholder')}
              className="h-8 text-sm"
            />
          </div>
          {config.label.trim() !== '' && (
            <>
              <ColorRow
                label={t('sidePanel.labelColor')}
                value={config.labelColor}
                onChange={(v) => update('labelColor', v)}
              />
              <SliderRow
                label={t('sidePanel.labelSize')}
                value={config.labelSize}
                onChange={(v) => update('labelSize', v)}
                min={8}
                max={32}
                limitMax={LIMIT_SYMBOL_SIZE_PX}
                step={0.1}
                suffix="px"
              />
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('sidePanel.lineLabelPosition')}
                </Label>
                <div className="grid grid-cols-3 gap-1.5">
                  {positions.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => update('labelPosition', p)}
                      className={cn(
                        'py-1.5 rounded-md border text-xs capitalize transition-colors',
                        config.labelPosition === p
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-accent'
                      )}
                    >
                      {t(`sidePanel.lineLabelPos_${p}`)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </Section>

      <TooltipTriggerSection
        value={config.tooltipTrigger}
        onChange={(v) => update('tooltipTrigger', v)}
      />
    </>
  )
}

// ---- Line placement panel ------------------------------------------------

// ---- Stair editor --------------------------------------------------------

/**
 * Compact properties form shared by stair placement (default-config
 * edit) and stair-selected (live edit of the saved row). Mirrors the
 * SketchUp/Revit stair UX: width, step count, riser height, and tread
 * mode (auto/manual). The Blondel + IBC compliance badge surfaces the
 * geometric quality of the current values in real time.
 */
/** Display name of a stair-tool type (stairs and lifts). */
function stairTypeLabel(type: StairShapeConfig['stairType'] | undefined, t: TFunction): string {
  switch (type ?? 'straight') {
    case 'l':
      return t('sidePanel.stairTypeL', { defaultValue: 'L-shape' })
    case 'u':
      return t('sidePanel.stairTypeU', { defaultValue: 'U-shape' })
    case 'escalator':
      return t('sidePanel.stairTypeEscalator', { defaultValue: 'Escalator' })
    case 'elevator':
      return t('sidePanel.stairTypeElevator', { defaultValue: 'Elevator' })
    default:
      return t('sidePanel.stairTypeStraight', { defaultValue: 'Straight' })
  }
}

function StairPropertiesForm({
  config,
  onChange,
  unit,
  runLengthMeters,
  floors = [],
  drawnLength,
  onLengthChange,
}: {
  config: StairShapeConfig
  onChange: (next: StairShapeConfig) => void
  /** Escalators: stretch the placed run to a new length (m). */
  onLengthChange?: (meters: number) => void
  unit: LengthUnit
  /** Effective run length used for Blondel evaluation (auto-mode only). */
  runLengthMeters: number
  /** The facility's floor plans, for linking lifts to floors. */
  floors?: readonly LiftFloorOption[]
  /** Drawn run length (m) of a placed shape — escalators with a fixed length use it. */
  drawnLength?: number
}) {
  const { t } = useTranslation()
  const update = <K extends keyof StairShapeConfig>(key: K, value: StairShapeConfig[K]) => {
    onChange({ ...config, [key]: value })
  }
  const kind = config.stairType ?? 'straight'
  const lift = isLiftType(kind)
  const typePicker = (
    <div className="space-y-2">
      {([
        [
          t('sidePanel.stairTypeGroupStairs', { defaultValue: 'Stairs' }),
          [
            ['straight', t('sidePanel.stairTypeStraight', { defaultValue: 'Straight' })],
            ['l', t('sidePanel.stairTypeL', { defaultValue: 'L-shape' })],
            ['u', t('sidePanel.stairTypeU', { defaultValue: 'U-shape' })],
          ],
        ],
        [
          t('sidePanel.stairTypeGroupLifts', { defaultValue: 'Lifts' }),
          [
            ['escalator', t('sidePanel.stairTypeEscalator', { defaultValue: 'Escalator' })],
            ['elevator', t('sidePanel.stairTypeElevator', { defaultValue: 'Elevator' })],
          ],
        ],
      ] as const).map(([group, options]) => (
        <div key={group} className="space-y-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{group}</div>
          <div className={cn('grid gap-1.5', options.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
            {options.map(([id, label]) => (
              <Button
                key={id}
                type="button"
                variant={kind === id ? 'default' : 'outline'}
                size="sm"
                aria-pressed={kind === id}
                onClick={() => onChange(configForStairType(config, id, floors))}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
  if (lift) {
    return (
      <>
        <Section
          title={
            kind === 'escalator'
              ? t('sidePanel.stairTypeEscalator', { defaultValue: 'Escalator' })
              : t('sidePanel.stairTypeElevator', { defaultValue: 'Elevator' })
          }
          icon={kind === 'escalator' ? Footprints : ArrowUpDown}
        >
          <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
            {typePicker}
            {kind === 'escalator' ? (
              <EscalatorFields
                config={config}
                onChange={onChange}
                floors={floors}
                unit={unit}
                drawnLength={drawnLength}
                onLengthChange={onLengthChange}
              />
            ) : (
              <ElevatorFields config={config} onChange={onChange} floors={floors} unit={unit} />
            )}
          </div>
        </Section>
        <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
          <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
            <ColorRow
              label={
                kind === 'escalator'
                  ? t('sidePanel.lift.bodyColor', { defaultValue: 'Body colour' })
                  : t('sidePanel.lift.frameColor', { defaultValue: 'Frame colour' })
              }
              value={config.color}
              onChange={(v) => update('color', v)}
            />
            <ColorRow
              label={
                kind === 'escalator'
                  ? t('sidePanel.lift.treadColor', { defaultValue: 'Step colour' })
                  : t('sidePanel.lift.carColor', { defaultValue: 'Car colour' })
              }
              value={config.riserColor ?? config.borderColor}
              onChange={(v) => update('riserColor', v)}
            />
            {kind === 'escalator' && (
              <>
                <ColorRow
                  label={t('sidePanel.lift.stepEdgeColor', { defaultValue: 'Step edge colour' })}
                  value={config.stepEdgeColor ?? '#facc15'}
                  onChange={(v) => update('stepEdgeColor', v)}
                />
                <SliderRow
                  label={t('sidePanel.lift.stepEdgeWidth', { defaultValue: 'Step edge width' })}
                  value={config.stepEdgeWidth ?? 1}
                  onChange={(v) => update('stepEdgeWidth', v)}
                  min={0}
                  max={4}
                  limitMax={LIMIT_STROKE_PX}
                  step={0.1}
                  suffix="px"
                />
                <p className="text-[10px] text-muted-foreground">
                  {t('sidePanel.lift.stepEdgeHint', {
                    defaultValue: 'Safety line along each step. Set the width to 0 to remove it.',
                  })}
                </p>
              </>
            )}
            <ColorRow
              label={t('sidePanel.borderColor')}
              value={config.borderColor}
              onChange={(v) => update('borderColor', v)}
            />
            <SliderRow
              label={t('sidePanel.borderWidth')}
              value={config.borderWidth ?? 1.2}
              onChange={(v) => update('borderWidth', v)}
              min={0}
              max={8}
              limitMax={LIMIT_STROKE_PX}
              step={0.1}
              suffix="px"
            />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">{t('sidePanel.lift.label', { defaultValue: 'Label' })}</Label>
                <Switch
                  checked={config.showLabels}
                  onCheckedChange={(v) => update('showLabels', v)}
                  aria-label={t('sidePanel.lift.showLabel', { defaultValue: 'Show label' })}
                />
              </div>
              {config.showLabels && (
                <Input
                  value={config.label}
                  onChange={(e) => update('label', e.target.value)}
                  placeholder={t('sidePanel.lift.labelPlaceholder', { defaultValue: 'e.g. To food court' })}
                  className="h-8 text-xs"
                />
              )}
            </div>
          </div>
        </Section>
      </>
    )
  }
  const compliance = evaluateStairCompliance(config, runLengthMeters)
  const badge =
    compliance.severity === 'ok'
      ? 'border-success/40 bg-success/10 text-success'
      : compliance.severity === 'warning'
        ? 'border-warning/40 bg-warning/10 text-warning'
        : 'border-danger/40 bg-danger/10 text-danger'
  return (
    <>
      <Section title={t('sidePanel.stairSectionGeometry', { defaultValue: 'Geometry' })} icon={Footprints}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            {typePicker}
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              {kind === 'straight'
                ? t('sidePanel.stairTypeHintStraight', {
                    defaultValue: 'Click bottom, then top of the run.',
                  })
                : kind === 'l'
                  ? t('sidePanel.stairTypeHintL', {
                      defaultValue: 'Click bottom, corner, then top. Each flight uses the full step count.',
                    })
                  : t('sidePanel.stairTypeHintU', {
                      defaultValue: 'Click bottom, then top of flight 1. Flight 2 mirrors back at the same length.',
                    })}
            </p>
          </div>
          <div className="space-y-1.5">
            <SliderRow
              label={t('sidePanel.stairStepCount', { defaultValue: 'Steps' })}
              value={Math.max(1, Math.floor(config.stepCount))}
              onChange={(v) => update('stepCount', Math.max(1, Math.min(LIMIT_STAIR_STEPS, Math.floor(v))))}
              min={1}
              max={40}
              limitMax={LIMIT_STAIR_STEPS}
              step={0.1}
              decimals={0}
            />
            {(config.stairType ?? 'straight') !== 'straight' && (
              <p className="text-[10px] text-muted-foreground">
                {t('sidePanel.stairStepsPerFlight', {
                  defaultValue: 'Steps per flight (total {{total}} across both).',
                  total: 2 * Math.max(1, Math.floor(config.stepCount)),
                })}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.stairWidth', { defaultValue: 'Width' })}</span>
              <span className="font-mono text-muted-foreground">
                {formatLength(config.width, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.width}
              unit={unit}
              min={0.1}
              onChange={(meters) => update('width', Math.max(0.1, meters))}
              ariaLabel={t('sidePanel.stairWidth', { defaultValue: 'Width' })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.stairRiser', { defaultValue: 'Riser height' })}</span>
              <span className="font-mono text-muted-foreground">
                {formatLength(config.riserHeight, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.riserHeight}
              unit={unit}
              min={0.05}
              onChange={(meters) => update('riserHeight', Math.max(0.05, meters))}
              ariaLabel={t('sidePanel.stairRiser', { defaultValue: 'Riser height' })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.stairTreadMode', { defaultValue: 'Tread depth' })}</span>
              <span className="font-mono text-muted-foreground">
                {formatLength(compliance.treadDepth, unit)}
              </span>
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                type="button"
                variant={config.treadMode === 'auto' ? 'default' : 'outline'}
                size="sm"
                onClick={() => update('treadMode', 'auto')}
                title={t('sidePanel.stairTreadAutoHint', {
                  defaultValue: 'Tread depth follows the drag length',
                })}
              >
                {t('sidePanel.stairTreadAuto', { defaultValue: 'Auto' })}
              </Button>
              <Button
                type="button"
                variant={config.treadMode === 'manual' ? 'default' : 'outline'}
                size="sm"
                onClick={() => update('treadMode', 'manual')}
                title={t('sidePanel.stairTreadManualHint', {
                  defaultValue: 'Tread depth fixed; top anchor recomputes',
                })}
              >
                {t('sidePanel.stairTreadManual', { defaultValue: 'Manual' })}
              </Button>
            </div>
            {config.treadMode === 'manual' && (
              <NumberInput
                value={config.treadDepth}
                unit={unit}
                min={0.1}
                onChange={(meters) => update('treadDepth', Math.max(0.1, meters))}
                ariaLabel={t('sidePanel.stairTreadDepth', { defaultValue: 'Tread depth' })}
              />
            )}
          </div>
          {(config.stairType ?? 'straight') !== 'straight' && (
            <div className="space-y-1.5">
              <Label className="flex items-center justify-between text-xs">
                <span>{t('sidePanel.stairLandingDepth', { defaultValue: 'Landing depth' })}</span>
                <span className="font-mono text-muted-foreground">
                  {formatLength(config.landingDepth ?? config.width * 1.5, unit)}
                </span>
              </Label>
              <NumberInput
                value={config.landingDepth ?? config.width * 1.5}
                unit={unit}
                min={0.1}
                onChange={(meters) => update('landingDepth', Math.max(0.1, meters))}
                ariaLabel={t('sidePanel.stairLandingDepth', { defaultValue: 'Landing depth' })}
              />
              <p className="text-[10px] text-muted-foreground">
                {t('sidePanel.stairLandingDepthHint', {
                  defaultValue: 'Depth of the turn platform along the run direction.',
                })}
              </p>
            </div>
          )}
          {config.stairType === 'u' && (
            <div className="space-y-1.5">
              <Label className="flex items-center justify-between text-xs">
                <span>{t('sidePanel.stairFlightGap', { defaultValue: 'Open well' })}</span>
                <span className="font-mono text-muted-foreground">
                  {formatLength(config.flightGap ?? 0, unit)}
                </span>
              </Label>
              <NumberInput
                value={config.flightGap ?? 0}
                unit={unit}
                min={0}
                onChange={(meters) => update('flightGap', Math.max(0, meters))}
                ariaLabel={t('sidePanel.stairFlightGap', { defaultValue: 'Open well' })}
              />
              <p className="text-[10px] text-muted-foreground">
                {t('sidePanel.stairFlightGapHint', {
                  defaultValue: 'Central void between the two flights. Set to 0 for flush flights.',
                })}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.stairBaseElevation', { defaultValue: 'Base elevation' })}</span>
              <span className="font-mono text-muted-foreground">
                {formatLength(config.baseElevation, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.baseElevation}
              unit={unit}
              min={0}
              onChange={(meters) => update('baseElevation', Math.max(0, meters))}
              ariaLabel={t('sidePanel.stairBaseElevation', { defaultValue: 'Base elevation' })}
            />
          </div>
          <div className={cn('p-2 text-[11px] border rounded leading-relaxed space-y-1', badge)}>
            <div className="font-semibold uppercase tracking-wide text-[10px]">
              {compliance.severity === 'ok'
                ? t('sidePanel.stairOk', { defaultValue: 'Geometry OK' })
                : compliance.severity === 'warning'
                  ? t('sidePanel.stairWarning', { defaultValue: 'Comfort warning' })
                  : t('sidePanel.stairViolation', { defaultValue: 'Code violation' })}
            </div>
            <div>
              {t('sidePanel.stairBlondel', {
                defaultValue: '2R + T = {{cm}} cm (target 60–63 cm)',
                cm: (compliance.blondelMeters * 100).toFixed(1),
              })}
            </div>
            {compliance.issues.map((iss) => (
              <div key={iss.rule}>· {iss.message}</div>
            ))}
          </div>
        </div>
      </Section>

      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.stairTreadColor', { defaultValue: 'Tread colour' })}
            value={config.color}
            onChange={(v) => update('color', v)}
          />
          <ColorRow
            label={t('sidePanel.stairBodyColor', { defaultValue: 'Risers and sides' })}
            value={config.riserColor ?? config.color}
            onChange={(v) => update('riserColor', v)}
          />
          <div className="space-y-1.5">
            <Label className="text-xs">{t('sidePanel.stairRailing', { defaultValue: 'Railing' })}</Label>
            <Choice
              value={config.railing ?? 'metal'}
              options={[
                ['metal', t('sidePanel.stairRailingMetal', { defaultValue: 'Metal' })],
                ['glass', t('sidePanel.stairRailingGlass', { defaultValue: 'Glass' })],
                ['none', t('sidePanel.stairRailingNone', { defaultValue: 'None' })],
              ]}
              onChange={(v) => update('railing', v)}
            />
          </div>
          {(config.railing ?? 'metal') !== 'none' && (
            <ColorRow
              label={t('sidePanel.stairRailingColor', { defaultValue: 'Handrail colour' })}
              value={config.railingColor ?? DEFAULT_RAILING_COLOR}
              onChange={(v) => update('railingColor', v)}
            />
          )}
          <ColorRow
            label={t('sidePanel.borderColor')}
            value={config.borderColor}
            onChange={(v) => update('borderColor', v)}
          />
          <SliderRow
            label={t('sidePanel.borderWidth')}
            value={config.borderWidth ?? 1.2}
            onChange={(v) => update('borderWidth', v)}
            min={0}
            max={8}
            limitMax={LIMIT_STROKE_PX}
            step={0.1}
            suffix="px"
          />
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
          />
        </div>
      </Section>
    </>
  )
}

function StairPlacementContent({
  config,
  onConfigChange,
  anchorCount,
  onExit,
  floors,
}: {
  config: StairShapeConfig
  onConfigChange: (next: StairShapeConfig) => void
  /** How many anchors the user has placed so far (0, 1, …). */
  anchorCount: number
  onExit?: () => void
  floors?: readonly LiftFloorOption[]
}) {
  const { t } = useTranslation()
  // Run length isn't known until the second click — use the manual
  // tread depth × stepCount as the hypothetical length so the Blondel
  // badge has something to evaluate against during placement.
  const runLength = config.stepCount * config.treadDepth
  const stairType = config.stairType ?? 'straight'
  const placementHint = (() => {
    if (stairType === 'escalator') {
      return anchorCount === 0
        ? t('sidePanel.lift.placeEscalatorStart', { defaultValue: 'Click the bottom landing of the escalator.' })
        : t('sidePanel.lift.placeEscalatorEnd', {
            defaultValue: 'Click towards the top landing. With “Fit length to incline” on, the length follows the rise.',
          })
    }
    if (stairType === 'elevator') {
      return anchorCount === 0
        ? t('sidePanel.lift.placeElevatorStart', {
            defaultValue: 'Standing in front of the lift, click the left corner of the door side.',
          })
        : t('sidePanel.lift.placeElevatorEnd', {
            defaultValue: 'Click the right corner. The shaft extends back from this line.',
          })
    }
    if (anchorCount === 0) {
      return t('sidePanel.stairPlacementHintStart', {
        defaultValue: 'Click the bottom of the run to begin.',
      })
    }
    if (stairType === 'l' && anchorCount === 1) {
      return t('sidePanel.stairPlacementHintCorner', {
        defaultValue: 'Click the corner where the run turns.',
      })
    }
    return t('sidePanel.stairPlacementHintEnd', {
      defaultValue: 'Click the top of the run to place the stairs.',
    })
  })()
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={Crosshair}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <p className="text-[11px] text-muted-foreground">{placementHint}</p>
          <Button variant="outline" size="sm" className="w-full" onClick={onExit}>
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.stairPlacementExit', { defaultValue: 'Exit stair tool' })}
          </Button>
        </div>
      </Section>
      <StairPropertiesForm
        config={config}
        onChange={onConfigChange}
        unit={'m'}
        runLengthMeters={runLength}
        floors={floors}
      />
    </>
  )
}

function StairSelectedContent({
  stair,
  onConfigChange,
  onRotationChange,
  onStartRotate,
  onStartMove,
  isRotating,
  isMoving,
  defaultConfig,
  onDefaultChange,
  onDelete,
  onDuplicate,
  floors,
  onVerticesChange,
}: {
  floors?: readonly LiftFloorOption[]
  /** Patch the run (escalator length) together with its config. */
  onVerticesChange?: (vertices: [number, number][], config: StairShapeConfig) => void
  stair: StairShape
  onConfigChange: (next: StairShapeConfig) => void
  onRotationChange?: (rotation: number) => void
  onStartRotate?: () => void
  onStartMove?: () => void
  isRotating?: boolean
  isMoving?: boolean
  defaultConfig?: StairShapeConfig
  onDefaultChange?: (next: StairShapeConfig) => void
  onDelete?: () => void
  onDuplicate?: () => void
}) {
  const { t } = useTranslation()
  // Compute the geographic run length so Auto-mode Blondel reflects the
  // real geometry instead of the synthesized stepCount·treadDepth.
  const a = stair.vertices[0]
  const b = stair.vertices[1]
  const METERS_PER_DEG_LAT = 111_320
  const midLat = (a[1] + b[1]) / 2
  const dx = (b[0] - a[0]) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
  const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT
  const runLength = Math.sqrt(dx * dx + dy * dy)
  return (
    <>
      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-3 gap-1.5">
            {onStartMove && (
              <Button
                variant={isMoving ? 'default' : 'outline'}
                size="sm"
                onClick={isMoving ? undefined : onStartMove}
                title={t('sidePanel.move', { defaultValue: 'Move' })}
              >
                <Move className="w-3.5 h-3.5 me-1.5" />
                {t('sidePanel.move', { defaultValue: 'Move' })}
              </Button>
            )}
            {onStartRotate && (
              <Button
                variant={isRotating ? 'default' : 'outline'}
                size="sm"
                onClick={isRotating ? undefined : onStartRotate}
                title={t('sidePanel.rotate', { defaultValue: 'Rotate' })}
              >
                <RotateCw className="w-3.5 h-3.5 me-1.5" />
                {t('sidePanel.rotate', { defaultValue: 'Rotate' })}
              </Button>
            )}
            {onDuplicate && (
              <Button
                variant="outline"
                size="sm"
                onClick={onDuplicate}
                title={t('sidePanel.duplicate')}
              >
                <Copy className="w-3.5 h-3.5 me-1.5" />
                {t('sidePanel.duplicate')}
              </Button>
            )}
            {onDelete && (
              <Button
                variant="outline"
                size="sm"
                className={onDuplicate ? undefined : 'col-span-2'}
                onClick={onDelete}
              >
                <Trash2 className="w-3.5 h-3.5 me-1.5" />
                {t('sidePanel.delete')}
              </Button>
            )}
          </div>
        </div>
      </Section>
      {onRotationChange && (
        <Section title={t('sidePanel.sectionTransform')} icon={RotateCw}>
          <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
            <SliderRow
              label={
                <span className="flex items-center gap-1.5">
                  <RotateCw className="w-3 h-3" />
                  {t('sidePanel.rotation')}
                </span>
              }
              labelExtra={
                <button
                  type="button"
                  onClick={() => onRotationChange(0)}
                  className="font-mono transition-colors text-muted-foreground hover:text-foreground"
                  title={t('sidePanel.rotationReset')}
                >
                  {(stair.rotation ?? 0).toFixed(1).replace(/\.0$/, '')}°
                </button>
              }
              value={stair.rotation ?? 0}
              onChange={(v) => onRotationChange(v)}
              min={-180}
              max={180}
              step={0.5}
              suffix="°"
            />
          </div>
        </Section>
      )}
      <StairPropertiesForm
        config={stair.config}
        onChange={onConfigChange}
        unit={stair.unit}
        runLengthMeters={runLength}
        floors={floors}
        drawnLength={runLength}
        onLengthChange={
          onVerticesChange && runLength > 0.01
            ? (meters) => {
                // Stretch along the drawn direction; the drawn length now
                // decides, so "fit to incline" goes off.
                const k = meters / runLength
                const end: [number, number] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
                onVerticesChange([a, end, ...stair.vertices.slice(2)], { ...stair.config, inclineFit: false })
              }
            : undefined
        }
      />
      {defaultConfig && onDefaultChange && (
        <div className="px-3 text-[10px] text-muted-foreground">
          {t('sidePanel.stairSelectedNote', {
            defaultValue: 'Changes apply to this one only. Use the toolbar to draw another.',
          })}
        </div>
      )}
    </>
  )
}

function LinePlacementContent({
  config,
  unit,
  vertexCount,
  onConfigChange,
  onExit,
}: {
  config: LineShapeConfig
  unit: LengthUnit
  vertexCount: number
  onConfigChange: (next: LineShapeConfig) => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={Crosshair}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <p className="text-[11px] text-muted-foreground">
            {t('sidePanel.linePlacementHint')}
          </p>
          <div className="text-[11px] text-muted-foreground">
            {t('sidePanel.linePlacementVertices', { count: vertexCount })}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onExit}
          >
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.linePlacementExit')}
          </Button>
        </div>
      </Section>
      <LinePropertiesForm
        config={config}
        unit={unit}
        onChange={onConfigChange}
      />
    </>
  )
}

// ---- Line selected panel -------------------------------------------------

function LineSelectedContent({
  line,
  onConfigChange,
  onPatch,
  confirmDelete,
  setConfirmDelete,
  actions,
}: {
  line: LineShape
  onConfigChange: (next: LineShapeConfig) => void
  onPatch?: (patch: Partial<LineShape>) => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const isMoving =
    actions?.lineTransformActive && actions?.lineTransformKind === 'move'
  const isRotating =
    actions?.lineTransformActive && actions?.lineTransformKind === 'rotate'
  const length = lineLengthMeters(line.vertices)
  return (
    <>
      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-3 gap-1.5">
            <Button
              variant={isMoving ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isMoving) actions?.onCancelLineTransform?.()
                else actions?.onStartMoveLine?.(line.id!)
              }}
              title={t('sidePanel.move')}
            >
              <Move className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.move')}
            </Button>
            <Button
              variant={isRotating ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isRotating) actions?.onCancelLineTransform?.()
                else actions?.onStartRotateLine?.(line.id!)
              }}
              title={t('sidePanel.rotate')}
            >
              <RotateCw className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.rotate')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onFitToLineById?.(line.id!)}
              title={t('sidePanel.fit')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
          </div>
          {(isMoving || isRotating) && (
            <p className="text-[11px] text-muted-foreground px-1">
              {isMoving ? t('sidePanel.moveHint') : t('sidePanel.rotateHint')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions?.onDuplicateLine?.(line.id!)}
              title={t('sidePanel.duplicate')}
            >
              <Copy className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.duplicate')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  actions?.onDeleteLineById?.(line.id!)
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
              title={t('sidePanel.delete')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t('sidePanel.confirmDeleteHint')}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() =>
              actions?.onEditShapeData?.({
                kind: 'line',
                shapeId: line.id!,
                shapeName: line.name,
              })
            }
            title={t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          >
            <Boxes className="w-3.5 h-3.5 me-1.5" />
            {t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          </Button>
        </div>
      </Section>

      <LinkedDataBlock kind="line" shapeId={line.id} />

      <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="flex items-center justify-between text-xs">
            <span>{t('sidePanel.lineLength')}</span>
            <span className="font-mono text-muted-foreground">
              {formatLength(length, line.unit)}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground font-mono">
            {t('sidePanel.lineVerticesCount', { count: line.vertices.length })}
          </div>
          <SliderRow
            label={
              <span className="flex items-center gap-1.5">
                <RotateCw className="w-3 h-3" />
                {t('sidePanel.rotation')}
              </span>
            }
            labelExtra={
              <button
                type="button"
                onClick={() => onPatch?.({ rotation: 0 })}
                className="font-mono transition-colors text-muted-foreground hover:text-foreground"
                title={t('sidePanel.rotationReset')}
              >
                {line.rotation.toFixed(1).replace(/\.0$/, '')}°
              </button>
            }
            value={line.rotation}
            onChange={(v) => onPatch?.({ rotation: v })}
            min={-180}
            max={180}
            step={0.5}
            suffix="°"
          />
        </div>
      </Section>

      <LinePropertiesForm
        config={line.config}
        unit={line.unit}
        onChange={onConfigChange}
      />
    </>
  )
}

// ---- Route: config editor (shared by placement + selected panels) --------
// One compact form for the eight route types + the handful of visual
// knobs users can tweak while drawing OR after selection. Placement calls
// it with a mutable draft `RouteShapeConfig`; selection calls it with the
// live shape's config and pipes changes through `onPatch({ config: … })`
// so the change round-trips to the backend.

const ROUTE_TYPES: RouteType[] = [
  'walking',
  'driving',
  'emergency',
  'forklift',
  'accessible',
  'service',
]

function RouteConfigForm({
  config,
  onChange,
}: {
  config: RouteShapeConfig
  onChange: (next: RouteShapeConfig) => void
}) {
  const { t } = useTranslation()
  const effectiveColor = config.color ?? ROUTE_TYPE_COLORS[config.type]
  return (
    <>
      <Section title={t('sidePanel.routeTypeTitle', { defaultValue: 'Route type' })} icon={Route}>
        <div className="grid gap-1.5 p-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm grid-cols-2">
          {ROUTE_TYPES.map((typ) => {
            const active = config.type === typ
            const swatch = ROUTE_TYPE_COLORS[typ]
            return (
              <button
                key={typ}
                type="button"
                onClick={() => onChange({ ...config, type: typ })}
                className={
                  'text-left rounded-md border px-2 py-1.5 text-xs transition-colors flex items-center gap-2 ' +
                  (active
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-background hover:bg-accent/40')
                }
              >
                <span
                  className="inline-block w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: swatch }}
                  aria-hidden="true"
                />
                <span className="capitalize">
                  {t(`route.type.${typ}`, { defaultValue: typ })}
                </span>
              </button>
            )
          })}
        </div>
      </Section>
      <Section title={t('sidePanel.sectionAppearance', { defaultValue: 'Appearance' })} icon={Palette}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.color', { defaultValue: 'Colour' })}
            value={effectiveColor}
            onChange={(hex) => onChange({ ...config, color: hex })}
          />
          <SliderRow
            label={t('sidePanel.opacity', { defaultValue: 'Opacity' })}
            value={config.opacity}
            onChange={(v) => onChange({ ...config, opacity: v })}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
          />
          <SliderRow
            label={t('sidePanel.width', { defaultValue: 'Width' })}
            value={config.width}
            onChange={(v) => onChange({ ...config, width: v })}
            min={1}
            max={12}
            limitMax={LIMIT_STROKE_PX}
            step={0.5}
            suffix="px"
          />
          <div className="grid grid-cols-3 gap-1">
            {(['solid', 'dashed', 'dotted'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onChange({ ...config, dash: d })}
                className={
                  'text-xs rounded-md border px-2 py-1 transition-colors ' +
                  (config.dash === d
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-background hover:bg-accent/40')
                }
              >
                {t(`sidePanel.dash.${d}`, { defaultValue: d })}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">
              {t('sidePanel.routeShowArrows', { defaultValue: 'Direction arrows' })}
            </Label>
            <Switch
              checked={config.showArrows}
              onCheckedChange={(v) => onChange({ ...config, showArrows: v })}
            />
          </div>
          <SliderRow
            label={t('sidePanel.elevation', { defaultValue: 'Elevation' })}
            value={config.elevation}
            onChange={(v) => onChange({ ...config, elevation: v })}
            min={0}
            max={50}
            limitMax={LIMIT_ELEVATION_M}
            step={0.1}
            suffix="m"
            decimals={2}
          />
        </div>
      </Section>
    </>
  )
}

function RouteConfigContent({
  config,
  vertexCount,
  onConfigChange,
  onExit,
  hint,
}: {
  config: RouteShapeConfig
  vertexCount: number
  onConfigChange: (next: RouteShapeConfig) => void
  onExit?: () => void
  hint: string
}) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={Crosshair}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <p className="text-[11px] text-muted-foreground">{hint}</p>
          <div className="text-[11px] text-muted-foreground">
            {t('sidePanel.routePlacementVertices', {
              count: vertexCount,
              defaultValue: '{{count}} waypoint(s) placed',
            })}
          </div>
          {onExit && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onExit}
            >
              <X className="w-3.5 h-3.5 me-2" />
              {t('sidePanel.routePlacementExit', {
                defaultValue: 'Exit route tool',
              })}
            </Button>
          )}
        </div>
      </Section>
      <RouteConfigForm config={config} onChange={onConfigChange} />
    </>
  )
}

function RouteSelectedContent({
  route,
  onPatch,
  confirmDelete,
  setConfirmDelete,
  actions,
}: {
  route: RouteShape
  onPatch?: (patch: Partial<RouteShape>) => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions?.onFitToRouteById?.(route.id!)}
              title={t('sidePanel.fit')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  actions?.onDeleteRouteById?.(route.id!)
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
              title={t('sidePanel.delete')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t('sidePanel.confirmDeleteHint')}
            </p>
          )}
        </div>
      </Section>

      <RouteConfigForm
        config={route.config}
        onChange={(next) => onPatch?.({ config: next })}
      />
    </>
  )
}

// ---- Saved images list ----------------------------------------------------

function SavedImagesContent({
  images,
  selectedImageIds,
  floorPlanOrder,
  actions,
}: {
  images?: ReadonlyArray<ImageShape>
  selectedImageIds?: ReadonlySet<number>
  floorPlanOrder?: ReadonlyArray<number>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)
  // Sort the source list by the persisted floor-plan order (top =
  // default). Images NOT in the order array (freshly uploaded ones,
  // or a legacy warehouse that never customised) fall to the end in
  // stable id order. THEN apply the workspace search filter — sorting
  // before filtering keeps the visible order stable when the user
  // types a partial name.
  const sortedAllImages = useMemo(() => {
    const src = images ?? []
    if (!floorPlanOrder || floorPlanOrder.length === 0) {
      return [...src].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    }
    const rank = new Map<number, number>()
    floorPlanOrder.forEach((id, i) => rank.set(id, i))
    return [...src].sort((a, b) => {
      const ra = a.id !== undefined && rank.has(a.id) ? rank.get(a.id)! : Infinity
      const rb = b.id !== undefined && rank.has(b.id) ? rank.get(b.id)! : Infinity
      if (ra !== rb) return ra - rb
      return (a.id ?? 0) - (b.id ?? 0)
    })
  }, [images, floorPlanOrder])
  const list = sortedAllImages.filter((i) => matchesWorkspaceQuery(i.name, query))
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectImage?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  const canReorder =
    actions?.onReorderFloorPlans !== undefined &&
    sortedAllImages.length > 1 &&
    // Reordering is a no-op while the user is searching — the visible
    // list is filtered and dropping onto row N wouldn't map cleanly to
    // an absolute position in the FULL list. Hide drag affordances so
    // there's no misleading interaction.
    query.trim() === ''
  const commitReorder = (targetId: number) => {
    if (dragId === null || dragId === targetId) return
    const currentIds = sortedAllImages
      .map((img) => img.id)
      .filter((id): id is number => id !== undefined)
    const from = currentIds.indexOf(dragId)
    const to = currentIds.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = [...currentIds]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    actions?.onReorderFloorPlans?.(next)
  }
  return (
    <Section title={t('sidePanel.savedImagesTitle')} icon={ImageIcon}>
      <div className="space-y-1">
        {list.map((img, listIdx) => {
          const id = img.id!
          const isSelected = selectedImageIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          const size = imageBboxSizeMeters(img)
          const isDefault = canReorder && listIdx === 0
          const isDragging = dragId === id
          const isOver = overId === id && dragId !== null && dragId !== id
          return (
            <div
              key={id}
              draggable={canReorder}
              onDragStart={
                canReorder
                  ? (e) => {
                      setDragId(id)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(id))
                    }
                  : undefined
              }
              onDragOver={
                canReorder
                  ? (e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (overId !== id) setOverId(id)
                    }
                  : undefined
              }
              onDragLeave={
                canReorder
                  ? () => {
                      if (overId === id) setOverId(null)
                    }
                  : undefined
              }
              onDrop={
                canReorder
                  ? (e) => {
                      e.preventDefault()
                      commitReorder(id)
                      setDragId(null)
                      setOverId(null)
                    }
                  : undefined
              }
              onDragEnd={
                canReorder
                  ? () => {
                      setDragId(null)
                      setOverId(null)
                    }
                  : undefined
              }
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30',
                isDragging && 'opacity-40',
                isOver && 'border-primary bg-primary/10',
              )}
            >
              {canReorder && (
                <GripVertical
                  className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 cursor-grab"
                  aria-hidden
                />
              )}
              <img
                src={urlForImage(img)}
                alt=""
                className="flex-shrink-0 object-cover w-5 h-5 border rounded-sm"
                aria-hidden="true"
              />
              <InlineNameCell
                name={img.name}
                subtitle={
                  <>
                    #{id} ·{' '}
                    {formatLength(size.width, img.unit, { withSuffix: false })}×
                    {formatLength(size.height, img.unit)}
                    {isDefault && (
                      <span className="ms-1.5 inline-flex items-center px-1 py-px rounded bg-primary/10 text-primary ring-1 ring-primary/15 text-[9px] font-semibold uppercase tracking-[0.1em]">
                        {t('sidePanel.floorPlanDefault', { defaultValue: 'Default' })}
                      </span>
                    )}
                  </>
                }
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenameImage?.(id, next)}
                titleAttr={`#${id} ${img.name}`}
              />
              {/*
                Eye toggle: flips the image's `visible` flag. The route's
                `hiddenFloorPlanIds` memo then cascades the change to
                every shape with `floorPlanId === id`, so hiding the
                ground floor also dims out the racks / markers placed
                on it. Default-true means a brand-new image renders the
                eye-open icon (since `visible` is `true` at save time).
              */}
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  img.visible === false && 'opacity-50',
                )}
                onClick={() =>
                  actions?.onToggleImageVisible?.(id, img.visible === false)
                }
                title={
                  img.visible === false
                    ? t('sidePanel.showLayer', { defaultValue: 'Show' })
                    : t('sidePanel.hideLayer', { defaultValue: 'Hide' })
                }
                aria-label={
                  img.visible === false
                    ? t('sidePanel.showLayer', { defaultValue: 'Show' })
                    : t('sidePanel.hideLayer', { defaultValue: 'Hide' })
                }
              >
                {img.visible === false ? (
                  <EyeOff className="w-3 h-3" />
                ) : (
                  <Eye className="w-3 h-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToImageById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteImageById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () => setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000
                    )
                  }
                }}
                title={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        })}
      </div>
      {canReorder && (
        <p className="text-[10px] text-muted-foreground px-1 mt-2">
          {t('sidePanel.floorPlanReorderHint', {
            defaultValue: 'Drag to reorder. Top of the list is the default in Preview and shared views.',
          })}
        </p>
      )}
    </Section>
  )
}

// ---- Saved 3D models list ------------------------------------------------

/**
 * Lists every placed glTF / GLB model with click-to-select, fit, and
 * delete. Mirrors `SavedMarkersContent` / `SavedImagesContent` — no
 * inline editor here; selection routes to the floating ModelEditor
 * rendered by `create-grids.tsx`.
 */
function SavedModelsContent({
  models,
  selectedModelIds,
  actions,
}: {
  models?: ReadonlyArray<ModelShape>
  selectedModelIds?: ReadonlySet<number>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (models ?? []).filter((m) => matchesWorkspaceQuery(m.name, query))
  const assets = useModelAssets()
  const assetLabelById = useMemo(() => {
    const out = new Map<string, string>()
    for (const a of assets) out.set(a.id, a.label)
    return out
  }, [assets])
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectModel?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section
      title={t('sidePanel.savedModelsTitle', { defaultValue: '3D models' })}
      icon={Box}
    >
      <VirtualList
        items={list}
        keyFor={(m) => m.id!}
        renderItem={(m) => {
          const id = m.id!
          const isSelected = selectedModelIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          const assetId = m.config.modelAssetId
          const assetLabel = assetId ? assetLabelById.get(assetId) : undefined
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30'
              )}
            >
              <Box
                className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <InlineNameCell
                name={m.name}
                subtitle={
                  <span className="truncate">
                    #{id}
                    {assetLabel && assetLabel !== m.name ? ` · ${assetLabel}` : null}
                  </span>
                }
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenameModel?.(id, next)}
                titleAttr={`#${id} ${m.name}`}
              />
              <EyeToggleButton
                visible={m.visible}
                onToggle={(next) => actions?.onToggleModelVisible?.(id, next)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToModelById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteModelById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () =>
                        setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000
                    )
                  }
                }}
                title={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

/**
 * Workspace-sidebar list of every placed image plane. Mirrors
 * `SavedModelsContent` — click-to-select, eye toggle, fit, delete.
 */
function SavedImagePlanesContent({
  imagePlanes,
  selectedImagePlaneIds,
  actions,
}: {
  imagePlanes?: ReadonlyArray<import('@/lib/shapes').ImagePlaneShape>
  selectedImagePlaneIds?: ReadonlySet<number>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (imagePlanes ?? []).filter((p) => matchesWorkspaceQuery(p.name, query))
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectImagePlane?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section
      title={t('sidePanel.savedImagePlanesTitle', { defaultValue: 'Image planes' })}
      icon={Frame}
    >
      <VirtualList
        items={list}
        keyFor={(p) => p.id!}
        renderItem={(p) => {
          const id = p.id!
          const isSelected = selectedImagePlaneIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30'
              )}
            >
              {p.imageUrl ? (
                <img
                  src={p.imageUrl}
                  alt=""
                  className="flex-shrink-0 object-cover w-5 h-5 border rounded-sm bg-muted"
                />
              ) : (
                <Frame
                  className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <InlineNameCell
                name={p.name}
                subtitle={
                  <span>
                    {p.config.width.toFixed(1)} × {p.config.height.toFixed(1)} m
                  </span>
                }
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenameImagePlane?.(id, next)}
                titleAttr={`#${id} ${p.name}`}
              />
              <EyeToggleButton
                visible={p.visible}
                onToggle={(next) => actions?.onToggleImagePlaneVisible?.(id, next)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToImagePlaneById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteImagePlaneById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () =>
                        setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000
                    )
                  }
                }}
                title={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

/**
 * Workspace-sidebar list of every placed stair. Click-to-select +
 * rename + fit + delete, matching the SavedModelsContent layout so the
 * sidebar feels uniform across shape kinds.
 */
function SavedStairsContent({
  stairs,
  selectedStairIds,
  actions,
}: {
  stairs?: ReadonlyArray<StairShape>
  selectedStairIds?: ReadonlySet<number>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (stairs ?? []).filter((s) => matchesWorkspaceQuery(s.name, query))
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectStair?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section
      title={t('sidePanel.savedStairsTitle', { defaultValue: 'Stairs' })}
      icon={Footprints}
    >
      <VirtualList
        items={list}
        keyFor={(s) => s.id!}
        renderItem={(s) => {
          const id = s.id!
          const isSelected = selectedStairIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          const typeLabel = stairTypeLabel(s.config.stairType, t)
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30',
              )}
            >
              <Footprints
                className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <InlineNameCell
                name={s.name}
                subtitle={
                  <span className="font-mono truncate">
                    {typeLabel} ·{' '}
                    {s.config.stairType === 'escalator'
                      ? `${s.config.direction === 'down' ? '↓' : '↑'} ${formatLength(s.config.rise ?? 0, s.unit)}`
                      : s.config.stairType === 'elevator'
                        ? t('sidePanel.lift.stopsCount', {
                            defaultValue: '{{count}} stops',
                            count: (s.config.stops ?? []).length || Math.max(2, Math.floor(s.config.stopCount ?? 2)),
                          })
                        : `${Math.max(1, Math.floor(s.config.stepCount))} ${t('sidePanel.stairStepCount', { defaultValue: 'Steps' }).toLowerCase()}`}
                  </span>
                }
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenameStair?.(id, next)}
                titleAttr={`#${id} ${s.name}`}
              />
              <EyeToggleButton
                visible={s.visible}
                onToggle={(next) => actions?.onToggleStairVisible?.(id, next)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToStairById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onDuplicateStair?.(id)}
                title={t('sidePanel.duplicate', { defaultValue: 'Duplicate' })}
                aria-label={t('sidePanel.duplicate', { defaultValue: 'Duplicate' })}
              >
                <Copy className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                    'bg-destructive text-destructive-foreground hover:bg-destructive/90',
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteStairById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () => setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000,
                    )
                  }
                }}
                title={
                  showConfirm
                    ? t('sidePanel.confirmDelete')
                    : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm
                    ? t('sidePanel.confirmDelete')
                    : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

// ===========================================================================
// Door tool — placement, edit, and saved list components.
//
// Door persistence lives in `@/lib/door/store` (localStorage) rather than the
// shared spatial backend, but the surface here matches the other shape
// sections (props mirror StairPlacementContent / StairSelectedContent /
// SavedStairsContent) so the user-visible UX is identical.
// ===========================================================================

function DoorPropertiesForm({
  config,
  onChange,
  // Opening width is a per-DOOR field (it lives in the vertices, not
  // in `config`). When a door is selected, the parent passes the
  // door's current width + a resize callback that rewrites its
  // vertices. During placement the parent passes the store's
  // `pendingWidthMeters` + its setter so the slider tunes the default
  // for the next-drawn door instead. Absent both, the slider is
  // hidden.
  widthMeters,
  onWidthMetersChange,
}: {
  config: DoorConfig
  onChange: (next: DoorConfig) => void
  widthMeters?: number
  onWidthMetersChange?: (next: number) => void
}) {
  const { t } = useTranslation()
  const update = <K extends keyof DoorConfig>(key: K, value: DoorConfig[K]) =>
    onChange({ ...config, [key]: value })

  return (
    <>
      <Section
        title={t('sidePanel.doorSectionType', { defaultValue: 'Type' })}
        icon={DoorOpen}
      >
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-4 gap-1">
            {(['single', 'double', 'sliding', 'revolving'] as const).map((k) => (
              <Button
                key={k}
                variant={config.kind === k ? 'default' : 'outline'}
                size="sm"
                onClick={() => update('kind', k)}
                className="h-7 px-1 text-[11px] capitalize"
              >
                {t(`sidePanel.doorKind_${k}`, { defaultValue: k })}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1">
            {(['closed', 'ajar', 'open'] as const).map((s) => (
              <Button
                key={s}
                variant={config.state === s ? 'default' : 'outline'}
                size="sm"
                onClick={() => update('state', s)}
                className="h-7 px-1 text-[11px] capitalize"
              >
                {t(`sidePanel.doorState_${s}`, { defaultValue: s })}
              </Button>
            ))}
          </div>
          {(config.kind === 'single' ||
            config.kind === 'double' ||
            config.kind === 'sliding') && (
            <div className="grid grid-cols-2 gap-1">
              {(['left', 'right'] as const).map((h) => (
                <Button
                  key={h}
                  variant={config.hingeSide === h ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => update('hingeSide', h)}
                  className="h-7 px-1 text-[11px] capitalize"
                >
                  {config.kind === 'sliding'
                    ? t(`sidePanel.doorPocket_${h}`, {
                        defaultValue: `Pocket ${h}`,
                      })
                    : t(`sidePanel.doorHinge_${h}`, {
                        defaultValue: `Hinge ${h}`,
                      })}
                </Button>
              ))}
            </div>
          )}
          {config.kind !== 'sliding' && (
            <div className="grid grid-cols-2 gap-1">
              {(['inward', 'outward'] as const).map((d) => (
                <Button
                  key={d}
                  variant={config.swingDirection === d ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => update('swingDirection', d)}
                  className="h-7 px-1 text-[11px] capitalize"
                >
                  {t(`sidePanel.doorSwing_${d}`, { defaultValue: d })}
                </Button>
              ))}
            </div>
          )}
          {config.kind !== 'sliding' && config.kind !== 'revolving' && (
            <SliderRow
              label={t('sidePanel.doorOpenAngle', { defaultValue: 'Open angle' })}
              value={config.openAngle}
              onChange={(v) => update('openAngle', v)}
              min={0}
              max={180}
              step={0.1}
              suffix="°"
            />
          )}
        </div>
      </Section>

      <Section
        title={t('sidePanel.doorSectionDimensions', { defaultValue: 'Dimensions' })}
        icon={Ruler}
      >
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          {widthMeters !== undefined && onWidthMetersChange && (
            <SliderRow
              label={t('sidePanel.doorOpeningWidth', {
                defaultValue: 'Opening width',
              })}
              value={widthMeters}
              onChange={(v) => onWidthMetersChange(v)}
              min={0.2}
              max={6}
              limitMax={LIMIT_DOOR_WIDTH_M}
              step={0.05}
              suffix="m"
              decimals={2}
            />
          )}
          <SliderRow
            label={t('sidePanel.doorHeight', { defaultValue: 'Door height' })}
            value={config.doorHeight}
            onChange={(v) => update('doorHeight', v)}
            min={0.5}
            max={4}
            limitMax={LIMIT_DOOR_HEIGHT_M}
            step={0.05}
            suffix="m"
            decimals={2}
          />
          <SliderRow
            label={t('sidePanel.doorElevation', { defaultValue: 'Elevation' })}
            value={config.elevation}
            onChange={(v) => update('elevation', v)}
            min={0}
            max={20}
            limitMax={LIMIT_ELEVATION_M}
            step={0.1}
            suffix="m"
            decimals={2}
          />
          <SliderRow
            label={t('sidePanel.doorFrameThickness', { defaultValue: 'Frame thickness' })}
            value={config.frameThickness}
            onChange={(v) => update('frameThickness', v)}
            min={0.02}
            max={0.6}
            limitMax={LIMIT_DOOR_FRAME_M}
            step={0.01}
            suffix="m"
            decimals={2}
          />
          <SliderRow
            label={t('sidePanel.doorFrameWidth', { defaultValue: 'Jamb width' })}
            value={config.frameWidth}
            onChange={(v) => update('frameWidth', v)}
            min={0}
            max={0.6}
            limitMax={LIMIT_DOOR_FRAME_M}
            step={0.01}
            suffix="m"
            decimals={2}
          />
          <SliderRow
            label={t('sidePanel.doorLeafThickness', { defaultValue: 'Leaf thickness' })}
            value={config.leafThickness}
            onChange={(v) => update('leafThickness', v)}
            min={0.01}
            max={0.2}
            limitMax={LIMIT_DOOR_LEAF_M}
            step={0.005}
            suffix="m"
            decimals={3}
          />
        </div>
      </Section>

      <Section
        title={t('sidePanel.doorSectionVisibility', { defaultValue: 'Visibility' })}
        icon={Eye}
      >
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="flex items-center justify-between">
            <Label className="text-xs">
              {t('sidePanel.doorShowFrame', { defaultValue: 'Show frame' })}
            </Label>
            <Switch
              checked={config.showFrame}
              onCheckedChange={(v) => update('showFrame', v)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">
              {t('sidePanel.doorShowSwingArc', { defaultValue: 'Show swing arc' })}
            </Label>
            <Switch
              checked={config.showSwingArc}
              onCheckedChange={(v) => update('showSwingArc', v)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">
              {t('sidePanel.doorShowLabel', { defaultValue: 'Show label' })}
            </Label>
            <Switch
              checked={config.showLabels}
              onCheckedChange={(v) => update('showLabels', v)}
            />
          </div>
          {config.showLabels && (
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('sidePanel.doorLabelText', { defaultValue: 'Label text' })}
              </Label>
              <TextField
                value={config.label ?? ''}
                onCommit={(text) => update('label', text)}
                placeholder={t('sidePanel.doorLabelPlaceholder', {
                  defaultValue: '(door name)',
                })}
                className="h-7 text-xs"
              />
            </div>
          )}
        </div>
      </Section>

      <Section
        title={t('sidePanel.doorSectionAppearance', { defaultValue: 'Appearance' })}
        icon={Palette}
      >
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.doorFrameColor', { defaultValue: 'Frame' })}
            value={config.frameColor}
            onChange={(v) => update('frameColor', v)}
          />
          <ColorRow
            label={t('sidePanel.doorLeafColor', { defaultValue: 'Leaf' })}
            value={config.leafColor}
            onChange={(v) => update('leafColor', v)}
          />
          <ColorRow
            label={t('sidePanel.doorArcColor', { defaultValue: 'Swing arc' })}
            value={config.arcColor}
            onChange={(v) => update('arcColor', v)}
          />
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
          />
        </div>
      </Section>
    </>
  )
}

function DoorPlacementContent({
  config,
  onConfigChange,
  anchorCount,
  onExit,
  // Default opening width for the next-drawn door. Feeds the same
  // slider that a selected door uses; here it edits the placement
  // default (stored on the door store) instead of a specific door's
  // vertices. Free 2-click placement still derives width from the
  // click points, so the slider only shapes the wall-snap commit +
  // cursor ghost preview.
  widthMeters,
  onWidthMetersChange,
}: {
  config: DoorConfig
  onConfigChange: (next: DoorConfig) => void
  anchorCount: number
  onExit?: () => void
  widthMeters?: number
  onWidthMetersChange?: (next: number) => void
}) {
  const { t } = useTranslation()
  const hint =
    anchorCount === 0
      ? t('sidePanel.doorPlacementHintStart', {
          defaultValue: 'Click the map to place the first jamb.',
        })
      : t('sidePanel.doorPlacementHintEnd', {
          defaultValue: 'Click the opposite jamb to commit the opening.',
        })
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={Crosshair}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <p className="text-[11px] text-muted-foreground">{hint}</p>
          <Button variant="outline" size="sm" className="w-full" onClick={onExit}>
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.doorPlacementExit', { defaultValue: 'Exit door tool' })}
          </Button>
        </div>
      </Section>
      <DoorPropertiesForm
        config={config}
        onChange={onConfigChange}
        widthMeters={widthMeters}
        onWidthMetersChange={onWidthMetersChange}
      />
    </>
  )
}

function DoorSelectedContent({
  door,
  onConfigChange,
  onVerticesChange,
  onDuplicate,
  onFit,
  defaultConfig,
  onDefaultChange,
  onDelete,
  actions,
}: {
  door: DoorShape
  onConfigChange: (next: DoorConfig) => void
  /** Vertex writes — used by the opening-width slider + transform buttons. */
  onVerticesChange?: (next: [[number, number], [number, number]]) => void
  onDuplicate?: () => void
  onFit?: () => void
  defaultConfig?: DoorConfig
  onDefaultChange?: (next: DoorConfig) => void
  onDelete?: () => void
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const widthM = doorWidthMeters(door.vertices)
  const isMoving =
    actions?.doorTransformActive && actions?.doorTransformKind === 'move'
  const isRotating =
    actions?.doorTransformActive && actions?.doorTransformKind === 'rotate'
  const isScaling =
    actions?.doorTransformActive && actions?.doorTransformKind === 'scale'
  const NUDGE_M = 0.25
  const ROTATE_DEG = 15
  const SCALE_PCT = 1.1
  // Move in the door's LOCAL frame so the arrows match the wall the
  // door is sitting on, not the basemap's compass. "Along" follows the
  // opening direction (v0 → v1); "perp" is the swing-in side.
  const moveAlong = (alongM: number) =>
    onVerticesChange?.(nudgeDoorVerticesLocal(door.vertices, alongM, 0))
  const movePerp = (perpM: number) =>
    onVerticesChange?.(nudgeDoorVerticesLocal(door.vertices, 0, perpM))
  const rotate = (deg: number) =>
    onVerticesChange?.(rotateDoorVertices(door.vertices, deg))
  const scale = (factor: number) =>
    onVerticesChange?.(
      resizeDoorVertices(door.vertices, Math.max(0.05, widthM * factor)),
    )
  return (
    <>
      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          {/*
           * Top-row interactive transforms — clicking the button spawns
           * an orange drag handle on the map (same UX as the image
           * tool). Buttons highlight while the corresponding drag is
           * active and cancel it on a second click.
           */}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant={isMoving ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isMoving) actions?.onCancelDoorTransform?.()
                else actions?.onStartMoveDoor?.(door.id)
              }}
              title={t('sidePanel.move', { defaultValue: 'Move' })}
            >
              <Move className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.move', { defaultValue: 'Move' })}
            </Button>
            <Button
              variant={isRotating ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isRotating) actions?.onCancelDoorTransform?.()
                else actions?.onStartRotateDoor?.(door.id)
              }}
              title={t('sidePanel.rotate', { defaultValue: 'Rotate' })}
            >
              <RotateCw className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.rotate', { defaultValue: 'Rotate' })}
            </Button>
            <Button
              variant={isScaling ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isScaling) actions?.onCancelDoorTransform?.()
                else actions?.onStartScaleDoor?.(door.id)
              }}
              title={t('sidePanel.scale', { defaultValue: 'Scale' })}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.scale', { defaultValue: 'Scale' })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onFit}
              title={t('sidePanel.fit', { defaultValue: 'Fit' })}
              disabled={!onFit}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit', { defaultValue: 'Fit' })}
            </Button>
          </div>
          {(isMoving || isRotating || isScaling) && (
            <p className="text-[11px] text-muted-foreground px-1">
              {isMoving
                ? t('sidePanel.moveHint', {
                    defaultValue: 'Drag the orange dot on the map to move the door.',
                  })
                : isRotating
                  ? t('sidePanel.rotateHint', {
                      defaultValue: 'Drag the orange dot around the door to rotate it.',
                    })
                  : t('sidePanel.doorScaleHint', {
                      defaultValue: 'Drag the orange dot to resize the opening. Press Esc to cancel.',
                    })}
            </p>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={onDuplicate}
              disabled={!onDuplicate}
              title={t('sidePanel.duplicate', { defaultValue: 'Duplicate' })}
            >
              <Copy className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.duplicate', { defaultValue: 'Duplicate' })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-danger hover:bg-danger/10"
              onClick={onDelete}
              disabled={!onDelete}
              title={t('sidePanel.delete')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.delete')}
            </Button>
          </div>

          {/*
           * Below the primary actions: precision nudges (keyboard-style
           * arrows) and rotate / scale buttons in the door's LOCAL
           * frame. These complement the on-map drag handle for users
           * who want exact 0.25 m / 15° / 10% steps.
           */}
          {onVerticesChange && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">
                {t('sidePanel.doorMove', {
                  defaultValue: 'Nudge (along the wall, not the map)',
                })}
              </div>
              <div className="grid grid-cols-3 gap-1">
                <div />
                <Button variant="outline" size="sm" className="h-7" onClick={() => movePerp(NUDGE_M)} title={t('sidePanel.doorMoveInto', { defaultValue: 'Into the room' })}>↑</Button>
                <div />
                <Button variant="outline" size="sm" className="h-7" onClick={() => moveAlong(-NUDGE_M)} title={t('sidePanel.doorMoveAlongBack', { defaultValue: 'Slide back along wall' })}>←</Button>
                <div className="flex items-center justify-center text-[10px] font-mono text-muted-foreground">{NUDGE_M}m</div>
                <Button variant="outline" size="sm" className="h-7" onClick={() => moveAlong(NUDGE_M)} title={t('sidePanel.doorMoveAlongFwd', { defaultValue: 'Slide forward along wall' })}>→</Button>
                <div />
                <Button variant="outline" size="sm" className="h-7" onClick={() => movePerp(-NUDGE_M)} title={t('sidePanel.doorMoveOut', { defaultValue: 'Out of the room' })}>↓</Button>
                <div />
              </div>
              <div className="grid grid-cols-2 gap-1">
                <Button variant="outline" size="sm" className="h-7" onClick={() => rotate(ROTATE_DEG)}>
                  <RotateCcw className="w-3.5 h-3.5 me-1" />
                  -15°
                </Button>
                <Button variant="outline" size="sm" className="h-7" onClick={() => rotate(-ROTATE_DEG)}>
                  <RotateCw className="w-3.5 h-3.5 me-1" />
                  +15°
                </Button>
                <Button variant="outline" size="sm" className="h-7" onClick={() => scale(1 / SCALE_PCT)}>
                  <Minus className="w-3.5 h-3.5 me-1" />
                  10%
                </Button>
                <Button variant="outline" size="sm" className="h-7" onClick={() => scale(SCALE_PCT)}>
                  <Plus className="w-3.5 h-3.5 me-1" />
                  10%
                </Button>
              </div>
            </>
          )}
        </div>
      </Section>
      <DoorPropertiesForm
        config={door.config}
        onChange={onConfigChange}
        widthMeters={onVerticesChange ? widthM : undefined}
        onWidthMetersChange={
          onVerticesChange
            ? (w) => onVerticesChange(resizeDoorVertices(door.vertices, w))
            : undefined
        }
      />
      {defaultConfig && onDefaultChange && (
        <div className="px-3 text-[10px] text-muted-foreground">
          {t('sidePanel.doorSelectedNote', {
            defaultValue:
              'Changes apply to this door only. Use the toolbar to draw another.',
          })}
        </div>
      )}
    </>
  )
}

/**
 * Workspace-sidebar list of every placed door. Mirrors SavedStairsContent —
 * click-to-select, rename inline, fit, delete.
 */
function SavedDoorsContent({
  doors,
  selectedDoorIds,
  actions,
}: {
  doors?: ReadonlyArray<DoorShape>
  selectedDoorIds?: ReadonlySet<number>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (doors ?? []).filter((d) => matchesWorkspaceQuery(d.name, query))
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectDoor?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section
      title={t('sidePanel.savedDoorsTitle', { defaultValue: 'Doors' })}
      icon={DoorOpen}
    >
      <VirtualList
        items={list}
        keyFor={(d) => d.id}
        renderItem={(d) => {
          const id = d.id
          const isSelected = selectedDoorIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          const kindLabel =
            d.config.kind === 'double'
              ? t('sidePanel.doorKindDouble', { defaultValue: 'Double' })
              : d.config.kind === 'sliding'
                ? t('sidePanel.doorKindSliding', { defaultValue: 'Sliding' })
                : d.config.kind === 'revolving'
                  ? t('sidePanel.doorKindRevolving', { defaultValue: 'Revolving' })
                  : t('sidePanel.doorKindSingle', { defaultValue: 'Single' })
          const stateLabel =
            d.config.state === 'closed'
              ? t('sidePanel.doorState_closed', { defaultValue: 'Closed' })
              : d.config.state === 'ajar'
                ? t('sidePanel.doorState_ajar', { defaultValue: 'Ajar' })
                : t('sidePanel.doorState_open', { defaultValue: 'Open' })
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30',
              )}
            >
              <DoorOpen
                className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <InlineNameCell
                name={d.name}
                subtitle={
                  <span className="font-mono truncate">
                    {kindLabel} · {stateLabel}
                  </span>
                }
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenameDoor?.(id, next)}
                titleAttr={`#${id} ${d.name}`}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToDoorById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onSetDoorVisible?.(id, !d.visible)}
                title={
                  d.visible
                    ? t('sidePanel.hide', { defaultValue: 'Hide' })
                    : t('sidePanel.show', { defaultValue: 'Show' })
                }
                aria-label={
                  d.visible
                    ? t('sidePanel.hide', { defaultValue: 'Hide' })
                    : t('sidePanel.show', { defaultValue: 'Show' })
                }
              >
                {d.visible ? (
                  <Eye className="w-3 h-3" />
                ) : (
                  <EyeOff className="w-3 h-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onDuplicateDoor?.(id)}
                title={t('sidePanel.duplicate', { defaultValue: 'Duplicate' })}
                aria-label={t('sidePanel.duplicate', { defaultValue: 'Duplicate' })}
              >
                <Copy className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                    'bg-destructive text-destructive-foreground hover:bg-destructive/90',
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteDoorById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () => setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000,
                    )
                  }
                }}
                title={
                  showConfirm
                    ? t('sidePanel.confirmDelete')
                    : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm
                    ? t('sidePanel.confirmDelete')
                    : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

// ---- Shared image appearance + label form --------------------------------

/**
 * Four sliders that trim inward from each edge of the floor-plan image
 * as a percentage of the full image. Emits `undefined` when everything
 * is zero so the shape's config stays clean; existing rows without a
 * crop don't grow a config field until the user actually crops.
 *
 * The math clamp is deliberately mild — 95% max per edge, with the
 * on-map raster path treating any pair whose sum reaches 100 as "no
 * crop" (see `effectiveImageCrop`). That keeps a mis-drag from
 * silently collapsing the image to nothing.
 */
function ImageCropSection({
  crop,
  onChange,
}: {
  crop: ImageCrop | undefined
  onChange: (next: ImageCrop | undefined) => void
}) {
  const { t } = useTranslation()
  const value: ImageCrop = crop ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const anyCrop =
    value.top > 0 || value.right > 0 || value.bottom > 0 || value.left > 0

  const setEdge = (edge: keyof ImageCrop, raw: number) => {
    // Clamp against the opposite edge — top + bottom < 100 and
    // left + right < 100 — so the crop never collapses the visible
    // rectangle to zero area.
    const other =
      edge === 'top' ? value.bottom
        : edge === 'bottom' ? value.top
          : edge === 'left' ? value.right
            : value.left
    const max = Math.max(0, 95 - other)
    const clamped = Math.max(0, Math.min(max, Math.round(raw)))
    const next: ImageCrop = { ...value, [edge]: clamped }
    const clean =
      next.top === 0 && next.right === 0 && next.bottom === 0 && next.left === 0
        ? undefined
        : next
    onChange(clean)
  }

  const edges: Array<{ key: keyof ImageCrop; labelKey: string }> = [
    { key: 'top', labelKey: 'sidePanel.imageCropTop' },
    { key: 'right', labelKey: 'sidePanel.imageCropRight' },
    { key: 'bottom', labelKey: 'sidePanel.imageCropBottom' },
    { key: 'left', labelKey: 'sidePanel.imageCropLeft' },
  ]

  return (
    <Section title={t('sidePanel.sectionCrop', { defaultValue: 'Crop' })} icon={Crop}>
      <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
        <p className="text-[11px] text-muted-foreground">
          {t('sidePanel.imageCropHint', {
            defaultValue:
              'Trim from each edge as a percentage of the full image. Non-destructive — the original file is preserved.',
          })}
        </p>
        {edges.map(({ key, labelKey }) => (
          <SliderRow
            key={key}
            label={t(labelKey, { defaultValue: key })}
            value={value[key]}
            onChange={(v) => setEdge(key, v)}
            min={0}
            max={95}
            step={0.1}
            suffix="%"
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!anyCrop}
          onClick={() => onChange(undefined)}
          title={t('sidePanel.imageCropReset', { defaultValue: 'Reset crop' })}
        >
          <RotateCcw className="w-3.5 h-3.5 me-1.5" />
          {t('sidePanel.imageCropReset', { defaultValue: 'Reset crop' })}
        </Button>
      </div>
    </Section>
  )
}

function ImagePropertiesForm({
  config,
  unit,
  onChange,
}: {
  config: ImageShapeConfig
  /** Active display unit — drives the elevation input's auto-conversion. */
  unit: LengthUnit
  onChange: (next: ImageShapeConfig) => void
}) {
  const { t } = useTranslation()
  const update = <K extends keyof ImageShapeConfig>(
    key: K,
    value: ImageShapeConfig[K]
  ) => onChange({ ...config, [key]: value })
  const positions: MarkerLabelPosition[] = ['top', 'right', 'bottom', 'left']
  // `elevation` is optional + backfilled to 0 on boot, but newly-typed
  // floor plans built from `DEFAULT_IMAGE_CONFIG` may still surface
  // `undefined` here during the first render after schema bump — coalesce.
  const elevationM = config.elevation ?? 0

  return (
    <>
      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
          />
        </div>
      </Section>

      {/*
        3D section — only `elevation` for images (a flat plan has no
        extrusion height of its own). The floor-plan layer draws the
        image at exactly this altitude, so floor-plan images stack
        visually at the right height for each floor.
      */}
      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.elevation')}</span>
              <span className="font-mono text-muted-foreground">
                {elevationM === 0
                  ? t('sidePanel.flat', { defaultValue: 'flat' })
                  : formatLength(elevationM, unit)}
              </span>
            </Label>
            <NumberInput
              value={elevationM}
              unit={unit}
              min={0}
              max={LIMIT_ELEVATION_M}
              onChange={(meters) => update('elevation', Math.max(0, meters))}
              ariaLabel={t('sidePanel.elevation')}
            />
            <StretchSlider
              value={elevationM}
              onValueChange={(v) => update('elevation', v)}
              min={0}
              max={500}
              limitMax={LIMIT_ELEVATION_M}
              step={0.1}
            />
          </div>
        </div>
      </Section>

      <ImageCropSection
        crop={config.crop}
        onChange={(next) => update('crop', next)}
      />

      <Section title={t('sidePanel.imageClipTitle', { defaultValue: 'Outside the building' })} icon={EyeOff}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium">
                {t('sidePanel.imageClipToWalls', { defaultValue: 'Hide outside walls' })}
              </div>
              <div className="text-[10px] text-muted-foreground leading-tight">
                {t('sidePanel.imageClipToWallsHint', {
                  defaultValue:
                    'Hides the sheet margin, title block and dimensions around the outer walls of this floor. Draw the outer walls first. The image itself is not changed.',
                })}
              </div>
            </div>
            <Switch
              checked={config.clipToWalls === true}
              onCheckedChange={(v) => update('clipToWalls', v)}
              aria-label={t('sidePanel.imageClipToWalls', { defaultValue: 'Hide outside walls' })}
            />
          </div>
          {config.clipToWalls === true && (
            <SliderRow
              label={t('sidePanel.imageClipMargin', { defaultValue: 'Margin around walls' })}
              value={config.clipMargin ?? 0.5}
              onChange={(v) => update('clipMargin', Math.max(0, v))}
              min={0}
              max={5}
              step={0.1}
              suffix="m"
            />
          )}
        </div>
      </Section>

      <Section title={t('sidePanel.sectionLabels')} icon={Type}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('sidePanel.imageLabel')}</Label>
            <TextField
              value={config.label}
              onCommit={(text) => {
                onChange({
                  ...config,
                  label: text,
                  showLabels: text.trim() !== '',
                })
              }}
              placeholder={t('sidePanel.imageLabelPlaceholder')}
              className="h-8 text-sm"
            />
          </div>
          {config.label.trim() !== '' && (
            <>
              <ColorRow
                label={t('sidePanel.labelColor')}
                value={config.labelColor}
                onChange={(v) => update('labelColor', v)}
              />
              <SliderRow
                label={t('sidePanel.labelSize')}
                value={config.labelSize}
                onChange={(v) => update('labelSize', v)}
                min={8}
                max={32}
                limitMax={LIMIT_SYMBOL_SIZE_PX}
                step={0.1}
                suffix="px"
              />
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('sidePanel.imageLabelPosition')}
                </Label>
                <div className="grid grid-cols-4 gap-1.5">
                  {positions.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => update('labelPosition', p)}
                      className={cn(
                        'py-1.5 rounded-md border text-xs capitalize transition-colors',
                        config.labelPosition === p
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-accent'
                      )}
                    >
                      {t(`sidePanel.imageLabelPos_${p}`)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </Section>

      <TooltipTriggerSection
        value={config.tooltipTrigger}
        onChange={(v) => update('tooltipTrigger', v)}
      />
    </>
  )
}

// ---- Image upload box (used by placement panel) --------------------------

function ImageUploadBox({
  draft,
  zoneId,
  onPickFile,
  onPickLibrary,
  onClearDraft,
}: {
  draft: SidePanelProps['imageDraft']
  zoneId: number | null
  onPickFile?: (file: File) => void
  onPickLibrary?: (item: LibraryImage) => void
  onClearDraft?: () => void
}) {
  const { t } = useTranslation()
  const library = useImageLibrary()
  // Open on the library once the workspace has uploads to reuse.
  const [source, setSource] = useState<'library' | 'upload' | null>(null)
  const resolvedSource = source ?? ((library.data?.length ?? 0) > 0 ? 'library' : 'upload')
  return (
    <div className="space-y-2">
      {draft ? (
        <div className="flex items-center gap-2 p-2 border rounded-md bg-background/70">
          <img
            src={draft.dataUrl}
            alt=""
            className="flex-shrink-0 object-cover w-12 h-12 border rounded-sm"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              {draft.sourceKind === 'pdf' && (
                <span
                  className="inline-flex items-center gap-1 px-1 py-px rounded-sm text-[9px] font-semibold uppercase tracking-wide bg-primary/10 text-primary flex-shrink-0"
                  title={t('sidePanel.imageFromPdfTitle')}
                >
                  <FileText className="w-2.5 h-2.5" />
                  PDF
                </span>
              )}
              {draft.sourceKind === 'dwg' && (
                <span
                  className="inline-flex items-center gap-1 px-1 py-px rounded-sm text-[9px] font-semibold uppercase tracking-wide bg-primary/10 text-primary flex-shrink-0"
                  title={t('sidePanel.imageFromCadTitle', {
                    defaultValue: 'Rendered from a CAD drawing',
                  })}
                >
                  <Scan className="w-2.5 h-2.5" />
                  DWG
                </span>
              )}
              <span className="text-xs font-medium truncate">
                {draft.fileName}
              </span>
            </div>
            <div
              dir="ltr"
              className="text-[10px] text-muted-foreground font-mono"
            >
              {draft.naturalWidth}×{draft.naturalHeight}px
              {draft.scaleDenominator
                ? ` · 1:${Math.round(draft.scaleDenominator)}`
                : ''}
            </div>
            {/* The two states differ in how the next map drag behaves, so
                they get distinct copy rather than a shared caption. */}
            {draft.realWidthMeters && draft.realHeightMeters ? (
              <div dir="ltr" className="text-[10px] text-primary font-mono">
                {t('sidePanel.imageScaledSize', {
                  width: draft.realWidthMeters.toFixed(1),
                  height: draft.realHeightMeters.toFixed(1),
                })}
              </div>
            ) : draft.sourceKind === 'pdf' ? (
              <div className="text-[10px] text-muted-foreground">
                {t('sidePanel.imageNoScale')}
              </div>
            ) : null}
          </div>
          {draft.pendingUpload && (
            <span className="flex flex-shrink-0 items-center gap-1 text-[10px] text-muted-foreground" role="status">
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
              {t('library.uploading', { defaultValue: 'Uploading…' })}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClearDraft}
            title={t('library.chooseAnother', { defaultValue: 'Choose another image' })}
            aria-label={t('library.chooseAnother', { defaultValue: 'Choose another image' })}
            className="flex-shrink-0 h-7 w-7"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      ) : (
        <>
          <LibrarySourceTabs value={resolvedSource} onChange={setSource} />
          {resolvedSource === 'library' ? (
            <ImageLibraryPicker
              zoneId={zoneId}
              selectedKey={null}
              onSelect={(item) => onPickLibrary?.(item)}
              onUploadInstead={() => setSource('upload')}
              columnsClassName="grid-cols-2"
            />
          ) : (
            <UploadDropzone
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.dwg"
              onFile={(file) => onPickFile?.(file)}
              title={t('library.dropFloorPlan', { defaultValue: 'Drop a floor plan here' })}
              hint={t('sidePanel.imageUploadHint')}
            />
          )}
        </>
      )}
    </div>
  )
}

// ---- Image placement panel ----------------------------------------------

function ImagePlacementContent({
  config,
  unit,
  draft,
  zoneId,
  onConfigChange,
  onPickFile,
  onPickLibrary,
  onClearDraft,
  onExit,
}: {
  config: ImageShapeConfig
  /** Active display unit — passed through to the properties form's
   *  elevation control. */
  unit: LengthUnit
  draft: SidePanelProps['imageDraft']
  zoneId: number | null
  onConfigChange: (next: ImageShapeConfig) => void
  onPickFile?: (file: File) => void
  onPickLibrary?: (item: LibraryImage) => void
  onClearDraft?: () => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={Crosshair}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ImageUploadBox
            draft={draft}
            zoneId={zoneId}
            onPickFile={onPickFile}
            onPickLibrary={onPickLibrary}
            onClearDraft={onClearDraft}
          />
          {/* A scaled sheet already knows its ground size, so the drag
              only picks position — telling the user to "drag the bounds"
              would make the snap look like the tool ignored them. */}
          <p className="text-[11px] text-muted-foreground">
            {draft?.realWidthMeters && draft?.realHeightMeters
              ? t('sidePanel.imagePlacementHintScaled')
              : t('sidePanel.imagePlacementHint')}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onExit}
          >
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.imagePlacementExit')}
          </Button>
        </div>
      </Section>
      <ImagePropertiesForm config={config} unit={unit} onChange={onConfigChange} />
    </>
  )
}

// ---- Image selected panel -----------------------------------------------

function ImageSelectedContent({
  image,
  onConfigChange,
  onPatch,
  confirmDelete,
  setConfirmDelete,
  actions,
}: {
  image: ImageShape
  onConfigChange: (next: ImageShapeConfig) => void
  onPatch?: (patch: Partial<ImageShape>) => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const isMoving =
    actions?.imageTransformActive && actions?.imageTransformKind === 'move'
  const isRotating =
    actions?.imageTransformActive && actions?.imageTransformKind === 'rotate'
  const isScaling =
    actions?.imageTransformActive && actions?.imageTransformKind === 'scale'
  const size = imageBboxSizeMeters(image)
  const center = imageBboxCenter(image)

  // Scale slider state. The slider scales the bbox proportionally around
  // its center, snapshotting the bbox at drag start so the math stays
  // idempotent during the drag (re-applying 150% from the same baseline
  // lands on the same corners regardless of intermediate frames). State
  // is reset across selections by the `key={image.id}` at the call site.
  const [scalePct, setScalePct] = useState(100)
  const baselineRef = useRef<{
    start: [number, number]
    current: [number, number]
  } | null>(null)

  const [lockAspect, setLockAspect] = useState(true)
  const [replaceOpen, setReplaceOpen] = useState(false)

  const onScaleChange = (pct: number) => {
    if (!baselineRef.current) {
      baselineRef.current = { start: image.start, current: image.current }
    }
    setScalePct(pct)
    const next = scaleImageBbox(baselineRef.current, pct / 100)
    if (next) onPatch?.(next)
  }
  const onScaleCommit = () => {
    setScalePct(100)
    baselineRef.current = null
  }

  const onWidthChange = (meters: number) => {
    if (meters <= 0) return
    if (lockAspect && size.width > 1e-9) {
      const factor = meters / size.width
      const next = scaleImageBbox(image, factor)
      if (next) onPatch?.(next)
      return
    }
    const next = resizeImageBboxWidthMeters(image, meters)
    if (next) onPatch?.(next)
  }
  const onHeightChange = (meters: number) => {
    if (meters <= 0) return
    if (lockAspect && size.height > 1e-9) {
      const factor = meters / size.height
      const next = scaleImageBbox(image, factor)
      if (next) onPatch?.(next)
      return
    }
    const next = resizeImageBboxHeightMeters(image, meters)
    if (next) onPatch?.(next)
  }
  return (
    <>
      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant={isMoving ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isMoving) actions?.onCancelImageTransform?.()
                else actions?.onStartMoveImage?.(image.id!)
              }}
              title={t('sidePanel.move')}
            >
              <Move className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.move')}
            </Button>
            <Button
              variant={isRotating ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isRotating) actions?.onCancelImageTransform?.()
                else actions?.onStartRotateImage?.(image.id!)
              }}
              title={t('sidePanel.rotate')}
            >
              <RotateCw className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.rotate')}
            </Button>
            <Button
              variant={isScaling ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isScaling) actions?.onCancelImageTransform?.()
                else actions?.onStartScaleImage?.(image.id!)
              }}
              title={t('sidePanel.scale')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.scale')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onFitToImageById?.(image.id!)}
              title={t('sidePanel.fit')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
          </div>
          {(isMoving || isRotating || isScaling) && (
            <p className="text-[11px] text-muted-foreground px-1">
              {isMoving
                ? t('sidePanel.moveHint')
                : isRotating
                  ? t('sidePanel.rotateHint')
                  : t('sidePanel.scaleHint')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions?.onDuplicateImage?.(image.id!)}
              title={t('sidePanel.duplicate')}
            >
              <Copy className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.duplicate')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  actions?.onDeleteImageById?.(image.id!)
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
              title={t('sidePanel.delete')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t('sidePanel.confirmDeleteHint')}
            </p>
          )}
          {actions?.onReplaceImageFile && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setReplaceOpen(true)}>
              <Replace className="w-3.5 h-3.5 me-1.5" />
              {t('library.replaceImage', { defaultValue: 'Replace image' })}
            </Button>
          )}
          {replaceOpen && (
            <ImageLibraryDialog
              open={replaceOpen}
              onOpenChange={setReplaceOpen}
              title={t('library.replaceTitle', { defaultValue: 'Replace floor plan image' })}
              description={t('library.replaceBody', { defaultValue: 'Pick an image this workspace already uploaded, or upload a new one. Position and size stay the same.' })}
              confirmLabel={t('library.replaceConfirm', { defaultValue: 'Use this image' })}
              zoneId={image.zoneId ?? null}
              onPick={(item) => actions?.onReplaceImageFile?.(image.id!, item)}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() =>
              actions?.onEditShapeData?.({
                kind: 'image',
                shapeId: image.id!,
                shapeName: image.name,
              })
            }
            title={t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          >
            <Boxes className="w-3.5 h-3.5 me-1.5" />
            {t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          </Button>
        </div>
      </Section>

      <LinkedDataBlock kind="image" shapeId={image.id} />

      <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-2">
            <NumberInput
              label={
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('sidePanel.imageWidth')}
                </Label>
              }
              value={size.width}
              unit={image.unit}
              min={0.01}
              onChange={onWidthChange}
            />
            <NumberInput
              label={
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('sidePanel.imageHeight')}
                </Label>
              }
              value={size.height}
              unit={image.unit}
              min={0.01}
              onChange={onHeightChange}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs flex items-center gap-1.5">
              <Lock className="w-3 h-3" />
              {t('sidePanel.imageLockAspect')}
            </Label>
            <Switch checked={lockAspect} onCheckedChange={setLockAspect} />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <Maximize2 className="w-3 h-3" />
                {t('sidePanel.imageScale')}
              </span>
              <button
                type="button"
                onClick={() => onScaleChange(100)}
                className="font-mono transition-colors text-muted-foreground hover:text-foreground"
                title={t('sidePanel.imageScaleReset')}
              >
                {scalePct.toFixed(0)}%
              </button>
            </Label>
            <Slider
              value={[scalePct]}
              onValueChange={(v) => onScaleChange(v[0])}
              onValueCommit={onScaleCommit}
              min={10}
              max={500}
              step={0.1}
            />
          </div>
          <SliderRow
            label={
              <span className="flex items-center gap-1.5">
                <RotateCw className="w-3 h-3" />
                {t('sidePanel.rotation')}
              </span>
            }
            labelExtra={
              <button
                type="button"
                onClick={() => onPatch?.({ rotation: 0 })}
                className="font-mono transition-colors text-muted-foreground hover:text-foreground"
                title={t('sidePanel.rotationReset')}
              >
                {image.rotation.toFixed(1).replace(/\.0$/, '')}°
              </button>
            }
            value={image.rotation}
            onChange={(v) => onPatch?.({ rotation: v })}
            min={-180}
            max={180}
            step={0.5}
            suffix="°"
          />
        </div>
      </Section>

      <ImagePropertiesForm
        config={image.config}
        unit={image.unit}
        onChange={onConfigChange}
      />

      {center && (
        <Section title={t('sidePanel.imagePosition')} icon={MapPin}>
          <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('sidePanel.imageLat')}
                </Label>
                <div className="mt-1 font-mono text-xs">
                  {center[1].toFixed(6)}
                </div>
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('sidePanel.imageLng')}
                </Label>
                <div className="mt-1 font-mono text-xs">
                  {center[0].toFixed(6)}
                </div>
              </div>
            </div>
          </div>
        </Section>
      )}
    </>
  )
}

// ---- Bulk content (for multi-select editors) ----------------------------
// All bulk panels now use BulkHeader (count + fit + delete) plus per-kind
// edit sections. The earlier BulkNonGridContent (delete-only) was removed
// once edit was added to every kind.

/**
 * Bulk-edit panel for FillShapeConfig (polygon, circle). Renders the
 * fields most users want to change in bulk — color, border, opacity,
 * elevation, height, labels — and fans every change to the parent's
 * `onPatchAll` callback as a partial config patch.
 *
 * When the selected shapes disagree on a field, the row marks itself as
 * "Mixed" so the user can see they're about to override the difference.
 * The input still seeds with the first shape's value so the user has a
 * sensible starting point.
 */
function BulkFillShapeContent({
  shapes,
  countKey,
  confirmDeleteAllKey,
  confirmDelete,
  setConfirmDelete,
  onDeleteAll,
  onFitAll,
  onPatchAll,
}: {
  shapes: ReadonlyArray<{ config: FillShapeConfig }>
  countKey: string
  confirmDeleteAllKey: string
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDeleteAll?: () => void
  onFitAll?: () => void
  onPatchAll?: (patch: Partial<FillShapeConfig>) => void
}) {
  const { t } = useTranslation()
  const count = shapes.length
  const color = sharedValue(shapes, (s) => s.config.color)
  const borderColor = sharedValue(shapes, (s) => s.config.borderColor)
  const borderWidth = sharedValue(shapes, (s) => s.config.borderWidth)
  const opacity = sharedValue(shapes, (s) => s.config.opacity)
  const elevation = sharedValue(shapes, (s) => s.config.elevation)
  const height = sharedValue(shapes, (s) => s.config.height)
  const receiveShadows = sharedValue(shapes, (s) => s.config.receiveShadows ?? true)
  const showLabels = sharedValue(shapes, (s) => s.config.showLabels)
  return (
    <>
      <Section title={t(countKey, { count })} icon={Boxes}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => onFitAll?.()}>
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  onDeleteAll?.()
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.deleteAll')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t(confirmDeleteAllKey, { count })}
            </p>
          )}
        </div>
      </Section>

      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkColorRow
            label={t('sidePanel.fillColor', { defaultValue: 'Fill' })}
            value={color.value ?? '#888888'}
            isMixed={color.isMixed}
            onChange={(v) => onPatchAll?.({ color: v })}
          />
          <BulkColorRow
            label={t('sidePanel.borderColor', { defaultValue: 'Border' })}
            value={borderColor.value ?? '#888888'}
            isMixed={borderColor.isMixed}
            onChange={(v) => onPatchAll?.({ borderColor: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.borderWidth', { defaultValue: 'Border width' })}
            value={borderWidth.value ?? 1}
            isMixed={borderWidth.isMixed}
            min={0}
            max={10}
            limitMax={LIMIT_STROKE_PX}
            step={0.5}
            onChange={(v) => onPatchAll?.({ borderWidth: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.opacity', { defaultValue: 'Opacity' })}
            value={opacity.value ?? 100}
            isMixed={opacity.isMixed}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
            onChange={(v) => onPatchAll?.({ opacity: v })}
          />
        </div>
      </Section>

      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkNumberRow
            label={t('sidePanel.elevation', { defaultValue: 'Elevation' })}
            value={elevation.value ?? 0}
            isMixed={elevation.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ elevation: v })}
          />
          <BulkNumberRow
            label={t('sidePanel.height', { defaultValue: 'Height' })}
            value={height.value ?? 0}
            isMixed={height.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ height: v })}
          />
          <BulkToggleRow
            label={t('sidePanel.receiveShadows', { defaultValue: 'Receive shadows' })}
            value={receiveShadows.value ?? false}
            isMixed={receiveShadows.isMixed}
            onChange={(v) => onPatchAll?.({ receiveShadows: v })}
          />
        </div>
      </Section>

      <Section title={t('sidePanel.sectionLabels')} icon={Type}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkToggleRow
            label={t('sidePanel.showLabels', { defaultValue: 'Show labels' })}
            value={showLabels.value ?? false}
            isMixed={showLabels.isMixed}
            onChange={(v) => onPatchAll?.({ showLabels: v })}
          />
        </div>
      </Section>
    </>
  )
}

/** Small badge used to mark fields whose values differ across the selection. */
function BulkColorRow({
  label,
  value,
  isMixed,
  onChange,
}: {
  label: string
  value: string
  isMixed: boolean
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        {isMixed && <MixedBadge />}
        <ColorPicker value={value} onChange={onChange} ariaLabel={label} />
      </div>
    </div>
  )
}

function BulkNumberRow({
  label,
  value,
  isMixed,
  min,
  step,
  suffix,
  onChange,
}: {
  label: string
  value: number
  isMixed: boolean
  min?: number
  step?: number
  suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs flex items-center gap-2">
        <span>{label}</span>
        {isMixed && <MixedBadge />}
      </Label>
      <div className="flex items-center gap-1">
        <NumberInput
          value={value}
          onChange={(v) => onChange(v)}
          min={min}
          step={step ?? 0.1}
          className="w-20"
        />
        {suffix && (
          <span className="text-[10px] text-muted-foreground font-mono">{suffix}</span>
        )}
      </div>
    </div>
  )
}

/**
 * Bulk-edit panel for lines. Same shape as BulkFillShapeContent but for
 * `LineShapeConfig` — color, width, opacity, elevation, height, labels,
 * dash style.
 */
function BulkLineShapeContent({
  shapes,
  countKey,
  confirmDeleteAllKey,
  confirmDelete,
  setConfirmDelete,
  onDeleteAll,
  onFitAll,
  onPatchAll,
}: {
  shapes: ReadonlyArray<{ config: LineShapeConfig }>
  countKey: string
  confirmDeleteAllKey: string
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDeleteAll?: () => void
  onFitAll?: () => void
  onPatchAll?: (patch: Partial<LineShapeConfig>) => void
}) {
  const { t } = useTranslation()
  const count = shapes.length
  const color = sharedValue(shapes, (s) => s.config.color)
  const width = sharedValue(shapes, (s) => s.config.width)
  const borderColor = sharedValue(shapes, (s) => s.config.borderColor ?? '#000000')
  const borderWidth = sharedValue(shapes, (s) => s.config.borderWidth ?? 0)
  const dash = sharedValue(shapes, (s) => s.config.dash)
  const opacity = sharedValue(shapes, (s) => s.config.opacity)
  const elevation = sharedValue(shapes, (s) => s.config.elevation)
  const height = sharedValue(shapes, (s) => s.config.height)
  const showLabels = sharedValue(shapes, (s) => s.config.showLabels)
  return (
    <>
      <Section title={t(countKey, { count })} icon={Boxes}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => onFitAll?.()}>
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  onDeleteAll?.()
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.deleteAll')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t(confirmDeleteAllKey, { count })}
            </p>
          )}
        </div>
      </Section>

      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkColorRow
            label={t('sidePanel.lineColor', { defaultValue: 'Color' })}
            value={color.value ?? '#888888'}
            isMixed={color.isMixed}
            onChange={(v) => onPatchAll?.({ color: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.lineWidth', { defaultValue: 'Width' })}
            value={width.value ?? 1}
            isMixed={width.isMixed}
            min={1}
            max={20}
            limitMax={LIMIT_STROKE_PX}
            step={0.5}
            suffix="px"
            onChange={(v) => onPatchAll?.({ width: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.opacity', { defaultValue: 'Opacity' })}
            value={opacity.value ?? 100}
            isMixed={opacity.isMixed}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
            onChange={(v) => onPatchAll?.({ opacity: v })}
          />
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs flex items-center gap-2">
              <span>{t('sidePanel.lineDash', { defaultValue: 'Dash' })}</span>
              {dash.isMixed && <MixedBadge />}
            </Label>
            <select
              value={dash.value ?? 'solid'}
              onChange={(e) => onPatchAll?.({ dash: e.target.value as LineShapeConfig['dash'] })}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="solid">{t('sidePanel.dashSolid', { defaultValue: 'Solid' })}</option>
              <option value="dashed">{t('sidePanel.dashDashed', { defaultValue: 'Dashed' })}</option>
              <option value="dotted">{t('sidePanel.dashDotted', { defaultValue: 'Dotted' })}</option>
            </select>
          </div>
          <BulkColorRow
            label={t('sidePanel.borderColor', { defaultValue: 'Border color' })}
            value={borderColor.value ?? '#000000'}
            isMixed={borderColor.isMixed}
            onChange={(v) => onPatchAll?.({ borderColor: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.borderWidth', { defaultValue: 'Border width' })}
            value={borderWidth.value ?? 0}
            isMixed={borderWidth.isMixed}
            min={0}
            max={8}
            limitMax={LIMIT_STROKE_PX}
            step={0.5}
            suffix="px"
            onChange={(v) => onPatchAll?.({ borderWidth: v })}
          />
        </div>
      </Section>

      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkNumberRow
            label={t('sidePanel.elevation', { defaultValue: 'Elevation' })}
            value={elevation.value ?? 0}
            isMixed={elevation.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ elevation: v })}
          />
          <BulkNumberRow
            label={t('sidePanel.height', { defaultValue: 'Height' })}
            value={height.value ?? 0}
            isMixed={height.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ height: v })}
          />
        </div>
      </Section>

      <Section title={t('sidePanel.sectionLabels')} icon={Type}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkToggleRow
            label={t('sidePanel.showLabels', { defaultValue: 'Show labels' })}
            value={showLabels.value ?? false}
            isMixed={showLabels.isMixed}
            onChange={(v) => onPatchAll?.({ showLabels: v })}
          />
        </div>
      </Section>
    </>
  )
}

/** Bulk-edit panel for stairs. Exposes the most-changed fields. */
function BulkStairShapeContent({
  shapes,
  countKey,
  confirmDeleteAllKey,
  confirmDelete,
  setConfirmDelete,
  onDeleteAll,
  onFitAll,
  onPatchAll,
}: {
  shapes: ReadonlyArray<{ config: StairShapeConfig }>
  countKey: string
  confirmDeleteAllKey: string
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDeleteAll?: () => void
  onFitAll?: () => void
  onPatchAll?: (patch: Partial<StairShapeConfig>) => void
}) {
  const { t } = useTranslation()
  const count = shapes.length
  const stepCount = sharedValue(shapes, (s) => s.config.stepCount)
  const riserHeight = sharedValue(shapes, (s) => s.config.riserHeight)
  const treadDepth = sharedValue(shapes, (s) => s.config.treadDepth)
  const width = sharedValue(shapes, (s) => s.config.width)
  const color = sharedValue(shapes, (s) => s.config.color)
  const borderColor = sharedValue(shapes, (s) => s.config.borderColor)
  const borderWidth = sharedValue(shapes, (s) => s.config.borderWidth ?? 1.2)
  const opacity = sharedValue(shapes, (s) => s.config.opacity)
  const baseElevation = sharedValue(shapes, (s) => s.config.baseElevation)
  return (
    <>
      <BulkHeader
        count={count}
        countKey={countKey}
        confirmDeleteAllKey={confirmDeleteAllKey}
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        onDeleteAll={onDeleteAll}
        onFitAll={onFitAll}
      />
      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkColorRow
            label={t('sidePanel.fillColor', { defaultValue: 'Fill' })}
            value={color.value ?? '#888888'}
            isMixed={color.isMixed}
            onChange={(v) => onPatchAll?.({ color: v })}
          />
          <BulkColorRow
            label={t('sidePanel.borderColor', { defaultValue: 'Border' })}
            value={borderColor.value ?? '#888888'}
            isMixed={borderColor.isMixed}
            onChange={(v) => onPatchAll?.({ borderColor: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.borderWidth', { defaultValue: 'Border width' })}
            value={borderWidth.value ?? 1.2}
            isMixed={borderWidth.isMixed}
            min={0}
            max={8}
            limitMax={LIMIT_STROKE_PX}
            step={0.1}
            suffix="px"
            onChange={(v) => onPatchAll?.({ borderWidth: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.opacity', { defaultValue: 'Opacity' })}
            value={opacity.value ?? 100}
            isMixed={opacity.isMixed}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
            onChange={(v) => onPatchAll?.({ opacity: v })}
          />
        </div>
      </Section>
      <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkNumberRow
            label={t('sidePanel.stairStepCount', { defaultValue: 'Steps' })}
            value={stepCount.value ?? 10}
            isMixed={stepCount.isMixed}
            min={1}
            step={0.1}
            onChange={(v) => onPatchAll?.({ stepCount: Math.max(1, Math.round(v)) })}
          />
          <BulkNumberRow
            label={t('sidePanel.stairRiserHeight', { defaultValue: 'Riser height' })}
            value={riserHeight.value ?? 0.178}
            isMixed={riserHeight.isMixed}
            min={0.05}
            step={0.01}
            suffix="m"
            onChange={(v) => onPatchAll?.({ riserHeight: v })}
          />
          <BulkNumberRow
            label={t('sidePanel.stairTreadDepth', { defaultValue: 'Tread depth' })}
            value={treadDepth.value ?? 0.279}
            isMixed={treadDepth.isMixed}
            min={0.1}
            step={0.01}
            suffix="m"
            onChange={(v) => onPatchAll?.({ treadDepth: v })}
          />
          <BulkNumberRow
            label={t('sidePanel.stairWidth', { defaultValue: 'Width' })}
            value={width.value ?? 1.2}
            isMixed={width.isMixed}
            min={0.5}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ width: v })}
          />
          <BulkNumberRow
            label={t('sidePanel.elevation', { defaultValue: 'Elevation' })}
            value={baseElevation.value ?? 0}
            isMixed={baseElevation.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ baseElevation: v })}
          />
        </div>
      </Section>
    </>
  )
}

/** Bulk-edit panel for doors. */
function BulkDoorShapeContent({
  shapes,
  countKey,
  confirmDeleteAllKey,
  confirmDelete,
  setConfirmDelete,
  onDeleteAll,
  onFitAll,
  onPatchAll,
}: {
  shapes: ReadonlyArray<{ config: DoorConfig }>
  countKey: string
  confirmDeleteAllKey: string
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDeleteAll?: () => void
  onFitAll?: () => void
  onPatchAll?: (patch: Partial<DoorConfig>) => void
}) {
  const { t } = useTranslation()
  const count = shapes.length
  const frameColor = sharedValue(shapes, (s) => s.config.frameColor)
  const leafColor = sharedValue(shapes, (s) => s.config.leafColor)
  const opacity = sharedValue(shapes, (s) => s.config.opacity)
  const doorHeight = sharedValue(shapes, (s) => s.config.doorHeight)
  const elevation = sharedValue(shapes, (s) => s.config.elevation)
  return (
    <>
      <BulkHeader
        count={count}
        countKey={countKey}
        confirmDeleteAllKey={confirmDeleteAllKey}
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        onDeleteAll={onDeleteAll}
        onFitAll={onFitAll}
      />
      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkColorRow
            label={t('sidePanel.doorFrameColor', { defaultValue: 'Frame' })}
            value={frameColor.value ?? '#888888'}
            isMixed={frameColor.isMixed}
            onChange={(v) => onPatchAll?.({ frameColor: v })}
          />
          <BulkColorRow
            label={t('sidePanel.doorLeafColor', { defaultValue: 'Leaf' })}
            value={leafColor.value ?? '#888888'}
            isMixed={leafColor.isMixed}
            onChange={(v) => onPatchAll?.({ leafColor: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.opacity', { defaultValue: 'Opacity' })}
            value={opacity.value ?? 100}
            isMixed={opacity.isMixed}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
            onChange={(v) => onPatchAll?.({ opacity: v })}
          />
        </div>
      </Section>
      <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkNumberRow
            label={t('sidePanel.doorHeight', { defaultValue: 'Door height' })}
            value={doorHeight.value ?? 2.1}
            isMixed={doorHeight.isMixed}
            min={1}
            step={0.05}
            suffix="m"
            onChange={(v) => onPatchAll?.({ doorHeight: v })}
          />
          <BulkNumberRow
            label={t('sidePanel.elevation', { defaultValue: 'Elevation' })}
            value={elevation.value ?? 0}
            isMixed={elevation.isMixed}
            min={0}
            step={0.05}
            suffix="m"
            onChange={(v) => onPatchAll?.({ elevation: v })}
          />
        </div>
      </Section>
    </>
  )
}

/** Bulk-edit panel for 3D models. */
function BulkModelShapeContent({
  shapes,
  countKey,
  confirmDeleteAllKey,
  confirmDelete,
  setConfirmDelete,
  onDeleteAll,
  onFitAll,
  onPatchAll,
}: {
  shapes: ReadonlyArray<{ config: ModelShapeConfig }>
  countKey: string
  confirmDeleteAllKey: string
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDeleteAll?: () => void
  onFitAll?: () => void
  onPatchAll?: (patch: Partial<ModelShapeConfig>) => void
}) {
  const { t } = useTranslation()
  const count = shapes.length
  const opacity = sharedValue(shapes, (s) => s.config.opacity)
  const color = sharedValue(shapes, (s) => s.config.color)
  const colorMix = sharedValue(shapes, (s) => s.config.colorMix)
  const emissive = sharedValue(shapes, (s) => s.config.emissive)
  const elevation = sharedValue(shapes, (s) => s.config.elevation)
  return (
    <>
      <BulkHeader
        count={count}
        countKey={countKey}
        confirmDeleteAllKey={confirmDeleteAllKey}
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        onDeleteAll={onDeleteAll}
        onFitAll={onFitAll}
      />
      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkColorRow
            label={t('sidePanel.modelTint', { defaultValue: 'Tint' })}
            value={color.value ?? '#ffffff'}
            isMixed={color.isMixed}
            onChange={(v) => onPatchAll?.({ color: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.modelTintStrength', { defaultValue: 'Tint strength' })}
            value={colorMix.value ?? 0}
            isMixed={colorMix.isMixed}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => onPatchAll?.({ colorMix: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.opacity', { defaultValue: 'Opacity' })}
            value={opacity.value ?? 100}
            isMixed={opacity.isMixed}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
            onChange={(v) => onPatchAll?.({ opacity: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.modelEmissive', { defaultValue: 'Glow' })}
            value={emissive.value ?? 0}
            isMixed={emissive.isMixed}
            min={0}
            max={5}
            step={0.1}
            onChange={(v) => onPatchAll?.({ emissive: v })}
          />
        </div>
      </Section>
      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkNumberRow
            label={t('sidePanel.elevation', { defaultValue: 'Elevation' })}
            value={elevation.value ?? 0}
            isMixed={elevation.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ elevation: v })}
          />
        </div>
      </Section>
    </>
  )
}

/** Bulk-edit panel for text labels. */
function BulkTextLabelContent({
  shapes,
  countKey,
  confirmDeleteAllKey,
  confirmDelete,
  setConfirmDelete,
  onDeleteAll,
  onFitAll,
  onPatchAll,
}: {
  shapes: ReadonlyArray<{ config: TextLabelConfig }>
  countKey: string
  confirmDeleteAllKey: string
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDeleteAll?: () => void
  onFitAll?: () => void
  onPatchAll?: (patch: Partial<TextLabelConfig>) => void
}) {
  const { t } = useTranslation()
  const count = shapes.length
  const color = sharedValue(shapes, (s) => s.config.color)
  const size = sharedValue(shapes, (s) => s.config.size)
  const sizeMode = sharedValue(shapes, (s) =>
    s.config.sizeMode ?? (s.config.fixedSize ? 'fixed' : 'screen'),
  )
  const opacity = sharedValue(shapes, (s) => s.config.opacity)
  const haloColor = sharedValue(shapes, (s) => s.config.haloColor)
  const haloWidth = sharedValue(shapes, (s) => s.config.haloWidth)
  const elevation = sharedValue(shapes, (s) => s.config.elevation)
  return (
    <>
      <BulkHeader
        count={count}
        countKey={countKey}
        confirmDeleteAllKey={confirmDeleteAllKey}
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        onDeleteAll={onDeleteAll}
        onFitAll={onFitAll}
      />
      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkColorRow
            label={t('sidePanel.textColor', { defaultValue: 'Color' })}
            value={color.value ?? '#000000'}
            isMixed={color.isMixed}
            onChange={(v) => onPatchAll?.({ color: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.textSize', { defaultValue: 'Size' })}
            value={size.value ?? 16}
            isMixed={size.isMixed}
            min={8}
            max={64}
            limitMax={LIMIT_SYMBOL_SIZE_PX}
            step={0.1}
            suffix="px"
            onChange={(v) => onPatchAll?.({ size: v })}
          />
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-2">
              <span>{t('sidePanel.textSizeMode', { defaultValue: 'Size behaviour' })}</span>
              {sizeMode.isMixed && <MixedBadge />}
            </Label>
            <div className="grid grid-cols-3 gap-1">
              {(['screen', 'fixed', 'shape'] as const).map((m) => {
                const active = !sizeMode.isMixed && sizeMode.value === m
                return (
                  <button
                    key={m}
                    type="button"
                    // Clear the legacy alias when picking a mode so the two
                    // fields can't disagree across the selected shapes.
                    onClick={() => onPatchAll?.({ sizeMode: m, fixedSize: undefined })}
                    className={cn(
                      'px-1.5 py-1 text-[10px] rounded border transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card hover:bg-accent border-input text-muted-foreground',
                    )}
                  >
                    {t(`sidePanel.textSizeMode_${m}`, {
                      defaultValue:
                        m === 'screen' ? 'Follow zoom'
                        : m === 'fixed' ? 'Fixed'
                        : 'In shape',
                    })}
                  </button>
                )
              })}
            </div>
          </div>
          <BulkSliderRow
            label={t('sidePanel.opacity', { defaultValue: 'Opacity' })}
            value={opacity.value ?? 100}
            isMixed={opacity.isMixed}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
            onChange={(v) => onPatchAll?.({ opacity: v })}
          />
          <BulkColorRow
            label={t('sidePanel.textHaloColor', { defaultValue: 'Halo color' })}
            value={haloColor.value ?? '#ffffff'}
            isMixed={haloColor.isMixed}
            onChange={(v) => onPatchAll?.({ haloColor: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.textHaloWidth', { defaultValue: 'Halo width' })}
            value={haloWidth.value ?? 0}
            isMixed={haloWidth.isMixed}
            min={0}
            max={5}
            limitMax={LIMIT_HALO_PX}
            step={0.5}
            onChange={(v) => onPatchAll?.({ haloWidth: v })}
          />
        </div>
      </Section>
      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkNumberRow
            label={t('sidePanel.elevation', { defaultValue: 'Elevation' })}
            value={elevation.value ?? 0}
            isMixed={elevation.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ elevation: v })}
          />
        </div>
      </Section>
    </>
  )
}

/**
 * Cross-kind bulk view — the sidebar body when the marquee tool has
 * produced a selection that spans more than one shape kind. Lists the
 * per-kind counts and exposes the actions that work regardless of
 * kind: change floor, hide, show, delete. Individual-kind editors
 * (colour pickers, dimension sliders, etc.) don't render here because
 * they don't make sense across e.g. polygons + markers + doors — the
 * user can click a single shape to drop back into that kind's editor.
 */
function BulkCrossKindContent({
  counts,
  confirmDelete,
  setConfirmDelete,
  onDelete,
  onHide,
  onShow,
  onChangeFloor,
  onClear,
}: {
  counts: Record<string, number>
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDelete?: () => void
  onHide?: () => void
  onShow?: () => void
  onChangeFloor?: () => void
  onClear?: () => void
}) {
  const { t } = useTranslation()
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const kindCount = Object.values(counts).filter((n) => n > 0).length

  const KIND_META: Array<{ key: keyof typeof counts; icon: typeof Boxes; labelKey: string; fallback: string }> = [
    { key: 'grid', icon: Grid3X3, labelKey: 'sidePanel.crossKindGrids', fallback: 'Racks' },
    { key: 'polygon', icon: Pentagon, labelKey: 'sidePanel.crossKindPolygons', fallback: 'Areas' },
    { key: 'circle', icon: Circle, labelKey: 'sidePanel.crossKindCircles', fallback: 'Circles' },
    { key: 'line', icon: Spline, labelKey: 'sidePanel.crossKindLines', fallback: 'Aisles & walls' },
    { key: 'route', icon: Route, labelKey: 'sidePanel.crossKindRoutes', fallback: 'Routes' },
    { key: 'stair', icon: Footprints, labelKey: 'sidePanel.crossKindStairs', fallback: 'Stairs' },
    { key: 'door', icon: DoorOpen, labelKey: 'sidePanel.crossKindDoors', fallback: 'Doors' },
    { key: 'marker', icon: MapPin, labelKey: 'sidePanel.crossKindMarkers', fallback: 'Markers' },
    { key: 'image', icon: ImageIcon, labelKey: 'sidePanel.crossKindImages', fallback: 'Floor plans' },
    { key: 'model', icon: Box, labelKey: 'sidePanel.crossKindModels', fallback: '3D models' },
    { key: 'image-plane', icon: Frame, labelKey: 'sidePanel.crossKindImagePlanes', fallback: 'Image planes' },
    { key: 'text-label', icon: Type, labelKey: 'sidePanel.crossKindTextLabels', fallback: 'Text labels' },
  ]
  return (
    <>
      <Section
        title={t('sidePanel.crossKindTitle', {
          defaultValue: '{{count}} selected · {{kinds}} kinds',
          count: total,
          kinds: kindCount,
        })}
        icon={Boxes}
      >
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => onChangeFloor?.()}>
              <ArrowRightLeft className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.crossKindChangeFloor', { defaultValue: 'Change floor' })}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onHide?.()}>
              <EyeOff className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.crossKindHide', { defaultValue: 'Hide' })}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onShow?.()}>
              <Eye className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.crossKindShow', { defaultValue: 'Show' })}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  onDelete?.()
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete
                ? t('sidePanel.confirmDelete')
                : t('sidePanel.crossKindDelete', { defaultValue: 'Delete' })}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t('sidePanel.crossKindConfirmDelete', {
                defaultValue:
                  'Deletes every selected shape across all kinds. Undo will restore.',
              })}
            </p>
          )}
          <Button variant="ghost" size="sm" className="w-full" onClick={() => onClear?.()}>
            <X className="w-3.5 h-3.5 me-1.5" />
            {t('sidePanel.crossKindClear', { defaultValue: 'Clear selection' })}
          </Button>
        </div>
      </Section>

      <Section
        title={t('sidePanel.crossKindBreakdown', { defaultValue: 'Selected by kind' })}
        icon={Boxes}
      >
        <div className="p-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm divide-y divide-border/60">
          {KIND_META.filter((k) => counts[k.key] > 0).map((k) => {
            const Icon = k.icon
            return (
              <div key={k.key} className="flex items-center gap-2 py-1.5 px-1 text-xs">
                <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">
                  {t(k.labelKey, { defaultValue: k.fallback })}
                </span>
                <span className="font-medium tabular-nums">{counts[k.key]}</span>
              </div>
            )
          })}
        </div>
      </Section>
    </>
  )
}

/** Bulk-edit panel for markers. */
function BulkMarkerShapeContent({
  shapes,
  countKey,
  confirmDeleteAllKey,
  confirmDelete,
  setConfirmDelete,
  onDeleteAll,
  onFitAll,
  onPatchAll,
}: {
  shapes: ReadonlyArray<{ config: MarkerShapeConfig }>
  countKey: string
  confirmDeleteAllKey: string
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDeleteAll?: () => void
  onFitAll?: () => void
  onPatchAll?: (patch: Partial<MarkerShapeConfig>) => void
}) {
  const { t } = useTranslation()
  const count = shapes.length
  const iconColor = sharedValue(shapes, (s) => s.config.iconColor)
  const iconSize = sharedValue(shapes, (s) => s.config.iconSize)
  const opacity = sharedValue(shapes, (s) => s.config.opacity)
  const elevation = sharedValue(shapes, (s) => s.config.elevation)
  const height = sharedValue(shapes, (s) => s.config.height)
  return (
    <>
      <BulkHeader
        count={count}
        countKey={countKey}
        confirmDeleteAllKey={confirmDeleteAllKey}
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        onDeleteAll={onDeleteAll}
        onFitAll={onFitAll}
      />
      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkColorRow
            label={t('sidePanel.markerColor', { defaultValue: 'Color' })}
            value={iconColor.value ?? '#3b82f6'}
            isMixed={iconColor.isMixed}
            onChange={(v) => onPatchAll?.({ iconColor: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.markerSize', { defaultValue: 'Size' })}
            value={iconSize.value ?? 16}
            isMixed={iconSize.isMixed}
            min={8}
            max={64}
            limitMax={LIMIT_MARKER_SIZE_PX}
            step={0.1}
            suffix="px"
            onChange={(v) => onPatchAll?.({ iconSize: v })}
          />
          <BulkSliderRow
            label={t('sidePanel.opacity', { defaultValue: 'Opacity' })}
            value={opacity.value ?? 100}
            isMixed={opacity.isMixed}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
            onChange={(v) => onPatchAll?.({ opacity: v })}
          />
        </div>
      </Section>
      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkNumberRow
            label={t('sidePanel.elevation', { defaultValue: 'Elevation' })}
            value={elevation.value ?? 0}
            isMixed={elevation.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ elevation: v })}
          />
          <BulkNumberRow
            label={t('sidePanel.markerPoleHeight', { defaultValue: 'Pole height' })}
            value={height.value ?? 0}
            isMixed={height.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ height: v })}
          />
        </div>
      </Section>
    </>
  )
}

/** Bulk-edit panel for images (floor plans). */
function BulkImageShapeContent({
  shapes,
  countKey,
  confirmDeleteAllKey,
  confirmDelete,
  setConfirmDelete,
  onDeleteAll,
  onFitAll,
  onPatchAll,
}: {
  shapes: ReadonlyArray<{ config: ImageShapeConfig }>
  countKey: string
  confirmDeleteAllKey: string
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDeleteAll?: () => void
  onFitAll?: () => void
  onPatchAll?: (patch: Partial<ImageShapeConfig>) => void
}) {
  const { t } = useTranslation()
  const count = shapes.length
  const opacity = sharedValue(shapes, (s) => s.config.opacity)
  const elevation = sharedValue(shapes, (s) => s.config.elevation ?? 0)
  return (
    <>
      <BulkHeader
        count={count}
        countKey={countKey}
        confirmDeleteAllKey={confirmDeleteAllKey}
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        onDeleteAll={onDeleteAll}
        onFitAll={onFitAll}
      />
      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkSliderRow
            label={t('sidePanel.opacity', { defaultValue: 'Opacity' })}
            value={opacity.value ?? 100}
            isMixed={opacity.isMixed}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
            onChange={(v) => onPatchAll?.({ opacity: v })}
          />
        </div>
      </Section>
      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <BulkNumberRow
            label={t('sidePanel.elevation', { defaultValue: 'Elevation' })}
            value={elevation.value ?? 0}
            isMixed={elevation.isMixed}
            min={0}
            step={0.1}
            suffix="m"
            onChange={(v) => onPatchAll?.({ elevation: v })}
          />
        </div>
      </Section>
    </>
  )
}

/** Shared header block for all bulk panels — count, fit, delete. */
function BulkHeader({
  count,
  countKey,
  confirmDeleteAllKey,
  confirmDelete,
  setConfirmDelete,
  onDeleteAll,
  onFitAll,
}: {
  count: number
  countKey: string
  confirmDeleteAllKey: string
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDeleteAll?: () => void
  onFitAll?: () => void
}) {
  const { t } = useTranslation()
  return (
    <Section title={t(countKey, { count })} icon={Boxes}>
      <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
        <div className="grid grid-cols-2 gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => onFitAll?.()}>
            <Maximize2 className="w-3.5 h-3.5 me-1.5" />
            {t('sidePanel.fit')}
          </Button>
          <Button
            variant={confirmDelete ? 'destructive' : 'outline'}
            size="sm"
            onClick={() => {
              if (confirmDelete) {
                onDeleteAll?.()
                setConfirmDelete(false)
              } else {
                setConfirmDelete(true)
              }
            }}
          >
            <Trash2 className="w-3.5 h-3.5 me-1.5" />
            {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.deleteAll')}
          </Button>
        </div>
        {confirmDelete && (
          <p className="text-[11px] text-destructive">
            {t(confirmDeleteAllKey, { count })}
          </p>
        )}
      </div>
    </Section>
  )
}

function BulkToggleRow({
  label,
  value,
  isMixed,
  onChange,
}: {
  label: string
  value: boolean
  isMixed: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs flex items-center gap-2">
        <span>{label}</span>
        {isMixed && <MixedBadge />}
      </Label>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  )
}


/**
 * Zones management section. Lets the user add a new zone (name + color)
 * and delete existing zones. Deleting a zone unassigns any grids in it
 * (handled in the parent — the action is the same `onAssignGridToZone`).
 */
function ZonesContent({
  zones,
  grids,
  actions,
}: {
  zones?: ReadonlyArray<Zone>
  grids?: ReadonlyArray<Grid>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#6366f1')
  const [pendingDelete, setPendingDelete] = useState<Zone | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const list = (zones ?? []).filter((z) => matchesWorkspaceQuery(z.name, query))
  // Drop the whole section if a non-empty query matches no zones —
  // matches the behaviour of the saved-shape sections. When the query
  // is empty we keep rendering even with no zones so the "Add zone"
  // CTA stays available; that's why we check the query separately
  // rather than just `list.length === 0`.
  if (query.trim().length > 0 && list.length === 0) return null
  const gridsInZone = (zoneId: number) =>
    (grids ?? []).filter((g) => g.zoneId === zoneId).length

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    actions?.onAddZone?.(trimmed, color)
    setName('')
    setColor('#6366f1')
    setAdding(false)
  }

  return (
    <Section title={t('sidePanel.zonesTitle')} icon={Warehouse} dataAttribute="data-side-panel-zones-title">
      <div className="space-y-1.5">
        {list.length === 0 && !adding && (
          <p className="text-[11px] text-muted-foreground">
            {t('sidePanel.zonesEmpty')}
          </p>
        )}
        {list.map((z) => (
          <div
            key={z.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40"
          >
            <span
              className="flex-shrink-0 w-3 h-3 rounded"
              style={{ backgroundColor: z.color }}
              aria-hidden="true"
            />
            <span className="flex-1 min-w-0 text-xs truncate">{z.name}</span>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {gridsInZone(z.id!)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6"
              onClick={() => {
                setDeleteError(null)
                setPendingDelete(z)
              }}
              title={t('sidePanel.deleteZone')}
              aria-label={t('sidePanel.deleteZone')}
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        ))}
        {adding ? (
          <div className="flex flex-col gap-1.5 p-2 rounded border bg-background/40">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('sidePanel.zoneNamePlaceholder')}
              className="text-xs h-7"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                else if (e.key === 'Escape') {
                  setAdding(false)
                  setName('')
                }
              }}
            />
            <div className="flex items-center gap-2">
              <ColorPicker
                value={color}
                onChange={setColor}
                ariaLabel={t('sidePanel.zoneColor')}
              />
              <Button
                size="sm"
                variant="default"
                onClick={submit}
                disabled={!name.trim()}
                className="flex-1 text-xs h-7"
              >
                {t('sidePanel.add')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(false)
                  setName('')
                }}
                className="h-7"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
            className="w-full text-xs h-7"
          >
            <Plus className="w-3 h-3 me-1" />
            {t('sidePanel.addZone')}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null)
        }}
        title={t('sidePanel.deleteZoneTitle', { defaultValue: 'Delete “{{name}}”?', name: pendingDelete?.name ?? '' })}
        description={t('sidePanel.deleteZoneBody', {
          defaultValue: 'Its shapes are kept and become unassigned. Its data links, share links and data fields are deleted. This can’t be undone.',
        })}
        confirmLabel={t('sidePanel.deleteZone')}
        busy={deleting}
        error={deleteError}
        onConfirm={async () => {
          if (!pendingDelete?.id) return
          setDeleting(true)
          setDeleteError(null)
          try {
            await actions?.onDeleteZone?.(pendingDelete.id)
            setPendingDelete(null)
          } catch (err) {
            setDeleteError(err instanceof Error ? err.message : String(err))
          } finally {
            setDeleting(false)
          }
        }}
      />
    </Section>
  )
}

// ---- Default config (idle / live-draw) -----------------------------------

/**
 * Shared 3D controls. `is3D` is true when the grid is rendered as a 3D
 * fill-extrusion, which happens whenever either `elevation > 0` or
 * `height > 0`. The `showLabels` switch is enabled in 3D too — labels
 * are now lifted to the top of the extrusion via the symbol layer's
 * `text-elevation-reference` and `text-z-offset` properties, so they
 * stay aligned with the cell face.
 */
function ThreeDControls({
  config,
  update,
  t,
}: {
  config: GridConfig
  update: <K extends keyof GridConfig>(key: K, value: GridConfig[K]) => void
  t: (key: string) => string
}) {
  // Mirrors the elevation/height block used by the circle, polygon, and
  // line panels: a NumberInput in the active display unit *and* a slider
  // so users can either type a precise value or drag for a quick
  // adjustment. Show-labels lives in the Labels section (same as the
  // other shape tools).
  return (
    <>
      <div className="space-y-1.5">
        <Label className="flex items-center justify-between text-xs">
          <span>{t('sidePanel.elevation')}</span>
          <span className="font-mono text-muted-foreground">
            {config.elevation === 0
              ? t('sidePanel.flat')
              : formatLength(config.elevation, config.unit)}
          </span>
        </Label>
        <NumberInput
          value={config.elevation}
          unit={config.unit}
          min={0}
          max={LIMIT_ELEVATION_M}
          onChange={(meters) => update('elevation', Math.max(0, meters))}
          ariaLabel={t('sidePanel.elevation')}
        />
        <StretchSlider
          value={config.elevation}
          onValueChange={(v) => update('elevation', v)}
          min={0}
          max={500}
          limitMax={LIMIT_ELEVATION_M}
          step={0.1}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="flex items-center justify-between text-xs">
          <span>{t('sidePanel.height')}</span>
          <span className="font-mono text-muted-foreground">
            {config.height === 0
              ? t('sidePanel.flat')
              : formatLength(config.height, config.unit)}
          </span>
        </Label>
        <NumberInput
          value={config.height}
          unit={config.unit}
          min={0}
          onChange={(meters) => {
            const next = Math.max(0, meters)
            // First time the user flips into 3D (height 0 → > 0) and the
            // label altitude is still 0 ("Flat"), default the label to
            // the top of the new extrusion so labels appear without
            // forcing the user to drag the altitude slider.
            if (config.height === 0 && next > 0 && config.labelAltitude === 0) {
              update('labelAltitude', config.elevation + next)
            }
            update('height', next)
          }}
          ariaLabel={t('sidePanel.height')}
        />
        <Slider
          value={[config.height]}
          onValueChange={(v) => {
            const next = v[0]
            if (config.height === 0 && next > 0 && config.labelAltitude === 0) {
              update('labelAltitude', config.elevation + next)
            }
            update('height', next)
          }}
          min={0}
          max={500}
          step={0.1}
        />
      </div>
    </>
  )
}

/**
 * Vertical-racking controls. Lets the user turn a 2D grid into a
 * stacked pallet-rack by setting `levels` and per-level shelf height.
 * Single-level grids (the default) hide the height input — it's only
 * meaningful once levels > 1, since for a flat grid the existing 3D
 * `height` controls the extrusion. Bumping `levels` from 1 → N also
 * pre-fills `labelAltitude` so labels lift to the top of the rack the
 * first time the user enables stacking, matching the existing UX where
 * height > 0 auto-lifts labels.
 */
function VerticalControls({
  config,
  update,
  t,
}: {
  config: GridConfig
  update: <K extends keyof GridConfig>(key: K, value: GridConfig[K]) => void
  t: (key: string) => string
}) {
  const levels = Math.max(1, Math.floor(config.levels ?? 1))
  const isMultiLevel = levels > 1
  return (
    <>
      <SliderRow
        label={t('sidePanel.levels')}
        value={levels}
        onChange={(v) => {
          const next = Math.max(1, Math.min(LIMIT_RACK_LEVELS, Math.floor(v)))
          // Multi-level racks position each label on its own shelf
          // rooftop (see `labelPointData` in map-grid-overlay), so
          // there's no need to auto-lift `labelAltitude` here —
          // that would double-count and push every label above the
          // entire rack. If a user previously had a non-zero
          // `labelAltitude` (e.g. from the old auto-lift), bumping
          // a single-level grid into multi-level zeroes it so the
          // new per-shelf labels render cleanly.
          if (levels === 1 && next > 1 && (config.labelAltitude ?? 0) > 0) {
            update('labelAltitude', 0)
          }
          update('levels', next)
        }}
        min={1}
        max={10}
        limitMax={LIMIT_RACK_LEVELS}
        step={0.1}
        decimals={0}
      />
      {isMultiLevel && (
        <div className="space-y-1.5">
          <Label className="flex items-center justify-between text-xs">
            <span>{t('sidePanel.levelHeight')}</span>
            <span className="font-mono text-muted-foreground">
              {formatLength(config.levelHeight ?? 0, config.unit)}
            </span>
          </Label>
          <NumberInput
            value={config.levelHeight ?? 0}
            unit={config.unit}
            min={0.1}
            onChange={(meters) => update('levelHeight', Math.max(0.1, meters))}
            ariaLabel={t('sidePanel.levelHeight')}
          />
          <p className="text-[10px] text-muted-foreground">
            {t('sidePanel.levelHeightHint')}
          </p>
        </div>
      )}
      {isMultiLevel && (
        <div className="space-y-1.5">
          <Label className="flex items-center justify-between text-xs">
            <span>{t('sidePanel.levelGap')}</span>
            <span className="font-mono text-muted-foreground">
              {formatLength(config.levelGap ?? 0, config.unit)}
            </span>
          </Label>
          <NumberInput
            value={config.levelGap ?? 0}
            unit={config.unit}
            min={0}
            onChange={(meters) => update('levelGap', Math.max(0, meters))}
            ariaLabel={t('sidePanel.levelGap')}
          />
          <p className="text-[10px] text-muted-foreground">
            {t('sidePanel.levelGapHint')}
          </p>
        </div>
      )}
    </>
  )
}

/**
 * Empty-state card shown when the user is idle and has not drawn any
 * grids yet. Replaces the wall of always-on configuration sections that
 * the original idle layout displayed before anything was on the map.
 */
function IdleEmptyState({ onStartDraw }: { onStartDraw: () => void }) {
  const { t } = useTranslation()
  // Onboarding hint list — surfaces the 3 fastest ways to get started.
  // Each row is keyboard-forward: users learn the shortcuts by seeing
  // them on the first empty state, not by opening the cheatsheet.
  const hints: { icon: typeof Grid3X3; labelKey: string; fallback: string; hint: string }[] = [
    { icon: Grid3X3, labelKey: 'sidePanel.emptyHintGrid', fallback: 'Draw a rack/grid', hint: 'G' },
    { icon: Pentagon, labelKey: 'sidePanel.emptyHintPolygon', fallback: 'Draw a polygon zone', hint: 'P' },
    { icon: MapPin, labelKey: 'sidePanel.emptyHintMarker', fallback: 'Drop a marker', hint: 'M' },
  ]
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-gradient-to-br from-primary/5 via-transparent to-transparent p-5 space-y-4">
      <div className="text-center space-y-3">
        <div className="flex items-center justify-center w-12 h-12 mx-auto rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20 shadow-sm">
          <Crosshair className="w-5 h-5" strokeWidth={2.25} />
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold tracking-tight">
            {t('sidePanel.emptyTitle')}
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-[280px] mx-auto">
            {t('sidePanel.emptyHint')}
          </p>
        </div>
        <Button size="sm" className="w-full shadow-sm" onClick={onStartDraw}>
          <Crosshair className="w-3.5 h-3.5 me-2" />
          {t('sidePanel.emptyCta')}
        </Button>
      </div>
      <div className="pt-4 border-t border-border/60 space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground text-center">
          {t('sidePanel.emptyOrHeading', { defaultValue: 'Or pick a tool' })}
        </p>
        <ul className="space-y-1">
          {hints.map((h) => (
            <li
              key={h.labelKey}
              className="flex items-center gap-2 text-xs text-muted-foreground px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors"
            >
              <span className="flex items-center justify-center w-6 h-6 rounded-md bg-muted/60 text-foreground flex-shrink-0">
                <h.icon className="w-3.5 h-3.5" />
              </span>
              <span className="flex-1">{t(h.labelKey, { defaultValue: h.fallback })}</span>
              <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded border border-border/60 bg-background text-[10px] font-mono font-semibold text-muted-foreground">
                {h.hint}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function DefaultConfigContent({
  config,
  update,
  drawMode,
  hasDrawLine,
  onToggleDrawMode,
  gridTypes,
}: {
  config: GridConfig
  update: <K extends keyof GridConfig>(key: K, value: GridConfig[K]) => void
  drawMode: boolean
  hasDrawLine: boolean
  onToggleDrawMode: () => void
  gridTypes: { id: GridType; icon: typeof Grid3X3; label: string }[]
}) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={MapPin}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <Button
            variant={drawMode ? 'default' : 'outline'}
            size="sm"
            className="w-full"
            onClick={onToggleDrawMode}
          >
            <Crosshair className="w-3.5 h-3.5 me-2" />
            {drawMode ? t('sidePanel.cancelDraw') : t('sidePanel.pickOnMap')}
          </Button>
          {drawMode ? (
            <p className="text-[11px] text-muted-foreground">
              {hasDrawLine ? t('sidePanel.drawHintCommit') : t('sidePanel.drawHint')}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {t('sidePanel.drawHintIdle')}
            </p>
          )}
        </div>
      </Section>

      <Section title={t('sidePanel.sectionShape')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-3 gap-1.5">
            {gridTypes.map((g) => {
              const Icon = g.icon
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => update('type', g.id)}
                  className={cn(
                    'flex flex-col items-center gap-1 py-2 px-1 rounded-md border text-xs transition-colors',
                    config.type === g.id
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:bg-accent'
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {g.label}
                </button>
              )
            })}
          </div>
          {config.type === 'hexagon' && (
            <div className="grid grid-cols-2 gap-1.5">
              {(['pointy', 'flat'] as HexOrientation[]).map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => update('hexOrientation', o)}
                  className={cn(
                    'py-1.5 rounded-md border text-xs capitalize transition-colors',
                    config.hexOrientation === o
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:bg-accent'
                  )}
                >
                  {t(`sidePanel.hex${o[0].toUpperCase()}${o.slice(1)}`)}
                </button>
              ))}
            </div>
          )}
        </div>
      </Section>

      <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>
                {config.type === 'hexagon' ? t('sidePanel.hexRadius') : t('sidePanel.xSize')}
              </span>
              <span className="font-mono text-muted-foreground">
                {formatLength(config.xSize, config.unit)}
              </span>
            </Label>
            <NumberInput
              value={config.xSize}
              unit={config.unit}
              min={0.01}
              onChange={(meters) => update('xSize', Math.max(0.01, meters))}
              ariaLabel={t('sidePanel.xSize')}
            />
          </div>
          {config.type !== 'hexagon' && (
            <div className="space-y-1.5">
              <Label className="flex items-center justify-between text-xs">
                <span>{t('sidePanel.ySize')}</span>
                <span className="font-mono text-muted-foreground">
                  {formatLength(config.ySize, config.unit)}
                </span>
              </Label>
              <NumberInput
                value={config.ySize}
                unit={config.unit}
                min={0.01}
                onChange={(meters) => update('ySize', Math.max(0.01, meters))}
                ariaLabel={t('sidePanel.ySize')}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.cellGap')}</span>
              <span className="font-mono text-muted-foreground">
                {formatLength(config.cellGap ?? 0, config.unit)}
              </span>
            </Label>
            <NumberInput
              value={config.cellGap ?? 0}
              unit={config.unit}
              min={0}
              onChange={(meters) => update('cellGap', Math.max(0, meters))}
              ariaLabel={t('sidePanel.cellGap')}
            />
          </div>
          <div className="space-y-2">
            <SliderRow
              label={
                <span className="flex items-center gap-1.5">
                  <RotateCw className="w-3 h-3" />
                  {t('sidePanel.rotation')}
                </span>
              }
              labelExtra={
                <button
                  type="button"
                  onClick={() => update('rotation', 0)}
                  className="font-mono transition-colors text-muted-foreground hover:text-foreground"
                  title={t('sidePanel.rotationReset')}
                >
                  {config.rotation.toFixed(1).replace(/\.0$/, '')}°
                </button>
              }
              value={config.rotation}
              onChange={(v) => update('rotation', v)}
              min={-180}
              max={180}
              step={0.5}
              suffix="°"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground font-mono px-0.5 -mt-1">
              <span>-180°</span>
              <span>0°</span>
              <span>+180°</span>
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.color')}
            value={config.color}
            onChange={(v) => update('color', v)}
          />
          <ColorRow
            label={t('sidePanel.borderColor')}
            value={config.borderColor}
            onChange={(v) => update('borderColor', v)}
          />
          <SliderRow
            label={t('sidePanel.borderWidth')}
            value={config.borderWidth}
            onChange={(v) => update('borderWidth', v)}
            min={0}
            max={6}
            limitMax={LIMIT_STROKE_PX}
            step={0.5}
            suffix="px"
          />
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
          />
        </div>
      </Section>

      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ThreeDControls config={config} update={update} t={t} />
        </div>
      </Section>

      {config.type === 'square' && (
        <Section title={t('sidePanel.sectionVertical')} icon={LayersIcon}>
          <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
            <VerticalControls config={config} update={update} t={t} />
          </div>
        </Section>
      )}

      <LabelSection
        config={config}
        update={update}
        showHeader
      />

      <Section title={t('sidePanel.sectionSave')} icon={Save}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <p className="text-[11px] text-muted-foreground">{t('sidePanel.saveHint')}</p>
        </div>
      </Section>
    </>
  )
}

// ---- Tooltip-trigger section (shared by every non-grid shape editor) -----
//
// Each shape's config carries a `tooltipTrigger` (`'hover' | 'click'`)
// the hover-popup overlay reads to decide whether to fire on
// `mousemove` (the default) or only on `click`. The toggle is
// deliberately a 2-button group instead of a Switch because the two
// states are equally weighted — neither is "off".

function TooltipTriggerSection({
  value,
  onChange,
}: {
  value: TooltipTrigger | undefined
  onChange: (v: TooltipTrigger) => void
}) {
  const { t } = useTranslation()
  // Undefined treated as 'hover' for any legacy shape saved before the
  // field existed. We don't *write* a default on read so the UI stays
  // in sync with whatever the row actually persists.
  const current = value ?? 'hover'
  const options: TooltipTrigger[] = ['hover', 'click']
  return (
    <Section
      title={t('sidePanel.sectionTooltip', { defaultValue: 'Tooltip' })}
      icon={MousePointerClick}
    >
      <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
        <Label className="text-xs">
          {t('sidePanel.tooltipTrigger', { defaultValue: 'Show on' })}
        </Label>
        <div className="grid grid-cols-2 gap-1.5">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={cn(
                'py-1.5 rounded-md border text-xs capitalize transition-colors',
                current === opt
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent'
              )}
            >
              {t(`sidePanel.tooltipTrigger_${opt}`, {
                defaultValue: opt === 'hover' ? 'Hover' : 'Click',
              })}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground">
          {current === 'click'
            ? t('sidePanel.tooltipTriggerHintClick', {
              defaultValue: 'Tooltip opens when the shape is clicked.',
            })
            : t('sidePanel.tooltipTriggerHintHover', {
              defaultValue: 'Tooltip opens when the cursor enters the shape.',
            })}
        </p>
      </div>
    </Section>
  )
}

// ---- Label section (shared between default and selected modes) -----------

function LabelSection({
  config,
  update,
  showHeader = false,
}: {
  config: GridConfig
  update: <K extends keyof GridConfig>(key: K, value: GridConfig[K]) => void
  showHeader?: boolean
}) {
  const { t } = useTranslation()
  const content = (
    <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
      <div className="flex items-center justify-between">
        <Label className="text-xs flex items-center gap-1.5">
          <Tag className="w-3 h-3" />
          {t('sidePanel.showLabels')}
        </Label>
        <Switch
          checked={config.showLabels}
          onCheckedChange={(v) => update('showLabels', v)}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5">
            <Hash className="w-3 h-3" />
            {t('sidePanel.labelPrefix')}
          </span>
        </Label>
        <TextField
          value={config.labelPrefix}
          onCommit={(text) => update('labelPrefix', text)}
          placeholder={t('sidePanel.labelPrefixPlaceholder')}
          className="h-8"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="flex items-center justify-between text-xs">
          <span>{t('sidePanel.labelStart')}</span>
          <span className="font-mono text-muted-foreground">{config.labelStart}</span>
        </Label>
        <Input
          type="number"
          step={1}
          min={0}
          value={config.labelStart}
          onChange={(e) => update('labelStart', Math.max(0, Number(e.target.value) || 0))}
          className="h-8"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs flex items-center gap-1.5">
          <ArrowRight className="w-3 h-3" />
          {t('sidePanel.labelDirection')}
        </Label>
        <div className="grid grid-cols-2 gap-1.5">
          {(['x', 'y'] as LabelDirection[]).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => update('labelDirection', d)}
              className={cn(
                'py-1.5 rounded-md border text-xs transition-colors',
                config.labelDirection === d
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent'
              )}
            >
              {t(`sidePanel.labelDir${d.toUpperCase()}`)}
            </button>
          ))}
        </div>
      </div>
      <ColorRow
        label={t('sidePanel.labelColor')}
        value={config.labelColor}
        onChange={(v) => update('labelColor', v)}
      />
      <SliderRow
        label={t('sidePanel.labelSize')}
        value={config.labelSize}
        onChange={(v) => update('labelSize', v)}
        min={8}
        max={32}
        limitMax={LIMIT_SYMBOL_SIZE_PX}
        step={0.1}
        suffix="px"
      />
      {config.height > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center justify-between text-xs">
            <span>{t('sidePanel.labelAltitude')}</span>
            <span className="font-mono text-muted-foreground">
              {config.labelAltitude === 0
                ? t('sidePanel.flat')
                : formatLength(config.labelAltitude, config.unit)}
            </span>
          </Label>
          <Slider
            value={[config.labelAltitude]}
            onValueChange={(v) => update('labelAltitude', v[0])}
            min={0}
            max={config.elevation + config.height}
            step={0.1}
          />
        </div>
      )}
    </div>
  )

  if (!showHeader) return content
  return (
    <Section title={t('sidePanel.sectionLabels')} icon={Type}>
      {content}
    </Section>
  )
}

// ---- Selected grid content (1 grid selected) -----------------------------

function SelectedGridContent({
  grid,
  onConfigChange,
  confirmDelete,
  setConfirmDelete,
  actions,
  selectedBin,
}: {
  grid: Grid
  onConfigChange: (config: GridConfig) => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  actions?: SidePanelActions
  selectedBin?: { gridId: number; row: number; col: number; level: number } | null
}) {
  const { t } = useTranslation()
  const config = grid.config
  const update = <K extends keyof GridConfig>(key: K, value: GridConfig[K]) => {
    onConfigChange({ ...config, [key]: value })
  }
  const isMoving = actions?.transformActive && actions?.transformKind === 'move'
  const isRotating = actions?.transformActive && actions?.transformKind === 'rotate'
  const isScaling = actions?.transformActive && actions?.transformKind === 'scale'

  // Geometry lock: when any bin attached to this grid was written by an
  // external data source (carries `syncSource` or `externalCode`), the
  // grid's (row, col) addressing must stay stable — otherwise the linked
  // WMS data would silently re-key. Scale + Redraw are the two actions
  // that change the row/col count, so they get gated. Move + Rotate
  // preserve indices and remain available.
  const gridId = grid.id
  const { data: bins = [] } = useSpatialBins()
  const geometryLocked = useMemo(
    () =>
      gridId !== undefined &&
      bins.some(
        (b) =>
          b.gridId === gridId &&
          (b.externalCode !== undefined || b.syncSource !== undefined),
      ),
    [bins, gridId],
  )
  const matchedBin = useMemo(
    () =>
      selectedBin && selectedBin.gridId === grid.id
        ? bins.find(
            (b) =>
              b.gridId === selectedBin.gridId &&
              b.row === selectedBin.row &&
              b.col === selectedBin.col &&
              b.level === selectedBin.level,
          )
        : undefined,
    [bins, selectedBin, grid.id],
  )

  return (
    <>
      {geometryLocked && (
        <Section title={t('sidePanel.sectionDataLink', { defaultValue: 'Linked data' })} icon={Link2}>
          <div className="p-3 border rounded-lg bg-warning/5 border-warning/30">
            <div className="flex items-start gap-2.5">
              <Lock className="w-3.5 h-3.5 mt-0.5 text-warning flex-shrink-0" />
              <div className="min-w-0 space-y-1">
                <p className="text-xs font-semibold text-warning">
                  {t('sidePanel.geometryLocked', { defaultValue: 'Geometry locked' })}
                </p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {t('sidePanel.geometryLockedHint', {
                    defaultValue:
                      'This grid has bins linked to external data. Scale + Redraw are disabled to keep row/col addresses stable. Move and Rotate remain available — they preserve indices.',
                  })}
                </p>
              </div>
            </div>
          </div>
        </Section>
      )}

      <Section title={t('sidePanel.sectionBin', { defaultValue: 'Bin' })} icon={Package}>
        <div className="p-0 overflow-hidden border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          {matchedBin ? (
            <BinPopupContent bin={matchedBin} compact withReferences={false} />
          ) : selectedBin && selectedBin.gridId === grid.id ? (
            <div className="p-3">
              <p className="text-[11px] text-muted-foreground">
                {t('sidePanel.binSelectedHint', {
                  defaultValue: 'Cell r{{row}} · c{{col}}{{levelSuffix}} ready to edit.',
                  row: selectedBin.row,
                  col: selectedBin.col,
                  levelSuffix:
                    (grid.config.levels ?? 1) > 1 ? ` · L${selectedBin.level + 1}` : '',
                })}
              </p>
            </div>
          ) : (
            <div className="p-3">
              <p className="text-[11px] text-muted-foreground">
                {t('sidePanel.binPickHint', {
                  defaultValue: 'Click a cell on the map to choose which bin to edit.',
                })}
              </p>
            </div>
          )}
          <div className="p-3 pt-0">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => actions?.onOpenBinEditor?.()}
              disabled={!selectedBin || selectedBin.gridId !== grid.id}
              title={t('sidePanel.editBin', { defaultValue: 'Edit bin properties' })}
            >
              <Boxes className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.editBin', { defaultValue: 'Edit bin properties' })}
            </Button>
          </div>
        </div>
      </Section>

      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant={isMoving ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isMoving) actions?.onCancelTransform?.()
                else actions?.onStartMove?.(grid.id!)
              }}
              title={t('sidePanel.move')}
              aria-label={t('sidePanel.move')}
            >
              <Move className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.move')}
            </Button>
            <Button
              variant={isRotating ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isRotating) actions?.onCancelTransform?.()
                else actions?.onStartRotate?.(grid.id!)
              }}
              title={t('sidePanel.rotate')}
              aria-label={t('sidePanel.rotate')}
            >
              <RotateCw className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.rotate')}
            </Button>
            <Button
              variant={isScaling ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isScaling) actions?.onCancelTransform?.()
                else actions?.onStartScale?.(grid.id!)
              }}
              disabled={geometryLocked}
              title={
                geometryLocked
                  ? t('sidePanel.lockedTooltip', { defaultValue: 'Disabled — grid is linked to external data' })
                  : t('sidePanel.scale')
              }
              aria-label={t('sidePanel.scale')}
            >
              {geometryLocked ? (
                <Lock className="w-3.5 h-3.5 me-1.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              )}
              {t('sidePanel.scale')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions?.onRedraw?.(grid.id!)}
              disabled={geometryLocked}
              title={
                geometryLocked
                  ? t('sidePanel.lockedTooltip', { defaultValue: 'Disabled — grid is linked to external data' })
                  : t('sidePanel.redraw')
              }
              aria-label={t('sidePanel.redraw')}
            >
              {geometryLocked ? (
                <Lock className="w-3.5 h-3.5 me-1.5" />
              ) : (
                <Crosshair className="w-3.5 h-3.5 me-1.5" />
              )}
              {t('sidePanel.redraw')}
            </Button>
          </div>
          {(isMoving || isRotating || isScaling) && (
            <p className="text-[11px] text-muted-foreground px-1">
              {isMoving
                ? t('sidePanel.moveHint')
                : isRotating
                  ? t('sidePanel.rotateHint')
                  : t('sidePanel.gridScaleHint')}
            </p>
          )}
          <div className="grid grid-cols-3 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions?.onDuplicate?.(grid.id!)}
              title={t('sidePanel.duplicate')}
              aria-label={t('sidePanel.duplicate')}
            >
              <Copy className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.duplicate')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  actions?.onDeleteSelected?.()
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
              title={t('sidePanel.delete')}
              aria-label={t('sidePanel.delete')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">{t('sidePanel.confirmDeleteHint')}</p>
          )}
          <div className="grid grid-cols-3 gap-1.5 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onFitToGrid?.()}
              title={t('sidePanel.fitToGrid')}
              aria-label={t('sidePanel.fitToGrid')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onExportGeoJSON?.()}
              title={t('sidePanel.exportGeoJSON')}
              aria-label={t('sidePanel.exportGeoJSON')}
            >
              <Download className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.geoJSON')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onExportPNG?.()}
              title={t('sidePanel.exportPNG')}
              aria-label={t('sidePanel.exportPNG')}
            >
              <ImageIcon className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.png')}
            </Button>
          </div>
        </div>
      </Section>

      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.color')}
            value={config.color}
            onChange={(v) => update('color', v)}
          />
          <ColorRow
            label={t('sidePanel.borderColor')}
            value={config.borderColor}
            onChange={(v) => update('borderColor', v)}
          />
          <SliderRow
            label={t('sidePanel.borderWidth')}
            value={config.borderWidth}
            onChange={(v) => update('borderWidth', v)}
            min={0}
            max={6}
            limitMax={LIMIT_STROKE_PX}
            step={0.5}
            suffix="px"
          />
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
          />
        </div>
      </Section>

      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ThreeDControls config={config} update={update} t={t} />
        </div>
      </Section>

      {config.type === 'square' && (
        <Section title={t('sidePanel.sectionVertical')} icon={LayersIcon}>
          <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
            <div className="space-y-1.5">
              <Label className="flex items-center justify-between text-xs">
                <span>{t('sidePanel.cellGap')}</span>
                <span className="font-mono text-muted-foreground">
                  {formatLength(config.cellGap ?? 0, config.unit)}
                </span>
              </Label>
              <NumberInput
                value={config.cellGap ?? 0}
                unit={config.unit}
                min={0}
                onChange={(meters) => update('cellGap', Math.max(0, meters))}
                ariaLabel={t('sidePanel.cellGap')}
              />
            </div>
            <VerticalControls config={config} update={update} t={t} />
          </div>
        </Section>
      )}

      <LabelSection config={config} update={update} showHeader />
    </>
  )
}

// ---- Bulk selected content (2+ grids selected) ---------------------------

function BulkSelectedContent({
  count,
  config,
  onConfigChange,
  actions,
  confirmDelete,
  setConfirmDelete,
}: {
  count: number
  config: GridConfig
  onConfigChange: (config: GridConfig) => void
  actions?: SidePanelActions
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
}) {
  const { t } = useTranslation()
  const update = <K extends keyof GridConfig>(key: K, value: GridConfig[K]) => {
    onConfigChange({ ...config, [key]: value })
  }
  return (
    <>
      <Section title={t('sidePanel.sectionBulkActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onFitToGrid?.()}
              title={t('sidePanel.fitToGrid')}
              aria-label={t('sidePanel.fitToGrid')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  actions?.onDeleteSelected?.()
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
              title={t('sidePanel.deleteAll')}
              aria-label={t('sidePanel.deleteAll')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.deleteAll')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t('sidePanel.confirmDeleteAllHint', { count })}
            </p>
          )}
        </div>
      </Section>
      <Section title={t('sidePanel.sectionBulkEdit')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.color')}
            value={config.color}
            onChange={(v) => update('color', v)}
          />
          <ColorRow
            label={t('sidePanel.borderColor')}
            value={config.borderColor}
            onChange={(v) => update('borderColor', v)}
          />
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={0}
            max={100}
            step={0.1}
            suffix="%"
          />
          <ThreeDControls config={config} update={update} t={t} />
        </div>
      </Section>
    </>
  )
}

// ---- Model selected panel -----------------------------------------------

/**
 * Renders the dedicated `ModelEditor` inside the SidePanel body. The
 * editor lives in its own component so the rotation/scale/material/
 * animation form logic doesn't pile into this 5k-line file — same
 * split we use for `BinEditor`.
 */
function ModelSelectedContent({
  model,
  onPatch,
  onSwapAsset,
  onDelete,
  onDuplicate,
  onMoveMode,
  moveActive,
  onCancelMove,
  onEditLinkedData,
}: {
  model: ModelShape
  onPatch: (patch: {
    config?: Partial<import('@/lib/shapes').ModelShapeConfig>
    name?: string
    visible?: boolean
  }) => void
  onSwapAsset?: () => void
  onDelete?: () => void
  onDuplicate?: () => void
  onMoveMode?: () => void
  moveActive?: boolean
  onCancelMove?: () => void
  onEditLinkedData?: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <ModelEditor
        shape={model}
        onChange={onPatch}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onSwapAsset={onSwapAsset}
        onMoveMode={onMoveMode}
        moveActive={moveActive}
        onCancelMove={onCancelMove}
      />

      <LinkedDataBlock kind="model" shapeId={model.id} />

      {onEditLinkedData && (
        <div className="px-3 pb-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onEditLinkedData}
            title={t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          >
            <Boxes className="w-3.5 h-3.5 me-1.5" />
            {t('sidePanel.editLinkedData', { defaultValue: 'Edit linked data' })}
          </Button>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Text label — mirrors the marker UX: Saved list section, placement panel,
// and selected panel built from a shared TextLabelPropertiesForm.
// ---------------------------------------------------------------------------

const TEXT_EFFECT_PRESETS: ReadonlyArray<{
  id: import('@/lib/shapes').TextEffectPreset
  labelKey: string
  fallback: string
}> = [
  { id: 'normal', labelKey: 'sidePanel.textPresetNormal', fallback: 'Normal' },
  { id: 'glow', labelKey: 'sidePanel.textPresetGlow', fallback: 'Glow' },
  { id: 'outlined', labelKey: 'sidePanel.textPresetOutlined', fallback: 'Outlined' },
  { id: 'subtle', labelKey: 'sidePanel.textPresetSubtle', fallback: 'Subtle' },
  { id: 'sign', labelKey: 'sidePanel.textPresetSign', fallback: 'Sign' },
]

const TEXT_ANCHOR_OPTIONS: ReadonlyArray<{
  id: import('@/lib/shapes').TextAnchor
  label: string
}> = [
  { id: 'top-left', label: '↖' },
  { id: 'top', label: '↑' },
  { id: 'top-right', label: '↗' },
  { id: 'left', label: '←' },
  { id: 'center', label: '•' },
  { id: 'right', label: '→' },
  { id: 'bottom-left', label: '↙' },
  { id: 'bottom', label: '↓' },
  { id: 'bottom-right', label: '↘' },
]

/**
 * Saved text-labels list — workspace tree section. Mirrors the
 * SavedMarkersContent layout: a color swatch, an InlineNameCell with
 * `#id · "label text"` subtitle, a Fit button and a Delete button with
 * confirm-second-click.
 */
function SavedTextLabelsContent({
  textLabels,
  selectedTextLabelIds,
  actions,
}: {
  textLabels?: ReadonlyArray<import('@/lib/shapes').TextLabelShape>
  selectedTextLabelIds?: ReadonlySet<number>
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const query = useWorkspaceQuery()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const list = (textLabels ?? []).filter((l) =>
    matchesWorkspaceQuery(l.name, query),
  )
  if (list.length === 0) return null
  const onSelect = (id: number, e: React.MouseEvent) => {
    actions?.onSelectTextLabel?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
  }
  return (
    <Section title={t('sidePanel.savedTextLabelsTitle', { defaultValue: 'Saved text labels' })} icon={Type}>
      <VirtualList
        items={list}
        keyFor={(l) => l.id!}
        renderItem={(l) => {
          const id = l.id!
          const isSelected = selectedTextLabelIds?.has(id) ?? false
          const showConfirm = confirmDeleteId === id
          const truncatedText =
            l.config.text.length > 24
              ? `${l.config.text.slice(0, 24)}…`
              : l.config.text
          return (
            <div
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded border bg-background/40 hover:bg-accent/40 transition-colors',
                isSelected && 'ring-1 ring-primary bg-accent/30',
              )}
            >
              {/* A small letter swatch tinted with the label's color —
                  parallel to the colored circle the SavedCirclesContent
                  uses, but more legible for text shapes. */}
              <span
                className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded border bg-background"
                style={{
                  color: l.config.color,
                  borderColor: l.config.haloColor,
                }}
                aria-hidden="true"
              >
                T
              </span>
              <InlineNameCell
                name={l.name}
                subtitle={
                  <>
                    #{id} · <span className="italic">{truncatedText}</span>
                  </>
                }
                onSelect={(e) => onSelect(id, e)}
                onCommit={(next) => actions?.onRenameTextLabel?.(id, next)}
                titleAttr={`#${id} ${l.name}`}
              />
              <EyeToggleButton
                visible={l.visible}
                onToggle={(next) => actions?.onToggleTextLabelVisible?.(id, next)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => actions?.onFitToTextLabelById?.(id)}
                title={t('sidePanel.fit')}
                aria-label={t('sidePanel.fit')}
              >
                <Maximize2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-6 w-6',
                  showConfirm &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90',
                )}
                onClick={() => {
                  if (showConfirm) {
                    actions?.onDeleteTextLabelById?.(id)
                    setConfirmDeleteId(null)
                  } else {
                    setConfirmDeleteId(id)
                    setTimeout(
                      () =>
                        setConfirmDeleteId((v) => (v === id ? null : v)),
                      3000,
                    )
                  }
                }}
                title={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
                aria-label={
                  showConfirm ? t('sidePanel.confirmDelete') : t('sidePanel.delete')
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )
        }}
      />
    </Section>
  )
}

// ---- Shared properties form ---------------------------------------------

/**
 * Mirrors MarkerPropertiesForm — one consistent set of sections, used by
 * both the placement panel and the selected panel. Sections:
 *   Content + Effect → Appearance → 3D → Alignment & Typography.
 */
function TextLabelPropertiesForm({
  config,
  unit,
  onChange,
}: {
  config: import('@/lib/shapes').TextLabelConfig
  /** Display unit for elevation field. */
  unit: LengthUnit
  onChange: (next: import('@/lib/shapes').TextLabelConfig) => void
}) {
  const { t } = useTranslation()
  const update = <K extends keyof import('@/lib/shapes').TextLabelConfig>(
    key: K,
    value: import('@/lib/shapes').TextLabelConfig[K],
  ) => onChange({ ...config, [key]: value })

  return (
    <>
      <Section title={t('sidePanel.textContent', { defaultValue: 'Content' })} icon={Type}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('sidePanel.textBody', { defaultValue: 'Text' })}
            </Label>
            <TextField
              value={config.text}
              onCommit={(text) => update('text', text)}
              placeholder={t('sidePanel.textBodyPlaceholder', {
                defaultValue: 'Label text',
              })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('sidePanel.textPreset', { defaultValue: 'Effect preset' })}
            </Label>
            <div className="grid grid-cols-5 gap-1">
              {TEXT_EFFECT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => update('preset', p.id)}
                  className={cn(
                    'px-1.5 py-1 text-[10px] rounded border transition-colors',
                    config.preset === p.id
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card hover:bg-accent border-input text-muted-foreground',
                  )}
                  title={t(p.labelKey, { defaultValue: p.fallback })}
                >
                  {t(p.labelKey, { defaultValue: p.fallback })}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {t('sidePanel.textPresetHint', {
                defaultValue:
                  'Presets adjust halo + emissive glow. Custom changes below are preserved.',
              })}
            </p>
          </div>
        </div>
      </Section>

      <Section title={t('sidePanel.sectionAppearance')} icon={Palette}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ColorRow
            label={t('sidePanel.textColor', { defaultValue: 'Text color' })}
            value={config.color}
            onChange={(v) => update('color', v)}
          />
          <SliderRow
            label={t('sidePanel.textSize', { defaultValue: 'Size' })}
            value={config.size}
            onChange={(v) => update('size', v)}
            min={8}
            max={72}
            limitMax={LIMIT_SYMBOL_SIZE_PX}
            step={0.1}
            suffix="px"
          />
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('sidePanel.textSizeMode', { defaultValue: 'Size behaviour' })}
            </Label>
            <div className="grid grid-cols-3 gap-1">
              {(['screen', 'fixed', 'shape'] as const).map((m) => {
                // Legacy fixedSize=true rows resolve to 'fixed' for the
                // active-state check so an older label still shows the
                // right button highlighted.
                const active = (config.sizeMode ?? (config.fixedSize ? 'fixed' : 'screen')) === m
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onChange({
                      ...config,
                      sizeMode: m,
                      // Clear the legacy alias so it can't drift out of sync.
                      fixedSize: undefined,
                    })}
                    className={cn(
                      'px-1.5 py-1 text-[10px] rounded border transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card hover:bg-accent border-input text-muted-foreground',
                    )}
                    title={t(`sidePanel.textSizeMode_${m}_hint`, {
                      defaultValue:
                        m === 'screen' ? 'Default. Shrinks slightly at low zoom.'
                        : m === 'fixed' ? 'Always the authored pixel size on screen.'
                        : 'Scales with the map — label stays inside its shape.',
                    })}
                  >
                    {t(`sidePanel.textSizeMode_${m}`, {
                      defaultValue:
                        m === 'screen' ? 'Follow zoom'
                        : m === 'fixed' ? 'Fixed'
                        : 'In shape',
                    })}
                  </button>
                )
              })}
            </div>
            <p className="text-[10px] text-muted-foreground leading-tight">
              {t('sidePanel.textSizeModeHint', {
                defaultValue: '“In shape” makes the label scale with the map so it stays inside its container as you zoom out.',
              })}
            </p>
          </div>
          <SliderRow
            label={t('sidePanel.opacity')}
            value={config.opacity}
            onChange={(v) => update('opacity', v)}
            min={10}
            max={100}
            step={0.1}
            suffix="%"
          />
          <div className="pt-2 mt-2 space-y-3 border-t">
            <ColorRow
              label={t('sidePanel.textHaloColor', { defaultValue: 'Halo color' })}
              value={config.haloColor}
              onChange={(v) => update('haloColor', v)}
            />
            <SliderRow
              label={t('sidePanel.textHaloWidth', { defaultValue: 'Halo width' })}
              value={config.haloWidth}
              onChange={(v) => update('haloWidth', v)}
              min={0}
              max={6}
              limitMax={LIMIT_HALO_PX}
              step={0.25}
              suffix="px"
              decimals={1}
            />
            <SliderRow
              label={t('sidePanel.textHaloBlur', { defaultValue: 'Halo blur' })}
              value={config.haloBlur}
              onChange={(v) => update('haloBlur', v)}
              min={0}
              max={6}
              limitMax={LIMIT_HALO_PX}
              step={0.25}
              suffix="px"
              decimals={1}
            />
            <div className="space-y-1.5">
              <SliderRow
                label={t('sidePanel.textEmissive', { defaultValue: 'Emissive glow' })}
                value={config.emissive}
                onChange={(v) => update('emissive', v)}
                min={0}
                max={3}
                step={0.1}
                suffix="x"
                decimals={1}
              />
              <p className="text-[10px] text-muted-foreground">
                {t('sidePanel.textEmissiveHint', {
                  defaultValue:
                    'Keeps text readable under the 3D lighting model. Crank for a glow effect.',
                })}
              </p>
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('sidePanel.section3D')} icon={Box}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.elevation')}</span>
              <span className="font-mono text-muted-foreground">
                {config.elevation === 0
                  ? t('sidePanel.flat')
                  : formatLength(config.elevation, unit)}
              </span>
            </Label>
            <NumberInput
              value={config.elevation}
              unit={unit}
              min={0}
              max={LIMIT_ELEVATION_M}
              onChange={(meters) => update('elevation', Math.max(0, meters))}
              ariaLabel={t('sidePanel.elevation')}
            />
            <StretchSlider
              value={config.elevation}
              onValueChange={(v) => update('elevation', v)}
              min={0}
              max={500}
              limitMax={LIMIT_ELEVATION_M}
              step={0.1}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center justify-between text-xs">
              <span>{t('sidePanel.textOcclusion', { defaultValue: 'See-through 3D' })}</span>
              <span className="font-mono text-muted-foreground">
                {Math.round(config.occlusionOpacity * 100)}%
              </span>
            </Label>
            <Slider
              value={[config.occlusionOpacity]}
              onValueChange={(v) => update('occlusionOpacity', v[0])}
              min={0}
              max={1}
              step={0.05}
            />
            <p className="text-[10px] text-muted-foreground">
              {t('sidePanel.textOcclusionHint', {
                defaultValue:
                  '0% hides text behind buildings. 100% shows it through everything.',
              })}
            </p>
          </div>
        </div>
      </Section>

      <Section title={t('sidePanel.textAlignment', { defaultValue: 'Alignment & typography' })} icon={AlignCenter}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('sidePanel.textAlignmentMode', { defaultValue: 'Orientation' })}
            </Label>
            <div className="grid grid-cols-2 gap-1">
              {(['viewport', 'map'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => update('pitchAlignment', m)}
                  className={cn(
                    'px-2 py-1.5 text-xs rounded border transition-colors',
                    config.pitchAlignment === m
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card hover:bg-accent border-input',
                  )}
                  title={
                    m === 'viewport'
                      ? t('sidePanel.textAlignViewportHint', {
                          defaultValue: 'Billboard — always faces the camera',
                        })
                      : t('sidePanel.textAlignMapHint', {
                          defaultValue: 'Lies flat on the map — tilts with the camera',
                        })
                  }
                >
                  {m === 'viewport'
                    ? t('sidePanel.textAlignViewport', { defaultValue: 'Billboard' })
                    : t('sidePanel.textAlignMap', { defaultValue: 'On map' })}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('sidePanel.textAnchor', { defaultValue: 'Anchor' })}
            </Label>
            <div className="inline-grid grid-cols-3 gap-1 p-1 border rounded bg-card">
              {TEXT_ANCHOR_OPTIONS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => update('anchor', a.id)}
                  className={cn(
                    'h-7 w-7 text-sm rounded transition-colors',
                    config.anchor === a.id
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-accent',
                  )}
                  title={a.id}
                  aria-label={a.id}
                  aria-pressed={config.anchor === a.id}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('sidePanel.textWeight', { defaultValue: 'Weight' })}
              </Label>
              <div className="grid grid-cols-3 gap-1">
                {(['regular', 'bold', 'italic'] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => update('fontWeight', w)}
                    className={cn(
                      'px-1.5 py-1 text-[11px] rounded border transition-colors',
                      config.fontWeight === w
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card hover:bg-accent border-input',
                    )}
                  >
                    {t(`sidePanel.textWeight_${w}`, { defaultValue: w })}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('sidePanel.textCase', { defaultValue: 'Case' })}
              </Label>
              <div className="grid grid-cols-3 gap-1">
                {(['none', 'uppercase', 'lowercase'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => update('transform', c)}
                    className={cn(
                      'px-1.5 py-1 text-[11px] rounded border transition-colors font-medium',
                      config.transform === c
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card hover:bg-accent border-input',
                    )}
                  >
                    {c === 'none' ? 'Aa' : c === 'uppercase' ? 'AA' : 'aa'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <SliderRow
            label={t('sidePanel.textLetterSpacing', { defaultValue: 'Letter spacing' })}
            value={config.letterSpacing}
            onChange={(v) => update('letterSpacing', v)}
            min={-0.05}
            max={0.4}
            step={0.01}
            suffix="em"
            decimals={2}
          />
        </div>
      </Section>
    </>
  )
}

// ---- Placement panel -----------------------------------------------------

function TextLabelPlacementContent({
  config,
  unit,
  onConfigChange,
  onExit,
}: {
  config: import('@/lib/shapes').TextLabelConfig
  unit: LengthUnit
  onConfigChange: (cfg: import('@/lib/shapes').TextLabelConfig) => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('sidePanel.sectionPlacement')} icon={Crosshair}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <p className="text-[11px] text-muted-foreground">
            {t('sidePanel.textPlacementHint', {
              defaultValue:
                'Click anywhere on the map to drop the label. Edit the text and effects below — they apply to the live preview.',
            })}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onExit}
          >
            <X className="w-3.5 h-3.5 me-2" />
            {t('sidePanel.textPlacementExit', { defaultValue: 'Exit placement' })}
          </Button>
        </div>
      </Section>
      <TextLabelPropertiesForm
        config={config}
        unit={unit}
        onChange={onConfigChange}
      />
    </>
  )
}

// ---- Selected panel ------------------------------------------------------

function TextLabelSelectedContent({
  label,
  onConfigChange,
  onPatch,
  confirmDelete,
  setConfirmDelete,
  actions,
}: {
  label: import('@/lib/shapes').TextLabelShape
  onConfigChange: (cfg: import('@/lib/shapes').TextLabelConfig) => void
  onPatch?: (patch: Partial<import('@/lib/shapes').TextLabelShape>) => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  actions?: SidePanelActions
}) {
  const { t } = useTranslation()
  const isMoving =
    actions?.textLabelTransformActive && actions?.textLabelTransformKind === 'move'
  const isRotating =
    actions?.textLabelTransformActive && actions?.textLabelTransformKind === 'rotate'
  const isScaling =
    actions?.textLabelTransformActive && actions?.textLabelTransformKind === 'scale'
  return (
    <>
      <Section title={t('sidePanel.sectionActions')} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant={isMoving ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isMoving) actions?.onCancelTextLabelTransform?.()
                else actions?.onStartMoveTextLabel?.(label.id!)
              }}
              title={t('sidePanel.move')}
            >
              <Move className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.move')}
            </Button>
            <Button
              variant={isRotating ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isRotating) actions?.onCancelTextLabelTransform?.()
                else actions?.onStartRotateTextLabel?.(label.id!)
              }}
              title={t('sidePanel.rotate')}
            >
              <RotateCw className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.rotate')}
            </Button>
            <Button
              variant={isScaling ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (isScaling) actions?.onCancelTextLabelTransform?.()
                else actions?.onStartScaleTextLabel?.(label.id!)
              }}
              title={t('sidePanel.scale')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.scale')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions?.onFitToTextLabelById?.(label.id!)}
              title={t('sidePanel.fit')}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit')}
            </Button>
          </div>
          {(isMoving || isRotating || isScaling) && (
            <p className="text-[11px] text-muted-foreground px-1">
              {isMoving
                ? t('sidePanel.textMoveHint', {
                    defaultValue: 'Click on the label and drag to relocate it.',
                  })
                : isRotating
                  ? t('sidePanel.textRotateHint', {
                      defaultValue: 'Drag the orange dot around the label to rotate it.',
                    })
                  : t('sidePanel.textScaleHint', {
                      defaultValue: 'Drag the orange dot away/toward the label to resize.',
                    })}
            </p>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions?.onDuplicateTextLabel?.(label.id!)}
              title={t('sidePanel.duplicate')}
            >
              <Copy className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.duplicate')}
            </Button>
            <Button
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                if (confirmDelete) {
                  actions?.onDeleteTextLabelById?.(label.id!)
                  setConfirmDelete(false)
                } else {
                  setConfirmDelete(true)
                }
              }}
              title={t('sidePanel.delete')}
            >
              <Trash2 className="w-3.5 h-3.5 me-1.5" />
              {confirmDelete ? t('sidePanel.confirmDelete') : t('sidePanel.delete')}
            </Button>
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-destructive">
              {t('sidePanel.confirmDeleteHint')}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => onPatch?.({ visible: !label.visible })}
          >
            {label.visible ? (
              <Eye className="w-3.5 h-3.5 me-1.5" />
            ) : (
              <EyeOff className="w-3.5 h-3.5 me-1.5" />
            )}
            {label.visible
              ? t('sidePanel.hide', { defaultValue: 'Hide' })
              : t('sidePanel.show', { defaultValue: 'Show' })}
          </Button>
        </div>
      </Section>

      <Section title={t('sidePanel.sectionDimensions')} icon={Ruler}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <SliderRow
            label={
              <span className="flex items-center gap-1.5">
                <RotateCw className="w-3 h-3" />
                {t('sidePanel.textRotation', { defaultValue: 'Rotation' })}
              </span>
            }
            labelExtra={
              <button
                type="button"
                onClick={() => onPatch?.({ rotation: 0 })}
                className="font-mono transition-colors text-muted-foreground hover:text-foreground"
                title={t('sidePanel.rotationReset')}
                disabled={label.config.pitchAlignment === 'viewport'}
              >
                {label.rotation.toFixed(1).replace(/\.0$/, '')}°
              </button>
            }
            value={label.rotation}
            onChange={(v) => onPatch?.({ rotation: v })}
            min={-180}
            max={180}
            step={0.5}
            suffix="°"
            disabled={label.config.pitchAlignment === 'viewport'}
          />
          {label.config.pitchAlignment === 'viewport' && (
            <p className="text-[10px] text-muted-foreground">
              {t('sidePanel.textRotationHint', {
                defaultValue:
                  'Rotation only applies when orientation is set to "On map".',
              })}
            </p>
          )}
        </div>
      </Section>

      <TextLabelPropertiesForm
        config={label.config}
        unit={label.unit}
        onChange={onConfigChange}
      />

      <TooltipTriggerSection
        value={label.config.tooltipTrigger}
        onChange={(v) =>
          onConfigChange({ ...label.config, tooltipTrigger: v })
        }
      />

      <Section title={t('sidePanel.textPosition', { defaultValue: 'Position' })} icon={MapPin}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('sidePanel.markerLat')}
              </Label>
              <div className="mt-1 font-mono text-xs">
                {label.position[1].toFixed(6)}
              </div>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('sidePanel.markerLng')}
              </Label>
              <div className="mt-1 font-mono text-xs">
                {label.position[0].toFixed(6)}
              </div>
            </div>
          </div>
        </div>
      </Section>
    </>
  )
}

// ---- Image plane (3D image) selected content ---------------------------
//
// Side-panel section shown when a single `ImagePlaneShape` is selected.
// Exposes the 3D transform knobs (elevation + per-axis rotation + width
// / height + opacity) plus a delete button — mirrors the model panel's
// layout but with image-specific controls.

function ImagePlaneSelectedContent({
  plane,
  onPatch,
  onDelete,
  onFit,
  onDuplicate,
  onMoveMode,
  moveActive,
  onCancelMove,
  confirmDelete,
  setConfirmDelete,
}: {
  plane: import('@/lib/shapes').ImagePlaneShape
  onPatch: (patch: {
    config?: Partial<import('@/lib/shapes').ImagePlaneShapeConfig>
    name?: string
    visible?: boolean
  }) => void
  onDelete?: () => void
  onFit?: () => void
  onDuplicate?: () => void
  onMoveMode?: (id: number) => void
  moveActive?: boolean
  onCancelMove?: () => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
}) {
  const { t } = useTranslation()
  const cfg = plane.config
  const patchConfig = (next: Partial<import('@/lib/shapes').ImagePlaneShapeConfig>) =>
    onPatch({ config: next })
  return (
    <>
      <Section title={t('imagePlane.title', { defaultValue: 'Image plane' })} icon={Frame}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          {plane.imageUrl && (
            <img
              src={rewriteFilesUrlSameOrigin(plane.imageUrl)}
              alt={plane.name || 'Image plane preview'}
              className="w-full h-24 object-contain rounded border border-border bg-muted"
            />
          )}
        </div>
      </Section>

      <Section title={t('sidePanel.sectionActions', { defaultValue: 'Actions' })} icon={Wrench}>
        <div className="p-3 space-y-2 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-3 gap-1.5">
            <Button
              variant={moveActive ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (moveActive) {
                  onCancelMove?.()
                } else if (plane.id !== undefined) {
                  onMoveMode?.(plane.id)
                }
              }}
              disabled={!onMoveMode && !moveActive}
              title={t('sidePanel.move', { defaultValue: 'Move' })}
              aria-label={t('sidePanel.move', { defaultValue: 'Move' })}
            >
              <Move className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.move', { defaultValue: 'Move' })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onFit}
              disabled={!onFit}
              title={t('sidePanel.fit', { defaultValue: 'Fit' })}
              aria-label={t('sidePanel.fit', { defaultValue: 'Fit' })}
            >
              <Maximize2 className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.fit', { defaultValue: 'Fit' })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onDuplicate}
              disabled={!onDuplicate}
              title={t('sidePanel.duplicate', { defaultValue: 'Duplicate' })}
              aria-label={t('sidePanel.duplicate', { defaultValue: 'Duplicate' })}
            >
              <Copy className="w-3.5 h-3.5 me-1.5" />
              {t('sidePanel.duplicate', { defaultValue: 'Duplicate' })}
            </Button>
          </div>
          <Button
            variant={confirmDelete ? 'destructive' : 'outline'}
            size="sm"
            className="w-full"
            onClick={() => {
              if (confirmDelete) {
                onDelete?.()
                setConfirmDelete(false)
              } else {
                setConfirmDelete(true)
                setTimeout(() => setConfirmDelete(false), 3000)
              }
            }}
            disabled={!onDelete}
          >
            <Trash2 className="w-3.5 h-3.5 me-1.5" />
            {confirmDelete
              ? t('sidePanel.confirmDelete', { defaultValue: 'Click again to confirm' })
              : t('sidePanel.delete', { defaultValue: 'Delete' })}
          </Button>
        </div>
      </Section>

      <Section title={t('imagePlane.sizeSection', { defaultValue: 'Size & elevation' })} icon={Ruler}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <div className="grid grid-cols-2 gap-2">
            <ImagePlaneNumberField
              label={t('imagePlane.width', { defaultValue: 'Width (m)' })}
              value={cfg.width}
              min={0.1}
              step={0.5}
              onChange={(v) => patchConfig({ width: v })}
            />
            <ImagePlaneNumberField
              label={t('imagePlane.height', { defaultValue: 'Height (m)' })}
              value={cfg.height}
              min={0.1}
              step={0.5}
              onChange={(v) => patchConfig({ height: v })}
            />
          </div>
          <ImagePlaneSliderField
            label={t('imagePlane.elevation', { defaultValue: 'Elevation (m)' })}
            value={cfg.elevation}
            min={0}
            max={100}
            limitMax={LIMIT_ELEVATION_M}
            step={0.1}
            onChange={(v) => patchConfig({ elevation: v })}
          />
          <ImagePlaneSliderField
            label={t('imagePlane.opacity', { defaultValue: 'Opacity (%)' })}
            value={cfg.opacity}
            min={0}
            max={100}
            step={0.1}
            onChange={(v) => patchConfig({ opacity: v })}
          />
        </div>
      </Section>

      <Section title={t('imagePlane.rotationSection', { defaultValue: 'Rotation' })} icon={RotateCw}>
        <div className="p-3 space-y-3 border border-border/60 rounded-lg bg-card/50 backdrop-blur-sm shadow-sm">
          <ImagePlaneSliderField
            label={t('imagePlane.rotationX', { defaultValue: 'Tilt (X axis)' })}
            value={cfg.rotation[0]}
            min={-180}
            max={180}
            step={0.1}
            onChange={(v) =>
              patchConfig({ rotation: [v, cfg.rotation[1], cfg.rotation[2]] })
            }
          />
          <ImagePlaneSliderField
            label={t('imagePlane.rotationY', { defaultValue: 'Yaw (Y axis)' })}
            value={cfg.rotation[1]}
            min={-180}
            max={180}
            step={0.1}
            onChange={(v) =>
              patchConfig({ rotation: [cfg.rotation[0], v, cfg.rotation[2]] })
            }
          />
          <ImagePlaneSliderField
            label={t('imagePlane.rotationZ', { defaultValue: 'Roll (Z axis)' })}
            value={cfg.rotation[2]}
            min={-180}
            max={180}
            step={0.1}
            onChange={(v) =>
              patchConfig({ rotation: [cfg.rotation[0], cfg.rotation[1], v] })
            }
          />
        </div>
      </Section>
    </>
  )
}

/**
 * Number input that commits **on blur or Enter** — not on every
 * keystroke. Same rationale as `ImagePlaneSliderField`: avoid spamming
 * the spatial store on every digit typed.
 */
function ImagePlaneNumberField({
  label,
  value,
  min,
  step,
  onChange,
}: {
  label: string
  value: number
  min?: number
  step?: number
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  // Sync incoming `value` into the display when the user isn't editing.
  const display = draft ?? String(value)
  const commit = () => {
    const n = Number(draft ?? value)
    if (Number.isFinite(n) && n !== value) onChange(n)
    setDraft(null)
  }
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        value={display}
        min={min}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.currentTarget as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            setDraft(null)
            ;(e.currentTarget as HTMLInputElement).blur()
          }
        }}
        className="h-8 text-xs"
      />
    </div>
  )
}

/**
 * Slider field that **commits to the parent only on release** (not on
 * every drag tick). The thumb tracks a local `draft` state during the
 * drag so the UI feels responsive, and `onChange` fires once on
 * `onValueCommit`. Without this, every pixel of drag would enqueue a
 * spatial-store patch and the side panel + map would lag.
 */
function ImagePlaneSliderField({
  label,
  value,
  min,
  max,
  limitMax,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  /** Let typed values (and the stretching slider) go past `max`. */
  limitMax?: number
  step: number
  onChange: (v: number) => void
}) {
  // Local draft of the thumb position. Synced from props when the
  // user isn't dragging (so external updates — e.g. the user typed in
  // the width input — still reflect on the slider).
  const [draft, setDraft] = useState<number | null>(null)
  const display = draft ?? value
  const stretches = limitMax !== undefined && limitMax > max
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px] text-muted-foreground">{label}</Label>
        <NumberInput
          value={display}
          onChange={onChange}
          min={min}
          max={stretches ? limitMax : max}
          step={step}
          decimals={step < 1 ? 1 : 0}
          hideSpinner
          ariaLabel={label}
          className="w-20"
          inputClassName="text-[11px]"
        />
      </div>
      <StretchSlider
        value={display}
        min={min}
        max={max}
        limitMax={limitMax}
        step={step}
        onValueChange={setDraft}
        onValueCommit={(v) => {
          setDraft(null)
          onChange(v)
        }}
      />
    </div>
  )
}
