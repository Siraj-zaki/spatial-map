import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { MapDoorOverlay } from '@/components/door/map-door-overlay'
import { MapRoutePreviewOverlay } from '@/components/map-route-preview-overlay'
import { RouteDirectionsPanel } from '@/components/route-directions-panel'
import type { FacilityRoutingInput } from '@/lib/routing/floors'
import { resolveStyleMaps } from '@/lib/style-rules'
import { useMapRotation } from '@/routes/create-grids/hooks/useMapRotation'
import { useRoutePreviewTool } from '@/routes/create-grids/hooks/useRoutePreviewTool'
import { MapBinOverlay } from '@/components/map-bin-overlay'
import { MapCircleOverlay } from '@/components/map-circle-overlay'
import {
  MapDataLinkedOverlay,
  getManualClusterLeaves,
} from '@/components/map-data-linked-overlay'
import { MapGridOverlay, type CommittedLine } from '@/components/map-grid-overlay'
import { MapImageOverlay } from '@/components/map-image-overlay'
import { MapImagePlaneOverlay } from '@/components/map-image-plane-overlay'
import { MapLineOverlay } from '@/components/map-line-overlay'
import { MapMarkerOverlay } from '@/components/map-marker-overlay'
import { MapModelOverlay } from '@/components/map-model-overlay'
import { MapPolygonOverlay } from '@/components/map-polygon-overlay'
import { MapShapeTooltip } from '@/components/map-shape-tooltip'
import { MapStairOverlay } from '@/components/map-stair-overlay'
import { MapFloorBaseOverlay } from '@/components/map-floor-base-overlay'
import { MapFocusOverlay } from '@/components/map-focus-overlay'
import { MapTextLabelOverlay } from '@/components/map-text-label-overlay'
import {
  MapboxMap,
  MAP_STYLE_IDS,
  DEFAULT_MAP_STYLE,
  normalizeStyleId,
  type MapStyleId,
} from '@/components/mapbox-map'
import {
  DEFAULT_LAYER_ORDER,
  SIDE_PANEL_DEFAULT_CONFIG,
  type LayerKind as ReorderableLayerKind,
} from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import { Drawer as DrawerPrimitive } from 'vaul'
import { useTranslation } from 'react-i18next'
import {
  DrawerClose,
  DrawerDescription,
  DrawerTitle,
} from '@/components/ui/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePublicWarehouse } from '@/hooks/usePublicWarehouse'
import { useShareLink } from '@/hooks/useShareLink'
import { useTheme } from '@/components/theme-provider'
import {
  useSpatialBins,
  useSpatialCircles,
  useSpatialDataLinks,
  useSpatialGrids,
  useSpatialImagePlanes,
  useSpatialImages,
  useSpatialLines,
  useSpatialMarkers,
  useSpatialModels,
  useSpatialPolygons,
  useSpatialStairs,
  useSpatialStyleRules,
  useSpatialTextLabels,
  useSpatialZones,
} from '@/hooks/useSpatialShapes'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { hasMapLayer, rootLayerOrder } from '@/lib/data-link/dl-layer-stack'
import { useStableCallback } from '@/hooks/useStableCallback'
import { resolveEntityFloor } from '@/lib/data-link/filter-evaluator'
import { readPayloadPath } from '@/lib/data-link/match-resolver'
import { resolveLabelTemplate } from '@/lib/data-link/style-rule-evaluator'
import { imageCorners } from '@/lib/image-generators'
import type {
  Bin,
  BindingKind,
  DataLinkConfig,
  DataLinkFilter,
  DataLinkFilterCondition,
  EntityState,
  Grid,
  Zone,
} from '@/lib/db'
import { flyToFocus, isFocusFlying, type FocusCameraMode, type FocusPadding } from '@/lib/focus/focus-camera'
import { useFollowEntity } from '@/lib/focus/use-follow-entity'
import { FollowChip } from '@/components/follow-chip'
import { useTrackFocusBlockers } from '@/lib/focus/focus-blockers'
import { useFocusNear } from '@/lib/focus/focus-near'
import { FocusBlockersContext, FocusSceneContext, useFocusSceneValue } from '@/lib/focus/focus-scene'
import {
  focusDlRef,
  focusKey,
  formatFocusParam,
  parseFocusParam,
  resolveFocus,
  type DlAnchor,
  type FocusShapeKind,
  type FocusShapes,
  type FocusTarget,
} from '@/lib/focus/focus-target'
import { useViewerMapTools } from '@/components/view/viewer-map-tools'
import { ViewerItemsPanel } from '@/components/view/viewer-items-panel'
import { STYLE_ICON, useStyleLabel } from '@/components/reports/layout/report-map-view'
import { useFocusExit } from '@/lib/focus/use-focus-exit'
import { buildOccluders, type OccluderPrism } from '@/lib/marker-occlusion'
import { fetchSharedWarehouse, type ShareLayerKind } from '@/lib/share-link-client'
import type { EntityKind } from '@/lib/spatial-store'
import { toast } from '@/lib/toast-store'
import {
  allLeavesValid,
  collectPromptLeaves,
  resolvePromptValues,
} from '@/components/data-link/filter-tree-builder'
import { useDoorStore } from '@/lib/door/store'
import { fitMapToGrids } from '@/lib/export'
import { useModelBoundingCenterMap, useModelBoundsMap, useModelInspectorMap, useModelUrlMap } from '@/lib/model-assets'
import { classifyBin, classifyValue, type MediaItem, type PrimaryFieldRow } from '@/lib/rich-data'
import { isWatchableStream, LiveStreamPlayer } from '@/components/live-stream-player'
import {
  liftFloorPlanIds,
  type ImageShape,
  type ModelShape,
  type PolygonShape,
} from '@/lib/shapes'
import { useSpatialStore } from '@/lib/spatial-store'
import { useSSE } from '@/lib/useSSE'
import { setFacilityShare } from '@/lib/reports/report-share'
import { cn } from '@/lib/utils'
import { labelFromKey, classifyKeyValue } from '@/lib/value-classifier'
import { FieldRow } from '@/components/bin-popup-content'
import { Toaster } from '@/components/feedback/toaster'
import {
  ArrowLeft,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Copy,
  Eye,
  ExternalLink,
  Clock,
  Image as ImageIcon,
  Info,
  Layers,
  Link2,
  Map as MapIcon,
  MapPinOff,
  Navigation,
  RotateCcw,
  RotateCw,
  Tag,
  Video,
  X,
} from 'lucide-react'
import { ViewerLayersPanel, type ShapeLayerKind, type DataLinkLayerKind } from '@/components/view/viewer-layers-panel'
import { inferLayerKind } from '@/components/view/view-layers-panel'
import { ViewSearch, type SearchResult } from '@/components/view/view-search'
import { ViewerFilterBar } from '@/components/view/viewer-filter-bar'
import { TableHistoryPanel } from '@/components/view/table-history-panel'
import { TableHistoryPlayer } from '@/components/view/table-history-player'
import { ViewerGraphicsPanel } from '@/components/view/viewer-graphics-panel'
import { DataLinkFullScreenLoader } from '@/components/data-link/data-link-loader'
import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import { sitePath } from '@/lib/site'

/**
 * v5.4 — multi-floor selection. `active` is either:
 *   • `null` — "All floors" mode, shape shows regardless of floor.
 *   • `Set<number>` — the picked floors. Shape shows when its
 *     `floorPlanId` is in the set. Shapes with no assigned floor
 *     (`floorPlanId === undefined`) show under any picked-floor
 *     selection, matching the pre-v5.4 semantic where unassigned
 *     shapes showed under a single-floor selection.
 */
function onFloor<T extends { floorPlanId?: number }>(
  row: T,
  active: ReadonlySet<number> | null,
): boolean {
  if (active === null) return true
  if (row.floorPlanId === undefined) return true
  return active.has(row.floorPlanId)
}

/**
 * v5.4 — pick a single floor id from a selection, or null when the
 * selection covers zero or more than one floor. Handed to APIs (data-
 * link overlay, layer-rows fetch) that still take one `number | null`.
 * A multi-floor selection collapses to null there, which the overlay
 * treats the same as "All floors" — i.e. it doesn't gate entities on
 * a specific floor. Combined with the shape-level `onFloor` filter
 * above, this gives the right result: shapes on picked floors show,
 * data-link entities aren't floor-gated.
 */
function singleFloorId(active: ReadonlySet<number> | null): number | null {
  if (active === null) return null
  if (active.size !== 1) return null
  const [only] = active
  return only ?? null
}

/**
 * v4 — apply the content-viewer config to a raw payload before it's
 * wrapped in a synthetic Bin for the sidebar drawer.
 *
 *   `fields` (from `config.tooltip.panel.fields`, fallback to
 *   `config.tooltip.fields`) is the ordered list of paths the user
 *   configured. When present:
 *     - we read each path via `readPayloadPath` (supports nested
 *       objects + `custom.foo` shortcuts the same as the template
 *       resolver)
 *     - we insert them into the result in EXACTLY that order
 *     - anything else in the payload is dropped, so the drawer's
 *       classify-then-render pipeline only sees the configured keys
 *
 * When no `fields` are configured we return the payload unchanged
 * so pre-v4 behaviour (every payload key) is preserved.
 */
function applyPanelConfig(
  payload: Record<string, unknown>,
  config: DataLinkConfig,
): { customProperties: Record<string, unknown>; header: string | undefined } {
  const panelFields = config.tooltip.panel?.fields ?? config.tooltip.fields
  let customProperties = payload
  if (panelFields && panelFields.length > 0) {
    const ordered: Record<string, unknown> = {}
    for (const path of panelFields) {
      const raw = readPayloadPath(payload, path)
      // Use the trailing segment as the display key so nested paths
      // (`custom.temp`, `sensor.reading`) render sensibly. Collisions
      // are namespaced with the full path so we never silently drop.
      const shortKey = path.split('.').pop() ?? path
      const key = shortKey in ordered ? path : shortKey
      // When the user explicitly picks fields, keep the pick even when
      // the value is missing / null / empty-string. `classifyBin` in
      // rich-data.ts drops nullish + empty strings from the custom-
      // properties list, so we fill blanks with an em-dash string so
      // every configured field renders — matching the intent that "if
      // I add this to the sidebar it should always show, with a — when
      // there's no data yet."
      if (
        raw === undefined ||
        raw === null ||
        (typeof raw === 'string' && raw.trim() === '')
      ) {
        ordered[key] = '—'
      } else {
        ordered[key] = raw
      }
    }
    customProperties = ordered
  }
  const tpl = config.tooltip.panel?.template
  const header = tpl ? resolveLabelTemplate(tpl, payload) : undefined
  return { customProperties, header }
}

// ---- Focus mode helpers ------------------------------------------------
//
// Focus mode (src/lib/focus/): an item the viewer asks for — clicked,
// searched, picked in the Layers pill, named by a `?focus=` link — is
// always drawn (exempt from occlusion, pulse ring). Only two things fade:
// the shapes standing between it and the camera, and its NEAR set
// (`focus-near.ts`: solids it sits inside, volumetric shapes on its floor
// within 5 m, anything overhead) — a large one only locally (cut-away).
// Everything else stays exactly as drawn. The viewer owns the target in `useState` and hands it to the
// overlays through FocusSceneContext / FocusBlockersContext.

/** Share-link layer that has to be visible for a focus target to be allowed. */
const SHARE_KIND_OF_FOCUS: Readonly<Record<FocusTarget['kind'], ShareLayerKind>> = {
  markers: 'markers',
  polygons: 'polygons',
  circles: 'circles',
  lines: 'lines',
  stairs: 'stairs',
  grids: 'racks',
  images: 'images',
  'image-planes': 'imagePlanes',
  models: 'models',
  doors: 'doors',
  'text-labels': 'text',
  dl: 'dataLinks',
}

/** The Layers-pill kind toggle that hides a focus kind (walls have none). */
const HIDE_KEY_OF_FOCUS: Readonly<Partial<Record<FocusShapeKind, ShapeLayerKind>>> = {
  markers: 'markers',
  polygons: 'polygons',
  circles: 'circles',
  stairs: 'stairs',
  grids: 'grids',
  images: 'images',
  'image-planes': 'imagePlanes',
  models: 'models',
  doors: 'doors',
  'text-labels': 'textLabels',
}

/** Layers-pill kind → focus kind (bins resolve through their binding). */
const FOCUS_KIND_OF_LAYER: Readonly<Record<Exclude<ShapeLayerKind, 'bins'>, FocusShapeKind>> = {
  polygons: 'polygons',
  circles: 'circles',
  markers: 'markers',
  models: 'models',
  stairs: 'stairs',
  doors: 'doors',
  imagePlanes: 'image-planes',
  textLabels: 'text-labels',
  grids: 'grids',
  images: 'images',
}

const FOCUS_KIND_OF_BINDING: Readonly<Partial<Record<BindingKind, FocusShapeKind>>> = {
  polygon: 'polygons',
  circle: 'circles',
  line: 'lines',
  marker: 'markers',
  image: 'images',
  model: 'models',
}

/** Store kind whose load a `?focus=` target waits for (signed-in viewer). Doors load through the door store. */
const ENTITY_KIND_OF_FOCUS: Readonly<Record<FocusTarget['kind'], EntityKind | null>> = {
  markers: 'markers',
  polygons: 'polygons',
  circles: 'circles',
  lines: 'lines',
  stairs: 'stairs',
  grids: 'grids',
  images: 'images',
  'image-planes': 'image-planes',
  models: 'models',
  doors: null,
  'text-labels': 'text-labels',
  dl: 'data-link-configs',
}

/** English fallbacks for `view.focus.kind.*` (the chip's kind label). */
const FOCUS_KIND_FALLBACK: Readonly<Record<string, string>> = {
  markers: 'Marker',
  polygons: 'Area',
  circles: 'Circle',
  lines: 'Wall',
  stairs: 'Stairs',
  grids: 'Rack',
  cell: 'Bin',
  images: 'Floor plan',
  'image-planes': 'Image',
  models: '3D model',
  doors: 'Door',
  'text-labels': 'Label',
  dl: 'Live data',
}

/** Which shape drawer a focus kind opens (markers / areas have one). */
function drawerForFocusKind(kind: FocusTarget['kind']): 'marker' | 'polygon' | null {
  if (kind === 'markers') return 'marker'
  if (kind === 'polygons') return 'polygon'
  return null
}

/**
 * A bin row → what to focus: its rack cell, or the shape it is bound to.
 * Null when the row points at nothing drawable.
 */
function focusTargetForBin(bin: Bin | undefined): FocusTarget | null {
  if (!bin) return null
  if (bin.targetKind === 'grid-cell') {
    if (bin.gridId === undefined || typeof bin.row !== 'number' || typeof bin.col !== 'number') return null
    return { kind: 'grids', id: bin.gridId, cell: { row: bin.row, col: bin.col, level: bin.level ?? 0 } }
  }
  const kind = FOCUS_KIND_OF_BINDING[bin.targetKind]
  if (!kind || typeof bin.shapeId !== 'number') return null
  return { kind, id: bin.shapeId }
}

/** A feature's `payload` property (stringified by GeoJSON tiling), or every property. */
function readFeaturePayload(props: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!props) return {}
  const raw = props['payload']
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      /* fall through */
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  // No `payload` key — treat every property as the payload.
  return props
}

/**
 * The floor a data-link row is drawn on, the way the overlay's floor gate
 * reads it (`passesFloorScope`): 'all' and multi-floor 'specific' scopes
 * have no single floor; 'auto' resolves the payload, and an id that is no
 * longer a floor plan counts as unknown.
 */
function dataLinkEntityFloor(
  payload: Record<string, unknown>,
  cfg: DataLinkConfig,
  liveFloorIds: ReadonlySet<number>,
): number | null {
  const scope = cfg.fieldMapping?.floorScope
  if (scope?.mode === 'all') return null
  if (scope?.mode === 'specific') {
    const ids = scope.floorPlanIds ?? []
    return ids.length === 1 ? ids[0] : null
  }
  const floor = resolveEntityFloor(payload, null, { field: scope?.field, valueMap: scope?.valueMap })
  return floor !== null && liveFloorIds.has(floor) ? floor : null
}

/** Where a clicked data-link point is drawn — its feature coordinates + `elevation`. */
function dataLinkAnchorOf(
  geometry: GeoJSON.Geometry | null | undefined,
  props: Record<string, unknown> | null | undefined,
  floorPlanId: number | null,
): DlAnchor | undefined {
  if (!geometry || geometry.type !== 'Point') return undefined
  const [lng, lat] = geometry.coordinates
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined
  const elevation = Number(props?.['elevation'])
  return { position: [lng, lat], elevationM: Number.isFinite(elevation) ? elevation : 0, floorPlanId }
}

/**
 * A text label's display name: the text it draws on the map, else its row
 * name (rows are mostly all called "Text", so the name alone can't tell
 * them apart).
 */
function textLabelName(label: { name?: string; config?: { text?: string } } | undefined): string {
  return (label?.config?.text ?? '').trim() || label?.name || ''
}

/** `params` without `?focus=` (every other param kept). */
function withoutFocusParam(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('focus')
  return next
}

/**
 * The `?focus=` link leaves the URL once it has been applied (`appliedTag`
 * is this param's tag) and the focus moves off the item it names: to
 * another item, or to nothing (`nextKey` ''). A param that names nothing
 * (`paramKey` '') goes as soon as nothing is focused.
 */
function focusParamReleased(appliedTag: string | null, paramTag: string, paramKey: string, nextKey: string): boolean {
  return paramTag !== '' && appliedTag === paramTag && (nextKey === '' || nextKey !== paramKey)
}

/** A data-link row's display name: its layer's label field, else the entity key. */
function dataLinkLabelOf(cfg: DataLinkConfig, payload: Record<string, unknown>, entityKey: string): string {
  const field = cfg.fieldMapping?.labelField
  const v = field ? readPayloadPath(payload, field) : undefined
  if (typeof v === 'string' && v.trim() !== '') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return entityKey
}

/** Detail drawer width per breakpoint (`ShapeDetailDrawer`: sm 420 / md 460 / lg 500; full width below sm). */
function detailDrawerWidth(viewportWidth: number): number {
  if (viewportWidth >= 1024) return 500
  if (viewportWidth >= 768) return 460
  if (viewportWidth >= 640) return 420
  return 0
}

interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * The part of `el` actually on screen: its box clipped by the viewport and
 * by every ancestor that clips overflow. On `/view` the map fills the app
 * shell's <main> (`absolute inset-0`); on `/share` it is the whole window.
 * Kept as a guard: anything an ancestor clips is out of sight.
 */
function visibleRectOf(el: Element): ScreenRect {
  const r = el.getBoundingClientRect()
  const vis: ScreenRect = {
    left: Math.max(r.left, 0),
    top: Math.max(r.top, 0),
    right: Math.min(r.right, window.innerWidth),
    bottom: Math.min(r.bottom, window.innerHeight),
  }
  for (let a = el.parentElement; a !== null; a = a.parentElement) {
    const cs = window.getComputedStyle(a)
    const clipX = cs.overflowX !== 'visible'
    const clipY = cs.overflowY !== 'visible'
    if (!clipX && !clipY) continue
    const ar = a.getBoundingClientRect()
    if (clipX) {
      vis.left = Math.max(vis.left, ar.left)
      vis.right = Math.min(vis.right, ar.right)
    }
    if (clipY) {
      vis.top = Math.max(vis.top, ar.top)
      vis.bottom = Math.min(vis.bottom, ar.bottom)
    }
  }
  return vis
}

/**
 * Screen area a focused item must land in: on the visible part of the
 * canvas, clear of the top / bottom chrome, and of the detail drawer when
 * one is open. The drawer is on the logical end side — the right in LTR,
 * the left in RTL (`ShapeDetailDrawer`). Below `sm` the drawer covers the
 * whole map, so it adds nothing.
 */
function focusPaddingFor(map: MapboxMapInstance, drawerOpen: boolean, rtl: boolean): FocusPadding {
  const pad: FocusPadding = { top: 64, right: 24, bottom: 48, left: 24 }
  if (typeof window === 'undefined') return pad
  const container = map.getContainer()
  const rect = container.getBoundingClientRect()
  const vis = visibleRectOf(container)
  pad.top += Math.max(0, vis.top - rect.top)
  pad.left += Math.max(0, vis.left - rect.left)
  pad.right += Math.max(0, rect.right - vis.right)
  pad.bottom += Math.max(0, rect.bottom - vis.bottom)
  if (!drawerOpen) return pad
  const vw = window.innerWidth
  const w = detailDrawerWidth(vw)
  if (w === 0) return pad
  if (rtl) pad.left += Math.max(0, w - vis.left)
  else pad.right += Math.max(0, vis.right - (vw - w))
  return pad
}

/** A data-link drawer's cluster list entry. */
interface DlClusterItem {
  payload: Record<string, unknown>
  position: [number, number]
  /** The leaf's `entityKey` (focus + table history); absent on keyless streams. */
  entityKey?: string
  /** Where the leaf is drawn, when it is a point. */
  anchor?: DlAnchor
}

/** The data-link widget drawer — one entity (`bin`) or a cluster list (`clusterItems`). */
interface DlEntityDrawerState {
  title: string
  kindLabel: string
  accentColor: string | undefined
  bin?: Bin
  clusterItems?: DlClusterItem[]
  /** v4 — rendered above the field grid in the drawer. Resolved from
   *  `config.tooltip.panel.template` against the payload. */
  panelHeader?: string
  /** v4 — ordered field paths the drawer should show. When set, the
   *  synthetic bin's `customProperties` is pre-filtered so classifyBin
   *  can only surface these keys, in this order. */
  panelFields?: string[]
  /** Raw (unresolved) template — kept so cluster-item drill-in can
   *  re-resolve it against the leaf's payload. */
  panelTemplateRaw?: string
  /** v4 — labelField from the layer's fieldMapping. Used by the cluster
   *  list to title each row (sku / external_code / etc.) instead of
   *  falling back to the generic "Item" placeholder. */
  labelField?: string
  /** v5.4 — source id + entity key for table-backed layers. When both
   *  are set the drawer surfaces the History panel; otherwise the
   *  entity has no per-row event trail (streaming path uses
   *  `entity_events`, which the replay flow reads, not this panel). */
  sourceId?: number
  entityKey?: string
  /** The layer the drawer belongs to (cluster drill-in focuses its rows). */
  configId?: number
}

/**
 * The drawer for one data-link row (the shared map-click / "View more" /
 * Layers-pill path). `assetLabel` is the translated generic kind
 * (`view.drawer.kind.asset`); a layer's own name stays as data.
 */
function dataLinkDrawerFor(
  cfg: DataLinkConfig,
  payload: Record<string, unknown>,
  entityKey: string | undefined,
  assetLabel: string,
): DlEntityDrawerState {
  const { customProperties, header } = applyPanelConfig(payload, cfg)
  return {
    title: cfg.name || assetLabel,
    kindLabel: assetLabel,
    accentColor: cfg.style?.defaultColor,
    bin: { targetKind: 'polygon', customProperties, updatedAt: new Date() },
    panelHeader: header,
    panelFields: cfg.tooltip.panel?.fields ?? cfg.tooltip.fields,
    labelField: cfg.fieldMapping?.labelField,
    sourceId: cfg.sourceId ?? undefined,
    entityKey,
    configId: cfg.id,
  }
}

interface FocusItemOptions {
  /**
   * 'always' = list / search / link picks and area clicks; 'ifNeeded' =
   * only when off-screen or hidden (cluster rows); 'reveal' = map clicks
   * (pan just enough to keep the item clear of the drawer, zoom / pitch /
   * bearing kept); 'none' = don't move.
   */
  camera: FocusCameraMode | 'none'
  /** The shape drawer to open (exactly one drawer is ever open). */
  drawer?: 'marker' | 'polygon' | null
  /** Data-link drawer content (opens the data-link drawer instead). */
  dlDrawer?: DlEntityDrawerState
  /** Chip name when the rows can't supply one (data-link rows). */
  label?: string | null
}

/** A camera move a focus action asked for; run once the item's floor is shown. */
interface FocusCameraIntent {
  key: string
  mode: FocusCameraMode
  /** The focus switched floors for this item — fold the new floor's rotation into the bearing. */
  floorSwitched: boolean
}

/** What a focus request is checked against (share-link scope + what exists). */
interface FocusScope {
  layerVisible: (kind: ShareLayerKind) => boolean
  /** Data-link layers the share link pins hidden. */
  pinnedHiddenConfigIds: ReadonlySet<number>
  /** The floor a share link locks the viewer to, or null. */
  lockedFloorPlanId: number | null
  configs: readonly DataLinkConfig[]
  shapes: FocusShapes
}

/**
 * Why a focus request must be refused, or null to allow it. Share links
 * never reveal what they hide: a kind or data-link layer the link leaves
 * out, or an item on a floor other than the one it locks to
 * ('notInLink'). An id that isn't on the map, or a data-link layer that
 * is gone or switched off, is 'notFound'. A data-link row without its
 * drawn anchor yet is re-checked when the anchor arrives.
 */
function focusRefusal(target: FocusTarget, scope: FocusScope): 'notInLink' | 'notFound' | null {
  if (!scope.layerVisible(SHARE_KIND_OF_FOCUS[target.kind])) return 'notInLink'
  const dlRef = focusDlRef(target)
  if (dlRef && scope.pinnedHiddenConfigIds.has(dlRef.configId)) return 'notInLink'
  const locked = scope.lockedFloorPlanId
  if (target.kind === 'dl') {
    const cfg = scope.configs.find((c) => c.id === target.configId)
    if (!cfg || cfg.enabled === false) return 'notFound'
    const floor = target.anchor?.floorPlanId ?? null
    return locked !== null && floor !== null && floor !== locked ? 'notInLink' : null
  }
  const resolved = resolveFocus(target, scope.shapes)
  if (!resolved) return 'notFound'
  if (locked === null || resolved.floorPlanId === null || resolved.floorPlanId === locked) return null
  // A lift is drawn on every floor it links, not only its own.
  const stair = target.kind === 'stairs' ? scope.shapes.stairs?.find((st) => st.id === target.id) : undefined
  return stair && liftFloorPlanIds(stair.config).includes(locked) ? null : 'notInLink'
}

/**
 * The floor-picker selection that shows `floor`: a single-floor pick
 * switches to it, a multi-floor pick adds it, and a floor plan that no
 * longer exists can only be shown by "All floors" (null). `undefined` =
 * already shown, leave the selection alone.
 */
function floorSelectionShowing(
  current: ReadonlySet<number> | null,
  floor: number,
  liveFloorIds: ReadonlySet<number>,
): ReadonlySet<number> | null | undefined {
  if (current === null) return undefined
  if (!liveFloorIds.has(floor)) return null
  if (current.has(floor)) return undefined
  if (current.size <= 1) return new Set([floor])
  const grown = new Set(current)
  grown.add(floor)
  return grown
}

/** The focused item's floor is on screen (or can't be switched to, so there is nothing to wait for). */
function focusFloorShown(
  selected: ReadonlySet<number> | null,
  floor: number | null,
  liveFloorIds: ReadonlySet<number>,
  lockedFloorPlanId: number | null,
): boolean {
  if (floor === null || lockedFloorPlanId !== null || selected === null) return true
  return liveFloorIds.has(floor) && selected.has(floor)
}

const NO_PRISMS: OccluderPrism[] = []
/** A data-link focus whose row never gets drawn gives up after this long. */
const DL_ANCHOR_TIMEOUT_MS = 30_000

/**
 * The editor's eye icon writes `visible=false`, and since 2026-11-11 the
 * viewer honours it for every shape kind: hide something in the editor and
 * it is gone from the preview, share links and report maps too. Only floor
 * plans (images) and bins still ignore the flag — a hidden floor sheet is
 * the editor's way of dimming a floor, while the viewer's own floor
 * dropdown decides which floors show here.
 */
/**
 * Share-link mode: open the link, then switch data-source row reads to the
 * link's public routes (`/public/share/{token}/sources/…`) BEFORE any layer
 * mounts and fetches — a signed-out visitor has no session for the
 * signed-in routes. Legacy links (404 here) carry no row routes.
 */
async function fetchSharedWarehouseWithRows(key: string) {
  const res = await fetchSharedWarehouse(key)
  if (res) setFacilityShare(key)
  return res
}

function forceVisible<T>(rows: ReadonlyArray<T>): T[] {
  return rows.map((r) => {
    if (r && typeof r === 'object' && (r as { visible?: boolean }).visible === false) {
      return { ...(r as object), visible: true } as T
    }
    return r
  })
}

function shouldShowImage(
  img: { id?: number },
  active: ReadonlySet<number> | null,
): boolean {
  if (active === null) return true
  // Strict id match — only the SELECTED floors' own images are drawn.
  // The prior "also show sub-images pinned to this floor" rule leaked
  // higher-floor images into the viewer when the hospital 3-floor
  // fixture stored floors 2 and 3 as children of floor 1 (legacy
  // migration artefact). Decorative sub-image overlays aren't a
  // production feature yet — the editor authoring flow doesn't
  // produce them — so dropping the sub-image branch is safe.
  return img.id !== undefined && active.has(img.id)
}

/**
 * `mode`: `id` — signed-in preview of the caller's own facility (spatial
 * store); `token` — public share link.
 */
export default function View({ mode = 'id' }: { mode?: 'id' | 'token' }) {
  const params = useParams<{ warehouseId?: string; token?: string }>()
  const warehouseId = params.warehouseId
  const token = params.token
  const { t, i18n } = useTranslation()
  const isRtl = i18n.dir() === 'rtl'
  const isAuthMode = mode === 'id'
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Two-stage token resolution:
  //   1. Try the RICH share endpoint `/api/v1/share/{token}` which
  //      returns `{ link: { settings, ... }, warehouse: WarehouseView }`.
  //      Fires only in token mode.
  //   2. If that 404s (legacy `/share/{shareToken}` links minted before
  //      share_links existed), fall back to the plain public warehouse
  //      endpoint. Any legacy URL keeps working; any new URL benefits
  //      from the settings blob.
  const shareTokenForLookup = mode !== 'id' ? token : undefined
  const shareResult = useShareLink(shareTokenForLookup, fetchSharedWarehouseWithRows)
  const shareSettings = shareResult.data?.link.settings
  // Keep the public row routes on while this link is open (the fetcher set
  // it first; this re-arms it after a StrictMode remount) and off after.
  const shareOpen = mode === 'token' && Boolean(shareResult.data)
  useEffect(() => {
    if (!shareOpen || !token) return
    setFacilityShare(token)
    return () => setFacilityShare(null)
  }, [shareOpen, token])

  // The legacy public warehouse hook is called for:
  //   * id mode (never touches share_links)
  //   * token mode when the share endpoint 404s (backward compat with
  //     the old zones.share_token URLs)
  // In the "rich token hit" case we still call the hook — it's a no-op
  // when `id === undefined` — to keep React's hook count stable.
  const usePublicId = mode === 'token'
    ? (shareResult.notFound ? token : undefined)
    : warehouseId
  const publicResult = usePublicWarehouse(usePublicId, {
    token: mode === 'token' && shareResult.notFound,
  })

  // Composite `data` — rich share wins, otherwise fall through to the
  // legacy public endpoint. `id` here is what downstream shape scoping
  // reads; for the token path it's the zone id embedded in the
  // WarehouseView so overlays can compute `warehouseIdNum` correctly.
  const data = shareResult.data?.warehouse ?? publicResult.data ?? null
  const id = mode !== 'id'
    ? (shareResult.data?.warehouse.zone.id !== undefined
        ? String(shareResult.data.warehouse.zone.id)
        : token)
    : warehouseId

  // Load state for the map's own overlay + the error screen: the facility
  // (share link / public warehouse) and, signed in, its floors.
  const imagesLoadedFor = useSpatialStore((s) => s.loadedFor.images)
  const loadError: Error | null =
    mode === 'token' ? (shareResult.notFound ? publicResult.error : shareResult.error) : publicResult.error
  const viewerLoading = !loadError && (!data || (isAuthMode && id !== undefined && imagesLoadedFor !== Number(id)))

  const tenantId = useCurrentTenantId()
  useSSE(isAuthMode ? tenantId : null)
  useEffect(() => {
    if (!isAuthMode || tenantId === null || id === undefined) return
    const warehouseIdNum = Number(id)
    if (!Number.isFinite(warehouseIdNum)) return
    // v5.4 — set the active zone BEFORE loadAll(), so every kind
    // fetch (polygons, circles, lines, markers, doors, style-rules,
    // data-link configs, …) carries `?zoneId=<warehouseId>` and the
    // backend returns only this facility's rows. Without this the
    // spatial-store's `activeZoneId` stays null, no query param is
    // sent, and every catalog endpoint answers with the whole
    // tenant roster. That was the reason the viewer was pulling
    // style rules + data-link configs + shapes from every other
    // warehouse.
    useSpatialStore.getState().setTenantId(tenantId)
    useSpatialStore.getState().setActiveZoneId(warehouseIdNum)
    void useSpatialStore.getState().loadAll()
  }, [isAuthMode, tenantId, id])

  // Which facility's doors have finished loading (the door store keeps no
  // loaded flag) — a `?focus=doors:<id>` link waits for it.
  const [doorsLoadedFor, setDoorsLoadedFor] = useState<number | null>(null)
  useEffect(() => {
    if (!isAuthMode || id === undefined) return
    const warehouseIdNum = Number(id)
    if (!Number.isFinite(warehouseIdNum)) return
    let live = true
    void useDoorStore
      .getState()
      .loadForWarehouse(warehouseIdNum)
      .finally(() => {
        if (live) setDoorsLoadedFor(warehouseIdNum)
      })
    return () => {
      live = false
    }
  }, [isAuthMode, id])

  const { data: storePolygonsAll } = useSpatialPolygons()
  const { data: storeCirclesAll } = useSpatialCircles()
  const { data: storeLinesAll } = useSpatialLines()
  const { data: storeMarkersAll } = useSpatialMarkers()
  const { data: storeImagesAll } = useSpatialImages()
  const { data: storeModelsAll } = useSpatialModels()
  const { data: storeStairsAll } = useSpatialStairs()
  const { data: storeTextLabelsAll } = useSpatialTextLabels()
  const { data: storeImagePlanesAll } = useSpatialImagePlanes()
  const { data: storeGridsAll } = useSpatialGrids()
  const { data: storeBinsAll } = useSpatialBins()
  const { data: storeZonesAll } = useSpatialZones()
  const { data: storeDataLinksAll } = useSpatialDataLinks()
  const { data: storeStyleRulesAll } = useSpatialStyleRules()
  const storeDoors = useDoorStore((s) => s.doors)

  const warehouseIdNum = id !== undefined ? Number(id) : NaN
  // Stable across renders — otherwise the memos below invalidate every
  // parent re-render and the whole overlay cascade fires. Depends only
  // on warehouseIdNum which itself only changes on route param change.
  const inWarehouse = useCallback(
    <T extends { zoneId?: number }>(rows: ReadonlyArray<T> | undefined): T[] => {
      if (!rows) return []
      if (!Number.isFinite(warehouseIdNum)) return rows as T[]
      return rows.filter((r) => r.zoneId === warehouseIdNum)
    },
    [warehouseIdNum],
  )

  // Memoize the six arrays that feed the nav graph so buildNavGraph
  // doesn't re-run on every unrelated re-render. Everything else can
  // stay unmemoized — those arrays are only used for rendering and
  // React handles the diffs cheaply.
  const allPolygons = useMemo(
    () => (isAuthMode ? inWarehouse(storePolygonsAll) : data?.polygons ?? []),
    [isAuthMode, storePolygonsAll, data?.polygons, inWarehouse],
  )
  const allLines = useMemo(
    () => (isAuthMode ? inWarehouse(storeLinesAll) : data?.lines ?? []),
    [isAuthMode, storeLinesAll, data?.lines, inWarehouse],
  )
  const allMarkers = useMemo(
    () => (isAuthMode ? inWarehouse(storeMarkersAll) : data?.markers ?? []),
    [isAuthMode, storeMarkersAll, data?.markers, inWarehouse],
  )
  const allStairs = useMemo(
    () => (isAuthMode ? inWarehouse(storeStairsAll) : data?.stairs ?? []),
    [isAuthMode, storeStairsAll, data?.stairs, inWarehouse],
  )
  const allGrids = useMemo(
    () => (isAuthMode ? inWarehouse(storeGridsAll) : data?.grids ?? []),
    [isAuthMode, storeGridsAll, data?.grids, inWarehouse],
  )
  const allDoors = useMemo(
    () => (isAuthMode ? storeDoors : data?.doors ?? []),
    [isAuthMode, storeDoors, data?.doors],
  )

  // v4 — memoised. Fresh () arrays every render leaked
  // downstream: the MapDataLinkedOverlay's shapeProps ({polygons,
  // circles, markers, lines, models}) was rebuilt every parent render
  // even when the actual shape data hadn't changed. Every un-memoised
  // consumer's push effect fired → source.setData → Mapbox re-layout.
  // Widening filter widget, layers-pill toggles, floor picker → each
  // was cascading a full overlay re-render. See the sibling useMemos
  // on polygons/markers/lines/stairs above for the pattern.
  const allCircles = useMemo(
    () => (isAuthMode ? inWarehouse(storeCirclesAll) : data?.circles ?? []),
    [isAuthMode, storeCirclesAll, inWarehouse, data?.circles],
  )
  const allImages = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeImagesAll) : data?.images ?? []),
    [isAuthMode, storeImagesAll, inWarehouse, data?.images],
  )
  const allModels = useMemo(
    () => (isAuthMode ? inWarehouse(storeModelsAll) : data?.models ?? []),
    [isAuthMode, storeModelsAll, inWarehouse, data?.models],
  )
  const allTextLabels = useMemo(
    () => (isAuthMode ? inWarehouse(storeTextLabelsAll) : data?.textLabels ?? []),
    [isAuthMode, storeTextLabelsAll, inWarehouse, data?.textLabels],
  )
  const allImagePlanes = useMemo(
    () => (isAuthMode ? inWarehouse(storeImagePlanesAll) : data?.imagePlanes ?? []),
    [isAuthMode, storeImagePlanesAll, inWarehouse, data?.imagePlanes],
  )
  const allBins = useMemo(
    () => forceVisible(isAuthMode ? (storeBinsAll ?? []) : data?.bins ?? []),
    [isAuthMode, storeBinsAll, data?.bins],
  )

  const zone: Zone | undefined = isAuthMode
    ? storeZonesAll?.find((z) => z.id === warehouseIdNum)
    : data?.zone

  // Share links with a pinned `defaultFloorPlanId` LOCK the viewer to
  // that single floor — the picker only shows that one option AND the
  // selection can't fall back to another floor via the initialisation
  // effect below. When `defaultFloorPlanId` is null / undefined (or in
  // auth / non-shared mode), the viewer sees every floor and can
  // switch freely. Setting it to `null` in the share dialog means
  // explicitly "show all floors, viewers choose".
  const lockedFloorPlanId = shareSettings?.defaultFloorPlanId

  // Read the persisted floor-plan order from localStorage so the
  // viewer's dropdown matches the editor's sidebar order. Top item
  // = default floor plan.
  const floorPlanOrder = useMemo<number[]>(() => {
    if (!Number.isFinite(warehouseIdNum)) return []
    try {
      const stored = window.localStorage.getItem(
        `sgv-floor-plan-order:${warehouseIdNum}`,
      )
      if (stored) {
        const arr = JSON.parse(stored)
        if (Array.isArray(arr)) return arr.filter((v: unknown) => typeof v === 'number' && v > 0)
      }
    } catch {
      /* ignore */
    }
    return []
  }, [warehouseIdNum])

  const floorPlans = useMemo<ReadonlyArray<ImageShape & { id: number }>>(
    () => {
      const list = allImages
        .filter((img): img is ImageShape & { id: number } => img.id !== undefined)
      if (typeof lockedFloorPlanId === 'number') {
        return list.filter((img) => img.id === lockedFloorPlanId)
      }
      if (floorPlanOrder.length === 0) {
        return [...list].sort((a, b) => a.id - b.id)
      }
      const rank = new Map<number, number>()
      floorPlanOrder.forEach((id, i) => rank.set(id, i))
      return [...list].sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id)! : Infinity
        const rb = rank.has(b.id) ? rank.get(b.id)! : Infinity
        if (ra !== rb) return ra - rb
        return a.id - b.id
      })
    },
    [allImages, lockedFloorPlanId, floorPlanOrder],
  )

  // `floorPlans` gets a fresh reference on every render (upstream
  // `allImages` is not memoized). Derive a stable key from the ids so
  // the default-selection effect only fires when the set of floors
  // actually changes — otherwise picking "All floors" (null) would be
  // clobbered back to the first floor on the next render.
  const floorPlanIdsKey = useMemo(
    () => floorPlans.map((fp) => fp.id).join(','),
    [floorPlans],
  )

  // Every currently-live floor plan id in the warehouse (NOT filtered
  // by `lockedFloorPlanId` — even when a share link pins the viewer to
  // one floor, orphan detection needs the full set to distinguish "an
  // id that used to exist" from "an id the viewer just isn't allowed
  // to see"). Fed into `MapDataLinkedOverlay` so the data-link floor
  // gate treats stale references as unknown instead of dropping the row.
  const liveFloorPlanIds = useMemo(
    () =>
      allImages
        .map((img) => img.id)
        .filter((id): id is number => id !== undefined),
    [allImages],
  )
  // v5.4 — selection is a Set so the viewer can show any subset of
  // floors. `null` means "All floors" (no filter). A single-item set
  // is the pre-v5.4 single-floor case.
  const [selectedFloorPlanIds, setSelectedFloorPlanIds] = useState<
    ReadonlySet<number> | null
  >(null)
  // v5.5 — facility-shell viewer mode. `auto` lets shell models fade
  // by zoom (their own paint expression); `shell-only` pins them
  // opaque AND hides every interior floor / polygon / data-link;
  // `interior-only` pins them transparent (viewer explicitly ignores
  // the shell). See MapModelOverlay for the paint side.
  const [shellMode, setShellMode] = useState<
    'auto' | 'shell-only' | 'interior-only'
  >('auto')
  // Interior is only React-unmounted in the explicit `shell-only`
  // chip. In `auto` mode the shell's zoom-interpolated opacity + the
  // GPU depth buffer already cover the interior visually when the
  // shell is opaque — mounting/unmounting overlays on zoom change was
  // measurably laggy for zero visual gain, so we don't.
  const shellHidesInterior = shellMode === 'shell-only'
  const floorInitializedRef = useRef(false)
  useEffect(() => {
    if (floorPlans.length === 0) {
      floorInitializedRef.current = false
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedFloorPlanIds(null)
      return
    }
    // Share links can pin the viewer to a specific floor via
    // `settings.defaultFloorPlanId`. When set, that's the only
    // valid selection — never `null` (which is "All floors").
    // Rehydrate whenever the floor set changes.
    if (typeof lockedFloorPlanId === 'number') {
      floorInitializedRef.current = true
      setSelectedFloorPlanIds(new Set([lockedFloorPlanId]))
      return
    }
    if (!floorInitializedRef.current) {
      floorInitializedRef.current = true
      setSelectedFloorPlanIds(new Set([floorPlans[0].id]))
      return
    }
    // Set of floors changed after initial default — prune the
    // selection down to floors that still exist. `null` (All floors)
    // stays as-is.
    setSelectedFloorPlanIds((prev) => {
      if (prev === null) return null
      const live = new Set(floorPlans.map((fp) => fp.id))
      const kept = new Set<number>()
      for (const id of prev) if (live.has(id)) kept.add(id)
      if (kept.size === 0) return new Set([floorPlans[0].id])
      return kept
    })
  }, [floorPlanIdsKey, floorPlans, lockedFloorPlanId])

  // Derived: the single-floor id when exactly one is picked, null
  // otherwise (all-floors OR multi-floor). Used to feed APIs that
  // still take one `number | null` (data-link overlay, share settings
  // hydration, layer-rows caching).
  const selectedFloorPlanId = useMemo(
    () => singleFloorId(selectedFloorPlanIds),
    [selectedFloorPlanIds],
  )

  // v5.5 — in `shell-only` mode every interior shape/data-link is
  // suppressed so the shell is the only thing on the map. A tiny
  // helper keeps the pattern uniform. In `auto` mode the shell's
  // OWN opacity expression handles the fade — interior gating for
  // "shell is currently opaque" is done separately via the
  // `shellCoveringInterior` state below (sampled on zoomend to avoid
  // per-frame re-renders).
  const emptyIfShellOnly = useCallback(
    <T,>(arr: readonly T[]): readonly T[] => (shellHidesInterior ? [] : arr),
    [shellHidesInterior],
  )

  const polygons = useMemo(
    () => emptyIfShellOnly(allPolygons.filter((p) => onFloor(p, selectedFloorPlanIds))),
    [allPolygons, selectedFloorPlanIds, emptyIfShellOnly],
  )
  const circles = useMemo(
    () => emptyIfShellOnly(allCircles.filter((c) => onFloor(c, selectedFloorPlanIds))),
    [allCircles, selectedFloorPlanIds, emptyIfShellOnly],
  )
  const lines = useMemo(
    () => emptyIfShellOnly(allLines.filter((l) => onFloor(l, selectedFloorPlanIds))),
    [allLines, selectedFloorPlanIds, emptyIfShellOnly],
  )
  const markers = useMemo(
    () => emptyIfShellOnly(allMarkers.filter((m) => onFloor(m, selectedFloorPlanIds))),
    [allMarkers, selectedFloorPlanIds, emptyIfShellOnly],
  )
  const images = useMemo(
    () =>
      emptyIfShellOnly(
        allImages.filter((img) => shouldShowImage(img, selectedFloorPlanIds)),
      ),
    [allImages, selectedFloorPlanIds, emptyIfShellOnly],
  )
  // v5.5 — model list branches on shellMode / shellHidesInterior:
  //   * shell-only OR (auto + zoom < shell fadeStart) →
  //         keep ONLY the facility-shell models (interior would be
  //         visually covered anyway).
  //   * interior-only → drop shell models entirely; the rest go through the
  //                     normal floor gate.
  //   * auto (zoom >= fadeStart) → every model on the active floor set +
  //                     any shell models.
  const models = useMemo(() => {
    const isShell = (m: ModelShape) => m.config?.facilityShell?.enabled === true
    if (shellMode === 'interior-only') {
      return allModels.filter((m) => !isShell(m) && onFloor(m, selectedFloorPlanIds))
    }
    if (shellHidesInterior) return allModels.filter(isShell)
    return allModels.filter((m) => isShell(m) || onFloor(m, selectedFloorPlanIds))
  }, [allModels, selectedFloorPlanIds, shellMode, shellHidesInterior])
  // Every floor's elevation (hidden floors too), so lifts linked to a
  // floor meet it exactly.
  const floorElevations = useMemo(
    () => new Map(allImages.filter((img) => img.id !== undefined).map((img) => [img.id as number, img.config.elevation ?? 0])),
    [allImages],
  )
  // Building base under a raised floor shown on its own.
  const floorBaseInput = useMemo(
    () => ({
      floors: allImages,
      visibleFloorIds: new Set(images.map((img) => img.id).filter((id): id is number => id !== undefined)),
      polygons: allPolygons,
      lines: allLines,
      stairs: allStairs,
      floorElevations,
    }),
    [allImages, images, allPolygons, allLines, allStairs, floorElevations],
  )
  const stairs = useMemo(
    () =>
      emptyIfShellOnly(
        allStairs.filter(
          (s) =>
            onFloor(s, selectedFloorPlanIds) ||
            (selectedFloorPlanIds !== null &&
              liftFloorPlanIds(s.config).some((id) => selectedFloorPlanIds.has(id))),
        ),
      ),
    [allStairs, selectedFloorPlanIds, emptyIfShellOnly],
  )
  const textLabels = useMemo(
    () => emptyIfShellOnly(allTextLabels.filter((lbl) => onFloor(lbl, selectedFloorPlanIds))),
    [allTextLabels, selectedFloorPlanIds, emptyIfShellOnly],
  )
  const imagePlanes = useMemo(
    () => emptyIfShellOnly(allImagePlanes.filter((p) => onFloor(p, selectedFloorPlanIds))),
    [allImagePlanes, selectedFloorPlanIds, emptyIfShellOnly],
  )
  const doors = useMemo(
    () => emptyIfShellOnly(allDoors.filter((d) => onFloor(d, selectedFloorPlanIds))),
    [allDoors, selectedFloorPlanIds, emptyIfShellOnly],
  )

  // Mirror create-grids.tsx: map wallId → doors attached to that wall so
  // MapLineOverlay's wall generator subtracts each door's footprint from
  // the fill-extrusion. Without this the walls render solid and the door
  // frames appear stuck inside them.
  const attachedDoorsByLineId = useMemo(() => {
    const m = new Map<number, import('@/lib/door/types').DoorShape[]>()
    for (const door of doors) {
      const wallId = door.config.attachedToLineId
      if (wallId === undefined) continue
      const bucket = m.get(wallId)
      if (bucket) bucket.push(door)
      else m.set(wallId, [door])
    }
    return m
  }, [doors])

  const gridFloorIndex = useMemo(() => {
    const m = new Map<number, number | undefined>()
    for (const g of allGrids) {
      if (g.id !== undefined) m.set(g.id, g.floorPlanId)
    }
    return m
  }, [allGrids])
  const grids = useMemo(
    () => allGrids.filter((g) => onFloor(g, selectedFloorPlanIds)),
    [allGrids, selectedFloorPlanIds],
  )
  const bins = useMemo(
    () =>
      allBins.filter((b) => {
        if (selectedFloorPlanId === null) return true
        if (b.gridId === undefined) return false
        return gridFloorIndex.get(b.gridId) === selectedFloorPlanId
      }),
    [allBins, selectedFloorPlanId, gridFloorIndex],
  )

  const [mapInstance, setMapInstance] = useState<MapboxMapInstance | null>(null)
  const fittedRef = useRef(false)
  // Focus mode's pending camera move (set by `focusItem`, consumed by the
  // focus camera effect). While one is pending — or its flight is running —
  // the floor-rotation ease and the first fit stand down.
  const focusCameraIntentRef = useRef<FocusCameraIntent | null>(null)
  useEffect(() => {
    fittedRef.current = false
  }, [id])

  const [mapStyle, setMapStyle] = useState<MapStyleId>(() => {
    try {
      if (typeof window === 'undefined') return DEFAULT_MAP_STYLE
      const saved = window.localStorage.getItem('viewerMapStyle')
      if (saved) return normalizeStyleId(saved)
    } catch {
      /* private-mode storage — fall through */
    }
    return DEFAULT_MAP_STYLE
  })
  // Theme setters used by the share-link settings effect below. Pulled
  // out here so the effect (declared after configFilters state further
  // down) can reference the setters without a fresh hook call.
  const { setTheme, setPalette } = useTheme()
  // Boolean gates the render tree consults for chrome flags. Missing
  // entries default to `true` (viewer shows everything). Declared up
  // here because JSX below references them.
  const chromeFlags = shareSettings?.chrome ?? {}
  const showFloorPlanFilter   = chromeFlags.showFloorPlanFilter   !== false
  const showLayersPanel       = chromeFlags.showLayersPanel       !== false
  const showDataLinkFilter    = chromeFlags.showDataLinkFilter    !== false
  const showStyleSwitcher     = chromeFlags.showStyleSwitcher     !== false
  const showGraphicsSettings  = chromeFlags.showGraphicsSettings  !== false
  const showShareBadge        = chromeFlags.showShareBadge        !== false
  const allowInteraction      = chromeFlags.allowInteraction      !== false
  const shareWatermark        = shareSettings?.watermark ?? ''
  const shareLinkLabel        = shareResult.data?.link.label ?? ''

  // Per-kind visibility helper. Reads the share link's `layerVisibility`
  // map; missing entries default to `true` (layer is shown). Passed to
  // every overlay so a link that hides "Doors" or "3D models" actually
  // removes those overlays from the render tree — `null` unmounts them
  // cleanly rather than passing an empty array, which is a Mapbox
  // no-op but leaves the sources/layers registered against the style.
  const layerVisible = useCallback(
    (kind: import('@/lib/share-link-client').ShareLayerKind): boolean => {
      const v = shareSettings?.layerVisibility?.[kind]
      return v !== false
    },
    [shareSettings],
  )

  // ---- Shape visibility (user-toggled from the layers panel) ----
  // Kinds hidden by the user via the viewer's layers panel. Shapes in
  // these kinds are completely removed from the render tree. Item-level
  // hides are stored per-kind as a Set of shape ids.
  const [hiddenShapeKinds, setHiddenShapeKinds] = useState<Set<string>>(new Set())

  const isShapeKindVisible = useCallback(
    (kind: string) => !hiddenShapeKinds.has(kind),
    [hiddenShapeKinds],
  )

  const toggleShapeKind = useCallback((kind: string) => {
    setHiddenShapeKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }, [])

  // When `allowInteraction` is false (kiosk / embed style share links)
  // we lock the mapbox instance's user handlers so viewers can't
  // pan / zoom / rotate away. Applied as a side-effect so it survives
  // style swaps and reruns when the flag flips.
  useEffect(() => {
    if (!mapInstance) return
    if (allowInteraction) {
      mapInstance.dragPan.enable()
      mapInstance.scrollZoom.enable()
      mapInstance.doubleClickZoom.enable()
      mapInstance.touchZoomRotate.enable()
      mapInstance.dragRotate.enable()
      mapInstance.keyboard.enable()
      mapInstance.boxZoom.enable()
    } else {
      mapInstance.dragPan.disable()
      mapInstance.scrollZoom.disable()
      mapInstance.doubleClickZoom.disable()
      mapInstance.touchZoomRotate.disable()
      mapInstance.dragRotate.disable()
      mapInstance.keyboard.disable()
      mapInstance.boxZoom.disable()
    }
  }, [mapInstance, allowInteraction])
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return
      window.localStorage.setItem('viewerMapStyle', mapStyle)
    } catch {
      /* ignore */
    }
  }, [mapStyle])

  // `loadedStyleId` is the id of the basemap that is currently fully
  // loaded on the map. When the user picks a new style we immediately
  // clear it, which unmounts the overlay tree from React — that avoids
  // the race where overlays try to `addLayer` against a style Mapbox is
  // mid-way through swapping. The next `style.load` fires, we set it
  // back to the active `mapStyle`, and every overlay remounts against a
  // stable basemap and re-adds its sources + layers. Mirrors the
  // editor pattern (create-grids.tsx).
  const [loadedStyleId, setLoadedStyleId] = useState<MapStyleId | null>(null)
  // Tracks whether the initial `style.load` has ever completed. See the
  // editor counterpart in useMapLifecycle.ts for the full rationale —
  // without this guard a style swap drops the gate and the isStyleLoaded()
  // fast-path immediately re-raises it (because setStyle() hasn't been
  // called yet), so overlays never unmount and their layers get wiped
  // without re-initializing.
  const initialStyleLoadedRef = useRef(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadedStyleId((prev) => (prev === mapStyle ? prev : null))
  }, [mapStyle])
  useEffect(() => {
    if (!mapInstance) return
    const onStyleLoad = () => {
      initialStyleLoadedRef.current = true
      setLoadedStyleId(mapStyle)
    }
    mapInstance.on('style.load', onStyleLoad)
    if (!initialStyleLoadedRef.current && mapInstance.isStyleLoaded() && loadedStyleId !== mapStyle) {
      initialStyleLoadedRef.current = true
      setLoadedStyleId(mapStyle)
    }
    return () => {
      mapInstance.off('style.load', onStyleLoad)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInstance, mapStyle])

  // Gate handed to overlays: null during style swap → React unmounts
  // them so they don't fight Mapbox mid-transition.
  const overlayMap = loadedStyleId === mapStyle ? mapInstance : null

  // ---- Auto-rotate camera ------------------------------------------------
  // Same hook the editor uses (`useMapRotation`) — a slow continuous
  // clockwise sweep of the camera around the current centre. Toggled
  // from the same bottom-left control cluster as "Navigate" so the
  // viewer stays a single-glance UI.
  const {
    isRotating: isAutoRotating,
    toggleRotate: toggleAutoRotate,
    stopRotate: stopAutoRotate,
  } = useMapRotation(mapInstance)

  // ---- Route-preview (indoor wayfinding) ---------------------------------
  // End-user surface — a "Navigate" floating button flips the tool on;
  // click point A then point B and the same routing pipeline the editor
  // uses draws a path + shows a directions panel. Toggle is local state
  // (not persisted) so refreshing the viewer resets the session.
  const [routePreviewActive, setRoutePreviewActive] = useState(false)

  useEffect(() => {
    if (!mapInstance || fittedRef.current) return

    // Priority 1 — drawn floor-plan image bbox with the floor's own
    // bearing as the camera heading. This is the GROUND TRUTH of the
    // warehouse layout — a stale `zone.defaultView` from an old
    // session must not win over the shapes the user actually authored.
    // Mapbox docs: `fitBounds(bounds, { bearing })` rotates the camera
    // to `bearing` and then fits the axis-aligned lng/lat bbox inside
    // the rotated viewport — which is what we want here.
    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    let hasImage = false
    let floorRotation = 0
    for (const img of allImages) {
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

    if (hasImage) {
      mapInstance.fitBounds(
        [[minLng, minLat], [maxLng, maxLat]],
        { padding: 40, duration: 800, maxZoom: 22, bearing: floorRotation },
      )
      fittedRef.current = true
      return
    }

    // Priority 2 — grid bounds when no floor plans exist yet.
    if (allGrids.length > 0) {
      fitMapToGrids(mapInstance, allGrids as Grid[])
      fittedRef.current = true
      return
    }

    // Priority 3 — the user's explicitly-saved default view. Only
    // reached when the warehouse has NO drawn geometry (shapes or
    // grids). A saved viewport from an older session may point at the
    // wrong lat/lng, so we prefer the raw drawings above.
    if (zone?.defaultView) {
      const v = zone.defaultView
      mapInstance.easeTo({
        center: [v.lng, v.lat],
        zoom: v.zoom,
        pitch: v.pitch ?? 0,
        bearing: v.bearing ?? 0,
        duration: 800,
      })
      fittedRef.current = true
      return
    }

    // Priority 4 (TENTATIVE) — zone.center as a soft prefit. This is
    // deliberately soft: we ease to the warehouse's marker but DO NOT
    // set `fittedRef.current`. When floor plan images arrive on the
    // next data tick this effect re-runs and priority 1 takes over,
    // fitting the camera to the actual drawn geometry. Locking here
    // would strand users on a rough centre point forever.
    if (zone?.center) {
      mapInstance.easeTo({
        center: zone.center,
        zoom: Math.max(mapInstance.getZoom(), 17),
        duration: 400,
      })
    }
  }, [mapInstance, zone, allImages, allGrids])

  // Rotation the map should adopt for the currently-selected floor.
  // Reads the picked floor image's `rotation` field so both the map
  // bearing AND the route rectification stay aligned to the floor
  // plan's own axes — not to the raw map compass. If no floor plan
  // is selected we return null (no forced rotation).
  const selectedFloorRotation = useMemo(() => {
    if (selectedFloorPlanId === null) return null
    const floor = allImages.find((img) => img.id === selectedFloorPlanId)
    if (!floor) return null
    return floor.rotation ?? 0
  }, [selectedFloorPlanId, allImages])
  // Ease the bearing to match the selected floor plan — but ONLY on
  // subsequent floor changes. The initial fit useEffect above already
  // sets `bearing: floorRotation` in its `fitBounds` call, so easing
  // here on first render would immediately interrupt that fit-bounds
  // animation and the user would never see the warehouse zoom in.
  const rotationSkipInitialRef = useRef(false)
  useEffect(() => {
    if (!mapInstance) return
    if (selectedFloorRotation === null) return
    if (!rotationSkipInitialRef.current) {
      rotationSkipInitialRef.current = true
      return
    }
    // A focus flight owns the camera: it folds this floor's rotation into
    // its own bearing, and an ease here would cut it short.
    if (focusCameraIntentRef.current !== null || isFocusFlying(mapInstance)) return
    const current = mapInstance.getBearing()
    if (Math.abs(current - selectedFloorRotation) < 0.5) return
    mapInstance.easeTo({ bearing: selectedFloorRotation, duration: 400 })
  }, [mapInstance, selectedFloorRotation])

  const modelUrlMap = useModelUrlMap()
  const modelBoundingCenters = useModelBoundingCenterMap()
  // Full AABB per asset, as in the editor: the overlay rests each model's
  // bottom on its elevation. Without it, it falls back to centre-based
  // anchoring and scaled-up uploads (cm-authored GLBs at ×100) sink.
  const modelBounds = useModelBoundsMap()
  // Route planner input: every floor (the floor picker only decides what
  // is shown — a route may pass through floors that aren't); clicks land
  // on the shown floors.
  const routeFacility = useMemo<FacilityRoutingInput>(
    () => ({
      images: allImages,
      lines: allLines,
      doors: allDoors,
      polygons: allPolygons,
      grids: allGrids,
      stairs: allStairs,
      circles: allCircles,
      models: allModels,
      modelBounds,
    }),
    [allImages, allLines, allDoors, allPolygons, allGrids, allStairs, allCircles, allModels, modelBounds],
  )
  const routePreview = useRoutePreviewTool({
    mapInstance,
    // The hook only listens when activeTool === 'route-preview'. Pass a
    // synthetic value so the editor's `Tool` union covers both call
    // sites without a second code path.
    activeTool: routePreviewActive ? 'route-preview' : 'pan',
    facility: routeFacility,
    pickableFloorIds: selectedFloorPlanIds,
  })
  const routePortalLabel = useCallback(
    (kind: 'stairs' | 'escalator' | 'lift', name: string, dir: 'up' | 'down' | null) =>
      `${name || t(`routePanel.portal.${kind}`)}${dir === 'up' ? ' ↑' : dir === 'down' ? ' ↓' : ''}`,
    [t],
  )
  // Bundled assets only carry bounds once their inspector is fetched —
  // limit that to the assets placed in this facility.
  const placedModelAssetIds = useMemo(() => {
    const s = new Set<string>()
    for (const m of allModels) if (m.config?.modelAssetId) s.add(m.config.modelAssetId)
    return s
  }, [allModels])
  useModelInspectorMap(placedModelAssetIds)

  const [drawerPolygonId, setDrawerPolygonId] = useState<number | null>(null)
  const drawerPolygon: PolygonShape | undefined = useMemo(
    // Every floor: a focus can open the drawer one render before the
    // floor picker shows the area's floor.
    () => (drawerPolygonId === null ? undefined : allPolygons.find((p) => p.id === drawerPolygonId)),
    [drawerPolygonId, allPolygons],
  )
  const drawerBin: Bin | undefined = useMemo(() => {
    if (drawerPolygonId === null) return undefined
    // Look up against `allBins` — floor filtering doesn't apply to
    // shape-attached bins (they're indexed by (targetKind, shapeId), not
    // by grid). The floor filter drops any bin without a gridId, which
    // is exactly what polygon bins look like.
    return allBins.find(
      (b) => b.targetKind === 'polygon' && b.shapeId === drawerPolygonId,
    )
  }, [drawerPolygonId, allBins])

  // Same drawer treatment for markers — click opens a sidebar with
  // the marker's linked bin data (sensor / camera / asset payload),
  // using the same ShapeDetailDrawer as polygons.
  const [drawerMarkerId, setDrawerMarkerId] = useState<number | null>(null)
  const drawerMarker = useMemo(
    () => (drawerMarkerId === null ? undefined : allMarkers.find((m) => m.id === drawerMarkerId)),
    [drawerMarkerId, allMarkers],
  )
  const drawerMarkerBin: Bin | undefined = useMemo(() => {
    if (drawerMarkerId === null) return undefined
    return allBins.find(
      (b) => b.targetKind === 'marker' && b.shapeId === drawerMarkerId,
    )
  }, [drawerMarkerId, allBins])

  // Set of data-link config ids the user has toggled OFF via the
  // Layers pill. Configs whose id lives here are filtered out of the
  // list passed to MapDataLinkedOverlay so their widget disappears.
  const [hiddenConfigIds, setHiddenConfigIds] = useState<Set<number>>(new Set())
  // v5 — which saved filter each layer is showing. Keyed by config id;
  // the value is a `DataLinkFilterPreset.id`, or `''` for "all records".
  // A missing key means the viewer hasn't chosen, so the layer's own
  // default preset (if any) applies — see `resolvedFilters` below.
  //
  // Filters are authored in the data-link editor, never here: the
  // viewer picks from published presets so a shared link stays
  // reproducible.
  const [activePresetIds, setActivePresetIds] = useState<Record<number, string>>({})

  // v5.1 — runtime values the viewer types for presets whose author left
  // some value slots blank. Keyed [configId][presetId] = array of values
  // in traversal order (see `collectPromptLeaves`). Not persisted in
  // share links: prompt values are per-session so the viewer isn't
  // handed a stranger's inputs.
  const [presetPromptValues, setPresetPromptValues] = useState<
    Record<number, Record<string, Array<DataLinkFilterCondition['value']>>>
  >({})

  // ---- Share-link settings application ---------------------------
  // Every knob configured in the share dialog lands here. Each field
  // is applied ONCE per token load so the viewer respects a subsequent
  // manual override (e.g. the user tweaks the map style — the share
  // link's `mapStyle` shouldn't snap them back on the next render).
  //
  // The applied-flag ref keys off token so navigating between two
  // share URLs cleanly re-applies each link's own settings.
  const appliedSettingsForTokenRef = useRef<string | null>(null)
  useEffect(() => {
    const activeToken = shareTokenForLookup ?? null
    if (activeToken === null || !shareSettings) return
    if (appliedSettingsForTokenRef.current === activeToken) return
    appliedSettingsForTokenRef.current = activeToken

    if (shareSettings.mapStyle) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMapStyle(normalizeStyleId(shareSettings.mapStyle))
    }
    if (shareSettings.themeMode) setTheme(shareSettings.themeMode)
    if (shareSettings.palette) setPalette(shareSettings.palette)
    if (shareSettings.hiddenDataLinkConfigIds?.length) {
      setHiddenConfigIds(new Set(shareSettings.hiddenDataLinkConfigIds))
    }
    if (shareSettings.dataLinkFilterPresets) {
      setActivePresetIds(shareSettings.dataLinkFilterPresets)
    }
    if (shareSettings.defaultFloorPlanId !== undefined) {
      const pinned = shareSettings.defaultFloorPlanId
      setSelectedFloorPlanIds(pinned === null ? null : new Set([pinned]))
      floorInitializedRef.current = true
    }
  }, [shareSettings, shareTokenForLookup, setTheme, setPalette])
  // v5.2 — the viewer bar holds a draft internally and commits on
  // Apply, so the map re-queries at most once per user gesture instead
  // of on every keystroke.
  const applyFilterDraft = useCallback(
    (
      ids: Record<number, string>,
      vals: Record<
        number,
        Record<string, Array<DataLinkFilterCondition['value']>>
      >,
    ) => {
      setActivePresetIds(ids)
      setPresetPromptValues(vals)
    },
    [],
  )
  // In auth mode the data-link configs come from the spatial store
  // (`storeDataLinksAll`); in public / share-token mode they arrive
  // as part of the WarehouseView envelope (backend slice 24 extended
  // the payload). Same for style rules — see the composite `data`
  // above. Falling back to `[]` guarantees the Layers pill and the
  // data-linked overlay both mount even for anonymous viewers.
  const warehouseConfigs = useMemo(() => {
    if (isAuthMode) {
      const list = storeDataLinksAll ?? []
      if (!Number.isFinite(warehouseIdNum)) return list
      return list.filter((c) => c.zoneId === warehouseIdNum)
    }
    return data?.dataLinkConfigs ?? []
  }, [isAuthMode, storeDataLinksAll, warehouseIdNum, data?.dataLinkConfigs])

  const activeStyleRules = useMemo(() => {
    if (isAuthMode) return storeStyleRulesAll ?? []
    return data?.styleRules ?? []
  }, [isAuthMode, storeStyleRulesAll, data?.styleRules])

  // Build the viewer index the resolver needs to broadcast a rule to
  // every shape of a kind. Mirrors the editor's `viewerIndex` in
  // create-grids/index.tsx.
  //
  // Grid cells are NOT listed here: `gridCellsFromBins` has the resolver
  // enumerate every grid-cell bin with a full address itself (the same
  // list, in the same order, this memo used to build from `allBins`).
  // Building it here rebuilt ~50k objects on every seat event and changed
  // the index identity, which forced the resolver to compare the whole
  // cell list again; without it the index only changes with the shapes.
  const viewerIndex = useMemo<import('@/lib/style-rules').ViewerIndex>(
    () => ({
      polygons,
      circles,
      lines,
      markers,
      images,
      models,
      textLabels,
      stairs,
      gridCells: [],
    }),
    [polygons, circles, lines, markers, images, models, textLabels, stairs],
  )

  // Resolve per-cell + per-shape style overrides from bins + style
  // rules — same call the editor makes (see create-grids/index.tsx).
  const resolvedStyles = useMemo(
    () =>
      resolveStyleMaps(activeStyleRules, allBins, {
        zoneId: warehouseIdNum ?? undefined,
        viewers: viewerIndex,
        gridCellsFromBins: true,
      }),
    [activeStyleRules, allBins, warehouseIdNum, viewerIndex],
  )

  // Resolves each layer's chosen preset into the three things the rest
  // of the tree needs: the filter tree for the overlay, the preset id
  // for the chip bar's selected state, and the label for the layers
  // panel badge. Keeping this in one pass means those three can't
  // disagree about what's applied.
  //
  // A config id absent from `activePresetIds` falls back to the layer's
  // `isDefault` preset; an explicit `''` means the viewer picked
  // "all records" and must NOT be overridden by that default.
  const { configFilters, resolvedPresetIds, activeFilterLabels } = useMemo(() => {
    const filters: Record<number, DataLinkFilter | null> = {}
    const resolved: Record<number, string> = {}
    const labels: Record<number, string> = {}
    for (const cfg of warehouseConfigs) {
      if (cfg.id === undefined) continue
      const presets = cfg.fieldMapping?.filters ?? []
      if (presets.length === 0) continue
      const chosen = activePresetIds[cfg.id]
      const preset =
        chosen === undefined
          ? presets.find((p) => p.isDefault)
          : presets.find((p) => p.id === chosen)
      resolved[cfg.id] = preset?.id ?? ''
      if (preset) {
        // Substitute any runtime values the viewer has typed. Prompts
        // that still lack a value make the resolved tree invalid, in
        // which case the filter is held back — the layer stays
        // unfiltered until the viewer completes the inputs, so the map
        // never briefly shows a broken query result.
        const runtime = presetPromptValues[cfg.id]?.[preset.id] ?? []
        const promptCount = collectPromptLeaves(preset.filter).length
        const resolvedTree =
          promptCount > 0
            ? resolvePromptValues(preset.filter, runtime)
            : preset.filter
        if (promptCount === 0 || allLeavesValid(resolvedTree)) {
          filters[cfg.id] = resolvedTree
        }
        labels[cfg.id] = preset.label
      }
    }
    return {
      configFilters: filters,
      resolvedPresetIds: resolved,
      activeFilterLabels: labels,
    }
  }, [warehouseConfigs, activePresetIds, presetPromptValues])

  const visibleConfigs = useMemo(
    () =>
      warehouseConfigs.filter(
        (c) => c.id === undefined || !hiddenConfigIds.has(c.id),
      ),
    [warehouseConfigs, hiddenConfigIds],
  )
  // The report map's Live / Cluster / Heatmap controls (viewer-map-tools.tsx).
  const floorsStacked = floorPlans.length > 1 && singleFloorId(selectedFloorPlanIds) === null
  const mapTools = useViewerMapTools({ configs: visibleConfigs, floorsStacked })
  // Heat stops at walls and solid objects — the route planner's shapes.
  const pointHeatmap = useMemo(
    () => (mapTools.pointHeatmap ? { ...mapTools.pointHeatmap, barriers: routeFacility } : null),
    [mapTools.pointHeatmap, routeFacility],
  )
  // Several floors read as a stack only with the camera tilted (as on a
  // report map): switching to them eases a flat camera to 55°. The first
  // framing and a single floor keep whatever pitch the viewer has.
  const wasStackedRef = useRef(floorsStacked)
  useEffect(() => {
    const was = wasStackedRef.current
    wasStackedRef.current = floorsStacked
    if (!overlayMap || !floorsStacked || was) return
    if (overlayMap.getPitch() < 50) overlayMap.easeTo({ pitch: 55, duration: 700 })
  }, [overlayMap, floorsStacked])

  // Shape items for the viewer layers panel — maps each shape kind to
  // its visible items (filtered by floor + user toggle).
  const shapeLayerItems = useMemo(
    () => ({
      polygons: polygons.map((p) => ({ id: p.id!, name: p.name })),
      circles: circles.map((c) => ({ id: c.id!, name: c.name })),
      markers: markers.map((m) => ({ id: m.id!, name: m.name })),
      models: models.map((m) => ({ id: m.id!, name: m.name })),
      stairs: stairs.map((s) => ({ id: s.id!, name: s.name })),
      doors: doors.map((d) => ({ id: d.id, name: d.name })),
      imagePlanes: imagePlanes.map((ip) => ({ id: ip.id!, name: ip.name })),
      textLabels: textLabels.map((tl) => ({ id: tl.id!, name: textLabelName(tl) })),
      grids: grids.map((g) => ({ id: g.id!, name: g.name })),
      images: images.map((img) => ({ id: img.id!, name: img.name })),
      bins: (bins ?? []).map((b) => ({
        id: b.id!,
        name: b.sku || b.externalCode || `Bin ${b.row ?? '?'}-${b.col ?? '?'}`,
        focusable: focusTargetForBin(b) !== null,
      })),
    }),
    [polygons, circles, markers, models, stairs, doors, imagePlanes, textLabels, grids, images, bins],
  )
  const toggleConfigVisibility = (configId: number) => {
    setHiddenConfigIds((prev) => {
      const next = new Set(prev)
      if (next.has(configId)) next.delete(configId)
      else next.add(configId)
      return next
    })
  }
  const setAllConfigsOfKind = (kind: DataLinkLayerKind, hidden: boolean) => {
    setHiddenConfigIds((prev) => {
      const next = new Set(prev)
      for (const cfg of warehouseConfigs) {
        if (cfg.id === undefined) continue
        if (inferLayerKind(cfg) !== kind) continue
        if (hidden) next.add(cfg.id)
        else next.delete(cfg.id)
      }
      return next
    })
  }
  // Flips a config's `enabled` flag in the DB. The overlay only
  // renders configs with `enabled === true`, so a layer that's been
  // toggled off in the data-link manager won't appear on the map
  // even though it still shows in the Layers pill. Surfacing the
  // toggle here lets the user re-enable without bouncing through
  // the manager.
  const toggleConfigEnabled = useCallback((configId: number, enabled: boolean) => {
    useSpatialStore.getState().updateLocal('data-link-configs', configId, { enabled })
    void useSpatialStore.getState().commit('data-link-configs')
  }, [])

  // Data-link widget drawer — for point-at-coord / heatmap / track
  // widgets that aren't bound to a shape id. Populated with a
  // synthetic Bin whose `customProperties` are the entity payload,
  // so ShapeDetailDrawer can render the same way it does for a real
  // bin. Cleared when the drawer closes.
  // The drawer is either showing a single entity (`bin`) or a cluster
  // of entities (`clusterItems`, non-empty). In cluster mode a
  // scrollable list of leaves is shown; clicking one flips the drawer
  // back into single-item mode by populating `bin`.
  const [dlEntityDrawer, setDlEntityDrawer] = useState<DlEntityDrawerState | null>(null)

  const polygonTriggerIndex = useMemo(() => {
    const idx = new Map<number, 'hover' | 'click'>()
    for (const p of polygons) {
      if (p.id === undefined) continue
      idx.set(p.id, p.config.tooltipTrigger ?? 'hover')
    }
    return idx
  }, [polygons])

  // ---- Focus mode ---------------------------------------------------------
  //
  // One focused item at a time, held here (never in a store) and handed to
  // the overlays through FocusSceneContext / FocusBlockersContext (see the
  // providers around the overlay stack). Every trigger goes through
  // `focusItem`, which also opens exactly one detail drawer; closing the
  // drawer, Esc, the chip's ✕ or a click on anything that doesn't focus
  // something else goes through `exitFocus`. With no focus both contexts
  // carry FOCUS_OFF / NO_BLOCKERS and the map is drawn exactly as before.
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null)
  /** Chip name a trigger supplied (data-link rows: their label field). */
  const [focusLabel, setFocusLabel] = useState<string | null>(null)
  /** Bumped by every focus request that moves the camera, so re-focusing the same item flies again. */
  const [focusCameraNonce, setFocusCameraNonce] = useState(0)
  /** Bumped by every focus action — a map click during which it changed was claimed by a trigger. */
  const focusSeqRef = useRef(0)
  /**
   * True while a click on a data-link symbol is being dispatched. The
   * symbols draw above every shape, so they win the click: the shape
   * handlers that run after the data-link one (grid cell, area, label,
   * door, the tooltip's override) stand down while it is set.
   */
  const dataLinkClickRef = useRef(false)
  const focusActive = focusTarget !== null

  // The viewer's own rows (the store is empty on share links). Every
  // floor: the item may sit on a floor the picker hides.
  const focusShapes = useMemo<FocusShapes>(
    () => ({
      markers: allMarkers,
      polygons: allPolygons,
      circles: allCircles,
      lines: allLines,
      stairs: allStairs,
      grids: allGrids,
      images: allImages,
      imagePlanes: allImagePlanes,
      models: allModels,
      doors: allDoors,
      textLabels: allTextLabels,
    }),
    [allMarkers, allPolygons, allCircles, allLines, allStairs, allGrids, allImages, allImagePlanes, allModels, allDoors, allTextLabels],
  )
  const resolvedFocus = useMemo(() => resolveFocus(focusTarget, focusShapes), [focusTarget, focusShapes])

  // The geometry markers / door labels hide behind — each kind gated on
  // its own visibility (see the marker overlay). One memo, so the marker
  // overlay, the door overlay and focus mode hand `buildOccluders` the
  // same arrays and share one prism list / spatial index.
  const visibleOccluders = useMemo(
    () => ({
      images: layerVisible('images') && isShapeKindVisible('images') ? images : undefined,
      polygons: layerVisible('polygons') && isShapeKindVisible('polygons') ? polygons : undefined,
      circles: layerVisible('circles') && isShapeKindVisible('circles') ? circles : undefined,
      lines: layerVisible('lines') && isShapeKindVisible('lines') ? lines : undefined,
      stairs: layerVisible('stairs') && isShapeKindVisible('stairs') ? stairs : undefined,
      grids: layerVisible('racks') && isShapeKindVisible('grids') ? grids : undefined,
    }),
    [layerVisible, isShapeKindVisible, images, polygons, circles, lines, stairs, grids],
  )
  // Built only while something is focused (not gated on the Graphics
  // occlusion toggle — blockers and the camera probe need it either way).
  const focusPrisms = useMemo(
    () => (focusActive ? buildOccluders(visibleOccluders) : NO_PRISMS),
    [focusActive, visibleOccluders],
  )
  const focusBlockers = useTrackFocusBlockers(overlayMap, resolvedFocus, focusPrisms)
  // The item's NEAR set (fades to FOCUS_FACTOR.near): what it sits inside,
  // volumetric shapes on its floor within 5 m, anything overhead.
  // Computed once per focus / floor switch, never on a camera move.
  const focusNear = useFocusNear(resolvedFocus, focusPrisms, focusShapes)

  // `?focus=` (applied further down) — declared here because leaving or
  // moving the focus takes it out of the URL.
  const focusParam = searchParams.get('focus')
  const focusParamTarget = useMemo(() => parseFocusParam(focusParam), [focusParam])
  const focusParamTag = focusParam ? `${id ?? ''}|${focusParam}` : ''
  /** The `?focus=` tag already applied (null once the param leaves the URL, so the same link applies again). */
  const appliedFocusParamRef = useRef<string | null>(null)
  /** Drop `?focus=` from the URL — replace, never a new history entry. */
  const dropFocusParam = useStableCallback(() => {
    if (!searchParams.has('focus')) return
    setSearchParams(withoutFocusParam, { replace: true })
  })
  /**
   * Once a `?focus=` link has been applied, the URL follows the focus: when
   * it moves off the link's item (another item, or none) the param goes, so
   * a reload doesn't bring a stale focus back.
   */
  const releaseFocusParam = useStableCallback((nextKey: string) => {
    if (focusParamReleased(appliedFocusParamRef.current, focusParamTag, focusKey(focusParamTarget), nextKey)) {
      dropFocusParam()
    }
  })

  const liveFloorIdSet = useMemo(() => new Set(liveFloorPlanIds), [liveFloorPlanIds])
  const sharePinnedHiddenConfigIds = useMemo(
    () => new Set(shareSettings?.hiddenDataLinkConfigIds ?? []),
    [shareSettings],
  )

  /** Leave focus but keep whatever drawer is open (cluster "Back to list", a row that can't be drawn). */
  const clearFocusOnly = useStableCallback(() => {
    focusCameraIntentRef.current = null
    setFocusTarget(null)
    setFocusLabel(null)
    releaseFocusParam('')
  })

  /** Leave focus: the map returns to its unfocused look and every drawer closes. */
  const exitFocus = useStableCallback(() => {
    clearFocusOnly()
    setDrawerMarkerId(null)
    setDrawerPolygonId(null)
    setDlEntityDrawer(null)
  })

  /**
   * Focus one item. Share links never reveal what the link hides: a kind,
   * data-link layer or floor the link leaves out is refused with a toast.
   * Toggles the viewer switched off themselves are switched back on for
   * the focused kind / layer, and shell-only mode drops back to auto.
   */
  const focusItem = useStableCallback((requested: FocusTarget, opts: FocusItemOptions): boolean => {
    focusSeqRef.current += 1
    // Re-focusing the row already focused keeps its drawn anchor (no
    // flicker back to "pending" while the overlay re-reports it).
    const prev = focusTarget
    const target: FocusTarget =
      requested.kind === 'dl' &&
      !requested.anchor &&
      prev?.kind === 'dl' &&
      prev.anchor &&
      focusKey(prev) === focusKey(requested)
        ? { ...requested, anchor: prev.anchor }
        : requested
    const refusal = focusRefusal(target, {
      layerVisible,
      pinnedHiddenConfigIds: sharePinnedHiddenConfigIds,
      lockedFloorPlanId: typeof lockedFloorPlanId === 'number' ? lockedFloorPlanId : null,
      configs: warehouseConfigs,
      shapes: focusShapes,
    })
    if (refusal !== null) {
      toast.info(
        refusal === 'notInLink'
          ? t('view.focus.notInLink', { defaultValue: "That item isn't part of this shared view." })
          : t('view.focus.notFound', { defaultValue: 'That item is no longer on this map.' }),
      )
      return false
    }
    const dlRef = focusDlRef(target)

    const hideKey = target.kind === 'dl' ? undefined : HIDE_KEY_OF_FOCUS[target.kind]
    if (hideKey) {
      setHiddenShapeKinds((prev) => {
        if (!prev.has(hideKey)) return prev
        const next = new Set(prev)
        next.delete(hideKey)
        return next
      })
    }
    if (dlRef) {
      setHiddenConfigIds((prev) => {
        if (!prev.has(dlRef.configId)) return prev
        const next = new Set(prev)
        next.delete(dlRef.configId)
        return next
      })
    }
    if (shellMode === 'shell-only') setShellMode('auto')

    setFocusTarget(target)
    setFocusLabel(opts.label ?? null)
    // Exactly one drawer: the one this focus asks for, or none.
    setDrawerMarkerId(opts.drawer === 'marker' && target.kind === 'markers' ? target.id : null)
    setDrawerPolygonId(opts.drawer === 'polygon' && target.kind === 'polygons' ? target.id : null)
    setDlEntityDrawer(opts.dlDrawer ?? null)

    if (opts.camera === 'none') {
      focusCameraIntentRef.current = null
    } else {
      focusCameraIntentRef.current = { key: focusKey(target), mode: opts.camera, floorSwitched: false }
      setFocusCameraNonce((n) => n + 1)
    }
    releaseFocusParam(focusKey(target))
    return true
  })

  /** Open the data-link drawer for something that isn't one row (a cluster list, a keyless row). */
  const showDataLinkDrawerOnly = useStableCallback((state: DlEntityDrawerState) => {
    focusSeqRef.current += 1
    clearFocusOnly()
    setDrawerMarkerId(null)
    setDrawerPolygonId(null)
    setDlEntityDrawer(state)
  })

  /**
   * Focus one data-link row and open its drawer. Shape-bound layers
   * (marker / polygon) focus the shape instead — with the row as its
   * `dl` sub-ref so the row's symbol is exempt too — and open the
   * shape's drawer, the same UX as clicking the shape itself. Shared by
   * the map click, the popup's "View more" and the Layers pill.
   */
  const focusDataLinkEntity = useStableCallback(
    (
      cfg: DataLinkConfig,
      payload: Record<string, unknown>,
      entityKey: string | undefined,
      opts: { camera: FocusItemOptions['camera']; anchor?: DlAnchor },
    ) => {
      if (cfg.id === undefined) return
      const shapeId = cfg.targetShapeId
      if (shapeId !== undefined && shapeId !== null && (cfg.targetKind === 'marker' || cfg.targetKind === 'polygon')) {
        const dl = entityKey !== undefined ? { configId: cfg.id, entityKey } : undefined
        const kind = cfg.targetKind === 'marker' ? 'markers' : 'polygons'
        focusItem(dl ? { kind, id: shapeId, dl } : { kind, id: shapeId }, {
          camera: opts.camera,
          drawer: drawerForFocusKind(kind),
        })
        return
      }
      const drawer = dataLinkDrawerFor(cfg, payload, entityKey, t('view.drawer.kind.asset', { defaultValue: 'Asset' }))
      if (entityKey === undefined) {
        showDataLinkDrawerOnly(drawer)
        return
      }
      focusItem(
        opts.anchor
          ? { kind: 'dl', configId: cfg.id, entityKey, anchor: opts.anchor }
          : { kind: 'dl', configId: cfg.id, entityKey },
        { camera: opts.camera, dlDrawer: drawer, label: dataLinkLabelOf(cfg, payload, entityKey) },
      )
    },
  )

  // The data-link overlay → here: where the pending row is drawn (or null
  // when it can't be). The anchor merges into the target; the key stays.
  const onDlAnchor = useStableCallback((key: string, anchor: DlAnchor | null) => {
    const current = focusTarget
    if (!current || current.kind !== 'dl' || focusKey(current) !== key) return
    if (!anchor) {
      toast.info(t('view.focus.notFound', { defaultValue: 'That item is no longer on this map.' }))
      clearFocusOnly()
      return
    }
    if (typeof lockedFloorPlanId === 'number' && anchor.floorPlanId !== null && anchor.floorPlanId !== lockedFloorPlanId) {
      toast.info(t('view.focus.notInLink', { defaultValue: "That item isn't part of this shared view." }))
      exitFocus()
      return
    }
    const prev = current.anchor
    if (
      prev &&
      prev.position[0] === anchor.position[0] &&
      prev.position[1] === anchor.position[1] &&
      prev.elevationM === anchor.elevationM &&
      prev.floorPlanId === anchor.floorPlanId
    ) {
      return
    }
    setFocusTarget((tgt) => (tgt && tgt.kind === 'dl' && focusKey(tgt) === key ? { ...tgt, anchor } : tgt))
  })

  // A focused record keeps the camera while its table plays back (history
  // player): the camera eases onto it and the anchor — so the ring and the
  // fades — moves with it. Dragging the map pauses; the chip resumes.
  const followCfg = focusTarget?.kind === 'dl' ? visibleConfigs.find((c) => c.id === focusTarget.configId) : undefined
  const followKey = focusTarget?.kind === 'dl' ? focusTarget.entityKey : null
  const follow = useFollowEntity(overlayMap, {
    config: followCfg,
    entityKey: followKey,
    enabled: followCfg?.renderMode === 'history-movement',
    onMove: (point) => {
      // Only moves the anchor the overlay reported (see facility-map.tsx).
      if (focusTarget?.kind !== 'dl' || !focusTarget.anchor) return
      onDlAnchor(focusKey(focusTarget), { position: point, elevationM: focusTarget.anchor.elevationM, floorPlanId: focusTarget.anchor.floorPlanId })
    },
  })

  // Backstop: a data-link row the overlay never reports (its layer never
  // loads) must not leave a pending focus up forever.
  const pendingDlKey = focusTarget?.kind === 'dl' && !focusTarget.anchor ? focusKey(focusTarget) : ''
  const giveUpPendingDl = useStableCallback((key: string) => {
    if (focusTarget?.kind !== 'dl' || focusTarget.anchor || focusKey(focusTarget) !== key) return
    toast.info(t('view.focus.notFound', { defaultValue: 'That item is no longer on this map.' }))
    clearFocusOnly()
  })
  useEffect(() => {
    if (pendingDlKey === '') return
    const timer = setTimeout(() => giveUpPendingDl(pendingDlKey), DL_ANCHOR_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [pendingDlKey, giveUpPendingDl])

  const focusScene = useFocusSceneValue({
    target: focusTarget,
    resolved: resolvedFocus,
    near: focusNear,
    onDlAnchor,
  })

  // The focused shape gets its overlay's own selection highlight (markers
  // are styled through `data-focus-tier` instead; a rack bin gets the grid
  // overlay's focus layer, not the whole rack's outline).
  let focusSelKind: FocusShapeKind | null = null
  let focusSelId: number | null = null
  if (focusTarget && focusTarget.kind !== 'dl' && focusTarget.kind !== 'markers' && !focusTarget.cell) {
    focusSelKind = focusTarget.kind
    focusSelId = focusTarget.id
  }
  const focusSelection = useMemo(
    () =>
      focusSelKind !== null && focusSelId !== null
        ? { kind: focusSelKind, ids: new Set([focusSelId]) as ReadonlySet<number> }
        : null,
    [focusSelKind, focusSelId],
  )
  const focusSelectedIds = (kind: FocusShapeKind): ReadonlySet<number> | undefined =>
    focusSelection?.kind === kind ? focusSelection.ids : undefined

  // Polygon selection outline — the open area drawer and the focused area.
  const selectedPolygonIds = useMemo(() => {
    const set = new Set<number>()
    if (drawerPolygonId !== null) set.add(drawerPolygonId)
    if (focusSelKind === 'polygons' && focusSelId !== null) set.add(focusSelId)
    return set
  }, [drawerPolygonId, focusSelKind, focusSelId])

  // Show the focused item's floor when the picker hides it: a single-floor
  // pick switches to it, a multi-floor pick adds it. A floor-locked share
  // link is never overridden (its items were checked in `focusItem`).
  const showFocusFloor = useStableCallback((key: string, floor: number) => {
    if (typeof lockedFloorPlanId === 'number') return
    const next = floorSelectionShowing(selectedFloorPlanIds, floor, liveFloorIdSet)
    if (next === undefined) return
    const intent = focusCameraIntentRef.current
    if (intent && intent.key === key) intent.floorSwitched = true
    setSelectedFloorPlanIds(next)
  })
  const focusFloorKey = resolvedFocus?.key ?? ''
  const focusFloorId = resolvedFocus?.floorPlanId ?? null
  useEffect(() => {
    if (focusFloorKey === '' || focusFloorId === null) return
    showFocusFloor(focusFloorKey, focusFloorId)
  }, [focusFloorKey, focusFloorId, showFocusFloor])

  // Bring the camera to the item once its floor is on screen: a clear line
  // of sight when there is one (`flyToFocus` probes pitches / bearings),
  // clear of the drawer, with the new floor's rotation folded in. A map
  // click ('reveal') only pans the item out from under the drawer.
  const anyDrawerOpen = drawerMarkerId !== null || drawerPolygonId !== null || dlEntityDrawer !== null
  useEffect(() => {
    const intent = focusCameraIntentRef.current
    if (!intent || !overlayMap || !resolvedFocus || resolvedFocus.key !== intent.key) return
    const locked = typeof lockedFloorPlanId === 'number' ? lockedFloorPlanId : null
    if (!focusFloorShown(selectedFloorPlanIds, resolvedFocus.floorPlanId, liveFloorIdSet, locked)) {
      return // the floor switch above hasn't rendered yet
    }
    focusCameraIntentRef.current = null
    // The auto-rotate loop sets the bearing every frame and would cut the flight short.
    if (isAutoRotating) stopAutoRotate()
    // The focus owns the camera from here: the first fit stands down (a
    // fit already under way is cut short by `flyToFocus`'s `map.stop()`).
    // Set only now, so a `?focus=` link that is refused, stale or still
    // waiting for its row keeps the normal first fit.
    fittedRef.current = true
    flyToFocus(overlayMap, resolvedFocus, focusPrisms, {
      mode: intent.mode,
      padding: focusPaddingFor(overlayMap, anyDrawerOpen, isRtl),
      bearing:
        intent.mode !== 'reveal' && intent.floorSwitched && selectedFloorRotation !== null
          ? selectedFloorRotation
          : undefined,
    })
  }, [
    focusCameraNonce,
    overlayMap,
    resolvedFocus,
    selectedFloorPlanIds,
    liveFloorIdSet,
    lockedFloorPlanId,
    focusPrisms,
    anyDrawerOpen,
    isRtl,
    selectedFloorRotation,
    isAutoRotating,
    stopAutoRotate,
  ])

  // Esc leaves focus (a drawer's own Esc closes it first, which also leaves).
  // Map clicks are handled below instead of by the hook's "empty click":
  // in the viewer a click on a floor plate, a hover-only area or a wall
  // focuses nothing, so it counts as empty even though it hits a layer.
  useFocusExit(overlayMap, focusActive, exitFocus, { emptyClick: false })
  // Also live while only a drawer is open (a cluster list): the drawer
  // has no scrim any more, so an unclaimed map click is what closes it.
  const clickExitActive = focusActive || anyDrawerOpen
  useEffect(() => {
    if (!overlayMap || !clickExitActive || routePreviewActive) return
    const container = overlayMap.getCanvasContainer()
    let live = true
    // Snapshot at press time: every focus trigger runs between the press
    // and this click's listeners (overlays register before this one).
    let seqAtPress = focusSeqRef.current
    const onPress = () => {
      seqAtPress = focusSeqRef.current
    }
    const onClick = (e: MapMouseEvent) => {
      queueMicrotask(() => {
        if (!live || focusSeqRef.current !== seqAtPress) return
        const target = (e.originalEvent as Event | undefined)?.target
        if (target instanceof Element && target.closest('.shape-marker,.mapboxgl-popup')) return
        exitFocus()
      })
    }
    container.addEventListener('pointerdown', onPress, true)
    overlayMap.on('click', onClick)
    return () => {
      live = false
      container.removeEventListener('pointerdown', onPress, true)
      overlayMap.off('click', onClick)
    }
  }, [overlayMap, clickExitActive, routePreviewActive, exitFocus])

  // ---- Focus triggers -----------------------------------------------------

  const handlePolygonClick = useStableCallback((id: number) => {
    if (dataLinkClickRef.current) return
    if (polygonTriggerIndex.get(id) === 'click') {
      focusItem({ kind: 'polygons', id }, { camera: 'always', drawer: 'polygon' })
    }
  })
  // Map clicks use camera 'reveal': the item is already on screen, so the
  // camera only pans when the drawer that opens would cover it.
  const handleMarkerClick = useStableCallback((id: number) => {
    focusItem({ kind: 'markers', id }, { camera: 'reveal', drawer: 'marker' })
  })
  const handleTextLabelClick = useStableCallback((id: number) => {
    if (dataLinkClickRef.current) return
    focusItem({ kind: 'text-labels', id }, { camera: 'reveal' })
  })
  const handleDoorClick = useStableCallback((id: number) => {
    if (dataLinkClickRef.current) return
    focusItem({ kind: 'doors', id }, { camera: 'reveal' })
  })
  const handleGridCellClick = useStableCallback((gridId: number, row: number, col: number, level: number) => {
    if (dataLinkClickRef.current || row < 0 || col < 0) return
    focusItem({ kind: 'grids', id: gridId, cell: { row, col, level } }, { camera: 'reveal' })
  })

  // MapShapeTooltip calls this for click-trigger shapes with linked data
  // (and from a hover popup's "View more"). Areas and markers take the
  // click over (drawer); circles / walls / floor plans / models focus but
  // keep their popup. Hover-trigger shapes are never focused from here.
  const clickShapeOverride = useStableCallback(
    (kind: 'polygon' | 'circle' | 'line' | 'marker' | 'image' | 'model', id: number): boolean | void => {
      // A data-link symbol on top of this shape took the click (and no
      // popup should open for the shape under it).
      if (dataLinkClickRef.current) return true
      if (kind === 'polygon') {
        focusItem({ kind: 'polygons', id }, { camera: 'always', drawer: 'polygon' })
        return true
      }
      if (kind === 'marker') {
        focusItem({ kind: 'markers', id }, { camera: 'reveal', drawer: 'marker' })
        return true
      }
      const trigger =
        kind === 'circle'
          ? allCircles.find((c) => c.id === id)?.config.tooltipTrigger
          : kind === 'line'
            ? allLines.find((l) => l.id === id)?.config.tooltipTrigger
            : kind === 'image'
              ? allImages.find((img) => img.id === id)?.config.tooltipTrigger
              : allModels.find((m) => m.id === id)?.config.tooltipTrigger
      if (trigger !== 'click') return
      const focusKind = FOCUS_KIND_OF_BINDING[kind]
      if (focusKind) focusItem({ kind: focusKind, id }, { camera: 'reveal' })
      return
    },
  )

  // The popup's "View more" — one identity for the page's lifetime, so
  // the data-link overlay's tooltip context doesn't change every render.
  // The row's anchor comes from the overlay (`onDlAnchor`).
  const onDataLinkViewMore = useStableCallback(
    (
      cfg: DataLinkConfig,
      payload: Record<string, unknown>,
      _lngLat: { lng: number; lat: number },
      entityKey?: string,
    ) => focusDataLinkEntity(cfg, payload, entityKey, { camera: 'reveal' }),
  )

  // Layers pill → "Show on map".
  const handleFocusLayerItem = useStableCallback((kind: ShapeLayerKind, id: number) => {
    const target: FocusTarget | null =
      kind === 'bins' ? focusTargetForBin(allBins.find((b) => b.id === id)) : { kind: FOCUS_KIND_OF_LAYER[kind], id }
    if (!target) {
      toast.info(t('view.focus.notFound', { defaultValue: 'That item is no longer on this map.' }))
      return
    }
    focusItem(target, { camera: 'always', drawer: drawerForFocusKind(target.kind) })
  })
  const handleFocusDataLinkItem = useStableCallback((cfg: DataLinkConfig, entity: EntityState) => {
    focusDataLinkEntity(cfg, entity.payload, entity.entityKey, { camera: 'always' })
  })

  // Viewer search → focus.
  const handleSearchPick = useStableCallback((r: SearchResult) => {
    const target: FocusTarget | null =
      r.kind === 'rack'
        ? r.grid.id !== undefined
          ? { kind: 'grids', id: r.grid.id }
          : null
        : r.kind === 'bin'
          ? focusTargetForBin(r.bin)
          : r.kind === 'marker'
            ? r.marker.id !== undefined
              ? { kind: 'markers', id: r.marker.id }
              : null
            : r.model.id !== undefined
              ? { kind: 'models', id: r.model.id }
              : null
    if (!target) {
      toast.info(t('view.focus.notFound', { defaultValue: 'That item is no longer on this map.' }))
      return
    }
    focusItem(target, { camera: 'always', drawer: drawerForFocusKind(target.kind) })
  })

  // What the search may offer: only kinds the share link shows, and on a
  // floor-locked link only that floor's rows.
  const inLinkFloor = useCallback(
    <T extends { floorPlanId?: number }>(rows: readonly T[]): readonly T[] =>
      typeof lockedFloorPlanId === 'number'
        ? rows.filter((r) => r.floorPlanId === undefined || r.floorPlanId === lockedFloorPlanId)
        : rows,
    [lockedFloorPlanId],
  )
  const searchGrids = useMemo(
    () => (layerVisible('racks') ? inLinkFloor(allGrids) : []),
    [layerVisible, inLinkFloor, allGrids],
  )
  const searchBins = useMemo(() => {
    if (!layerVisible('racks')) return []
    if (typeof lockedFloorPlanId !== 'number') return allBins
    return allBins.filter((b) => {
      if (b.gridId === undefined) return true
      const floor = gridFloorIndex.get(b.gridId)
      return floor === undefined || floor === lockedFloorPlanId
    })
  }, [layerVisible, lockedFloorPlanId, allBins, gridFloorIndex])
  const searchMarkers = useMemo(
    () => (layerVisible('markers') ? inLinkFloor(allMarkers) : []),
    [layerVisible, inLinkFloor, allMarkers],
  )
  const searchModels = useMemo(
    () => (layerVisible('models') ? inLinkFloor(allModels) : []),
    [layerVisible, inLinkFloor, allModels],
  )

  // ---- `?focus=` share / deep link ---------------------------------------
  // `/view/:id?focus=markers:12` and `/share/:token?focus=dl:343:<key>` open
  // the facility focused. Applied once per facility + param, after the
  // data, the first floor pick and (share links) the link's own settings.
  // The first fit is NOT skipped here: the focus camera effect takes the
  // camera over only when it actually moves to the item, so a link that is
  // refused, stale or still waiting for its row still gets framed. Once
  // applied, the param leaves the URL as soon as the focus moves off its
  // item (`releaseFocusParam`); a refused or unreadable link leaves at once.
  const focusParamEntityKind = focusParamTarget ? ENTITY_KIND_OF_FOCUS[focusParamTarget.kind] : null
  const focusParamKindLoaded = useSpatialStore((st) =>
    focusParamEntityKind === null ? true : st.loadedFor[focusParamEntityKind] === warehouseIdNum,
  )
  const focusParamReady =
    !isAuthMode ||
    (focusParamTarget?.kind === 'doors' ? doorsLoadedFor === warehouseIdNum : focusParamKindLoaded)
  useEffect(() => {
    if (focusParamTag === '') {
      // Gone from the URL (exit, or navigated away): the same link pasted
      // again applies again.
      appliedFocusParamRef.current = null
      return
    }
    if (appliedFocusParamRef.current === focusParamTag) return
    if (viewerLoading || !focusParamReady) return
    if (floorPlanIdsKey !== '' && !floorInitializedRef.current) return
    if (shareTokenForLookup && shareSettings && appliedSettingsForTokenRef.current !== shareTokenForLookup) return
    appliedFocusParamRef.current = focusParamTag
    if (!focusParamTarget) {
      toast.info(t('view.focus.notFound', { defaultValue: 'That item is no longer on this map.' }))
      dropFocusParam()
      return
    }
    if (!focusItem(focusParamTarget, { camera: 'always', drawer: drawerForFocusKind(focusParamTarget.kind) })) {
      dropFocusParam() // refused (toast shown): a reload would only refuse it again
    }
  }, [
    focusParamTag,
    focusParamTarget,
    focusParamReady,
    viewerLoading,
    floorPlanIdsKey,
    shareTokenForLookup,
    shareSettings,
    focusItem,
    dropFocusParam,
    t,
  ])

  // ---- Focus chip ---------------------------------------------------------
  const focusChipKind =
    focusTarget === null ? '' : focusTarget.kind === 'grids' && focusTarget.cell ? 'cell' : focusTarget.kind
  const focusChipName = useMemo(() => {
    const tgt = focusTarget
    if (!tgt) return ''
    const nameIn = (rows: ReadonlyArray<{ id?: number; name?: string }>, rowId: number) =>
      rows.find((r) => r.id === rowId)?.name ?? ''
    switch (tgt.kind) {
      case 'dl':
        return focusLabel || tgt.entityKey
      case 'markers':
        return nameIn(allMarkers, tgt.id)
      case 'polygons':
        return nameIn(allPolygons, tgt.id)
      case 'circles':
        return nameIn(allCircles, tgt.id)
      case 'lines':
        return nameIn(allLines, tgt.id)
      case 'stairs':
        return nameIn(allStairs, tgt.id)
      case 'images':
        return nameIn(allImages, tgt.id)
      case 'image-planes':
        return nameIn(allImagePlanes, tgt.id)
      case 'models':
        return nameIn(allModels, tgt.id)
      case 'doors':
        return nameIn(allDoors, tgt.id)
      case 'text-labels':
        return textLabelName(allTextLabels.find((l) => l.id === tgt.id))
      case 'grids': {
        const gridName = nameIn(allGrids, tgt.id)
        const cell = tgt.cell
        if (!cell) return gridName
        const bin = allBins.find(
          (b) =>
            b.targetKind === 'grid-cell' &&
            b.gridId === tgt.id &&
            b.row === cell.row &&
            b.col === cell.col &&
            (b.level ?? 0) === cell.level,
        )
        return bin?.sku || bin?.externalCode || `${gridName ? `${gridName} · ` : ''}${cell.row},${cell.col}`
      }
    }
    return ''
  }, [
    focusTarget,
    focusLabel,
    allMarkers,
    allPolygons,
    allCircles,
    allLines,
    allStairs,
    allImages,
    allImagePlanes,
    allModels,
    allDoors,
    allTextLabels,
    allGrids,
    allBins,
  ])
  const copyFocusLink = useStableCallback(async () => {
    if (!focusTarget) return
    const url = `${window.location.origin}${window.location.pathname}?focus=${encodeURIComponent(formatFocusParam(focusTarget))}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('view.focus.linkCopied', { defaultValue: 'Link copied' }))
    } catch {
      /* clipboard blocked (insecure context / permission) — nothing to copy into */
    }
  })

  // Picking the shell-only view leaves focus: the interior it points into is hidden.
  const changeShellMode = useStableCallback((next: 'auto' | 'shell-only' | 'interior-only') => {
    if (next === 'shell-only') exitFocus()
    setShellMode(next)
  })

  // Drawer clicks on the map switch focus instead of closing the drawer.
  const isMapEventTarget = useCallback(
    (target: EventTarget | null) =>
      !!mapInstance && target instanceof Node && mapInstance.getContainer().contains(target),
    [mapInstance],
  )

  // Click on a data-link widget (sensor / camera / asset — any layer
  // whose id starts with `dl-{configId}-`) focuses that row and opens
  // its drawer (`focusDataLinkEntity`). A cluster opens the drawer in
  // list mode; picking a row there focuses it (`handleSelectClusterItem`).
  const handleDataLinkMapClick = useStableCallback((e: MapMouseEvent) => {
    const map = mapInstance
    if (!map) return
    let hits: Array<{
      layer?: { id?: string; source?: string }
      properties?: Record<string, unknown> | null
      geometry?: GeoJSON.Geometry | null
      source?: string
    }>
    // Query the data-link layers only. Unfiltered, every click
    // hit-tested every rendered layer (the stadium's ~50k seat
    // extrusions included) just to skip the non-`dl-` hits below.
    // Same hits, same top-down order, for the layers that matter.
    const dlLayerIds = rootLayerOrder(map).filter(
      (layerId) => layerId.startsWith('dl-') && hasMapLayer(map, layerId),
    )
    if (dlLayerIds.length === 0) return
    try {
      hits = map.queryRenderedFeatures(e.point, { layers: dlLayerIds }) as typeof hits
    } catch {
      return
    }
    for (const hit of hits) {
      const layerId = hit.layer?.id
      if (typeof layerId !== 'string' || !layerId.startsWith('dl-')) continue
      const rest = layerId.slice('dl-'.length)
      const dash = rest.indexOf('-')
      const configId = Number(dash === -1 ? rest : rest.slice(0, dash))
      if (!Number.isFinite(configId)) continue
      const cfg = warehouseConfigs.find((c) => c.id === configId)
      if (!cfg || cfg.id === undefined) continue
      // Claim the click on both event flavours (the overlays' protocol),
      // so the shape handlers that run after this one bail.
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      dataLinkClickRef.current = true
      queueMicrotask(() => {
        dataLinkClickRef.current = false
      })
      // Claimed: whatever opens below (possibly after an async leaf
      // fetch), this click must not count as an empty one.
      focusSeqRef.current += 1

      // Cluster hit — a `-cluster` or `-cluster-count` layer carries
      // `{cluster: true, cluster_id, point_count}` properties for
      // native Mapbox clusters, OR `{manualCluster: true, groupKey,
      // point_count}` for our room-aware manual clusters. Both
      // paths open the drawer in list mode; only how we fetch the
      // leaves differs. The individual-item detail rendered when
      // the user clicks a row is identical.
      const isCluster = /-cluster(-count)?$/.test(layerId)
      if (isCluster) {
        const props = hit.properties ?? {}
        const pointCount =
          typeof props['point_count'] === 'number'
            ? (props['point_count'] as number)
            : Number(props['point_count'] ?? 0) || 0
        const openList = (
          leaves: Array<{
            properties?: Record<string, unknown> | null
            geometry?: GeoJSON.Geometry | null
          }>,
        ) => {
          const items: DlClusterItem[] = []
          for (const leaf of leaves) {
            const leafProps = leaf.properties as Record<string, unknown> | null
            const payload = readFeaturePayload(leafProps)
            const geom = leaf.geometry
            const coords =
              geom && geom.type === 'Point'
                ? (geom.coordinates as [number, number])
                : [0, 0]
            const rawKey = leafProps?.['entityKey']
            items.push({
              payload,
              position: [coords[0], coords[1]],
              entityKey: typeof rawKey === 'string' && rawKey !== '' ? rawKey : undefined,
              anchor: dataLinkAnchorOf(geom, leafProps, dataLinkEntityFloor(payload, cfg, liveFloorIdSet)),
            })
          }
          const assetLabel = t('view.drawer.kind.asset', { defaultValue: 'Asset' })
          showDataLinkDrawerOnly({
            title: `${cfg.name || assetLabel} · ${pointCount || items.length}`,
            kindLabel: cfg.name || assetLabel,
            accentColor: cfg.style?.defaultColor,
            clusterItems: items,
            panelFields: cfg.tooltip.panel?.fields ?? cfg.tooltip.fields,
            panelTemplateRaw: cfg.tooltip.panel?.template,
            labelField: cfg.fieldMapping?.labelField,
            configId: cfg.id,
          })
        }
        // Manual cluster path — the aggregate feature carries
        // `manualCluster: true` and its `groupKey` tells us which
        // room to filter the raw feature list on.
        if (props['manualCluster'] === true || props['manualCluster'] === 'true') {
          const groupKey = String(props['groupKey'] ?? '')
          openList(getManualClusterLeaves(configId, groupKey))
          return
        }
        // Native Mapbox cluster path.
        const clusterId =
          typeof props['cluster_id'] === 'number'
            ? (props['cluster_id'] as number)
            : Number(props['cluster_id'])
        const sourceId = hit.layer?.source ?? `dl-${configId}-src`
        const source = map.getSource(sourceId) as
          | (mapboxgl.GeoJSONSource & {
              getClusterLeaves?: (
                clusterId: number,
                limit: number,
                offset: number,
                cb: (err: unknown, features: GeoJSON.Feature[]) => void,
              ) => void
            })
          | undefined
        if (!source?.getClusterLeaves || !Number.isFinite(clusterId)) return
        source.getClusterLeaves(clusterId, 1000, 0, (err, leaves) => {
          if (err || !leaves) {
            console.warn('[view] getClusterLeaves failed', err)
            return
          }
          openList(leaves)
        })
        return
      }

      // One row. Occluded rows are clickable on purpose: they are only
      // drawn (as faint ghosts) when Graphics → "Show hidden items as
      // faint ghosts" is on, and clicking a ghost is how you focus it.
      const payload = readFeaturePayload(hit.properties)
      const rawKey = hit.properties?.['entityKey']
      const entityKey = typeof rawKey === 'string' && rawKey !== '' ? rawKey : undefined
      const anchor = dataLinkAnchorOf(
        hit.geometry,
        hit.properties,
        dataLinkEntityFloor(payload, cfg, liveFloorIdSet),
      )
      focusDataLinkEntity(cfg, payload, entityKey, { camera: 'reveal', anchor })
      return
    }
  })
  useEffect(() => {
    if (!mapInstance) return
    mapInstance.on('click', handleDataLinkMapClick)
    return () => {
      mapInstance.off('click', handleDataLinkMapClick)
    }
  }, [mapInstance, handleDataLinkMapClick])

  // A cluster row → focus it (the drawer stays in the cluster's list
  // mode, so "Back to list" still works).
  const handleSelectClusterItem = useStableCallback((item: DlClusterItem) => {
    const current = dlEntityDrawer
    if (!current) return
    const payload = item.payload
    // Apply the same content-viewer filter/order as the top-level
    // click path so drilling into a cluster leaf renders the same
    // set of configured fields. Fills empty/null/undefined values
    // with an em-dash so classifyBin (which drops nullish + empty
    // strings from its custom list) keeps every configured field
    // visible — matches the intent that "if I added it to the
    // sidebar it should always show, with — when there's no data."
    const panelFields = current.panelFields
    let customProperties: Record<string, unknown> = payload
    if (panelFields && panelFields.length > 0) {
      const ordered: Record<string, unknown> = {}
      for (const path of panelFields) {
        const raw = readPayloadPath(payload, path)
        const shortKey = path.split('.').pop() ?? path
        const key = shortKey in ordered ? path : shortKey
        if (
          raw === undefined ||
          raw === null ||
          (typeof raw === 'string' && raw.trim() === '')
        ) {
          ordered[key] = '—'
        } else {
          ordered[key] = raw
        }
      }
      customProperties = ordered
    }
    const header = current.panelTemplateRaw
      ? resolveLabelTemplate(current.panelTemplateRaw, payload)
      : undefined
    const next: DlEntityDrawerState = {
      ...current,
      // Keep the cluster snapshot around so the "Back to list"
      // control can flip us home.
      bin: {
        targetKind: 'polygon',
        customProperties,
        updatedAt: new Date(),
      } as Bin,
      panelHeader: header,
    }
    const cfg = current.configId !== undefined ? warehouseConfigs.find((c) => c.id === current.configId) : undefined
    if (!cfg || cfg.id === undefined || !item.entityKey) {
      setDlEntityDrawer(next)
      return
    }
    // The row was on screen inside its cluster: only move the camera when
    // the drawer covers it or something hides it.
    focusItem(
      item.anchor
        ? { kind: 'dl', configId: cfg.id, entityKey: item.entityKey, anchor: item.anchor }
        : { kind: 'dl', configId: cfg.id, entityKey: item.entityKey },
      { camera: 'ifNeeded', dlDrawer: next, label: dataLinkLabelOf(cfg, payload, item.entityKey) },
    )
  })
  const handleBackToCluster = useStableCallback(() => {
    const current = dlEntityDrawer
    if (!current) return
    clearFocusOnly()
    setDlEntityDrawer({ ...current, bin: undefined })
  })

  const committedLines = useMemo<CommittedLine[]>(
    () =>
      grids
        .filter((g): g is Grid & { id: number } => g.id !== undefined)
        .map((g) => ({ id: g.id, start: g.start, current: g.current, config: g.config, visible: g.visible })),
    [grids],
  )

  return (
    // A share link is the whole window; inside the app shell the viewer fills
    // <main> (as the editor does) — viewport-sized there, it overflowed <main>
    // by the sidebar's width and the top bar's height and scrolled both ways.
    <div className={mode === 'token' ? 'relative h-dvh w-dvw overflow-hidden bg-background' : 'absolute inset-0 overflow-clip bg-background'}>
      <MapboxMap
        onMapLoad={setMapInstance}
        onMapDestroy={() => setMapInstance(null)}
        styleId={mapStyle}
        busy={viewerLoading}
        busyLabel={t('view.loadState.loading', { defaultValue: 'Loading facility…' })}
      />
      {loadError && <ViewerLoadError tokenMode={mode === 'token'} onRetry={() => window.location.reload()} />}

      {/*
       * Fragment key intentionally does NOT include `loadedStyleId`
       * — the `overlayMap` gate (null while a new style is loading,
       * non-null once it's ready) already tells each child overlay
       * when to clean up + re-add its Mapbox layers. Keying on
       * loadedStyleId as well would REMOUNT the whole Fragment on
       * every style swap, adding its layers AFTER the always-mounted
       * image-plane + door overlays outside this block, and pushing
       * polygons / walls on top of them. Match the editor pattern
       * (create-grids OverlayStack Fragment key = layerOrder only).
       *
       * The two focus providers are ALWAYS rendered (FOCUS_OFF /
       * NO_BLOCKERS while nothing is focused) so toggling focus never
       * changes this tree's shape — no overlay remounts.
       */}
      <FocusSceneContext.Provider value={focusScene}>
      <FocusBlockersContext.Provider value={focusBlockers}>
      <Fragment key={DEFAULT_LAYER_ORDER.join('-')}>
        {DEFAULT_LAYER_ORDER.map((kind: ReorderableLayerKind) => {
          // v5.5 — in shell-only mode ONLY the shell model paints; every
          // interior overlay (images, grids, circles, polygons, lines,
          // stairs, image-planes) unmounts so its Mapbox layers tear down.
          // The shape-kind switch still runs for `model` so the shell
          // itself keeps rendering.
          if (shellHidesInterior && kind !== 'model') return null
          switch (kind) {
            case 'image':
              if (!layerVisible('images') || !isShapeKindVisible('images')) return null
              return <MapImageOverlay key="image" map={overlayMap} images={images} wallLines={allLines} />
            case 'grid':
              if (!layerVisible('racks') || !isShapeKindVisible('grids')) return null
              return (
                <MapGridOverlay
                  key="grid"
                  map={overlayMap}
                  bbox={null}
                  line={null}
                  committedLines={committedLines}
                  config={grids[0]?.config ?? SIDE_PANEL_DEFAULT_CONFIG}
                  cellStyleOverrides={
                    resolvedStyles.gridCells.size > 0
                      ? resolvedStyles.gridCells
                      : null
                  }
                  selectedGridIds={focusSelectedIds('grids')}
                  // A bin (rack cell) click focuses that cell.
                  onCellClick={handleGridCellClick}
                  // v5.5 — rack labels fade behind floor plates,
                  // walls, and OTHER rack cells (a rear rack hides
                  // the label of a rack behind it). Same layer
                  // gating as marker/text overlays.
                  occluders={{
                    images:
                      layerVisible('images') && isShapeKindVisible('images')
                        ? images
                        : undefined,
                    polygons:
                      layerVisible('polygons') && isShapeKindVisible('polygons')
                        ? polygons
                        : undefined,
                    circles:
                      layerVisible('circles') && isShapeKindVisible('circles')
                        ? circles
                        : undefined,
                    lines:
                      layerVisible('lines') && isShapeKindVisible('lines')
                        ? lines
                        : undefined,
                    stairs:
                      layerVisible('stairs') && isShapeKindVisible('stairs')
                        ? stairs
                        : undefined,
                    grids: grids,
                  }}
                />
              )
            case 'circle':
              return (
                <MapCircleOverlay
                  key="circle"
                  map={overlayMap}
                  circles={circles}
                  committedVisible={layerVisible('circles') && isShapeKindVisible('circles')}
                  selectedCircleIds={focusSelectedIds('circles')}
                />
              )
            case 'polygon':
              if (!layerVisible('polygons') || !isShapeKindVisible('polygons')) return null
              return (
                <MapPolygonOverlay
                  key="polygon"
                  map={overlayMap}
                  polygons={polygons}
                  onPolygonClick={handlePolygonClick}
                  selectedPolygonIds={selectedPolygonIds}
                />
              )
            case 'line':
              if (!layerVisible('lines')) return null
              return (
                <MapLineOverlay
                  key="line"
                  map={overlayMap}
                  lines={lines}
                  attachedDoorsByLineId={
                    layerVisible('doors') && attachedDoorsByLineId.size > 0
                      ? attachedDoorsByLineId
                      : null
                  }
                  selectedLineIds={focusSelectedIds('lines')}
                />
              )
            case 'stair':
              if (!layerVisible('stairs') || !isShapeKindVisible('stairs')) return null
              return (
                <MapStairOverlay
                  key="stair"
                  map={overlayMap}
                  stairs={stairs}
                  floorElevations={floorElevations}
                  selectedStairIds={focusSelectedIds('stairs')}
                />
              )
            case 'model':
              if (!layerVisible('models') || !isShapeKindVisible('models')) return null
              return (
                <MapModelOverlay
                  key="model"
                  map={overlayMap}
                  models={models}
                  urlMap={modelUrlMap}
                  boundingCenterMap={modelBoundingCenters}
                  boundsMap={modelBounds}
                  facilityShellMode={shellMode}
                  selectedModelIds={focusSelectedIds('models')}
                />
              )
            case 'imagePlane':
              return null
          }
          return null
        })}
      </Fragment>

      {/*
       * Image-planes + doors both intentionally use `committedVisible`
       * (always mounted) instead of conditional rendering. When
       * either was wrapped in `{layerVisible('X') && …}`, toggling
       * off + on unmounted the overlay and re-added its Mapbox
       * layers at the top of the stack — image-planes ended up under
       * polygons (store logos hidden), doors lost their arc/leaf
       * visuals when they remounted after a wall. Keeping both
       * always-mounted preserves the editor's stable mount order:
       *   OverlayStack (image → … → model) → image-plane → door → …
       * so image-planes always sit above polygons and doors always
       * sit above image-planes. The visibility toggles below flip
       * Mapbox layer `visibility: 'visible' | 'none'` without
       * re-adding layers.
       */}
      {/* v5.5 — image-planes and doors are otherwise always mounted
          (see the block comment above about layer-order); in shell-only
          mode we still need to force them off. Passing `committedVisible:
          false` in that mode flips their Mapbox layers to visibility=none
          without a full remount, preserving the stable stack order for
          when the viewer flips back to auto/interior. */}
      <MapFloorBaseOverlay map={overlayMap} input={floorBaseInput} />
      <MapImagePlaneOverlay
        map={overlayMap}
        imagePlanes={imagePlanes}
        committedVisible={
          !shellHidesInterior &&
          layerVisible('imagePlanes') &&
          isShapeKindVisible('imagePlanes')
        }
        selectedImagePlaneIds={focusSelectedIds('image-planes')}
      />
      {routePreviewActive && (
        <>
          <MapRoutePreviewOverlay
            map={overlayMap}
            start={routePreview.start}
            end={routePreview.end}
            option={routePreview.options[routePreview.selected] ?? null}
            status={routePreview.status}
            floors={routePreview.floors}
            elevatedPolygons={routePreview.elevatedPolygons}
            portalLabel={routePortalLabel}
          />
          <RouteDirectionsPanel
            status={routePreview.status}
            options={routePreview.options}
            selected={routePreview.selected}
            onSelect={routePreview.setSelected}
            floors={routePreview.floors}
            onClear={routePreview.reset}
            side="left"
          />
        </>
      )}
      <MapDoorOverlay
        map={overlayMap}
        doors={doors}
        committedVisible={
          !shellHidesInterior &&
          layerVisible('doors') &&
          isShapeKindVisible('doors')
        }
        selectedDoorIds={focusSelectedIds('doors')}
        onDoorClick={handleDoorClick}
        // v5.5 — door labels use the same analytic occlusion pass as
        // text-labels + markers so they stop poking through floor
        // plates, walls, and rack cells at a tilt.
        occluders={visibleOccluders}
      />
      {!shellHidesInterior && layerVisible('markers') && isShapeKindVisible('markers') && (
        <MapMarkerOverlay
          map={overlayMap}
          markers={markers}
          onMarkerClick={handleMarkerClick}
          // Slabs, walls and staircases hide the markers standing behind
          // them. Each kind is gated on its own visibility — geometry the
          // viewer toggled off paints nothing and so must occlude nothing.
          occluders={visibleOccluders}
        />
      )}
      {!shellHidesInterior && layerVisible('bins') && isShapeKindVisible('bins') && (
        <MapBinOverlay map={overlayMap} committedLines={committedLines} bins={bins} visible />
      )}
      {!shellHidesInterior && layerVisible('text') && isShapeKindVisible('textLabels') && (
        <MapTextLabelOverlay
          map={overlayMap}
          labels={textLabels}
          selectedLabelIds={focusSelectedIds('text-labels')}
          onLabelClick={handleTextLabelClick}
          // v5.4 — Same-floor geometry only. Passing `allPolygons` /
          // `allLines` (multi-floor) marked every ground-floor label
          // as occluded in top-down because upper-floor slabs at
          // elevation ~4m sit RIGHT ABOVE ground-floor labels: the
          // vertical camera→label segment crosses the slab's altitude
          // band, and the 2D projection at that altitude is the label
          // point — which sits inside the slab's footprint (labels
          // are inside rooms that stack vertically). Tilting sometimes
          // moved the projection off the slab, which is why labels
          // seemed to appear "randomly on tilt". Restricting to the
          // current floor's shapes matches the editor, which renders
          // one floor at a time. Images are the DRAWN floor plates —
          // multi-floor when several floors are shown (each prism
          // carries `floorPlanId`, so the solver skips the label's own
          // floor plate; see marker-occlusion.ts). Not `allImages`: the
          // viewer force-shows every row, so an unselected upper floor's
          // plan — invisible on screen — hid every label below it.
          occluders={{
            images,
            polygons,
            circles,
            lines,
            stairs,
            grids,
          }}
        />
      )}

      {/*
       * Live data-link widgets — sensors, cameras, assets, etc.
       * Every enabled DataLinkConfig scoped to this warehouse renders
       * its configured render mode (point-at-coord, gauge-on-shape,
       * shape-tint, heatmap, track, fov-cone, roi-pulse, …). The
       * overlay does its own 5s polling + SSE-driven invalidation, so
       * we just have to mount it with the shape catalog + configs +
       * style rules from the spatial store.
       */}
      {/* Live data-link overlay. Enabled for BOTH auth mode AND token
          mode when the /api/v1/public/share/{token} endpoint responded
          — the share endpoint returns the same catalog + configs the
          authed viewer would see (subject to the share link's
          `hiddenDataLinkConfigIds` filter, already applied to
          `visibleConfigs` upstream via `hiddenConfigIds`). Also gated
          by the share link's `layerVisibility.dataLinks` toggle so a
          link can hide live data entirely. */}
      {layerVisible('dataLinks') && !shellHidesInterior && (
        <MapDataLinkedOverlay
          map={overlayMap}
          activeZoneId={Number.isFinite(warehouseIdNum) ? warehouseIdNum : null}
          configs={visibleConfigs}
          enabled={isAuthMode || Boolean(shareResult.data)}
          polygons={allPolygons}
          circles={allCircles}
          markers={allMarkers}
          lines={allLines}
          models={allModels}
          // v5.5 — occluders are the VISIBLE-floor filtered shapes,
          // not the whole zone. Otherwise a first-floor slab at 3.75 m
          // hides ground-floor markers even while the viewer is on
          // ground-floor mode (the slab isn't drawn but still counts
          // as an occluder). Shape-anchor lookup stays on the full
          // zone set via the props above.
          occluderPolygons={polygons}
          occluderCircles={circles}
          occluderLines={lines}
          occluderImages={images}
          occluderStairs={stairs}
          styleRules={activeStyleRules}
          disableTooltips
          activeFloorPlanId={selectedFloorPlanId}
          liveFloorPlanIds={liveFloorPlanIds}
          configFilters={configFilters}
          onEntityViewMore={onDataLinkViewMore}
          pointCluster={mapTools.pointCluster}
          pointHeatmap={pointHeatmap}
        />
      )}

      <MapShapeTooltip
        map={overlayMap}
        enabled={!shellHidesInterior}
        withReferences={false}
        onClickShapeOverride={clickShapeOverride}
        bins={allBins}
        polygons={allPolygons}
        circles={allCircles}
        lines={allLines}
        markers={allMarkers}
        images={allImages}
        models={allModels}
      />

      {/* Focus mode's pulse ring (DOM marker, outside the depth buffer). */}
      <MapFocusOverlay map={overlayMap} focus={shellHidesInterior ? null : resolvedFocus} prisms={focusPrisms} />
      </FocusBlockersContext.Provider>
      </FocusSceneContext.Provider>

      {/* Preview header — only in authenticated preview mode
          (`/view/:warehouseId` from the map-toolbar's Preview button),
          NEVER in share-link mode (`/share/:token`). Shows a back
          button that returns the user to the editor plus the
          warehouse name as a hero card. Matches the visual language
          of the top-end controls (glass card, rounded-full pills). */}
      {isAuthMode && (
        <div className="absolute z-10 flex items-center gap-2 top-4 start-4">
          {/* Below sm the back button is icon-only and the name pill hides:
              the top-end Search sits on the same row there. */}
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 rounded-full border-border/60 bg-background/70 px-2.5 shadow-lg shadow-black/5 backdrop-blur-xl hover:bg-background/90 sm:pl-2 sm:pr-3"
            onClick={() => {
              if (window.history.length > 1) navigate(-1)
              else navigate('/create-grids')
            }}
            title={t('view.header.backToEditor', { defaultValue: 'Back to editor' })}
            aria-label={t('view.header.backToEditor', { defaultValue: 'Back to editor' })}
          >
            <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
            <span className="hidden text-xs font-medium sm:inline">{t('view.header.backToEditor', { defaultValue: 'Back to editor' })}</span>
          </Button>
          <div className="hidden h-9 items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 shadow-lg shadow-black/5 backdrop-blur-xl sm:flex">
            <span
              className="flex items-center justify-center w-5 h-5 rounded-md bg-primary/10 text-primary ring-1 ring-primary/15"
              aria-hidden
            >
              <Eye className="w-3 h-3" />
            </span>
            <span className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">
              {t('toolbar.preview', { defaultValue: 'Preview' })}
            </span>
            {zone?.name && (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span className="max-w-[220px] truncate text-xs font-medium text-foreground">
                  {zone.name}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* The report map's list + key numbers, from this map's own layers. */}
      {showLayersPanel && layerVisible('dataLinks') && !shellHidesInterior && (
        <ViewerItemsPanel
          configs={visibleConfigs}
          activeFloors={selectedFloorPlanId}
          configFilters={configFilters}
          liveFloorPlanIds={liveFloorIdSet}
          styleRules={activeStyleRules}
          focusedKey={focusTarget?.kind === 'dl' ? `${focusTarget.configId}:${focusTarget.entityKey}` : null}
          onFocus={handleFocusDataLinkItem}
        />
      )}

      <div className="sgv-scroll-hide absolute z-10 flex flex-col items-end gap-2 max-h-[calc(100%-2rem)] overflow-y-auto top-4 end-4">
        {/* Search → focus mode (racks, bins, markers, 3D models). Only
            what the share link shows is searchable; a pick in shell-only
            mode drops back to auto (`focusItem`). */}
        {(searchGrids.length > 0 || searchBins.length > 0 || searchMarkers.length > 0 || searchModels.length > 0) && (
          <ViewSearch
            grids={searchGrids}
            bins={searchBins}
            markers={searchMarkers}
            models={searchModels}
            warehouseId={id}
            onPick={handleSearchPick}
          />
        )}
        {showFloorPlanFilter && floorPlans.length > 0 && (
          <FloorSwitcher
            floorPlans={floorPlans}
            selectedIds={selectedFloorPlanIds}
            onSelect={setSelectedFloorPlanIds}
            allowAllFloors={typeof lockedFloorPlanId !== 'number'}
            shellMode={shellMode}
            onShellModeChange={changeShellMode}
            hasFacilityShell={allModels.some(
              (m) => m.config?.facilityShell?.enabled === true,
            )}
          />
        )}
        {showStyleSwitcher && (
          <StyleSwitcher selectedId={mapStyle} onSelect={setMapStyle} />
        )}
        {warehouseConfigs.length > 0 && layerVisible('dataLinks') && mapTools.node}
        {showLayersPanel && (warehouseConfigs.length > 0 || Object.values(shapeLayerItems).some((v) => v.length > 0)) && (
          <ViewerLayersPanel
            shapeItems={shapeLayerItems}
            onFocusItem={handleFocusLayerItem}
            hiddenShapeKinds={hiddenShapeKinds}
            onToggleShapeKind={toggleShapeKind}
            dataLinkConfigs={warehouseConfigs}
            hiddenConfigIds={hiddenConfigIds}
            onToggleDataLinkConfig={toggleConfigVisibility}
            onSetAllDataLinkConfigs={setAllConfigsOfKind}
            onToggleDataLinkEnabled={toggleConfigEnabled}
            activeFilterLabels={activeFilterLabels}
            onZoomToDataLinkItem={handleFocusDataLinkItem}
          />
        )}
        {showDataLinkFilter && (
          <ViewerFilterBar
            configs={visibleConfigs}
            activePresetIds={resolvedPresetIds}
            promptValues={presetPromptValues}
            onApply={applyFilterDraft}
          />
        )}
        {showGraphicsSettings && <ViewerGraphicsPanel />}
      </div>

      {/* Focus chip — what is focused, a link to it, and the way out.
          The ALWAYS-MOUNTED live region around it keeps the chip in the
          accessibility tree while a detail drawer is open: vaul (1.1.2)
          never hands `modal={false}` to Radix, so the drawer runs Radix's
          modal content, whose `hideOthers` sets aria-hidden on everything
          outside it — except `[aria-live]` subtrees that exist when it
          runs. This wrapper is there before any drawer opens, so the chip
          (and its "Show everything" ✕) stays reachable. Keyboard focus is
          still trapped in the drawer by Radix while it is open (Esc and the
          drawer's ✕ leave focus); a pointer reaches the chip as before.
          A plain static block: no box of its own (0 px tall, the chip is
          absolutely placed against the same ancestor as before), nothing
          to hit when empty. */}
      <div aria-live="polite">
        {focusTarget !== null && !shellHidesInterior && (
          <FocusChip
            kindLabel={t(`view.focus.kind.${focusChipKind}`, {
              defaultValue: FOCUS_KIND_FALLBACK[focusChipKind] ?? '',
            })}
            name={focusChipName || t('view.focus.untitled', { defaultValue: 'Selected item' })}
            onCopyLink={() => void copyFocusLink()}
            onExit={exitFocus}
            drawerOpen={anyDrawerOpen}
            belowHeader={isAuthMode}
          />
        )}
      </div>

      {/* v5.4 — history player. Bottom-of-map, video-player-style bar
          that auto-shows when at least one visible layer uses
          renderMode='history-movement'. Positioned outside the
          top-right stack so it can span the map width. */}
      <TableHistoryPlayer configs={visibleConfigs} />
      {followCfg && (follow.playing || follow.paused) && (
        <FollowChip
          label={focusChipName || t('view.focus.untitled', { defaultValue: 'Selected item' })}
          paused={follow.paused}
          onResume={follow.resume}
          style={{ bottom: 132 }}
        />
      )}

      {/* Share-link watermark (settings.watermark). Small pill drawn at
          the bottom-center so it's visible over the map but doesn't
          block interaction. Kiosk / customer share links use this for
          CONFIDENTIAL / customer branding. */}
      {shareWatermark && (
        <div className="absolute bottom-4 start-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full bg-background/80 backdrop-blur border text-xs font-medium text-muted-foreground pointer-events-none max-w-md text-center">
          {shareWatermark}
        </div>
      )}

      {/* Shared-view badge (settings.chrome.showShareBadge). Signals to
          the viewer that they're on a shared, read-only link — with
          the link's optional label for context. Positioned bottom-end
          so it stays out of the way of the top-right controls. */}
      {showShareBadge && shareResult.data && (
        <div className="absolute bottom-4 end-4 z-10 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium border border-primary/20 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          <span>Shared view{shareLinkLabel ? ` — ${shareLinkLabel}` : ''}</span>
        </div>
      )}

      {/* Navigate — end-user routing tool. Click A on the map, click
          B, and the same routing pipeline the editor uses draws a
          wall-avoiding path + shows a turn-by-turn directions panel.
          Bottom-start position so it stays out of the way of the
          layers/style controls at top-end and doesn't collide with
          the share-badge at bottom-end. */}
      <div className="absolute z-10 bottom-4 start-4 flex flex-col items-start gap-2 pointer-events-auto">
        <Button
          variant={routePreviewActive ? 'default' : 'outline'}
          size="sm"
          onClick={() => setRoutePreviewActive((v) => !v)}
          className={cn(
            'h-10 gap-1.5 rounded-full px-4 shadow-lg shadow-black/10 backdrop-blur-xl',
            routePreviewActive
              ? 'bg-emerald-500 hover:bg-emerald-500/90 text-white ring-1 ring-emerald-500/40'
              : 'bg-background/85 hover:bg-background border-border/60',
          )}
          title={routePreviewActive ? 'Stop navigating' : 'Get directions between two points'}
          aria-pressed={routePreviewActive}
        >
          <Navigation className={cn('w-4 h-4', routePreviewActive && 'text-white')} />
          <span className="text-xs font-medium">
            {routePreviewActive ? 'Stop navigating' : 'Navigate'}
          </span>
        </Button>
        {/* Auto-rotate — slow continuous camera sweep for hands-off
            presentation displays. Same pill treatment as the Navigate
            button above so the two grouped controls read as one unit
            visually. Emerald "active" fill mirrors the Navigate
            active state — one colour meaning throughout the viewer:
            emerald = "this thing is on right now". */}
        <Button
          variant={isAutoRotating ? 'default' : 'outline'}
          size="sm"
          onClick={toggleAutoRotate}
          className={cn(
            'h-10 gap-1.5 rounded-full px-4 shadow-lg shadow-black/10 backdrop-blur-xl',
            isAutoRotating
              ? 'bg-emerald-500 hover:bg-emerald-500/90 text-white ring-1 ring-emerald-500/40'
              : 'bg-background/85 hover:bg-background border-border/60',
          )}
          title={isAutoRotating ? 'Stop auto-rotate' : 'Auto-rotate map view'}
          aria-pressed={isAutoRotating}
        >
          <RotateCw
            className={cn('w-4 h-4', isAutoRotating && 'text-white animate-spin')}
            // Slow ~4 s spin — same treatment the toolbar rotate icon
            // uses in the editor so the two surfaces feel identical.
            style={isAutoRotating ? { animationDuration: '4s' } : undefined}
          />
          <span className="text-xs font-medium">
            {isAutoRotating ? 'Stop rotate' : 'Auto-rotate'}
          </span>
        </Button>
      </div>

      {/* Global full-screen loader for data-link fetches. Overlays the
          map with a backdrop + spinner while any layer's query is in
          flight past a 200 ms grace window. Sits above the map but
          below dialogs (z-30) so drawers etc. still float. */}
      <DataLinkFullScreenLoader />

      <ShapeDetailDrawer
        name={drawerPolygon?.name}
        accentColor={drawerPolygon?.config.color}
        kindLabel={t('view.drawer.kind.area', { defaultValue: 'Area' })}
        fallbackId={drawerPolygon?.id}
        bin={drawerBin}
        open={drawerPolygonId !== null}
        onClose={exitFocus}
        isMapEventTarget={isMapEventTarget}
      />

      <ShapeDetailDrawer
        name={drawerMarker?.name}
        accentColor={drawerMarker?.config.iconColor}
        kindLabel={t('view.drawer.kind.marker', { defaultValue: 'Marker' })}
        fallbackId={drawerMarker?.id}
        bin={drawerMarkerBin}
        open={drawerMarkerId !== null}
        onClose={exitFocus}
        isMapEventTarget={isMapEventTarget}
      />

      <ShapeDetailDrawer
        name={dlEntityDrawer?.title}
        accentColor={dlEntityDrawer?.accentColor}
        kindLabel={dlEntityDrawer?.kindLabel ?? t('view.drawer.kind.widget', { defaultValue: 'Widget' })}
        fallbackId={undefined}
        bin={dlEntityDrawer?.bin}
        clusterItems={dlEntityDrawer?.clusterItems}
        clusterLabelField={dlEntityDrawer?.labelField}
        panelHeader={dlEntityDrawer?.panelHeader}
        historySourceId={dlEntityDrawer?.sourceId}
        historyEntityKey={dlEntityDrawer?.entityKey}
        onSelectClusterItem={handleSelectClusterItem}
        onBackToCluster={handleBackToCluster}
        open={dlEntityDrawer !== null}
        onClose={exitFocus}
        isMapEventTarget={isMapEventTarget}
      />

      {/* The app shell's toaster isn't mounted on public share links. */}
      {mode === 'token' && <Toaster />}
    </div>
  )
}

/**
 * Focus mode's chip: what is focused, a copy-link button for it, and the
 * way out (✕, or Esc).
 *
 * From `sm` up it sits at the top, centred in the map's FREE area: a
 * wrapper spans the map from its start edge to its end edge — or to the
 * open drawer's edge + 16 px (the drawer is 420 / 460 / 500 px and always
 * on the logical end side, so logical insets work in both directions) —
 * and the chip is centred in it, never wider than the wrapper. With no
 * drawer the top-end control stack shares the row, so the chip is capped
 * at the wrapper minus room for the stack on both sides. The wrapper is
 * placed like the other map chrome (against the app shell's <main> on
 * /view, the page on /share — not the viewport), so the app sidebar never
 * clips it. Below the signed-in preview header. On phones the stack fills
 * the top-end corner and the drawer covers the map, so the chip sits
 * full-width above the bottom-start Navigate / Auto-rotate pills instead.
 */
function FocusChip({
  kindLabel,
  name,
  onCopyLink,
  onExit,
  drawerOpen,
  belowHeader,
}: {
  kindLabel: string
  name: string
  onCopyLink: () => void
  onExit: () => void
  drawerOpen: boolean
  /** The signed-in preview header holds the top-start corner. */
  belowHeader: boolean
}) {
  const { t } = useTranslation()
  const title = t('view.focus.title', { name, defaultValue: 'Showing {{name}}' })
  const copyLabel = t('view.focus.copyLink', { defaultValue: 'Copy link to this item' })
  const exitLabel = t('view.focus.exit', { defaultValue: 'Show everything' })
  // Literal class strings (Tailwind can't see composed ones).
  return (
    <div
      className={cn(
        'pointer-events-none absolute z-20 flex justify-center',
        'inset-x-4 bottom-[7.5rem]',
        'sm:bottom-auto',
        belowHeader ? 'sm:top-16' : 'sm:top-4',
        drawerOpen && 'sm:end-[436px] md:end-[476px] lg:end-[516px]',
      )}
    >
      {/* Announced by the host's always-mounted live region around the chip. */}
      <span className="sr-only">{title}</span>
      <div
        role="group"
        aria-label={title}
        className={cn(
          'pointer-events-auto flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-background/80 ps-3 pe-1 shadow-lg shadow-black/5 backdrop-blur-xl',
          drawerOpen ? 'sm:max-w-[min(28rem,100%)]' : 'sm:max-w-[min(28rem,calc(100%-27rem))]',
        )}
      >
        <span className="relative flex h-2 w-2 flex-shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-primary/60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
          {kindLabel}
        </span>
        <span className="text-muted-foreground/60" aria-hidden>
          ·
        </span>
        <span className="min-w-0 truncate text-xs font-medium text-foreground" title={name}>
          {name}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ms-0.5 h-7 w-7 flex-shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onCopyLink}
          aria-label={copyLabel}
          title={copyLabel}
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <kbd
          className="hidden h-5 flex-shrink-0 items-center rounded border border-border/60 bg-muted px-1.5 font-mono text-[10px] leading-none text-muted-foreground md:inline-flex"
          aria-hidden
        >
          {t('view.focus.escHint', { defaultValue: 'Esc' })}
        </kbd>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 flex-shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onExit}
          aria-label={exitLabel}
          title={exitLabel}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  )
}

function ShapeDetailDrawer({
  name,
  accentColor,
  kindLabel,
  fallbackId,
  bin,
  clusterItems,
  clusterLabelField,
  onSelectClusterItem,
  onBackToCluster,
  open,
  onClose,
  panelHeader,
  historySourceId,
  historyEntityKey,
  isMapEventTarget,
}: {
  name: string | undefined
  accentColor: string | undefined
  kindLabel: string
  fallbackId: number | undefined
  bin: Bin | undefined
  /**
   * When set, the drawer opens in cluster-list mode: a scrollable list
   * of the leaves. Each entry is clickable and calls
   * `onSelectClusterItem(payload)` — the parent responds by populating
   * `bin` so the drawer flips to detail mode. `onBackToCluster` lets
   * the user return to the list without closing the drawer.
   */
  clusterItems?: ReadonlyArray<DlClusterItem>
  /** v4 — payload path chosen by the layer as its main label (e.g.
   *  `sku`). Used to title each entry in the cluster-list mode so users
   *  see the identifier they picked, not a hardcoded fallback. */
  clusterLabelField?: string
  onSelectClusterItem?: (item: DlClusterItem) => void
  onBackToCluster?: () => void
  open: boolean
  onClose: () => void
  /** v4 — resolved template from `config.tooltip.panel.template` shown
   *  above the field grid. Optional; the drawer keeps its default
   *  layout when this is unset. */
  panelHeader?: string
  /** v5.4 — table source id + entity key for the History section. Both
   *  must be set for the section to render; a streaming entity has no
   *  `data_source_row_events` trail. */
  historySourceId?: number
  historyEntityKey?: string
  /**
   * The drawer is non-modal (focus mode keeps the map live beside it):
   * an outside interaction on the map must never close it — a map click
   * switches focus, or leaves it through `onClose`'s owner.
   */
  isMapEventTarget?: (target: EventTarget | null) => boolean
}) {
  const inClusterMode = (clusterItems?.length ?? 0) > 0 && !bin
  const classified = useMemo(() => (bin ? classifyBin(bin) : null), [bin])
  const images = useMemo(
    () => classified?.media.filter((m) => m.kind === 'image') ?? [],
    [classified],
  )
  const videos = useMemo(
    () => classified?.media.filter((m) => m.kind === 'video') ?? [],
    [classified],
  )
  // Streams the browser can show play in the Live view section; the rest
  // (RTSP, plain links) stay link tiles.
  const liveStreams = useMemo(
    () => (classified?.links ?? []).filter((m) => m.kind === 'stream' && isWatchableStream(m.src)),
    [classified],
  )
  const links = useMemo(
    () => (classified?.links ?? []).filter((m) => !liveStreams.includes(m)),
    [classified, liveStreams],
  )
  const cameraOffline = /^offline$/i.test(String(bin?.customProperties?.['status'] ?? ''))
  const primary = classified?.primary ?? []
  const custom = classified?.custom ?? []

  const headerTitle =
    (bin?.externalCode ||
      bin?.sku ||
      (typeof bin?.customProperties?.['name'] === 'string'
        ? (bin.customProperties['name'] as string)
        : '') ||
      name ||
      (fallbackId !== undefined ? `${kindLabel} #${fallbackId}` : kindLabel)) as string

  const { t, i18n } = useTranslation()
  const isRtl = i18n.dir() === 'rtl'
  const direction: 'left' | 'right' = isRtl ? 'left' : 'right'
  const copyLabel = t('view.drawer.copyIdentifier', { defaultValue: 'Copy identifier' })

  // vaul renders a non-modal drawer on Radix's MODAL dialog, whose layer
  // sets `body { pointer-events: none }`; vaul switches it back only when
  // the drawer opens itself. Opened from here (the `open` prop) the map
  // would stop taking clicks — and a map click is how focus moves on with
  // the drawer open. Same reset vaul does, on our open path (two frames:
  // the dialog layer's effect lands after its node mounts). Radix puts
  // the original value back when the last layer closes.
  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const release = () => {
      if (document.body.style.pointerEvents === 'none') document.body.style.pointerEvents = 'auto'
    }
    let second = 0
    const first = window.requestAnimationFrame(() => {
      release()
      second = window.requestAnimationFrame(release)
    })
    return () => {
      window.cancelAnimationFrame(first)
      window.cancelAnimationFrame(second)
    }
  }, [open])

  const [copiedTitle, setCopiedTitle] = useState(false)
  const copyTitle = async () => {
    try {
      await navigator.clipboard.writeText(headerTitle)
      setCopiedTitle(true)
      setTimeout(() => setCopiedTitle(false), 900)
    } catch {
      /* ignore */
    }
  }

  return (
    <DrawerPrimitive.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
      direction={direction}
      // Non-modal, no scrim: the focused item stays visible and the map
      // stays interactive beside the drawer.
      modal={false}
    >
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Content
          onInteractOutside={(e) => {
            if (isMapEventTarget?.(e.target)) e.preventDefault()
          }}
          className={cn(
            'fixed top-0 bottom-0 z-50 flex flex-col outline-none',
            'w-full sm:w-[420px] md:w-[460px] lg:w-[500px]',
            'bg-background/85 backdrop-blur-2xl',
            // Match side-panel.tsx's custom drop shadow — soft depth
            // + hairline ring in one composite shadow that adapts per
            // theme so it never looks flat against light or dark.
            'shadow-[0_10px_40px_-10px_rgba(0,0,0,0.25),0_0_0_1px_rgba(0,0,0,0.02)]',
            'dark:shadow-[0_10px_40px_-10px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.03)]',
            'ring-1 ring-black/5 dark:ring-white/10',
            // On the logical END side in both directions — the right in
            // LTR, the left in RTL — which is where vaul slides it in from
            // (`direction`) and the side `focusPaddingFor` keeps the
            // focused item clear of.
            'end-0 border-s border-border/60 rounded-s-2xl',
            // No vaul ::after — a 200%-wide copy of the drawer's background
            // beyond its outer edge (drag overshoot). Without a modal scrim,
            // whenever it lands on the map side it washes out and blocks
            // the map (it did in RTL).
            'after:hidden',
          )}
        >
          {/* Header — matches side-panel.tsx's "hero card" treatment:
              gradient wash from primary/10 → transparent, decorative
              dot pattern in the corner, icon chip with ring + primary
              tint, and status pill / copy / close in the trailing
              cluster. The whole block reads as a hero for the selected
              shape. */}
          <div className="relative flex items-start justify-between flex-shrink-0 gap-2 px-5 pt-4 pb-4 border-b border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent overflow-hidden">
            {/* Decorative dot pattern in the far corner — pure CSS,
                uses the primary token so it retints with the palette. */}
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
              {accentColor ? (
                <span
                  className="flex items-center justify-center flex-shrink-0 w-9 h-9 rounded-lg shadow-sm ring-1 ring-black/10 mt-0.5"
                  style={{ backgroundColor: accentColor }}
                  aria-hidden
                />
              ) : (
                <span
                  className="flex items-center justify-center flex-shrink-0 w-9 h-9 rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20 shadow-sm mt-0.5"
                  aria-hidden
                >
                  <Tag className="w-4 h-4" />
                </span>
              )}
              <div className="min-w-0 flex-1 flex flex-col gap-1 pt-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-primary/10 text-primary ring-1 ring-primary/15 text-[10px] uppercase tracking-[0.1em] font-semibold">
                    {kindLabel}
                  </span>
                  {bin?.status && bin.status !== 'empty' && (
                    <StatusBadge status={bin.status} />
                  )}
                </div>
                <DrawerTitle className="text-lg font-semibold leading-tight truncate">
                  {headerTitle}
                </DrawerTitle>
                {/* Always a description (Radix warns without one): the
                    shape's name when the title shows something else,
                    otherwise a screen-reader-only line. */}
                {name && name !== headerTitle ? (
                  <DrawerDescription className="text-xs truncate text-muted-foreground">
                    {name}
                  </DrawerDescription>
                ) : (
                  <DrawerDescription className="sr-only">
                    {t('view.drawer.description', { kind: kindLabel, defaultValue: '{{kind}} details' })}
                  </DrawerDescription>
                )}
              </div>
            </div>
            <div className="relative flex items-center flex-shrink-0 gap-0.5">
              {!inClusterMode && bin && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60"
                  onClick={copyTitle}
                  title={copiedTitle ? t('view.drawer.copied', { defaultValue: 'Copied' }) : copyLabel}
                  aria-label={copyLabel}
                >
                  {copiedTitle ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              )}
              <DrawerClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60"
                  aria-label={t('view.drawer.close', { defaultValue: 'Close' })}
                >
                  <X className="w-4 h-4" />
                </Button>
              </DrawerClose>
            </div>
          </div>

          {/* Hero image — the FIRST detected image renders at full width
              at the top of the drawer so the primary picture (equipment
              photo / patient portrait / staff badge) is the first thing
              a user sees. Additional images fall through to the grid
              below the fields. Only shown in single-item mode. */}
          {!inClusterMode && images.length > 0 && (
            <div className="relative w-full aspect-[16/10] border-b border-border/60 overflow-hidden bg-muted/30">
              <img
                src={images[0].src}
                alt={images[0].label ?? labelFromKey(images[0].sourceKey)}
                className="object-cover w-full h-full"
                loading="eager"
                onError={(e) => {
                  // Broken image URL — hide the container so the drawer
                  // doesn't show a big empty grey rectangle.
                  const el = e.currentTarget as HTMLImageElement
                  el.parentElement?.classList.add('hidden')
                }}
              />
              <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/25 to-transparent pointer-events-none" />
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {/* v4 — Content viewer header. Rendered when the DataLinkConfig
                had `tooltip.panel.template` set. Sits above the field grid
                so the operator's summary reads first. */}
            {!inClusterMode && bin && panelHeader && (
              <div className="p-3 text-sm leading-relaxed border rounded-lg shadow-sm border-border/60 bg-card/50 backdrop-blur-sm whitespace-pre-wrap">
                {panelHeader}
              </div>
            )}
            {inClusterMode && (
              <DrawerSection
                title={t('view.drawer.cluster', {
                  n: clusterItems?.length ?? 0,
                  defaultValue: 'Cluster · {{n}} items',
                })}
                icon={Layers}
              >
                <div className="p-2 space-y-1.5 border rounded-lg shadow-sm border-border/60 bg-card/50 backdrop-blur-sm">
                  {clusterItems?.map((it: DlClusterItem, i: number) => (
                    <ClusterListItem
                      key={`${i}-${String(it.payload.id ?? i)}`}
                      payload={it.payload}
                      labelField={clusterLabelField}
                      onClick={() => onSelectClusterItem?.(it)}
                    />
                  ))}
                </div>
              </DrawerSection>
            )}

            {!inClusterMode && !bin && (
              <div className="px-6 py-12 text-sm text-center border border-dashed rounded-lg border-border/60 bg-card/40 text-muted-foreground">
                {t('view.drawer.noLinkedData', {
                  kind: kindLabel,
                  kindLower: kindLabel.toLowerCase(),
                  defaultValue: 'No linked data for this {{kindLower}}.',
                })}
              </div>
            )}

            {/* Back-to-cluster affordance when the user drilled from a
                cluster list into a single item. Placed at the top of the
                scroll area so it's discoverable without hunting for a
                header icon. */}
            {!inClusterMode && bin && (clusterItems?.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => onBackToCluster?.()}
                className="inline-flex items-center gap-1.5 h-7 px-2 -mt-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                <ChevronLeftIcon className="w-3.5 h-3.5" />
                {t('view.drawer.backToList', {
                  n: clusterItems!.length,
                  defaultValue: 'Back to list ({{n}})',
                })}
              </button>
            )}

            {!inClusterMode && liveStreams.length > 0 && (
              <DrawerSection title={t('view.drawer.section.liveView', { defaultValue: 'Live view' })} icon={Video}>
                <div className="space-y-2">
                  {liveStreams.map((m: MediaItem, i: number) => (
                    <LiveStreamPlayer
                      key={`${m.sourceKey}-${i}`}
                      src={m.src}
                      title={headerTitle}
                      subtitle={typeof bin?.customProperties?.['area'] === 'string' ? (bin.customProperties['area'] as string) : undefined}
                      offline={cameraOffline}
                      className="border border-border/60 shadow-sm"
                    />
                  ))}
                </div>
              </DrawerSection>
            )}

            {/* Additional images (all but the first — that one is
                already the hero above). */}
            {!inClusterMode && images.length > 1 && (
              <DrawerSection title={t('view.drawer.section.media', { defaultValue: 'Media' })} icon={ImageIcon}>
                <div className="grid grid-cols-2 gap-2 p-2 border rounded-lg shadow-sm border-border/60 bg-card/50 backdrop-blur-sm">
                  {images.slice(1).map((m: MediaItem, i: number) => (
                    <a
                      key={`${m.sourceKey}-${i}`}
                      href={m.src}
                      target="_blank"
                      rel="noreferrer"
                      className="group relative overflow-hidden rounded-md border border-border/60 bg-muted/30 aspect-[4/3]"
                    >
                      <img
                        src={m.src}
                        alt={m.label ?? labelFromKey(m.sourceKey)}
                        className="object-cover w-full h-full transition-transform group-hover:scale-105"
                      />
                    </a>
                  ))}
                </div>
              </DrawerSection>
            )}

            {videos.length > 0 && (
              <DrawerSection title={t('view.drawer.section.video', { defaultValue: 'Video' })} icon={Video}>
                <div className="grid grid-cols-1 gap-2 p-2 border rounded-lg shadow-sm border-border/60 bg-card/50 backdrop-blur-sm">
                  {videos.map((m: MediaItem, i: number) => (
                    <video
                      key={`${m.sourceKey}-${i}`}
                      src={m.src}
                      controls
                      className="w-full bg-black border rounded-md border-border/60"
                    />
                  ))}
                </div>
              </DrawerSection>
            )}

            {primary.length > 0 && (
              <DrawerSection title={t('view.drawer.section.details', { defaultValue: 'Details' })} icon={Info}>
                <FieldGridWithDivider>
                  {primary.map((f: PrimaryFieldRow) => (
                    <FieldRow
                      key={f.label}
                      field={{
                        label: f.label,
                        kind: 'text',
                        value: classifyKeyValue(f.label, f.value),
                      }}
                    />
                  ))}
                </FieldGridWithDivider>
              </DrawerSection>
            )}

            {custom.length > 0 && (
              <DrawerSection title={t('view.drawer.section.properties', { defaultValue: 'Properties' })} icon={Braces}>
                <FieldGridWithDivider>
                  {custom.map((c: { key: string; value: unknown }) => (
                    <FieldRow
                      key={c.key}
                      field={{
                        label: labelFromKey(c.key),
                        kind: 'text',
                        value: classifyKeyValue(c.key, c.value),
                      }}
                    />
                  ))}
                </FieldGridWithDivider>
              </DrawerSection>
            )}

            {!inClusterMode &&
              historySourceId !== undefined &&
              historyEntityKey !== undefined && (
                <DrawerSection title={t('view.drawer.section.history', { defaultValue: 'History' })} icon={Clock}>
                  <TableHistoryPanel
                    sourceId={historySourceId}
                    entityKey={historyEntityKey}
                  />
                </DrawerSection>
              )}

            {links.length > 0 && (
              <DrawerSection title={t('view.drawer.section.links', { defaultValue: 'Links' })} icon={Link2}>
                <div className="p-2 space-y-1 border rounded-lg shadow-sm border-border/60 bg-card/50 backdrop-blur-sm">
                  {links.map((l: MediaItem, i: number) => (
                    <a
                      key={`${l.sourceKey}-${i}`}
                      href={l.src}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-center gap-2 rounded-md border border-border/50 bg-background/60 hover:bg-accent hover:border-border transition-colors px-2.5 py-2"
                    >
                      <span
                        className="flex items-center justify-center flex-shrink-0 w-7 h-7 rounded-md bg-primary/10 text-primary ring-1 ring-primary/15"
                        aria-hidden
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </span>
                      <span className="flex-1 min-w-0 text-xs font-medium truncate text-foreground">
                        {l.label ?? labelFromKey(l.sourceKey)}
                      </span>
                      <ChevronRightIcon className="flex-shrink-0 w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
                    </a>
                  ))}
                </div>
              </DrawerSection>
            )}
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  )
}

/**
 * One row of a cluster-expansion list. Renders a thumbnail (first
 * image URL detected in the payload) + a title (id / name / mrn /
 * employeeId — whichever fits) + a short subtitle drawn from
 * status-ish fields. Whole card is clickable and delegates to the
 * parent for the drill-down.
 */
function ClusterListItem({
  payload,
  labelField,
  onClick,
}: {
  payload: Record<string, unknown>
  /** Payload path chosen by the layer's `fieldMapping.labelField`. Wins
   *  over the built-in fallback chain when the field is present + non-
   *  empty, so users see the identifier they configured (sku,
   *  external_code, etc.) instead of a generic "Item" placeholder. */
  labelField?: string
  onClick: () => void
}) {
  const { t } = useTranslation()
  // Pull the first URL-shaped value with a media-hinted key. Uses the
  // same classifier the drawer body relies on so what shows here
  // stays consistent with the hero image below.
  const thumbnail = useMemo(() => {
    for (const [k, v] of Object.entries(payload)) {
      const items = classifyValue(k, v)
      const img = items.find((it: MediaItem) => it.kind === 'image')
      if (img) return img.src
    }
    return null
  }, [payload])

  // 1. Config-driven label field (sku / external_code / …) — the
  //    layer's `fieldMapping.labelField` is authoritative when set.
  //    Falls through to the built-in fallback chain when the payload
  //    has no value for that path.
  const labelFieldValue = labelField
    ? readPayloadPath(payload, labelField)
    : undefined
  const configLabel =
    typeof labelFieldValue === 'string' && labelFieldValue.trim().length > 0
      ? labelFieldValue
      : typeof labelFieldValue === 'number'
        ? String(labelFieldValue)
        : ''

  const title =
    configLabel ||
    (typeof payload['name'] === 'string' && (payload['name'] as string)) ||
    (typeof payload['firstName'] === 'string' && typeof payload['lastName'] === 'string'
      ? `${payload['firstName'] as string} ${payload['lastName'] as string}`
      : '') ||
    (typeof payload['sku'] === 'string' ? (payload['sku'] as string) : '') ||
    (typeof payload['external_code'] === 'string' ? (payload['external_code'] as string) : '') ||
    (typeof payload['entity_key'] === 'string' ? (payload['entity_key'] as string) : '') ||
    (typeof payload['id'] === 'string' ? (payload['id'] as string) : '') ||
    (typeof payload['mrn'] === 'string' ? (payload['mrn'] as string) : '') ||
    (typeof payload['employeeId'] === 'string' ? (payload['employeeId'] as string) : '') ||
    t('view.drawer.item', { defaultValue: 'Item' })

  const subtitleParts: string[] = []
  for (const k of ['type', 'role', 'status', 'condition', 'department']) {
    const v = payload[k]
    if (typeof v === 'string' && v.length > 0) subtitleParts.push(v)
  }
  for (const k of ['currentRoomName', 'roomName']) {
    const v = payload[k]
    if (typeof v === 'string' && v.length > 0) {
      subtitleParts.push(v)
      break
    }
  }
  const subtitle = subtitleParts.slice(0, 3).join(' · ')

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 rounded-md border border-border/50 bg-background/60 hover:bg-accent hover:border-border transition-colors px-2.5 py-2 text-start"
    >
      <div className="flex-shrink-0 w-10 h-10 rounded-md overflow-hidden border border-border/50 bg-muted/40">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'
            }}
          />
        ) : (
          <div className="w-full h-full grid place-items-center text-muted-foreground">
            <ImageIcon className="w-3.5 h-3.5" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate text-foreground">{title}</div>
        {subtitle && (
          <div className="text-[11px] text-muted-foreground truncate">{subtitle}</div>
        )}
      </div>
      <ChevronRightIcon className="flex-shrink-0 w-3.5 h-3.5 text-muted-foreground" />
    </button>
  )
}

/**
 * Section wrapper for the drawer body. Mirrors the visual language of
 * `Section` in `src/components/side-panel.tsx` — the section title
 * renders as a tiny tinted primary chip with a lucide icon + a
 * uppercase small-caps title, so a shape's detail drawer feels like a
 * read-only sibling of the editor's side panel.
 */
function DrawerSection({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        <span
          className="flex items-center justify-center flex-shrink-0 w-4 h-4 rounded bg-primary/10 text-primary ring-1 ring-primary/15"
          aria-hidden
        >
          <Icon className="w-2.5 h-2.5" />
        </span>
        <span className="min-w-0 truncate">{title}</span>
      </div>
      {children}
    </section>
  )
}

function FieldGridWithDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden border rounded-lg shadow-sm border-border/60 bg-card/50 backdrop-blur-sm divide-y divide-border/50">
      {children}
    </div>
  )
}

/** Bin statuses with a translated badge (`view.drawer.status.*`); others show as stored. */
const KNOWN_BIN_STATUSES: ReadonlySet<string> = new Set(['empty', 'occupied', 'reserved'])

function StatusBadge({ status }: { status: 'empty' | 'occupied' | 'reserved' | string }) {
  const { t } = useTranslation()
  const tone =
    status === 'occupied'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25'
      : status === 'reserved'
        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'
        : 'bg-muted text-muted-foreground border-border/60'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em]',
        tone,
      )}
    >
      {KNOWN_BIN_STATUSES.has(status) ? t(`view.drawer.status.${status}`, { defaultValue: status }) : status}
    </span>
  )
}

/**
 * Multi-select floor switcher.
 *
 * `selectedIds`:
 *   • `null` — "All floors": every floor's shapes render.
 *   • `Set<id>` — the checked floors: only those render.
 *
 * "All floors" acts as a toggle that clears the individual picks.
 * Individual floor rows are checkboxes; clicking toggles that floor
 * in the set. Clicking the last selected floor OFF snaps back to
 * "All floors" (so the viewer never renders nothing).
 *
 * The dropdown uses `stopPropagation` on the floor rows so a check
 * doesn't auto-close the menu — that matches Shift-click-friendly
 * multi-select UI everywhere else in the app.
 */
function FloorSwitcher({
  floorPlans,
  selectedIds,
  onSelect,
  allowAllFloors = true,
  shellMode = 'auto',
  onShellModeChange,
  hasFacilityShell = false,
}: {
  floorPlans: ReadonlyArray<ImageShape & { id: number }>
  selectedIds: ReadonlySet<number> | null
  onSelect: (next: ReadonlySet<number> | null) => void
  /**
   * When false, the "All floors" escape hatch at the top of the
   * dropdown is hidden. Set to false for share-link viewers that
   * have been locked to a specific floor via
   * `settings.defaultFloorPlanId` — otherwise viewers can click
   * "All floors" and escape the lock, defeating the whole point
   * of restricting them.
   */
  allowAllFloors?: boolean
  /** v5.5 — facility-shell viewer mode. Chip renders only when
   *  `hasFacilityShell` is true. */
  shellMode?: 'auto' | 'shell-only' | 'interior-only'
  onShellModeChange?: (mode: 'auto' | 'shell-only' | 'interior-only') => void
  hasFacilityShell?: boolean
}) {
  const isAll = selectedIds === null
  const activeLabel = (() => {
    if (shellMode === 'shell-only') return 'Shell'
    if (isAll) return 'All floors'
    const only = selectedIds.size === 1 ? [...selectedIds][0] : undefined
    if (only !== undefined) {
      return (
        floorPlans.find((fp) => fp.id === only)?.name ?? `Floor #${only}`
      )
    }
    return `${selectedIds.size} floors`
  })()

  const toggleFloor = (id: number) => {
    // When starting from "All floors", a click means "just this one"
    // — matches user intent from the pre-v5.4 single-select flow.
    if (isAll) {
      onSelect(new Set([id]))
      return
    }
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    if (next.size === 0) {
      onSelect(null)
      return
    }
    onSelect(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2 rounded-full border-border/60 bg-background/70 pl-3 pr-2.5 shadow-lg shadow-black/5 backdrop-blur-xl hover:bg-background/90"
        >
          <Layers className="h-3.5 w-3.5 text-primary" />
          <span className="max-w-[140px] truncate text-xs font-medium">
            {activeLabel}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-56 shadow-xl rounded-xl border-border/60 bg-popover/90 backdrop-blur-xl"
      >
        {/* v5.5 — facility-shell mode chip. Only rendered when the
            zone has at least one model with the shell flag ticked;
            otherwise the chip is noise. Selecting `shell-only` hides
            every floor + data-link and pins the shell opaque. */}
        {hasFacilityShell && onShellModeChange && (
          <>
            <div className="px-1.5 pt-1.5 pb-1">
              <div
                className="grid grid-cols-3 gap-1"
                role="radiogroup"
                aria-label="Facility view mode"
              >
                {(
                  [
                    { id: 'auto', label: 'Auto' },
                    { id: 'shell-only', label: 'Shell' },
                    { id: 'interior-only', label: 'Interior' },
                  ] as const
                ).map((opt) => {
                  const active = shellMode === opt.id
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => onShellModeChange(opt.id)}
                      className={
                        'text-[10.5px] rounded-md px-1.5 py-1 border transition-colors ' +
                        (active
                          ? 'border-primary bg-primary/10 text-foreground font-medium'
                          : 'border-border/60 hover:bg-accent/40 text-muted-foreground')
                      }
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {shellMode !== 'shell-only' && allowAllFloors && (
          <>
            <DropdownMenuItem
              onSelect={() => onSelect(null)}
              className="gap-2 text-xs"
            >
              <Check
                className={
                  'h-3.5 w-3.5 ' + (isAll ? 'opacity-100' : 'opacity-0')
                }
              />
              <span className="flex-1">All floors</span>
              <span className="text-[10px] text-muted-foreground">
                {floorPlans.length}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {shellMode !== 'shell-only' &&
          floorPlans.map((fp, idx) => {
            const checked = !isAll && selectedIds.has(fp.id)
            return (
              <DropdownMenuItem
                key={fp.id}
                onSelect={(e) => {
                  // Keep the menu open so users can tick multiple
                  // floors without re-opening between clicks.
                  e.preventDefault()
                  toggleFloor(fp.id)
                }}
                className="gap-2 text-xs"
              >
                <span
                  className={
                    'h-3.5 w-3.5 rounded-sm border flex items-center justify-center ' +
                    (checked
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-border')
                  }
                  aria-hidden
                >
                  {checked && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="flex-1 truncate">
                  {fp.name || `Floor ${idx + 1}`}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  L{idx + 1}
                </span>
              </DropdownMenuItem>
            )
          })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function StyleSwitcher({
  selectedId,
  onSelect,
}: {
  selectedId: MapStyleId
  onSelect: (id: MapStyleId) => void
}) {
  // The report map view's style tiles (icon + name), same labels.
  const styleLabel = useStyleLabel()
  const SelectedIcon = STYLE_ICON[selectedId] ?? MapIcon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2 rounded-full border-border/60 bg-background/70 pl-3 pr-2.5 shadow-lg shadow-black/5 backdrop-blur-xl hover:bg-background/90"
        >
          <SelectedIcon className="h-3.5 w-3.5 text-primary" />
          <span className="max-w-[140px] truncate text-xs font-medium">
            {styleLabel(selectedId)}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="grid w-72 grid-cols-2 gap-1 rounded-xl border-border/60 bg-popover/90 p-1.5 shadow-xl backdrop-blur-xl"
      >
        {MAP_STYLE_IDS.map((sid: MapStyleId) => {
          const Icon = STYLE_ICON[sid] ?? MapIcon
          const on = sid === selectedId
          return (
            <DropdownMenuItem
              key={sid}
              onSelect={() => onSelect(sid)}
              className={cn(
                'flex-col items-start gap-1 rounded-lg border py-2 pl-2.5 pr-2 text-xs',
                on ? 'border-primary bg-primary/10' : 'border-border/60',
              )}
            >
              <Icon className={cn('h-4 w-4', on ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
              <span className="w-full truncate font-medium">{styleLabel(sid)}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The facility couldn't load: a share link that's wrong / expired / turned
 * off, or a facility that's gone or failed to load — instead of a blank map.
 */
function ViewerLoadError({ tokenMode, onRetry }: { tokenMode: boolean; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm" role="alert">
      <div className="sgv-rise w-full max-w-sm rounded-2xl border bg-card p-6 text-center shadow-xl">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <MapPinOff className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>
        <h1 className="text-base font-semibold">
          {tokenMode
            ? t('view.loadState.linkTitle', { defaultValue: 'This link doesn’t work' })
            : t('view.loadState.errorTitle', { defaultValue: 'Couldn’t load this facility' })}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {tokenMode
            ? t('view.loadState.linkBody', { defaultValue: 'It may have expired or been turned off. Ask whoever shared it for a new link.' })
            : t('view.loadState.errorBody', { defaultValue: 'It may have been deleted, or the connection dropped. Try again in a moment.' })}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('common.retry', { defaultValue: 'Retry' })}
          </Button>
          {!tokenMode && (
            <Button asChild size="sm">
              <a href={sitePath('/warehouses')}>{t('view.loadState.back', { defaultValue: 'All facilities' })}</a>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
