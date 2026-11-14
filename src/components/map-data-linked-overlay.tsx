/**
 * MapDataLinkedOverlay — the generic replacement for the seven
 * hardcoded live overlays (asset / sensor / camera / shipment / RFID /
 * CV / rule). See DESIGN-data-link.md for the full design.
 *
 * SLICE 3 SCOPE — every render mode wired up:
 *   - `point-at-coord`   (original slice-2 renderer, unchanged)
 *   - `point-on-shape`   sensor(s) mounted at a shape's centroid
 *   - `gauge-on-shape`   value badge stacked at a shape's centroid
 *   - `shape-tint`       fill override on a bound polygon/circle
 *   - `heatmap`          density heatmap of recent event log
 *   - `track`            per-entity breadcrumb LineString + head dot
 *   - `fov-cone`         camera field-of-view triangle at a centroid
 *   - `roi-pulse`        pulsing ring + count badge on a bound shape
 *
 * For each enabled DataLinkConfig bound to the active warehouse, one
 * sub-renderer instance is mounted with its own Mapbox sources +
 * layers, namespaced by config id (`dl-{id}-*`) so multiple configs on
 * the same map never collide.
 */

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'
import { useApiQuery, queryCache } from '@/lib/useApiQuery'
import { subscribeExternalSSE } from '@/lib/useSSE'
import { useStableCallback } from '@/hooks/useStableCallback'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { listEntityEventsForStream } from '@/lib/data-link/entity-state-service'
import { fetchLayerRows } from '@/lib/data-link/layer-rows'
import { getRowForSource } from '@/lib/data-link/data-source-rows'
import { whenStyleLoaded } from '@/lib/mapbox-style-ready'
import { ensureDataLinkSpritesFor } from '@/lib/data-link/lucide-icon-sprites'
import {
  compileEntityRules,
  nextRuleClockChange,
  resolveLabelTemplate,
} from '@/lib/data-link/style-rule-evaluator'
import {
  readPayloadPath,
  resolvePayloadCoord,
  type MatchableShape,
  type MatchStoreSnapshot,
} from '@/lib/data-link/match-resolver'
import { useSpatialStore } from '@/lib/spatial-store'
import { emitDataLinkClick } from '@/lib/data-link/data-link-events'
import type { StyleRule } from '@/lib/style-rules'
import type {
  PolygonShape,
  CircleShape,
  MarkerShape,
  LineShape,
  ModelShape,
  ImageShape,
  StairShape,
} from '@/lib/shapes'
import type {
  Bin,
  DataLinkConfig,
  DataLinkFilter,
  EntityState,
  EntityEvent,
} from '@/lib/db'
import {
  evaluateDataLinkFilter,
  passesFloorScope,
  resolveEntityFloor,
  activeFloorKey,
  type ActiveFloors,
} from '@/lib/data-link/filter-evaluator'
import {
  listTableEvents,
  type TableRowEvent,
} from '@/lib/data-link/table-events-client'
import { useTablePlaybackFor } from '@/lib/data-link/table-playback-store'
import { useLayerPollMs } from '@/lib/data-link/layer-refresh'
import {
  buildOccluders,
  createOcclusionState,
  resetOcclusionState,
  updateOcclusion,
  type OccludableTarget,
} from '@/lib/marker-occlusion'
import { BinPopupContent } from './bin-popup-content'
import { useLayerLoading } from '@/lib/data-link/loading-store'
import {
  buildCoordFeatures,
  buildFovFeatures,
  buildGaugeFeatures,
  buildHeatmapFeatures,
  buildPointOnShapeFeatures,
  buildRoiFeatures,
  buildShapeTintFeatures,
  buildTrackFeatures,
  createRowBuildCache,
  eventsToEntities,
  focusedAnchorOf,
  matchReadsBins,
  matchShapesLoaded,
  narrowMatchSnapshot,
  resolveAnchorElevation,
  type CoordFeaturesResult,
  type CoordFocusOptions,
  type RowAnchors,
  type RowBuildCache,
} from '@/lib/data-link/feature-builders'
import {
  hasMapLayer,
  noteNewDataLinkLayers,
  raiseDataLinkLayers,
  registerDataLinkLayers,
  rootLayerOrder,
  rootSourceIds,
  settleDataLinkMerge,
} from '@/lib/data-link/dl-layer-stack'
import { useSharedRows } from '@/lib/data-link/row-sharing'
import { anyManualClusterFeature, manualClusterLayersAlwaysEmpty } from '@/lib/data-link/dl-layer-gate'
import { createGeoJSONDiffWriter, type GeoJSONDiffWriter } from '@/lib/geojson-diff-writer'
import { hintLayerEmpty } from '@/lib/empty-layer-gate'
import { FOCUS_FACTOR, GHOST_OCCLUDED_OPACITY, useFocusScene } from '@/lib/focus/focus-scene'
import type { FocusNearRegion } from '@/lib/focus/focus-near'
import type { DlAnchor } from '@/lib/focus/focus-target'
import { useGraphicsSettings } from '@/lib/graphics-settings'
import {
  buildRoomIndex,
  clearRuntimeClusterMembers,
  clusterPoints,
  colorToken,
  setRuntimeClusterMembers,
  type ClusterItem,
  type PointClusterSpec,
  type RoomIndex,
} from '@/lib/data-link/point-clusters'
import {
  runtimeClusterIds,
  useClusterZoomBucket,
  useDlClusterLayer,
  type DlClusterLayerHandle,
} from './map-dl-cluster-overlay'
import { heatmapCovers, heatCells, useDlHeatmapLayer, type PointHeatmapSpec } from './map-dl-heatmap-overlay'

/**
 * Depth handling shared by every render mode.
 *
 * Two Mapbox facts drive the shape of the code below:
 *
 *  1. `*-occlusion-opacity` is what makes a feature disappear behind a
 *     slab, rack or wall. Its spec default reads "absent value means
 *     full occlusion against TERRAIN only" — so leaving it unset is NOT
 *     the same as setting it to 0. Every layer that should hide behind
 *     3D content has to name the property explicitly.
 *  2. Mapbox 3.25's `circle` layer has neither `circle-z-offset` nor
 *     `circle-occlusion-opacity`. A circle therefore cannot leave the
 *     ground and cannot be occluded, at all. Every disc/dot/ring in
 *     this file is consequently drawn as a `symbol` with a `●` glyph —
 *     the workaround `point-at-coord` already used, now applied
 *     uniformly so a first-floor sensor behaves the same in all modes.
 */
const Z_OFFSET: mapboxgl.ExpressionSpecification = [
  'coalesce',
  ['get', 'elevation'],
  0,
]

/**
 * A `●` glyph fills roughly 0.72 of its em-box, so a symbol rendering
 * at the same visual size as a circle of radius R needs
 * `text-size = 2R / 0.72 ≈ R * 2.8`. Kept as a named constant because
 * every circle→symbol conversion below has to apply it to preserve the
 * sizes users already configured.
 */
const DISC_EM_SCALE = 2.8

/** Glyph + font shared by every disc drawn as a symbol. */
const DISC_LAYOUT: mapboxgl.SymbolLayerSpecification['layout'] = {
  'text-field': '●',
  'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
  'text-allow-overlap': true,
  'text-ignore-placement': true,
  // Explicit `symbol-z-offset` is the altitude source; letting Mapbox
  // also auto-lift the symbol onto whatever 3D content sits underneath
  // would double-count it.
  'symbol-z-elevate': false,
}

/**
 * Hollow counterpart of `DISC_LAYOUT`, for what used to be a circle with
 * `circle-color: transparent` + a stroke. The glyph's stroke thickness
 * scales with `text-size` instead of being a fixed pixel width — the one
 * visual difference the circle→symbol move forces here.
 */
const RING_LAYOUT: mapboxgl.SymbolLayerSpecification['layout'] = {
  ...DISC_LAYOUT,
  'text-field': '○',
}

/**
 * Shared empty arrays for absent props. A `= []` default is a NEW array on
 * every render, which re-ran every memo and push effect keyed on it (and
 * rebuilt every config's occluder prisms) whenever the host re-rendered.
 */
const EMPTY_POLYGONS: ReadonlyArray<PolygonShape> = []
const EMPTY_CIRCLES: ReadonlyArray<CircleShape> = []
const EMPTY_MARKERS: ReadonlyArray<MarkerShape> = []
const EMPTY_LINES: ReadonlyArray<LineShape> = []
const EMPTY_MODELS: ReadonlyArray<ModelShape> = []
const EMPTY_IMAGES: ReadonlyArray<ImageShape> = []
const EMPTY_STAIRS: ReadonlyArray<StairShape> = []
const EMPTY_RULES: ReadonlyArray<StyleRule> = []
const EMPTY_ENTITIES: EntityState[] = []
const EMPTY_EVENTS: EntityEvent[] = []
const EMPTY_BINS: readonly Bin[] = []
const NO_SHAPES: readonly MatchableShape[] = []

interface MapDataLinkedOverlayProps {
  map: MapboxMapInstance | null
  /**
   * Warehouse scope. Only configs with `zoneId === activeZoneId` render.
   * Pass null to disable — useful when the app first mounts before the
   * user picks a warehouse.
   */
  activeZoneId: number | null
  /**
   * All data-link configs the user has created. The overlay filters
   * down to `{ zoneId: activeZoneId, enabled: true }` internally.
   */
  configs: ReadonlyArray<DataLinkConfig>
  /** Master visibility flag from the Layers popover. */
  visible?: boolean
  /** Disable fetching (e.g. editor's preview=false). */
  enabled?: boolean
  /**
   * Shape arrays for shape-anchor lookups. The render modes that pin a
   * marker/badge/tint/fov/pulse to a specific shape (`point-on-shape`,
   * `gauge-on-shape`, `shape-tint`, `fov-cone`, `roi-pulse`) resolve
   * `config.targetShapeId` against these. All optional — modes that
   * don't need them (`point-at-coord`, `heatmap`, `track`) ignore.
   */
  polygons?: ReadonlyArray<PolygonShape>
  circles?: ReadonlyArray<CircleShape>
  markers?: ReadonlyArray<MarkerShape>
  lines?: ReadonlyArray<LineShape>
  models?: ReadonlyArray<ModelShape>
  /**
   * v5.4 — occluder shapes fed to the analytic occlusion pass. Kept
   * separate from `polygons/circles/lines` above because those props
   * feed the shape-anchor RESOLVER for shape-pinned render modes,
   * whereas these feed the OCCLUSION solver in every render mode.
   *
   * In share-link mode the spatial store is empty (shapes arrive
   * inside the share payload's `data.polygons` etc.), so a sub-
   * renderer that read straight from `useSpatialStore` got nothing
   * and hid nothing. The host is responsible for passing whichever
   * arrays actually paint on the map — that's what the occluders
   * should be too.
   */
  occluderImages?: ReadonlyArray<ImageShape>
  occluderStairs?: ReadonlyArray<StairShape>
  /**
   * v5.5 — polygons/circles/lines the ANALYTIC OCCLUSION pass should
   * consider. The main `polygons` / `circles` / `lines` props above are
   * for shape-anchor lookup and must include EVERY shape in the zone,
   * because a data-link config can anchor to a shape on a floor the
   * viewer isn't currently on. Occluders are different — the pass
   * only wants shapes that are actually painted on the map, so a
   * first-floor slab at 3.75 m doesn't hide a ground-floor marker
   * while the viewer is on ground-floor mode. Defaults to the anchor
   * arrays when unset (pre-fix behaviour).
   */
  occluderPolygons?: ReadonlyArray<PolygonShape>
  occluderCircles?: ReadonlyArray<CircleShape>
  occluderLines?: ReadonlyArray<LineShape>
  /**
   * All style rules the tenant has authored. Sub-renderers evaluate a
   * config's `styleRuleIds` against each entity's payload via
   * `evaluateEntityRules` and let matching rules override the feature's
   * color / label / opacity before the paint expressions consume them.
   * Default `[]` — rules are opt-in and empty = no overrides.
   */
  styleRules?: ReadonlyArray<StyleRule>
  /**
   * When true, CLICK-mode popups are suppressed — the host is expected
   * to handle clicks itself (typically opening a shared sidebar
   * drawer). Hover-mode popups still fire, so a config whose
   * `tooltip.trigger` is `hover` continues to render the hover tooltip
   * normally. Default false keeps the editor's existing behaviour
   * untouched.
   *
   * Historical note: this flag used to disable BOTH hover and click
   * popups. That broke hover tooltips on the /view route (which sets
   * this flag) — users would set `trigger: hover` in the data-link
   * config, see nothing on hover, and only the sidebar drawer open on
   * click. Split into hover-still-runs + click-suppressed so hover
   * config finally does what it says.
   */
  disableTooltips?: boolean
  /**
   * v4 — the floor plan the host currently has selected. Passed down
   * to every sub-renderer so entities are filtered before they hit the
   * source. Floor resolution:
   *   - shape-anchored modes → matched shape's floorPlanId
   *   - coord/heatmap/track → `payload.floorPlanId` | `floorId` | `floor`
   *   - unknown/undefined → show on every floor (matches the onFloor
   *     helper's behaviour for shapes with undefined floorPlanId)
   * `null` disables the filter (all-floors mode).
   */
  activeFloorPlanId?: ActiveFloors
  /**
   * The set of floor plan ids that currently exist for the tenant.
   * Used to detect *orphan* references in an entity's payload — e.g.
   * when a floor plan was deleted and a new one added with a fresh id,
   * the old id embedded in every ingested row no longer matches. Instead
   * of silently dropping every affected row, the overlay treats orphan
   * floors as *unknown* so rows keep rendering on the current floor.
   *
   * Optional so callers that haven't wired it yet keep the pre-fix
   * behaviour. Empty or undefined disables orphan detection.
   */
  liveFloorPlanIds?: ReadonlyArray<number>
  /**
   * v4 — per-config filter expressions. Keyed by config.id. The Layers
   * panel authors these; sub-renderers evaluate them against every
   * entity's payload before pushing features. `null` / missing entry =
   * no filter for that config.
   */
  configFilters?: Readonly<Record<number, DataLinkFilter | null>>
  /**
   * Called when the user clicks "View more" on a compact hover popup.
   * The host (view.tsx) wires this to open its sidebar drawer for the
   * entity — replacing the earlier `map.fire('click', ...)` synthetic
   * hack that didn't reliably reach view.tsx's global `dl-*` click
   * handler across all builds. Called with the ORIGINAL payload
   * (unmodified — the popup body's filtered `customProperties` is a
   * display artifact) and the anchor lngLat so the host can position
   * follow-up UI (fit-to-bounds, focus ring, etc.) if it wants.
   * When unset, "View more" falls back to firing the synthetic click
   * so existing behaviour keeps working.
   */
  onEntityViewMore?: (
    config: DataLinkConfig,
    payload: Record<string, unknown>,
    lngLat: { lng: number; lat: number },
    /** v5.4 — feature-level `entityKey` prop so the drawer can look
     *  up per-row history on table-backed layers. Optional because
     *  streaming features may not carry a stable key. */
    entityKey?: string,
  ) => void
  /**
   * Runtime clustering for point-at-coord / history-movement configs
   * (`@/lib/data-link/point-clusters`): rows that sit close together on
   * screen (or share a room / field value) fold into donut bubbles on
   * `dl-<id>-rc-*`. The host must memoise it (a new object re-clusters).
   * null / unset = today's path, untouched: no extra layers, listeners or
   * writes.
   */
  pointCluster?: PointClusterSpec | null
  /**
   * Viewer-chosen heatmap over point-at-coord / history-movement layers
   * (`map-dl-heatmap-overlay.tsx`): `dl-<id>-rh-heat` under the config's
   * points, or instead of them (`mode: 'only'`). Memoise it like
   * `pointCluster`. null / unset = off, nothing installed.
   */
  pointHeatmap?: PointHeatmapSpec | null
}

/**
 * Passes `disableTooltips` + the "View more" callback down to every
 * TooltipManager so sub-renderers don't need individual props. All
 * fields optional so the editor's existing tooltip UX is unchanged
 * when the overlay mounts without any override.
 */
interface DataLinkTooltipCtx {
  disable: boolean
  onEntityViewMore?: (
    config: DataLinkConfig,
    payload: Record<string, unknown>,
    lngLat: { lng: number; lat: number },
    entityKey?: string,
  ) => void
}
const DataLinkTooltipContext = createContext<DataLinkTooltipCtx>({ disable: false })

/**
 * Poll cadence for the layer's row query. Was 5s originally — set that
 * low so a WebSocket-driven stream would surface new events fast even
 * if the SSE invalidation ever missed one. For REST sources on a 30s+
 * scheduled poll that's 6× more traffic than the source actually
 * refreshes, and the network tab lights up with duplicate 241-row
 * responses.
 *
 * 30s is a better default: it matches the typical REST cadence, and
 * the `queryCache.invalidate('layer-rows')` call the rerun path fires
 * on every scheduled / manual ingest means fresh rows still render
 * within a paint tick — the poll is just a safety net for the "another
 * tab wrote something" case where our local invalidation didn't fire.
 */

/**
 * v5.4 — resolve the effective entity list for a sub-renderer. When
 * the table-playback player has activated this layer's source, we
 * bypass the live query and read reconstructed entities at the
 * playhead; otherwise we return the live query's data. Centralised
 * so every sub-renderer picks up playback support in one edit.
 *
 * The playback subscription is per source and only wakes this
 * component when the entity set at the playhead changes — not on every
 * playhead tick, and never for another source's playback.
 */
function useEffectiveEntities(
  config: DataLinkConfig,
  liveEntities: readonly EntityState[] | undefined,
): { entities: EntityState[]; playbackActive: boolean } {
  const playback = useTablePlaybackFor(config.sourceId)
  const entities = useMemo(
    () =>
      playback.active && playback.entities
        ? playback.entities
        : (liveEntities ?? EMPTY_ENTITIES) as EntityState[],
    [playback.active, playback.entities, liveEntities],
  )
  return { entities, playbackActive: playback.active }
}

/**
 * The layer's rows, with unchanged rows keeping their object identity
 * across refetches (see row-sharing.ts), and its loading flag reported
 * to the data-link loader along with whether rows are already held. The
 * viewer's blocking card covers only loads with no rows (useApiQuery
 * keeps `data` across a key change, so `data` is undefined until the
 * first response or after the cache entry was dropped); a refresh (SSE
 * invalidation, floor switch) shows only in the editor's pill.
 */
function useLayerRows(
  config: DataLinkConfig,
  query: { data: EntityState[] | undefined; isLoading: boolean },
): readonly EntityState[] | undefined {
  useLayerLoading(config.id, config.name, query.isLoading, query.data !== undefined)
  return useSharedRows(query.data)
}

/** `data_source_rows` row → the `EntityState` the builders read (as `fetchLayerRows` maps it). */
function focusRowToEntity(row: Awaited<ReturnType<typeof getRowForSource>>): EntityState | null {
  if (!row) return null
  return {
    id: row.id,
    streamId: 0,
    entityKey: row.entityKey,
    payload: row.payload,
    position: row.position,
    lastSeenAt: new Date(row.ts),
    updatedAt: new Date(row.updatedAt),
  }
}

/**
 * Fetches the focused row by key when the layer's own query doesn't hold
 * it — a filter preset or the active floor is pushed to the server
 * (`fetchLayerRows`), so a row the user asked to see can be missing from
 * `query.data`. Mounted only while that is the case, so it costs nothing
 * otherwise. Its key sits under `layer-rows` with the source id at
 * deps[2], so the same SSE invalidations refresh it.
 */
function FocusedRowLoader({
  sourceId,
  entityKey,
  onRow,
}: {
  sourceId: number
  entityKey: string
  onRow: (entityKey: string, row: EntityState | null) => void
}) {
  const tenantId = useCurrentTenantId()
  const layerPollMs = useLayerPollMs()
  const query = useApiQuery(
    () => getRowForSource(sourceId, entityKey).then(focusRowToEntity),
    ['layer-rows', tenantId, sourceId, 'focus-row', entityKey],
    { intervalMs: layerPollMs },
  )
  const done = query.data !== undefined || (!query.isLoading && query.error !== null)
  const row = query.data ?? null
  useEffect(() => {
    if (done) onRow(entityKey, row)
  }, [done, row, entityKey, onRow])
  return null
}

/**
 * The rows a sub-renderer builds from, with the focused row of this
 * config added when the layer's query left it out (see FocusedRowLoader).
 * `settled` is true once the focused row is known to be in `rows` or known
 * to be absent — the moment a missing anchor can be reported as "not
 * drawn". With no focus here, `rows` is `entities` itself.
 */
function useFocusedRows(
  config: DataLinkConfig,
  entities: EntityState[],
  focusKey: string | null,
  loaded: boolean,
  canFetch: boolean,
): { rows: EntityState[]; settled: boolean; loader: React.ReactNode } {
  const present = useMemo(
    () => focusKey === null || entities.some((e) => e.entityKey === focusKey),
    [entities, focusKey],
  )
  const sourceId = config.sourceId
  const fetchable = canFetch && sourceId !== undefined && sourceId !== null
  const [fetched, setFetched] = useState<{ key: string; row: EntityState | null } | null>(null)
  const got = fetched !== null && fetched.key === focusKey ? fetched : null
  const extra = !present && got !== null ? got.row : null
  const rows = useMemo(() => (extra ? [...entities, extra] : entities), [entities, extra])
  const settled = focusKey === null || (loaded && (present || !fetchable || got !== null))
  const onRow = useStableCallback((key: string, row: EntityState | null) => {
    setFetched((prev) => (prev && prev.key === key && prev.row === row ? prev : { key, row }))
  })
  const loader =
    focusKey !== null && loaded && !present && fetchable ? (
      <FocusedRowLoader
        key={focusKey}
        sourceId={sourceId as number}
        entityKey={focusKey}
        onRow={onRow}
      />
    ) : null
  return { rows, settled, loader }
}

/**
 * Anchor reporting for a pending dl focus target (`FocusScene.needsDlAnchor`).
 * The push effect hands every build to the returned `onDrawn(features,
 * complete)`. As soon as a build drew the focused row, the anchor the
 * builder actually used goes to the host. "Not drawn" (null) goes only
 * from a COMPLETE build — rows loaded, the focused row present or known
 * absent, the bound shapes arrived — so a row that is merely still
 * loading is never reported missing. The overlay forwards each request
 * once. Also answers when the host asks again for a row it already drew
 * (no re-push needed).
 */
function useFocusAnchorReport(
  config: DataLinkConfig,
  focus: ConfigFocus,
  liveFloorPlanIds: ReadonlySet<number> | undefined,
): (features: readonly GeoJSON.Feature[], complete: boolean) => void {
  const drawn = useRef<{ key: string; features: readonly GeoJSON.Feature[]; complete: boolean } | null>(null)
  const send = useStableCallback(() => {
    const d = drawn.current
    const configId = config.id
    if (configId === undefined || focus.key === null || !focus.needsAnchor) return
    if (!d || d.key !== focus.key) return
    const anchor = focusedAnchorOf(d.features, config, liveFloorPlanIds)
    if (anchor || d.complete) focus.report(configId, focus.key, anchor)
  })
  const needsAnchor = focus.needsAnchor
  useEffect(() => {
    if (needsAnchor) send()
  }, [needsAnchor, send])
  return useStableCallback((features: readonly GeoJSON.Feature[], complete: boolean) => {
    drawn.current = focus.key !== null ? { key: focus.key, features, complete } : null
    send()
  })
}

// ---------------------------------------------------------------------------
// Focus mode paint (see src/lib/focus/)
// ---------------------------------------------------------------------------
//
// Three feature properties drive it, all stamped by the builders on cached
// copies of a row's feature (`@/lib/data-link/feature-builders`):
//
//   - `focused: true` — the one row the user asked to see. It is never
//     occluded, passes the layer filter and floor gate, and draws at its
//     own opacity THROUGH floors and walls (`*-occlusion-opacity` 1).
//   - `occluded: true` — a ghost row (Graphics → "Show hidden items as
//     faint ghosts"): an analytically occluded row kept in the source,
//     drawn at GHOST_OCCLUDED_OPACITY × its opacity, also through 3D
//     content, so it reads as a consistent 25 % at every zoom (the depth
//     test alone is too coarse at low zoom, which is why the analytic
//     pass exists).
//   - `focusNear: true` — a point row drawn inside the focused item's
//     NEAR column (`FocusScene.near.region`, `isFocusNearPoint`), drawn at
//     FOCUS_FACTOR.near × its opacity so it doesn't crowd the item.
//     Unclustered point symbols only; every other row, and every
//     aggregate (clusters, heatmap, tints, cones, roi rings, tracks),
//     stays exactly as drawn without focus — there is no global dim.
//
// Properties, not feature-state: a GeoJSON `setData` wipes feature-state,
// and stamping the row keeps it across every write (v5.4). The paint is
// installed once in its focus-aware form and NEVER swapped on focus enter
// / exit: a data-driven `setPaintProperty` re-lays out the whole source,
// and racing that against the floor gate's `setData` during a focus
// flight made GL's symbol placement read a feature index that no longer
// matched its tile ("reading '0'" in FeatureIndex.loadFeature).
//
// While no row carries any flag (focus off, ghosts off) every expression
// below evaluates to exactly the value the layer had before focus mode —
// `*-occlusion-opacity` 0, opacity = the layer's base — so installing them
// changes nothing on screen. The `*-occlusion-opacity` properties stay in
// `layer.paint`, so GL's symbol-merge classification
// (`hasOcclusionOpacityProperties`) is unchanged too.

type PaintValue = number | mapboxgl.ExpressionSpecification

const FOCUSED_ROW: mapboxgl.ExpressionSpecification = ['boolean', ['get', 'focused'], false]
const GHOST_ROW: mapboxgl.ExpressionSpecification = ['boolean', ['get', 'occluded'], false]
const NEAR_ROW: mapboxgl.ExpressionSpecification = ['boolean', ['get', 'focusNear'], false]

/** Point symbols: hidden behind 3D content, except the focused row and ghost rows. */
const POINT_OCCLUSION_OPACITY: mapboxgl.ExpressionSpecification = [
  'case', FOCUSED_ROW, 1, GHOST_ROW, 1, 0,
]
/** Aggregate / track / heatmap symbols (no ghost rows): only the focused row shows through. */
const FOCUS_OCCLUSION_OPACITY: mapboxgl.ExpressionSpecification = ['case', FOCUSED_ROW, 1, 0]

/** `base × f`, folded when `base` is a constant. */
function scaleOpacity(base: PaintValue, f: number): PaintValue {
  return typeof base === 'number' ? Math.round(base * f * 1e6) / 1e6 : ['*', f, base]
}

/**
 * A point symbol's opacity: the focused row at `base`, ghost rows at
 * GHOST × `base`, rows in the focused item's NEAR column at NEAR × `base`,
 * every other row at `base` (precedence focused > ghost > near).
 */
function pointSymbolOpacity(base: PaintValue): mapboxgl.ExpressionSpecification {
  return [
    'case',
    FOCUSED_ROW, base,
    GHOST_ROW, scaleOpacity(base, GHOST_OCCLUDED_OPACITY),
    NEAR_ROW, scaleOpacity(base, FOCUS_FACTOR.near),
    base,
  ]
}

/**
 * Set a paint property only when the layer holds a different value. GL
 * already skips an identical write, but a style-sync effect that re-runs
 * on every install tick then reads as no write at all — the focus proofs
 * count paint writes.
 */
function setPaintIfChanged(map: MapboxMapInstance, layerId: string, prop: string, value: PaintValue): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = map as any
  const held: unknown = m.getPaintProperty(layerId, prop)
  if (held === value || JSON.stringify(held) === JSON.stringify(value)) return
  m.setPaintProperty(layerId, prop, value)
}

/** `value` in a ref that is current by the time any passive effect runs. */
function useLatest<T>(value: T): React.RefObject<T> {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

/**
 * Focus state as the sub-renderers see it — primitives (and the NEAR
 * region, whose identity is stable per focus) only, so the memo'd
 * sub-renderers never hold the host's FocusScene object. One value per
 * focus enter / exit / NEAR column / anchor request / ghost toggle.
 */
interface DataLinkFocusCtx {
  /** Config of the focused data-link row (`FocusScene.dl`), else null. */
  configId: number | null
  /** Entity key of the focused row, else null. */
  entityKey: string | null
  /**
   * `FocusScene.near.region`: point rows drawn inside it are stamped
   * `focusNear` (null = no column: focus off, pending, a floor plan).
   */
  nearRegion: FocusNearRegion | null
  /** Graphics → "Show hidden items as faint ghosts". */
  ghosts: boolean
  /** The host waits for the focused row's drawn anchor. */
  needsAnchor: boolean
  /** Report where the focused row is drawn (null = not drawn). Stable. */
  report: (configId: number, entityKey: string, anchor: DlAnchor | null) => void
}
const DataLinkFocusContext = createContext<DataLinkFocusCtx>({
  configId: null,
  entityKey: null,
  nearRegion: null,
  ghosts: false,
  needsAnchor: false,
  report: () => {},
})

/** The focus context narrowed to one config. */
interface ConfigFocus {
  /** The focused row's entity key when it belongs to this config, else null. */
  key: string | null
  /** The focused item's NEAR column (see DataLinkFocusCtx.nearRegion). */
  near: FocusNearRegion | null
  ghosts: boolean
  /** `key !== null` and the host waits for its anchor. */
  needsAnchor: boolean
  report: DataLinkFocusCtx['report']
}

function useConfigFocus(config: DataLinkConfig): ConfigFocus {
  const ctx = useContext(DataLinkFocusContext)
  const key = ctx.configId !== null && ctx.configId === config.id ? ctx.entityKey : null
  return {
    key,
    near: ctx.nearRegion,
    ghosts: ctx.ghosts,
    needsAnchor: key !== null && ctx.needsAnchor,
    report: ctx.report,
  }
}

/** Render modes that mount a sub-renderer (`ActiveConfigsRenderer`). */
const RENDERED_MODES: ReadonlySet<string> = new Set([
  'point-at-coord',
  'history-movement',
  'point-on-shape',
  'gauge-on-shape',
  'shape-tint',
  'heatmap',
  'track',
  'fov-cone',
  'roi-pulse',
])

export function MapDataLinkedOverlay({
  map,
  activeZoneId,
  configs,
  visible = true,
  enabled = true,
  polygons = EMPTY_POLYGONS,
  circles = EMPTY_CIRCLES,
  markers = EMPTY_MARKERS,
  lines = EMPTY_LINES,
  models = EMPTY_MODELS,
  occluderImages = EMPTY_IMAGES,
  occluderStairs = EMPTY_STAIRS,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  styleRules = EMPTY_RULES,
  disableTooltips = false,
  activeFloorPlanId = null,
  liveFloorPlanIds,
  configFilters,
  onEntityViewMore,
  pointCluster = null,
  pointHeatmap = null,
}: MapDataLinkedOverlayProps) {
  // v5.5 — separate occluder + shape-anchor arrays. Host may pin
  // occluders to the visible-floor filtered set while still passing
  // every zone shape as an anchor target. When the host doesn't opt
  // in, fall back to the anchor arrays for identical pre-fix behaviour.
  const effectiveOccluderPolygons = occluderPolygons ?? polygons
  const effectiveOccluderCircles = occluderCircles ?? circles
  const effectiveOccluderLines = occluderLines ?? lines
  // Set form for O(1) orphan lookups. Keyed on the id list's CONTENT, not
  // its reference: a host that rebuilds the list every render (the editor
  // did) would otherwise hand every sub-renderer a new Set each time and
  // re-run every config's filter + push.
  const liveFloorPlanIdKey = (liveFloorPlanIds ?? []).join(',')
  const liveFloorPlanIdSet = useMemo(
    () =>
      new Set(
        liveFloorPlanIdKey === '' ? [] : liveFloorPlanIdKey.split(',').map(Number),
      ),
    [liveFloorPlanIdKey],
  )
  // Only render configs scoped to the active warehouse. Multiple
  // configs can share the map (e.g. one for forklifts + one for
  // sensors); each gets its own dedicated overlay child.
  const activeConfigs = useMemo(
    () =>
      configs.filter(
        (c) => c.enabled && c.zoneId === activeZoneId && c.id !== undefined,
      ),
    [configs, activeZoneId],
  )

  // Table-kind sources push rows straight into `data_source_rows` and
  // broadcast a `data-sources` SSE event. That kind is deliberately absent
  // from useSSE's VALID_KINDS (it is not a spatial entity), so it arrives on
  // the external channel — without this, table-backed layers would only
  // refresh on the layer poll tick (`useLayerPollMs`, 30 s by default).
  //
  // The event's id is the source that changed, so only the layers reading
  // that table refetch (`layer-rows` keys carry the source id at deps[2]);
  // an id of 0 means "reload the kind" and refreshes every layer, as all
  // events used to. A burst of writes (a simulator tick, an import)
  // arrives as many events, each in its own task; they are folded into
  // one invalidation per animation frame (the timeout covers a hidden
  // tab, where frames don't run).
  useEffect(() => {
    let raf: number | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let all = false
    const sourceIds = new Set<number>()
    const cancel = () => {
      if (raf !== null) cancelAnimationFrame(raf)
      if (timer !== null) clearTimeout(timer)
      raf = null
      timer = null
    }
    const flush = () => {
      cancel()
      if (all) {
        queryCache.invalidate('layer-rows')
      } else if (sourceIds.size > 0) {
        const ids = new Set(sourceIds)
        queryCache.invalidateWhere('layer-rows', (deps) => ids.has(deps[2] as number))
      }
      all = false
      sourceIds.clear()
    }
    const unsubscribe = subscribeExternalSSE((kind, ev) => {
      if (kind !== 'data-sources') return
      const id = Number(ev?.id)
      if (Number.isInteger(id) && id > 0) sourceIds.add(id)
      else all = true
      if (raf !== null || timer !== null) return
      raf = requestAnimationFrame(flush)
      timer = setTimeout(flush, 50)
    })
    return () => {
      unsubscribe()
      cancel()
    }
  }, [])

  // (Removed) Diagnostic breadcrumb that logged on every re-render.
  // Even under `import.meta.env.DEV` it spammed the console because
  // `configs` and `activeConfigs` change reference on every spatial-
  // store update — every wall / shape patch triggered a log. If a
  // targeted trace is needed in the future, attach it to a specific
  // event (mount, config-add, config-remove) instead of a props-diff
  // effect.

  // Container-level maintenance for `dl-*` layers:
  //   (a) When `activeConfigs` changes (e.g. the host toggled a
  //       widget off), sweep layers + sources whose config id is no
  //       longer active. Runs ONCE per change — not on every
  //       `styledata` event — because sub-renderers repeatedly emit
  //       `styledata` while installing, and re-running the sweep on
  //       each of those would race the install and remove
  //       just-installed layers. Reads the style's own layer order and
  //       source list (`dl-layer-stack.ts`), not `getStyle()`, which
  //       serialises the whole style including the imported basemap.
  //   (b) On every `styledata` event, keep the `dl-*` layers on top of
  //       the stack as one block (`raiseDataLinkLayers`) so widgets stay
  //       visible above any overlay whose layers get pushed on top of
  //       ours during a style swap. The raise moves nothing when the
  //       block is already on top. It used to move every `dl-*` layer
  //       unconditionally, and since every `moveLayer` dirties the style,
  //       the next frame fired `styledata` again: with one data-link layer
  //       on the map, the map re-ran full symbol placement every frame and
  //       never went idle. Only registered while a config is active, so a
  //       facility without live data pays nothing.
  useEffect(() => {
    if (!map) return
    const activeIds = new Set(
      activeConfigs
        .map((c) => c.id)
        .filter((id): id is number => id !== undefined),
    )
    const parseConfigId = (id: string): number | null => {
      if (!id.startsWith('dl-')) return null
      const rest = id.slice('dl-'.length)
      const dash = rest.indexOf('-')
      const n = Number(dash === -1 ? rest : rest.slice(0, dash))
      return Number.isFinite(n) ? n : null
    }
    // (a) One-shot orphan removal on activeConfigs change. Copies of the
    // id lists: `removeLayer` / `removeSource` edit the live ones.
    try {
      for (const id of [...rootLayerOrder(map)]) {
        const cfgId = parseConfigId(id)
        if (cfgId === null || activeIds.has(cfgId)) continue
        try { map.removeLayer(id) } catch { /* concurrent */ }
      }
      for (const sourceId of rootSourceIds(map)) {
        const cfgId = parseConfigId(sourceId)
        if (cfgId === null || activeIds.has(cfgId)) continue
        try { map.removeSource(sourceId) } catch { /* concurrent */ }
      }
    } catch { /* style not ready */ }
  }, [map, activeConfigs])

  const hasActiveConfigs = activeConfigs.length > 0
  useEffect(() => {
    if (!map || !hasActiveConfigs) return
    // (b) Guarded raise-to-top on styledata (no removals here).
    const raise = () => {
      try {
        raiseDataLinkLayers(map)
        noteNewDataLinkLayers(map)
      } catch { /* style not ready */ }
    }
    // One re-merge per new dl layer once its paint is evaluated (3D tints
    // must sort below the markers) — see settleDataLinkMerge.
    const settle = () => {
      try {
        settleDataLinkMerge(map)
      } catch { /* style not ready */ }
    }
    raise()
    map.on('styledata', raise)
    map.on('render', settle)
    return () => {
      map.off('styledata', raise)
      map.off('render', settle)
    }
  }, [map, hasActiveConfigs])

  // Stable context value: a new object here re-rendered every tooltip on
  // every host render. The "View more" callback keeps its identity too
  // and always calls the host's latest handler.
  const hasViewMore = onEntityViewMore !== undefined
  const viewMore = useStableCallback(
    (...args: Parameters<NonNullable<DataLinkTooltipCtx['onEntityViewMore']>>) =>
      onEntityViewMore?.(...args),
  )
  const tooltipCtx = useMemo<DataLinkTooltipCtx>(
    () => ({
      disable: disableTooltips,
      onEntityViewMore: hasViewMore ? viewMore : undefined,
    }),
    [disableTooltips, hasViewMore, viewMore],
  )

  // ---- focus mode ---------------------------------------------------------
  // The host's FocusScene (viewer / report map / editor) narrowed to the
  // primitives the sub-renderers need; the memo'd sub-renderers only ever
  // see these, never the scene object.
  const scene = useFocusScene()
  const ghosts = useGraphicsSettings((s) => s.occlusionGhosts)
  const focusConfigId = scene.dl?.configId ?? null
  const focusEntityKey = scene.dl?.entityKey ?? null
  // Stable per focus (and per NEAR content): a camera move never changes it.
  const nearRegion = scene.near.region
  const needsAnchor = scene.needsDlAnchor
  const sceneKey = scene.key
  const onDlAnchor = scene.onDlAnchor
  // Latest request, current before any sub-renderer's effect runs (layout
  // effects precede every passive effect of the commit).
  const anchorRequest = useRef({ sceneKey, needsAnchor, focusConfigId, focusEntityKey, onDlAnchor })
  // The sceneKey whose anchor went out; cleared once the host stops asking,
  // so focusing the same row again later asks (and answers) again.
  const anchorSentFor = useRef<string | null>(null)
  useLayoutEffect(() => {
    anchorRequest.current = { sceneKey, needsAnchor, focusConfigId, focusEntityKey, onDlAnchor }
    if (!needsAnchor) anchorSentFor.current = null
  })
  /** Forward a drawn anchor to the host: once per request, for the row it asked about. */
  const reportAnchor = useStableCallback(
    (configId: number, entityKey: string, anchor: DlAnchor | null) => {
      const req = anchorRequest.current
      if (!req.needsAnchor || !req.onDlAnchor) return
      if (req.focusConfigId !== configId || req.focusEntityKey !== entityKey) return
      if (anchorSentFor.current === req.sceneKey) return
      anchorSentFor.current = req.sceneKey
      req.onDlAnchor(req.sceneKey, anchor)
    },
  )
  const focusCtx = useMemo<DataLinkFocusCtx>(
    () => ({
      configId: focusConfigId,
      entityKey: focusEntityKey,
      nearRegion,
      ghosts,
      needsAnchor,
      report: reportAnchor,
    }),
    [focusConfigId, focusEntityKey, nearRegion, ghosts, needsAnchor, reportAnchor],
  )
  // No sub-renderer will ever draw the requested row: its config isn't
  // active on this map (disabled, another facility, hidden by the host) or
  // the overlay is switched off. An empty `configs` list is still loading,
  // so it isn't an answer yet.
  const configCount = configs.length
  useEffect(() => {
    if (!needsAnchor || focusConfigId === null || focusEntityKey === null) return
    if (!map || activeZoneId === null) return
    if (enabled) {
      if (configCount === 0) return
      const cfg = activeConfigs.find((c) => c.id === focusConfigId)
      if (cfg && RENDERED_MODES.has(cfg.renderMode)) return
    }
    reportAnchor(focusConfigId, focusEntityKey, null)
  }, [needsAnchor, focusConfigId, focusEntityKey, map, activeZoneId, enabled, configCount, activeConfigs, reportAnchor])

  if (!map || !enabled || activeZoneId === null) return null

  return (
    <DataLinkTooltipContext.Provider value={tooltipCtx}>
      <DataLinkFocusContext.Provider value={focusCtx}>
        <ActiveConfigsRenderer
          activeConfigs={activeConfigs}
          map={map}
          visible={visible}
          enabled={enabled}
          styleRules={styleRules}
          activeFloorPlanId={activeFloorPlanId}
          liveFloorPlanIds={liveFloorPlanIdSet}
          configFilters={configFilters}
          polygons={polygons}
          circles={circles}
          markers={markers}
          lines={lines}
          models={models}
          occluderImages={occluderImages}
          occluderStairs={occluderStairs}
          occluderPolygons={effectiveOccluderPolygons}
          occluderCircles={effectiveOccluderCircles}
          occluderLines={effectiveOccluderLines}
          pointCluster={pointCluster}
          pointHeatmap={pointHeatmap}
        />
      </DataLinkFocusContext.Provider>
    </DataLinkTooltipContext.Provider>
  )
}

/**
 * Split out so the parent's `activeConfigs.map(config => ...)` can
 * memo the shape props array ONCE per parent render instead of once
 * per config. The sub-renderers are `memo` components: every prop
 * handed down here is either a host array, a memo, or the per-config
 * `configFilters[id]` entry (stable while the filter map is), so a host
 * re-render that changed nothing they read no longer re-runs their
 * filter, rule and push effects.
 */
function ActiveConfigsRenderer({
  activeConfigs,
  map,
  visible,
  enabled,
  styleRules,
  activeFloorPlanId,
  liveFloorPlanIds,
  configFilters,
  polygons,
  circles,
  markers,
  lines,
  models,
  occluderImages,
  occluderStairs,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  pointCluster,
  pointHeatmap,
}: {
  activeConfigs: readonly DataLinkConfig[]
  map: MapboxMapInstance
  visible: boolean
  enabled: boolean
  styleRules: ReadonlyArray<StyleRule>
  activeFloorPlanId: ActiveFloors
  liveFloorPlanIds: ReadonlySet<number>
  configFilters?: Readonly<Record<number, DataLinkFilter | null>>
  polygons: ReadonlyArray<PolygonShape>
  circles: ReadonlyArray<CircleShape>
  markers: ReadonlyArray<MarkerShape>
  lines: ReadonlyArray<LineShape>
  models: ReadonlyArray<ModelShape>
  occluderImages: ReadonlyArray<ImageShape>
  occluderStairs: ReadonlyArray<StairShape>
  occluderPolygons: ReadonlyArray<PolygonShape>
  occluderCircles: ReadonlyArray<CircleShape>
  occluderLines: ReadonlyArray<LineShape>
  pointCluster: PointClusterSpec | null
  pointHeatmap: PointHeatmapSpec | null
}) {
  // v4 — one memoised shape props object shared by every shape-anchored
  // sub-renderer. Previously recreated on every activeConfigs.map
  // iteration → sub-renderers saw a fresh reference every parent
  // render → push effects fired for no reason.
  const shapeProps = useMemo(
    () => ({ polygons, circles, markers, lines, models }),
    [polygons, circles, markers, lines, models],
  )
  return (
    <>
      {activeConfigs.map((config) => {
        // key MUST be passed directly, not via spread — otherwise
        // React treats N sibling sub-renderers as keyless and reuses
        // the wrong instance when the config array reorders (e.g.
        // when a new layer is added). Symptom: features don't paint,
        // console shows the "props containing a key is being spread"
        // warning.
        const k = `dl-${config.id}`
        const configFilter =
          (config.id !== undefined && configFilters?.[config.id]) || null
        const commonProps = {
          map,
          config,
          visible,
          enabled,
          styleRules,
          activeFloorPlanId,
          liveFloorPlanIds,
          filter: configFilter,
          // v5.4 — occluder bag threaded down so the analytic
          // occlusion pass in each sub-renderer's `useDataLinkOcclusion`
          // hook has the shapes that actually paint on this host's
          // map. In share-link mode the spatial store is empty, so
          // subscribing to the store returned nothing and nothing got
          // occluded.
          occluderImages,
          occluderPolygons,
          occluderCircles,
          occluderLines,
          occluderStairs,
        }
        switch (config.renderMode) {
          case 'point-at-coord':
          case 'history-movement':
            // Same sub-renderer — the playback store swap-in
            // (`useEffectiveEntities`) is what makes `history-movement`
            // scrub through events instead of pulling live rows.
            return (
              <PointAtCoordSubRenderer
                key={k}
                {...commonProps}
                pointCluster={pointCluster ?? null}
                roomPolygons={pointCluster?.mode === 'room' ? polygons : undefined}
                pointHeatmap={heatmapCovers(pointHeatmap, config.id) ? pointHeatmap : null}
              />
            )
          case 'point-on-shape':
            return <PointOnShapeSubRenderer key={k} {...commonProps} {...shapeProps} />
          case 'gauge-on-shape':
            return <GaugeOnShapeSubRenderer key={k} {...commonProps} {...shapeProps} />
          case 'shape-tint':
            return <ShapeTintSubRenderer key={k} {...commonProps} {...shapeProps} />
          case 'heatmap':
            return <HeatmapSubRenderer key={k} {...commonProps} />
          case 'track':
            return <TrackSubRenderer key={k} {...commonProps} />
          case 'fov-cone':
            return <FovConeSubRenderer key={k} {...commonProps} {...shapeProps} />
          case 'roi-pulse':
            return <RoiPulseSubRenderer key={k} {...commonProps} {...shapeProps} />
          default:
            return null
        }
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// point-at-coord sub-renderer
// ---------------------------------------------------------------------------

interface SubRendererProps {
  map: MapboxMapInstance
  config: DataLinkConfig
  visible: boolean
  enabled: boolean
  /** All tenant style rules; filtered per-entity via config.styleRuleIds. */
  styleRules: ReadonlyArray<StyleRule>
  /**
   * Warehouse polygons — used by point-at-coord to fall back to the
   * ROOM's elevation when the entity payload doesn't carry its own
   * `elevation` field. If the user maps `clusterGroupField` to
   * `currentRoomId` (say), and the entity says `currentRoomId: 42`,
   * we look up polygon 42 and lift the marker to `polygon.config.elevation`.
   * This means the mock doesn't have to emit elevation per row to get
   * per-floor marker altitudes.
   */
  polygons?: ReadonlyArray<PolygonShape>
  /**
   * v4 — global floor scope from the host's floor switcher. Sub-renderers
   * drop entities that resolve to a different floor before feature push.
   * `null` = all-floors mode. See `resolveEntityFloor` in
   * `data-link/filter-evaluator.ts` for the resolution order.
   */
  activeFloorPlanId?: ActiveFloors
  /**
   * Live floor plan id set from the host — passed as an actual Set so
   * O(1) orphan checks in the floor gate stay cheap. See
   * `passesFloorScope` in `filter-evaluator.ts`.
   */
  liveFloorPlanIds?: ReadonlySet<number>
  /**
   * v4 — per-config filter authored from the /view Layers panel. Passed
   * as `null` when the layer has no filter (or the host didn't wire the
   * feature yet). Evaluated against each entity's payload before push.
   */
  filter?: DataLinkFilter | null
  /**
   * v5.4 — occluder bag for the analytic occlusion pass. Sub-renderers
   * subscribe to `useDataLinkOcclusion` which reads these directly.
   * Must be threaded by the host — the spatial store is empty in
   * share-link mode so we cannot fall back to it.
   */
  occluderImages?: ReadonlyArray<ImageShape>
  occluderPolygons?: ReadonlyArray<PolygonShape>
  occluderCircles?: ReadonlyArray<CircleShape>
  occluderLines?: ReadonlyArray<LineShape>
  occluderStairs?: ReadonlyArray<StairShape>
}

/** Runtime clustering inputs of the point-at-coord sub-renderer. */
interface PointClusterProps {
  /** See MapDataLinkedOverlayProps.pointCluster (null = off). */
  pointCluster?: PointClusterSpec | null
  /** Room mode only: the facility's polygons (the rooms). */
  roomPolygons?: ReadonlyArray<PolygonShape>
  /** See MapDataLinkedOverlayProps.pointHeatmap — already narrowed to this config. */
  pointHeatmap?: PointHeatmapSpec | null
}

interface ShapeAnchorProps {
  polygons: ReadonlyArray<PolygonShape>
  circles: ReadonlyArray<CircleShape>
  markers: ReadonlyArray<MarkerShape>
  lines: ReadonlyArray<LineShape>
  models: ReadonlyArray<ModelShape>
}

/**
 * Renders one config's entities as points at their payload lng/lat.
 * When `style.cluster` is on, the source clusters + we draw the
 * cluster bubble + count. Individual points always draw a circle,
 * arrow (if payload has `heading`), and a text label.
 */
const PointAtCoordSubRenderer = memo(function PointAtCoordSubRenderer({
  map,
  config,
  visible,
  enabled,
  styleRules,
  polygons,
  activeFloorPlanId,
  liveFloorPlanIds,
  filter,
  occluderImages,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  occluderStairs,
  pointCluster = null,
  roomPolygons,
  pointHeatmap = null,
}: SubRendererProps & PointClusterProps) {
  const configId = config.id
  const tenantId = useCurrentTenantId()
  // Runtime clustering (null = off: every line below behaves as before).
  const runtime = configId !== undefined ? pointCluster : null
  const runtimeActive = runtime !== null

  // Poll the stream's entities on `useLayerPollMs()` (30 s by default) — the
  // safety net. Every scheduled / manual rerun invalidates the
  // `layer-rows` cache from `rerunDataSource`, which triggers an
  // immediate refetch, so the poll only kicks in as a backstop for
  // cross-tab updates.
  const layerPollMs = useLayerPollMs()
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: layerPollMs, enabled },
  )
  const { entities, playbackActive } = useEffectiveEntities(config, useLayerRows(config, query))

  // Focus mode: the focused row of this config (fetched on its own when
  // the layer's query left it out), ghost rows, rows in the focused item's
  // NEAR column. A clustered config never draws ghosts nor stamps NEAR
  // rows (a bubble aggregates them). A natively clustered or unclustered
  // config draws its focused row on its own source (`dl-focus-<id>-*`,
  // registered last in the dl block): a row in a clustered source can't
  // be kept out of a bubble, and a row in a plain source would draw
  // UNDER the rows after it — e.g. one RFID bag among the ~40 at the
  // same carousel coordinate. A manually clustered config keeps its
  // focused row last in its own source (never folded into a bubble).
  const focus = useConfigFocus(config)
  const loaded = playbackActive || query.data !== undefined
  const { rows, settled, loader } = useFocusedRows(config, entities, focus.key, loaded, !playbackActive)
  // Runtime clustering replaces the config's own native / manual clusters
  // while it is on: the config draws like an unclustered one (dynamic
  // source, focus twin, ghosts, NEAR) and the bubbles come from the runtime
  // layer.
  const clustered = config.style.cluster === true && !runtimeActive
  const nativeCluster = clustered && !config.fieldMapping.clusterGroupField
  const ghostsHere = focus.ghosts && !clustered
  const nearHere = clustered ? null : focus.near
  const visibleRef = useLatest(visible)
  const onDrawn = useFocusAnchorReport(config, focus, liveFloorPlanIds)

  // Track that our sources/layers exist so downstream data-push
  // effects don't push against a torn-down style. `installedRef` is
  // kept as a ref for effects that only need "is it there right now"
  // — but the *tick* below is a useState counter that bumps whenever
  // install finishes so effects that depend on install completion
  // (style-sync in particular) get a genuine re-render trigger. Refs
  // alone can't do this: mutating installedRef.current doesn't wake
  // React up, so sync effects run once with the ref still false and
  // then never re-fire.
  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)

  // Namespace every id by the config so multiple configs coexist on
  // one map. Using the id (not the name) so a rename doesn't leak
  // old sources.
  const ids = useMemo(() => sourceLayerIds(configId ?? 0), [configId])
  const focusIds = useMemo(() => focusLayerIds(configId ?? 0), [configId])
  const tooltipLayerIds = useMemo(
    () => [ids.point, ids.icon, ids.label],
    [ids.point, ids.icon, ids.label],
  )
  // The runtime bubbles sit under this config's singles, so the focused
  // row (always a single) and its ring draw above its pile's bubble.
  const rcIds = useMemo(() => runtimeClusterIds(configId ?? 0), [configId])
  const ownLayerIds = useMemo(
    () => [ids.cluster, ids.clusterCount, rcIds.bubble, rcIds.count, ids.point, ids.icon, ids.label],
    [ids, rcIds],
  )
  const focusLayerList = useMemo(
    () => [focusIds.point, focusIds.icon, focusIds.label],
    [focusIds],
  )

  // Diff-only writes to the (dynamic) source, plus the per-row feature
  // cache that lets an unchanged row hand the writer the same feature
  // object it wrote last time. See pushFeatures.
  const writer = useSourceWriter(map, ids.source)
  const focusWriter = useSourceWriter(map, focusIds.source)
  const [rowCache] = useState(() => createRowBuildCache<GeoJSON.Feature<GeoJSON.Point> | null>())

  // A native cluster source can't be dynamic: reinstall only when THAT
  // changes (an unclustered config never reinstalls on a runtime toggle).
  const shouldNativeCluster = config.style.cluster === true && !runtimeActive

  // ---- install / uninstall on map + enabled + config change --------------
  useEffect(() => {
    if (!enabled) {
      teardown(map, ids)
      installedRef.current = false
      return
    }
    return whenStyleLoaded(
      map,
      () => {
        // Register the Lucide icon sprite catalog on this map BEFORE
        // adding the symbol layer that references it — otherwise
        // Mapbox logs a "no image found" warning per feature until
        // the async load resolves. Idempotent + WeakMap-cached, so
        // this only actually rasterises on the first mount per map.
        // Load ONLY the icon + color this config uses (v2 supports the
        // full ~1714-icon Lucide set at any color — see
        // lucide-icon-sprites.ts). Two configs on the same icon at
        // different colors get separate sprites keyed by hex.
        const iconColor = config.style.iconColor
        void ensureDataLinkSpritesFor(
          map,
          [config.style.defaultIcon ?? 'map-pin'],
          { color: iconColor },
        ).then(() => {
          installSourcesAndLayers(map, ids, config, runtimeActive)
          installedRef.current = true
          if (import.meta.env.DEV) {
            console.debug(`[map-dl:${config.name}] install complete`, {
              entities: entities.length,
              configId: config.id,
            })
          }
          // The features go in from the push effect, which re-runs on
          // this tick. (Pushing here too used to write the closure's
          // stale, UNfiltered rows for a frame.)
          setInstallTick((t) => t + 1)
          pushVisibility(map, ids, visible)
        })
      },
      `[map-dl:${config.name}]`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, ids.point, ids.cluster, shouldNativeCluster])

  // ---- style sync: default colour only ---------------------------------
  // Sizes now flow via feature properties (`discSize` + `iconSize`
  // stamped in pushFeatures, read at render time via `['coalesce',
  // ['get', 'discSize'], 22]` / `['coalesce', ['get', 'iconSize'],
  // 0.7]`). When the user drags markerSize / iconSize in the editor,
  // `config` changes, the features-push effect re-runs, source.setData
  // fires with the new stamps, and Mapbox re-lays out the symbols in
  // one paint tick. That path avoids the known symbol-layer
  // setLayoutProperty staleness bugs (Mapbox GL JS issue #1451, still
  // open in 3.25). Colour is a paint property so setPaintProperty is
  // safe and instant.
  useEffect(() => {
    if (!enabled || !map) return
    const defaultColor = config.style.defaultColor ?? '#3b82f6'
    try {
      if (hasMapLayer(map, ids.point)) {
        map.setPaintProperty(ids.point, 'text-color', [
          'coalesce',
          ['get', 'color'],
          defaultColor,
        ])
      }
    } catch { /* mid-teardown */ }
  }, [
    map,
    enabled,
    installTick,
    ids.point,
    config.style.defaultColor,
  ])
  // The focus twin's disc is installed with the colour of its moment; a
  // colour edit while it is up re-applies it (no-op while it is down).
  const defaultColor = config.style.defaultColor
  useEffect(() => {
    if (!enabled || !hasMapLayer(map, focusIds.point)) return
    try {
      map.setPaintProperty(focusIds.point, 'text-color', [
        'coalesce',
        ['get', 'color'],
        defaultColor ?? '#3b82f6',
      ])
    } catch { /* mid-teardown */ }
  }, [map, enabled, focusIds.point, defaultColor])

  // ---- pre-filter entities: layer filter + active-floor gate ---------
  // Applied before `pushFeatures` so both the ingest and re-emit paths
  // agree on what makes it to the map. The floor gate honours the
  // config's `fieldMapping.floorScope` (auto | all | specific) and
  // treats orphan floor references (payload floor id no longer in
  // `liveFloorPlanIds`) as unknown — so entities whose data references
  // a deleted floor keep rendering instead of vanishing on the current
  // floor.
  // Focus mode: the focused row passes both gates — the user asked to see
  // it, whatever the filter preset or the floor picker say.
  const floorScope = config.fieldMapping.floorScope
  const focusKey = focus.key
  const filteredEntities = useMemo(() => {
    return rows.filter((e) => {
      if (focusKey !== null && e.entityKey === focusKey) return true
      if (filter && !evaluateDataLinkFilter(e.payload, filter)) return false
      if (
        !passesFloorScope(
          e.payload,
          floorScope,
          activeFloorPlanId ?? null,
          liveFloorPlanIds,
        )
      ) {
        return false
      }
      return true
    })
  }, [rows, focusKey, filter, floorScope, activeFloorPlanId, liveFloorPlanIds])

  // ---- analytic occlusion ------------------------------------------------
  // Deterministic hiding at every zoom level. `occludedVersion` bumps
  // when the set of hidden entities actually changes, which retriggers
  // the pushFeatures effect below so each feature gets its `occluded`
  // property re-stamped.
  const { occludedRef, occludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    // The rows it pushes (layer filter + floor gate applied).
    entities: filteredEntities,
    focusKey,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // ---- push new features whenever data changes ----------------------------
  // Layer order is no longer touched here: the container keeps the whole
  // `dl-*` block on top (see useDataLinkLayerStack).
  // Re-push when a clock rule ("expires within 7 days") flips for a row.
  const ruleClockTick = useRuleClockTick(styleRules, config.styleRuleIds, filteredEntities, enabled)

  // Focus twin (natively clustered and unclustered configs): up only
  // while one of its rows is focused, removed when focus leaves. Declared
  // before the push so the push of the same commit finds its source.
  const splitFocused = nativeCluster || !clustered
  const wantFocusLayers = enabled && splitFocused && focusKey !== null
  useEffect(() => {
    if (!wantFocusLayers || installTick === 0 || !installedRef.current) return
    try {
      installFocusLayers(map, focusIds, config, visibleRef.current)
    } catch { /* style mid-swap — the next install re-runs this */ }
    return () => safeTeardown(map, () => teardownFocusLayers(map, focusIds))
    // `config` is read at install only (the colour sync above follows edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, wantFocusLayers, installTick, focusIds])

  // ---- runtime clustering inputs (all inert while it is off) -------------
  const zoomBucket = useClusterZoomBucket(map, enabled && runtimeActive)
  const clusterField = runtime?.mode === 'field' ? runtime.field : undefined
  // Per row: its floor (as the floor gate resolves it) and, by field, its value.
  const clusterMeta = useMemo<ReadonlyMap<string, { floor: number | null; part: string }> | null>(() => {
    if (!runtimeActive) return null
    const out = new Map<string, { floor: number | null; part: string }>()
    for (const e of filteredEntities) {
      let floor = resolveEntityFloor(e.payload, null, { field: floorScope?.field, valueMap: floorScope?.valueMap })
      if (floor !== null && liveFloorPlanIds && liveFloorPlanIds.size > 0 && !liveFloorPlanIds.has(floor)) floor = null
      let part = ''
      if (clusterField) {
        const v = readPayloadPath(e.payload, clusterField)
        part = v === undefined || v === null ? '' : String(v)
      }
      out.set(e.entityKey, { floor, part })
    }
    return out
  }, [runtimeActive, filteredEntities, floorScope, liveFloorPlanIds, clusterField])
  const rooms = useMemo<RoomIndex | null>(
    () => (runtime?.mode === 'room' && roomPolygons ? buildRoomIndex(roomPolygons) : null),
    [runtime?.mode, roomPolygons],
  )
  // Ring colour → the name of the first enabled rule (ascending priority)
  // that paints it, for the bubble's hover breakdown.
  const styleRuleIds = config.styleRuleIds
  const clusterColorNames = useMemo<ReadonlyMap<string, string>>(() => {
    if (!runtimeActive) return NO_COLOR_NAMES
    const ruleIds = new Set(styleRuleIds ?? [])
    const out = new Map<string, string>()
    const rules = styleRules
      .filter((r) => r.id !== undefined && ruleIds.has(r.id) && r.enabled !== false)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    for (const r of rules) {
      const colour = r.style?.iconColor ?? r.style?.fillColor
      if (!colour) continue
      const tok = colorToken(colour)
      if (!out.has(tok)) out.set(tok, r.name)
    }
    return out
  }, [runtimeActive, styleRuleIds, styleRules])
  const clusterLayer = useDlClusterLayer(map, configId, {
    enabled: enabled && runtimeActive,
    visible,
    colorNames: clusterColorNames,
    field: clusterField,
  })
  // Viewer heatmap: heat under (or instead of) this config's points.
  const heatOn = pointHeatmap !== null
  const heatOnly = pointHeatmap?.mode === 'only'
  const heatWeight = pointHeatmap?.weightField ?? null
  const heatBarriers = pointHeatmap?.barriers ?? null
  const heatTint = (configId !== undefined && pointHeatmap?.tints?.get(configId)) || null
  // The markers' occluders (same arrays → the same cached prism list): a
  // heat cell behind a wall from the camera is hidden like a marker.
  const heatOccluders = useMemo(
    () =>
      heatOn
        ? buildOccluders({
            images: occluderImages ?? EMPTY_IMAGES,
            polygons: occluderPolygons ?? EMPTY_POLYGONS,
            circles: occluderCircles ?? EMPTY_CIRCLES,
            lines: occluderLines ?? EMPTY_LINES,
            stairs: occluderStairs ?? EMPTY_STAIRS,
          })
        : undefined,
    [heatOn, occluderImages, occluderPolygons, occluderCircles, occluderLines, occluderStairs],
  )
  const heatLayer = useDlHeatmapLayer(map, configId, {
    enabled: enabled && heatOn,
    visible,
    pointsShown: !heatOnly,
    tint: heatTint,
    occluders: heatOccluders,
  })
  // The heatmap counts every filtered row on the floor — also the ones the
  // markers drop as occluded (a tag inside a cold-room volume still makes
  // that room hot) — built without the occlusion set or the focus split, so
  // it is computed once per data change, not on every marker flip. With the
  // host's barriers the heat stops at walls and solid objects.
  const heatFeatures = useMemo(
    () => (heatOn && enabled ? heatCells(buildCoordFeatures(config, filteredEntities, styleRules, polygons).features, heatWeight, heatBarriers) : null),
    [heatOn, enabled, config, filteredEntities, styleRules, polygons, heatWeight, heatBarriers],
  )
  useEffect(() => {
    if (heatFeatures) heatLayer.write(heatFeatures)
  }, [heatLayer, heatFeatures])

  // Turning clustering off: forget the members (the push re-adds the rows).
  useEffect(() => {
    if (runtimeActive || configId === undefined) return
    clearRuntimeClusterMembers(configId)
  }, [runtimeActive, configId])

  const complete = loaded && settled
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // With the twin up, the focused row leaves the base source (a
    // one-feature diff write) and goes to the twin. `features` still holds
    // it (only `outFeatures` leaves it out), so the anchor report finds it.
    const { features, focused } = pushFeatures(
      map, ids, config, filteredEntities, styleRules, polygons, occludedRef.current, writer, rowCache,
      { focusedKey: focusKey, ghosts: ghostsHere, near: nearHere, splitFocused: wantFocusLayers, skipGroupCluster: runtimeActive },
      runtime && configId !== undefined && clusterMeta
        ? { spec: runtime, zoom: zoomBucket, configId, rooms, meta: clusterMeta, layer: clusterLayer }
        : undefined,
    )
    if (wantFocusLayers) focusWriter.write(focused ? [focused] : [], coordFeatureKey)
    // Every drawn row, bubbled or not: the focus anchor report reads them.
    onDrawn(features, complete)
  }, [map, ids, config, filteredEntities, enabled, styleRules, polygons, installTick, occludedRef, occludedVersion, writer, rowCache, ruleClockTick, focusKey, ghostsHere, nearHere, focusWriter, wantFocusLayers, complete, onDrawn, runtime, configId, zoomBucket, rooms, clusterMeta, clusterLayer, runtimeActive])

  // Claim this config's place in the `dl-*` block (replaces the old
  // per-renderer `styledata` raise). The focus twin registers on its
  // own, last, so it sits on top of every config while it is up.
  useDataLinkLayerStack(map, ownLayerIds, enabled)
  useDataLinkLayerStack(map, focusLayerList, wantFocusLayers)

  // ---- visibility toggling -----------------------------------------------
  // "Heatmap only" hides the singles; a focused row's twin stays visible.
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    pushVisibility(map, ids, visible && !heatOnly)
    pushFocusTwinVisibility(map, focusIds, visible)
  }, [map, ids, focusIds, visible, enabled, installTick, heatOnly])

  return (
    <>
      <TooltipManager
        map={map}
        config={config}
        layerIds={tooltipLayerIds}
        occludedKeysRef={occludedRef}
      />
      {loader}
    </>
  )
})

// ---------------------------------------------------------------------------
// Mapbox helpers — one source + up to 5 layers per config
// ---------------------------------------------------------------------------

interface OverlayIds {
  source: string
  cluster: string
  clusterCount: string
  point: string
  icon: string
  label: string
}

function sourceLayerIds(configId: number): OverlayIds {
  return {
    source: `dl-${configId}-src`,
    cluster: `dl-${configId}-cluster`,
    clusterCount: `dl-${configId}-cluster-count`,
    point: `dl-${configId}-point`,
    icon: `dl-${configId}-icon`,
    label: `dl-${configId}-label`,
  }
}

/**
 * Focus twin of a natively clustered or unclustered point-at-coord /
 * history-movement config: its own source holding just the focused row,
 * drawn by copies of the point / icon / label layers on top of every
 * config (so the row is never under the rows sharing its coordinate).
 * `dl-focus-…`: still a `dl-` layer (raised with the block, skipped by
 * the translucent ordering, counted as a hit by focus exit), but not
 * `dl-<configId>-…`, so the container's orphan sweep and the viewer's
 * click routing leave it alone.
 */
interface FocusOverlayIds {
  source: string
  point: string
  icon: string
  label: string
}

function focusLayerIds(configId: number): FocusOverlayIds {
  return {
    source: `dl-focus-${configId}-src`,
    point: `dl-focus-${configId}-point`,
    icon: `dl-focus-${configId}-icon`,
    label: `dl-focus-${configId}-label`,
  }
}

/** Base opacity of the point-at-coord disc (a style rule's `opacity`, 0–1). */
const COORD_DISC_OPACITY: mapboxgl.ExpressionSpecification = [
  '/',
  ['coalesce', ['get', 'opacity'], 1],
  1,
]

/** Opacity of a point symbol drawn at full strength (focus / ghost / NEAR aware). */
const FULL_POINT_OPACITY = pointSymbolOpacity(1)

/**
 * The disc / icon / label layer specs of a point-at-coord config. The
 * focus twin is built from the same specs: no cluster filter, a label
 * that can't lose collision, and — since every feature on its source is
 * the focused row — the same paint resolves to full opacity through 3D
 * content.
 */
function coordSymbolLayers(
  layerIds: { point: string; icon: string; label: string },
  source: string,
  config: DataLinkConfig,
  filter: mapboxgl.ExpressionSpecification,
  twin: { visibility: 'visible' | 'none' } | null,
): mapboxgl.SymbolLayerSpecification[] {
  const defaultColor = config.style.defaultColor ?? '#3b82f6'
  const twinLayout = twin ? { visibility: twin.visibility } : {}
  return [
    // Individual point disc — a symbol (not a circle) so it can be
    // lifted by `symbol-z-offset` when the feature carries an
    // `elevation` property. Mapbox 3.25's `circle` layer has no
    // `circle-z-offset`, which is why every SGV overlay that renders
    // above ground uses a symbol pattern (see map-line-overlay's draw
    // guide comment for the historical context).
    //
    // `symbol-z-elevate` is a `layout` property; `symbol-z-offset` is a
    // `paint` property. Mapbox silently drops `symbol-z-offset` when
    // placed under `layout`, which is what kept the first-floor
    // markers stuck on the ground in the earlier fix.
    {
      id: layerIds.point,
      type: 'symbol',
      source,
      filter,
      layout: {
        ...DISC_LAYOUT,
        // Data-driven text-size — reads the size from each feature's
        // `discSize` property (stamped in pushFeatures). Mapbox
        // recommends this over calling `setLayoutProperty('text-size',…)`
        // per config change because it uses the source-update fast path
        // (see the Mapbox performance guide + issue #1451 where naked
        // setLayoutProperty on text-size intermittently doesn't repaint).
        // Feature-level size also lets style rules override per-record.
        //
        // `discSize` is a DIAMETER in this mode (the editor defaults it
        // to 22) whereas DISC_EM_SCALE converts a radius, hence the /2.
        'text-size': [
          '*',
          ['coalesce', ['get', 'discSize'], 22],
          DISC_EM_SCALE / 2,
        ],
        ...twinLayout,
      },
      paint: {
        'text-color': [
          'coalesce',
          ['get', 'color'],
          defaultColor,
        ],
        // v5.4 — analytic occlusion. Mapbox's `text-occlusion-opacity`
        // uses the depth buffer, whose precision at low zoom is too
        // coarse to tell a marker at elevation 0 from a slab at 0.152m
        // above — so the disc stayed visible under floors and walls
        // until the user zoomed in enough. Occluded rows are left out
        // of the source (useDataLinkOcclusion), which hides them
        // deterministically at every zoom; the focused row and ghost
        // rows read `focused` / `occluded`, NEAR rows `focusNear` (see
        // pointSymbolOpacity).
        'text-opacity': pointSymbolOpacity(COORD_DISC_OPACITY),
        'text-halo-color': '#ffffff',
        'text-halo-width': 2,
        'symbol-z-offset': Z_OFFSET,
        'text-occlusion-opacity': POINT_OCCLUSION_OPACITY,
      },
    },
    // Lucide icon symbol layer. `feature.icon` is stamped in
    // `pushFeatures` per config.style.defaultIcon. The sprite is
    // registered via `ensureDataLinkSprites` before install; missing
    // icons fall through to the coloured disc above so the marker
    // stays visible.
    {
      id: layerIds.icon,
      type: 'symbol',
      source,
      filter,
      layout: {
        'icon-image': ['get', 'icon'],
        // Same data-driven pattern as text-size — features carry their
        // `iconSize` (a Mapbox 0-1+ scale) and the layer reads it. Avoids
        // the setLayoutProperty flakiness Mapbox has around symbol layout
        // updates.
        'icon-size': ['coalesce', ['get', 'iconSize'], 0.7],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // `symbol-z-elevate` stays in layout; `symbol-z-offset` moves to
        // paint. Matching the disc's elevation so the icon rides at the
        // same altitude — otherwise a first-floor marker's icon would
        // sit at ground level while its disc hovers above it.
        'symbol-z-elevate': false,
        ...twinLayout,
      },
      paint: {
        'symbol-z-offset': Z_OFFSET,
        // v5.4 — analytic occlusion (see disc layer comment above).
        'icon-opacity': FULL_POINT_OPACITY,
        'icon-occlusion-opacity': POINT_OCCLUSION_OPACITY,
      },
    },
    // Text label — only visible when the payload key referenced by
    // `fieldMapping.labelField` resolved to a string on the feature.
    {
      id: layerIds.label,
      type: 'symbol',
      source,
      filter,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 11,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        // The focus twin's label never loses collision to another label.
        'text-allow-overlap': twin !== null,
        ...(twin ? { 'text-ignore-placement': true } : {}),
        'symbol-z-elevate': false,
        ...twinLayout,
      },
      paint: {
        'text-color': '#111827',
        // v5.4 — analytic occlusion (see disc layer comment above).
        'text-opacity': FULL_POINT_OPACITY,
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
        'symbol-z-offset': Z_OFFSET,
        'text-occlusion-opacity': POINT_OCCLUSION_OPACITY,
      },
    },
  ]
}

/** Add the focus twin (see FocusOverlayIds) on top of the map. */
function installFocusLayers(
  map: MapboxMapInstance,
  f: FocusOverlayIds,
  config: DataLinkConfig,
  visible: boolean,
): void {
  if (map.getSource(f.source)) teardownFocusLayers(map, f)
  map.addSource(f.source, { type: 'geojson', data: emptyFC() })
  const specs = coordSymbolLayers(
    f, f.source, config, ['literal', true] as mapboxgl.ExpressionSpecification,
    { visibility: visible ? 'visible' : 'none' },
  )
  for (const spec of specs) map.addLayer(spec)
}

function teardownFocusLayers(map: MapboxMapInstance, f: FocusOverlayIds): void {
  if (!mapAlive(map)) return
  for (const layerId of [f.label, f.icon, f.point]) {
    if (hasMapLayer(map, layerId)) map.removeLayer(layerId)
  }
  if (map.getSource(f.source)) map.removeSource(f.source)
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

/**
 * Registry of un-aggregated features per configId. Used by manual
 * clustering (see `pushFeatures`) — when the user clicks a manual
 * cluster in the /view drawer, we need to return the ORIGINAL
 * per-entity features, not the aggregated bubble. Mapbox's
 * `getClusterLeaves` only understands native clusters, so we keep our
 * own lookup here.
 *
 * The map is keyed by configId → raw features array. It's overwritten
 * on every push so the drawer always sees the freshest state.
 */
const manualClusterLeaves = new Map<number, GeoJSON.Feature<GeoJSON.Point>[]>()

export function getManualClusterLeaves(
  configId: number,
  groupKey: string,
): GeoJSON.Feature<GeoJSON.Point>[] {
  const raw = manualClusterLeaves.get(configId)
  if (!raw) return []
  return raw.filter((f) => String(f.properties?.groupKey ?? '') === groupKey)
}

function installSourcesAndLayers(
  map: MapboxMapInstance,
  ids: OverlayIds,
  config: DataLinkConfig,
  /** Runtime clustering is on: no native cluster, a dynamic source. */
  noCluster = false,
): void {
  // A cluster-config swap means the source's `cluster` option has to
  // change; sources can't be mutated in place, so we tear the whole
  // thing down and rebuild. Cheap — one source + max five layers.
  const existing = map.getSource(ids.source)
  if (existing) teardown(map, ids)

  // v5.4 — retry `addLayer` when Mapbox rejects it with "source not
  // found" even though we just added the source. Mapbox 3.x can
  // return `undefined` from `map.getSource()` for a source that IS
  // present on the map (internal style state lags addSource by a
  // frame under some paint-loop timings) — so we can't gate on
  // `getSource` truthfully. Instead: try the addLayer, and only if
  // Mapbox throws "source not found" do we re-install the source
  // and retry once. Guard against infinite loops with a single
  // retry attempt.
  const addLayerGuarded: typeof map.addLayer = (spec, before) => {
    try {
      return map.addLayer(spec, before)
    } catch (err) {
      const msg = (err as Error)?.message ?? ''
      if (!msg.includes('source') || !msg.includes('not found')) throw err
      // Source went missing mid-install — hard-remove it (belt-and-
      // suspenders in case Mapbox has a stale entry) and re-add.
      try { map.removeSource(ids.source) } catch { /* ignore */ }
      map.addSource(ids.source, sourceSpec())
      return map.addLayer(spec, before)
    }
  }

  // When `clusterGroupField` is set (e.g. `currentRoomId`), we disable
  // Mapbox's built-in distance-based clustering entirely and rely on
  // per-group aggregation stamped in `pushFeatures` — see `groupKey`
  // + `manualCluster` handling below. Rationale: Mapbox's cluster
  // aggregator is purely geographic (screen-space radius) and cannot
  // be told "never merge across group boundaries". When left ON in a
  // hospital-room layout it produces bubbles sitting on walls between
  // rooms that visually contain zero markers. The user's ask —
  // clusters that respect polygon/area — needs a semantic (not
  // geographic) grouping key, which Mapbox doesn't natively support.
  const groupField = config.fieldMapping.clusterGroupField
  const useManualCluster = !!groupField
  const shouldCluster = config.style.cluster === true && !useManualCluster && !noCluster
  // Closure over the same cluster settings so `addLayerGuarded`
  // above can re-add the source with the SAME spec if it got yanked
  // mid-install. Cluster-related keys are OMITTED (not `undefined`)
  // when clustering is off — Mapbox's source validator rejects
  // `clusterProperties: undefined` on a non-clustered GeoJSON source
  // with the confusingly-worded "object expected, object found".
  function sourceSpec(): mapboxgl.SourceSpecification {
    const base: mapboxgl.GeoJSONSourceSpecification = {
      type: 'geojson',
      data: emptyFC(),
      // v5.4 — promote `entityKey` to the feature id so the analytic
      // occlusion pass below can `setFeatureState({id: entityKey,
      // occluded: true|false})` per marker. Without this, feature-state
      // has no stable key and every occlusion recomputation would have
      // to regenerate the whole FeatureCollection.
      promoteId: 'entityKey',
    }
    if (shouldCluster) {
      base.cluster = true
      // 20 (was 17) — allow small clusters to persist at close zoom so
      // tightly-packed warehouse assets group instead of overlapping as
      // individual dots. Individual markers still show once the user
      // zooms past 20.
      base.clusterMaxZoom = 20
      base.clusterRadius = config.style.clusterRadius ?? 22
      // Aggregated features are synthesised by supercluster and inherit
      // none of the leaves' properties, so without this a cluster bubble
      // over a first-floor aisle drops back to ground level. `max` (not
      // an average) keeps the bubble on the highest floor it covers,
      // which is the one the user is looking down at. The manual-cluster
      // path does its own averaging in pushFeatures.
      base.clusterProperties = {
        elevation: ['max', ['coalesce', ['get', 'elevation'], 0]],
      }
    } else {
      // Unclustered points take diff-only `updateData` writes (see
      // geojson-diff-writer.ts): a poll or SSE refresh that changed a
      // few rows re-sends those rows, not the whole collection. Point
      // symbols draw the same from a dynamic source — the anchor maths
      // matches geojson-vt's, and an anchor outside its tile is dropped
      // either way. Not for clustered sources: supercluster would then
      // be fed the dynamic index's internal features.
      base.dynamic = true
    }
    return base
  }
  map.addSource(ids.source, sourceSpec())

  const defaultColor = config.style.defaultColor ?? '#3b82f6'
  // v4 — per-marker sizes flow through the feature properties
  // (`discSize` + `iconSize` stamped in pushFeatures). The layer
  // expressions read them with `['coalesce', ['get', 'discSize'], 22]`
  // / `['coalesce', ['get', 'iconSize'], 0.7]`. This is the Mapbox-
  // recommended data-driven path — avoids the known symbol-layer
  // `setLayoutProperty('text-size', …)` staleness bugs.

  // Cluster bubbles + count label — matched by either Mapbox's native
  // `point_count` property OR our own `manualCluster` marker. Both
  // paths share paint, so a config toggling between modes doesn't
  // change what a cluster looks like — only whether it can straddle
  // room boundaries.
  const clusterFilter: mapboxgl.ExpressionSpecification = useManualCluster
    ? (['==', ['get', 'manualCluster'], true] as mapboxgl.ExpressionSpecification)
    : (['has', 'point_count'] as mapboxgl.ExpressionSpecification)
  const nonClusterFilter: mapboxgl.ExpressionSpecification = useManualCluster
    ? (['!=', ['get', 'manualCluster'], true] as mapboxgl.ExpressionSpecification)
    : (['!', ['has', 'point_count']] as mapboxgl.ExpressionSpecification)

  if (shouldCluster || useManualCluster) {
    // Bubble drawn as a `●` symbol rather than a circle: circles can
    // neither carry `symbol-z-offset` nor be depth-occluded, so a
    // circle bubble would sit on the ground and shine through the floor
    // above it. Radii 14/18/22/28 px become em-box sizes via
    // DISC_EM_SCALE so the bubble keeps the size it had before.
    addLayerGuarded({
      id: ids.cluster,
      type: 'symbol',
      source: ids.source,
      filter: clusterFilter,
      layout: {
        ...DISC_LAYOUT,
        'text-size': [
          'step',
          ['get', 'point_count'],
          14 * DISC_EM_SCALE, 25,
          18 * DISC_EM_SCALE, 100,
          22 * DISC_EM_SCALE, 500,
          28 * DISC_EM_SCALE,
        ],
      },
      paint: {
        'text-color': [
          'step',
          ['get', 'point_count'],
          defaultColor, 25,
          '#6366f1', 100,
          '#7c3aed', 500,
          '#a21caf',
        ],
        'text-opacity': 0.9,
        'text-halo-color': '#ffffff',
        'text-halo-width': 2,
        'symbol-z-offset': Z_OFFSET,
        'text-occlusion-opacity': 0,
      },
    })
    addLayerGuarded({
      id: ids.clusterCount,
      type: 'symbol',
      source: ids.source,
      filter: clusterFilter,
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-size': 12,
        'text-allow-overlap': true,
        'symbol-z-elevate': false,
      },
      paint: {
        'text-color': '#ffffff',
        'symbol-z-offset': Z_OFFSET,
        'text-occlusion-opacity': 0,
      },
    })
    // A group field with `style.cluster` off (every seeded
    // history-movement layer) installs both bubble layers, but no bubble
    // is ever built, so they would only cost a style re-evaluation and a
    // placement pass every frame. Hint them empty for the empty-layer
    // gate (`@/lib/data-link/dl-layer-gate`); `pushFeatures` clears the
    // hint if a bubble ever turns up. Set unconditionally so a hint left
    // by the previous style (a style swap drops layers without
    // `removeLayer`) never carries over. Native clusters are built on the
    // worker, so those layers are never hinted.
    const alwaysEmpty = useManualCluster && manualClusterLayersAlwaysEmpty(config) ? true : null
    hintLayerEmpty(map, ids.cluster, alwaysEmpty)
    hintLayerEmpty(map, ids.clusterCount, alwaysEmpty)
  }

  // Disc, icon and label (see coordSymbolLayers).
  const pointFilter = (shouldCluster || useManualCluster)
    ? nonClusterFilter
    : (['literal', true] as mapboxgl.ExpressionSpecification)
  for (const spec of coordSymbolLayers(ids, ids.source, config, pointFilter, null)) {
    addLayerGuarded(spec)
  }
}

/**
 * False once the map has been removed (`map.remove()` drops its style).
 * Leaving a page unmounts MapboxMap — which removes the map — before
 * this overlay's cleanup runs, and `getLayer` on a removed map throws
 * ("reading 'getOwnLayer'"). The layers went with the map, so there is
 * nothing left to tear down.
 */
function mapAlive(map: MapboxMapInstance | null | undefined): map is MapboxMapInstance {
  const m = map as unknown as { style?: unknown; _removed?: boolean } | null | undefined
  return Boolean(m?.style) && !m?._removed
}

/** Run a teardown only on a live map; a style mid-swap can still throw. */
function safeTeardown(map: MapboxMapInstance, fn: () => void): void {
  if (!mapAlive(map)) return
  try {
    fn()
  } catch {
    /* style swapping — the next install re-creates everything */
  }
}

function teardown(map: MapboxMapInstance, ids: OverlayIds): void {
  if (!mapAlive(map)) return
  for (const layerId of [ids.label, ids.icon, ids.point, ids.clusterCount, ids.cluster]) {
    if (hasMapLayer(map, layerId)) map.removeLayer(layerId)
  }
  if (map.getSource(ids.source)) map.removeSource(ids.source)
}

/**
 * Build the config's point features (`buildCoordFeatures` — field
 * mapping, rules, manual clusters) and write them to its source.
 * Entities whose payload doesn't yield a usable (lng, lat) are skipped
 * — those won't render, but we don't error, since the ingest pipeline
 * accepts arbitrary payloads.
 *
 * Rows whose object is unchanged since the last push reuse their
 * feature (`cache`), and the writer then sends the source only what
 * changed. Occluded rows are left out (v5.4 hard-hide), so an
 * occlusion change removes or re-adds just those rows. Focus mode
 * (`focus`): the focused row is never left out and is stamped
 * `focused: true`; ghost mode keeps occluded rows as `occluded: true`.
 * Returns the build, so the caller can draw a split-off focused row and
 * report where the focused row went.
 */
function pushFeatures(
  map: MapboxMapInstance,
  ids: OverlayIds,
  config: DataLinkConfig,
  entities: EntityState[],
  styleRules: ReadonlyArray<StyleRule>,
  polygons: ReadonlyArray<PolygonShape> | undefined,
  /** v5.4 — entity keys currently occluded; those rows are skipped.
   *  Empty / omitted means nothing hidden. */
  occludedKeys: ReadonlySet<string> | undefined,
  writer: GeoJSONDiffWriter,
  cache: RowBuildCache<GeoJSON.Feature<GeoJSON.Point> | null>,
  focus?: CoordFocusOptions,
  /** Runtime clustering (see pushClustered); unset = today's path. */
  runtime?: RuntimeClusterPush,
): CoordFeaturesResult {
  const result = buildCoordFeatures(
    config,
    entities,
    styleRules,
    polygons,
    occludedKeys,
    cache,
    focus,
  )
  const { features, outFeatures, manualClusterActive, focused } = result

  if (runtime) {
    if (config.id !== undefined) manualClusterLeaves.delete(config.id)
    pushClustered(config, outFeatures, focused, writer, runtime)
    return result
  }

  // Stash the un-aggregated feature list so the /view drawer can
  // expand manual clusters into their leaves later. The focused row is
  // drawn on its own, so it is no bubble's leaf.
  if (manualClusterActive && config.id !== undefined) {
    manualClusterLeaves.set(config.id, focused ? features.filter((f) => f !== focused) : features)
  } else if (config.id !== undefined) {
    manualClusterLeaves.delete(config.id)
  }

  // The bubble layers may carry an "always empty" gate hint from install
  // (see installSourcesAndLayers). If this push carries a bubble anyway,
  // show the layers before the write goes out, so the hint can never
  // hold a bubble back.
  if (anyManualClusterFeature(outFeatures)) {
    hintLayerEmpty(map, ids.cluster, null)
    hintLayerEmpty(map, ids.clusterCount, null)
  }

  writer.write(outFeatures, coordFeatureKey)
  return result
}

interface RuntimeClusterPush {
  spec: PointClusterSpec
  /** `clusterZoomBucket` of the settled camera. */
  zoom: number
  configId: number
  rooms: RoomIndex | null
  /** Per entity key: its floor and (field mode) value. */
  meta: ReadonlyMap<string, { floor: number | null; part: string }>
  layer: DlClusterLayerHandle
}

const NO_COLOR_NAMES: ReadonlyMap<string, string> = new Map()

/**
 * Runtime clustering's half of the push: fold the drawable rows into
 * bubbles (`clusterPoints`), write the rows that stay single to the
 * config's own source (original order, the existing diff writer) and the
 * bubbles to the runtime layer. The focused row and ghost rows are never
 * members: they pass through as singles.
 */
function pushClustered(
  config: DataLinkConfig,
  outFeatures: readonly GeoJSON.Feature<GeoJSON.Point>[],
  focused: GeoJSON.Feature<GeoJSON.Point> | null,
  writer: GeoJSONDiffWriter,
  rt: RuntimeClusterPush,
): void {
  const defaultColor = config.style.defaultColor ?? '#3b82f6'
  const items: ClusterItem[] = []
  for (const f of outFeatures) {
    const p = f.properties
    if (f === focused || !p || p.occluded === true || p.focused === true) continue
    const key = p.entityKey
    if (typeof key !== 'string') continue
    const meta = rt.meta.get(key)
    const elevation = Number(p.elevation)
    items.push({
      key,
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      elevation: Number.isFinite(elevation) ? elevation : 0,
      color: typeof p.color === 'string' && p.color ? p.color : defaultColor,
      floor: meta?.floor ?? null,
      part: meta?.part ?? '',
    })
  }
  const result = clusterPoints(items, rt.spec, rt.zoom, { configId: rt.configId, rooms: rt.rooms })
  const singles = result.memberKeys.size === 0
    ? outFeatures
    : outFeatures.filter((f) => {
        const key = f.properties?.entityKey
        return f === focused || f.properties?.occluded === true || typeof key !== 'string' || !result.memberKeys.has(key)
      })
  writer.write(singles, coordFeatureKey)
  setRuntimeClusterMembers(rt.configId, result.members)
  rt.layer.write(result.bubbles)
}

/**
 * Writer identity for a point-at-coord feature: the entity key, or the
 * group key for a manual-cluster bubble. Duplicates are told apart by
 * the writer itself.
 */
function coordFeatureKey(f: GeoJSON.Feature): string {
  const p = f.properties
  if (p?.manualCluster === true) return `g:${String(p.groupKey ?? '')}`
  return `e:${String(p?.entityKey ?? '')}`
}

function pushVisibility(
  map: MapboxMapInstance,
  ids: OverlayIds,
  visible: boolean,
  focusIds?: FocusOverlayIds,
): void {
  const value = visible ? 'visible' : 'none'
  const layerIds = [ids.cluster, ids.clusterCount, ids.point, ids.icon, ids.label]
  // The focus twin, when it is up (it installs with the current value).
  if (focusIds) layerIds.push(focusIds.point, focusIds.icon, focusIds.label)
  for (const layerId of layerIds) {
    if (hasMapLayer(map, layerId)) {
      map.setLayoutProperty(layerId, 'visibility', value)
    }
  }
}

function pushFocusTwinVisibility(map: MapboxMapInstance, focusIds: FocusOverlayIds, visible: boolean): void {
  const value = visible ? 'visible' : 'none'
  for (const layerId of [focusIds.point, focusIds.icon, focusIds.label]) {
    if (hasMapLayer(map, layerId)) map.setLayoutProperty(layerId, 'visibility', value)
  }
}

// ---------------------------------------------------------------------------
// Shared helpers for the shape-anchored sub-renderers below
// ---------------------------------------------------------------------------
//
// The feature builders themselves (anchor resolution, rule overrides,
// per-mode geometry) live in `@/lib/data-link/feature-builders`.

/**
 * One diff writer per (map, source id) for the sub-renderer's lifetime.
 * See `@/lib/geojson-diff-writer`: on a `dynamic` source it sends only
 * the features that changed; on any other source it calls `setData`, and
 * skips a write whose features are all the same objects as last time.
 */
function useSourceWriter(map: MapboxMapInstance, sourceId: string): GeoJSONDiffWriter {
  const writer = useMemo(() => createGeoJSONDiffWriter(map, sourceId), [map, sourceId])
  useEffect(() => () => writer.dispose(), [writer])
  return writer
}

/** Writer identity for a per-entity feature (shape-anchored point modes). */
function entityFeatureKey(f: GeoJSON.Feature): string {
  return String(f.properties?.entityKey ?? '')
}

/**
 * One `move` listener per map for every data-link occlusion pass. Each
 * sub-renderer of each config used to register its own; now they join
 * the map's pass and it runs them all, in join order, inside the same
 * synchronous `move` — so results land on the same frame as before.
 * Keyed per map instance, so a remounted map gets a fresh listener.
 */
const dataLinkOcclusionPasses = new WeakMap<
  MapboxMapInstance,
  { jobs: Set<() => void>; onMove: () => void }
>()

function joinDataLinkOcclusionPass(map: MapboxMapInstance, job: () => void): () => void {
  let pass = dataLinkOcclusionPasses.get(map)
  if (!pass) {
    const jobs = new Set<() => void>()
    pass = {
      jobs,
      onMove: () => {
        for (const run of jobs) run()
      },
    }
    dataLinkOcclusionPasses.set(map, pass)
  }
  const joined = pass
  if (joined.jobs.size === 0) map.on('move', joined.onMove)
  joined.jobs.add(job)
  return () => {
    if (!joined.jobs.delete(job)) return
    if (joined.jobs.size === 0) map.off('move', joined.onMove)
  }
}

/**
 * How far past twice the live row count `useDataLinkOcclusion`'s id
 * table may grow before it is compacted.
 */
const OCCLUSION_ID_SLACK = 1024

function sameKeySet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

/**
 * v5.4 — analytic occlusion pass shared by every sub-renderer.
 *
 * Same solver the marker + text-label overlays use: for each entity,
 * clip the camera → entity segment to every occluder prism's altitude
 * slab and ask whether the surviving span crosses the footprint.
 * Anything on a floor plate above the entity, or a wall / rack in the
 * way at tilt, marks the entity as occluded.
 *
 * Runs on every `move` because occlusion is a function of the camera,
 * not the data — through the map's shared pass
 * (`joinDataLinkOcclusionPass`) and `updateOcclusion`, which projects
 * the targets once per data change, skips repeat camera positions and
 * reports only what flipped. Hiding is a hard-hide: the sub-renderer
 * re-pushes with the occluded rows left out (heatmap density, shape
 * tints, ROI counts, clusters and label collision all depend on the
 * row being absent, which feature-state opacity could not reproduce),
 * so React state bumps only on an actual change of the set.
 *
 * Returns a ref pointing at the current occluded-key set so the
 * TooltipManager can also skip hover / click on hidden entities —
 * `queryRenderedFeatures` doesn't respect paint opacity and would
 * otherwise open a tooltip over a marker the user can't see.
 */
function useDataLinkOcclusion({
  map,
  enabled,
  installTick: _installTick,
  config,
  entities,
  filter = null,
  focusKey = null,
  images: propImages,
  polygons: propPolygons,
  circles: propCircles,
  lines: propLines,
  stairs: propStairs,
}: {
  map: MapboxMapInstance | null
  enabled: boolean
  /** Bumped when install completes; re-runs the effect so state gets
   *  applied on the newly-attached source. */
  installTick: number
  config: DataLinkConfig
  /**
   * The rows the sub-renderer draws from. Pass the already-filtered list
   * when it has one (point-at-coord pushes `filteredEntities`) — a row
   * that is never drawn needn't be tested, nor re-push on a flip.
   */
  entities: readonly EntityState[]
  /**
   * The layer filter, ONLY when the sub-renderer's builder drops every
   * row whose own payload fails it (all modes except history-movement,
   * whose filter reads the events'). Those rows are skipped here too.
   */
  filter?: DataLinkFilter | null
  /**
   * Focus mode: the focused row of this config. It is never a target, so
   * it is never occluded — and if it was, `updateOcclusion` reports it in
   * `left` and the row is re-pushed visible.
   */
  focusKey?: string | null
  images?: ReadonlyArray<ImageShape>
  polygons?: ReadonlyArray<PolygonShape>
  circles?: ReadonlyArray<CircleShape>
  lines?: ReadonlyArray<LineShape>
  stairs?: ReadonlyArray<StairShape>
}): {
  occludedRef: React.RefObject<Set<string>>
  /**
   * Bumps every time the occluded set actually changes (not on every
   * `move` — only on set-diff). Sub-renderers include this in the
   * pushFeatures deps so the occluded rows leave (or re-enter) the
   * source.
   */
  occludedVersion: number
} {
  // v5.4 — occluders arrive as PROPS from the host. Neither
  // `useSpatialPolygons()` nor a direct `useSpatialStore` selector
  // works in share-link mode: that route (`/share/…`) never
  // populates the spatial store — shapes come inside the share
  // payload (`data.polygons` etc.) and are already threaded through
  // to `MapDataLinkedOverlay` as props. Reading from the store gave
  // 0 prisms and nothing was ever occluded. The host is the single
  // source of truth.
  // Shared empties, not `?? []`: a fresh array every render rebuilt the
  // prisms (and re-registered the `move` pass) on every render.
  const storeImages = propImages ?? EMPTY_IMAGES
  const storePolygons = propPolygons ?? EMPTY_POLYGONS
  const storeCircles = propCircles ?? EMPTY_CIRCLES
  const storeLines = propLines ?? EMPTY_LINES
  const storeStairs = propStairs ?? EMPTY_STAIRS
  // Every sub-renderer gets the same arrays, so `buildOccluders` hands
  // them all the same list — and with it one shared spatial index.
  const prisms = useMemo(
    () =>
      buildOccluders({
        images: storeImages,
        polygons: storePolygons,
        circles: storeCircles,
        lines: storeLines,
        stairs: storeStairs,
      }),
    [storeImages, storePolygons, storeCircles, storeLines, storeStairs],
  )
  const occludedRef = useRef<Set<string>>(new Set())
  const [occludedVersion, setOccludedVersion] = useState(0)
  // One numeric id per entity key (`keys[id]` is the key), kept across
  // `entities` changes, so the ids `updateOcclusion` diffs mean the same
  // row from one run to the next and its `entered` / `left` are exactly
  // the keys that flipped. `state.last` always holds the ids of
  // `occludedRef`, except right after a compaction (below).
  const [occlusion] = useState(() => ({
    state: createOcclusionState(),
    idOfKey: new Map<string, number>(),
    keys: [] as string[],
  }))
  useEffect(() => {
    if (!map || !enabled) return
    const { state, idOfKey, keys } = occlusion
    // Keys that leave the rows keep their ids (a track window rolling
    // past short-lived keys, a deleted table row), so the table would
    // grow for as long as the tab stays open. Once it holds more than
    // about twice the live rows, start it again from the current rows
    // and forget what the core reported. Nothing can be diffed by id
    // then, so the first pass compares the occluded KEYS with
    // `occludedRef` and re-pushes only if they differ.
    let resync = false
    if (keys.length > 2 * entities.length + OCCLUSION_ID_SLACK) {
      idOfKey.clear()
      keys.splice(0, keys.length)
      resetOcclusionState(state)
      resync = true
    }
    const targets: OccludableTarget[] = []
    for (const e of entities) {
      if (!e.entityKey) continue
      if (focusKey !== null && e.entityKey === focusKey) continue
      if (filter && !evaluateDataLinkFilter(e.payload, filter)) continue
      const lngLat = resolvePayloadCoord(e.payload, config) ?? e.position
      if (!lngLat) continue
      const altitudeM = resolveAnchorElevation(e.payload, config, null)
      let id = idOfKey.get(e.entityKey)
      if (id === undefined) {
        id = keys.length
        idOfKey.set(e.entityKey, id)
        keys.push(e.entityKey)
      }
      targets.push({
        id,
        position: lngLat,
        elevationM: altitudeM,
        floorPlanId: (e.payload?.floorPlanId as number | undefined) ?? undefined,
      })
    }
    const apply = () => {
      const { occluded, entered, left } = updateOcclusion(map, targets, prisms, state)
      if (!resync && entered.length === 0 && left.length === 0) return
      const next = new Set<string>()
      for (const id of occluded) next.add(keys[id])
      if (resync) {
        resync = false
        if (sameKeySet(next, occludedRef.current)) return
      }
      occludedRef.current = next
      // Trigger a re-push so the hidden rows leave (or re-enter) the
      // source. Only on a real change, so a slow pan (same visibility
      // for every frame) doesn't spam writes.
      setOccludedVersion((v) => v + 1)
    }
    apply()
    return joinDataLinkOcclusionPass(map, apply)
  }, [map, enabled, _installTick, entities, filter, focusKey, prisms, config, occlusion])

  return { occludedRef, occludedVersion }
}

/** setTimeout's longest delay. A later instant is reached in steps. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Re-check trigger for style rules that read the clock (`olderThan` /
 * `newerThan`, e.g. "expires within 7 days"). Their answer for a row
 * changes with time alone, but a layer only re-pushes when its inputs
 * change, so an open view kept an expired item in its "expiring" colour.
 *
 * Returns a counter that bumps at the first instant one of `rows` flips
 * a clock condition of the config's rules. The sub-renderer puts it in
 * its push-effect deps, and the builders re-evaluate every row
 * (`timeDependent` rules skip the per-row cache). Nothing is armed, and
 * nothing re-pushes, when the config has no clock rule or no row will
 * flip. Pass the rows the builder evaluates the rules on.
 */
function useRuleClockTick(
  styleRules: ReadonlyArray<StyleRule>,
  styleRuleIds: ReadonlyArray<number>,
  rows: ReadonlyArray<{ payload: Record<string, unknown> }>,
  enabled: boolean,
): number {
  const rules = compileEntityRules(styleRules, styleRuleIds)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled || !rules.timeDependent) return
    let due = nextRuleClockChange(rules, rows, Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    function arm() {
      if (due === null) return
      timer = setTimeout(check, Math.min(Math.max(0, due - Date.now()), MAX_TIMER_MS))
    }
    function check() {
      timer = undefined
      if (due === null) return
      const now = Date.now()
      // Woken early, or by one step of a delay longer than a timer takes.
      if (now < due) {
        arm()
        return
      }
      setTick((t) => t + 1)
      due = nextRuleClockChange(rules, rows, now)
      arm()
    }
    // A hidden tab's timers are throttled; catch up as soon as it shows.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || due === null || Date.now() < due) return
      if (timer !== undefined) clearTimeout(timer)
      check()
    }
    arm()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, rules, rows])
  return tick
}

type SpatialStoreState = ReturnType<typeof useSpatialStore.getState>

/** Prop-supplied shape arrays that stand in for store slices. */
type ShapeOverrides = Partial<
  Pick<MatchStoreSnapshot, 'polygons' | 'circles' | 'markers' | 'lines' | 'models'>
>

/** The prop array that replaces the store slice for `kind`, if any. */
function overrideForKind(
  kind: DataLinkConfig['targetKind'],
  overrides: ShapeOverrides,
): readonly MatchableShape[] | undefined {
  switch (kind) {
    case 'polygon': return overrides.polygons
    case 'circle':  return overrides.circles
    case 'marker':  return overrides.markers
    case 'line':    return overrides.lines
    case 'model':   return overrides.models
    default:        return undefined
  }
}

/** The store slice the resolver reads for `kind` (`shapesForKind`). */
function storeShapesForKind(
  s: SpatialStoreState,
  kind: DataLinkConfig['targetKind'],
): readonly MatchableShape[] {
  switch (kind) {
    case 'polygon':    return s.polygons
    case 'circle':     return s.circles
    case 'marker':     return s.markers
    case 'line':       return s.lines
    case 'stair':      return s.stairs
    case 'door':       return s.doors
    case 'image':      return s.images
    case 'model':      return s.models
    case 'text-label': return s.textLabels
    default:           return NO_SHAPES
  }
}

/**
 * The store slices the match resolver reads for this config, as one
 * memoised snapshot.
 *
 * The resolver only ever reads the config's `targetKind` slice (via
 * `shapesForKind`) and, for a `bin.*` shape side (`external-code`, or
 * an attribute-join on `bin.externalCode` / `bin.customProp`), `bins`.
 * Every other slot is left empty, and only those two slices are
 * subscribed: a bins SSE event no longer re-pushes a name-joined layer,
 * and a door edit no longer re-pushes a polygon layer. The returned
 * object keeps its identity until one of them changes, which keeps the
 * resolver's join index and the per-row feature cache warm.
 *
 * `overrides` lets callers substitute prop-supplied shape arrays for
 * store slices. Share-link / public-view code paths render without
 * `useSpatialStore` populated — the shapes arrive as props from the
 * share endpoint — so an attribute-join sub-renderer must feed those
 * props into the resolver, otherwise every match returns "no polygon
 * where name = X" even though the map draws them fine.
 */
function useMatchSnapshot(
  config: DataLinkConfig,
  overrides: ShapeOverrides,
): MatchStoreSnapshot {
  const kind = config.targetKind
  const readsBins = matchReadsBins(config)
  const override = overrideForKind(kind, overrides)
  const bins = useSpatialStore((s) => (readsBins ? s.bins : EMPTY_BINS))
  const storeShapes = useSpatialStore((s) =>
    override === undefined ? storeShapesForKind(s, kind) : NO_SHAPES,
  )
  const shapes = override ?? storeShapes
  return useMemo(() => narrowMatchSnapshot(kind, shapes, bins), [kind, shapes, bins])
}

/**
 * Generic style-loaded install harness used by every shape-anchored
 * sub-renderer. `install` builds the sources/layers; `teardownFn`
 * removes them. Returns the whenStyleLoaded cleanup.
 */
function useStyleReadyInstall(
  map: MapboxMapInstance,
  enabled: boolean,
  install: () => void,
  teardownFn: () => void,
  tag: string,
  deps: React.DependencyList,
  installedRef: React.MutableRefObject<boolean>,
  /**
   * Optional signal fired AFTER the install callback completes so
   * downstream effects (style-sync, `installTick`-gated pushes) get a
   * real re-render trigger. Mutating installedRef alone doesn't wake
   * React up — dedicated sync effects would race the async install
   * and permanently skip. Sub-renderers that expose per-mode style
   * knobs pass a `useState` bumper here.
   */
  onInstalled?: () => void,
): void {
  useEffect(() => {
    if (!enabled) {
      safeTeardown(map, teardownFn)
      installedRef.current = false
      return
    }
    const detach = whenStyleLoaded(
      map,
      () => {
        install()
        installedRef.current = true
        onInstalled?.()
      },
      tag,
    )
    // Compose the style-load listener detach with a full teardown so
    // React's own unmount cleanup (parent stopped rendering this
    // sub-renderer — e.g. the layer visibility toggle filtered its
    // config out) removes the mapbox source + layer. Before this,
    // detach only unhooked the listener and the layer painted forever.
    return () => {
      detach()
      safeTeardown(map, teardownFn)
      installedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/**
 * Keep this sub-renderer's layers on top of the map, as its own slice of
 * the `dl-*` block (`@/lib/data-link/dl-layer-stack`). Configs stack in
 * the order they registered, each in its own fixed layer order — the
 * order the per-renderer `styledata` listeners this replaces settled on.
 * The container re-raises the block on `styledata`, guarded, so nothing
 * moves (and no new `styledata` fires) while the block is already on top.
 */
function useDataLinkLayerStack(
  map: MapboxMapInstance,
  layerIds: readonly string[],
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return
    const release = registerDataLinkLayers(map, layerIds)
    try {
      raiseDataLinkLayers(map)
    } catch { /* style not ready — the container's styledata pass catches up */ }
    return release
  }, [map, layerIds, enabled])
}

function setGeoJSONData(
  map: MapboxMapInstance,
  sourceId: string,
  data: GeoJSON.FeatureCollection,
): void {
  const src = map.getSource(sourceId) as unknown as
    | { setData: (data: GeoJSON.FeatureCollection) => void }
    | undefined
  if (src && typeof src.setData === 'function') src.setData(data)
}

// ---------------------------------------------------------------------------
// point-on-shape sub-renderer
// ---------------------------------------------------------------------------

/**
 * N sensors mounted on one shape: renders one point (+ label) per
 * entity at the bound shape's centroid. Every entity stacks at the
 * same coord; typical use is one-sensor-per-shape where the stack is
 * a single dot.
 */
const PointOnShapeSubRenderer = memo(function PointOnShapeSubRenderer({
  map,
  config,
  visible,
  enabled,
  styleRules,
  polygons,
  circles,
  markers,
  lines,
  models,
  activeFloorPlanId,
  liveFloorPlanIds,
  filter,
  occluderImages,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  occluderStairs,
}: SubRendererProps & ShapeAnchorProps) {
  const tenantId = useCurrentTenantId()
  const layerPollMs = useLayerPollMs()
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: layerPollMs, enabled },
  )
  const { entities, playbackActive } = useEffectiveEntities(config, useLayerRows(config, query))
  // Focus mode (see the point-at-coord sub-renderer).
  const focus = useConfigFocus(config)
  const loaded = playbackActive || query.data !== undefined
  const { rows, settled, loader } = useFocusedRows(config, entities, focus.key, loaded, !playbackActive)
  const onDrawn = useFocusAnchorReport(config, focus, liveFloorPlanIds)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const pointId = `dl-${config.id}-point`
  const iconId = `dl-${config.id}-icon`
  const labelId = `dl-${config.id}-label`
  const ownLayerIds = useMemo(
    () => [pointId, iconId, labelId],
    [pointId, iconId, labelId],
  )
  // Diff-only writes to the (dynamic) source + per-row feature cache.
  const writer = useSourceWriter(map, sourceId)
  const [rowCache] = useState(() =>
    createRowBuildCache<{ row: RowAnchors; features: GeoJSON.Feature<GeoJSON.Point>[] }>(),
  )

  const teardownFn = () => {
    if (hasMapLayer(map, labelId)) map.removeLayer(labelId)
    if (hasMapLayer(map, iconId)) map.removeLayer(iconId)
    if (hasMapLayer(map, pointId)) map.removeLayer(pointId)
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }

  useStyleReadyInstall(
    map,
    enabled,
    () => {
      if (map.getSource(sourceId)) teardownFn()
      // Sprite catalog registration mirrors PointAtCoord — safe to
      // call every install; WeakMap-cached inside the helper.
      void ensureDataLinkSpritesFor(
        map,
        [config.style.defaultIcon ?? 'map-pin'],
        { color: config.style.iconColor },
      )
      // `dynamic`: diff-only writes (see the point-at-coord source).
      map.addSource(sourceId, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey', dynamic: true })
      const defaultColor = config.style.defaultColor ?? '#3b82f6'
      // v4 — sizes flow via feature properties (stamped in this
      // sub-renderer's push-features effect). Layer expressions read
      // them so a slider change → source.setData → instant relayout.
      // Coloured background disc BEHIND the icon. Drawn as a `●`
      // symbol, not a circle: `discSize` is a RADIUS here (the editor
      // defaults it to 11 for this mode, vs 22 as a diameter for
      // point-at-coord), so DISC_EM_SCALE is applied to the radius to
      // land on the same pixel size the circle had.
      map.addLayer({
        id: pointId,
        type: 'symbol',
        source: sourceId,
        layout: {
          ...DISC_LAYOUT,
          'text-size': [
            '*',
            ['coalesce', ['get', 'discSize'], 11],
            DISC_EM_SCALE,
          ],
        },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], defaultColor],
          // Analytic occlusion leaves occluded rows out; focus / ghost /
          // NEAR rows read their flags (see pointSymbolOpacity).
          'text-opacity': FULL_POINT_OPACITY,
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': POINT_OCCLUSION_OPACITY,
        },
      })
      map.addLayer({
        id: iconId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'icon-image': ['get', 'icon'],
          // Data-driven to sidestep Mapbox's known symbol layout
          // update flakiness (issue #1451 + related).
          'icon-size': ['coalesce', ['get', 'iconSize'], 0.7],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-z-elevate': false,
        },
        paint: {
          'symbol-z-offset': Z_OFFSET,
          'icon-opacity': FULL_POINT_OPACITY,
          'icon-occlusion-opacity': POINT_OCCLUSION_OPACITY,
        },
      })
      map.addLayer({
        id: labelId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, 1.6],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'symbol-z-elevate': false,
        },
        paint: {
          'text-color': '#111827',
          'text-opacity': FULL_POINT_OPACITY,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': POINT_OCCLUSION_OPACITY,
        },
      })
    },
    teardownFn,
    `[map-dl:point-on-shape:${config.name}]`,
    [map, enabled, sourceId],
    installedRef,
    () => setInstallTick((t) => t + 1),
  )

  // ---- style sync: colour only (sizes flow via feature props) ---------
  // See the note on the point-at-coord sync effect: sizes are now
  // read from `feature.properties.discSize` / `iconSize` via the
  // install-time `['coalesce', ['get', ...], fallback]` expressions.
  // When the user drags a slider, config changes → the features-push
  // effect below re-runs → source.setData with new stamps → Mapbox
  // relayouts on the fast path. Only color still needs an explicit
  // paint sync (it's a paint property so setPaintProperty works
  // instantly).
  useEffect(() => {
    if (!enabled || !map) return
    const defaultColor = config.style.defaultColor ?? '#3b82f6'
    try {
      if (hasMapLayer(map, pointId)) {
        map.setPaintProperty(pointId, 'text-color', [
          'coalesce',
          ['get', 'color'],
          defaultColor,
        ])
      }
    } catch { /* mid-teardown */ }
  }, [
    map,
    enabled,
    installTick,
    pointId,
    config.style.defaultColor,
  ])

  const snapshot = useMatchSnapshot(config, { polygons, circles, markers, lines, models })

  // v5.4 — analytic occlusion. Declared before the push effect so
  // `occludedVersion` is available as a dep — the push re-runs when
  // the occluded set changes so each feature's `occluded` property
  // re-stamps.
  const { occludedRef: pointOnShapeOccludedRef, occludedVersion: pointOnShapeOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities: rows,
    // Its builder drops rows failing the layer filter.
    filter,
    focusKey: focus.key,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // Push features when entities OR the resolver's inputs change. v2:
  // for each entity, look up EVERY matched shape (attribute-join can
  // hit multiple) and stack a marker at each centroid. Explicit-shape
  // matches at most one shape; legacy configs still resolve there
  // through the effectiveMatch() fallback.
  // Re-push when a clock rule ("expires within 7 days") flips for a row.
  const ruleClockTick = useRuleClockTick(styleRules, config.styleRuleIds, rows, enabled)
  const focusKey = focus.key
  const ghosts = focus.ghosts
  const near = focus.near
  // A row with no anchor may just be waiting for its shapes to arrive.
  const complete = loaded && settled && matchShapesLoaded(config, snapshot)
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // `buildPointOnShapeFeatures` — one marker per (entity, matched
    // shape); occluded entities never enter the source (v5.4 hard-hide)
    // unless ghost mode keeps them; the focused row is always drawn;
    // markers in the focused item's NEAR column are stamped `focusNear`.
    const features = buildPointOnShapeFeatures(
      rows,
      config,
      snapshot,
      styleRules,
      { activeFloorPlanId, liveFloorPlanIds, filter, focusedKey: focusKey, ghosts, near },
      pointOnShapeOccludedRef.current,
      rowCache,
    )
    writer.write(features, entityFeatureKey)
    onDrawn(features, complete)
  }, [
    map,
    config,
    rows,
    enabled,
    styleRules,
    snapshot,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    writer,
    rowCache,
    pointOnShapeOccludedRef,
    pointOnShapeOccludedVersion,
    ruleClockTick,
    focusKey,
    ghosts,
    near,
    complete,
    onDrawn,
  ])

  useDataLinkLayerStack(map, ownLayerIds, enabled)

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (hasMapLayer(map, id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])


  return (
    <>
      <TooltipManager
        map={map}
        config={config}
        layerIds={ownLayerIds}
        occludedKeysRef={pointOnShapeOccludedRef}
      />
      {loader}
    </>
  )
})

// ---------------------------------------------------------------------------
// gauge-on-shape sub-renderer
// ---------------------------------------------------------------------------

/**
 * Value badge stacked at a shape's centroid. Circle background + text
 * for each entity — the typical case is one sensor per shape so the
 * stack is a single badge.
 */
const GaugeOnShapeSubRenderer = memo(function GaugeOnShapeSubRenderer({
  map,
  config,
  visible,
  enabled,
  styleRules,
  polygons,
  circles,
  markers,
  lines,
  models,
  activeFloorPlanId,
  liveFloorPlanIds,
  filter,
  occluderImages,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  occluderStairs,
}: SubRendererProps & ShapeAnchorProps) {
  const tenantId = useCurrentTenantId()
  const layerPollMs = useLayerPollMs()
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: layerPollMs, enabled },
  )
  const { entities, playbackActive } = useEffectiveEntities(config, useLayerRows(config, query))
  // Focus mode (see the point-at-coord sub-renderer).
  const focus = useConfigFocus(config)
  const loaded = playbackActive || query.data !== undefined
  const { rows, settled, loader } = useFocusedRows(config, entities, focus.key, loaded, !playbackActive)
  const onDrawn = useFocusAnchorReport(config, focus, liveFloorPlanIds)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const bgId = `dl-${config.id}-gauge-bg`
  const textId = `dl-${config.id}-gauge-text`
  const ownLayerIds = useMemo(() => [bgId, textId], [bgId, textId])
  // Diff-only writes to the (dynamic) source + per-row feature cache.
  const writer = useSourceWriter(map, sourceId)
  const [rowCache] = useState(() =>
    createRowBuildCache<{ row: RowAnchors; features: GeoJSON.Feature<GeoJSON.Point>[] }>(),
  )

  const teardownFn = () => {
    if (hasMapLayer(map, textId)) map.removeLayer(textId)
    if (hasMapLayer(map, bgId)) map.removeLayer(bgId)
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }

  useStyleReadyInstall(
    map,
    enabled,
    () => {
      if (map.getSource(sourceId)) teardownFn()
      // `dynamic`: diff-only writes (see the point-at-coord source).
      map.addSource(sourceId, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey', dynamic: true })
      const defaultColor = config.style.defaultColor ?? '#3b82f6'
      // v4 — user-configurable badge size.
      const badgeSize = config.style.badgeSize ?? 18
      // Larger radius background — reads like a "chip" / rounded rect
      // at typical map zoom levels.
      // `badgeSize` is a radius; DISC_EM_SCALE converts it to the
      // em-box size that renders the `●` at the same diameter. Read
      // per-feature rather than baked in, because `text-size` is a
      // LAYOUT property — driving it from the source keeps slider
      // changes on the setData fast path instead of the
      // setLayoutProperty path this file avoids everywhere else.
      map.addLayer({
        id: bgId,
        type: 'symbol',
        source: sourceId,
        layout: {
          ...DISC_LAYOUT,
          'text-size': [
            '*',
            ['coalesce', ['get', 'badgeSize'], badgeSize],
            DISC_EM_SCALE,
          ],
        },
        paint: {
          // A style rule's colour (stamped per feature by buildGaugeFeatures) wins over the default.
          'text-color': ['coalesce', ['get', 'color'], defaultColor],
          // The gauge's authored 0.92 translucency; occluded rows are
          // left out of the source (v5.4 hard-hide), focus / ghost / NEAR
          // rows read their flags (see pointSymbolOpacity).
          'text-opacity': pointSymbolOpacity(0.92),
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': POINT_OCCLUSION_OPACITY,
        },
      })
      map.addLayer({
        id: textId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'text-field': ['get', 'value'],
          'text-size': 12,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-z-elevate': false,
        },
        paint: {
          'text-color': '#ffffff',
          'text-opacity': FULL_POINT_OPACITY,
          'text-halo-color': 'rgba(0,0,0,0.35)',
          'text-halo-width': 1,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': POINT_OCCLUSION_OPACITY,
        },
      })
    },
    teardownFn,
    `[map-dl:gauge-on-shape:${config.name}]`,
    [map, enabled, sourceId],
    installedRef,
    () => setInstallTick((t) => t + 1),
  )

  // ---- style sync: colour (size flows via feature props) --------------
  useEffect(() => {
    if (!enabled || !map) return
    const defaultColor = config.style.defaultColor ?? '#3b82f6'
    try {
      if (hasMapLayer(map, bgId)) {
        // Size rides on the feature's `badgeSize` stamp (see install);
        // only the colour needs an explicit paint sync.
        map.setPaintProperty(bgId, 'text-color', ['coalesce', ['get', 'color'], defaultColor])
      }
    } catch { /* mid-teardown */ }
  }, [map, enabled, installTick, bgId, config.style.badgeSize, config.style.defaultColor])

  const snapshot = useMatchSnapshot(config, { polygons, circles, markers, lines, models })

  // v5.4 — analytic occlusion. See useDataLinkOcclusion + the point-
  // at-coord sub-renderer's usage for the pattern.
  const { occludedRef: gaugeOccludedRef, occludedVersion: gaugeOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities: rows,
    // Its builder drops rows failing the layer filter.
    filter,
    focusKey: focus.key,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // Re-push when a clock rule ("expires within 7 days") flips for a row.
  const ruleClockTick = useRuleClockTick(styleRules, config.styleRuleIds, rows, enabled)
  const focusKey = focus.key
  const ghosts = focus.ghosts
  const near = focus.near
  // A row with no anchor may just be waiting for its shapes to arrive.
  const complete = loaded && settled && matchShapesLoaded(config, snapshot)
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // `buildGaugeFeatures` — one badge per (entity, matched shape);
    // occluded entities never enter the source (v5.4 hard-hide) unless
    // ghost mode keeps them; the focused row is always drawn; badges in
    // the focused item's NEAR column are stamped `focusNear`.
    const features = buildGaugeFeatures(
      rows,
      config,
      snapshot,
      styleRules,
      { activeFloorPlanId, liveFloorPlanIds, filter, focusedKey: focusKey, ghosts, near },
      gaugeOccludedRef.current,
      rowCache,
    )
    writer.write(features, entityFeatureKey)
    onDrawn(features, complete)
  }, [
    map,
    config,
    rows,
    enabled,
    styleRules,
    snapshot,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    writer,
    rowCache,
    gaugeOccludedRef,
    gaugeOccludedVersion,
    ruleClockTick,
    focusKey,
    ghosts,
    near,
    complete,
    onDrawn,
  ])

  useDataLinkLayerStack(map, ownLayerIds, enabled)

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (hasMapLayer(map, id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])


  return (
    <>
      <TooltipManager
        map={map}
        config={config}
        layerIds={ownLayerIds}
        occludedKeysRef={gaugeOccludedRef}
      />
      {loader}
    </>
  )
})

// ---------------------------------------------------------------------------
// shape-tint sub-renderer
// ---------------------------------------------------------------------------

/**
 * Paints a fill layer over the bound polygon/circle using the config's
 * defaultColor. Renders even when 0 entities exist — the tint IS the
 * point; data-driven tint is a Slice 4 (style rules) job.
 */
const ShapeTintSubRenderer = memo(function ShapeTintSubRenderer({
  map,
  config,
  visible,
  enabled,
  styleRules,
  polygons,
  circles,
  activeFloorPlanId,
  liveFloorPlanIds,
  filter,
  occluderImages,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  occluderStairs,
}: SubRendererProps & ShapeAnchorProps) {
  const tenantId = useCurrentTenantId()
  const layerPollMs = useLayerPollMs()
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: layerPollMs, enabled },
  )
  const { entities, playbackActive } = useEffectiveEntities(config, useLayerRows(config, query))
  // Focus mode (see the point-at-coord sub-renderer): the focused row's
  // tint is drawn whatever the filter / floor. Tints are never faded — not
  // even in the focused item's NEAR column.
  const focus = useConfigFocus(config)
  const loaded = playbackActive || query.data !== undefined
  const { rows, settled, loader } = useFocusedRows(config, entities, focus.key, loaded, !playbackActive)
  const onDrawn = useFocusAnchorReport(config, focus, liveFloorPlanIds)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const tintId = `dl-${config.id}-tint`
  const ownLayerIds = useMemo(() => [tintId], [tintId])

  const teardownFn = () => {
    if (hasMapLayer(map, tintId)) map.removeLayer(tintId)
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }

  useStyleReadyInstall(
    map,
    enabled,
    () => {
      if (map.getSource(sourceId)) teardownFn()
      map.addSource(sourceId, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey' })
      const defaultColor = config.style.defaultColor ?? '#3b82f6'
      // v4 — user-configurable base opacity. Per-feature `opacity`
      // (from style rules) still overrides via the coalesce chain.
      const fillOpacity = config.style.fillOpacity ?? 0.5
      // Data-expression-driven fill: per-feature `color` / `opacity`
      // stamped by pushFeatures (from either style rules or defaults)
      // wins; falls back to config defaults when the property is null.
      map.addLayer({
        id: tintId,
        type: 'fill',
        source: sourceId,
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], defaultColor],
          'fill-opacity': ['coalesce', ['get', 'opacity'], fillOpacity],
          'fill-outline-color': ['coalesce', ['get', 'color'], defaultColor],
          // Ride at the tinted shape's own altitude instead of draping
          // on the ground. The 2 cm lift keeps the tint off the shape's
          // own fill so the two don't z-fight (same epsilon the bin
          // overlay uses over rack cells). An elevated fill is depth-
          // tested, so a floor above now hides it for free.
          'fill-z-offset': ['+', Z_OFFSET, 0.02],
        },
      })
    },
    teardownFn,
    `[map-dl:shape-tint:${config.name}]`,
    [map, enabled, sourceId],
    installedRef,
    () => setInstallTick((t) => t + 1),
  )

  // ---- style sync: fill opacity + default colour ----------------------
  // Fill opacity is written only on a change (the install already holds
  // it), so a re-install or a focus change never writes paint.
  useEffect(() => {
    if (!enabled || !map) return
    const fillOpacity = config.style.fillOpacity ?? 0.5
    const defaultColor = config.style.defaultColor ?? '#3b82f6'
    try {
      if (hasMapLayer(map, tintId)) {
        setPaintIfChanged(map, tintId, 'fill-opacity', [
          'coalesce',
          ['get', 'opacity'],
          fillOpacity,
        ])
        map.setPaintProperty(tintId, 'fill-color', [
          'coalesce',
          ['get', 'color'],
          defaultColor,
        ])
      }
    } catch { /* mid-teardown */ }
  }, [map, enabled, installTick, tintId, config.style.fillOpacity, config.style.defaultColor])

  // The store slices the resolver reads for this config, with the
  // tint's own polygons / circles standing in for the store's.
  const snapshot = useMatchSnapshot(config, { polygons, circles })

  // v5.4 — analytic occlusion. See useDataLinkOcclusion + the point-
  // at-coord sub-renderer's usage for the pattern. Even though the
  // tint rides on `fill-z-offset` and is depth-tested "for free", the
  // native depth test is unreliable at low zooms — mirror the
  // symbol-based sub-renderers so behaviour is uniform.
  const { occludedRef: tintOccludedRef, occludedVersion: tintOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities: rows,
    // Its builder drops rows failing the layer filter.
    filter,
    focusKey: focus.key,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // Rebuild the fill polygons whenever the resolver's inputs change.
  // v2: iterate entities → resolveMatchTargets → union of matched
  // shape ids → one tinted feature per shape. Attribute-join hits ALL
  // matching shapes; explicit-shape falls back to the single target
  // as before.
  // Re-push when a clock rule ("expires within 7 days") flips for a row.
  const ruleClockTick = useRuleClockTick(styleRules, config.styleRuleIds, rows, enabled)
  const focusKey = focus.key
  // A row with no anchor may just be waiting for its shapes to arrive.
  const complete = loaded && settled && matchShapesLoaded(config, snapshot)
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // `buildShapeTintFeatures` — last matching entity per shape wins;
    // a bound shape with no entities yet still tints with the defaults.
    // The focused row's shape is stamped `focused` (its anchor).
    const features = buildShapeTintFeatures(
      rows,
      config,
      snapshot,
      polygons,
      circles,
      styleRules,
      { activeFloorPlanId, liveFloorPlanIds, filter, focusedKey: focusKey },
      tintOccludedRef.current,
    )
    setGeoJSONData(map, sourceId, { type: 'FeatureCollection', features })
    onDrawn(features, complete)
  }, [
    map,
    sourceId,
    config,
    polygons,
    circles,
    enabled,
    rows,
    styleRules,
    snapshot,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    tintOccludedRef,
    tintOccludedVersion,
    ruleClockTick,
    focusKey,
    complete,
    onDrawn,
  ])

  useDataLinkLayerStack(map, ownLayerIds, enabled)

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (hasMapLayer(map, id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return (
    <>
      <TooltipManager map={map} config={config} layerIds={ownLayerIds} />
      {loader}
    </>
  )
})

// ---------------------------------------------------------------------------
// heatmap sub-renderer
// ---------------------------------------------------------------------------

/**
 * Renders a Mapbox `heatmap` layer over the layer's records.
 * Falls back to a per-point circle at high zoom so individual points
 * remain visible past the point where the heatmap fades.
 */
const HeatmapSubRenderer = memo(function HeatmapSubRenderer({
  map,
  config,
  visible,
  enabled,
  styleRules,
  activeFloorPlanId,
  liveFloorPlanIds,
  filter,
  occluderImages,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  occluderStairs,
}: SubRendererProps) {
  const tenantId = useCurrentTenantId()
  // v5.4 — when the layer is table-backed AND the operator picked
  // `heatmapSource: 'history'`, source density from
  // `data_source_row_events` over the window. Every event is a
  // weighted point (recency-weighted); a room that saw 200 updates
  // today shows hotter than one that saw 5. Live mode still sums
  // current rows one-per-record, matching the pre-v5.4 behaviour.
  const useHistorySource =
    config.style.heatmapSource === 'history' && config.sourceId !== undefined
  const historyWindowSec = config.style.heatmapWindowSec ?? 86_400
  const layerPollMs = useLayerPollMs()
  const historyQuery = useApiQuery<TableRowEvent[]>(
    () =>
      config.sourceId !== undefined && useHistorySource
        ? listTableEvents(config.sourceId, {
            windowSec: historyWindowSec,
            limit: 5000,
          })
        : Promise.resolve([]),
    ['heatmap-events', tenantId, config.sourceId ?? 0, historyWindowSec],
    { intervalMs: layerPollMs, enabled: enabled && useHistorySource },
  )
  const liveQuery = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: layerPollMs, enabled: enabled && !useHistorySource },
  )
  const liveEntities = useMemo(
    () =>
      useHistorySource
        ? eventsToEntities(historyQuery.data ?? [])
        : liveQuery.data,
    [useHistorySource, historyQuery.data, liveQuery.data],
  )
  // Unchanged rows / events keep their objects across refetches (so the
  // per-row feature cache below holds), and the loader's blocking card
  // only covers a load with no rows yet — see useLayerRows.
  const { entities, playbackActive } = useEffectiveEntities(config, useSharedRows(liveEntities))
  const loadingQuery = useHistorySource ? historyQuery : liveQuery
  useLayerLoading(config.id, config.name, loadingQuery.isLoading, loadingQuery.data !== undefined)
  // Focus mode: the focused row adds its density and its high-zoom dot
  // whatever the filter / floor; nothing else changes (an aggregate is
  // never faded). The single-row fetch only applies to the live-rows
  // source (history events aren't filtered server-side by row).
  const focus = useConfigFocus(config)
  const loaded = playbackActive || loadingQuery.data !== undefined
  const { rows, settled, loader } = useFocusedRows(
    config, entities, focus.key, loaded, !playbackActive && !useHistorySource,
  )
  const onDrawn = useFocusAnchorReport(config, focus, liveFloorPlanIds)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const heatmapId = `dl-${config.id}-heatmap`
  const heatpointId = `dl-${config.id}-heatmap-point`
  const ownLayerIds = useMemo(() => [heatmapId, heatpointId], [heatmapId, heatpointId])
  // Skips a write whose features are all unchanged (per-row cache).
  const writer = useSourceWriter(map, sourceId)
  const [rowCache] = useState(() => createRowBuildCache<GeoJSON.Feature<GeoJSON.Point> | null>())

  const teardownFn = () => {
    if (hasMapLayer(map, heatpointId)) map.removeLayer(heatpointId)
    if (hasMapLayer(map, heatmapId)) map.removeLayer(heatmapId)
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }

  useStyleReadyInstall(
    map,
    enabled,
    () => {
      if (map.getSource(sourceId)) teardownFn()
      map.addSource(sourceId, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey' })
      const defaultColor = config.style.defaultColor ?? '#3b82f6'
      // v4 — user-configurable heatmap knobs. The linear-zoom
      // interpolation is preserved; only the max-zoom end value moves.
      const heatmapRadiusMax = config.style.heatmapRadius ?? 40
      const heatmapIntensityMult = config.style.heatmapIntensity ?? 1
      // The heatmap pass is the one render mode that cannot follow a
      // floor. Mapbox composites `heatmap` in screen space from point
      // density — there is no `heatmap-z-offset` and no occlusion
      // property, so the gradient always lies flat on the ground and
      // shows through everything above it. The `minzoom: 18` dot layer
      // below IS elevated and occluded, which is why the two cross-fade
      // rather than the heatmap simply extending to max zoom.
      map.addLayer({
        id: heatmapId,
        type: 'heatmap',
        source: sourceId,
        maxzoom: 22,
        paint: {
          'heatmap-weight': ['coalesce', ['get', 'weight'], 1],
          'heatmap-intensity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            0, 1 * heatmapIntensityMult,
            22, 3 * heatmapIntensityMult,
          ],
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.2, 'rgba(59,130,246,0.4)',
            0.5, 'rgba(139,92,246,0.6)',
            0.8, 'rgba(239,68,68,0.8)',
            1, 'rgba(239,68,68,1)',
          ],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 10, 22, heatmapRadiusMax],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 20, 0.6, 22, 0],
        },
      })
      // High-zoom fallback: individual dot per event, faded in as the
      // heatmap fades out. Per-point colour comes from any matching
      // style rule (via `properties.color`); default is the config's
      // base colour.
      map.addLayer({
        id: heatpointId,
        type: 'symbol',
        source: sourceId,
        minzoom: 18,
        layout: {
          ...DISC_LAYOUT,
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            18, 3 * DISC_EM_SCALE,
            22, 8 * DISC_EM_SCALE,
          ],
        },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], defaultColor],
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 18, 0, 20, 0.9],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1,
          'symbol-z-offset': Z_OFFSET,
          // The focused row's dot shows through floors and walls.
          'text-occlusion-opacity': FOCUS_OCCLUSION_OPACITY,
        },
      })
    },
    teardownFn,
    `[map-dl:heatmap:${config.name}]`,
    [map, enabled, sourceId],
    installedRef,
    () => setInstallTick((t) => t + 1),
  )

  // ---- style sync: heatmap radius + intensity -------------------------
  useEffect(() => {
    if (!enabled || !map) return
    const heatmapRadiusMax = config.style.heatmapRadius ?? 40
    const heatmapIntensityMult = config.style.heatmapIntensity ?? 1
    try {
      if (hasMapLayer(map, heatmapId)) {
        map.setPaintProperty(heatmapId, 'heatmap-radius', [
          'interpolate', ['linear'], ['zoom'], 0, 10, 22, heatmapRadiusMax,
        ])
        map.setPaintProperty(heatmapId, 'heatmap-intensity', [
          'interpolate', ['linear'], ['zoom'],
          0, 1 * heatmapIntensityMult,
          22, 3 * heatmapIntensityMult,
        ])
      }
    } catch { /* mid-teardown */ }
  }, [
    map,
    enabled,
    installTick,
    heatmapId,
    config.style.heatmapRadius,
    config.style.heatmapIntensity,
  ])

  // v5.4 — analytic occlusion. Even the heatmap gradient is dropped
  // where the entity's anchor sits under a slab: the heatmap pass
  // itself is screen-space with no depth test, so without this an
  // occluded sensor would still bleed its density through the floor
  // above. The high-zoom dot layer benefits identically.
  const { occludedRef: heatmapOccludedRef, occludedVersion: heatmapOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities: rows,
    // Its builder drops rows failing the layer filter.
    filter,
    focusKey: focus.key,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // Re-push when a clock rule ("expires within 7 days") flips for a row.
  const ruleClockTick = useRuleClockTick(styleRules, config.styleRuleIds, rows, enabled)
  const focusKey = focus.key
  const complete = loaded && settled
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // `buildHeatmapFeatures` — one weighted point per record with a
    // coordinate; occluded entities do not contribute to density.
    const features = buildHeatmapFeatures(
      rows,
      config,
      styleRules,
      { activeFloorPlanId, liveFloorPlanIds, filter, focusedKey: focusKey },
      heatmapOccludedRef.current,
      rowCache,
    )
    writer.write(features, entityFeatureKey)
    onDrawn(features, complete)
  }, [map, config, rows, enabled, styleRules, activeFloorPlanId, liveFloorPlanIds, filter, installTick, heatmapOccludedRef, heatmapOccludedVersion, writer, rowCache, ruleClockTick, focusKey, complete, onDrawn])

  useDataLinkLayerStack(map, ownLayerIds, enabled)

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (hasMapLayer(map, id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return (
    <>
      <TooltipManager map={map} config={config} layerIds={ownLayerIds} occludedKeysRef={heatmapOccludedRef} />
      {loader}
    </>
  )
})

// ---------------------------------------------------------------------------
// track sub-renderer
// ---------------------------------------------------------------------------

/**
 * Per-entity breadcrumb LineString + a `circle` for each entity's
 * latest position. Groups events by entityKey, sorts by ts ascending,
 * connects the dots.
 */
const TrackSubRenderer = memo(function TrackSubRenderer({
  map,
  config,
  visible,
  enabled,
  styleRules,
  activeFloorPlanId,
  liveFloorPlanIds,
  filter,
  occluderImages,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  occluderStairs,
}: SubRendererProps) {
  const tenantId = useCurrentTenantId()
  const layerPollMs = useLayerPollMs()
  const query = useApiQuery(
    () => listEntityEventsForStream(config.streamId, { windowSec: 300 }),
    ['entity-events', tenantId, config.streamId, 300],
    { intervalMs: layerPollMs, enabled },
  )
  const events = useMemo(() => query.data ?? EMPTY_EVENTS, [query.data])
  // Blocking card only while no rows are held (see useLayerRows).
  useLayerLoading(config.id, config.name, query.isLoading, query.data !== undefined)
  // Focus mode: the focused track is drawn whatever the filter / floor
  // and its head shows through 3D content; every other track stays as
  // drawn. (Events are fetched unfiltered, so there is no row to fetch
  // apart.)
  const focus = useConfigFocus(config)
  const loaded = query.data !== undefined
  const onDrawn = useFocusAnchorReport(config, focus, liveFloorPlanIds)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const lineSrc = `dl-${config.id}-track-line-src`
  const headSrc = `dl-${config.id}-track-head-src`
  const lineId = `dl-${config.id}-track-line`
  const headId = `dl-${config.id}-track-head`
  const ownLayerIds = useMemo(() => [lineId, headId], [lineId, headId])

  const teardownFn = () => {
    if (hasMapLayer(map, headId)) map.removeLayer(headId)
    if (hasMapLayer(map, lineId)) map.removeLayer(lineId)
    if (map.getSource(headSrc)) map.removeSource(headSrc)
    if (map.getSource(lineSrc)) map.removeSource(lineSrc)
  }

  useStyleReadyInstall(
    map,
    enabled,
    () => {
      if (map.getSource(lineSrc) || map.getSource(headSrc)) teardownFn()
      map.addSource(lineSrc, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey' })
      map.addSource(headSrc, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey' })
      const defaultColor = config.style.defaultColor ?? '#3b82f6'
      // v4 — user-configurable line width.
      const lineWidth = config.style.lineWidth ?? 3
      map.addLayer({
        id: lineId,
        type: 'line',
        source: lineSrc,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-elevation-reference': 'sea',
          'line-z-offset': Z_OFFSET,
        },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], defaultColor],
          'line-width': lineWidth,
          // Constant on purpose — `line-occlusion-opacity` (spec
          // default 0, i.e. hide the occluded span) is unsupported when
          // line-opacity is data-driven.
          'line-opacity': 0.7,
        },
      })
      map.addLayer({
        id: headId,
        type: 'symbol',
        source: headSrc,
        layout: {
          ...DISC_LAYOUT,
          'text-size': 6 * DISC_EM_SCALE,
        },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], defaultColor],
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
          'symbol-z-offset': Z_OFFSET,
          // The focused track's head shows through floors and walls.
          'text-occlusion-opacity': FOCUS_OCCLUSION_OPACITY,
        },
      })
    },
    teardownFn,
    `[map-dl:track:${config.name}]`,
    [map, enabled, lineSrc, headSrc],
    installedRef,
    () => setInstallTick((t) => t + 1),
  )

  // ---- style sync: line width + colour ---------------------------------
  useEffect(() => {
    if (!enabled || !map) return
    const lineWidth = config.style.lineWidth ?? 3
    const defaultColor = config.style.defaultColor ?? '#3b82f6'
    try {
      if (hasMapLayer(map, lineId)) {
        map.setPaintProperty(lineId, 'line-width', lineWidth)
        map.setPaintProperty(lineId, 'line-color', [
          'coalesce', ['get', 'color'], defaultColor,
        ])
      }
      if (hasMapLayer(map, headId)) {
        map.setPaintProperty(headId, 'text-color', [
          'coalesce', ['get', 'color'], defaultColor,
        ])
      }
    } catch { /* mid-teardown */ }
  }, [map, enabled, installTick, lineId, headId, config.style.lineWidth, config.style.defaultColor])

  // Latest event per entityKey → synthetic EntityState list so the
  // analytic occlusion pass can score each track by its "head"
  // position. A track whose current head is under a slab drops
  // entirely, including its breadcrumb line.
  const latestEntities = useMemo<readonly EntityState[]>(() => {
    const latest = new Map<string, EntityEvent>()
    for (const ev of events) {
      const prev = latest.get(ev.entityKey)
      if (!prev || ev.ts.getTime() > prev.ts.getTime()) {
        latest.set(ev.entityKey, ev)
      }
    }
    const out: EntityState[] = []
    for (const ev of latest.values()) {
      out.push({
        entityKey: ev.entityKey,
        streamId: -1,
        payload: ev.payload,
        lastSeenAt: ev.ts,
        updatedAt: ev.ts,
      })
    }
    return out
  }, [events])

  const { occludedRef: trackOccludedRef, occludedVersion: trackOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities: latestEntities,
    focusKey: focus.key,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // Re-push when a clock rule ("expires within 7 days") flips for a row.
  const ruleClockTick = useRuleClockTick(styleRules, config.styleRuleIds, events, enabled)
  const focusKey = focus.key
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // `buildTrackFeatures` — per-entity breadcrumb + head; an occluded
    // track drops entirely, breadcrumb included.
    const { lineFeatures, headFeatures } = buildTrackFeatures(
      events,
      config,
      styleRules,
      { activeFloorPlanId, liveFloorPlanIds, filter, focusedKey: focusKey },
      trackOccludedRef.current,
    )
    setGeoJSONData(map, lineSrc, { type: 'FeatureCollection', features: lineFeatures })
    setGeoJSONData(map, headSrc, { type: 'FeatureCollection', features: headFeatures })
    onDrawn(headFeatures, loaded)
  }, [map, lineSrc, headSrc, config, events, enabled, styleRules, activeFloorPlanId, liveFloorPlanIds, filter, installTick, trackOccludedRef, trackOccludedVersion, ruleClockTick, focusKey, loaded, onDrawn])

  useDataLinkLayerStack(map, ownLayerIds, enabled)

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (hasMapLayer(map, id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return <TooltipManager map={map} config={config} layerIds={ownLayerIds} occludedKeysRef={trackOccludedRef} />
})

// ---------------------------------------------------------------------------
// fov-cone sub-renderer
// ---------------------------------------------------------------------------

/**
 * Camera field-of-view triangle rooted at a bound shape's centroid.
 * Each entity draws its own triangle using its payload's yaw / pitch
 * (ignored today, kept for future 3D tilt) / fovDeg / viewDistanceM.
 * Field keys are hardcoded for now — a follow-up can expose them on
 * `config.fieldMapping` when the editor UI catches up.
 */
const FovConeSubRenderer = memo(function FovConeSubRenderer({
  map,
  config,
  visible,
  enabled,
  styleRules,
  polygons,
  circles,
  markers,
  lines,
  models,
  activeFloorPlanId,
  liveFloorPlanIds,
  filter,
  occluderImages,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  occluderStairs,
}: SubRendererProps & ShapeAnchorProps) {
  const tenantId = useCurrentTenantId()
  const layerPollMs = useLayerPollMs()
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: layerPollMs, enabled },
  )
  const { entities, playbackActive } = useEffectiveEntities(config, useLayerRows(config, query))
  // Focus mode (see the point-at-coord sub-renderer): the focused cone is
  // drawn whatever the filter / floor; cones are never faded.
  const focus = useConfigFocus(config)
  const loaded = playbackActive || query.data !== undefined
  const { rows, settled, loader } = useFocusedRows(config, entities, focus.key, loaded, !playbackActive)
  const onDrawn = useFocusAnchorReport(config, focus, liveFloorPlanIds)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const fillId = `dl-${config.id}-fov-fill`
  const outlineId = `dl-${config.id}-fov-outline`
  const ownLayerIds = useMemo(() => [fillId, outlineId], [fillId, outlineId])
  // Skips a write whose features are all unchanged (per-row cache).
  const writer = useSourceWriter(map, sourceId)
  const [rowCache] = useState(() =>
    createRowBuildCache<{ row: RowAnchors; features: GeoJSON.Feature<GeoJSON.Polygon>[] }>(),
  )

  const teardownFn = () => {
    if (hasMapLayer(map, outlineId)) map.removeLayer(outlineId)
    if (hasMapLayer(map, fillId)) map.removeLayer(fillId)
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }

  useStyleReadyInstall(
    map,
    enabled,
    () => {
      if (map.getSource(sourceId)) teardownFn()
      map.addSource(sourceId, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey' })
      const defaultColor = config.style.defaultColor ?? '#3b82f6'
      // v4 — user-configurable knobs.
      const fillOpacity = config.style.fillOpacity ?? 0.3
      const outlineWidth = config.style.outlineWidth ?? 1.5
      map.addLayer({
        id: fillId,
        type: 'fill',
        source: sourceId,
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], defaultColor],
          'fill-opacity': ['coalesce', ['get', 'opacity'], fillOpacity],
          // A camera bolted to a first-floor wall throws its cone at
          // that height, not on the ground.
          'fill-z-offset': Z_OFFSET,
        },
      })
      map.addLayer({
        id: outlineId,
        type: 'line',
        source: sourceId,
        layout: {
          'line-elevation-reference': 'sea',
          'line-z-offset': Z_OFFSET,
        },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], defaultColor],
          'line-width': outlineWidth,
          // Constant (not data-driven) line-opacity — `line-occlusion-
          // opacity` is silently unsupported when line-opacity is
          // data-driven, and the spec default of 0 is what hides the
          // occluded span behind a floor above.
          'line-opacity': 0.8,
        },
      })
    },
    teardownFn,
    `[map-dl:fov-cone:${config.name}]`,
    [map, enabled, sourceId],
    installedRef,
    () => setInstallTick((t) => t + 1),
  )

  // ---- style sync: fill opacity + outline width + colour --------------
  // Fill opacity is written only on a change (see the shape-tint sync).
  useEffect(() => {
    if (!enabled || !map) return
    const fillOpacity = config.style.fillOpacity ?? 0.3
    const outlineWidth = config.style.outlineWidth ?? 1.5
    const defaultColor = config.style.defaultColor ?? '#3b82f6'
    try {
      if (hasMapLayer(map, fillId)) {
        setPaintIfChanged(map, fillId, 'fill-opacity', [
          'coalesce', ['get', 'opacity'], fillOpacity,
        ])
        map.setPaintProperty(fillId, 'fill-color', [
          'coalesce', ['get', 'color'], defaultColor,
        ])
      }
      if (hasMapLayer(map, outlineId)) {
        map.setPaintProperty(outlineId, 'line-width', outlineWidth)
        map.setPaintProperty(outlineId, 'line-color', [
          'coalesce', ['get', 'color'], defaultColor,
        ])
      }
    } catch { /* mid-teardown */ }
  }, [
    map,
    enabled,
    installTick,
    fillId,
    outlineId,
    config.style.fillOpacity,
    config.style.outlineWidth,
    config.style.defaultColor,
  ])

  const snapshot = useMatchSnapshot(config, { polygons, circles, markers, lines, models })

  // v5.4 — analytic occlusion. A camera bolted to a wall on the
  // ground floor doesn't throw its cone through the ceiling of the
  // floor above; hide the cone entirely when its apex is under a slab.
  const { occludedRef: fovOccludedRef, occludedVersion: fovOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities: rows,
    // Its builder drops rows failing the layer filter.
    filter,
    focusKey: focus.key,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // Re-push when a clock rule ("expires within 7 days") flips for a row.
  const ruleClockTick = useRuleClockTick(styleRules, config.styleRuleIds, rows, enabled)
  const focusKey = focus.key
  // A row with no anchor may just be waiting for its shapes to arrive.
  const complete = loaded && settled && matchShapesLoaded(config, snapshot)
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // `buildFovFeatures` — one cone per (entity, anchor); occluded
    // entities never emit a cone (the focused one always does).
    const features = buildFovFeatures(
      rows,
      config,
      snapshot,
      styleRules,
      { activeFloorPlanId, liveFloorPlanIds, filter, focusedKey: focusKey },
      fovOccludedRef.current,
      rowCache,
    )
    writer.write(features, entityFeatureKey)
    onDrawn(features, complete)
  }, [
    map,
    config,
    rows,
    enabled,
    styleRules,
    snapshot,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    fovOccludedRef,
    fovOccludedVersion,
    writer,
    rowCache,
    ruleClockTick,
    focusKey,
    complete,
    onDrawn,
  ])

  useDataLinkLayerStack(map, ownLayerIds, enabled)

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (hasMapLayer(map, id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return (
    <>
      <TooltipManager map={map} config={config} layerIds={ownLayerIds} occludedKeysRef={fovOccludedRef} />
      {loader}
    </>
  )
})

// ---------------------------------------------------------------------------
// roi-pulse sub-renderer
// ---------------------------------------------------------------------------

/**
 * Pulsing ring at a shape's centroid + a count badge showing how many
 * entities the stream currently has bound to this config. The ring's
 * radius animates on a 1 s cycle via a 100 ms setInterval.
 */
const RoiPulseSubRenderer = memo(function RoiPulseSubRenderer({
  map,
  config,
  visible,
  enabled,
  styleRules,
  polygons,
  circles,
  markers,
  lines,
  models,
  activeFloorPlanId,
  liveFloorPlanIds,
  filter,
  occluderImages,
  occluderPolygons,
  occluderCircles,
  occluderLines,
  occluderStairs,
}: SubRendererProps & ShapeAnchorProps) {
  const tenantId = useCurrentTenantId()
  const layerPollMs = useLayerPollMs()
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: layerPollMs, enabled },
  )
  const { entities, playbackActive } = useEffectiveEntities(config, useLayerRows(config, query))
  // Focus mode (see the point-at-coord sub-renderer): the ring holding the
  // focused row counts it whatever the filter / floor and shows through
  // 3D content; rings are never faded.
  const focus = useConfigFocus(config)
  const loaded = playbackActive || query.data !== undefined
  const { rows, settled, loader } = useFocusedRows(config, entities, focus.key, loaded, !playbackActive)
  const onDrawn = useFocusAnchorReport(config, focus, liveFloorPlanIds)

  const installedRef = useRef(false)
  // The halo pulses by fading, not by growing: its size is now
  // `text-size`, a LAYOUT property, and re-setting layout on a 100 ms
  // timer would re-run symbol layout every tick. Opacity is paint, so
  // it animates for free. Held in a ref and written straight to the
  // layer: as React state, every tick re-rendered this sub-renderer
  // and re-pushed its whole source ten times a second.
  const haloOpacityRef = useRef(0.35)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const haloId = `dl-${config.id}-roi-halo`
  const ringId = `dl-${config.id}-roi-ring`
  const discId = `dl-${config.id}-roi-disc`
  const countId = `dl-${config.id}-roi-count`
  const ownLayerIds = useMemo(
    () => [haloId, ringId, discId, countId],
    [haloId, ringId, discId, countId],
  )

  const teardownFn = () => {
    if (hasMapLayer(map, countId)) map.removeLayer(countId)
    if (hasMapLayer(map, discId)) map.removeLayer(discId)
    if (hasMapLayer(map, ringId)) map.removeLayer(ringId)
    if (hasMapLayer(map, haloId)) map.removeLayer(haloId)
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }

  useStyleReadyInstall(
    map,
    enabled,
    () => {
      if (map.getSource(sourceId)) teardownFn()
      map.addSource(sourceId, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey' })
      const defaultColor = config.style.defaultColor ?? '#ef4444'
      // `*-occlusion-opacity`: the ring holding the focused row shows
      // through floors and walls; every other ring hides as before.
      // 1. Halo — filled disc, animated opacity (ripple).
      map.addLayer({
        id: haloId,
        type: 'symbol',
        source: sourceId,
        layout: { ...DISC_LAYOUT, 'text-size': 22 * DISC_EM_SCALE },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], defaultColor],
          'text-opacity': 0.35,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': FOCUS_OCCLUSION_OPACITY,
        },
      })
      // 2. Ring — static stroke ring, mid-size.
      map.addLayer({
        id: ringId,
        type: 'symbol',
        source: sourceId,
        layout: { ...RING_LAYOUT, 'text-size': 18 * DISC_EM_SCALE },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], defaultColor],
          'text-opacity': ['coalesce', ['get', 'opacity'], 0.9],
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': FOCUS_OCCLUSION_OPACITY,
        },
      })
      // 3. Center disc — solid fill behind the count number.
      map.addLayer({
        id: discId,
        type: 'symbol',
        source: sourceId,
        layout: { ...DISC_LAYOUT, 'text-size': 12 * DISC_EM_SCALE },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], defaultColor],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': FOCUS_OCCLUSION_OPACITY,
        },
      })
      // 4. Count text — white, bold, sits on the disc.
      map.addLayer({
        id: countId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'text-field': ['get', 'count'],
          'text-size': 13,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-z-elevate': false,
        },
        paint: {
          'text-color': '#ffffff',
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': FOCUS_OCCLUSION_OPACITY,
        },
      })
    },
    teardownFn,
    `[map-dl:roi-pulse:${config.name}]`,
    [map, enabled, sourceId],
    installedRef,
    () => setInstallTick((t) => t + 1),
  )

  // Halo pulse — fades 0.35 → 0 over 1.2 s, resets.
  useEffect(() => {
    if (!enabled) return
    let phase = 0
    const interval = setInterval(() => {
      phase = (phase + 0.083) % 1 // 12 ticks × 100 ms = 1.2 s cycle
      haloOpacityRef.current = 0.35 * (1 - phase)
      if (!installedRef.current || !hasMapLayer(map, haloId)) return
      try {
        map.setPaintProperty(haloId, 'text-opacity', haloOpacityRef.current)
      } catch {
        /* swallowed — layer went away between check + set */
      }
    }, 100)
    return () => clearInterval(interval)
  }, [enabled, map, haloId])

  const snapshot = useMatchSnapshot(config, { polygons, circles, markers, lines, models })

  // v5.4 — analytic occlusion. Occluded entities never contribute to a
  // ring; a ring whose every entity is occluded therefore disappears.
  const { occludedRef: roiOccludedRef, occludedVersion: roiOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities: rows,
    // Its builder drops rows failing the layer filter.
    filter,
    focusKey: focus.key,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // Push one ring per matched shape (attribute-join can hit many); the
  // count on each ring is the number of entities whose payload resolved
  // to that particular shape. Explicit-shape produces exactly one ring.
  // Re-push when a clock rule ("expires within 7 days") flips for a row.
  const ruleClockTick = useRuleClockTick(styleRules, config.styleRuleIds, rows, enabled)
  const focusKey = focus.key
  // A row with no anchor may just be waiting for its shapes to arrive.
  const complete = loaded && settled && matchShapesLoaded(config, snapshot)
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // `buildRoiFeatures` — first entity's style-rule override becomes
    // the ring's colour; occluded entities don't count (the focused one
    // always does, and stamps its ring `focused`).
    const features = buildRoiFeatures(
      rows,
      config,
      snapshot,
      styleRules,
      { activeFloorPlanId, liveFloorPlanIds, filter, focusedKey: focusKey },
      roiOccludedRef.current,
    )
    setGeoJSONData(map, sourceId, { type: 'FeatureCollection', features })
    onDrawn(features, complete)
  }, [
    map,
    sourceId,
    config,
    rows,
    enabled,
    styleRules,
    snapshot,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    roiOccludedRef,
    roiOccludedVersion,
    ruleClockTick,
    focusKey,
    complete,
    onDrawn,
  ])

  // Re-apply the pulse's current opacity once the halo layer exists
  // (install, style swap) instead of waiting for the next tick.
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    if (hasMapLayer(map, haloId)) {
      try {
        map.setPaintProperty(haloId, 'text-opacity', haloOpacityRef.current)
      } catch {
        /* swallowed — layer went away between check + set */
      }
    }
  }, [map, haloId, enabled, installTick])

  useDataLinkLayerStack(map, ownLayerIds, enabled)

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (hasMapLayer(map, id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return (
    <>
      <TooltipManager map={map} config={config} layerIds={ownLayerIds} occludedKeysRef={roiOccludedRef} />
      {loader}
    </>
  )
})

// ---------------------------------------------------------------------------
// TooltipManager — one popup per config, listens on that config's layers
// ---------------------------------------------------------------------------

interface TooltipManagerProps {
  map: MapboxMapInstance
  config: DataLinkConfig
  /**
   * Layer ids the sub-renderer installed. The popup only fires on
   * events over these — never a global map listener, so multiple
   * configs (each with their own TooltipManager) stay isolated.
   */
  layerIds: ReadonlyArray<string>
  /**
   * v5.4 — entities currently hidden by the analytic occlusion pass.
   * The tooltip skips hover / click on these because
   * `queryRenderedFeatures` doesn't check per-feature paint opacity,
   * so a marker at `text-opacity: 0` was still hittable + hoverable
   * even though the user couldn't see it.
   */
  occludedKeysRef?: React.RefObject<Set<string>>
}

/**
 * Data-link tooltip popup. Mirrors the hover / click state machine in
 * `map-shape-tooltip.tsx` but scoped to one DataLinkConfig's layers.
 *
 *   - hover trigger: mousemove opens/updates, mouseleave closes.
 *   - click trigger: click opens (sticky), map click on empty area
 *     closes. Clicking the same feature again toggles it off.
 *
 * The popup body reads the raw payload from `feature.properties.payload`
 * (JSON-stringified at push time, parsed here) and renders one row per
 * key in `config.tooltip.fields` — or every key when the field list is
 * empty — as `Key: value`. If `config.tooltip.template` is set, the
 * whole body renders as the resolved template instead.
 */
function TooltipManager({ map, config, layerIds, occludedKeysRef }: TooltipManagerProps) {
  // Host-level opt-out: when the surrounding overlay was mounted with
  // `disableTooltips`, only CLICK-mode popups are suppressed (the host
  // wires its own click handler — typically to open a shared sidebar
  // drawer). HOVER-mode popups keep working so users who set
  // `trigger: hover` in their data-link config still see the tooltip
  // over the marker. See the doc-comment on the `disableTooltips`
  // prop up top for the history of this split.
  const { disable: disabledByHost, onEntityViewMore } = useContext(
    DataLinkTooltipContext,
  )
  const configTrigger = config.tooltip.trigger ?? 'hover'
  const suppressedByHost = disabledByHost && configTrigger === 'click'
  // Keep the "View more" callback in a ref so the popup's inner
  // closure (built inside a `useEffect` that runs once per popup
  // lifecycle) always sees the latest handler without re-triggering
  // the effect on every parent render.
  const onEntityViewMoreRef = useRef(onEntityViewMore)
  useEffect(() => {
    onEntityViewMoreRef.current = onEntityViewMore
  }, [onEntityViewMore])

  // v3 UX: for SHAPE-ANCHORED render modes (shape-tint / point-on-shape /
  // gauge-on-shape / fov-cone / roi-pulse) we do NOT open our own popup.
  // The underlying shape (polygon / circle / marker / …) already has a
  // hover+click tooltip system, and this used to fire a competing popup
  // on top of it. Only coord/track/heatmap render brand-new features
  // with no host shape overlay, so they still need this popup for their
  // own hit-testing.
  const shapeAnchoredMode =
    suppressedByHost ||
    config.renderMode === 'shape-tint' ||
    config.renderMode === 'point-on-shape' ||
    config.renderMode === 'gauge-on-shape' ||
    config.renderMode === 'fov-cone' ||
    config.renderMode === 'roi-pulse'

  // Bump styleGen only when target layers TRANSITION from
  // "not-all-present" to "all-present" (and vice-versa) — NOT on every
  // `styledata` event once we're settled. The previous unconditional
  // bump was the root of the view.tsx hover flicker: view mounts many
  // sibling overlays (shape tooltip, hover highlight, route overlay,
  // etc.), each of which triggers `styledata` at high frequency. Every
  // one of those events was incrementing `styleGen` here, which
  // re-ran the popup-install effect below → teardown + rebind → the
  // popup blinked between mousemoves. Editor doesn't ship those
  // overlays so it never noticed. Latch on the transition and the
  // popup effect only re-attaches when it genuinely needs to (e.g.
  // after a style swap that pulled the layers out).
  const [styleGen, setStyleGen] = useState(0)
  useEffect(() => {
    if (!map || layerIds.length === 0 || shapeAnchoredMode) return
    // `hasMapLayer`, not `map.getLayer` — the latter serialises the
    // layer, and this runs on every `styledata` of every overlay.
    let allPresent = layerIds.every((id) => hasMapLayer(map, id))
    const onStyleData = () => {
      const nowAllPresent = layerIds.every((id) => hasMapLayer(map, id))
      if (nowAllPresent !== allPresent) {
        allPresent = nowAllPresent
        setStyleGen((g) => g + 1)
      }
    }
    map.on('styledata', onStyleData)
    return () => {
      map.off('styledata', onStyleData)
    }
  }, [map, layerIds, shapeAnchoredMode])

  useEffect(() => {
    if (!map || layerIds.length === 0 || shapeAnchoredMode) return
    const trigger = config.tooltip.trigger ?? 'hover'
    const popup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      // Larger offset so the popup DOM never overlaps the marker
      // beneath the cursor. The primary anti-flicker guarantee is
      // the CSS `pointer-events: none` rule on `.dl-hover-popup` —
      // this offset is belt-and-braces for the edge case where the
      // browser hasn't yet applied the rule (e.g. hot-reload race).
      offset: 18,
      // Reuse `.bin-hover-popup` so the styled surface (glass
      // backdrop, radius, border, entry animation) matches the shape
      // tooltip — the two live side by side and looked mismatched
      // when the data-link one used mapbox's raw defaults. The extra
      // `.dl-hover-popup` class attaches the pointer-events: none
      // rule ONLY to the data-link variant so shape tooltips (which
      // work correctly with pointer-events auto because polygons are
      // large enough) keep their behaviour.
      className: 'bin-hover-popup dl-hover-popup',
      maxWidth: '360px',
    })
    let popupNode: HTMLElement | null = null
    let popupRoot: Root | null = null
    // Hover-preservation state — mirrors map-shape-tooltip.tsx. The
    // 180 ms grace period lets the cursor travel from the feature to
    // the popup without dismissing mid-transit; the popupHovered flag
    // cancels any pending dismiss while the cursor is over the popup.
    let popupHovered = false
    let pendingDismiss: ReturnType<typeof setTimeout> | null = null
    const cancelPendingDismiss = () => {
      if (pendingDismiss !== null) {
        clearTimeout(pendingDismiss)
        pendingDismiss = null
      }
    }
    const HOVER_DISMISS_DELAY_MS = 180
    const scheduleDismiss = () => {
      if (owner !== 'hover') return
      if (popupHovered) return
      cancelPendingDismiss()
      pendingDismiss = setTimeout(() => {
        pendingDismiss = null
        if (popupHovered) return
        if (owner === 'hover') dismiss()
      }, HOVER_DISMISS_DELAY_MS)
    }
    const ensureMount = (): Root => {
      if (popupRoot) return popupRoot
      popupNode = document.createElement('div')
      popupRoot = createRoot(popupNode)
      popupNode.addEventListener('mouseenter', () => {
        popupHovered = true
        cancelPendingDismiss()
      })
      popupNode.addEventListener('mouseleave', () => {
        popupHovered = false
        scheduleDismiss()
      })
      popup.setDOMContent(popupNode)
      return popupRoot
    }

    // Only listen to layers that currently exist. When the sub-renderer
    // installs its layers async we may mount before them; the effect
    // re-runs when styleGen bumps so late-added layers land here.
    const liveLayerIds = layerIds.filter((id) => hasMapLayer(map, id))
    if (liveLayerIds.length === 0) return

    let clickedFeaturePayload: string | null = null
    let owner: 'hover' | 'click' | null = null
    // The entityKey currently rendered in the popup. Used to skip
    // re-renders on every mousemove event that hits the same
    // marker — the popup would flash the same content thousands of
    // times per second otherwise, and each re-render nudges the DOM
    // enough to briefly move it under the cursor.
    let renderedFor: string | null = null

    const parsePayload = (raw: unknown): Record<string, unknown> | null => {
      if (typeof raw !== 'string') return null
      try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : null
      } catch {
        return null
      }
    }

    /**
     * Body renderer. Three tiers, in order of user preference:
     *
     *   1. Explicit `tooltip.template` string with `{{path}}` tokens
     *      — resolved verbatim, no styling.
     *   2. Otherwise, hand the payload to `BinPopupContent` so the
     *      data-link tooltip matches the polished shape-tooltip UI
     *      (media carousel, semantic field badges, RFID / battery /
     *      status icons — the same layer `map-shape-tooltip.tsx`
     *      uses for polygons / circles / markers). This is the same
     *      component the /view drawer uses in single-item mode, so
     *      hover + click surface stay consistent.
     */
    const renderBody = (
      payload: Record<string, unknown>,
      mode: 'compact' | 'full',
      anchor: mapboxgl.LngLatLike,
      entityKey: string,
    ): React.ReactNode => {
      if (config.tooltip.template) {
        const text = resolveLabelTemplate(config.tooltip.template, payload)
        return <div className="text-xs whitespace-pre-wrap p-2">{text}</div>
      }
      // v4 fix: keep the polished BinPopupContent (media carousel,
      // status badges, icon rows) in BOTH the "fields configured"
      // and "no fields configured" cases. The earlier custom minimal
      // grid caused two regressions:
      //   1. Content mismatch — editor's editor-drawer path uses
      //      BinPopupContent so the two surfaces diverged.
      //   2. Hover flicker — the smaller custom body reflowed the
      //      Mapbox popup on every mousemove-triggered rerender.
      // To honour `config.tooltip.fields` we pre-filter and pre-order
      // the payload's keys before handing it to BinPopupContent. ES
      // preserves object insertion order for string keys, so the
      // configured order flows through.
      const orderedFields = config.tooltip.fields ?? []
      const customProperties: Record<string, unknown> = (() => {
        if (orderedFields.length === 0) return payload
        const ordered: Record<string, unknown> = {}
        for (const path of orderedFields) {
          const raw = readPayloadPath(payload, path)
          const shortKey = path.split('.').pop() ?? path
          const displayKey = shortKey in ordered ? path : shortKey
          // When the user explicitly picks fields to show, respect the
          // pick even when the value is missing / null / empty-string.
          // classifyBin (rich-data.ts) silently drops nullish + empty
          // strings from the custom-attributes list, so we fill blanks
          // with an em-dash string that renders as "—". This preserves
          // the caller's intent — a field you configured stays visible
          // even when the row happens to have no data for it.
          if (
            raw === undefined ||
            raw === null ||
            (typeof raw === 'string' && raw.trim() === '')
          ) {
            ordered[displayKey] = '—'
          } else {
            ordered[displayKey] = raw
          }
        }
        return ordered
      })()
      const bin: Bin = {
        targetKind: 'polygon',
        customProperties,
        updatedAt: new Date(),
      }
      // Title: use the layer's configured `labelField` (from the data
      // link editor). This wins over BinPopupContent's built-in fallback
      // chain (external code → sku → customProperties.name → 'Untitled')
      // which produced confusing 'Untitled' headers for data-link rows
      // whose synthesised bin has neither an externalCode nor an sku.
      const labelKey = config.fieldMapping?.labelField
      const labelRaw = labelKey ? readPayloadPath(payload, labelKey) : undefined
      const tooltipTitle =
        typeof labelRaw === 'string' || typeof labelRaw === 'number'
          ? String(labelRaw)
          : undefined
      // "View more" opens the host's sidebar drawer via the
      // `onEntityViewMore` callback threaded through
      // `DataLinkTooltipContext`. Direct callback (rather than the
      // earlier `map.fire('click', ...)` synthetic-event hack) so the
      // handler runs synchronously and reliably regardless of what
      // other click handlers happen to be attached to the map. Then
      // ALWAYS dismiss the popup: the drawer replaces it as the
      // detail surface, and leaving a promoted click-owner popup
      // pinned would trap it open (sticky click ignores hover-leave)
      // AND block subsequent hovers on other markers. See the
      // 2026-07-22 report chain.
      const onViewMore = () => {
        const lngLat = mapboxgl.LngLat.convert(anchor)
        try {
          onEntityViewMoreRef.current?.(
            config,
            payload,
            { lng: lngLat.lng, lat: lngLat.lat },
            entityKey,
          )
        } catch (err) {
          console.warn('[data-link] onEntityViewMore failed', err)
        }
        dismiss()
      }
      // withReferences=false so BinPopupContent doesn't spawn N
      // extra API queries on every hover (the shape-tooltip does
      // this too for its hover-mode).
      // Full-mode caps at 60dvh so a config with 20+ fields scrolls
      // internally instead of running off-screen. Compact mode
      // doesn't need the cap (it's already limited to 5 fields).
      // hideKind=true suppresses the meaningless "Zone Polygon" pill —
      // the synthesised bin's kind is always 'polygon' regardless of
      // what data the layer actually represents (assets, sensors, etc.).
      const containerStyle: React.CSSProperties =
        mode === 'full'
          ? {
              maxHeight: '60dvh',
              overflowY: 'auto',
              overscrollBehavior: 'contain',
            }
          : {}
      return (
        <div className="sgv-tt" style={containerStyle}>
          <BinPopupContent
            bin={bin}
            withReferences={false}
            title={tooltipTitle}
            hideKind
            compact={mode === 'compact'}
            onViewMore={mode === 'compact' ? onViewMore : undefined}
          />
        </div>
      )
    }

    /**
     * Track which mode the popup was last rendered in so a hover→click
     * transition (or click "View more" in compact) actually re-renders
     * instead of dedup-skipping via the `renderedFor` guard.
     */
    let renderedMode: 'compact' | 'full' | null = null
    const showAt = (
      lngLat: mapboxgl.LngLatLike,
      payload: Record<string, unknown>,
      entityKey: string,
      mode: 'compact' | 'full',
    ) => {
      if (renderedFor !== entityKey || renderedMode !== mode) {
        ensureMount().render(renderBody(payload, mode, lngLat, entityKey))
        renderedFor = entityKey
        renderedMode = mode
      }
      cancelPendingDismiss()
      popup.setLngLat(lngLat)
      if (!popup.isOpen()) popup.addTo(map)
    }
    const dismiss = () => {
      cancelPendingDismiss()
      popup.remove()
      owner = null
      renderedFor = null
      renderedMode = null
      popupHovered = false
      clickedFeaturePayload = null
    }

    const onMouseMove = (
      e: mapboxgl.MapMouseEvent,
      /** This event's query over `liveLayerIds`, when the caller ran it. */
      queried?: mapboxgl.MapboxGeoJSONFeature[],
    ) => {
      if (trigger !== 'hover') return
      if (owner === 'click') return
      let hits: mapboxgl.MapboxGeoJSONFeature[]
      if (queried) {
        hits = queried
      } else {
        try {
          hits = map.queryRenderedFeatures(e.point, { layers: liveLayerIds })
        } catch {
          return
        }
      }
      // v5.4 — skip features the analytic occlusion pass has hidden.
      // `queryRenderedFeatures` doesn't check per-feature paint opacity,
      // so a marker at `text-opacity: 0` is still hittable. Without
      // this filter the user could hover a tooltip over a marker they
      // can't see (behind a wall / under a floor). The `occluded`
      // flag rides on `feature.properties` because Mapbox wipes
      // feature-state on every `source.setData()`.
      void occludedKeysRef  // preserved for API compat; property is source of truth
      const hit = (() => {
        for (const h of hits) {
          if (h.properties?.['occluded'] === true) continue
          return h
        }
        return undefined
      })()
      if (!hit) {
        if (owner === 'hover') scheduleDismiss()
        return
      }
      const payload = parsePayload(hit.properties?.payload)
      if (!payload) {
        if (owner === 'hover') scheduleDismiss()
        return
      }
      owner = 'hover'
      // Anchor at the feature's own coordinate (not the cursor
      // position). Cursor-anchored popups shake with every pointer
      // micro-move, and the shaking can move the popup under the
      // cursor → mouseleave → dismiss → flicker. Feature-anchored
      // popups stay put while the mouse wanders inside the marker's
      // hit radius.
      const geom = hit.geometry
      const anchor =
        geom && geom.type === 'Point'
          ? (geom.coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat] as [number, number]
      const entityKey =
        (typeof hit.properties?.entityKey === 'string'
          ? hit.properties.entityKey
          : String(hit.properties?.payload ?? '')) as string
      showAt(anchor as mapboxgl.LngLatLike, payload, entityKey, 'compact')
    }

    const onMouseLeave = () => {
      if (owner === 'hover') scheduleDismiss()
    }

    const onLayerClick = (e: mapboxgl.MapMouseEvent) => {
      if (trigger !== 'click') return
      let hits: mapboxgl.MapboxGeoJSONFeature[]
      try {
        hits = map.queryRenderedFeatures(e.point, { layers: liveLayerIds })
      } catch {
        return
      }
      // v5.4 — skip features the analytic occlusion pass has hidden.
      // `queryRenderedFeatures` doesn't check per-feature paint opacity,
      // so a marker at `text-opacity: 0` is still hittable. Without
      // this filter the user could hover a tooltip over a marker they
      // can't see (behind a wall / under a floor). The `occluded`
      // flag rides on `feature.properties` because Mapbox wipes
      // feature-state on every `source.setData()`.
      void occludedKeysRef  // preserved for API compat; property is source of truth
      const hit = (() => {
        for (const h of hits) {
          if (h.properties?.['occluded'] === true) continue
          return h
        }
        return undefined
      })()
      if (!hit) return
      const payload = parsePayload(hit.properties?.payload)
      if (!payload) return

      // v2: dispatch the click according to config.tooltip.onClick.
      // 'open-panel' (default) keeps the sticky popup behaviour below.
      // 'open-url' navigates a new tab to the templated URL.
      // 'custom-event' fires the data-link event bus for plugins.
      const onClick = config.tooltip.onClick
      const kind = onClick?.kind ?? 'open-panel'
      if (kind === 'open-url') {
        const url = onClick?.url
          ? resolveLabelTemplate(onClick.url, payload)
          : ''
        if (url) {
          try {
            window.open(url, '_blank', 'noopener,noreferrer')
          } catch (err) {
            console.warn('[data-link] open-url failed', err)
          }
        }
        e.originalEvent.stopPropagation?.()
        return
      }
      if (kind === 'custom-event') {
        emitDataLinkClick({
          event: onClick?.event || 'dl:click',
          config,
          payload,
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
        })
        e.originalEvent.stopPropagation?.()
        return
      }

      const key = String(hit.properties?.payload ?? '')
      // Toggle off when clicking the same feature twice.
      if (owner === 'click' && clickedFeaturePayload === key) {
        dismiss()
        return
      }
      owner = 'click'
      clickedFeaturePayload = key
      const geom = hit.geometry
      const anchor =
        geom && geom.type === 'Point'
          ? (geom.coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat] as [number, number]
      const entityKey =
        (typeof hit.properties?.entityKey === 'string'
          ? hit.properties.entityKey
          : key) as string
      showAt(anchor as mapboxgl.LngLatLike, payload, entityKey, 'full')
      // Stop the click from bubbling into the empty-area dismiss below.
      e.originalEvent.stopPropagation?.()
    }

    // Empty-area click dismisses a sticky click popup.
    const onMapClick = (e: mapboxgl.MapMouseEvent) => {
      if (trigger !== 'click') return
      if (owner !== 'click') return
      let hits: mapboxgl.MapboxGeoJSONFeature[]
      try {
        hits = map.queryRenderedFeatures(e.point, { layers: liveLayerIds })
      } catch {
        hits = []
      }
      if (hits.length === 0) dismiss()
    }

    // Hover: ONE map listener for this config, replacing the delegated
    // `mousemove` + `mouseleave` pair per layer. Each delegated listener
    // ran its own `queryRenderedFeatures` (plus a `getLayer` serialise per
    // layer) on every mouse move, and `onMouseMove` then ran another over
    // every layer — 2N+ queries per move. Here one query answers all of
    // them, and the per-layer sequence is replayed in the same order:
    // for each layer, "move" when the cursor is over one of its features,
    // then "leave" when it just left that layer's features (or the map).
    const insideLayers = new Set<string>()
    const onHoverMove = (e: mapboxgl.MapMouseEvent) => {
      const present = liveLayerIds.filter((id) => hasMapLayer(map, id))
      let hits: mapboxgl.MapboxGeoJSONFeature[] = []
      if (present.length > 0) {
        try {
          hits = map.queryRenderedFeatures(e.point, { layers: present })
        } catch {
          return
        }
      }
      const hitLayers = new Set<string>()
      for (const h of hits) {
        const id = h.layer?.id
        if (id) hitLayers.add(id)
      }
      // `onMouseMove` queries every listed layer; reuse this query when
      // it covered all of them.
      const queried = present.length === liveLayerIds.length ? hits : undefined
      for (const id of liveLayerIds) {
        if (hitLayers.has(id)) {
          onMouseMove(e, queried)
          insideLayers.add(id)
        } else if (insideLayers.has(id)) {
          insideLayers.delete(id)
          onMouseLeave()
        }
      }
    }
    const onHoverOut = () => {
      for (const id of liveLayerIds) {
        if (!insideLayers.has(id)) continue
        insideLayers.delete(id)
        onMouseLeave()
      }
    }

    if (trigger === 'hover') {
      map.on('mousemove', onHoverMove)
      map.on('mouseout', onHoverOut)
    } else {
      for (const id of liveLayerIds) {
        map.on('click', id, onLayerClick)
      }
      map.on('click', onMapClick)
    }

    return () => {
      if (trigger === 'hover') {
        map.off('mousemove', onHoverMove)
        map.off('mouseout', onHoverOut)
      } else {
        for (const id of liveLayerIds) {
          map.off('click', id, onLayerClick)
        }
        map.off('click', onMapClick)
      }
      cancelPendingDismiss()
      // Defer the React root unmount to a microtask so any pending
      // render call above settles first (React warns if you unmount
      // during a synchronous render).
      const rootRef = popupRoot
      const nodeRef = popupNode
      queueMicrotask(() => {
        try {
          rootRef?.unmount()
        } catch {
          /* already unmounted */
        }
        nodeRef?.remove()
      })
      popup.remove()
    }
  }, [map, config, layerIds, styleGen, shapeAnchoredMode, occludedKeysRef])

  return null
}
