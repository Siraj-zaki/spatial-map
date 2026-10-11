import { MapFloorBaseOverlay } from '@/components/map-floor-base-overlay'
import { useAIMapTool } from '@/routes/create-grids/hooks/useAIMapTool'
import { AIDetectionReviewDialog } from '@/components/ai-detection-review-dialog'
import { MapAIDetectionOverlay } from '@/components/map-ai-detection-overlay'
import { MapRoutePreviewOverlay } from '@/components/map-route-preview-overlay'
import { RouteDirectionsPanel } from '@/components/route-directions-panel'
import { acceptDetection, type AcceptResult } from '@/lib/ai-accept'
import type { AIDetection } from '@/lib/ai-client'
import { useEditorBootstrap } from '@/routes/create-grids/hooks/useEditorBootstrap'
import { useMapLifecycle } from '@/routes/create-grids/hooks/useMapLifecycle'
import { useMapRotation } from '@/routes/create-grids/hooks/useMapRotation'
import { useCirclePlacementTool } from '@/routes/create-grids/hooks/useCirclePlacementTool'
import { useDoorPlacementTool } from '@/routes/create-grids/hooks/useDoorPlacementTool'
import { useRoutePreviewTool } from '@/routes/create-grids/hooks/useRoutePreviewTool'
import { useGridDrawTool } from '@/routes/create-grids/hooks/useGridDrawTool'
import { useKeyboardDispatch } from '@/routes/create-grids/hooks/useKeyboardDispatch'
import { OverlayStack } from '@/routes/create-grids/layers/OverlayStack'
import { SecondaryLayers } from '@/routes/create-grids/layers/SecondaryLayers'
import { DataLinkPill } from '@/routes/create-grids/panels/DataLinkPill'
import { StatusBar } from '@/routes/create-grids/panels/StatusBar'
import { WarehousePill } from '@/routes/create-grids/panels/WarehousePill'
import { SaveStatus, useUnsavedEditsGuard } from '@/routes/create-grids/panels/SaveStatus'
import { useStableCallback } from '@/hooks/useStableCallback'
import { copyName } from '@/lib/copy-name'
import { toast } from '@/lib/toast-store'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { EditorDialogs } from '@/routes/create-grids/dialogs/EditorDialogs'
import { ExportDialog } from '@/components/export-dialog'
import { useImagePlacementTool } from '@/routes/create-grids/hooks/useImagePlacementTool'
import { useLineDrawTool } from '@/routes/create-grids/hooks/useLineDrawTool'
import { useMarkerPlacementTool } from '@/routes/create-grids/hooks/useMarkerPlacementTool'
import { useModelPlacementTool } from '@/routes/create-grids/hooks/useModelPlacementTool'
import { usePolygonDrawTool } from '@/routes/create-grids/hooks/usePolygonDrawTool'
import { useRouteDrawTool } from '@/routes/create-grids/hooks/useRouteDrawTool'
import { useStairPlacementTool } from '@/routes/create-grids/hooks/useStairPlacementTool'
import { useTextLabelPlacementTool } from '@/routes/create-grids/hooks/useTextLabelPlacementTool'
import { useTransformCancelHandlers } from '@/routes/create-grids/hooks/useTransformCancelHandlers'
import { useBulkHandlers } from '@/routes/create-grids/handlers/useBulkHandlers'
import { fitBoundsIfOffscreen } from '@/routes/create-grids/handlers/fitToShapeOnSelect'
import { useCircleHandlers } from '@/routes/create-grids/handlers/useCircleHandlers'
import { useDoorHandlers } from '@/routes/create-grids/handlers/useDoorHandlers'
import { useGridHandlers } from '@/routes/create-grids/handlers/useGridHandlers'
import { useImageHandlers } from '@/routes/create-grids/handlers/useImageHandlers'
import { useLineHandlers } from '@/routes/create-grids/handlers/useLineHandlers'
import { useMarkerHandlers } from '@/routes/create-grids/handlers/useMarkerHandlers'
import { useModelHandlers } from '@/routes/create-grids/handlers/useModelHandlers'
import { usePolygonHandlers } from '@/routes/create-grids/handlers/usePolygonHandlers'
import { useRouteHandlers } from '@/routes/create-grids/handlers/useRouteHandlers'
import { useStairHandlers } from '@/routes/create-grids/handlers/useStairHandlers'
import { useTextLabelHandlers } from '@/routes/create-grids/handlers/useTextLabelHandlers'
import { useCircleEditorState } from '@/routes/create-grids/state/useCircleEditorState'
import { useDoorEditorState } from '@/routes/create-grids/state/useDoorEditorState'
import { useGridEditorState } from '@/routes/create-grids/state/useGridEditorState'
import { useImageEditorState } from '@/routes/create-grids/state/useImageEditorState'
import { useImagePlaneEditorState } from '@/routes/create-grids/state/useImagePlaneEditorState'
import { useLineEditorState } from '@/routes/create-grids/state/useLineEditorState'
import { useMarkerEditorState } from '@/routes/create-grids/state/useMarkerEditorState'
import { useModelEditorState } from '@/routes/create-grids/state/useModelEditorState'
import { usePolygonEditorState } from '@/routes/create-grids/state/usePolygonEditorState'
import { useRouteEditorState } from '@/routes/create-grids/state/useRouteEditorState'
import { useStairEditorState } from '@/routes/create-grids/state/useStairEditorState'
import { useTextLabelEditorState } from '@/routes/create-grids/state/useTextLabelEditorState'
import { KeyboardHint } from '@/components/keyboard-status-bar'
import { DataLinkFullScreenLoader } from '@/components/data-link/data-link-loader'
import { type CommittedLine } from '@/components/map-grid-overlay'
import {
  MapToolbar,
  type LayerVisibility,
  type LayerVisibilityKind,
  type MapToolbarTool,
} from '@/components/map-toolbar'
import { MapboxMap } from '@/components/mapbox-map'
import { CadImportDialog } from '@/components/cad-import-dialog'
import { PdfPagePicker } from '@/components/pdf-page-picker'
import { type ShapeEditorTarget } from '@/components/shape-data-editor'
import { ShortcutsCheatsheet } from '@/components/shortcuts-cheatsheet'
import {
  DEFAULT_LAYER_ORDER,
  SIDE_PANEL_DEFAULT_CONFIG,
  SidePanel,
  type LayerKind,
  type SidePanelActions,
  type SidePanelMode,
} from '@/components/side-panel'
import {
  useSpatialBins,
  useSpatialCircles,
  useSpatialDataLinks,
  useSpatialGrids,
  useSpatialImages,
  useSpatialLines,
  useSpatialRoutes,
  useSpatialMarkers,
  useSpatialImagePlanes,
  useSpatialModels,
  useSpatialPolygons,
  useSpatialStairs,
  useSpatialStyleRules,
  useSpatialTextLabels,
  useSpatialZones,
} from '@/hooks/useSpatialShapes'
import { apiDb } from '@/lib/api-db'
import { apiPost } from '@/lib/api-client'
import {
  backfillGridConfig,
  backfillImageConfig,
  backfillMarkerConfig,
  getDisplayUnit,
  setDisplayUnit,
  type Grid,
} from '@/lib/db'
import { useDoorStore } from '@/lib/door/store'
import {
  exportAllShapesAsGeoJSON,
  exportMapAsPNG,
  importGridsFromGeoJSONFile,
  updateGridGeometry,
} from '@/lib/export'
import { distanceMeters, type GridConfig } from '@/lib/grid-generators'
import { generateMagicWallPolylines } from '@/lib/magic-wall-generator'
import { usePersistedState } from '@/lib/persisted-state'
import { gridHistory } from '@/lib/grid-history'
import { imageCorners, imageLngLatToUV } from '@/lib/image-generators'
import {
  backfillUserModelBounds,
  backfillUserModelInspectors,
  useModelBoundingCenterMap,
  useModelBoundsMap,
  useModelInspectorMap,
  useModelUrlMap,
} from '@/lib/model-assets'
import {
  liftFloorPlanIds,
  type CircleShape,
  type ImagePlaneShape,
  type ImageShape,
  type LineShape,
  type RouteShape,
  type MarkerShape,
  type ModelShape,
  type PolygonShape,
  type StairShape,
  type TextLabelShape,
} from '@/lib/shapes'
import { getSpatialEntity, patchSpatialEntity, saveSpatialEntity, useSpatialStore, type EntityKind } from '@/lib/spatial-store'
import { resolveStyleMaps } from '@/lib/style-rules'
import { defaultUnitForLocale, type LengthUnit } from '@/lib/units'
import { queryCache } from '@/lib/useApiQuery'
import { ArrowRightLeft, Eye, EyeOff, Trash2, Wand2, X as XIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

interface CreateGridsProps {
  panelOpen: boolean
  onPanelOpenChange: (open: boolean) => void
  /** When true, this route acts as the live preview / operations view.
   *  Live overlays, stream schedulers, and alerts are enabled. When false
   *  (the default), it is the design-time editor and stays quiet. */
  preview?: boolean
}

const EMPTY_GRIDS: ReadonlyArray<never> = Object.freeze([]) as ReadonlyArray<never>

export default function CreateGrids({ panelOpen, onPanelOpenChange, preview = false }: CreateGridsProps) {
  const { t, i18n } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const [rootWidth, setRootWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setRootWidth(Math.round(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const {
    activeWarehouseId,
    activeWarehouseIdRef,
    defaultFloorPlanId,
    defaultFloorPlanIdRef,
    handleDefaultFloorPlanChange,
    floorPlanOrder,
    handleReorderFloorPlans,
    pinWarehouseCenterIfNeeded,
    initialViewportSetRef,
  } = useEditorBootstrap(preview)

  const navigate = useNavigate()

  /**
   * The cell the user has clicked. Tracks "which cell is the next bin
   * edit targeting" — does NOT control dialog visibility. Cleared when
   * the user selects another shape kind or deselects everything.
   */
  const [selectedBin, setSelectedBin] = useState<
    { gridId: number; row: number; col: number; level: number } | null
  >(null)
  /**
   * Controls the BinEditor dialog. Opened by the sidebar's "Edit bin"
   * button (not by the cell click itself), so users keep a clear view
   * of the map until they ask for the editor.
   */
  const [binDialogOpen, setBinDialogOpen] = useState(false)
  /**
   * Linked-data editor target for non-grid shapes. The sidebar's
   * `onEditShapeData` action seeds this and opens the dialog; setting
   * `null` closes it. One state for all kinds (polygon / circle / line /
   * marker / image / model) so we don't need six separate dialogs.
   */
  const [shapeEditorTarget, setShapeEditorTarget] = useState<ShapeEditorTarget | null>(null)
  const [shapeEditorOpen, setShapeEditorOpen] = useState(false)
  /**
   * Controls the bulk-assign dialog (toolbar action). Opens with the
   * current multi-selection summary so the user sees exactly what
   * they're about to retag.
   */
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false)
  const [pendingDataLinkDelete, setPendingDataLinkDelete] = useState<number | null>(null)

  // Toolbar state. Two-way bound to <MapToolbar />.
  const [activeTool, setActiveTool] = useState<MapToolbarTool>('pan')

  // AI Map tool state. Owns the single in-flight detection job + SSE
  // subscription; the image-click dispatch below routes to it when
  // activeTool === 'ai-map'. Everything else in the editor is
  // unaffected — a session that never activates the tool never hits
  // any of this code path.
  const aiMap = useAIMapTool()
  // Which detection is highlighted on the map + in the review list.
  // Shared by the overlay (visual pop) and the dialog (border), so a
  // click on either side stays in sync.
  const [aiSelectedDetectionId, setAiSelectedDetectionId] = useState<string | null>(null)

  // Preview is a read-only operations view; never land in a creation tool
  // (adjusted during render rather than in an effect).
  if (preview && activeTool !== 'pan') setActiveTool('pan')

  // Magic-wall selection set. Distinct from `selectedPolygonIds` so
  // entering the mode doesn't disturb the user's prior polygon
  // selection. Cleared whenever the user leaves the magic-wall tool.
  const [magicWallSelectedPolygonIds, setMagicWallSelectedPolygonIds] =
    useState<Set<number>>(new Set())
  // True while a Generate is in flight — drives the sidebar's spinner
  // + the map's blocking overlay so the user can't click / drag / draw
  // during the batch create.
  const [magicWallBusy, setMagicWallBusy] = useState(false)
  // Leaving the magic-wall tool clears its selection (during render).
  if (activeTool !== 'magic-wall' && magicWallSelectedPolygonIds.size > 0) {
    setMagicWallSelectedPolygonIds(new Set())
  }

  // Data-Link import wizard visibility (CSV → bins, distinct from the
  // data-link editor).
  const [dataLinkOpen, setDataLinkOpen] = useState(false)
  // Data-link editor dialog (DESIGN-data-link.md Slice 2) — separate
  // from the file-import wizard above. Editing existing rows preloads
  // via `editingDataLinkId`; null = create a fresh binding.
  const [dataLinkEditorOpen, setDataLinkEditorOpen] = useState(false)
  const [editingDataLinkId, setEditingDataLinkId] = useState<number | null>(null)
  // Data-link MANAGER dialog (DESIGN-data-link-v2.md §1) — zone-wide
  // inventory reached from the map toolbar's Data flyout.
  const [dataLinkManagerOpen, setDataLinkManagerOpen] = useState(false)
  // Rich share-link dialog visibility. Opens against the currently-active
  // warehouse via the toolbar Share button; the dialog itself handles list
  // + create + edit + revoke + delete of share_links rows.
  const [shareLinkDialogOpen, setShareLinkDialogOpen] = useState(false)
  // Schema Builder dialog visibility.
  const [schemaBuilderOpen, setSchemaBuilderOpen] = useState(false)
  // Export shapes dialog visibility.
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  /**
   * Per-layer visibility — drives the toolbar's Layers dropdown and
   * each overlay's `committedVisible` prop. The two ad-hoc booleans
   * we used to keep here (`gridsVisible` + `zonesVisible`) collapsed
   * into this single map so adding a new layer kind is a one-line
   * change rather than a search-and-thread refactor.
   */
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>({
    grid: true,
    marker: true,
    circle: true,
    polygon: true,
    line: true,
    route: true,
    image: true,
    model: true,
    imagePlane: true,
    text: true,
    stair: true,
    door: true,
    zones: true,
  })
  const handleLayerVisibilityChange = useCallback(
    (kind: LayerVisibilityKind, visible: boolean) => {
      setLayerVisibility((prev) =>
        prev[kind] === visible ? prev : { ...prev, [kind]: visible },
      )
    },
    [],
  )
  // Back-compat aliases — the workspace tree section and `MapBinOverlay`
  // still read these as plain booleans. Sourced from the new map so
  // they stay in sync without touching every consumer.
  const gridsVisible = layerVisibility.grid
  const zonesVisible = layerVisibility.zones
  /**
   * Bottom→top render order of the reorderable overlay types. Mirrored
   * into JSX below so React mounts each overlay in this order, which in
   * turn dictates the order of Mapbox `addLayer` calls and thus the
   * canvas stacking. Markers are HTML DOM markers and always render on
   * top of the canvas, so they're not part of this list.
   *
   * Persistence: keyed PER-WAREHOUSE in the backend `app_settings`
   * key/value store under `warehouse:<id>:layerOrder`. The order
   * follows the user's drag-reorder gesture in the sidebar; we load
   * the saved order on warehouse switch (effect below) and debounce-
   * write back on every change. Falls back to `DEFAULT_LAYER_ORDER`
   * for warehouses that have never been customised.
   */
  const [layerOrder, setLayerOrder] = useState<LayerKind[]>(DEFAULT_LAYER_ORDER)
  // Tracks whether the current `layerOrder` was hydrated from the
  // backend for the active warehouse. Without this guard the very
  // first render's default-order value would be persisted back, overwriting
  // the user's saved order on the next mount.
  const layerOrderHydratedForRef = useRef<number | null>(null)
  // The order as last read from / written to settings — saving only when the
  // user's order differs from it keeps opening the editor from writing.
  const layerOrderStoredRef = useRef<string | null>(null)

  /**
   * Load the saved bottom→top layer order for the active warehouse from
   * the backend `app_settings` store, falling back to
   * `DEFAULT_LAYER_ORDER` when the user hasn't customised it yet. We
   * tolerate (a) missing keys, (b) corrupt JSON, and (c) entries that
   * don't validate against the current `LayerKind` enum — in any of
   * those cases we keep the default rather than crashing the editor.
   * The hydration ref is flipped so the persistence effect below
   * doesn't immediately re-write the default over the freshly-loaded
   * value.
   */
  useEffect(() => {
    if (activeWarehouseId === null) {
      layerOrderHydratedForRef.current = null
      return
    }
    const id = activeWarehouseId
    layerOrderHydratedForRef.current = null
    let cancelled = false
    const key = `warehouse:${id}:layerOrder`
    void (async () => {
      try {
        const row = await apiDb.settings.get(key)
        if (cancelled) return
        let next: LayerKind[] | null = null
        if (row?.value !== undefined && row.value !== null) {
          const raw =
            typeof row.value === 'string' ? row.value : JSON.stringify(row.value)
          try {
            const parsed = JSON.parse(raw)
            if (
              Array.isArray(parsed) &&
              parsed.every((k) => DEFAULT_LAYER_ORDER.includes(k as LayerKind))
            ) {
              // Heal missing kinds (e.g. a layer added to the codebase
              // after the user saved their order) by appending any
              // DEFAULT_LAYER_ORDER entries the stored list lacks.
              // Stored extras that no longer exist are dropped by the
              // `every` filter above.
              const stored = parsed as LayerKind[]
              const missing = DEFAULT_LAYER_ORDER.filter(
                (k) => !stored.includes(k),
              )
              next = [...stored, ...missing]
            }
          } catch {
            // corrupt value — fall through to defaults
          }
        }
        const resolved = next ?? DEFAULT_LAYER_ORDER
        layerOrderStoredRef.current = next ? JSON.stringify(resolved) : null
        setLayerOrder(resolved)
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[layer-order] load failed', err)
        setLayerOrder(DEFAULT_LAYER_ORDER)
      } finally {
        if (!cancelled) layerOrderHydratedForRef.current = id
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeWarehouseId])

  /**
   * Persist `layerOrder` whenever the user reorders rows in the
   * sidebar. Debounced 400 ms so a drag through several positions
   * emits one write instead of one per ordering tick. Gated on the
   * hydration ref so the initial default state doesn't write back
   * immediately and overwrite the saved order on first paint.
   */
  useEffect(() => {
    if (activeWarehouseId === null) return
    if (layerOrderHydratedForRef.current !== activeWarehouseId) return
    const id = activeWarehouseId
    const value = JSON.stringify(layerOrder)
    // Unchanged from what's stored, or the untouched default: nothing to save.
    if (value === (layerOrderStoredRef.current ?? JSON.stringify(DEFAULT_LAYER_ORDER))) return
    const handle = window.setTimeout(() => {
      const key = `warehouse:${id}:layerOrder`
      layerOrderStoredRef.current = value
      void apiDb.settings
        .put({ key, value: value as unknown as string })
        .catch((err) => {
          if (import.meta.env.DEV) console.warn('[layer-order] save failed', err)
        })
    }, 400)
    return () => window.clearTimeout(handle)
  }, [layerOrder, activeWarehouseId])

  // Default drawing config — used when the panel is in idle/live-draw mode.
  // Persisted to localStorage so the user's tuning (color, cell size, elevation,
  // labels, etc.) survives a page refresh.
  const [config, setConfig] = usePersistedState<GridConfig>(
    'sgv-draw-config:grid',
    () => SIDE_PANEL_DEFAULT_CONFIG,
  )

  // ---- Grid tool state -----------------------------------------------------
  const {
    selectedGridIds,
    setSelectedGridIds,
    redrawingGridId,
    setRedrawingGridId,
    transform,
    setTransform,
    transformDraft,
    setTransformDraft,
  } = useGridEditorState()

  // ---- Marker tool state ---------------------------------------------------
  const {
    selectedMarkerIds,
    setSelectedMarkerIds,
    markerConfig,
    setMarkerConfig,
    markerCursor,
    setMarkerCursor,
    markerTransform,
    setMarkerTransform,
  } = useMarkerEditorState()

  // ---- Circle tool state ---------------------------------------------------
  const {
    selectedCircleIds,
    setSelectedCircleIds,
    circleConfig,
    setCircleConfig,
    circleSubMode,
    setCircleSubMode,
    circleCellSize,
    setCircleCellSize,
    circleCellRadius,
    setCircleCellRadius,
    circleDragStart,
    setCircleDragStart,
    circleDragCursor,
    setCircleDragCursor,
    circleGridStart,
    setCircleGridStart,
    circleGridCursor,
    setCircleGridCursor,
    circleTransform,
    setCircleTransform,
    circleTransformDraft,
    setCircleTransformDraft,
  } = useCircleEditorState()

  // ---- Polygon tool state --------------------------------------------------
  const {
    selectedPolygonIds,
    setSelectedPolygonIds,
    polygonConfig,
    setPolygonConfig,
    polygonDraftVertices,
    setPolygonDraftVertices,
    polygonDraftCursor,
    setPolygonDraftCursor,
    polygonTransform,
    setPolygonTransform,
    polygonTransformDraft,
    setPolygonTransformDraft,
    selectedPolygonIdsRef,
    polygonVerticesRef,
  } = usePolygonEditorState()

  // ---- Line tool state -----------------------------------------------------
  const {
    selectedLineIds,
    setSelectedLineIds,
    lineConfig,
    setLineConfig,
    lineDraftVertices,
    setLineDraftVertices,
    lineDraftCursor,
    setLineDraftCursor,
    lineDraftSnap,
    setLineDraftSnap,
    drawingUnit,
    setDrawingUnit,
    lineTransform,
    setLineTransform,
    lineTransformDraft,
    setLineTransformDraft,
    lineVerticesRef,
  } = useLineEditorState()
  // ---- Route (wayfinding path) tool state -----------------------------------
  const {
    selectedRouteIds,
    setSelectedRouteIds,
    routeConfig,
    setRouteConfig,
    routeDraftVertices,
    setRouteDraftVertices,
    routeDraftCursor,
    setRouteDraftCursor,
    routeDraftSnap,
    setRouteDraftSnap,
    routeVerticesRef,
  } = useRouteEditorState()
  // ---- Stair tool state ----------------------------------------------------
  const {
    selectedStairIds,
    setSelectedStairIds,
    stairConfig,
    setStairConfig,
    stairDraftAnchors,
    setStairDraftAnchors,
    stairDraftCursor,
    setStairDraftCursor,
    stairTransform,
    setStairTransform,
    stairTransformDraft,
    setStairTransformDraft,
  } = useStairEditorState()

  // ---- Door tool state ----------------------------------------------------
  // Doors persist via `useDoorStore` (backend tenant + zone scoped, with
  // a localStorage cache for instant cold-start). The transient
  // placement state comes from `useDoorEditorState`; the store
  // selectors below give us the persisted list plus the mutation
  // actions the handlers below invoke.
  const {
    selectedDoorIds,
    setSelectedDoorIds,
    doorDraftAnchors,
    setDoorDraftAnchors,
    doorDraftCursor,
    setDoorDraftCursor,
    doorWallSnap,
    setDoorWallSnap,
    doorCursorPreview,
    setDoorCursorPreview,
    doorTransform,
    setDoorTransform,
  } = useDoorEditorState()
  const doors = useDoorStore((s) => s.doors)
  const doorConfig = useDoorStore((s) => s.pendingConfig)
  const doorPendingWidthMeters = useDoorStore((s) => s.pendingWidthMeters)
  const setDoorPendingWidthMeters = useDoorStore((s) => s.setPendingWidthMeters)
  const setDoorPendingConfig = useDoorStore((s) => s.setPendingConfig)
  const addDoorToStore = useDoorStore((s) => s.addDoor)
  const updateDoorInStore = useDoorStore((s) => s.updateDoor)
  const updateDoorConfigInStore = useDoorStore((s) => s.updateDoorConfig)
  const deleteDoorInStore = useDoorStore((s) => s.deleteDoor)
  const setDoorVisibleInStore = useDoorStore((s) => s.setVisible)
  const renameDoorInStore = useDoorStore((s) => s.setName)
  const duplicateDoorInStore = useDoorStore((s) => s.duplicateDoor)

  // ---- Text-label tool state ----------------------------------------------
  const {
    selectedTextLabelIds,
    setSelectedTextLabelIds,
    textLabelConfig,
    setTextLabelConfig,
    textLabelCursor,
    setTextLabelCursor,
    textLabelTransform,
    setTextLabelTransform,
    textLabelTransformDraft,
    setTextLabelTransformDraft,
  } = useTextLabelEditorState()

  // ---- Image tool state ----------------------------------------------------
  const {
    selectedImageIds,
    setSelectedImageIds,
    imageConfig,
    setImageConfig,
    imageDraft,
    setImageDraft,
    pendingPdfFile,
    setPendingPdfFile,
    pendingCadFile,
    setPendingCadFile,
    imageDragStart,
    setImageDragStart,
    imageDragCursor,
    setImageDragCursor,
    imageTransform,
    setImageTransform,
    imageTransformDraft,
    setImageTransformDraft,
  } = useImageEditorState()

  // ---- Model (glTF/GLB) tool state ----------------------------------------
  const {
    selectedModelIds,
    setSelectedModelIds,
    modelConfig,
    setModelConfig,
    modelCursor,
    setModelCursor,
    modelLibraryOpen,
    setModelLibraryOpen,
    modelLibraryMode,
    setModelLibraryMode,
    modelLibraryPickedRef,
    modelTransform,
    setModelTransform,
    modelTransformDraft,
    setModelTransformDraft,
  } = useModelEditorState()

  // ---- Map lifecycle (state, style gate, viewport, fullscreen) -----------
  // The map lifecycle hook owns `mapInstance`, `drawRef`, `mapStyle`
  // (persisted), the style-swap gate, the `overlayMap` derivation, the
  // viewport rAF listener, the fullscreen mirror, and the
  // `useHeaderControls` publish. Grid-draw state (`hasAnchor`,
  // `drawMode`, `liveStart`, `liveCurrent`) lives in
  // `useGridDrawTool` and that hook self-resets when `mapInstance`
  // goes null, so we no longer need to thread an `onMapDestroy`
  // callback through the lifecycle hook.
  const {
    mapInstance,
    drawRef,
    mapStyle,
    setMapStyle,
    viewport,
    overlayMap,
    handleMapLoad,
    handleMapDestroy,
    handleZoomIn,
    handleZoomOut,
  } = useMapLifecycle({ initialViewportSetRef })

  // Slow auto-rotate for hands-off presentation / wall-display use.
  // Toggled from the map toolbar; the hook owns the rAF loop.
  const { isRotating, toggleRotate } = useMapRotation(mapInstance)

  // Status-bar counts (`statusBarCounts` below) are derived from the
  // warehouse-scoped `savedX` arrays declared later in the file. The
  // tenant-wide totals used to live here; they were misleading once a
  // single warehouse was active. The actual stats are computed in one
  // useMemo near the rest of the saved-shape memos so every count
  // reflects the same warehouse + floor-plan filter `scopeToWarehouse`
  // already applies.

  /**
   * Saved-shape arrays are scoped to the active warehouse: when one is
   * selected, only rows tagged with its `zoneId` are surfaced to the
   * overlays / side panel. When no warehouse is active, all rows are
   * visible (legacy behavior — useful when planning across sites).
   */
  // Raw images from the local spatial store (lifted up here so
  // `scopeToWarehouse` can read floor-plan visibility flags).
  const { data: savedImagesRawAll } = useSpatialImages()
  // Also lifted so the initial-viewport effect below can fall back to
  // shape geometry when no floor-plan image exists (fixes the stuck
  // globe-view on warehouses with center=[0,0] and a stair-only layout).
  const { data: savedStairsRawAllForInit } = useSpatialStairs()
  const { data: savedTextLabelsRawAllForInit } = useSpatialTextLabels()
  const { data: savedPolygonsRawAllForInit } = useSpatialPolygons()
  const { data: savedCirclesRawAllForInit } = useSpatialCircles()
  const { data: savedLinesRawAllForInit } = useSpatialLines()

  /**
   * Set of image (floor-plan) ids whose `visible` flag is currently
   * off. Drives the cascade: any shape with `floorPlanId` pointing at
   * one of these is filtered out of the saved-shape lists + overlays,
   * mirroring the eye-toggle behaviour the user expects from the
   * "Floor plans" LAYERS row.
   *
   * Reads from the unscoped raw list so the cascade works even when
   * the user is currently in a different warehouse than the hidden
   * image's zone — an explicit hide should always win over any scope.
   */
  const hiddenFloorPlanIds = useMemo(() => {
    const set = new Set<number>()
    for (const img of savedImagesRawAll ?? []) {
      if (img.id !== undefined && img.visible === false) set.add(img.id)
    }
    return set
  }, [savedImagesRawAll])

  const scopeToWarehouse = useCallback(
    <T extends { zoneId?: number; floorPlanId?: number }>(
      rows: ReadonlyArray<T>,
    ): T[] => {
      // First the warehouse filter, then the floor-plan-visibility
      // cascade. Both are O(n) over the input so ordering only affects
      // total work for warehouses with many shapes; we keep the
      // warehouse check first because it's the most common no-op path.
      const inZone =
        activeWarehouseId === null
          ? (rows as T[])
          : rows.filter((r) => r.zoneId === activeWarehouseId)
      if (hiddenFloorPlanIds.size === 0) return inZone
      return inZone.filter(
        (r) => r.floorPlanId === undefined || !hiddenFloorPlanIds.has(r.floorPlanId),
      )
    },
    [activeWarehouseId, hiddenFloorPlanIds],
  )

  const { data: savedGridsRawAll } = useSpatialGrids()
  const savedGrids = useMemo(
    () => scopeToWarehouse(savedGridsRawAll ?? EMPTY_GRIDS),
    [savedGridsRawAll, scopeToWarehouse],
  )

  const { data: savedZonesRaw } = useSpatialZones()
  const savedZones = useMemo(() => savedZonesRaw ?? [], [savedZonesRaw])

  // All bins for the racks visible on the map. Read from the local store
  // instead of polling; SSE reconciles any backend changes.
  const { data: savedBinsRaw } = useSpatialBins()
  const savedBins = useMemo(() => savedBinsRaw ?? [], [savedBinsRaw])

  // Style rules — drives data-driven paint overrides for every overlay.
  // `resolvedStyles` and the per-kind projection live further down so
  // they can read each shape's `dataSourceShape` link and resolve
  // cross-shape rules in one pass (Phase 2 linking).
  const { data: savedStyleRulesRaw } = useSpatialStyleRules()
  const savedStyleRules = useMemo(
    () =>
      (savedStyleRulesRaw ?? []) as ReadonlyArray<import('@/lib/style-rules').StyleRule>,
    [savedStyleRulesRaw],
  )

  // Data-link configs (DESIGN-data-link.md). The generic overlay
  // renders one entity per config for the active warehouse. Configs
  // for other warehouses are silently ignored by the overlay via its
  // `activeZoneId` filter, so we hand it the whole list.
  const { data: savedDataLinksRaw } = useSpatialDataLinks()
  const savedDataLinks = useMemo(
    () => savedDataLinksRaw ?? [],
    [savedDataLinksRaw],
  )
  const editingDataLink = useMemo(
    () =>
      editingDataLinkId !== null
        ? savedDataLinks.find((d) => d.id === editingDataLinkId) ?? null
        : null,
    [editingDataLinkId, savedDataLinks],
  )

  /** The active warehouse row (or null when no scope is active). */
  const activeWarehouse = useMemo(
    () =>
      activeWarehouseId === null
        ? null
        : savedZones.find((z) => z.id === activeWarehouseId) ?? null,
    [savedZones, activeWarehouseId],
  )

  // Default editor viewport, in priority order:
  //   1. Floor-plan image bbox — GROUND TRUTH from the user's drawings.
  //   2. zone.defaultView — saved viewport, only when no drawings exist.
  //   3. zone.center — soft prefit while shapes are still loading; does
  //      NOT lock the "fitted" flag so images arriving later still win.
  //   4. Whole earth — no warehouse selected OR a freshly-created warehouse
  //      with no floor plans, no saved viewport, and no real center (the
  //      backend writes POINT(0 0) when the create form sends no center).
  //      Soft when a warehouse IS selected so the first floor-plan upload
  //      still triggers fitBounds; locked only for the no-warehouse case.
  // Runs once per map instance + active warehouse, and is reset on
  // unmount or warehouse switch.
  //
  // It waits until this warehouse's floor plans and shapes have LOADED: with
  // a (0,0) centre and nothing loaded yet, the fallbacks below end at the
  // globe view and lock, so a floor plan arriving a moment later never got
  // fitted — whether you saw the zoom depended on which won the race.
  const viewportInputsReady = useSpatialStore((s) =>
    s.loadedFor.zones !== undefined &&
    (['images', 'polygons', 'circles', 'lines', 'stairs', 'text-labels'] as const).every(
      (k) => s.loadedFor[k] !== undefined && s.loadedFor[k] === (activeWarehouseId ?? null),
    ),
  )
  useEffect(() => {
    if (!mapInstance) return
    if (initialViewportSetRef.current) return
    if (!viewportInputsReady) return

    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    let hasImage = false
    // Capture the first matching image's rotation so `fitBounds` can
    // rotate the map bearing to match — otherwise the floor plan sits
    // on the raster in its native orientation but the camera looks at
    // it at the world's compass bearing, so users see a skewed layout
    // that doesn't line up with the plan they authored.
    let floorRotation = 0
    // Only consider images belonging to the active warehouse — without
    // this filter a tenant with multiple warehouses would compute a
    // bbox spanning ALL their floor plans, which zooms the camera out
    // to a random midpoint between sites (the "landing in a random
    // place on the map" symptom). When no warehouse is selected (the
    // legacy multi-warehouse mode), fall back to every image.
    for (const img of savedImagesRawAll) {
      if (img.visible === false) continue
      if (activeWarehouseId !== null && img.zoneId !== activeWarehouseId) continue
      const corners = imageCorners(img)
      if (!corners) continue
      if (!hasImage) floorRotation = img.rotation ?? 0
      hasImage = true
      for (const [lng, lat] of corners) {
        minLng = Math.min(minLng, lng)
        minLat = Math.min(minLat, lat)
        maxLng = Math.max(maxLng, lng)
        maxLat = Math.max(maxLat, lat)
      }
    }

    if (hasImage && Number.isFinite(minLng) && Number.isFinite(maxLat)) {
      mapInstance.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        {
          padding: 40,
          duration: 800,
          maxZoom: 20,
          bearing: floorRotation,
        },
      )
      initialViewportSetRef.current = true
    } else if (activeWarehouse?.defaultView) {
      // Saved viewport as fallback when no drawings exist yet.
      const v = activeWarehouse.defaultView
      mapInstance.easeTo({
        center: [v.lng, v.lat],
        zoom: v.zoom,
        pitch: v.pitch ?? 0,
        bearing: v.bearing ?? 0,
        duration: 800,
      })
      initialViewportSetRef.current = true
    } else if (
      activeWarehouseId !== null &&
      activeWarehouse?.center &&
      (activeWarehouse.center[0] !== 0 || activeWarehouse.center[1] !== 0)
    ) {
      // Soft prefit — ease to the warehouse marker but DO NOT lock
      // `initialViewportSetRef`. When the shape store's async load
      // finishes and images arrive, this effect re-runs and the
      // image-bbox branch above takes over. Locking here would strand
      // the editor at a rough centre point forever.
      mapInstance.easeTo({
        center: activeWarehouse.center,
        zoom: Math.max(mapInstance.getZoom(), 16),
        duration: 400,
      })
    } else {
      // Shape-bbox fallback — no image, no defaultView, and warehouse
      // center is (0,0) or missing, but the user may have already drawn
      // stairs / text labels / polygons / circles in this warehouse.
      // Compute a bounds from those so the camera fits their work
      // instead of stranding at the globe view.
      let shapeMinLng = Infinity
      let shapeMinLat = Infinity
      let shapeMaxLng = -Infinity
      let shapeMaxLat = -Infinity
      let hasShape = false
      const inWh = (zid: number | undefined | null) =>
        activeWarehouseId === null || zid === activeWarehouseId
      const bump = (lng: number, lat: number) => {
        shapeMinLng = Math.min(shapeMinLng, lng)
        shapeMinLat = Math.min(shapeMinLat, lat)
        shapeMaxLng = Math.max(shapeMaxLng, lng)
        shapeMaxLat = Math.max(shapeMaxLat, lat)
        hasShape = true
      }
      for (const s of savedStairsRawAllForInit ?? []) {
        if (!inWh(s.zoneId)) continue
        for (const [lng, lat] of s.vertices ?? []) bump(lng, lat)
      }
      for (const l of savedTextLabelsRawAllForInit ?? []) {
        if (!inWh(l.zoneId)) continue
        if (l.position) bump(l.position[0], l.position[1])
      }
      for (const p of savedPolygonsRawAllForInit ?? []) {
        if (!inWh(p.zoneId)) continue
        for (const [lng, lat] of p.vertices ?? []) bump(lng, lat)
      }
      for (const c of savedCirclesRawAllForInit ?? []) {
        if (!inWh(c.zoneId)) continue
        if (c.center) bump(c.center[0], c.center[1])
      }
      // Walls / aisles: a facility drawn only with lines still gets framed.
      for (const ln of savedLinesRawAllForInit ?? []) {
        if (!inWh(ln.zoneId)) continue
        for (const [lng, lat] of ln.vertices ?? []) bump(lng, lat)
      }
      if (hasShape) {
        mapInstance.fitBounds(
          [
            [shapeMinLng, shapeMinLat],
            [shapeMaxLng, shapeMaxLat],
          ],
          { padding: 60, duration: 800, maxZoom: 19 },
        )
        initialViewportSetRef.current = true
      } else {
        // Globe fallback — no warehouse selected (legitimate empty-world
        // state) OR a freshly-created warehouse with no shapes at all.
        // The backend writes POINT(0 0) when the create form sends no
        // center, so without this branch the camera would snap to
        // [0,0] zoom 16 — a random spot in the Gulf of Guinea.
        mapInstance.easeTo({ center: [0, 0], zoom: 1, duration: 0 })
        // Always lock after a globe fallback — even with a selected
        // warehouse. Otherwise every downstream re-render (a polygon
        // toggle, a query invalidation) re-runs this effect and eases
        // the camera back to (0, 0), fighting any user navigation. If
        // the user later uploads a floor plan or draws a shape, this
        // effect won't fire again — they can click Fit to reframe.
        initialViewportSetRef.current = true
      }
    }
  }, [
    mapInstance,
    savedImagesRawAll,
    savedZones,
    activeWarehouseId,
    activeWarehouse,
    savedStairsRawAllForInit,
    savedTextLabelsRawAllForInit,
    savedPolygonsRawAllForInit,
    savedCirclesRawAllForInit,
    savedLinesRawAllForInit,
    viewportInputsReady,
  ])

  const { data: savedMarkersRawAll } = useSpatialMarkers()
  const savedMarkers = useMemo<MarkerShape[]>(
    () => scopeToWarehouse(savedMarkersRawAll ?? []),
    [savedMarkersRawAll, scopeToWarehouse],
  )

  const selectedMarker = useMemo<MarkerShape | null>(() => {
    if (selectedMarkerIds.size !== 1) return null
    const id = [...selectedMarkerIds][0]
    return savedMarkers.find((m) => m.id === id) ?? null
  }, [selectedMarkerIds, savedMarkers])

  const { data: savedCirclesRawAll } = useSpatialCircles()
  const savedCircles = useMemo<CircleShape[]>(
    () => scopeToWarehouse(savedCirclesRawAll ?? []),
    [savedCirclesRawAll, scopeToWarehouse],
  )
  const selectedCircle = useMemo<CircleShape | null>(() => {
    if (selectedCircleIds.size !== 1) return null
    const id = [...selectedCircleIds][0]
    return savedCircles.find((c) => c.id === id) ?? null
  }, [selectedCircleIds, savedCircles])

  const { data: savedPolygonsRawAll } = useSpatialPolygons()
  const savedPolygons = useMemo<PolygonShape[]>(
    () => scopeToWarehouse(savedPolygonsRawAll ?? []),
    [savedPolygonsRawAll, scopeToWarehouse],
  )
  const selectedPolygon = useMemo<PolygonShape | null>(() => {
    if (selectedPolygonIds.size !== 1) return null
    const id = [...selectedPolygonIds][0]
    return savedPolygons.find((p) => p.id === id) ?? null
  }, [selectedPolygonIds, savedPolygons])

  /**
   * View of `savedPolygons` with any in-flight transform draft applied.
   */
  const polygonsForOverlay = useMemo<PolygonShape[]>(() => {
    if (!polygonTransform || !polygonTransformDraft) return savedPolygons
    return savedPolygons.map((p) =>
      p.id === polygonTransform.polygonId
        ? { ...p, ...polygonTransformDraft }
        : p
    )
  }, [savedPolygons, polygonTransform, polygonTransformDraft])

  const { data: savedLinesRawAll } = useSpatialLines()
  const savedLines = useMemo<LineShape[]>(
    () => scopeToWarehouse(savedLinesRawAll ?? []),
    [savedLinesRawAll, scopeToWarehouse],
  )
  const selectedLine = useMemo<LineShape | null>(() => {
    if (selectedLineIds.size !== 1) return null
    const id = [...selectedLineIds][0]
    return savedLines.find((l) => l.id === id) ?? null
  }, [selectedLineIds, savedLines])

  const linesForOverlay = useMemo<LineShape[]>(() => {
    if (!lineTransform || !lineTransformDraft) return savedLines
    return savedLines.map((l) =>
      l.id === lineTransform.lineId ? { ...l, ...lineTransformDraft } : l
    )
  }, [savedLines, lineTransform, lineTransformDraft])

  const { data: savedRoutesRawAll } = useSpatialRoutes()
  const savedRoutes = useMemo<RouteShape[]>(
    () => scopeToWarehouse(savedRoutesRawAll ?? []),
    [savedRoutesRawAll, scopeToWarehouse],
  )
  const selectedRoute = useMemo<RouteShape | null>(() => {
    if (selectedRouteIds.size !== 1) return null
    const id = [...selectedRouteIds][0]
    return savedRoutes.find((r) => r.id === id) ?? null
  }, [selectedRouteIds, savedRoutes])

  const { data: savedTextLabelsRawAll } = useSpatialTextLabels()
  const savedTextLabels = useMemo<TextLabelShape[]>(
    () => scopeToWarehouse(savedTextLabelsRawAll ?? []),
    [savedTextLabelsRawAll, scopeToWarehouse],
  )
  const selectedTextLabel = useMemo<TextLabelShape | null>(() => {
    if (selectedTextLabelIds.size !== 1) return null
    const id = [...selectedTextLabelIds][0]
    return savedTextLabels.find((l) => l.id === id) ?? null
  }, [selectedTextLabelIds, savedTextLabels])
  /** View of `savedTextLabels` with any in-flight transform draft applied. */
  const textLabelsForOverlay = useMemo<TextLabelShape[]>(() => {
    if (!textLabelTransform || !textLabelTransformDraft) return savedTextLabels
    return savedTextLabels.map((l) =>
      l.id === textLabelTransform.textLabelId
        ? { ...l, ...textLabelTransformDraft }
        : l,
    )
  }, [savedTextLabels, textLabelTransform, textLabelTransformDraft])

  // `savedImagesRawAll` is declared earlier (so `scopeToWarehouse`'s
  // visibility-cascade can read it). Here we just derive the scoped
  // view that the side panel + overlays consume.
  const savedImages = useMemo<ImageShape[]>(
    () => scopeToWarehouse(savedImagesRawAll ?? []),
    [savedImagesRawAll, scopeToWarehouse],
  )
  const selectedImage = useMemo<ImageShape | null>(() => {
    if (selectedImageIds.size !== 1) return null
    const id = [...selectedImageIds][0]
    return savedImages.find((img) => img.id === id) ?? null
  }, [selectedImageIds, savedImages])
  // Self-heal the persisted default: if the floor plan it points at
  // was deleted (or never belonged to this warehouse), fall back to
  // "no default" so a stale localStorage value doesn't silently pin
  // every new shape to a floorPlanId that no longer resolves.
  useEffect(() => {
    if (defaultFloorPlanId === null) return
    if (savedImages.some((img) => img.id === defaultFloorPlanId)) return
    handleDefaultFloorPlanChange(null)
  }, [defaultFloorPlanId, savedImages, handleDefaultFloorPlanChange])
  // Elevation of the currently-selected default floor plan (meters, 0
  // when no plan is selected). Reads the raw list so it stays in sync
  // when the user edits the plan's own elevation from the images
  // sidebar. Drives the sync effect below so every draw tool defaults
  // to the same altitude — a shape drawn on a "Second floor" plan at
  // 24 ft lands at 24 ft without the user touching the tool's slider.
  const defaultFloorPlanElevation = useMemo<number>(() => {
    if (defaultFloorPlanId === null) return 0
    const img = savedImagesRawAll?.find((x) => x.id === defaultFloorPlanId)
    return img?.config?.elevation ?? 0
  }, [defaultFloorPlanId, savedImagesRawAll])
  // Sync the plan's elevation into every draw tool's config so the
  // sidebar slider, live-draw preview, and saved shape all agree.
  // Overwrites any prior manual tweak whenever the plan (or its own
  // elevation) changes — that's intentional: the plan is the source of
  // truth for "default altitude at this floor". The user can still
  // override per-tool before drawing (their tweak persists until the
  // plan changes) and per-shape after drawing from the side panel.
  // Image planes read the value through the ImagePlaneTool prop.
  useEffect(() => {
    const elev = defaultFloorPlanElevation
    setConfig((c) => ({ ...c, elevation: elev }))
    setMarkerConfig((c) => ({ ...c, elevation: elev }))
    setCircleConfig((c) => ({ ...c, elevation: elev }))
    setPolygonConfig((c) => ({ ...c, elevation: elev }))
    setLineConfig((c) => ({ ...c, elevation: elev }))
    setRouteConfig((c) => ({ ...c, elevation: elev }))
    setStairConfig((c) => ({ ...c, baseElevation: elev }))
    setTextLabelConfig((c) => ({ ...c, elevation: elev }))
    setModelConfig((c) => ({ ...c, elevation: elev }))
    useDoorStore.getState().updatePendingConfig({ elevation: elev })
  }, [defaultFloorPlanElevation])
  // Minimal { id, name } shape passed to the toolbar's default-floor
  // picker — strips the expensive fields (imageData, config, corners)
  // so the picker doesn't re-render every time a floor plan's opacity
  // slider moves.
  const toolbarFloorPlans = useMemo(() => {
    const src = savedImages
      .filter((img): img is ImageShape & { id: number } => img.id !== undefined)
      .map((img) => ({ id: img.id, name: img.name }))
    if (floorPlanOrder.length === 0) return src
    const rank = new Map<number, number>()
    floorPlanOrder.forEach((id, i) => rank.set(id, i))
    return [...src].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id)! : Infinity
      const rb = rank.has(b.id) ? rank.get(b.id)! : Infinity
      if (ra !== rb) return ra - rb
      return a.id - b.id
    })
  }, [savedImages, floorPlanOrder])

  const { data: savedModelsRawAll } = useSpatialModels()
  const savedModels = useMemo<ModelShape[]>(
    () => scopeToWarehouse(savedModelsRawAll ?? []),
    [savedModelsRawAll, scopeToWarehouse],
  )
  const selectedModel = useMemo<ModelShape | null>(() => {
    if (selectedModelIds.size !== 1) return null
    const id = [...selectedModelIds][0]
    return savedModels.find((m) => m.id === id) ?? null
  }, [selectedModelIds, savedModels])

  const { data: savedStairsRawAll } = useSpatialStairs()
  const savedStairs = useMemo<StairShape[]>(() => {
    const all = savedStairsRawAll ?? []
    const scoped = scopeToWarehouse(all)
    if (hiddenFloorPlanIds.size === 0) return scoped
    // A lift spans floors: keep it while any floor it links is shown,
    // even when its own `floorPlanId` floor is hidden.
    const kept = new Set(scoped)
    const rescued = all.filter(
      (s) =>
        !kept.has(s) &&
        (activeWarehouseId === null || s.zoneId === activeWarehouseId) &&
        liftFloorPlanIds(s.config).some((id) => !hiddenFloorPlanIds.has(id)),
    )
    return rescued.length ? [...scoped, ...rescued] : scoped
  }, [savedStairsRawAll, scopeToWarehouse, hiddenFloorPlanIds, activeWarehouseId]
  )

  // Image planes — separate kind from `images`. Renders user images as
  // textured planes in 3D space (elevation + X/Y/Z rotation) via the
  // model-layer pipeline. See `map-image-plane-overlay.tsx`.
  const { data: savedImagePlanesRawAll } = useSpatialImagePlanes()
  // Building base under a raised floor shown on its own (floors below
  // hidden) — see src/lib/floor-base.ts.
  const floorBaseInput = useMemo(() => {
    const inZone = <T extends { zoneId?: number }>(rows: ReadonlyArray<T> | undefined): T[] =>
      (rows ?? []).filter((r) => activeWarehouseId !== null && r.zoneId === activeWarehouseId)
    const floors = inZone(savedImagesRawAll)
    return {
      floors,
      visibleFloorIds: new Set(floors.filter((f) => f.visible !== false && f.id !== undefined).map((f) => f.id as number)),
      polygons: inZone(savedPolygonsRawAll),
      lines: inZone(savedLinesRawAll),
      stairs: inZone(savedStairsRawAll),
      floorElevations: new Map(floors.filter((f) => f.id !== undefined).map((f) => [f.id as number, f.config.elevation ?? 0])),
    }
  }, [activeWarehouseId, savedImagesRawAll, savedPolygonsRawAll, savedLinesRawAll, savedStairsRawAll])
  const savedImagePlanes = useMemo<ImagePlaneShape[]>(
    () => scopeToWarehouse(savedImagePlanesRawAll ?? []),
    [savedImagePlanesRawAll, scopeToWarehouse],
  )
  // Doors live in `useDoorStore` (localStorage-backed, separate from
  // the spatial-store the other shapes ride). The store already
  // reloads by warehouse, so the zone filter here is normally a
  // no-op — but the SECOND half of `scopeToWarehouse` (the
  // hidden-floor-plan cascade) is what we actually need, and it wasn't
  // being applied to doors at all. Result: hiding a floor plan on the
  // "Floor plans" LAYERS row would drop every polygon / grid / circle
  // / marker / model / stair / text label / other image assigned to
  // it, but the doors sitting on that same floor stayed pinned to the
  // map. Cascading them through the same helper keeps their behaviour
  // consistent with every other shape kind.
  const scopedDoors = useMemo(
    () => scopeToWarehouse(doors),
    [doors, scopeToWarehouse],
  )
  /**
   * `Map<lineId, DoorShape[]>` — every door that has stamped
   * `config.attachedToLineId = wallId`. Passed to MapLineOverlay so
   * the wall generator (`buildLineWallFeature`) subtracts each door's
   * opening footprint from the wall's fill-extrusion, producing a
   * real hole where the door sits.
   *
   * Uses `scopedDoors` so hiding a floor plan cascades to the doors
   * that live on it — those doors' walls stop being punched too,
   * mirroring the way the door overlay hides them from the map. A
   * stale `attachedToLineId` (wall deleted, door orphaned) is
   * silently a no-op: the Map lookup misses and the wall renders
   * intact.
   */
  const attachedDoorsByLineId = useMemo(() => {
    const map = new Map<number, import('@/lib/door/types').DoorShape[]>()
    for (const door of scopedDoors) {
      const wallId = door.config.attachedToLineId
      if (wallId === undefined) continue
      const bucket = map.get(wallId)
      if (bucket) bucket.push(door)
      else map.set(wallId, [door])
    }
    return map
  }, [scopedDoors])

  // Route-preview (indoor wayfinding) — click A, click B, path drawn.
  // Owns its own session state; deactivating the tool wipes it.
  const routePreview = useRoutePreviewTool({
    mapInstance,
    activeTool,
    walls: savedLines,
    doors: scopedDoors,
    polygons: savedPolygons,
    grids: savedGrids,
  })
  // ---- Image-plane tool state ----------------------------------------------
  const {
    selectedImagePlaneIds,
    setSelectedImagePlaneIds,
    imagePlaneTransform,
    setImagePlaneTransform,
    imagePlaneTransformDraft,
    setImagePlaneTransformDraft,
  } = useImagePlaneEditorState()
  const selectedImagePlane = useMemo<ImagePlaneShape | null>(() => {
    if (selectedImagePlaneIds.size !== 1) return null
    const id = [...selectedImagePlaneIds][0]
    return savedImagePlanes.find((p) => p.id === id) ?? null
  }, [selectedImagePlaneIds, savedImagePlanes])
  // Apply the in-flight transform draft to the overlay's view of planes
  // so the dragged plane visually follows the marker mid-drag without
  // touching the canonical store until dragend.
  const imagePlanesForOverlay = useMemo<ImagePlaneShape[]>(() => {
    if (!imagePlaneTransform || !imagePlaneTransformDraft) return savedImagePlanes
    return savedImagePlanes.map((p) =>
      p.id === imagePlaneTransform.imagePlaneId
        ? { ...p, position: imagePlaneTransformDraft.position }
        : p,
    )
  }, [savedImagePlanes, imagePlaneTransform, imagePlaneTransformDraft])
  const handleImagePlaneTransformChange = useCallback(
    (patch: { position?: [number, number] }, commit: boolean) => {
      if (!imagePlaneTransform) return
      if (!patch.position) return
      if (commit) {
        patchSpatialEntity('image-planes', imagePlaneTransform.imagePlaneId, {
          position: patch.position,
        })
        setImagePlaneTransformDraft(null)
        setImagePlaneTransform(null)
      } else {
        setImagePlaneTransformDraft({ position: patch.position })
      }
    },
    [imagePlaneTransform],
  )

  /**
   * Aggregated counts surfaced in the bottom status bar. All values
   * are scoped to the active warehouse — the same scope the saved-
   * shape lists in the side panel use — so the bar reflects what
   * you're actually working on rather than tenant-wide totals.
   *
   *   - Walls: a `LineShape` that's been extruded (`config.height > 0`
   *     or a base elevation lifts it off the ground). Flat lines
   *     stamped as aisles (name/role contains "aisle") are counted
   *     separately so the user can tell at a glance how much
   *     architecture vs. navigation infrastructure they've drawn.
   *   - Areas: polygons. Most editing sessions revolve around them.
   *   - Floor plans: warehouse-scoped images uploaded as raster
   *     backdrops; the count tells the user how many floors they've
   *     stacked.
   *
   * Doors come from `useDoorStore`, which is already scoped to the
   * active warehouse via the `loadForWarehouse` call elsewhere in this
   * route, so it can be read directly without `scopeToWarehouse`.
   */
  const statusBarCounts = useMemo(() => {
    let walls = 0
    let aisles = 0
    for (const ln of savedLines) {
      const cfg = ln.config
      const isWall = (cfg.height ?? 0) > 0 || (cfg.elevation ?? 0) > 0
      // LineShape has no `role` field — discriminate aisles by the
      // name pattern only. This matches the filter used in
      // `view-sidebar.tsx`'s `isAisleShape` for polygons/lines and
      // in `nav/graph.ts`'s aisle detection, so the counts agree
      // with what the viewer hides + what the nav graph builds on.
      const isAisle = !!ln.name && /\baisle\b/i.test(ln.name)
      if (isWall) walls++
      // Only tag as an aisle when it's not already extruded as a wall —
      // a name match shouldn't double-count a 3D wall as an aisle.
      else if (isAisle) aisles++
    }
    return {
      racks: savedGrids.length,
      areas: savedPolygons.length,
      walls,
      aisles,
      doors: scopedDoors.length,
      stairs: savedStairs.length,
      models: savedModels.length,
      floorPlans: savedImages.length,
      markers: savedMarkers.length,
      circles: savedCircles.length,
      textLabels: savedTextLabels.length,
      imagePlanes: savedImagePlanes.length,
    }
  }, [
    savedGrids,
    savedPolygons,
    savedLines,
    scopedDoors,
    savedStairs,
    savedModels,
    savedImages,
    savedMarkers,
    savedCircles,
    savedTextLabels,
    savedImagePlanes,
  ])

  /**
   * Phase 2: per-rule target/source linking. Build a viewer index of
   * every shape currently on the canvas (plus addressable grid cells)
   * so the resolver can broadcast a rule with a pinned source to every
   * eligible target — e.g. "for every text label, when this polygon's
   * status is occupied, set text = OCCUPIED." Or pin both target and
   * source to drive a one-to-one relationship.
   */
  const viewerIndex = useMemo<import('@/lib/style-rules').ViewerIndex>(() => {
    // Enumerate the address of every cell that already has a bin. The
    // resolver's `target: 'all' + scope: 'grid-cell'` branch reads
    // exclusively from `viewers.gridCells` (see resolver.ts:311-316) —
    // without this list, that branch returns an empty array and no
    // grid-cell rule ever fires, even when the bin data satisfies its
    // conditions. Cells without a bin are intentionally skipped: a
    // grid-cell rule's conditions almost always evaluate against the
    // cell's own bin (`source: 'self'`), and an empty cell has no bin
    // to evaluate against.
    const gridCells: { gridId: number; row: number; col: number; level: number }[] = []
    for (const bin of savedBins) {
      if (bin.targetKind !== 'grid-cell') continue
      if (bin.gridId === undefined || bin.row === undefined || bin.col === undefined) continue
      gridCells.push({
        gridId: bin.gridId,
        row: bin.row,
        col: bin.col,
        level: bin.level ?? 0,
      })
    }
    return {
      polygons: savedPolygons,
      circles: savedCircles,
      lines: savedLines,
      markers: savedMarkers,
      images: savedImages,
      models: savedModels,
      textLabels: savedTextLabels,
      stairs: savedStairs,
      gridCells,
    }
  }, [
    savedPolygons,
    savedCircles,
    savedLines,
    savedMarkers,
    savedImages,
    savedModels,
    savedTextLabels,
    savedStairs,
    savedBins,
  ])

  const resolvedStyles = useMemo(
    () =>
      resolveStyleMaps(savedStyleRules, savedBins, {
        zoneId: activeWarehouseId ?? undefined,
        viewers: viewerIndex,
      }),
    [savedStyleRules, savedBins, activeWarehouseId, viewerIndex],
  )

  /**
   * Project the resolver's compound-keyed shape map into one Map per
   * shape kind so each overlay's prop type stays simple
   * (Map<shapeId, styleOverride>). Computed once per resolver run.
   *
   * Model is the odd one out — the model overlay already has its own
   * `shapeExtras: Map<id, Record<string, unknown>>` ingestion pipeline
   * with named keys (`tintColor`, `opacity`, `emissive`, …) — so we
   * translate the style payload into that shape rather than introducing
   * a parallel one. Markers are DOM-based so they take a typed
   * `MarkerStyleOverride` directly. Text labels are a Phase-2 addition
   * — they don't have a bin themselves, but the resolver's link pass
   * may have emitted a style keyed by `text-label:<id>`.
   */
  const styleOverridesByKind = useMemo(() => {
    const polygon = new Map<number, import('@/lib/polygon-generators').PolygonStyleOverride>()
    const circle = new Map<number, import('@/lib/circle-generators').CircleStyleOverride>()
    const line = new Map<number, import('@/lib/line-generators').LineStyleOverride>()
    const marker = new Map<number, import('@/components/map-marker-overlay').MarkerStyleOverride>()
    const model = new Map<number, Record<string, unknown>>()
    const textLabel = new Map<number, { labelText?: string; labelColor?: string; fillColor?: string; fillOpacity?: number }>()
    for (const [key, resolved] of resolvedStyles.shapes) {
      const sep = key.indexOf(':')
      if (sep < 0) continue
      const kind = key.slice(0, sep)
      const id = Number(key.slice(sep + 1))
      if (!Number.isFinite(id)) continue
      const s = resolved.style
      if (kind === 'polygon') polygon.set(id, s)
      else if (kind === 'circle') circle.set(id, s)
      else if (kind === 'line') line.set(id, s)
      else if (kind === 'marker') {
        marker.set(id, {
          iconColor: s.iconColor ?? s.fillColor,
          fillOpacity: s.fillOpacity,
          elevation: s.elevation,
          height: s.height,
          labelColor: s.labelColor,
          labelText: s.labelText,
        })
      } else if (kind === 'model') {
        const extras: Record<string, unknown> = {}
        if (s.fillColor !== undefined) extras.tintColor = s.fillColor
        if (s.fillOpacity !== undefined) extras.opacity = s.fillOpacity
        if (s.labelText !== undefined) extras.status = s.labelText
        model.set(id, extras)
      } else if (kind === 'text-label') {
        textLabel.set(id, {
          labelText: s.labelText,
          labelColor: s.labelColor,
          fillColor: s.fillColor,
          fillOpacity: s.fillOpacity,
        })
      }
    }
    return { polygon, circle, line, marker, model, textLabel }
  }, [resolvedStyles])

  const selectedStair = useMemo<StairShape | null>(() => {
    if (selectedStairIds.size !== 1) return null
    const id = [...selectedStairIds][0]
    return savedStairs.find((s) => s.id === id) ?? null
  }, [selectedStairIds, savedStairs])

  // Door selection. No draft layer is needed because edits write
  // straight to the door store, which re-renders this component via
  // its zustand subscription.
  const selectedDoorForPanel = useMemo(() => {
    if (selectedDoorIds.size !== 1) return null
    const id = [...selectedDoorIds][0]
    return doors.find((d) => d.id === id) ?? null
  }, [selectedDoorIds, doors])

  // The store merges unsaved edits into every row (useSpatialShapes), so
  // the selected stair already carries them.
  const selectedStairForPanel = selectedStair

  /** Stairs handed to the map overlay, with the in-flight transform draft merged in. */
  const stairsForOverlay = useMemo<StairShape[]>(() => {
    let list = savedStairs
    // Merge in-flight transform draft so transform handles and the
    // in-flight preview track the drag position instead of the
    // committed (pre-drag) position.
    if (stairTransform && stairTransformDraft) {
      list = list.map((s) => {
        if (s.id !== stairTransform.stairId) return s
        return {
          ...s,
          ...(stairTransformDraft.vertices ? { vertices: stairTransformDraft.vertices } : {}),
          ...(stairTransformDraft.rotation !== undefined ? { rotation: stairTransformDraft.rotation } : {}),
        }
      })
    }
    return list
  }, [savedStairs, stairTransform, stairTransformDraft])

  // Unsaved sidebar edits are already merged in by the store.
  const selectedModelForPanel = selectedModel

  /** Apply the in-flight move-draft so the dragged model follows the cursor. */
  const modelsForOverlay = useMemo<ModelShape[]>(() => {
    if (!modelTransform || !modelTransformDraft?.position) return savedModels
    return savedModels.map((m) => {
      let out: ModelShape = m
      if (
        modelTransform &&
        modelTransformDraft?.position &&
        m.id === modelTransform.modelId
      ) {
        out = { ...out, position: modelTransformDraft.position }
      }
      return out
    })
  }, [savedModels, modelTransform, modelTransformDraft])

  /** Bundled + uploaded model URL map for Mapbox's `style.models` registry. */
  const modelUrlMap = useModelUrlMap()
  /** Per-asset bbox centre — drives horizontal Mapbox model-scale compensation. */
  const modelBoundingCenters = useModelBoundingCenterMap()
  /** Per-asset full AABB — drives vertical bottom-anchor so the model
   *  rests on the elevation plane instead of centring on it. */
  const modelBounds = useModelBoundsMap()
  // Kick off the inspector fetch for any bundled asset the user has
  // placed. Without this, `useModelBoundsMap()` returns nothing for
  // bundled assets (they don't stamp `inspector` at build time), so
  // off-origin meshes like the Forklift (rigged) render 193 m from
  // their pin. The hook restricts fetches to placed-asset ids so we
  // don't fire ~40 GETs on load.
  const placedAssetIds = useMemo(() => {
    const s = new Set<string>()
    for (const m of savedModels) {
      const assetId = (m.config as unknown as { modelAssetId?: string })
        .modelAssetId
      if (assetId) s.add(assetId)
    }
    return s
  }, [savedModels])
  useModelInspectorMap(placedAssetIds)

  /**
   * Per-shape property overrides fed to MapModelOverlay. We walk the
   * `savedBins` list once for every model row whose `targetKind` is
   * `'model'`, then expose its `customProperties` + typed columns
   * (status, sku, capacity) as a flat object keyed by the model's id.
   * The model-generators layer recognises a few well-known keys
   * (tintColor, opacity, emissive, active, status) and the rest pass
   * through as feature properties — the overlay's expressions can then
   * key off any column the import wired up.
   */
  const modelShapeExtras = useMemo<Map<number, Record<string, unknown>>>(() => {
    const out = new Map<number, Record<string, unknown>>()
    for (const bin of savedBins) {
      if (bin.targetKind !== 'model') continue
      if (bin.shapeId === undefined) continue
      const props: Record<string, unknown> = {}
      if (bin.status !== undefined) props.status = bin.status
      if (bin.sku !== undefined) props.sku = bin.sku
      if (bin.capacity !== undefined) props.capacity = bin.capacity
      if (bin.notes !== undefined) props.notes = bin.notes
      if (bin.externalCode !== undefined) props.externalCode = bin.externalCode
      if (bin.customProperties) {
        for (const [k, v] of Object.entries(bin.customProperties)) {
          props[k] = v
        }
      }
      out.set(bin.shapeId, props)
    }
    return out
  }, [savedBins])

  /**
   * Merge bin-driven model props with style-rule overrides. The rules
   * win (they're explicit user paint decisions) while the bin attrs
   * fill in raw values the overlay's expressions might be using.
   */
  const modelShapeExtrasMerged = useMemo(() => {
    if (styleOverridesByKind.model.size === 0) return modelShapeExtras
    const out = new Map<number, Record<string, unknown>>(modelShapeExtras)
    for (const [id, ruleExtras] of styleOverridesByKind.model) {
      out.set(id, { ...(out.get(id) ?? {}), ...ruleExtras })
    }
    return out
  }, [modelShapeExtras, styleOverridesByKind])

  /**
   * Image overlay view with any in-flight move transform applied so the
   * dragged image follows the cursor before the dragend commit lands in
   * IndexedDB. Mirrors the polygon/line draft pattern.
   */
  const imagesForOverlay = useMemo<ImageShape[]>(() => {
    if (!imageTransform || !imageTransformDraft) return savedImages
    return savedImages.map((img) =>
      img.id === imageTransform.imageId
        ? { ...img, ...imageTransformDraft }
        : img
    )
  }, [savedImages, imageTransform, imageTransformDraft])

  /**
   * View of `savedCircles` with any in-flight transform draft applied to
   * the transforming circle. The overlay reads from this so the drag
   * preview reflects live changes; the original `savedCircles` array
   * stays untouched until commit (then this becomes a no-op).
   */
  const circlesForOverlay = useMemo<CircleShape[]>(() => {
    if (!circleTransform || !circleTransformDraft) return savedCircles
    return savedCircles.map((c) =>
      c.id === circleTransform.circleId
        ? { ...c, ...circleTransformDraft }
        : c
    )
  }, [savedCircles, circleTransform, circleTransformDraft])

  /**
   * Selection is OFF while any create tool is active so a click on top
   * of an existing shape doesn't hijack the click (no preventDefault,
   * no `onClick` callback). Without this, dropping a marker on top of
   * a circle would deselect the circle and never place the marker —
   * because the circle overlay's `preventDefault` killed the event.
   */
  /**
   * Tool semantics:
   *
   *   - **Pan**     → read-only inspect mode. Hover/click tooltips on
   *                   shapes (driven by `MapShapeTooltip`). No
   *                   selection, no placement.
   *   - **Select**  → click-to-select on shapes. No tooltips (the
   *                   click would otherwise compete between "select"
   *                   and "open popup").
   *   - **Create-***→ click places a new shape of that kind. No
   *                   selection on shape-click (clicks fall through
   *                   to the placement handler) and no tooltips
   *                   (they'd lie about what the next click does).
   *
   * `shapeSelectionEnabled` controls click-to-select; `MapShapeTooltip`
   * has its own `enabled` prop wired to `activeTool === 'pan'` at the
   * mount site. Together they make Pan and Select feel like clearly
   * separate modes.
   */
  const shapeSelectionEnabled = useMemo(
    // Magic-wall mode is a selection mode too — the click handler is
    // routed through `handlePolygonClickRouted` to toggle the picked
    // polygon in the magic-wall set instead of the normal selection.
    // AI Map likewise: the image overlay's click listener is our entry
    // point for triggering a detection on the clicked floor plan
    // (routed through handleImageClickDispatch). Without listing 'ai-map'
    // here, MapImageOverlay short-circuits the click-listener attach
    // and the AI Map button appears broken — activates but nothing
    // happens on click. Without this line, clicks are dropped at the
    // overlay layer and the routed handler never fires.
    () => activeTool === 'select' || activeTool === 'magic-wall' || activeTool === 'ai-map',
    [activeTool]
  )

  /**
   * Selection is owned by the Select tool. Leaving Select (to Pan,
   * Zones, or any Create-* tool) clears every per-kind selection set,
   * dismisses the bin target, and cancels any in-progress transform.
   *
   * Why this lives in an effect instead of being folded into the tool
   * switcher:
   *   - the tool switches from many places (toolbar click, escape
   *     keypress, post-placement auto-reset, sidebar actions) and
   *     pasting the clear logic into all of them would be lossy;
   *   - watching `activeTool` directly means a future tool switch
   *     from anywhere — including programmatic ones — keeps the
   *     invariant "you only have a selection while Select is
   *     active" without anyone having to remember the rule.
   *
   * Create-* tools are intentionally included: a freshly placed
   * shape auto-selects itself for sidebar editing, but leaving the
   * placement mode (e.g. switching to Pan) ends that session
   * cleanly. Want to keep editing the shape? Switch to Select first.
   */
  const prevActiveToolRef = useRef(activeTool)
  useEffect(() => {
    const prev = prevActiveToolRef.current
    prevActiveToolRef.current = activeTool
    if (prev === activeTool) return
    // Select AND Marquee are both selection modes — switching between
    // them preserves whatever the user already has picked so they can
    // click one shape, then hit Q to lasso a few more, without losing
    // the original.
    if (activeTool === 'select' || activeTool === 'marquee') return
    // React Compiler dislikes synchronous setState inside an effect body.
    // Scheduling the cleanup in a microtask keeps the same behaviour without
    // cascading renders.
    queueMicrotask(() => {
      // Per-kind selections.
      setSelectedGridIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedMarkerIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedCircleIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedPolygonIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedLineIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedImageIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedModelIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedStairIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedTextLabelIds((p) => (p.size > 0 ? new Set() : p))
      // Bin (which cell is staged for the bin editor).
      setSelectedBin(null)
      // Cancel transforms — drafts go too so the overlay snaps back to
      // the persisted geometry instead of holding the in-progress drag.
      setTransform(null)
      setMarkerTransform(null)
      setCircleTransform(null)
      setCircleTransformDraft(null)
      setPolygonTransform(null)
      setPolygonTransformDraft(null)
      setLineTransform(null)
      setLineTransformDraft(null)
      setImageTransform(null)
      setImageTransformDraft(null)
      setModelTransform(null)
      setTextLabelTransform(null)
      setTextLabelTransformDraft(null)
    })
  }, [activeTool])

  /**
   * In-progress circle preview while the user is drawing. Built from the
   * current sub-mode + drag/click state so the overlay can render a
   * translucent ghost of what will be committed.
   */
  const circleLivePreview = useMemo<CircleShape | null>(() => {
    if (activeTool !== 'create-circle') return null
    const now = new Date()
    const baseConfig = { ...circleConfig }
    if (circleSubMode === 'single') {
      if (!circleDragStart || !circleDragCursor) return null
      const radius = distanceMeters(circleDragStart, circleDragCursor)
      if (radius < 0.1) return null
      return {
        kind: 'circle',
        name: '',
        unit: config.unit,
        visible: true,
        mode: 'single',
        center: circleDragStart,
        radius,
        rotation: 0,
        config: baseConfig,
        createdAt: now,
        updatedAt: now,
      } as unknown as CircleShape
    }
    // Grid sub-mode: only render preview once the user has placed the
    // first click and is moving the cursor toward the second.
    if (!circleGridStart || !circleGridCursor) return null
    if (
      circleGridStart[0] === circleGridCursor[0] &&
      circleGridStart[1] === circleGridCursor[1]
    ) {
      return null
    }
    return {
      kind: 'circle',
      name: '',
      unit: config.unit,
      visible: true,
      mode: 'grid',
      start: circleGridStart,
      current: circleGridCursor,
      cellSize: circleCellSize,
      cellRadius: circleCellRadius,
      rotation: 0,
      config: baseConfig,
      createdAt: now,
      updatedAt: now,
    } as unknown as CircleShape
  }, [
    activeTool,
    circleSubMode,
    circleConfig,
    config.unit,
    circleDragStart,
    circleDragCursor,
    circleGridStart,
    circleGridCursor,
    circleCellSize,
    circleCellRadius,
  ])

  /**
   * In-progress bbox preview while the user drags to place an image.
   * Built into a full ImageShape (with no `id`) so the overlay can run
   * it through the same raster + outline pipeline as committed shapes —
   * only the opacity is dimmed by the overlay to mark it as a preview.
   */
  const imageLivePreview = useMemo<ImageShape | null>(() => {
    if (activeTool !== 'create-image') return null
    if (!imageDraft) return null
    if (!imageDragStart || !imageDragCursor) return null
    if (
      Math.abs(imageDragStart[0] - imageDragCursor[0]) < 1e-12 &&
      Math.abs(imageDragStart[1] - imageDragCursor[1]) < 1e-12
    ) {
      return null
    }
    const now = new Date()
    return {
      name: '',
      unit: config.unit,
      visible: true,
      start: imageDragStart,
      current: imageDragCursor,
      rotation: 0,
      imageData: imageDraft.dataUrl,
      imageUrl: imageDraft.imageUrl,
      mimeType: imageDraft.mimeType,
      naturalWidth: imageDraft.naturalWidth,
      naturalHeight: imageDraft.naturalHeight,
      config: { ...imageConfig },
      createdAt: now,
      updatedAt: now,
    }
  }, [
    activeTool,
    imageDraft,
    imageDragStart,
    imageDragCursor,
    imageConfig,
    config.unit,
  ])

  // Call the backfill on mount so older rows get the new label fields.
  // Also seed the default config's display unit from the persisted global
  // preference (or the user's locale).
  useEffect(() => {
    void backfillGridConfig()
    void backfillMarkerConfig()
    void backfillImageConfig()
    void backfillUserModelBounds()
    void backfillUserModelInspectors()
    void (async () => {
      const fallback = defaultUnitForLocale(i18n.language)
      const unit = await getDisplayUnit(fallback)
      setConfig((c) => (c.unit === unit ? c : { ...c, unit }))
      // Mirror the persisted default into the line-drawing HUD unit
      // so segment / total lengths render in the user's preferred
      // unit (m / ft / …) from first mount.
      setDrawingUnit(unit)
    })()
    // Only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePersistDefaultUnit = useCallback((unit: LengthUnit) => {
    void setDisplayUnit(unit)
    // Keep the drawing HUD in sync when the user changes the default
    // via the sidebar picker.
    setDrawingUnit(unit)
  }, [])

  const committedLines = useMemo<CommittedLine[]>(
    () =>
      savedGrids
        .filter((g): g is Grid & { id: number } => g.id !== undefined)
        .map((g) => ({
          id: g.id,
          start: g.start,
          current: g.current,
          config: g.config,
          visible: g.visible,
        })),
    [savedGrids]
  )

  const selectedGrid = useMemo<Grid | null>(() => {
    if (selectedGridIds.size !== 1) return null
    const id = [...selectedGridIds][0]
    return savedGrids.find((g) => g.id === id) ?? null
  }, [selectedGridIds, savedGrids])

  // ---- Zone actions -------------------------------------------------------

  const handleAddZone = useCallback(async (name: string, color: string) => {
    await apiDb.zones.add({ name, color, description: '' })
    queryCache.invalidate('zones')
  }, [])

  const handleDeleteZone = useCallback(
    async (id: number) => {
      // Shapes in the facility are KEPT (unassigned), as the confirmation
      // says. This matters: every shape table's zone_id FK is ON DELETE
      // CASCADE, so deleting the zone with shapes still pointing at it
      // deletes them. (The old loop sent `zoneId: undefined`, which
      // api-db strips — empty PATCHes — so the cascade took the shapes.)
      // Save anything queued first, then one bulk-assign clears zone_id on
      // every kind, then the zone goes.
      const store = useSpatialStore.getState()
      await store.commit().catch(() => {})
      const tables = {
        grid: ['grids', 'grids'],
        marker: ['markers', 'markers'],
        circle: ['circles', 'circles'],
        polygon: ['polygons', 'polygons'],
        line: ['lines', 'lines'],
        model: ['models', 'models'],
        stair: ['stairs', 'stairs'],
        text_label: ['textLabels', 'text-labels'],
        image: ['images', 'images'],
        door: ['doors', 'doors'],
        image_plane: ['imagePlanes', 'image-planes'],
      } as const
      const kinds: Record<string, number[]> = {}
      await Promise.all(
        Object.entries(tables).map(async ([key, [table]]) => {
          const rows = (await (apiDb[table] as { toArray: (q?: string) => Promise<Array<{ id?: number; zoneId?: number | null }>> }).toArray(`zoneId=${id}`))
            .filter((r) => r.zoneId === id && r.id !== undefined)
          if (rows.length > 0) kinds[key] = rows.map((r) => r.id as number)
        }),
      )
      if (Object.keys(kinds).length > 0) {
        await apiPost('/bulk-assign', { zoneId: null, kinds })
      }
      // Routes aren't covered by bulk-assign; they're rare, so one PATCH each.
      const routes = (await apiDb.routes.toArray(`zoneId=${id}`)).filter((r) => r.zoneId === id && r.id !== undefined)
      await Promise.all(routes.map((r) => apiDb.routes.update(r.id as number, { zoneId: null } as never)))
      if (routes.length > 0) void store.loadKind('routes')
      await apiDb.zones.delete(id)
      for (const [key, [, kind]] of Object.entries(tables)) {
        if (kinds[key]) {
          queryCache.invalidate(kind)
          void store.loadKind(kind)
        }
      }
      queryCache.invalidate('zones')
    },
    []
  )

  // ---- Grid draw tool ----------------------------------------------------
  // Owns `hasAnchor` / `drawMode` / `liveStart` / `liveCurrent`, the
  // toolbar ↔ side-panel sync, `MapboxDraw` event listeners, and the
  // live-preview mousemove rAF batcher. Two-way tool ↔ mode sync is
  // driven by `drawModeSourceRef` — the side panel's toggle stamps
  // `'panel'` on it before firing, and the sync effect uses that flag
  // to know whether to echo the change back to the toolbar. Returns
  // setters (used by `handleRedraw` below to seed an existing grid's
  // geometry) plus the memoised `liveLine` overlay input.
  const {
    hasAnchor,
    drawMode,
    liveLine,
    setHasAnchor,
    setDrawMode,
    setLiveStart,
    setLiveCurrent,
    exitDrawMode,
    handleToggleDrawMode,
    drawModeSourceRef,
  } = useGridDrawTool({
    mapInstance,
    drawRef,
    activeTool,
    config,
    savedGrids,
    redrawingGridId,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    pinWarehouseCenterIfNeeded,
    setActiveTool,
    setRedrawingGridId,
  })

  // Consolidated Esc + selection-drop cancellers for the six
  // transforms (circle / marker / polygon / image / line / door).
  useTransformCancelHandlers({
    circleTransform,
    setCircleTransform,
    setCircleTransformDraft,
    selectedCircleIds,
    markerTransform,
    setMarkerTransform,
    selectedMarkerIds,
    polygonTransform,
    setPolygonTransform,
    setPolygonTransformDraft,
    selectedPolygonIds,
    imageTransform,
    setImageTransform,
    setImageTransformDraft,
    selectedImageIds,
    lineTransform,
    setLineTransform,
    setLineTransformDraft,
    selectedLineIds,
    doorTransform,
    setDoorTransform,
    selectedDoorIds,
  })

  // ---- Per-kind CRUD handler hooks ---------------------------------------
  const {
    handleMarkerClick,
    handleSelectMarker,
    handleFitToMarkerById,
    handleDeleteMarkerById,
    handleDuplicateMarker,
    handleExitMarkerPlacement,
    handleStartMoveMarker,
    handleCancelMarkerTransform,
    handleMarkerTransformChange,
    handleMarkerPatch,
    handleRenameMarker,
    handleAssignMarkerToZone,
    handleMarkerConfigChange,
    handleToggleMarkerVisible,
  } = useMarkerHandlers({
    mapInstance,
    savedMarkers,
    selectedMarker,
    markerTransform,
    setSelectedMarkerIds,
    setMarkerTransform,
    setMarkerConfig,
    setSelectedBin,
    setSelectedGridIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedImageIds,
    setSelectedModelIds,
    setSelectedStairIds,
    setActiveTool,
  })

  const {
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
  } = useCircleHandlers({
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
  })

  const {
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
  } = usePolygonHandlers({
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
  })

  const {
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
  } = useLineHandlers({
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
  })

  const {
    handleFitToRouteById,
    handleDeleteRouteById,
    handleRenameRoute,
    handleExitRoutePlacement,
  } = useRouteHandlers({
    mapInstance,
    savedRoutes,
    setSelectedRouteIds,
    setActiveTool,
  })

  const {
    handleStairPatch,
    handleStairConfigChange,
    handleSelectStair,
    handleDeleteStairById,
    handleFitToStairById,
    handleExitStairPlacement,
    handleRenameStair,
    handleDuplicateStair,
    handleAssignStairToZone,
    handleToggleStairVisible,
    handleStartRotateStair,
    handleStartMoveStair,
    handleCancelStairTransform,
    handleStairTransformChange,
  } = useStairHandlers({
    mapInstance,
    savedStairs,
    selectedStair,
    selectedStairIds,
    setSelectedStairIds,
    setStairConfig,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedImageIds,
    setSelectedModelIds,
    setSelectedTextLabelIds,
    setActiveTool,
    stairTransform,
    setStairTransform,
    stairTransformDraft,
    setStairTransformDraft,
  })

  const {
    handleDoorPatch,
    handleDoorConfigChange,
    handleSelectDoor,
    handleDeleteDoorById,
    handleFitToDoorById,
    handleExitDoorPlacement,
    handleRenameDoor,
    handleDuplicateDoor,
    handleSetDoorVisible,
    handleStartMoveDoor,
    handleStartRotateDoor,
    handleStartScaleDoor,
    handleCancelDoorTransform,
    handleDoorTransformChange,
  } = useDoorHandlers({
    mapInstance,
    doors,
    selectedDoorForPanel,
    doorTransform,
    updateDoorConfigInStore,
    renameDoorInStore,
    setDoorVisibleInStore,
    updateDoorInStore,
    deleteDoorInStore,
    duplicateDoorInStore,
    setDoorPendingConfig,
    setSelectedDoorIds,
    setDoorTransform,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedImageIds,
    setSelectedModelIds,
    setSelectedStairIds,
    setActiveTool,
  })

  const {
    handlePickImageFile,
    handleConfirmPdfPage,
    handleCancelPdfPage,
    handleConfirmCadDrawing,
    handleCancelCadDrawing,
    handleClearImageDraft,
    handleSelectImage,
    handleImageClick,
    handleFitToImageById,
    handleDeleteImageById,
    handleDuplicateImage,
    handleExitImagePlacement,
    handleRenameImage,
    handleToggleImageVisible,
    handleAssignImageToZone,
    handleImageConfigChange,
    handleImagePatch,
    handleStartMoveImage,
    handleStartRotateImage,
    handleStartScaleImage,
    handleCancelImageTransform,
    handleImageTransformChange,
    handlePickLibraryImage,
    handleReplaceImageFile,
  } = useImageHandlers({
    activeWarehouseId,
    mapInstance,
    savedImages,
    selectedImage,
    imageTransform,
    imageTransformDraft,
    setSelectedImageIds,
    setImageTransform,
    setImageTransformDraft,
    setImageConfig,
    setImageDraft,
    setPendingPdfFile,
    setPendingCadFile,
    setSelectedBin,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedModelIds,
    setSelectedStairIds,
    setActiveTool,
  })

  // Region-select drag state for the AI Map tool. Two pieces:
  //   - aiDragStartRef: mousedown position (screen + lngLat). Consumed
  //     by the click dispatch below to decide "drag = region" vs "click
  //     = whole image".
  //   - aiDragRect (state, not ref): live rect in SCREEN space during
  //     the drag, driving the semi-transparent preview overlay.
  //     Screen-space is intentional — Mapbox's coord system re-projects
  //     on every camera change, so a lngLat-based preview would jitter
  //     during pan/zoom mid-drag; a screen-space overlay stays glued to
  //     the mouse.
  const aiDragStartRef = useRef<{
    lngLat: [number, number]
    screen: { x: number; y: number }
  } | null>(null)
  const [aiDragRect, setAiDragRect] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  // Marquee (drag-select) tool state. Screen-space rect over the map
  // canvas; on mouseup, everything intersecting the rect gets selected
  // across all kinds. `shiftRef` records whether shift was held on
  // mousedown so an in-progress shift-drag additively selects even if
  // the user releases shift before mouseup.
  const marqueeStartRef = useRef<{
    screen: { x: number; y: number }
    additive: boolean
  } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  // The AI Map tool's target floor plan. Defaults to the editor's
  // active default floor plan (the same one every new shape inherits)
  // so the user usually just clicks Detect without touching the picker.
  // Sidebar picker overrides this when the facility has multiple floors.
  const [aiTargetImageId, setAiTargetImageId] = useState<number | null>(null)
  useEffect(() => {
    // Whenever the AI Map tool activates OR the default floor plan
    // changes underneath us, reset the target to the current default.
    // This keeps the sidebar honest — the target row always reflects
    // "what will actually be detected on" if the user hits Enter.
    if (activeTool === 'ai-map') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAiTargetImageId(defaultFloorPlanId ?? null)
    }
  }, [activeTool, defaultFloorPlanId])

  useEffect(() => {
    const map = mapInstance
    if (!map || activeTool !== 'ai-map') {
      aiDragStartRef.current = null
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAiDragRect(null)
      return
    }
    // Visual signal that the tool is armed. Crosshair matches other
    // draw tools; drag-to-select is the primary UX now so hinting at
    // "make a rectangle" reads better than 'pointer'.
    map.getCanvas().style.cursor = 'crosshair'
    const onDown = (e: mapboxgl.MapMouseEvent) => {
      aiDragStartRef.current = {
        lngLat: [e.lngLat.lng, e.lngLat.lat],
        screen: { x: e.point.x, y: e.point.y },
      }
      setAiDragRect(null)
    }
    const onMove = (e: mapboxgl.MapMouseEvent) => {
      const start = aiDragStartRef.current
      if (!start) return
      const x0 = Math.min(start.screen.x, e.point.x)
      const y0 = Math.min(start.screen.y, e.point.y)
      const w = Math.abs(e.point.x - start.screen.x)
      const h = Math.abs(e.point.y - start.screen.y)
      // Only show the preview once the drag is meaningful — avoids a
      // 0×0 flash on every click.
      if (w < 6 && h < 6) return
      setAiDragRect({ x: x0, y: y0, w, h })
    }
    const clearRect = () => setAiDragRect(null)
    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', clearRect)
    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', clearRect)
      map.getCanvas().style.cursor = ''
      aiDragStartRef.current = null
      setAiDragRect(null)
    }
  }, [mapInstance, activeTool])

  // ---- Marquee (drag-select) tool ---------------------------------------
  // Screen-space rectangle over the map canvas; every shape whose feature
  // is rendered inside the rect (or, for markers, whose projected
  // coordinate falls inside) gets selected. Runs across ALL kinds at once,
  // so this is the codebase's one exception to the "one kind selected at
  // a time" invariant. Plain drag replaces the selection, shift-drag adds.
  //
  // Panning is disabled while the tool is armed — the rect needs stable
  // screen coordinates, and a mid-drag pan would drag the world instead
  // of the rect. Re-enabled on effect cleanup.
  //
  // Marker overlay renders as HTML `mapboxgl.Marker`s (not a Mapbox
  // layer), so markers are hit-tested by projecting each `savedMarker`
  // coordinate through `map.project` and checking screen intersection.
  useEffect(() => {
    const map = mapInstance
    if (!map || activeTool !== 'marquee') {
      marqueeStartRef.current = null
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMarqueeRect(null)
      return
    }
    map.getCanvas().style.cursor = 'crosshair'
    map.dragPan.disable()

    const onDown = (e: mapboxgl.MapMouseEvent) => {
      marqueeStartRef.current = {
        screen: { x: e.point.x, y: e.point.y },
        additive: e.originalEvent.shiftKey,
      }
      setMarqueeRect(null)
    }
    const onMove = (e: mapboxgl.MapMouseEvent) => {
      const start = marqueeStartRef.current
      if (!start) return
      const x0 = Math.min(start.screen.x, e.point.x)
      const y0 = Math.min(start.screen.y, e.point.y)
      const w = Math.abs(e.point.x - start.screen.x)
      const h = Math.abs(e.point.y - start.screen.y)
      if (w < 4 && h < 4) return
      setMarqueeRect({ x: x0, y: y0, w, h })
    }
    const onUp = (e: mapboxgl.MapMouseEvent) => {
      const start = marqueeStartRef.current
      marqueeStartRef.current = null
      setMarqueeRect(null)
      if (!start) return
      const x0 = Math.min(start.screen.x, e.point.x)
      const y0 = Math.min(start.screen.y, e.point.y)
      const x1 = Math.max(start.screen.x, e.point.x)
      const y1 = Math.max(start.screen.y, e.point.y)
      const w = x1 - x0
      const h = y1 - y0
      // A tiny release is a click, not a drag. Fall through to the map's
      // own click plumbing (which routes to handleMapClickEmpty and
      // clears selection on empty canvas).
      if (w < 4 && h < 4) return

      const bbox: [mapboxgl.PointLike, mapboxgl.PointLike] = [
        [x0, y0],
        [x1, y1],
      ]

      // Build the list of layers to query. We look them up on the live
      // style so kinds whose overlay hasn't mounted yet (empty facility)
      // are silently skipped instead of throwing.
      const style = map.getStyle()
      const KIND_LAYERS: ReadonlyArray<{
        kind:
          | 'grid'
          | 'polygon'
          | 'circle'
          | 'line'
          | 'route'
          | 'stair'
          | 'image'
          | 'text-label'
          | 'door'
        /** Static layer ids. */
        layerIds: string[]
        /**
         * Optional prefix — any live layer whose id starts with this is
         * also queried. Polygon / circle / grid render shapes on 11
         * opacity-bucketed extrude layers (`polygon-extrude-layer-op0`
         * … `-op100`), so the query has to walk every bucket to catch
         * every shape.
         */
        layerPrefixes?: string[]
        prop: string
      }> = [
        {
          kind: 'grid',
          layerIds: ['grid-fill-layer', 'grid-line-layer'],
          layerPrefixes: ['grid-extrude-layer-op'],
          prop: 'gridId',
        },
        {
          kind: 'polygon',
          layerIds: ['polygon-line-layer'],
          layerPrefixes: ['polygon-extrude-layer-op'],
          prop: 'polygonId',
        },
        {
          kind: 'circle',
          layerIds: ['circle-fill-layer', 'circle-line-layer'],
          layerPrefixes: ['circle-extrude-layer-op'],
          prop: 'circleId',
        },
        { kind: 'line', layerIds: ['line-stroke-layer'], prop: 'lineId' },
        { kind: 'route', layerIds: ['route-stroke-layer'], prop: 'id' },
        {
          kind: 'stair',
          layerIds: ['stair-step-layer', 'stair-step-border-layer'],
          prop: 'shapeId',
        },
        { kind: 'image', layerIds: ['image-hit-layer'], prop: 'imageId' },
        {
          kind: 'text-label',
          layerIds: ['text-label-layer-viewport', 'text-label-layer-map'],
          prop: 'textLabelId',
        },
        // Door: intentionally excludes `door-tool-arc-layer`. The arc
        // is a swing indicator that protrudes ~1 door-width outside
        // the door body — if we included it, dragging a rect tight
        // around a door would put its arc in the outside strip and
        // filter the door out. Arc is decoration; fill + outline are
        // the actual door surface.
        {
          kind: 'door',
          layerIds: ['door-tool-fill-layer', 'door-tool-outline-layer'],
          prop: 'doorId',
        },
      ]

      // Resolve each kind's live layer list once. Uses `map.getLayer()`
      // directly (not a snapshot of `map.getStyle().layers`) because
      // that snapshot has been observed to be stale in Mapbox 3.x —
      // runtime `addLayer` calls sometimes don't reflect until the
      // next tick. Matches the pattern the individual overlay click
      // handlers use.
      const allLayerIds = (style?.layers ?? []).map((l) => l.id)
      const resolveLayers = (entry: (typeof KIND_LAYERS)[number]): string[] => {
        const out = entry.layerIds.filter((id) => map.getLayer(id) !== undefined)
        if (entry.layerPrefixes) {
          for (const prefix of entry.layerPrefixes) {
            for (const id of allLayerIds) {
              if (id.startsWith(prefix) && map.getLayer(id) !== undefined) {
                out.push(id)
              }
            }
          }
        }
        return out
      }

      const collected: Record<string, Set<number>> = {
        grid: new Set(),
        polygon: new Set(),
        circle: new Set(),
        line: new Set(),
        route: new Set(),
        stair: new Set(),
        image: new Set(),
        'text-label': new Set(),
        door: new Set(),
        model: new Set(),
        'image-plane': new Set(),
        marker: new Set(),
      }

      for (const entry of KIND_LAYERS) {
        const layers = resolveLayers(entry)
        if (layers.length === 0) continue
        try {
          const feats = map.queryRenderedFeatures(bbox, { layers })
          for (const f of feats) {
            const raw = (f.properties as Record<string, unknown> | null)?.[entry.prop]
            const id = typeof raw === 'number' ? raw : Number(raw)
            if (Number.isFinite(id)) collected[entry.kind].add(id)
          }
        } catch {
          // A layer can disappear mid-query if a style rebuild lands
          // between the filter above and the call — swallow and move on.
        }
      }

      // Per-shape layer kinds: enumerate matching layer ids and query
      // each; the id is baked into the layer id itself.
      const perShape: ReadonlyArray<{ kind: 'model' | 'image-plane'; prefix: string }> = [
        { kind: 'model', prefix: 'model-shapes-layer-' },
        { kind: 'image-plane', prefix: 'image-plane-layer-' },
      ]
      for (const entry of perShape) {
        const ids = (style?.layers ?? [])
          .map((l) => l.id)
          .filter((id) => id.startsWith(entry.prefix))
        if (ids.length === 0) continue
        try {
          const hits = map.queryRenderedFeatures(bbox, { layers: ids })
          for (const f of hits) {
            const layerId = (f.layer as { id?: string } | undefined)?.id ?? ''
            if (!layerId.startsWith(entry.prefix)) continue
            const idNum = Number(layerId.slice(entry.prefix.length))
            if (Number.isFinite(idNum)) collected[entry.kind].add(idNum)
          }
        } catch {
          // Style churn — ignore.
        }
      }

      // ---- Full-containment filter (strip subtraction) ------------------
      // Rather than project each shape's raw lng/lat coordinates
      // (which ignores elevation / terrain / pitch and produces a
      // stale, ground-level answer), we ask Mapbox what it actually
      // rendered outside the rect. A candidate that appears in ANY of
      // the four strips around the rect must extend past the edge, so
      // it's not fully contained. Whatever's left after subtracting
      // those outside hits is fully inside — trivially correct at any
      // elevation because we're driving the check with the same
      // renderer that placed the pixels.
      const canvas = map.getCanvas()
      const canvasW = canvas.clientWidth
      const canvasH = canvas.clientHeight
      const outsideStrips: Array<[mapboxgl.PointLike, mapboxgl.PointLike]> = [
        [[0, 0], [canvasW, Math.max(0, y0 - 1)]],
        [[0, Math.min(canvasH, y1 + 1)], [canvasW, canvasH]],
        [[0, Math.max(0, y0 - 1)], [Math.max(0, x0 - 1), Math.min(canvasH, y1 + 1)]],
        [[Math.min(canvasW, x1 + 1), Math.max(0, y0 - 1)], [canvasW, Math.min(canvasH, y1 + 1)]],
      ]
      const outsideIds: Record<string, Set<number>> = {
        grid: new Set(),
        polygon: new Set(),
        circle: new Set(),
        line: new Set(),
        route: new Set(),
        stair: new Set(),
        image: new Set(),
        'text-label': new Set(),
        door: new Set(),
        model: new Set(),
        'image-plane': new Set(),
      }

      const queryStrip = (strip: [mapboxgl.PointLike, mapboxgl.PointLike]) => {
        for (const entry of KIND_LAYERS) {
          const layers = resolveLayers(entry)
          if (layers.length === 0) continue
          try {
            for (const f of map.queryRenderedFeatures(strip, { layers })) {
              const raw = (f.properties as Record<string, unknown> | null)?.[entry.prop]
              const id = typeof raw === 'number' ? raw : Number(raw)
              if (Number.isFinite(id)) outsideIds[entry.kind].add(id)
            }
          } catch {
            /* style churn */
          }
        }
        for (const entry of perShape) {
          const ids = (style?.layers ?? [])
            .map((l) => l.id)
            .filter((id) => id.startsWith(entry.prefix))
          if (ids.length === 0) continue
          try {
            for (const f of map.queryRenderedFeatures(strip, { layers: ids })) {
              const layerId = (f.layer as { id?: string } | undefined)?.id ?? ''
              if (!layerId.startsWith(entry.prefix)) continue
              const idNum = Number(layerId.slice(entry.prefix.length))
              if (Number.isFinite(idNum)) outsideIds[entry.kind].add(idNum)
            }
          } catch {
            /* style churn */
          }
        }
      }
      for (const strip of outsideStrips) {
        // A degenerate zero-area strip (rect flush with a canvas edge)
        // makes Mapbox throw — skip it.
        const w = (strip[1] as [number, number])[0] - (strip[0] as [number, number])[0]
        const h = (strip[1] as [number, number])[1] - (strip[0] as [number, number])[1]
        if (w <= 0 || h <= 0) continue
        queryStrip(strip)
      }

      const filtered: typeof collected = {
        grid: new Set(),
        polygon: new Set(),
        circle: new Set(),
        line: new Set(),
        route: new Set(),
        stair: new Set(),
        image: new Set(),
        'text-label': new Set(),
        door: new Set(),
        model: new Set(),
        'image-plane': new Set(),
        marker: new Set(),
      }
      // Kinds where the "shape" is really a single anchor point — a
      // label, a model instance, a plane. Their rendered pixels (halo,
      // 3D geometry, plane extent) shouldn't disqualify the whole
      // shape when part of them lands outside the rect. If the anchor
      // was inside (i.e. the shape appeared in the initial rect
      // query), that's enough. Marker is handled separately via DOM.
      const ANCHOR_ONLY_KINDS: ReadonlySet<string> = new Set([
        'text-label',
        'model',
        'image-plane',
      ])
      for (const kind of Object.keys(collected)) {
        if (kind === 'marker') continue
        if (ANCHOR_ONLY_KINDS.has(kind)) {
          for (const id of collected[kind]) filtered[kind].add(id)
          continue
        }
        for (const id of collected[kind]) {
          if (!outsideIds[kind]?.has(id)) filtered[kind].add(id)
        }
      }

      // Markers render as absolutely-positioned DOM elements managed by
      // `mapboxgl.Marker`, which places them accounting for pitch and
      // any offset config. Use their live bounding-client-rect (relative
      // to the map container) so elevation-adjusted marker positions
      // are respected without us having to re-implement Mapbox's
      // projection maths.
      const containerRect = map.getContainer().getBoundingClientRect()
      const domMarkers = document.querySelectorAll<HTMLElement>('.shape-marker[data-marker-id]')
      for (const el of Array.from(domMarkers)) {
        const raw = el.dataset.markerId
        if (!raw) continue
        const id = Number(raw)
        if (!Number.isFinite(id)) continue
        const r = el.getBoundingClientRect()
        const mx0 = r.left - containerRect.left
        const my0 = r.top - containerRect.top
        const mx1 = r.right - containerRect.left
        const my1 = r.bottom - containerRect.top
        if (mx0 >= x0 && mx1 <= x1 && my0 >= y0 && my1 <= y1) {
          filtered.marker.add(id)
        }
      }

      // Apply. Shift-drag adds to the current selection; plain drag
      // replaces. Every kind is written independently so cross-kind
      // multi-selection is preserved.
      const merge = (prev: Set<number>, next: Set<number>): Set<number> => {
        if (!start.additive) return next
        if (next.size === 0) return prev
        const out = new Set(prev)
        for (const id of next) out.add(id)
        return out
      }
      setSelectedGridIds((p) => merge(p, filtered.grid))
      setSelectedPolygonIds((p) => merge(p, filtered.polygon))
      setSelectedCircleIds((p) => merge(p, filtered.circle))
      setSelectedLineIds((p) => merge(p, filtered.line))
      setSelectedRouteIds((p) => merge(p, filtered.route))
      setSelectedStairIds((p) => merge(p, filtered.stair))
      setSelectedImageIds((p) => merge(p, filtered.image))
      setSelectedTextLabelIds((p) => merge(p, filtered['text-label']))
      setSelectedDoorIds((p) => merge(p, filtered.door))
      setSelectedModelIds((p) => merge(p, filtered.model))
      setSelectedImagePlaneIds((p) => merge(p, filtered['image-plane']))
      setSelectedMarkerIds((p) => merge(p, filtered.marker))

      // Mapbox can still fire a `click` event on the map after a
      // meaningful drag (especially at small drag distances or high
      // pointer velocity). If we let it through, per-overlay click
      // handlers — the door / polygon / grid / etc. click handlers —
      // will replace our marquee-produced selection with the single
      // shape under the pointer (or clear it entirely via
      // `handleMapClickEmpty` if the release point is on empty
      // canvas). Swallow the very next click at the DOM capture phase
      // so Mapbox's dispatch never runs. Auto-expires in 200 ms so we
      // don't accidentally eat a genuine click later.
      const canvasContainer = map.getCanvasContainer()
      const eatNextClick = (ev: MouseEvent) => {
        // `stopImmediatePropagation` blocks OTHER capture-phase
        // listeners on the same element too — Mapbox may attach its
        // own capture-phase click handler.
        ev.stopImmediatePropagation()
        ev.stopPropagation()
        ev.preventDefault()
        canvasContainer.removeEventListener('click', eatNextClick, true)
      }
      canvasContainer.addEventListener('click', eatNextClick, true)
      setTimeout(() => {
        canvasContainer.removeEventListener('click', eatNextClick, true)
      }, 200)
    }
    const onCancel = () => {
      marqueeStartRef.current = null
      setMarqueeRect(null)
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    // If focus leaves the window mid-drag, drop the state so the rect
    // doesn't reappear when the user comes back with the mouse held.
    window.addEventListener('blur', onCancel)
    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', onUp)
      window.removeEventListener('blur', onCancel)
      map.getCanvas().style.cursor = ''
      map.dragPan.enable()
      marqueeStartRef.current = null
      setMarqueeRect(null)
    }
  }, [
    // Selection is driven entirely by the live Mapbox rendering (via
    // queryRenderedFeatures) + live DOM (for markers), so the saved
    // shape arrays are intentionally NOT dependencies — we don't need
    // to rebind the mouse listeners when a shape changes.
    mapInstance,
    activeTool,
    setSelectedGridIds,
    setSelectedPolygonIds,
    setSelectedCircleIds,
    setSelectedLineIds,
    setSelectedRouteIds,
    setSelectedStairIds,
    setSelectedImageIds,
    setSelectedTextLabelIds,
    setSelectedDoorIds,
    setSelectedModelIds,
    setSelectedImagePlaneIds,
    setSelectedMarkerIds,
  ])

  // Route image clicks. When the AI Map tool is active, clicks on a
  // placed floor plan kick a detection job. If the click was actually
  // a drag (mousedown-to-mouseup pixel distance > threshold), the drag
  // rect becomes a region-select and the backend crops the image
  // before detecting — materially better recall per Qwen/Kimi grounding
  // research. This wrapping keeps useImageHandlers oblivious to the
  // AI tool.
  const handleImageClickDispatch = useCallback(
    (id: number, e: MouseEvent) => {
      if (activeTool === 'ai-map') {
        const drag = aiDragStartRef.current
        aiDragStartRef.current = null
        const map = mapInstance
        // Try region-select. Needs the map to convert lngLat<->UV and
        // the image row to know its persisted bbox.
        if (drag && map) {
          const distPx = Math.hypot(e.offsetX - drag.screen.x, e.offsetY - drag.screen.y)
          if (distPx > 10) {
            const img = savedImages.find((i) => i.id === id)
            if (img) {
              const upLngLat = map.unproject([e.offsetX, e.offsetY])
              const startUV = imageLngLatToUV(img, drag.lngLat[0], drag.lngLat[1])
              const endUV = imageLngLatToUV(img, upLngLat.lng, upLngLat.lat)
              if (startUV && endUV) {
                // Clamp to [0, 1] — user can drag outside the image
                // bounds and we don't want the backend to reject a
                // sub-zero region.
                const clamp = (v: number) => Math.max(0, Math.min(1, v))
                const region = {
                  x0: clamp(Math.min(startUV[0], endUV[0])),
                  y0: clamp(Math.min(startUV[1], endUV[1])),
                  x1: clamp(Math.max(startUV[0], endUV[0])),
                  y1: clamp(Math.max(startUV[1], endUV[1])),
                }
                // Guard against zero-area region (e.g. drag entirely
                // outside image) — fall through to whole-image path.
                if (region.x1 - region.x0 > 0.01 && region.y1 - region.y0 > 0.01) {
                  void aiMap.startForImage(id, region)
                  return
                }
              }
            }
          }
        }
        // Plain click → whole-image detection.
        void aiMap.startForImage(id)
        return
      }
      handleImageClick(id, e)
    },
    [activeTool, aiMap, handleImageClick, mapInstance, savedImages],
  )

  // ---- AI Map accept/reject wiring ---------------------------------------
  // Each accept fires the same apiDb.<kind>.add path a manual draw
  // would use. Successes update the hook state (removes the detection
  // from the pending set) and dedupe queryCache invalidations so a
  // "accept 20 at once" doesn't cause 20 refetches. Failures land as
  // per-detection error messages in the review dialog.
  const runAIAccept = useCallback(async (dets: readonly AIDetection[]): Promise<void> => {
    const wid = activeWarehouseIdRef.current
    if (!wid) {
      // Without an active warehouse the created row would be orphaned
      // (invisible everywhere). Fail loudly per detection rather than
      // silently drop.
      for (const d of dets) aiMap.setPerDetectionError(d.id, 'No active facility — pick one before accepting.')
      return
    }
    const floorId = defaultFloorPlanIdRef.current ?? undefined
    const unit = config.unit
    const results: AcceptResult[] = await Promise.all(
      dets.map((d) => acceptDetection(d, { zoneId: wid, floorPlanId: floorId, unit })),
    )
    const touched = new Set<'lines' | 'polygons' | 'doors' | 'stairs'>()
    for (const r of results) {
      if (r.error) {
        aiMap.setPerDetectionError(r.detectionId, r.error)
        continue
      }
      aiMap.markAccepted(r.detectionId)
      if (r.writtenAs) touched.add(r.writtenAs)
    }
    // One invalidate per kind touched — the SSE broadcast from the
    // backend will also fire, but that's per-entity; the eager local
    // invalidate here shortens the "just accepted, now visible on the
    // map" latency to a single tick.
    for (const kind of touched) queryCache.invalidate(kind)
  }, [aiMap, config.unit])

  const handleAIAccept = useCallback((det: AIDetection) => {
    void runAIAccept([det])
  }, [runAIAccept])

  const handleAIReject = useCallback((det: AIDetection) => {
    aiMap.markRejected(det.id)
    if (aiSelectedDetectionId === det.id) setAiSelectedDetectionId(null)
  }, [aiMap, aiSelectedDetectionId])

  const handleAIAcceptAllAbove = useCallback((thresholdPct: number) => {
    const above = aiMap.pendingDetections.filter(
      (d) => Math.round(d.confidence * 100) >= thresholdPct,
    )
    if (above.length === 0) return
    void runAIAccept(above)
  }, [aiMap.pendingDetections, runAIAccept])

  const {
    handleModelPatch,
    handleModelSwapAsset,
    handleStartMoveModel,
    handleCancelModelTransform,
    handleDuplicateModel,
    handleModelTransformChange,
    handleSelectModel,
    handleFitToModelById,
    handleDeleteModelById,
    handleRenameModel,
    handleAssignModelToZone,
    handleToggleModelVisible,
  } = useModelHandlers({
    mapInstance,
    savedModels,
    selectedModel,
    modelTransform,
    setSelectedModelIds,
    setModelTransform,
    setModelTransformDraft,
    setModelLibraryMode,
    setModelLibraryOpen,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedImageIds,
  })

  const {
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
  } = useTextLabelHandlers({
    mapInstance,
    savedTextLabels,
    setSelectedTextLabelIds,
    setTextLabelTransform,
    setTextLabelTransformDraft,
    setActiveTool,
  })

  const {
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
    handleAssignGridToZone,
    handleToggleGridVisible,
  } = useGridHandlers({
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
  })

  // Deep link from a report row ("Open in editor"): `?select=<kind>:<id>`
  // selects that shape once this facility has loaded and the first
  // viewport fit has run; the select handler then brings it into view.
  // See facilityEditorHref in src/lib/reports/facility-sources.ts.
  const [searchParams] = useSearchParams()
  const selectParam = searchParams.get('select')
  const selectMatch = useMemo(() => (selectParam ? /^([a-z-]+):(\d+)$/.exec(selectParam) : null), [selectParam])
  const selectKind = selectMatch?.[1] as EntityKind | undefined
  const selectKindLoaded = useSpatialStore((s) =>
    selectKind !== undefined && s.loadedFor[selectKind] !== undefined && s.loadedFor[selectKind] === (activeWarehouseId ?? null),
  )
  const deepLinkDoneRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectMatch || !selectParam || deepLinkDoneRef.current === selectParam) return
    if (!mapInstance || !viewportInputsReady || !selectKindLoaded) return
    const handlers: Partial<Record<string, (id: number, additive: boolean) => void>> = {
      polygons: handleSelectPolygon,
      markers: handleSelectMarker,
      grids: handleSelectGrid,
      images: handleSelectImage,
      lines: handleSelectLine,
      doors: handleSelectDoor,
      stairs: handleSelectStair,
      'text-labels': handleSelectTextLabel,
      models: handleSelectModel,
    }
    const select = handlers[selectMatch[1]]
    if (!select) return
    deepLinkDoneRef.current = selectParam
    const id = Number(selectMatch[2])
    select(id, false)
    // The select handlers only pan when the shape is off-screen; a link
    // from a report should land close enough to see the shape itself.
    const state = useSpatialStore.getState() as unknown as Record<string, unknown>
    const key = selectMatch[1] === 'text-labels' ? 'textLabels' : selectMatch[1]
    const shape = (state[key] as Array<Record<string, unknown>> | undefined)?.find((x) => x.id === id)
    const pts: [number, number][] = []
    if (shape) {
      if (Array.isArray(shape.vertices)) pts.push(...(shape.vertices as [number, number][]))
      if (Array.isArray(shape.position)) pts.push(shape.position as [number, number])
      if (Array.isArray(shape.start) && Array.isArray(shape.current)) pts.push(shape.start as [number, number], shape.current as [number, number])
    }
    if (pts.length > 0) {
      const lngs = pts.map((p) => p[0])
      const lats = pts.map((p) => p[1])
      mapInstance.easeTo({
        center: [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2],
        zoom: Math.max(mapInstance.getZoom(), 19),
        duration: 800,
      })
    }
  }, [
    selectMatch,
    selectParam,
    mapInstance,
    viewportInputsReady,
    selectKindLoaded,
    handleSelectPolygon,
    handleSelectMarker,
    handleSelectGrid,
    handleSelectImage,
    handleSelectLine,
    handleSelectDoor,
    handleSelectStair,
    handleSelectTextLabel,
    handleSelectModel,
  ])

  const {
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
  } = useBulkHandlers({
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
  })

  // ---- Toolbar actions ---------------------------------------------------

  // ---- Single-click placement tools (marker / text-label / model) --------
  useMarkerPlacementTool({
    mapInstance,
    activeTool,
    markerConfig,
    configUnit: config.unit,
    t,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    pinWarehouseCenterIfNeeded,
    setMarkerCursor,
    setSelectedMarkerIds,
    setSelectedGridIds,
    setActiveTool,
  })

  useTextLabelPlacementTool({
    mapInstance,
    activeTool,
    textLabelConfig,
    configUnit: config.unit,
    t,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    pinWarehouseCenterIfNeeded,
    setTextLabelCursor,
    setSelectedTextLabelIds,
    setSelectedGridIds,
    setActiveTool,
  })

  useModelPlacementTool({
    mapInstance,
    activeTool,
    modelConfig,
    configUnit: config.unit,
    t,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    pinWarehouseCenterIfNeeded,
    setModelCursor,
    setModelLibraryOpen,
    setSelectedModelIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setActiveTool,
  })

  useCirclePlacementTool({
    mapInstance,
    activeTool,
    circleSubMode,
    circleConfig,
    circleCellSize,
    circleCellRadius,
    circleDragStart,
    circleGridStart,
    configUnit: config.unit,
    t,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    pinWarehouseCenterIfNeeded,
    setCircleDragStart,
    setCircleDragCursor,
    setCircleGridStart,
    setCircleGridCursor,
    setSelectedCircleIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setActiveTool,
  })


  // ---- Vertex-chain draw tools (polygon / line / route) ------------------
  usePolygonDrawTool({
    mapInstance,
    activeTool,
    polygonConfig,
    configUnit: config.unit,
    t,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    polygonVerticesRef,
    pinWarehouseCenterIfNeeded,
    setPolygonDraftVertices,
    setPolygonDraftCursor,
    setSelectedPolygonIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setActiveTool,
  })


  useImagePlacementTool({
    mapInstance,
    activeTool,
    imageConfig,
    imageDraft,
    imageDragStart,
    configUnit: config.unit,
    t,
    activeWarehouseIdRef,
    pinWarehouseCenterIfNeeded,
    setImageDragStart,
    setImageDragCursor,
    setImageDraft,
    setSelectedImageIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setActiveTool,
  })

  useLineDrawTool({
    mapInstance,
    activeTool,
    lineConfig,
    configUnit: config.unit,
    t,
    savedLines,
    defaultFloorPlanId,
    savedImagesRawAll,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    lineVerticesRef,
    pinWarehouseCenterIfNeeded,
    setLineDraftVertices,
    setLineDraftCursor,
    setLineDraftSnap,
    setSelectedLineIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setActiveTool,
  })

  useRouteDrawTool({
    mapInstance,
    activeTool,
    routeConfig,
    configUnit: config.unit,
    t,
    savedRoutes,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    routeVerticesRef,
    pinWarehouseCenterIfNeeded,
    setRouteDraftVertices,
    setRouteDraftCursor,
    setRouteDraftSnap,
    setSelectedRouteIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setActiveTool,
  })

  useStairPlacementTool({
    mapInstance,
    activeTool,
    stairConfig,
    stairDraftAnchors,
    configUnit: config.unit,
    t,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    pinWarehouseCenterIfNeeded,
    setStairDraftAnchors,
    setStairDraftCursor,
    setSelectedStairIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedImageIds,
    setSelectedModelIds,
    setActiveTool,
  })

  useDoorPlacementTool({
    mapInstance,
    activeTool,
    selectedDoorIds,
    doors,
    savedLines,
    doorWallSnap,
    setDoorPendingConfig,
    addDoorToStore,
    setDoorDraftAnchors,
    setDoorDraftCursor,
    setDoorWallSnap,
    setDoorCursorPreview,
    setSelectedDoorIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedImageIds,
    setSelectedModelIds,
    setSelectedStairIds,
    setActiveTool,
  })


  const handleImport = useCallback(async (file: File) => {
    try {
      const ids = await importGridsFromGeoJSONFile(file, 'Imported')
      if (ids.length > 0) {
        // Select the first imported grid so the user can immediately
        // tweak its config in the side panel.
        setSelectedGridIds(new Set([ids[0]]))
        if (!panelOpen) onPanelOpenChange(true)
      }
    } catch (err) {
      console.error('[import] failed', err)
      toast.error(t('toolbar.importError'), { description: err instanceof Error ? err.message : undefined })
    }
  }, [onPanelOpenChange, panelOpen, t])

  const handleExportGeoJSONFromToolbar = useCallback(() => {
    // If a single kind has a selection, export only that kind's
    // selected shapes. Otherwise dump everything across all kinds.
    const gridHits = savedGrids.filter(
      (g): g is Grid => g.id !== undefined && selectedGridIds.has(g.id)
    )
    const markerHits = savedMarkers.filter(
      (m) => m.id !== undefined && selectedMarkerIds.has(m.id)
    )
    const circleHits = savedCircles.filter(
      (c) => c.id !== undefined && selectedCircleIds.has(c.id)
    )
    const polygonHits = savedPolygons.filter(
      (p) => p.id !== undefined && selectedPolygonIds.has(p.id)
    )
    const lineHits = savedLines.filter(
      (l) => l.id !== undefined && selectedLineIds.has(l.id)
    )
    const imageHits = savedImages.filter(
      (img) => img.id !== undefined && selectedImageIds.has(img.id)
    )
    const totalSelected =
      gridHits.length +
      markerHits.length +
      circleHits.length +
      polygonHits.length +
      lineHits.length +
      imageHits.length
    if (totalSelected > 0) {
      exportAllShapesAsGeoJSON({
        grids: gridHits,
        markers: markerHits,
        circles: circleHits,
        polygons: polygonHits,
        lines: lineHits,
        images: imageHits,
        filename: `selection-${totalSelected}-${Date.now()}.geojson`,
      })
      return
    }
    // No selection — export everything.
    exportAllShapesAsGeoJSON({
      grids: savedGrids,
      markers: savedMarkers,
      circles: savedCircles,
      polygons: savedPolygons,
      lines: savedLines,
      images: savedImages,
    })
  }, [
    savedGrids,
    savedMarkers,
    savedCircles,
    savedPolygons,
    savedLines,
    savedImages,
    selectedGridIds,
    selectedMarkerIds,
    selectedCircleIds,
    selectedPolygonIds,
    selectedLineIds,
    selectedImageIds,
  ])

  const handleExportPNGFromToolbar = useCallback(() => {
    if (!mapInstance) return
    const name = selectedGrid?.name ?? `map-${Date.now()}`
    exportMapAsPNG(mapInstance, name)
  }, [mapInstance, selectedGrid])

  const handleFocusZones = useCallback(() => {
    // Open the side panel if it isn't, and scroll to the Zones section.
    if (!panelOpen) onPanelOpenChange(true)
    // The Zones section renders under the "Zones / Sites" heading.
    // We scroll the closest scrollable parent of the heading into view.
    requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>('[data-side-panel-zones-title]')
      if (heading) {
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
        // Add a brief highlight ring so the user sees where it landed.
        heading.classList.add('ring-2', 'ring-primary', 'rounded')
        setTimeout(() => heading.classList.remove('ring-2', 'ring-primary', 'rounded'), 1500)
      }
    })
  }, [onPanelOpenChange, panelOpen])

  /** Navigate to the shareable presentation view, preserving the current warehouse scope. */
  const handlePreview = useCallback(() => {
    if (activeWarehouseId !== null) {
      navigate(`/view/${activeWarehouseId}`)
    } else {
      navigate('/preview')
    }
  }, [navigate, activeWarehouseId])

  // ---- Per-grid config / bulk config writes -------------------------------

  const handlePanelConfigChange = useCallback(
    (newConfig: GridConfig) => {
      if (selectedGridIds.size > 0) {
        // Editing selected rack(s): only the fields that changed are applied,
        // each onto that rack's own config — with several selected, copying
        // the whole panel config used to overwrite every rack's rotation,
        // size and levels with the first one's. The store previews it at
        // once and saves when the edit settles.
        // What the panel showed: the rack's latest config with one selected,
        // the draw defaults with several (that's what the panel renders).
        const only = selectedGridIds.size === 1 ? getSpatialEntity<Grid>('grids', [...selectedGridIds][0]) : undefined
        const shown = only?.config ?? config
        const changed = (Object.keys(newConfig) as (keyof GridConfig)[]).filter(
          (k) => JSON.stringify(newConfig[k]) !== JSON.stringify(shown[k]),
        )
        if (changed.length === 0) return
        const patches: Array<readonly [number, Partial<Grid>]> = []
        for (const id of selectedGridIds) {
          const grid = getSpatialEntity<Grid>('grids', id)
          if (!grid) continue
          const config = { ...grid.config }
          for (const k of changed) (config as Record<string, unknown>)[k] = newConfig[k]
          patches.push([id, { config }] as const)
        }
        useSpatialStore.getState().updateManyLocal('grids', patches)
      } else {
        // Idle / live-draw: just update the in-memory default for the
        // next draw.
        setConfig(newConfig)
      }
    },
    [selectedGridIds, config]
  )

  useUnsavedEditsGuard()

  // Stable toolbar callbacks — `MapToolbar` is memoised, so inline lambdas
  // would re-render it on every edit anywhere in the editor.
  const handleToolbarToolChange = useCallback(
    (tool: MapToolbarTool) => {
      // Clicking the model toolbar icon always reopens the library so
      // the user can switch to a different asset. Without this, once
      // an asset is staged on `modelConfig`, re-clicking the icon is
      // a no-op (React skips the activeTool update because it didn't
      // change), so the user is silently locked into the previous
      // pick.
      if (tool === 'create-model') {
        setModelConfig((cfg) => ({ ...cfg, modelAssetId: undefined }))
        setModelLibraryMode('place')
        setModelLibraryOpen(true)
      }
      setActiveTool(tool)
    },
    [setModelConfig, setModelLibraryMode, setModelLibraryOpen],
  )
  const openExportDialog = useCallback(() => setExportDialogOpen(true), [])
  const openDataLinkManager = useCallback(() => setDataLinkManagerOpen(true), [])
  const openBulkAssign = useCallback(() => setBulkAssignOpen(true), [])
  const openShareDialog = useCallback(() => setShareLinkDialogOpen(true), [])
  const openSchemaBuilder = useCallback(() => setSchemaBuilderOpen(true), [])
  // Handlers that read shape lists / selection: stable for the memoised toolbar.
  const exportGeoJSONStable = useStableCallback(() => handleExportGeoJSONFromToolbar())
  const exportPNGStable = useStableCallback(() => handleExportPNGFromToolbar())
  const focusZonesStable = useStableCallback(() => handleFocusZones())


  // Grid / model / stair edits go through the spatial store (updateLocal),
  // which previews them at once, saves when the edit settles and keeps the
  // draft until the server confirms — no route-level drafts or auto-commit
  // timers, so values can't snap back mid-save.
  const editorHasUnsaved = useSpatialStore((s) => s.sync.pending > 0)

  // (handleReset was wired to the side-panel Reset button, which was
  // removed. Undo/redo via Cmd-Z + auto-committed drafts cover the same
  // "revert my mistake" workflow without a dedicated button.)

  // ---- Undo / Redo ---------------------------------------------------------

  const handleUndo = useCallback(async () => {
    const entry = gridHistory.popUndo()
    if (!entry) return
    if (entry.type === 'delete') {
      // Restore the deleted grids with every field (facility, floor plan,
      // visibility — dropping them left the rack outside the warehouse
      // scope), and remember the new ids so Redo deletes the right rows.
      const now = new Date()
      for (let i = 0; i < entry.grids.length; i++) {
        const { id: _, ...rest } = entry.grids[i]
        const newId = await apiDb.grids.add({ ...rest, updatedAt: now })
        entry.grids[i] = { ...entry.grids[i], id: newId }
      }
      queryCache.invalidate('grids')
    } else if (entry.type === 'redraw') {
      await updateGridGeometry(entry.gridId, entry.oldStart, entry.oldCurrent)
    } else if (entry.type === 'recreate') {
      // Redo of a delete — push the inverse onto the undo stack via history.
      const ids = entry.grids.map((g) => g.id!).filter((id) => id !== undefined)
      await Promise.all(ids.map((id) => apiDb.grids.delete(id)))
      queryCache.invalidate('grids')
    } else if (entry.type === 'delete-marker') {
      const now = new Date()
      for (let i = 0; i < entry.markers.length; i++) {
        const { id: _, ...rest } = entry.markers[i]
        const newId = await apiDb.markers.add({ ...rest, updatedAt: now })
        entry.markers[i] = { ...entry.markers[i], id: newId }
      }
      queryCache.invalidate('markers')
    } else if (entry.type === 'delete-circle') {
      const now = new Date()
      for (let i = 0; i < entry.circles.length; i++) {
        const { id: _, ...rest } = entry.circles[i]
        const newId = await apiDb.circles.add({ ...rest, updatedAt: now })
        entry.circles[i] = { ...entry.circles[i], id: newId }
      }
      queryCache.invalidate('circles')
    } else if (entry.type === 'delete-polygon') {
      const now = new Date()
      for (let i = 0; i < entry.polygons.length; i++) {
        const { id: _, ...rest } = entry.polygons[i]
        const newId = await apiDb.polygons.add({ ...rest, updatedAt: now })
        entry.polygons[i] = { ...entry.polygons[i], id: newId }
      }
      queryCache.invalidate('polygons')
    } else if (entry.type === 'delete-line') {
      const now = new Date()
      for (let i = 0; i < entry.lines.length; i++) {
        const { id: _, ...rest } = entry.lines[i]
        const newId = await apiDb.lines.add({ ...rest, updatedAt: now })
        entry.lines[i] = { ...entry.lines[i], id: newId }
      }
      queryCache.invalidate('lines')
    } else if (entry.type === 'delete-model') {
      const now = new Date()
      for (let i = 0; i < entry.models.length; i++) {
        const { id: _, ...rest } = entry.models[i]
        const newId = await apiDb.models.add({ ...rest, updatedAt: now })
        entry.models[i] = { ...entry.models[i], id: newId }
      }
      queryCache.invalidate('models')
    } else if (entry.type === 'delete-text-label') {
      const now = new Date()
      for (let i = 0; i < entry.textLabels.length; i++) {
        const { id: _, ...rest } = entry.textLabels[i]
        const newId = await apiDb.textLabels.add({ ...rest, updatedAt: now })
        entry.textLabels[i] = { ...entry.textLabels[i], id: newId }
      }
      queryCache.invalidate('text-labels')
    } else if (entry.type === 'delete-stair') {
      const now = new Date()
      for (let i = 0; i < entry.stairs.length; i++) {
        const { id: _, ...rest } = entry.stairs[i]
        const newId = await apiDb.stairs.add({ ...rest, updatedAt: now })
        entry.stairs[i] = { ...entry.stairs[i], id: newId }
      }
      queryCache.invalidate('stairs')
    } else if (entry.type === 'delete-door') {
      const now = new Date()
      for (let i = 0; i < entry.doors.length; i++) {
        const { id: _, ...rest } = entry.doors[i]
        const newId = await apiDb.doors.add({ ...rest, updatedAt: now })
        entry.doors[i] = { ...entry.doors[i], id: newId }
      }
      queryCache.invalidate('doors')
    } else if (entry.type === 'polygon-transform') {
      // Undo — patch the polygon back to its pre-commit vertices/rotation.
      const patch: Partial<PolygonShape> = { updatedAt: new Date() }
      if (entry.prevVertices) patch.vertices = entry.prevVertices
      if (entry.prevRotation !== undefined) patch.rotation = entry.prevRotation
      // Through the store, so a pending draft can't paint over the undo.
      await saveSpatialEntity('polygons', entry.polygonId, patch)
    }
  }, [])

  const handleRedo = useCallback(async () => {
    const entry = gridHistory.popRedo()
    if (!entry) return
    if (entry.type === 'delete') {
      // Redo a delete — delete them again.
      const ids = entry.grids.map((g) => g.id!).filter((id): id is number => id !== undefined)
      await Promise.all(ids.map((id) => apiDb.grids.delete(id)))
      queryCache.invalidate('grids')
    } else if (entry.type === 'recreate') {
      // Redo a recreate (i.e., redo an undo of a delete).
      const now = new Date()
      for (const g of entry.grids) {
        const { id: _, ...rest } = g
        await apiDb.grids.add({ ...rest, updatedAt: now })
      }
      queryCache.invalidate('grids')
    } else if (entry.type === 'redraw') {
      await updateGridGeometry(entry.gridId, entry.newStart, entry.newCurrent)
    } else if (entry.type === 'delete-marker') {
      // Redo a marker delete — re-delete the same shapes by id.
      const ids = entry.markers.map((m) => m.id!).filter((x): x is number => x !== undefined)
      await Promise.all(ids.map((id) => apiDb.markers.delete(id)))
      queryCache.invalidate('markers')
    } else if (entry.type === 'delete-circle') {
      const ids = entry.circles.map((c) => c.id!).filter((x): x is number => x !== undefined)
      await Promise.all(ids.map((id) => apiDb.circles.delete(id)))
      queryCache.invalidate('circles')
    } else if (entry.type === 'delete-polygon') {
      const ids = entry.polygons.map((p) => p.id!).filter((x): x is number => x !== undefined)
      await Promise.all(ids.map((id) => apiDb.polygons.delete(id)))
      queryCache.invalidate('polygons')
    } else if (entry.type === 'delete-line') {
      const ids = entry.lines.map((l) => l.id!).filter((x): x is number => x !== undefined)
      await Promise.all(ids.map((id) => apiDb.lines.delete(id)))
      queryCache.invalidate('lines')
    } else if (entry.type === 'delete-model') {
      const ids = entry.models.map((m) => m.id!).filter((x): x is number => x !== undefined)
      await Promise.all(ids.map((id) => apiDb.models.delete(id)))
      queryCache.invalidate('models')
    } else if (entry.type === 'delete-text-label') {
      const ids = entry.textLabels.map((tl) => tl.id!).filter((x): x is number => x !== undefined)
      await Promise.all(ids.map((id) => apiDb.textLabels.delete(id)))
      queryCache.invalidate('text-labels')
    } else if (entry.type === 'delete-stair') {
      const ids = entry.stairs.map((s) => s.id!).filter((x): x is number => x !== undefined)
      await Promise.all(ids.map((id) => apiDb.stairs.delete(id)))
      queryCache.invalidate('stairs')
    } else if (entry.type === 'delete-door') {
      const ids = entry.doors.map((d) => d.id!).filter((x): x is number => x !== undefined)
      await Promise.all(ids.map((id) => apiDb.doors.delete(id)))
      queryCache.invalidate('doors')
    } else if (entry.type === 'polygon-transform') {
      // Redo — re-apply the forward transform.
      const patch: Partial<PolygonShape> = { updatedAt: new Date() }
      if (entry.newVertices) patch.vertices = entry.newVertices
      if (entry.newRotation !== undefined) patch.rotation = entry.newRotation
      await saveSpatialEntity('polygons', entry.polygonId, patch)
    }
  }, [])

  // ---- Keyboard shortcuts --------------------------------------------------
  // (Hook + dispatchers are wired further down, after all per-kind
  // delete/duplicate handlers exist — see `useKeyboardShortcuts` call
  // near the bottom of this component.)

  // Generalized selection / transform dispatchers used by the
  // `useKeyboardShortcuts` hook. The per-kind handlers below pick the
  // first non-empty selection set and route to the matching existing
  // callback — the hook itself owns no business logic.

  // ---- Expose actions on window in dev mode for testing ------------------
  // Playwright's `press('Control+z')` doesn't always set ctrlKey in headless
  // Chromium, so we expose the handlers on window for direct invocation.
  useEffect(() => {
    if (!import.meta.env.DEV) return
      ; (window as unknown as {
        __gridActions?: {
          undo: () => Promise<void>
          redo: () => Promise<void>
          deleteSelected: () => Promise<void>
          duplicate: (id: number) => Promise<void>
          redraw: (id: number) => void
          rename: (id: number, name: string) => Promise<void>
          fitToGrid: () => void
          exportGeoJSON: () => void
          exportPNG: () => void
          deselect: () => void
          setSelectedGridIds: (ids: number[]) => void
          startMove: (id: number) => void
          startRotate: (id: number) => void
          cancelTransform: () => void
        }
      }).__gridActions = {
        undo: () => handleUndo(),
        redo: () => handleRedo(),
        deleteSelected: () => handleDeleteSelected(),
        duplicate: (id: number) => handleDuplicate(id),
        redraw: (id: number) => handleRedraw(id),
        rename: (id: number, name: string) => handleRename(id, name),
        fitToGrid: () => handleFitToGrid(),
        exportGeoJSON: () => handleExportGeoJSON(),
        exportPNG: () => handleExportPNG(),
        deselect: () => handleDeselect(),
        setSelectedGridIds: (ids: number[]) => setSelectedGridIds(new Set(ids)),
        startMove: (id: number) => handleStartMove(id),
        startRotate: (id: number) => handleStartRotate(id),
        cancelTransform: () => handleCancelTransform(),
      }
  }, [
    handleUndo,
    handleRedo,
    handleDeleteSelected,
    handleDuplicate,
    handleRedraw,
    handleRename,
    handleFitToGrid,
    handleExportGeoJSON,
    handleExportPNG,
    handleDeselect,
    handleStartMove,
    handleStartRotate,
    handleCancelTransform,
  ])
  // Stable for the status bar's Undo / Redo buttons.
  const undoStable = useStableCallback(() => void handleUndo())
  const redoStable = useStableCallback(() => void handleRedo())

  // ---- Magic-wall handlers ------------------------------------------------
  //
  // The magic-wall tool lets the user pick one or more polygons and
  // spawn walls (LineShape rows) around them in one action: shared
  // edges between adjacent polygons collapse to ONE party wall, and
  // segments already covered by an existing wall are skipped. The
  // algorithm itself lives in `@/lib/magic-wall-generator`. Everything
  // here is UI plumbing.

  const handleMagicWallTogglePolygon = useCallback(
    (id: number) => {
      setMagicWallSelectedPolygonIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [],
  )

  const handleExitMagicWall = useCallback(() => {
    setMagicWallSelectedPolygonIds(new Set())
    setActiveTool('pan')
  }, [setActiveTool])

  const handleGenerateMagicWall = useCallback(() => {
    if (magicWallSelectedPolygonIds.size === 0) return
    if (magicWallBusy) return
    const picked = savedPolygons.filter(
      (p) => p.id !== undefined && magicWallSelectedPolygonIds.has(p.id),
    )
    if (picked.length === 0) return
    const polylines = generateMagicWallPolylines(picked, savedLines, {
      wallThicknessMeters: lineConfig.wallThickness ?? 0.3,
    })
    if (polylines.length === 0) {
      setMagicWallSelectedPolygonIds(new Set())
      setActiveTool('select')
      return
    }
    const now = new Date()
    const wid = activeWarehouseIdRef.current
    const floorId = defaultFloorPlanIdRef.current ?? undefined
    const defaultName = t('magicWall.defaultWallName', { defaultValue: 'Wall' })
    setMagicWallBusy(true)
    void (async () => {
      try {
        // Parallel POSTs — Promise.all over ~dozens of walls is much
        // faster than sequential awaits. Each polyline gets the
        // caller's full `lineConfig` unmodified (one closed ring per
        // polygon at the tool's current wall thickness).
        const results = await Promise.all(
          polylines.map((pl) =>
            apiDb.lines.add({
              name: defaultName,
              unit: config.unit,
              visible: true,
              zoneId: wid ?? undefined,
              floorPlanId: floorId,
              vertices: pl.vertices,
              rotation: 0,
              config: { ...lineConfig },
              createdAt: now,
              updatedAt: now,
            }),
          ),
        )
        const newIds = results.filter(
          (id): id is number => typeof id === 'number',
        )
        queryCache.invalidate('lines')
        setMagicWallSelectedPolygonIds(new Set())
        setSelectedLineIds(new Set(newIds))
        setActiveTool('select')
      } finally {
        setMagicWallBusy(false)
      }
    })()
  }, [
    magicWallSelectedPolygonIds,
    magicWallBusy,
    savedPolygons,
    savedLines,
    lineConfig,
    config.unit,
    activeWarehouseIdRef,
    defaultFloorPlanIdRef,
    t,
    setSelectedLineIds,
    setActiveTool,
  ])

  // Effective polygon-selection set the map overlay highlights. In
  // magic-wall mode we swap in the magic-wall picks so the user sees
  // their staged selection with the same visual style as a normal
  // polygon selection — no new highlight layer needed.
  const polygonOverlaySelectedIds = useMemo<Set<number>>(
    () =>
      activeTool === 'magic-wall'
        ? magicWallSelectedPolygonIds
        : selectedPolygonIds,
    [activeTool, magicWallSelectedPolygonIds, selectedPolygonIds],
  )

  // Wraps the normal polygon-click handler so a click while the magic-
  // wall tool is active only toggles the polygon in the magic-wall set
  // instead of selecting it in the usual way.
  const handlePolygonClickRouted = useCallback(
    (id: number, e: MouseEvent) => {
      if (activeTool === 'magic-wall') {
        handleMagicWallTogglePolygon(id)
        return
      }
      handlePolygonClick(id, e)
    },
    [activeTool, handleMagicWallTogglePolygon, handlePolygonClick],
  )

  // ---- Panel mode ---------------------------------------------------------

  // Distinct-kind count — used both to detect cross-kind selections
  // (2+ kinds) for the sidebar's cross-kind bulk view, and to render
  // the "N selected · K kinds" count in the floating map action bar.
  // Cheap; runs every render.
  const selectedKindCountForPanel = (() => {
    let n = 0
    if (selectedGridIds.size > 0) n++
    if (selectedMarkerIds.size > 0) n++
    if (selectedCircleIds.size > 0) n++
    if (selectedPolygonIds.size > 0) n++
    if (selectedLineIds.size > 0) n++
    if (selectedImageIds.size > 0) n++
    if (selectedModelIds.size > 0) n++
    if (selectedStairIds.size > 0) n++
    if (selectedDoorIds.size > 0) n++
    if (selectedTextLabelIds.size > 0) n++
    if (selectedRouteIds.size > 0) n++
    if (selectedImagePlaneIds.size > 0) n++
    return n
  })()
  const isCrossKindSelection = selectedKindCountForPanel >= 2

  const panelMode: SidePanelMode = useMemo(() => {
    if (activeTool === 'magic-wall') return 'magic-wall'
    if (activeTool === 'ai-map') return 'ai-map'
    // Cross-kind selection (2+ different kinds selected simultaneously,
    // typically produced by the marquee tool) short-circuits the per-
    // kind priority order below. The dedicated bulk view lists every
    // selected kind with its own count and the shared actions
    // (Delete / Hide / Show / Change floor) — without this the sidebar
    // would fall through to a single higher-priority kind's editor
    // and hide the fact that other kinds are also selected.
    if (isCrossKindSelection) return 'cross-kind-bulk'
    if (selectedMarkerIds.size === 1) return 'marker-selected'
    if (selectedMarkerIds.size > 1) return 'marker-bulk'
    if (selectedCircleIds.size === 1) return 'circle-selected'
    if (selectedCircleIds.size > 1) return 'circle-bulk'
    if (selectedPolygonIds.size === 1) return 'polygon-selected'
    if (selectedPolygonIds.size > 1) return 'polygon-bulk'
    if (selectedLineIds.size === 1) return 'line-selected'
    if (selectedLineIds.size > 1) return 'line-bulk'
    if (selectedRouteIds.size === 1) return 'route-selected'
    if (selectedImageIds.size === 1) return 'image-selected'
    if (selectedImageIds.size > 1) return 'image-bulk'
    if (selectedModelIds.size === 1) return 'model-selected'
    if (selectedModelIds.size > 1) return 'model-bulk'
    if (selectedStairIds.size === 1) return 'stair-selected'
    if (selectedStairIds.size > 1) return 'stair-bulk'
    if (selectedDoorIds.size === 1) return 'door-selected'
    if (selectedDoorIds.size > 1) return 'door-bulk'
    if (selectedTextLabelIds.size === 1) return 'text-selected'
    if (selectedTextLabelIds.size > 1) return 'text-bulk'
    if (selectedImagePlaneIds.size === 1) return 'image-plane-selected'
    if (drawMode) return 'live-draw'
    if (activeTool === 'create-marker') return 'marker-placement'
    if (activeTool === 'create-circle') return 'circle-placement'
    if (activeTool === 'create-polygon') return 'polygon-placement'
    if (activeTool === 'create-line') return 'line-placement'
    if (activeTool === 'create-route') return 'route-placement'
    if (activeTool === 'create-image') return 'image-placement'
    if (activeTool === 'create-model') return 'model-placement'
    if (activeTool === 'create-text') return 'text-placement'
    if (activeTool === 'create-stair') return 'stair-placement'
    if (activeTool === 'create-door') return 'door-placement'
    if (activeTool === 'create-image-plane') return 'image-plane-placement'
    if (selectedGridIds.size === 1) return 'grid-selected'
    if (selectedGridIds.size > 1) return 'bulk-select'
    return 'idle'
  }, [
    drawMode,
    activeTool,
    selectedGridIds,
    selectedMarkerIds,
    selectedCircleIds,
    selectedPolygonIds,
    selectedLineIds,
    selectedRouteIds,
    selectedImageIds,
    selectedModelIds,
    selectedStairIds,
    selectedDoorIds,
    selectedTextLabelIds,
    selectedImagePlaneIds,
    isCrossKindSelection,
  ])

  const panelConfig: GridConfig = useMemo(() => {
    if (panelMode === 'grid-selected' && selectedGrid) return selectedGrid.config
    return config
  }, [panelMode, selectedGrid, config])

  // Unsaved edits are merged into the grid by the store already.
  const selectedGridForPanel = selectedGrid

  // The config shown in the panel + the change handler — differs per mode.
  const handlePanelConfigChangeWrapped = useCallback(
    (newConfig: GridConfig) => {
      void handlePanelConfigChange(newConfig)
    },
    [handlePanelConfigChange]
  )


  // ---- Image actions -------------------------------------------------------

  /**
   * Per-shape eye toggle handlers driven by the sidebar's saved-shapes
   * lists. Each one flips the row's `visible` flag and persists via the
   * shared `apiDb` so the change survives reloads. The map overlays
   * already filter `visible === false`, so the on-map render updates as
   * soon as the spatial-store sync echoes the patch back.
   *
   * Why this exists: when the user has stacked floors, the upper-floor
   * polygons / circles / aisles paint over the ground-floor shapes,
   * making it impossible to click/select what's beneath. Toggling the
   * eye on the offending row dims it out so the user can interact with
   * the underlying shape without deleting anything.
   */


  // Deselect handler that also clears marker + circle + polygon + line + image + model + text selection.
  const handleDeselectAll = useCallback(() => {
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
    setSelectedImagePlaneIds((prev) => (prev.size > 0 ? new Set() : prev))
    setActiveTool((t) =>
      t === 'create-marker' ||
        t === 'create-circle' ||
        t === 'create-polygon' ||
        t === 'create-line' ||
        t === 'create-image' ||
        t === 'create-image-plane' ||
        t === 'create-text'
        ? 'pan'
        : t
    )
  }, [])

  // ---- Bulk-assign --------------------------------------------------------
  // The bulk-assign dialog owns its own selection — the user picks
  // which shapes to reassign from a checkbox list inside the modal
  // (the route's per-kind selection sets only support one-kind-at-a-
  // time which isn't enough for cross-kind bulk operations). We do
  // still seed the dialog with whatever's selected on the map so the
  // common single-selection flow stays one click.
  const totalMapSelection =
    selectedGridIds.size +
    selectedMarkerIds.size +
    selectedCircleIds.size +
    selectedPolygonIds.size +
    selectedLineIds.size +
    selectedImageIds.size +
    selectedModelIds.size +
    selectedStairIds.size +
    selectedDoorIds.size +
    selectedTextLabelIds.size +
    selectedRouteIds.size +
    selectedImagePlaneIds.size

  // Cross-kind selection detection is computed above (before panelMode)
  // as `selectedKindCountForPanel` / `isCrossKindSelection` so the
  // panel-mode useMemo can consume it. Aliased here to keep the
  // downstream cross-kind handlers readable.
  const selectedKindCount = selectedKindCountForPanel

  // Cross-kind bulk actions. Each fans out to whatever the individual
  // kinds already expose — bulk handlers where they exist, per-id
  // handlers or `deleteLocal` for the three kinds without bulk
  // (grids, routes, image-planes). Nothing here is a new persistence
  // path; the marquee flow reuses the same optimistic pipes the side
  // panel uses per kind.
  const handleCrossKindDelete = useCallback(() => {
    if (selectedGridIds.size > 0) {
      for (const id of selectedGridIds) handleDeleteGridById(id)
    }
    if (selectedRouteIds.size > 0) {
      for (const id of selectedRouteIds) handleDeleteRouteById(id)
    }
    if (selectedImagePlaneIds.size > 0) {
      const store = useSpatialStore.getState()
      for (const id of selectedImagePlaneIds) store.deleteLocal('image-planes', id)
      setSelectedImagePlaneIds(new Set())
    }
    if (selectedMarkerIds.size > 0) handleBulkDeleteMarkers()
    if (selectedCircleIds.size > 0) handleBulkDeleteCircles()
    if (selectedPolygonIds.size > 0) handleBulkDeletePolygons()
    if (selectedLineIds.size > 0) handleBulkDeleteLines()
    if (selectedStairIds.size > 0) handleBulkDeleteStairs()
    if (selectedDoorIds.size > 0) handleBulkDeleteDoors()
    if (selectedModelIds.size > 0) handleBulkDeleteModels()
    if (selectedTextLabelIds.size > 0) handleBulkDeleteTextLabels()
    if (selectedImageIds.size > 0) handleBulkDeleteImages()
  }, [
    selectedGridIds,
    selectedRouteIds,
    selectedImagePlaneIds,
    selectedMarkerIds,
    selectedCircleIds,
    selectedPolygonIds,
    selectedLineIds,
    selectedStairIds,
    selectedDoorIds,
    selectedModelIds,
    selectedTextLabelIds,
    selectedImageIds,
    handleDeleteGridById,
    handleDeleteRouteById,
    setSelectedImagePlaneIds,
    handleBulkDeleteMarkers,
    handleBulkDeleteCircles,
    handleBulkDeletePolygons,
    handleBulkDeleteLines,
    handleBulkDeleteStairs,
    handleBulkDeleteDoors,
    handleBulkDeleteModels,
    handleBulkDeleteTextLabels,
    handleBulkDeleteImages,
  ])

  const handleCrossKindSetVisibility = useCallback(
    (visible: boolean) => {
      const now = new Date()
      const apply = (kind: Parameters<typeof patchSpatialEntity>[0], ids: ReadonlySet<number>) => {
        for (const id of ids) void patchSpatialEntity(kind, id, { visible, updatedAt: now })
      }
      apply('grids', selectedGridIds)
      apply('markers', selectedMarkerIds)
      apply('circles', selectedCircleIds)
      apply('polygons', selectedPolygonIds)
      apply('lines', selectedLineIds)
      apply('routes', selectedRouteIds)
      apply('stairs', selectedStairIds)
      apply('doors', selectedDoorIds)
      apply('models', selectedModelIds)
      apply('text-labels', selectedTextLabelIds)
      apply('images', selectedImageIds)
      apply('image-planes', selectedImagePlaneIds)
    },
    [
      selectedGridIds,
      selectedMarkerIds,
      selectedCircleIds,
      selectedPolygonIds,
      selectedLineIds,
      selectedRouteIds,
      selectedStairIds,
      selectedDoorIds,
      selectedModelIds,
      selectedTextLabelIds,
      selectedImageIds,
      selectedImagePlaneIds,
    ],
  )

  const handleCrossKindClearSelection = useCallback(() => {
    setSelectedGridIds(new Set())
    setSelectedMarkerIds(new Set())
    setSelectedCircleIds(new Set())
    setSelectedPolygonIds(new Set())
    setSelectedLineIds(new Set())
    setSelectedRouteIds(new Set())
    setSelectedStairIds(new Set())
    setSelectedDoorIds(new Set())
    setSelectedModelIds(new Set())
    setSelectedTextLabelIds(new Set())
    setSelectedImageIds(new Set())
    setSelectedImagePlaneIds(new Set())
  }, [
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
    setSelectedRouteIds,
    setSelectedStairIds,
    setSelectedDoorIds,
    setSelectedModelIds,
    setSelectedTextLabelIds,
    setSelectedImageIds,
    setSelectedImagePlaneIds,
  ])

  // ---- Map keyboard handler gating --------------------------------------
  // Mapbox GL JS attaches its own keydown listener directly on the
  // canvas — arrow keys pan, +/- zoom, shift+arrow rotates pitch, and
  // so on. Those fire BEFORE the window-level `useKeyboardShortcuts`
  // listener (DOM bubbling order), so calling `e.preventDefault()` in
  // our hook is too late: the map has already moved.
  //
  // While the user has anything selected we want arrows / +- to nudge
  // and resize the SHAPE, not the basemap. The cleanest way to do that
  // without intercepting events at the capture phase is to disable
  // Mapbox's keyboard handler entirely while a selection exists, and
  // re-enable it as soon as everything is deselected. This is a
  // built-in Mapbox API so it's safe across versions.
  useEffect(() => {
    if (!mapInstance) return
    if (totalMapSelection > 0) {
      mapInstance.keyboard?.disable?.()
    } else {
      mapInstance.keyboard?.enable?.()
    }
    return () => {
      // Restore on unmount / map swap so a future map mount doesn't
      // start with keyboard interaction silently dead.
      mapInstance.keyboard?.enable?.()
    }
  }, [mapInstance, totalMapSelection])


  // ---- Keyboard shortcuts: cross-kind dispatchers + hook wiring ---------
  const keyboardState = useKeyboardDispatch({
    preview,
    activeTool,
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
  })
  const setCheatsheetOpen = keyboardState.setCheatsheetOpen
  const openCheatsheet = useCallback(() => setCheatsheetOpen(true), [setCheatsheetOpen])



  /**
   * Apply the user's bulk-assign patch to the dialog's checked items in
   * ONE backend round trip. `selection` is the dialog's local state
   * (independent from the map / sidebar selection); `patch` names the
   * zone and/or floor-plan destination (each field: undefined = skip,
   * null = clear, number = assign).
   *
   * The previous implementation fired one PATCH per id per kind (via
   * `apiDb.X.update(id, …)` in a `for/await` loop), which turned a
   * 200-item selection into 200 sequential HTTP calls plus 200 SSE
   * broadcasts. This now hits `POST /api/v1/bulk-assign` once with the
   * full id list per kind — the backend does a single `UPDATE ...
   * WHERE id = ANY($ids)` per kind and broadcasts one SSE per updated
   * row. Local caches are invalidated by kind afterward so the SSE
   * reload lands the new state in the UI.
   */

  const sidePanelActions = useMemo<SidePanelActions>(
    () => ({
      onRedraw: handleRedraw,
      onDuplicate: handleDuplicate,
      onDeleteSelected: handleDeleteSelected,
      onRename: handleRename,
      onFitToGrid: handleFitToGrid,
      onExportGeoJSON: handleExportGeoJSON,
      onExportPNG: handleExportPNG,
      onDeselect: handleDeselectAll,
      onSelectGrid: handleSelectGrid,
      onFitToGridById: handleFitToGridById,
      onDeleteGridById: handleDeleteGridById,
      onAssignGridToZone: handleAssignGridToZone,
      onAddZone: handleAddZone,
      onDeleteZone: handleDeleteZone,
      onStartMove: handleStartMove,
      onStartRotate: handleStartRotate,
      onStartScale: handleStartScale,
      onCancelTransform: handleCancelTransform,
      onOpenBinEditor: () => setBinDialogOpen(true),
      onEditShapeData: (target) => {
        setShapeEditorTarget(target)
        setShapeEditorOpen(true)
      },
      transformActive: transform !== null,
      transformKind: transform?.kind ?? null,
      onSelectMarker: handleSelectMarker,
      onFitToMarkerById: handleFitToMarkerById,
      onDeleteMarkerById: handleDeleteMarkerById,
      onDuplicateMarker: handleDuplicateMarker,
      onExitMarkerPlacement: handleExitMarkerPlacement,
      onAssignMarkerToZone: handleAssignMarkerToZone,
      onRenameMarker: handleRenameMarker,
      onStartMoveMarker: handleStartMoveMarker,
      onCancelMarkerTransform: handleCancelMarkerTransform,
      markerTransformActive: markerTransform !== null,
      markerTransformKind: markerTransform?.kind ?? null,
      onSelectCircle: handleSelectCircle,
      onFitToCircleById: handleFitToCircleById,
      onDeleteCircleById: handleDeleteCircleById,
      onDuplicateCircle: handleDuplicateCircle,
      onExitCirclePlacement: handleExitCirclePlacement,
      onAssignCircleToZone: handleAssignCircleToZone,
      onRenameCircle: handleRenameCircle,
      onSelectPolygon: handleSelectPolygon,
      onFitToPolygonById: handleFitToPolygonById,
      onDeletePolygonById: handleDeletePolygonById,
      onDuplicatePolygon: handleDuplicatePolygon,
      onExitPolygonPlacement: handleExitPolygonPlacement,
      onAssignPolygonToZone: handleAssignPolygonToZone,
      onRenamePolygon: handleRenamePolygon,
      onStartMovePolygon: handleStartMovePolygon,
      onStartRotatePolygon: handleStartRotatePolygon,
      onStartEditPolygon: handleStartEditPolygon,
      onCancelPolygonTransform: handleCancelPolygonTransform,
      polygonTransformActive: polygonTransform !== null,
      polygonTransformKind: polygonTransform?.kind ?? null,
      onStartMoveCircle: handleStartMoveCircle,
      onStartRotateCircle: handleStartRotateCircle,
      onCancelCircleTransform: handleCancelCircleTransform,
      circleTransformActive: circleTransform !== null,
      circleTransformKind: circleTransform?.kind ?? null,
      onSelectLine: handleSelectLine,
      onFitToLineById: handleFitToLineById,
      onDeleteLineById: handleDeleteLineById,
      onDuplicateLine: handleDuplicateLine,
      onExitLinePlacement: handleExitLinePlacement,
      onAssignLineToZone: handleAssignLineToZone,
      onRenameLine: handleRenameLine,
      onStartMoveLine: handleStartMoveLine,
      onStartRotateLine: handleStartRotateLine,
      onCancelLineTransform: handleCancelLineTransform,
      lineTransformActive: lineTransform !== null,
      lineTransformKind: lineTransform?.kind ?? null,
      onFitToRouteById: handleFitToRouteById,
      onDeleteRouteById: handleDeleteRouteById,
      onRenameRoute: handleRenameRoute,
      onExitRoutePlacement: handleExitRoutePlacement,
      onBulkDeleteMarkers: handleBulkDeleteMarkers,
      onBulkPatchMarkers: handleBulkPatchMarkers,
      onBulkFitMarkers: handleBulkFitMarkers,
      onBulkDeleteCircles: handleBulkDeleteCircles,
      onBulkPatchCircles: handleBulkPatchCircles,
      onBulkFitCircles: handleBulkFitCircles,
      onBulkDeletePolygons: handleBulkDeletePolygons,
      onBulkFitPolygons: handleBulkFitPolygons,
      onBulkPatchPolygons: handleBulkPatchPolygons,
      onBulkDeleteLines: handleBulkDeleteLines,
      onBulkPatchLines: handleBulkPatchLines,
      onBulkFitLines: handleBulkFitLines,
      onBulkDeleteStairs: handleBulkDeleteStairs,
      onBulkFitStairs: handleBulkFitStairs,
      onBulkPatchStairs: handleBulkPatchStairs,
      onBulkDeleteDoors: handleBulkDeleteDoors,
      onBulkFitDoors: handleBulkFitDoors,
      onBulkPatchDoors: handleBulkPatchDoors,
      onBulkDeleteModels: handleBulkDeleteModels,
      onBulkFitModels: handleBulkFitModels,
      onBulkPatchModels: handleBulkPatchModels,
      onBulkDeleteTextLabels: handleBulkDeleteTextLabels,
      onBulkFitTextLabels: handleBulkFitTextLabels,
      onBulkPatchTextLabels: handleBulkPatchTextLabels,
      onCrossKindDelete: handleCrossKindDelete,
      onCrossKindSetVisibility: handleCrossKindSetVisibility,
      onCrossKindChangeFloor: () => setBulkAssignOpen(true),
      onCrossKindClear: handleCrossKindClearSelection,
      onSelectImage: handleSelectImage,
      onFitToImageById: handleFitToImageById,
      onDeleteImageById: handleDeleteImageById,
      onDuplicateImage: handleDuplicateImage,
      onExitImagePlacement: handleExitImagePlacement,
      onAssignImageToZone: handleAssignImageToZone,
      onRenameImage: handleRenameImage,
      onStartMoveImage: handleStartMoveImage,
      onStartRotateImage: handleStartRotateImage,
      onStartScaleImage: handleStartScaleImage,
      onCancelImageTransform: handleCancelImageTransform,
      imageTransformActive: imageTransform !== null,
      imageTransformKind: imageTransform?.kind ?? null,
      onBulkDeleteImages: handleBulkDeleteImages,
      onBulkPatchImages: handleBulkPatchImages,
      onBulkFitImages: handleBulkFitImages,
      onPickImageFile: handlePickImageFile,
      onPickLibraryImage: handlePickLibraryImage,
      onReplaceImageFile: handleReplaceImageFile,
      onClearImageDraft: handleClearImageDraft,
      onToggleImageVisible: handleToggleImageVisible,
      onReorderFloorPlans: handleReorderFloorPlans,
      // ---- Magic-wall actions ----
      onGenerateMagicWall: handleGenerateMagicWall,
      onExitMagicWall: handleExitMagicWall,
      // ---- AI Map actions ----
      onDetectFloorPlan: (id: number) => { void aiMap.startForImage(id) },
      onSetAIMapTarget: (id: number | null) => { setAiTargetImageId(id) },
      onExitAIMap: () => { setActiveTool('pan') },
      // Per-shape eye toggles (sidebar saved-shapes lists).
      onToggleGridVisible: handleToggleGridVisible,
      onTogglePolygonVisible: handleTogglePolygonVisible,
      onToggleCircleVisible: handleToggleCircleVisible,
      onToggleLineVisible: handleToggleLineVisible,
      onToggleStairVisible: handleToggleStairVisible,
      onToggleMarkerVisible: handleToggleMarkerVisible,
      onToggleModelVisible: handleToggleModelVisible,
      onToggleTextLabelVisible: handleToggleTextLabelVisible,
      // ---- Image-plane actions ----
      onSelectImagePlane: (id: number, additive: boolean) => {
        // Clear sibling selections (matching every other shape's handler)
        setSelectedGridIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedMarkerIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedCircleIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedPolygonIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedLineIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedImageIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedModelIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedStairIds((p) => (p.size > 0 ? new Set() : p))
        setSelectedImagePlaneIds((prev) => {
          if (additive) {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          }
          return new Set([id])
        })
        const plane = savedImagePlanes.find((p) => p.id === id)
        if (plane && plane.position) {
          fitBoundsIfOffscreen(
            mapInstance,
            [plane.position[0], plane.position[1], plane.position[0], plane.position[1]],
            { additive, targetZoom: 19 },
          )
        }
      },
      onFitToImagePlaneById: (id: number) => {
        const plane = savedImagePlanes.find((p) => p.id === id)
        if (!plane || !mapInstance) return
        mapInstance.flyTo({ center: plane.position, zoom: 19, duration: 600 })
      },
      onDeleteImagePlaneById: (id: number) => {
        useSpatialStore.getState().deleteLocal('image-planes', id)
        setSelectedImagePlaneIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      },
      onDuplicateImagePlane: async (id: number) => {
        const plane = savedImagePlanes.find((p) => p.id === id)
        if (!plane) return
        // Offset the duplicate slightly to the east so it doesn't sit
        // exactly on top of the original.
        const copy: Omit<ImagePlaneShape, 'id'> = {
          name: copyName('image-planes', plane.name),
          position: [plane.position[0] + 0.00005, plane.position[1]],
          imageUrl: plane.imageUrl,
          mimeType: plane.mimeType,
          naturalWidth: plane.naturalWidth,
          naturalHeight: plane.naturalHeight,
          config: { ...plane.config },
          zoneId: plane.zoneId,
          unit: plane.unit,
          visible: true,
        } as Omit<ImagePlaneShape, 'id'>
        try {
          const created = await useSpatialStore
            .getState()
            .createLocal('image-planes', copy)
          if (created.id !== undefined) {
            setSelectedImagePlaneIds(new Set([created.id]))
          }
        } catch (err) {
          console.warn('[create-grids] duplicate image plane failed', err)
        }
      },
      onRenameImagePlane: (id: number, name: string) => {
        patchSpatialEntity('image-planes', id, { name })
      },
      onToggleImagePlaneVisible: (id: number, visible: boolean) => {
        patchSpatialEntity('image-planes', id, { visible })
      },
      onStartMoveImagePlane: (id: number) => {
        setImagePlaneTransform({ imagePlaneId: id, kind: 'move' })
        setImagePlaneTransformDraft(null)
      },
      onCancelImagePlaneTransform: () => {
        setImagePlaneTransform(null)
        setImagePlaneTransformDraft(null)
      },
      imagePlaneTransformActive: imagePlaneTransform !== null,
      // ---- Model actions ----
      onSelectModel: handleSelectModel,
      onFitToModelById: handleFitToModelById,
      onDeleteModelById: handleDeleteModelById,
      onRenameModel: handleRenameModel,
      onAssignModelToZone: handleAssignModelToZone,
      onStartMoveModel: handleStartMoveModel,
      onCancelModelTransform: handleCancelModelTransform,
      modelTransformActive: modelTransform !== null,
      onDuplicateModel: handleDuplicateModel,
      // ---- Stair actions ----
      onSelectStair: handleSelectStair,
      onFitToStairById: handleFitToStairById,
      onDeleteStairById: handleDeleteStairById,
      onDuplicateStair: handleDuplicateStair,
      onRenameStair: handleRenameStair,
      onAssignStairToZone: handleAssignStairToZone,
      onExitStairPlacement: handleExitStairPlacement,
      onStartRotateStair: handleStartRotateStair,
      onStartMoveStair: handleStartMoveStair,
      onCancelStairTransform: handleCancelStairTransform,
      stairTransformKind: stairTransform?.kind ?? null,
      // ---- Door actions ----
      onSelectDoor: handleSelectDoor,
      onFitToDoorById: handleFitToDoorById,
      onDeleteDoorById: handleDeleteDoorById,
      onDuplicateDoor: handleDuplicateDoor,
      onRenameDoor: handleRenameDoor,
      onExitDoorPlacement: handleExitDoorPlacement,
      onSetDoorVisible: handleSetDoorVisible,
      onStartMoveDoor: handleStartMoveDoor,
      onStartRotateDoor: handleStartRotateDoor,
      onStartScaleDoor: handleStartScaleDoor,
      onCancelDoorTransform: handleCancelDoorTransform,
      doorTransformActive: doorTransform !== null,
      doorTransformKind: doorTransform?.kind ?? null,
      // ---- Text-label actions ----
      onFitToTextLabelById: handleFitToTextLabelById,
      onSelectTextLabel: handleSelectTextLabel,
      onDeleteTextLabelById: handleDeleteTextLabelById,
      onDuplicateTextLabel: handleDuplicateTextLabel,
      onRenameTextLabel: handleRenameTextLabel,
      onExitTextLabelPlacement: handleExitTextLabelPlacement,
      onStartMoveTextLabel: handleStartMoveTextLabel,
      onStartRotateTextLabel: handleStartRotateTextLabel,
      onStartScaleTextLabel: handleStartScaleTextLabel,
      onCancelTextLabelTransform: handleCancelTextLabelTransform,
      textLabelTransformActive: textLabelTransform !== null,
      textLabelTransformKind: textLabelTransform?.kind ?? null,
    }),
    [
      handleRedraw,
      handleDuplicate,
      handleDeleteSelected,
      handleRename,
      handleFitToGrid,
      handleExportGeoJSON,
      handleExportPNG,
      handleDeselectAll,
      handleSelectGrid,
      handleFitToGridById,
      handleDeleteGridById,
      handleAssignGridToZone,
      handleAddZone,
      handleDeleteZone,
      handleStartMove,
      handleStartRotate,
      handleStartScale,
      handleCancelTransform,
      transform,
      handleSelectMarker,
      handleFitToMarkerById,
      handleDeleteMarkerById,
      handleDuplicateMarker,
      handleExitMarkerPlacement,
      handleAssignMarkerToZone,
      handleRenameMarker,
      handleStartMoveMarker,
      handleCancelMarkerTransform,
      markerTransform,
      handleSelectCircle,
      handleFitToCircleById,
      handleDeleteCircleById,
      handleDuplicateCircle,
      handleExitCirclePlacement,
      handleAssignCircleToZone,
      handleRenameCircle,
      handleSelectPolygon,
      handleFitToPolygonById,
      handleDeletePolygonById,
      handleDuplicatePolygon,
      handleExitPolygonPlacement,
      handleAssignPolygonToZone,
      handleRenamePolygon,
      handleStartMovePolygon,
      handleStartRotatePolygon,
      handleStartEditPolygon,
      handleCancelPolygonTransform,
      polygonTransform,
      handleStartMoveCircle,
      handleStartRotateCircle,
      handleCancelCircleTransform,
      circleTransform,
      handleSelectLine,
      handleFitToLineById,
      handleDeleteLineById,
      handleDuplicateLine,
      handleExitLinePlacement,
      handleAssignLineToZone,
      handleRenameLine,
      handleStartMoveLine,
      handleStartRotateLine,
      handleCancelLineTransform,
      lineTransform,
      handleBulkDeleteMarkers,
      handleBulkPatchMarkers,
      handleBulkFitMarkers,
      handleBulkDeleteCircles,
      handleBulkPatchCircles,
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
      handleBulkFitCircles,
      handleBulkDeletePolygons,
      handleBulkPatchPolygons,
      handleBulkFitPolygons,
      handleBulkDeleteLines,
      handleBulkFitLines,
      handleSelectImage,
      handleFitToImageById,
      handleDeleteImageById,
      handleDuplicateImage,
      handleExitImagePlacement,
      handleAssignImageToZone,
      handleRenameImage,
      handleStartMoveImage,
      handleStartRotateImage,
      handleStartScaleImage,
      handleCancelImageTransform,
      imageTransform,
      handleBulkDeleteImages,
      handleBulkPatchImages,
      handleBulkFitImages,
      handlePickImageFile,
      handlePickLibraryImage,
      handleReplaceImageFile,
      handleClearImageDraft,
      handleToggleImageVisible,
      handleGenerateMagicWall,
      handleExitMagicWall,
      handleTogglePolygonVisible,
      handleToggleCircleVisible,
      handleToggleLineVisible,
      handleToggleStairVisible,
      handleToggleMarkerVisible,
      handleToggleModelVisible,
      handleToggleTextLabelVisible,
      handleSelectModel,
      handleFitToModelById,
      handleDeleteModelById,
      handleRenameModel,
      handleAssignModelToZone,
      handleStartMoveModel,
      handleCancelModelTransform,
      modelTransform,
      handleDuplicateModel,
      handleSelectStair,
      handleFitToStairById,
      handleDeleteStairById,
      handleDuplicateStair,
      handleRenameStair,
      handleAssignStairToZone,
      handleExitStairPlacement,
      handleSelectDoor,
      handleFitToDoorById,
      handleDeleteDoorById,
      handleDuplicateDoor,
      handleRenameDoor,
      handleExitDoorPlacement,
      handleSetDoorVisible,
      handleStartMoveDoor,
      handleStartRotateDoor,
      handleStartScaleDoor,
      handleCancelDoorTransform,
      doorTransform,
    ]
  )

  // Top-row layout depends on how much map is visible beside the side
  // panel: with room, the place search sits on the top row next to the
  // panel and the pills keep the space before it; without, the search
  // drops to a second row, starting past the vertical toolbar (which is
  // vertically centred, so on short screens it reaches the top rows).
  const panelInset = panelOpen && rootWidth >= 640 ? 416 : 0
  const searchOnTopRow = rootWidth - panelInset >= 860

  // The floor-plan tool's picker (library / upload) lives in the side
  // panel, which starts closed on a phone — open it with the tool, then
  // get the drawer out of the way once an image is picked so the user can
  // drag the bounds on the map.
  const isPhone = rootWidth < 768
  useEffect(() => {
    if (activeTool === 'create-image' && !imageDraft && !panelOpen) onPanelOpenChange(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool])
  const hadImageDraftRef = useRef(false)
  useEffect(() => {
    const has = imageDraft != null
    if (has && !hadImageDraftRef.current && isPhone && activeTool === 'create-image') onPanelOpenChange(false)
    hadImageDraftRef.current = has
  }, [imageDraft, isPhone, activeTool, onPanelOpenChange])
  const topRowStyle = { '--panel-inset': `${panelInset}px` } as CSSProperties

  return (
    <div ref={rootRef} style={topRowStyle} className="absolute inset-0 bg-background overflow-clip">
      <div className="absolute inset-0">
        <MapboxMap
          onMapLoad={handleMapLoad}
          onMapDestroy={handleMapDestroy}
          styleId={mapStyle}
          // Floors + shapes of this facility still loading (the same gate
          // the first camera fit waits on).
          busy={activeWarehouseId != null && !viewportInputsReady}
          busyLabel={t('view.loadState.loading', { defaultValue: 'Loading facility…' })}
        />
      </div>

      <MapFloorBaseOverlay map={overlayMap} input={floorBaseInput} />
      <OverlayStack
        overlayMap={overlayMap}
        layerOrder={layerOrder}
        layerVisibility={layerVisibility}
        shapeSelectionEnabled={shapeSelectionEnabled}
        activeTool={activeTool}
        onMapClickEmpty={handleMapClickEmpty}
        imagesForOverlay={imagesForOverlay}
        imageWallLines={floorBaseInput.lines}
        imageLivePreview={imageLivePreview}
        selectedImageIds={selectedImageIds}
        imageTransform={imageTransform}
        onImageClick={handleImageClickDispatch}
        onImageTransformChange={handleImageTransformChange}
        liveLine={liveLine}
        committedLines={committedLines}
        panelMode={panelMode}
        selectedGrid={selectedGrid}
        gridConfig={config}
        selectedGridIds={selectedGridIds}
        gridTransform={transform}
        gridTransformDraft={transformDraft}
        onCellClick={handleCellClick}
        onGridTransformChange={handleTransformMove}
        resolvedStyles={resolvedStyles}
        circlesForOverlay={circlesForOverlay}
        circleLivePreview={circleLivePreview}
        selectedCircleIds={selectedCircleIds}
        circleTransform={circleTransform}
        onCircleClick={handleCircleClick}
        onCircleTransformChange={handleCircleTransformChange}
        circleStyleOverrides={
          styleOverridesByKind.circle.size > 0 ? styleOverridesByKind.circle : null
        }
        polygonsForOverlay={polygonsForOverlay}
        polygonDraftVertices={polygonDraftVertices}
        polygonDraftCursor={polygonDraftCursor}
        polygonConfig={polygonConfig}
        selectedPolygonIds={polygonOverlaySelectedIds}
        polygonTransform={polygonTransform}
        onPolygonClick={handlePolygonClickRouted}
        onPolygonTransformChange={handlePolygonTransformChange}
        polygonStyleOverrides={
          styleOverridesByKind.polygon.size > 0 ? styleOverridesByKind.polygon : null
        }
        linesForOverlay={linesForOverlay}
        lineDraftVertices={lineDraftVertices}
        lineDraftCursor={lineDraftCursor}
        lineConfig={lineConfig}
        lineDraftSnap={lineDraftSnap}
        drawingUnit={drawingUnit}
        selectedLineIds={selectedLineIds}
        lineTransform={lineTransform}
        onLineClick={handleLineClick}
        onLineTransformChange={handleLineTransformChange}
        lineStyleOverrides={
          styleOverridesByKind.line.size > 0 ? styleOverridesByKind.line : null
        }
        attachedDoorsByLineId={
          attachedDoorsByLineId.size > 0 ? attachedDoorsByLineId : null
        }
        savedRoutes={savedRoutes}
        routeDraftVertices={routeDraftVertices}
        routeDraftCursor={routeDraftCursor}
        routeConfig={routeConfig}
        routeDraftSnap={routeDraftSnap}
        selectedRouteIds={selectedRouteIds}
        onRouteClick={(id) => {
          setSelectedRouteIds(new Set([id]))
          setActiveTool('select')
        }}
        stairsForOverlay={stairsForOverlay}
        selectedStairIds={selectedStairIds}
        stairDraftAnchors={stairDraftAnchors}
        stairDraftCursor={stairDraftCursor}
        stairConfig={stairConfig}
        onStairClick={(id, e) =>
          handleSelectStair(id, e.shiftKey || e.metaKey || e.ctrlKey)
        }
        stairTransform={stairTransform}
        onStairTransformChange={handleStairTransformChange}
        modelsForOverlay={modelsForOverlay}
        modelUrlMap={modelUrlMap}
        modelBoundingCenters={modelBoundingCenters}
        modelBounds={modelBounds}
        modelShapeExtras={modelShapeExtrasMerged}
        modelCursor={modelCursor}
        modelAssetId={modelConfig.modelAssetId}
        selectedModelIds={selectedModelIds}
        modelTransform={modelTransform}
        onModelClick={(id, e) =>
          handleSelectModel(id, e.shiftKey || e.metaKey || e.ctrlKey)
        }
        onModelTransformChange={handleModelTransformChange}
      />

      {/*
       * Image-plane overlay + placement tool. Renders user images as
       * textured planes in 3D space (elevation + 3-axis rotation) via
       * Mapbox's model layer, with a self-contained tool that handles
       * the file picker → upload → click-to-place flow without
       * disturbing the existing create-image flow.
       */}
      {/* AI Map draft-detection overlay. Mounted OUTSIDE the layer-order
          fragment (OverlayStack) so a warehouse re-order doesn't
          unmount/remount the entire preview mid-review. Renders nothing
          until pendingDetections is non-empty. */}
      <MapAIDetectionOverlay
        map={overlayMap}
        detections={aiMap.pendingDetections}
        selectedId={aiSelectedDetectionId}
        onDetectionClick={setAiSelectedDetectionId}
      />

      {/* Route-preview overlay — visible only while the routing tool
          is active (`activeTool === 'route-preview'`). Handles its own
          layer/marker teardown; nothing to gate here beyond keeping it
          out of the tree so its click handler doesn't run on other
          tools. */}
      {activeTool === 'route-preview' && (
        <>
          <MapRoutePreviewOverlay
            map={overlayMap}
            start={routePreview.start}
            end={routePreview.end}
            path={routePreview.path}
            status={routePreview.status}
            elevatedPolygons={routePreview.elevatedPolygons}
          />
          <RouteDirectionsPanel
            status={routePreview.status}
            waypoints={routePreview.path}
            distanceMeters={routePreview.distanceMeters}
            onClear={routePreview.reset}
            side="right"
          />
        </>
      )}

      {/* AI Map drag preview — screen-space DOM overlay pinned to the
          map canvas. Only visible while the user is actively dragging
          a rect with the AI Map tool armed. Screen-space (vs a Mapbox
          layer) so the rect stays glued to the mouse when pan/zoom
          fires mid-drag; render layer sits above the map but below
          the toolbar / sidebar so the user can see their selection. */}
      {activeTool === 'ai-map' && aiDragRect && (
        <div
          className="pointer-events-none absolute z-10 border-2 border-primary/80 bg-primary/10 rounded-sm shadow-sm"
          style={{
            left: aiDragRect.x,
            top: aiDragRect.y,
            width: aiDragRect.w,
            height: aiDragRect.h,
          }}
          aria-hidden="true"
        />
      )}

      {/* Marquee drag preview — same screen-space technique as the AI
          Map rect above. Dashed border reads as a selection lasso rather
          than a solid draw region so the two tools are visually distinct
          when a user tries both. */}
      {activeTool === 'marquee' && marqueeRect && (
        <div
          className="pointer-events-none absolute z-10 border-2 border-dashed border-primary/80 bg-primary/10 rounded-sm shadow-sm"
          style={{
            left: marqueeRect.x,
            top: marqueeRect.y,
            width: marqueeRect.w,
            height: marqueeRect.h,
          }}
          aria-hidden="true"
        />
      )}

      {/* Cross-kind bulk action bar — floats at the bottom-center of the
          map whenever the selection spans more than one kind. The
          per-kind side panel already handles single-kind selections, so
          this surface only shows up when the user has genuinely
          multi-kind state (typically after a marquee drag). */}
      {isCrossKindSelection && !preview && (
        <div
          className="pointer-events-auto absolute bottom-16 start-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-border/60 bg-card/95 p-1.5 shadow-lg backdrop-blur-md rtl:translate-x-1/2"
          role="toolbar"
          aria-label={t('bulkbar.label', { defaultValue: 'Bulk actions' })}
        >
          <div className="px-3 text-xs font-medium text-muted-foreground select-none">
            {t('bulkbar.count', {
              defaultValue: '{{count}} selected · {{kinds}} kinds',
              count: totalMapSelection,
              kinds: selectedKindCount,
            })}
          </div>
          <div className="h-5 w-px bg-border/60" aria-hidden="true" />
          <button
            type="button"
            onClick={() => setBulkAssignOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-primary/5 hover:text-primary transition-colors"
            title={t('bulkbar.changeFloorTitle', {
              defaultValue: 'Change floor plan / warehouse',
            })}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            {t('bulkbar.changeFloor', { defaultValue: 'Change floor' })}
          </button>
          <button
            type="button"
            onClick={() => handleCrossKindSetVisibility(false)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-primary/5 hover:text-primary transition-colors"
            title={t('bulkbar.hideTitle', { defaultValue: 'Hide selected shapes' })}
          >
            <EyeOff className="w-3.5 h-3.5" />
            {t('bulkbar.hide', { defaultValue: 'Hide' })}
          </button>
          <button
            type="button"
            onClick={() => handleCrossKindSetVisibility(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-primary/5 hover:text-primary transition-colors"
            title={t('bulkbar.showTitle', { defaultValue: 'Show selected shapes' })}
          >
            <Eye className="w-3.5 h-3.5" />
            {t('bulkbar.show', { defaultValue: 'Show' })}
          </button>
          <button
            type="button"
            onClick={handleCrossKindDelete}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
            title={t('bulkbar.deleteTitle', {
              defaultValue: 'Delete every selected shape (undo restores)',
            })}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('bulkbar.delete', { defaultValue: 'Delete' })}
          </button>
          <div className="h-5 w-px bg-border/60" aria-hidden="true" />
          <button
            type="button"
            onClick={handleCrossKindClearSelection}
            className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-accent transition-colors"
            title={t('bulkbar.clear', { defaultValue: 'Clear selection (Esc)' })}
            aria-label={t('bulkbar.clear', { defaultValue: 'Clear selection (Esc)' })}
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <SecondaryLayers
        overlayMap={overlayMap}
        activeTool={activeTool}
        shapeSelectionEnabled={shapeSelectionEnabled}
        layerVisibility={layerVisibility}
        onMapClickEmpty={handleMapClickEmpty}
        preview={preview}
        activeWarehouseId={activeWarehouseId}
        defaultFloorPlanId={defaultFloorPlanId}
        defaultFloorPlanElevation={defaultFloorPlanElevation}
        configUnit={config.unit}
        imagePlanesForOverlay={imagePlanesForOverlay}
        selectedImagePlaneIds={selectedImagePlaneIds}
        imagePlaneTransform={imagePlaneTransform}
        onImagePlaneTransformChange={handleImagePlaneTransformChange}
        setSelectedImagePlaneIds={setSelectedImagePlaneIds}
        setActiveTool={setActiveTool}
        scopedDoors={scopedDoors}
        selectedDoorIds={selectedDoorIds}
        doorTransform={doorTransform}
        doorConfig={doorConfig}
        doorDraftAnchors={doorDraftAnchors}
        doorDraftCursor={doorDraftCursor}
        doorCursorPreview={doorCursorPreview}
        onDoorTransformChange={handleDoorTransformChange}
        setSelectedDoorIds={setSelectedDoorIds}
        savedMarkers={savedMarkers}
        markerConfig={markerConfig}
        markerCursor={markerCursor}
        selectedMarkerIds={selectedMarkerIds}
        markerTransform={markerTransform}
        onMarkerClick={handleMarkerClick}
        onMarkerTransformChange={handleMarkerTransformChange}
        markerStyleOverrides={
          styleOverridesByKind.marker.size > 0
            ? styleOverridesByKind.marker
            : null
        }
        binCommittedLines={committedLines}
        savedBins={savedBins}
        gridsVisible={gridsVisible}
        textLabelsForOverlay={textLabelsForOverlay}
        textLabelCursor={textLabelCursor}
        textLabelConfig={textLabelConfig}
        selectedTextLabelIds={selectedTextLabelIds}
        textLabelTransform={textLabelTransform}
        textLabelTransformDraft={textLabelTransformDraft}
        setTextLabelTransform={setTextLabelTransform}
        setTextLabelTransformDraft={setTextLabelTransformDraft}
        setSelectedTextLabelIds={setSelectedTextLabelIds}
        textLabelStyleOverrides={
          styleOverridesByKind.textLabel.size > 0
            ? styleOverridesByKind.textLabel
            : null
        }
        savedDataLinks={savedDataLinks}
        savedPolygons={savedPolygons}
        savedCircles={savedCircles}
        savedLines={savedLines}
        savedModels={savedModels}
        savedStairs={savedStairs}
        savedGrids={savedGrids}
        savedStyleRules={savedStyleRules}
        savedImages={savedImages}
        setSelectedGridIds={setSelectedGridIds}
        setSelectedMarkerIds={setSelectedMarkerIds}
        setSelectedCircleIds={setSelectedCircleIds}
        setSelectedPolygonIds={setSelectedPolygonIds}
        setSelectedLineIds={setSelectedLineIds}
        setSelectedImageIds={setSelectedImageIds}
        setSelectedModelIds={setSelectedModelIds}
        setSelectedStairIds={setSelectedStairIds}
      />

      {/* Global full-screen loader for data-link fetches — also mounted
          in view.tsx. Sub-renderers report their query.isLoading state
          via useLayerLoading; loader reads the aggregate from the
          Zustand store. */}
      <DataLinkFullScreenLoader
        variant="pill"
        pillClassName={
          searchOnTopRow
            ? 'top-16 end-[calc(var(--panel-inset)+1rem)]'
            : 'top-28 start-[5.5rem]'
        }
      />

      {/* Blocking overlay while a magic-wall batch is in flight.
          Prevents the user from clicking / drawing / switching tools
          while dozens of parallel apiDb.lines.add() calls settle. */}
      {magicWallBusy && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center animate-in fade-in duration-200"
        >
          <div className="absolute inset-0 bg-background/50 backdrop-blur-md" />
          <div className="relative rounded-2xl border border-border/60 bg-background/95 shadow-2xl px-8 py-6 min-w-[280px]">
            <div className="absolute -top-6 -start-6 w-24 h-24 rounded-full bg-primary/20 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-6 -end-6 w-24 h-24 rounded-full bg-info/20 blur-3xl pointer-events-none" />
            <div className="relative flex flex-col items-center gap-4">
              <div className="relative">
                <div className="absolute inset-0 rounded-full bg-primary/10 animate-ping" />
                <div className="relative w-14 h-14 rounded-full bg-gradient-to-br from-primary to-info flex items-center justify-center shadow-lg shadow-primary/20">
                  <Wand2 className="w-7 h-7 text-primary-foreground" strokeWidth={2.5} />
                </div>
              </div>
              <div className="text-center">
                <h3 className="text-base font-semibold">
                  {t('magicWall.generating', { defaultValue: 'Generating walls…' })}
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('magicWall.generatingHint', {
                    defaultValue: 'Please don’t move anything until this finishes.',
                  })}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}


      <MapToolbar
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        mapStyle={mapStyle}
        onMapStyleChange={setMapStyle}
        activeTool={activeTool}
        onActiveToolChange={handleToolbarToolChange}
        layerVisibility={layerVisibility}
        onLayerVisibilityChange={handleLayerVisibilityChange}
        onImport={handleImport}
        onOpenExportDialog={openExportDialog}
        onExportGeoJSON={exportGeoJSONStable}
        onExportPNG={exportPNGStable}
        onFocusZones={focusZonesStable}
        onOpenDataLink={openDataLinkManager}
        onOpenBulkAssign={openBulkAssign}
        selectedCount={totalMapSelection}
        showPreviewButton={!preview}
        onPreview={handlePreview}
        onOpenShare={activeWarehouseId !== null ? openShareDialog : undefined}
        preview={preview}
        onOpenCheatsheet={openCheatsheet}
        onOpenSchemaBuilder={openSchemaBuilder}
        defaultFloorPlanId={defaultFloorPlanId}
        onDefaultFloorPlanChange={handleDefaultFloorPlanChange}
        floorPlans={toolbarFloorPlans}
        isAutoRotating={isRotating}
        onToggleAutoRotate={toggleRotate}
      />

      <AIDetectionReviewDialog
        open={aiMap.dialogOpen}
        onOpenChange={(open) => { if (!open) { aiMap.closeDialog(); setAiSelectedDetectionId(null) } }}
        job={aiMap.currentJob}
        isStarting={aiMap.isStarting}
        error={aiMap.error}
        pendingDetections={aiMap.pendingDetections}
        acceptedIds={aiMap.acceptedIds}
        rejectedIds={aiMap.rejectedIds}
        perDetectionErrors={aiMap.perDetectionErrors}
        selectedDetectionId={aiSelectedDetectionId}
        onSelectDetection={setAiSelectedDetectionId}
        onAccept={handleAIAccept}
        onReject={handleAIReject}
        onAcceptAllAboveThreshold={handleAIAcceptAllAbove}
        onCancel={aiMap.cancelCurrent}
      />

      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        activeZoneId={activeWarehouseId}
        source={{
          grids: savedGrids,
          polygons: savedPolygons,
          circles: savedCircles,
          lines: savedLines,
          routes: savedRoutes,
          markers: savedMarkers,
          images: savedImages,
          imagePlanes: savedImagePlanes,
          models: savedModels,
          stairs: savedStairs,
          doors: doors,
          textLabels: savedTextLabels,
        }}
        selectedIds={{
          grid: selectedGridIds,
          polygon: selectedPolygonIds,
          circle: selectedCircleIds,
          line: selectedLineIds,
          route: selectedRouteIds,
          marker: selectedMarkerIds,
          image: selectedImageIds,
          imagePlane: selectedImagePlaneIds,
          model: selectedModelIds,
          stair: selectedStairIds,
          door: selectedDoorIds,
          text: selectedTextLabelIds,
        }}
      />

      <EditorDialogs
        mapInstance={mapInstance}
        language={i18n.language}
        placeSearchClassName={
          searchOnTopRow
            ? 'top-4 end-[calc(var(--panel-inset)+1rem)] w-[420px]'
            : 'top-16 start-[5.5rem] w-[min(420px,calc(100%-var(--panel-inset)-6.5rem))]'
        }
        activeTool={activeTool}
        activeWarehouseId={activeWarehouseId}
        activeWarehouse={activeWarehouse}
        dataLinkOpen={dataLinkOpen}
        setDataLinkOpen={setDataLinkOpen}
        dataLinkEditorOpen={dataLinkEditorOpen}
        setDataLinkEditorOpen={setDataLinkEditorOpen}
        dataLinkManagerOpen={dataLinkManagerOpen}
        setDataLinkManagerOpen={setDataLinkManagerOpen}
        editingDataLinkId={editingDataLinkId}
        editingDataLink={editingDataLink}
        setEditingDataLinkId={setEditingDataLinkId}
        schemaBuilderOpen={schemaBuilderOpen}
        setSchemaBuilderOpen={setSchemaBuilderOpen}
        shareLinkDialogOpen={shareLinkDialogOpen}
        setShareLinkDialogOpen={setShareLinkDialogOpen}
        savedImages={savedImages}
        savedDataLinks={savedDataLinks}
        bulkAssignOpen={bulkAssignOpen}
        setBulkAssignOpen={setBulkAssignOpen}
        selectedGridIds={selectedGridIds}
        selectedMarkerIds={selectedMarkerIds}
        selectedCircleIds={selectedCircleIds}
        selectedPolygonIds={selectedPolygonIds}
        selectedLineIds={selectedLineIds}
        selectedModelIds={selectedModelIds}
        selectedStairIds={selectedStairIds}
        selectedTextLabelIds={selectedTextLabelIds}
        selectedDoorIds={selectedDoorIds}
        selectedImageIds={selectedImageIds}
        selectedImagePlaneIds={selectedImagePlaneIds}
        savedGrids={savedGrids}
        savedMarkers={savedMarkers}
        savedCircles={savedCircles}
        savedPolygons={savedPolygons}
        savedLines={savedLines}
        savedModels={savedModels}
        savedStairs={savedStairs}
        savedTextLabels={savedTextLabels}
        scopedDoors={scopedDoors}
        savedImagePlanes={savedImagePlanes}
        savedZones={savedZones}
        onApplyBulkAssign={handleApplyBulkAssign}
        modelLibraryOpen={modelLibraryOpen}
        setModelLibraryOpen={setModelLibraryOpen}
        modelLibraryMode={modelLibraryMode}
        setModelLibraryMode={setModelLibraryMode}
        modelLibraryPickedRef={modelLibraryPickedRef}
        selectedModel={selectedModel}
        setModelConfig={setModelConfig}
        setActiveTool={setActiveTool}
        selectedBin={selectedBin}
        binDialogOpen={binDialogOpen}
        setBinDialogOpen={setBinDialogOpen}
        setSelectedBin={setSelectedBin}
        shapeEditorTarget={shapeEditorTarget}
        shapeEditorOpen={shapeEditorOpen}
        setShapeEditorOpen={setShapeEditorOpen}
        setShapeEditorTarget={setShapeEditorTarget}
      />

      {/*
       * Active-warehouse pill — top-left of the map, beside the toolbar.
       * Shows which warehouse the current edits are scoped to, with a
       * back-link to the warehouses dashboard. When no warehouse is
       * active a subtle "no warehouse" hint is shown instead so the
       * user knows that saves won't be tagged.
       */}
      {/* Top-left pill row: facility · data links · save state (last, so
          its changing width never shifts the buttons). One flex row, so a
          long facility name truncates instead of sliding under the others,
          and the row stops short of the centred place search (wrapping
          when there's no room) so nothing ends up under it. */}
      <div
        className={cn(
          'pointer-events-none absolute start-5 top-4 z-10 flex flex-wrap items-center gap-2 [&>*]:pointer-events-auto',
          searchOnTopRow ? 'max-w-[calc(100%-var(--panel-inset)-472px)]' : 'max-w-[calc(100%-var(--panel-inset)-2.5rem)]',
        )}
      >
        <WarehousePill activeWarehouse={activeWarehouse} />
        <DataLinkPill
          activeWarehouseId={activeWarehouseId}
          savedDataLinks={savedDataLinks}
          onOpenEditor={() => {
            setEditingDataLinkId(null)
            setDataLinkEditorOpen(true)
          }}
        />
        <SaveStatus />
      </div>

      <StatusBar
        viewport={viewport}
        counts={statusBarCounts}
        panelOpen={panelOpen}
        onUndo={undoStable}
        onRedo={redoStable}
        hint={
          <KeyboardHint
            activeTool={activeTool}
            panelMode={panelMode}
            transformActive={
              transform !== null ||
              markerTransform !== null ||
              polygonTransform !== null ||
              lineTransform !== null ||
              circleTransform !== null ||
              imageTransform !== null ||
              modelTransform !== null ||
              textLabelTransform !== null ||
              stairTransform !== null ||
              doorTransform !== null ||
              imagePlaneTransform !== null
            }
            selectedCount={totalMapSelection}
            shiftHeld={keyboardState.shiftHeld}
            altHeld={keyboardState.altHeld}
            onOpenCheatsheet={openCheatsheet}
          />
        }
      />

      <SidePanel
        open={panelOpen}
        onOpenChange={onPanelOpenChange}
        mode={panelMode}
        config={panelConfig}
        onConfigChange={handlePanelConfigChangeWrapped}
        selectedGrid={selectedGridForPanel}
        selectedBin={selectedBin}
        bulkSelectedCount={selectedGridIds.size}
        drawMode={drawMode}
        onToggleDrawMode={() => {
          drawModeSourceRef.current = 'panel'
          handleToggleDrawMode()
        }}
        isDirty={editorHasUnsaved}
        hasDrawLine={hasAnchor}
        grids={savedGrids}
        zones={savedZones}
        activeWarehouseId={activeWarehouseId}
        selectedGridIds={selectedGridIds}
        zonesVisible={zonesVisible && activeWarehouseId === null}
        onPersistDefaultUnit={handlePersistDefaultUnit}
        markers={savedMarkers}
        selectedMarker={selectedMarker}
        selectedMarkerIds={selectedMarkerIds}
        markerConfig={markerConfig}
        onMarkerConfigChange={handleMarkerConfigChange}
        onMarkerPatch={handleMarkerPatch}
        circles={savedCircles}
        selectedCircle={selectedCircle}
        selectedCircleIds={selectedCircleIds}
        circleConfig={circleConfig}
        onCircleConfigChange={handleCircleConfigChange}
        circleSubMode={circleSubMode}
        onCircleSubModeChange={setCircleSubMode}
        circleCellSize={circleCellSize}
        onCircleCellSizeChange={setCircleCellSize}
        circleCellRadius={circleCellRadius}
        onCircleCellRadiusChange={setCircleCellRadius}
        onCirclePatch={handleCirclePatch}
        polygons={savedPolygons}
        selectedPolygon={selectedPolygon}
        selectedPolygonIds={selectedPolygonIds}
        polygonConfig={polygonConfig}
        onPolygonConfigChange={handlePolygonConfigChange}
        onPolygonPatch={handlePolygonPatch}
        polygonDraftVertexCount={
          activeTool === 'create-polygon' ? polygonDraftVertices.length : 0
        }
        magicWallSelectedPolygonIds={magicWallSelectedPolygonIds}
        magicWallBusy={magicWallBusy}
        aiMapBusy={aiMap.isStarting || aiMap.currentJob?.status === 'running'}
        aiMapTargetImageId={aiTargetImageId}
        lines={savedLines}
        selectedLine={selectedLine}
        selectedLineIds={selectedLineIds}
        lineConfig={lineConfig}
        onLineConfigChange={handleLineConfigChange}
        onLinePatch={handleLinePatch}
        lineDraftVertexCount={
          activeTool === 'create-line' ? lineDraftVertices.length : 0
        }
        routes={savedRoutes}
        selectedRoute={selectedRoute}
        selectedRouteIds={selectedRouteIds}
        routeConfig={routeConfig}
        onRouteConfigChange={setRouteConfig}
        onRoutePatch={(patch) => {
          if (!selectedRoute?.id) return
          const store = useSpatialStore.getState()
          store.updateLocal('routes', selectedRoute.id, patch)
        }}
        routeDraftVertexCount={
          activeTool === 'create-route' ? routeDraftVertices.length : 0
        }
        stairs={savedStairs}
        selectedStair={selectedStairForPanel}
        selectedStairIds={selectedStairIds}
        stairConfig={stairConfig}
        onStairConfigChange={handleStairConfigChange}
        onStairPatch={handleStairPatch}
        stairPlacementAnchorCount={stairDraftAnchors.length}
        doors={scopedDoors}
        selectedDoor={selectedDoorForPanel}
        selectedDoorIds={selectedDoorIds}
        doorConfig={doorConfig}
        onDoorConfigChange={handleDoorConfigChange}
        onDoorPatch={handleDoorPatch}
        doorPlacementAnchorCount={doorDraftAnchors.length}
        doorPendingWidthMeters={doorPendingWidthMeters}
        onDoorPendingWidthMetersChange={setDoorPendingWidthMeters}
        images={savedImages}
        selectedImage={selectedImage}
        selectedImageIds={selectedImageIds}
        floorPlanOrder={floorPlanOrder}
        imageConfig={imageConfig}
        onImageConfigChange={handleImageConfigChange}
        onImagePatch={handleImagePatch}
        imageDraft={
          imageDraft
            ? {
              fileName: imageDraft.fileName,
              dataUrl: imageDraft.dataUrl,
              naturalWidth: imageDraft.naturalWidth,
              naturalHeight: imageDraft.naturalHeight,
              sourceKind: imageDraft.sourceKind,
              scaleDenominator: imageDraft.scaleDenominator,
              realWidthMeters: imageDraft.realWidthMeters,
              realHeightMeters: imageDraft.realHeightMeters,
            }
            : null
        }
        layerOrder={layerOrder}
        onLayerOrderChange={setLayerOrder}
        models={savedModels}
        selectedModel={selectedModelForPanel}
        selectedModelIds={selectedModelIds}
        onModelPatch={handleModelPatch}
        onModelSwapAsset={handleModelSwapAsset}
        imagePlanes={savedImagePlanes}
        selectedImagePlane={selectedImagePlane}
        selectedImagePlaneIds={selectedImagePlaneIds}
        onImagePlanePatch={(patch) => {
          if (!selectedImagePlane?.id) return
          const merged: Partial<ImagePlaneShape> = {}
          if (patch.name !== undefined) merged.name = patch.name
          if (patch.visible !== undefined) merged.visible = patch.visible
          if (patch.config !== undefined) {
            merged.config = { ...selectedImagePlane.config, ...patch.config }
          }
          patchSpatialEntity('image-planes', selectedImagePlane.id, merged)
        }}
        textLabels={savedTextLabels}
        selectedTextLabel={selectedTextLabel}
        selectedTextLabelIds={selectedTextLabelIds}
        textLabelConfig={textLabelConfig}
        onTextLabelConfigChange={(cfg) => {
          if (selectedTextLabel && selectedTextLabel.id !== undefined) {
            void patchSpatialEntity('text-labels', selectedTextLabel.id, {
              config: { ...cfg },
              updatedAt: new Date(),
            })
          } else {
            setTextLabelConfig(cfg)
          }
        }}
        onTextLabelPatch={(patch) => {
          if (!selectedTextLabel || selectedTextLabel.id === undefined) return
          void patchSpatialEntity('text-labels', selectedTextLabel.id, {
            ...patch,
            updatedAt: new Date(),
          })
        }}
        actions={sidePanelActions}
        // Per-shape Data Links section — DataLinkPanel filters the
        // catalog client-side to configs bound to the current shape.
        // "New" pops the editor with a blank form (user picks target
        // from the picker); Edit pops with the row preloaded; Delete
        // removes the config via the same optimistic spatial-store
        // path as any other catalog entity.
        dataLinks={savedDataLinks}
        onDataLinkNew={() => {
          setEditingDataLinkId(null)
          setDataLinkEditorOpen(true)
        }}
        onDataLinkEdit={(configId) => {
          setEditingDataLinkId(configId)
          setDataLinkEditorOpen(true)
        }}
        onDataLinkDelete={(configId) => setPendingDataLinkDelete(configId)}
      />


      <ConfirmDialog
        open={pendingDataLinkDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDataLinkDelete(null)
        }}
        title={t('dataLink.confirmDelete', { defaultValue: 'Delete this data link?' })}
        description={t('dataLink.confirmDeleteBody', {
          defaultValue: 'The shapes it colours go back to their own styling. The data itself is not deleted.',
        })}
        confirmLabel={t('dataLink.delete', { defaultValue: 'Delete data link' })}
        onConfirm={() => {
          if (pendingDataLinkDelete === null) return
          // Saved through the store's queue straight away.
          useSpatialStore.getState().deleteLocal('data-link-configs', pendingDataLinkDelete)
          setPendingDataLinkDelete(null)
        }}
      />

      {keyboardState.cheatsheetOpen && (
        <ShortcutsCheatsheet open onOpenChange={keyboardState.setCheatsheetOpen} />
      )}

      <PdfPagePicker
        file={pendingPdfFile}
        onCancel={handleCancelPdfPage}
        onConfirm={handleConfirmPdfPage}
      />

      <CadImportDialog
        file={pendingCadFile}
        onCancel={handleCancelCadDrawing}
        onConfirm={handleConfirmCadDrawing}
      />
    </div>
  )
}
