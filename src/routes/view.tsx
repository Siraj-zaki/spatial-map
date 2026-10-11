import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { MapDoorOverlay } from '@/components/door/map-door-overlay'
import { MapRoutePreviewOverlay } from '@/components/map-route-preview-overlay'
import { RouteDirectionsPanel } from '@/components/route-directions-panel'
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
import { MapTextLabelOverlay } from '@/components/map-text-label-overlay'
import {
  MapboxMap,
  MAP_STYLE_IDS,
  DEFAULT_MAP_STYLE,
  defaultStyleLabel,
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
import {
  readPayloadPath,
  resolveMatchTargets,
  type MatchStoreSnapshot,
  type MatchableShape,
} from '@/lib/data-link/match-resolver'
import { resolveLabelTemplate } from '@/lib/data-link/style-rule-evaluator'
import { polygonCentroid } from '@/lib/polygon-generators'
import { imageCorners } from '@/lib/image-generators'
import { lineCentroid } from '@/lib/line-generators'
import type {
  Bin,
  DataLinkConfig,
  DataLinkFilter,
  DataLinkFilterCondition,
  EntityState,
  Grid,
  Zone,
} from '@/lib/db'
import {
  allLeavesValid,
  collectPromptLeaves,
  resolvePromptValues,
} from '@/components/data-link/filter-tree-builder'
import { useDoorStore } from '@/lib/door/store'
import { fitMapToGrids } from '@/lib/export'
import { useModelBoundingCenterMap, useModelUrlMap } from '@/lib/model-assets'
import { classifyBin, classifyValue, type MediaItem, type PrimaryFieldRow } from '@/lib/rich-data'
import {
  liftFloorPlanIds,
  type CircleShape,
  type ImageShape,
  type LineShape,
  type MarkerShape,
  type ModelShape,
  type PolygonShape,
} from '@/lib/shapes'
import { useSpatialStore } from '@/lib/spatial-store'
import { useSSE } from '@/lib/useSSE'
import { cn } from '@/lib/utils'
import { labelFromKey, classifyKeyValue } from '@/lib/value-classifier'
import { FieldRow } from '@/components/bin-popup-content'
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
import { ViewerFilterBar } from '@/components/view/viewer-filter-bar'
import { TableHistoryPanel } from '@/components/view/table-history-panel'
import { TableHistoryPlayer } from '@/components/view/table-history-player'
import { ViewerGraphicsPanel } from '@/components/view/viewer-graphics-panel'
import { DataLinkFullScreenLoader } from '@/components/data-link/data-link-loader'
import type { Map as MapboxMapInstance } from 'mapbox-gl'

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

/**
 * Centroid for a single data-link matched shape. Mirrors the overlay's
 * `centroidForShape` (kept in map-data-linked-overlay.tsx) so the
 * Layers pill's "zoom to item" lands on the same anchor the marker
 * renders at. Only handles the kinds a DataLinkConfig can target.
 */
function centroidForDataLinkShape(
  shape: MatchableShape,
  kind: DataLinkConfig['targetKind'],
): [number, number] | null {
  switch (kind) {
    case 'polygon': {
      const p = shape as PolygonShape
      return p.vertices.length >= 3 ? polygonCentroid(p.vertices) : null
    }
    case 'circle': {
      const c = shape as CircleShape
      if (c.center) return c.center
      if (c.start && c.current) {
        return [(c.start[0] + c.current[0]) / 2, (c.start[1] + c.current[1]) / 2]
      }
      return null
    }
    case 'marker': return (shape as MarkerShape).position
    case 'line': {
      const l = shape as LineShape
      return l.vertices.length >= 2 ? lineCentroid(l.vertices) : null
    }
    case 'model': return (shape as ModelShape).position
    default: return null
  }
}

/**
 * The viewer must be independent of any per-shape `visible` flag the
 * editor may have toggled — the editor's eye icon writes `visible=false`
 * to the DB, which would otherwise silently hide shapes here. We strip
 * that flag on the read path so the viewer's only visibility control is
 * its own floor dropdown.
 */
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

export default function View({ mode = 'id' }: { mode?: 'id' | 'token' }) {
  const { warehouseId, token } = useParams<{ warehouseId?: string; token?: string }>()
  const { t } = useTranslation()
  const isAuthMode = mode !== 'token'
  const navigate = useNavigate()

  // Two-stage token resolution:
  //   1. Try the RICH share endpoint `/api/v1/share/{token}` which
  //      returns `{ link: { settings, ... }, warehouse: WarehouseView }`.
  //      Fires only in token mode.
  //   2. If that 404s (legacy `/share/{shareToken}` links minted before
  //      share_links existed), fall back to the plain public warehouse
  //      endpoint. Any legacy URL keeps working; any new URL benefits
  //      from the settings blob.
  const shareTokenForLookup = mode === 'token' ? token : undefined
  const shareResult = useShareLink(shareTokenForLookup)
  const shareSettings = shareResult.data?.link.settings

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
  const id = mode === 'token'
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

  useEffect(() => {
    if (!isAuthMode || id === undefined) return
    const warehouseIdNum = Number(id)
    if (!Number.isFinite(warehouseIdNum)) return
    void useDoorStore.getState().loadForWarehouse(warehouseIdNum)
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
    () => forceVisible(isAuthMode ? inWarehouse(storePolygonsAll) : data?.polygons ?? []),
    [isAuthMode, storePolygonsAll, data?.polygons, warehouseIdNum],
  )
  const allLines = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeLinesAll) : data?.lines ?? []),
    [isAuthMode, storeLinesAll, data?.lines, warehouseIdNum],
  )
  const allMarkers = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeMarkersAll) : data?.markers ?? []),
    [isAuthMode, storeMarkersAll, data?.markers, warehouseIdNum],
  )
  const allStairs = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeStairsAll) : data?.stairs ?? []),
    [isAuthMode, storeStairsAll, data?.stairs, warehouseIdNum],
  )
  const allGrids = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeGridsAll) : data?.grids ?? []),
    [isAuthMode, storeGridsAll, data?.grids, warehouseIdNum],
  )
  const allDoors = useMemo(
    () => forceVisible(isAuthMode ? storeDoors : data?.doors ?? []),
    [isAuthMode, storeDoors, data?.doors],
  )

  // v4 — memoised. Fresh forceVisible() arrays every render leaked
  // downstream: the MapDataLinkedOverlay's shapeProps ({polygons,
  // circles, markers, lines, models}) was rebuilt every parent render
  // even when the actual shape data hadn't changed. Every un-memoised
  // consumer's push effect fired → source.setData → Mapbox re-layout.
  // Widening filter widget, layers-pill toggles, floor picker → each
  // was cascading a full overlay re-render. See the sibling useMemos
  // on polygons/markers/lines/stairs above for the pattern.
  const allCircles = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeCirclesAll) : data?.circles ?? []),
    [isAuthMode, storeCirclesAll, inWarehouse, data?.circles],
  )
  const allImages = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeImagesAll) : data?.images ?? []),
    [isAuthMode, storeImagesAll, inWarehouse, data?.images],
  )
  const allModels = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeModelsAll) : data?.models ?? []),
    [isAuthMode, storeModelsAll, inWarehouse, data?.models],
  )
  const allTextLabels = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeTextLabelsAll) : data?.textLabels ?? []),
    [isAuthMode, storeTextLabelsAll, inWarehouse, data?.textLabels],
  )
  const allImagePlanes = useMemo(
    () => forceVisible(isAuthMode ? inWarehouse(storeImagePlanesAll) : data?.imagePlanes ?? []),
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
  const emptyIfShellOnly = <T,>(arr: readonly T[]): readonly T[] =>
    shellHidesInterior ? [] : arr

  const polygons = useMemo(
    () => emptyIfShellOnly(allPolygons.filter((p) => onFloor(p, selectedFloorPlanIds))),
    [allPolygons, selectedFloorPlanIds, shellHidesInterior],
  )
  const circles = useMemo(
    () => emptyIfShellOnly(allCircles.filter((c) => onFloor(c, selectedFloorPlanIds))),
    [allCircles, selectedFloorPlanIds, shellHidesInterior],
  )
  const lines = useMemo(
    () => emptyIfShellOnly(allLines.filter((l) => onFloor(l, selectedFloorPlanIds))),
    [allLines, selectedFloorPlanIds, shellHidesInterior],
  )
  const markers = useMemo(
    () => emptyIfShellOnly(allMarkers.filter((m) => onFloor(m, selectedFloorPlanIds))),
    [allMarkers, selectedFloorPlanIds, shellHidesInterior],
  )
  const images = useMemo(
    () =>
      emptyIfShellOnly(
        allImages.filter((img) => shouldShowImage(img, selectedFloorPlanIds)),
      ),
    [allImages, selectedFloorPlanIds, shellHidesInterior],
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
    [allStairs, selectedFloorPlanIds, shellHidesInterior],
  )
  const textLabels = useMemo(
    () => emptyIfShellOnly(allTextLabels.filter((lbl) => onFloor(lbl, selectedFloorPlanIds))),
    [allTextLabels, selectedFloorPlanIds, shellHidesInterior],
  )
  const imagePlanes = useMemo(
    () => emptyIfShellOnly(allImagePlanes.filter((p) => onFloor(p, selectedFloorPlanIds))),
    [allImagePlanes, selectedFloorPlanIds, shellHidesInterior],
  )
  const doors = useMemo(
    () => emptyIfShellOnly(allDoors.filter((d) => onFloor(d, selectedFloorPlanIds))),
    [allDoors, selectedFloorPlanIds, shellHidesInterior],
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

  const handleZoomToShape = useCallback(
    (center: [number, number]) => {
      if (!mapInstance) return
      mapInstance.flyTo({ center, zoom: 19, duration: 600 })
    },
    [mapInstance],
  )

  const getShapeCenter = useCallback(
    (kind: ShapeLayerKind, id: number): [number, number] | null => {
      switch (kind) {
        case 'polygons': {
          const p = polygons.find((s) => s.id === id)
          if (!p || p.vertices.length < 3) return null
          return polygonCentroid(p.vertices)
        }
        case 'circles': {
          const c = circles.find((s) => s.id === id)
          if (!c) return null
          if (c.center) return c.center
          if (c.start && c.current) return [(c.start[0] + c.current[0]) / 2, (c.start[1] + c.current[1]) / 2]
          return null
        }
        case 'markers': {
          const m = markers.find((s) => s.id === id)
          return m?.position ?? null
        }
        case 'models': {
          const m = models.find((s) => s.id === id)
          return m?.position ?? null
        }
        case 'stairs': {
          const s = stairs.find((st) => st.id === id)
          if (!s || s.vertices.length < 2) return null
          return [(s.vertices[0][0] + s.vertices[1][0]) / 2, (s.vertices[0][1] + s.vertices[1][1]) / 2]
        }
        case 'doors': {
          const d = doors.find((s) => s.id === id)
          if (!d || d.vertices.length < 2) return null
          return [(d.vertices[0][0] + d.vertices[1][0]) / 2, (d.vertices[0][1] + d.vertices[1][1]) / 2]
        }
        case 'imagePlanes': {
          const ip = imagePlanes.find((s) => s.id === id)
          return ip?.position ?? null
        }
        case 'textLabels': {
          const tl = textLabels.find((s) => s.id === id)
          return tl?.position ?? null
        }
        case 'grids': {
          const g = grids.find((s) => s.id === id)
          if (!g) return null
          return g.config.rotation ? [g.start[0], g.start[1]] : [(g.start[0] + g.current[0]) / 2, (g.start[1] + g.current[1]) / 2]
        }
        case 'images': {
          const img = images.find((s) => s.id === id)
          if (!img) return null
          return [(img.start[0] + img.current[0]) / 2, (img.start[1] + img.current[1]) / 2]
        }
        default:
          return null
      }
    },
    [polygons, circles, markers, models, stairs, doors, imagePlanes, textLabels, grids, images],
  )

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
  const { isRotating: isAutoRotating, toggleRotate: toggleAutoRotate } =
    useMapRotation(mapInstance)

  // ---- Route-preview (indoor wayfinding) ---------------------------------
  // End-user surface — a "Navigate" floating button flips the tool on;
  // click point A then point B and the same routing pipeline the editor
  // uses draws a path + shows a directions panel. Toggle is local state
  // (not persisted) so refreshing the viewer resets the session.
  const [routePreviewActive, setRoutePreviewActive] = useState(false)
  const routePreview = useRoutePreviewTool({
    mapInstance,
    // The hook only listens when activeTool === 'route-preview'. Pass a
    // synthetic value so the editor's `Tool` union covers both call
    // sites without a second code path.
    activeTool: routePreviewActive ? 'route-preview' : 'pan',
    walls: lines,
    doors,
    polygons,
    grids,
  })

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
    const current = mapInstance.getBearing()
    if (Math.abs(current - selectedFloorRotation) < 0.5) return
    mapInstance.easeTo({ bearing: selectedFloorRotation, duration: 400 })
  }, [mapInstance, selectedFloorRotation])

  const modelUrlMap = useModelUrlMap()
  const modelBoundingCenters = useModelBoundingCenterMap()

  const [drawerPolygonId, setDrawerPolygonId] = useState<number | null>(null)
  const drawerPolygon: PolygonShape | undefined = useMemo(
    () => (drawerPolygonId === null ? undefined : polygons.find((p) => p.id === drawerPolygonId)),
    [drawerPolygonId, polygons],
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHiddenConfigIds(new Set(shareSettings.hiddenDataLinkConfigIds))
    }
    if (shareSettings.dataLinkFilterPresets) {
      setActivePresetIds(shareSettings.dataLinkFilterPresets)
    }
    if (shareSettings.defaultFloorPlanId !== undefined) {
      const pinned = shareSettings.defaultFloorPlanId
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // Build the viewer index the resolver needs to enumerate grid cell
  // addresses for `scope='grid-cell'` rules. Without this the resolver
  // returns an empty map for grid-cell targets (see resolver.ts:311-316:
  // the `all + grid-cell` branch reads *exclusively* from
  // `viewers.gridCells`). Mirrors the editor's `viewerIndex` in
  // create-grids/index.tsx.
  const viewerIndex = useMemo<import('@/lib/style-rules').ViewerIndex>(() => {
    const gridCells: { gridId: number; row: number; col: number; level: number }[] = []
    for (const bin of allBins) {
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
      polygons,
      circles,
      lines,
      markers,
      images,
      models,
      textLabels,
      stairs,
      gridCells,
    }
  }, [polygons, circles, lines, markers, images, models, textLabels, stairs, allBins])

  // Resolve per-cell + per-shape style overrides from bins + style
  // rules — same call the editor makes (see create-grids/index.tsx).
  const resolvedStyles = useMemo(
    () =>
      resolveStyleMaps(activeStyleRules, allBins, {
        zoneId: warehouseIdNum ?? undefined,
        viewers: viewerIndex,
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
      textLabels: textLabels.map((tl) => ({ id: tl.id!, name: tl.name })),
      grids: grids.map((g) => ({ id: g.id!, name: g.name })),
      images: images.map((img) => ({ id: img.id!, name: img.name })),
      bins: (bins ?? []).map((b) => ({ id: b.id!, name: b.sku || b.externalCode || `Bin ${b.row ?? '?'}-${b.col ?? '?'}` })),
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
  const [dlEntityDrawer, setDlEntityDrawer] = useState<{
    title: string
    kindLabel: string
    accentColor: string | undefined
    bin?: Bin
    clusterItems?: Array<{
      payload: Record<string, unknown>
      position: [number, number]
    }>
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
  } | null>(null)

  const polygonTriggerIndex = useMemo(() => {
    const idx = new Map<number, 'hover' | 'click'>()
    for (const p of polygons) {
      if (p.id === undefined) continue
      idx.set(p.id, p.config.tooltipTrigger ?? 'hover')
    }
    return idx
  }, [polygons])

  const focusPolygon = (id: number) => {
    setDrawerPolygonId(id)
    const target = polygons.find((p) => p.id === id)
    if (!target || !mapInstance) return
    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    for (const [lng, lat] of target.vertices) {
      minLng = Math.min(minLng, lng)
      minLat = Math.min(minLat, lat)
      maxLng = Math.max(maxLng, lng)
      maxLat = Math.max(maxLat, lat)
    }
    if (!Number.isFinite(minLng)) return
    mapInstance.fitBounds(
      [[minLng, minLat], [maxLng, maxLat]],
      {
        padding: 40,
        duration: 600,
        maxZoom: 22,
        bearing: mapInstance.getBearing(),
      },
    )
  }

  // Zoom the map to a single data-link entity. Resolves the entity's
  // anchor the same way the overlay does — coord mode reads payload
  // coordFields (with `entity.position` fallback); shape-anchored modes
  // resolve to the matched shape's centroid. Used by the Layers pill's
  // per-item "zoom to" button.
  const handleZoomToDataLinkItem = useCallback(
    (cfg: DataLinkConfig, entity: EntityState) => {
      if (!mapInstance) return
      const state = useSpatialStore.getState()
      const snapshot: MatchStoreSnapshot = {
        bins: state.bins ?? [],
        polygons: state.polygons ?? [],
        markers: state.markers ?? [],
        circles: state.circles ?? [],
        lines: state.lines ?? [],
        stairs: state.stairs ?? [],
        doors: state.doors ?? [],
        images: state.images ?? [],
        imagePlanes: state.imagePlanes ?? [],
        models: state.models ?? [],
        textLabels: state.textLabels ?? [],
      }
      const result = resolveMatchTargets(entity.payload, cfg, snapshot)
      let position: [number, number] | null = null
      if (result.kind === 'coord') {
        position = result.position
      } else if (result.kind === 'shapes' && result.shapes.length > 0) {
        position = centroidForDataLinkShape(result.shapes[0], cfg.targetKind)
      }
      // Coord-mode fallback: the overlay's PointAtCoordSubRenderer falls
      // back to `entity.position` when the payload doesn't carry coord
      // fields (e.g. the backend extracted coords at ingest time but
      // didn't echo them in the payload JSON). Mirror that here so the
      // zoom button works for those entities too.
      if (!position && entity.position && entity.position.length === 2) {
        position = entity.position
      }
      if (!position) {
        // Debug aid: when the button silently no-ops, this logs the
        // resolver's verdict so you can see why (e.g. join field
        // mismatch, target shape missing from store, coordFields unset).
        console.warn('[zoom-to-item] no position resolved', {
          configId: cfg.id,
          configName: cfg.name,
          renderMode: cfg.renderMode,
          targetKind: cfg.targetKind,
          match: cfg.fieldMapping?.match,
          entityKey: entity.entityKey,
          resolver: result.kind === 'none' ? result.reason : result.kind,
          hasEntityPosition: !!entity.position,
        })
        return
      }
      mapInstance.flyTo({
        center: position,
        zoom: Math.max(mapInstance.getZoom(), 18),
        duration: 600,
        essential: true,
      })
    },
    [mapInstance],
  )

  // Polygon selection outline — the drawer highlights the currently
  // opened polygon on the map.
  const selectedPolygonIds = useMemo(() => {
    const set = new Set<number>()
    if (drawerPolygonId !== null) set.add(drawerPolygonId)
    return set
  }, [drawerPolygonId])

  const handlePolygonClick = (id: number) => {
    if (polygonTriggerIndex.get(id) === 'click') {
      focusPolygon(id)
    }
  }
  const handleMarkerClick = (id: number) => {
    setDrawerMarkerId(id)
  }

  const clickShapeOverride = (
    kind: 'polygon' | 'circle' | 'line' | 'marker' | 'image' | 'model',
    id: number,
  ): boolean | void => {
    if (kind === 'polygon') {
      focusPolygon(id)
      return true
    }
    if (kind === 'marker') {
      setDrawerMarkerId(id)
      return true
    }
    return
  }

  const kindLabelForDataLinkConfig = (
    cfg: import('@/lib/db').DataLinkConfig,
  ): string => {
    return cfg.name || 'Asset'
  }

  /**
   * Route a data-link entity payload to the right drawer:
   *   - Shape-bound configs (marker / polygon) → focus the shape's
   *     dedicated drawer so it shares the same UX as clicking the
   *     shape itself.
   *   - Coord-based configs → synthesise a Bin from the payload and
   *     open the entity drawer.
   * Shared by the map click handler AND the popup's "View more"
   * callback so the two entry points produce identical results.
   */
  const openDataLinkEntityDrawer = (
    cfg: import('@/lib/db').DataLinkConfig,
    payload: Record<string, unknown>,
    /** Optional — the map feature's `entityKey` prop. When present +
     *  the layer is table-backed, the drawer surfaces the History
     *  panel for this row's change trail. */
    entityKey?: string,
  ) => {
    if (cfg.targetShapeId !== undefined && cfg.targetShapeId !== null) {
      if (cfg.targetKind === 'marker') {
        setDrawerMarkerId(cfg.targetShapeId)
        return
      }
      if (cfg.targetKind === 'polygon') {
        setDrawerPolygonId(cfg.targetShapeId)
        return
      }
    }
    const { customProperties, header } = applyPanelConfig(payload, cfg)
    const bin: Bin = {
      targetKind: 'polygon',
      customProperties,
      updatedAt: new Date(),
    }
    setDlEntityDrawer({
      title: kindLabelForDataLinkConfig(cfg),
      kindLabel: 'Asset',
      accentColor: cfg.style?.defaultColor,
      bin,
      panelHeader: header,
      panelFields: cfg.tooltip.panel?.fields ?? cfg.tooltip.fields,
      labelField: cfg.fieldMapping?.labelField,
      sourceId: cfg.sourceId ?? undefined,
      entityKey,
    })
  }

  // Click on a data-link widget (sensor / camera / asset — any layer
  // whose id starts with `dl-{configId}-`) opens the shared drawer.
  //   - If the widget's config binds to a marker/polygon, open the
  //     shape drawer for that shape id (uses its Bin like normal).
  //   - Otherwise (point-at-coord / heatmap / track — no shape id),
  //     synthesise a Bin from the clicked feature's payload so the
  //     ShapeDetailDrawer can render the same UX with live data.
  useEffect(() => {
    if (!mapInstance) return
    const readPayload = (props: Record<string, unknown> | null | undefined): Record<string, unknown> => {
      if (!props) return {}
      const raw = props['payload']
      if (typeof raw === 'string') {
        try { return JSON.parse(raw) as Record<string, unknown> } catch { /* fallthrough */ }
      }
      if (raw && typeof raw === 'object') return raw as Record<string, unknown>
      // No `payload` key — treat every property as the payload.
      return props
    }
    const onDlClick = (e: import('mapbox-gl').MapMouseEvent) => {
      let hits: Array<{
        layer?: { id?: string; source?: string }
        properties?: Record<string, unknown> | null
        source?: string
      }>
      try {
        hits = mapInstance.queryRenderedFeatures(e.point) as typeof hits
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
        if (!cfg) continue
        e.preventDefault()

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
            const items: Array<{
              payload: Record<string, unknown>
              position: [number, number]
            }> = []
            for (const leaf of leaves) {
              const payload = readPayload(
                leaf.properties as Record<string, unknown> | null,
              )
              const geom = leaf.geometry
              const coords =
                geom && geom.type === 'Point'
                  ? (geom.coordinates as [number, number])
                  : [0, 0]
              items.push({ payload, position: [coords[0], coords[1]] })
            }
            setDlEntityDrawer({
              title: `${kindLabelForDataLinkConfig(cfg)} · ${pointCount || items.length}`,
              kindLabel: kindLabelForDataLinkConfig(cfg),
              accentColor: cfg.style?.defaultColor,
              clusterItems: items,
              panelFields: cfg.tooltip.panel?.fields ?? cfg.tooltip.fields,
              panelTemplateRaw: cfg.tooltip.panel?.template,
              labelField: cfg.fieldMapping?.labelField,
            })
          }
          // Manual cluster path — the aggregate feature carries
          // `manualCluster: true` and its `groupKey` tells us which
          // room to filter the raw feature list on.
          if (props['manualCluster'] === true || props['manualCluster'] === 'true') {
            const groupKey = String(props['groupKey'] ?? '')
            const leaves = getManualClusterLeaves(configId, groupKey)
            openList(leaves)
            return
          }
          // Native Mapbox cluster path.
          const clusterId =
            typeof props['cluster_id'] === 'number'
              ? (props['cluster_id'] as number)
              : Number(props['cluster_id'])
          const sourceId = hit.layer?.source ?? `dl-${configId}-src`
          const source = mapInstance.getSource(sourceId) as
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

        // Non-cluster hit: delegate to the shared helper. Same
        // routing as the popup's "View more" callback so the two
        // entry points produce identical drawer state.
        const payload = readPayload(hit.properties)
        const rawKey = hit.properties?.['entityKey']
        const entityKey = typeof rawKey === 'string' ? rawKey : undefined
        // v5.4 — respect analytic occlusion. `queryRenderedFeatures`
        // returns features regardless of paint opacity, so a marker
        // that has been faded to 0 by the occlusion pass is still
        // clickable and would open the drawer over a marker the user
        // can't see. Property-based hide (see OCCLUSION_TEXT_OPACITY
        // in map-data-linked-overlay.tsx) means the flag is on the
        // feature's `properties.occluded` — not feature-state, which
        // Mapbox wipes on every `source.setData`.
        if (hit.properties?.['occluded'] === true) continue
        openDataLinkEntityDrawer(cfg, payload, entityKey)
        return
      }
    }
    mapInstance.on('click', onDlClick)
    return () => {
      mapInstance.off('click', onDlClick)
    }
  }, [mapInstance, warehouseConfigs])

  const committedLines = useMemo<CommittedLine[]>(
    () =>
      grids
        .filter((g): g is Grid & { id: number } => g.id !== undefined)
        .map((g) => ({ id: g.id, start: g.start, current: g.current, config: g.config, visible: g.visible })),
    [grids],
  )

  return (
    <div className="w-dvw h-dvh overflow-hidden bg-background">
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
       */}
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
                  facilityShellMode={shellMode}
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
      />
      {routePreviewActive && (
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
        // v5.5 — door labels use the same analytic occlusion pass as
        // text-labels + markers so they stop poking through floor
        // plates, walls, and rack cells at a tilt.
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
          grids:
            layerVisible('racks') && isShapeKindVisible('grids')
              ? grids
              : undefined,
        }}
      />
      {!shellHidesInterior && layerVisible('markers') && isShapeKindVisible('markers') && (
        <MapMarkerOverlay
          map={overlayMap}
          markers={markers}
          onMarkerClick={handleMarkerClick}
          // Slabs, walls and staircases hide the markers standing behind
          // them. Each kind is gated on its own visibility — geometry the
          // viewer toggled off paints nothing and so must occlude nothing.
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
            grids:
              layerVisible('racks') && isShapeKindVisible('grids')
                ? grids
                : undefined,
          }}
        />
      )}
      {!shellHidesInterior && layerVisible('bins') && isShapeKindVisible('bins') && (
        <MapBinOverlay map={overlayMap} committedLines={committedLines} bins={bins} visible />
      )}
      {!shellHidesInterior && layerVisible('text') && isShapeKindVisible('textLabels') && (
        <MapTextLabelOverlay
          map={overlayMap}
          labels={textLabels}
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
          // one floor at a time. Images stay multi-floor because they
          // carry `floorPlanId` on their prism and the solver skips
          // the label's own floor plate (see marker-occlusion.ts).
          occluders={{
            images: allImages,
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
          onEntityViewMore={(cfg, payload, _lngLat, entityKey) =>
            openDataLinkEntityDrawer(cfg, payload, entityKey)
          }
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

      {/* Preview header — only in authenticated preview mode
          (`/view/:warehouseId` from the map-toolbar's Preview button),
          NEVER in share-link mode (`/share/:token`). Shows a back
          button that returns the user to the editor plus the
          warehouse name as a hero card. Matches the visual language
          of the top-end controls (glass card, rounded-full pills). */}
      {isAuthMode && (
        <div className="absolute z-10 flex items-center gap-2 top-4 start-4">
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 rounded-full border-border/60 bg-background/70 pl-2 pr-3 shadow-lg shadow-black/5 backdrop-blur-xl hover:bg-background/90"
            onClick={() => {
              if (window.history.length > 1) navigate(-1)
              else navigate('/create-grids')
            }}
            title="Back to editor"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Back to editor</span>
          </Button>
          <div className="flex items-center gap-2 h-9 px-3 rounded-full border border-border/60 bg-background/70 shadow-lg shadow-black/5 backdrop-blur-xl">
            <span
              className="flex items-center justify-center w-5 h-5 rounded-md bg-primary/10 text-primary ring-1 ring-primary/15"
              aria-hidden
            >
              <Eye className="w-3 h-3" />
            </span>
            <span className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">
              Preview
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

      <div className="sgv-scroll-hide absolute z-10 flex flex-col items-end gap-2 max-h-[calc(100dvh-2rem)] overflow-y-auto top-4 end-4">
        {showFloorPlanFilter && floorPlans.length > 0 && (
          <FloorSwitcher
            floorPlans={floorPlans}
            selectedIds={selectedFloorPlanIds}
            onSelect={setSelectedFloorPlanIds}
            allowAllFloors={typeof lockedFloorPlanId !== 'number'}
            shellMode={shellMode}
            onShellModeChange={setShellMode}
            hasFacilityShell={allModels.some(
              (m) => m.config?.facilityShell?.enabled === true,
            )}
          />
        )}
        {showStyleSwitcher && (
          <StyleSwitcher selectedId={mapStyle} onSelect={setMapStyle} />
        )}
        {showLayersPanel && (warehouseConfigs.length > 0 || Object.values(shapeLayerItems).some((v) => v.length > 0)) && (
          <ViewerLayersPanel
            shapeItems={shapeLayerItems}
            getShapeCenter={getShapeCenter}
            onZoomTo={handleZoomToShape}
            hiddenShapeKinds={hiddenShapeKinds}
            onToggleShapeKind={toggleShapeKind}
            dataLinkConfigs={warehouseConfigs}
            hiddenConfigIds={hiddenConfigIds}
            onToggleDataLinkConfig={toggleConfigVisibility}
            onSetAllDataLinkConfigs={setAllConfigsOfKind}
            onToggleDataLinkEnabled={toggleConfigEnabled}
            activeFilterLabels={activeFilterLabels}
            onZoomToDataLinkItem={handleZoomToDataLinkItem}
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

      {/* v5.4 — history player. Bottom-of-map, video-player-style bar
          that auto-shows when at least one visible layer uses
          renderMode='history-movement'. Positioned outside the
          top-right stack so it can span the map width. */}
      <TableHistoryPlayer configs={visibleConfigs} />

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
        kindLabel="Area"
        fallbackId={drawerPolygon?.id}
        bin={drawerBin}
        open={drawerPolygonId !== null}
        onClose={() => setDrawerPolygonId(null)}
      />

      <ShapeDetailDrawer
        name={drawerMarker?.name}
        accentColor={drawerMarker?.config.iconColor}
        kindLabel="Marker"
        fallbackId={drawerMarker?.id}
        bin={drawerMarkerBin}
        open={drawerMarkerId !== null}
        onClose={() => setDrawerMarkerId(null)}
      />

      <ShapeDetailDrawer
        name={dlEntityDrawer?.title}
        accentColor={dlEntityDrawer?.accentColor}
        kindLabel={dlEntityDrawer?.kindLabel ?? 'Widget'}
        fallbackId={undefined}
        bin={dlEntityDrawer?.bin}
        clusterItems={dlEntityDrawer?.clusterItems}
        clusterLabelField={dlEntityDrawer?.labelField}
        panelHeader={dlEntityDrawer?.panelHeader}
        historySourceId={dlEntityDrawer?.sourceId}
        historyEntityKey={dlEntityDrawer?.entityKey}
        onSelectClusterItem={(payload) => {
          if (!dlEntityDrawer) return
          // Apply the same content-viewer filter/order as the top-level
          // click path so drilling into a cluster leaf renders the same
          // set of configured fields. Fills empty/null/undefined values
          // with an em-dash so classifyBin (which drops nullish + empty
          // strings from its custom list) keeps every configured field
          // visible — matches the intent that "if I added it to the
          // sidebar it should always show, with — when there's no data."
          const panelFields = dlEntityDrawer.panelFields
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
          const header = dlEntityDrawer.panelTemplateRaw
            ? resolveLabelTemplate(dlEntityDrawer.panelTemplateRaw, payload)
            : undefined
          setDlEntityDrawer({
            ...dlEntityDrawer,
            // Keep the cluster snapshot around so the "Back to list"
            // control can flip us home.
            bin: {
              targetKind: 'polygon',
              customProperties,
              updatedAt: new Date(),
            } as Bin,
            panelHeader: header,
          })
        }}
        onBackToCluster={() => {
          if (!dlEntityDrawer) return
          setDlEntityDrawer({ ...dlEntityDrawer, bin: undefined })
        }}
        open={dlEntityDrawer !== null}
        onClose={() => setDlEntityDrawer(null)}
      />
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
  clusterItems?: ReadonlyArray<{
    payload: Record<string, unknown>
    position: [number, number]
  }>
  /** v4 — payload path chosen by the layer as its main label (e.g.
   *  `sku`). Used to title each entry in the cluster-list mode so users
   *  see the identifier they picked, not a hardcoded fallback. */
  clusterLabelField?: string
  onSelectClusterItem?: (payload: Record<string, unknown>) => void
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
  const links = classified?.links ?? []
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

  const { i18n } = useTranslation()
  const isRtl = i18n.dir() === 'rtl'
  const direction: 'left' | 'right' = isRtl ? 'left' : 'right'

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
    >
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <DrawerPrimitive.Content
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
            isRtl
              ? 'start-0 border-e border-border/60 rounded-e-2xl'
              : 'end-0 border-s border-border/60 rounded-s-2xl',
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
                {name && name !== headerTitle && (
                  <DrawerDescription className="text-xs truncate text-muted-foreground">
                    {name}
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
                  title={copiedTitle ? 'Copied' : 'Copy identifier'}
                  aria-label="Copy identifier"
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
                  aria-label="Close"
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
                title={`Cluster · ${clusterItems?.length ?? 0} items`}
                icon={Layers}
              >
                <div className="p-2 space-y-1.5 border rounded-lg shadow-sm border-border/60 bg-card/50 backdrop-blur-sm">
                  {clusterItems?.map(
                    (
                      it: { payload: Record<string, unknown>; position: [number, number] },
                      i: number,
                    ) => (
                      <ClusterListItem
                        key={`${i}-${String(it.payload.id ?? i)}`}
                        payload={it.payload}
                        labelField={clusterLabelField}
                        onClick={() => onSelectClusterItem?.(it.payload)}
                      />
                    ),
                  )}
                </div>
              </DrawerSection>
            )}

            {!inClusterMode && !bin && (
              <div className="px-6 py-12 text-sm text-center border border-dashed rounded-lg border-border/60 bg-card/40 text-muted-foreground">
                No linked data for this {kindLabel.toLowerCase()}.
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
                Back to list ({clusterItems!.length})
              </button>
            )}

            {/* Additional images (all but the first — that one is
                already the hero above). */}
            {!inClusterMode && images.length > 1 && (
              <DrawerSection title="Media" icon={ImageIcon}>
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
              <DrawerSection title="Video" icon={Video}>
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
              <DrawerSection title="Details" icon={Info}>
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
              <DrawerSection title="Properties" icon={Braces}>
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
                <DrawerSection title="History" icon={Clock}>
                  <TableHistoryPanel
                    sourceId={historySourceId}
                    entityKey={historyEntityKey}
                  />
                </DrawerSection>
              )}

            {links.length > 0 && (
              <DrawerSection title="Links" icon={Link2}>
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
    'Item'

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

function StatusBadge({ status }: { status: 'empty' | 'occupied' | 'reserved' | string }) {
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
      {status}
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2 rounded-full border-border/60 bg-background/70 pl-3 pr-2.5 shadow-lg shadow-black/5 backdrop-blur-xl hover:bg-background/90"
        >
          <MapIcon className="h-3.5 w-3.5 text-primary" />
          <span className="max-w-[140px] truncate text-xs font-medium">
            {defaultStyleLabel(selectedId)}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-56 shadow-xl rounded-xl border-border/60 bg-popover/90 backdrop-blur-xl"
      >
        {MAP_STYLE_IDS.map((sid: MapStyleId) => (
          <DropdownMenuItem
            key={sid}
            onSelect={() => onSelect(sid)}
            className="gap-2 text-xs"
          >
            <Check
              className={
                'h-3.5 w-3.5 ' + (selectedId === sid ? 'opacity-100' : 'opacity-0')
              }
            />
            <span className="flex-1 truncate">{defaultStyleLabel(sid)}</span>
          </DropdownMenuItem>
        ))}
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
              <a href="/warehouses">{t('view.loadState.back', { defaultValue: 'All facilities' })}</a>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
