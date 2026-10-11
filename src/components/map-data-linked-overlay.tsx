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

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'
import { useApiQuery, queryCache } from '@/lib/useApiQuery'
import { subscribeExternalSSE } from '@/lib/useSSE'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { listEntityEventsForStream } from '@/lib/data-link/entity-state-service'
import { fetchLayerRows } from '@/lib/data-link/layer-rows'
import { whenStyleLoaded } from '@/lib/mapbox-style-ready'
import { ensureDataLinkSpritesFor, mapboxImageIdFor } from '@/lib/data-link/lucide-icon-sprites'
import { polygonCentroid } from '@/lib/polygon-generators'
import { lineCentroid } from '@/lib/line-generators'
import { buildCircleFeatures } from '@/lib/circle-generators'
import {
  evaluateEntityRules,
  resolveLabelTemplate,
} from '@/lib/data-link/style-rule-evaluator'
import {
  readPayloadPath,
  resolveMatchTargets,
  resolvePayloadCoord,
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
  ElevationSpec,
  EntityState,
  EntityEvent,
} from '@/lib/db'
import {
  evaluateDataLinkFilter,
  passesFloorScope,
  activeFloorKey,
  type ActiveFloors,
  shapeOnEntityFloor,
} from '@/lib/data-link/filter-evaluator'
import {
  listTableEvents,
  type TableRowEvent,
} from '@/lib/data-link/table-events-client'
import {
  useTablePlaybackState,
  visibleEntities,
} from '@/lib/data-link/table-playback-store'
import {
  buildOccluders,
  computeOccludedIds,
  type OccludableTarget,
} from '@/lib/marker-occlusion'
import { BinPopupContent } from './bin-popup-content'
import { useLayerLoading } from '@/lib/data-link/loading-store'

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
const LAYER_ROWS_POLL_MS = 30_000

/**
 * v5.4 — resolve the effective entity list for a sub-renderer. When
 * the table-playback player has activated this layer's source, we
 * bypass the live query and read reconstructed entities at the
 * playhead; otherwise we return the live query's data. Centralised
 * so every sub-renderer picks up playback support in one edit.
 */
function useEffectiveEntities(
  config: DataLinkConfig,
  liveEntities: readonly EntityState[] | undefined,
): { entities: EntityState[]; playbackActive: boolean } {
  const playback = useTablePlaybackState()
  const playbackActive =
    config.sourceId !== undefined && playback.activeSourceId === config.sourceId
  const entities = useMemo(
    () =>
      playbackActive
        ? visibleEntities(config.sourceId!)
        : (liveEntities ?? []) as EntityState[],
    // playback.currentMs is intentional so the render follows the scrubber.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playbackActive, playback.currentMs, playback.events, liveEntities, config.sourceId],
  )
  return { entities, playbackActive }
}

/**
 * v5.4 — paint expressions that fade a feature to opacity 0 when the
 * analytic occlusion pass (`useDataLinkOcclusion`) has marked it
 * hidden. Used across every sub-renderer's disc / icon / label /
 * ring paint block so occlusion behaves identically regardless of
 * render mode. The `1` fallback is the layer's normal opacity — a
 * layer that wants a data-driven base opacity can inline the case
 * around that expression instead of these constants.
 */
// v5.4 — property-based, NOT feature-state. GeoJSON `source.setData(...)`
// wipes feature-state on every call (a lot: SSE update, poll tick, style
// rule refetch, entity edit — the whole point of the overlay is that
// data updates often), which was silently un-hiding markers between
// occlusion recomputes. Stamping `occluded` in `feature.properties`
// instead makes hiding persist across every setData because Mapbox
// copies properties verbatim into the source cache.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OCCLUSION_TEXT_OPACITY: any = [
  'case',
  ['boolean', ['get', 'occluded'], false],
  0,
  1,
]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OCCLUSION_ICON_OPACITY: any = [
  'case',
  ['boolean', ['get', 'occluded'], false],
  0,
  1,
]

/**
 * Coerce a payload coord value to a finite number, or `undefined` when
 * the value can't be parsed. Handles the three common cases: native
 * number, numeric string (`"-121.76"` — how file-imported rows land in
 * `data_source_rows.payload`), and missing / non-numeric values.
 */
/**
 * v5.4 — adapt a `data_source_row_events` list to the `EntityState`
 * shape the heatmap sub-renderer already consumes, so the history vs
 * live source swap is invisible to the render code. `entityKey` is
 * preserved so tooltips still identify the record; `payload` is the
 * per-event snapshot so lng/lat & style-rule inputs come out of it
 * unchanged. `streamId` is a synthetic negative placeholder — nothing
 * downstream keys off it once `sourceId` is set, but a numeric value
 * keeps existing code happy.
 */
function eventsToEntities(events: readonly TableRowEvent[]): EntityState[] {
  return events.map((e) => {
    const ts = new Date(e.ts)
    return {
      entityKey: e.entityKey,
      streamId: -1,
      payload: e.payload,
      lastSeenAt: ts,
      updatedAt: ts,
    }
  })
}

function coerceCoord(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function MapDataLinkedOverlay({
  map,
  activeZoneId,
  configs,
  visible = true,
  enabled = true,
  polygons = [],
  circles = [],
  markers = [],
  lines = [],
  models = [],
  occluderImages = [],
  occluderStairs = [],
  occluderPolygons,
  occluderCircles,
  occluderLines,
  styleRules = [],
  disableTooltips = false,
  activeFloorPlanId = null,
  liveFloorPlanIds,
  configFilters,
  onEntityViewMore,
}: MapDataLinkedOverlayProps) {
  // v5.5 — separate occluder + shape-anchor arrays. Host may pin
  // occluders to the visible-floor filtered set while still passing
  // every zone shape as an anchor target. When the host doesn't opt
  // in, fall back to the anchor arrays for identical pre-fix behaviour.
  const effectiveOccluderPolygons = occluderPolygons ?? polygons
  const effectiveOccluderCircles = occluderCircles ?? circles
  const effectiveOccluderLines = occluderLines ?? lines
  // Set form for O(1) orphan lookups. Memoised on the id list so
  // sub-renderers don't rebuild it every render.
  const liveFloorPlanIdSet = useMemo(
    () => new Set(liveFloorPlanIds ?? []),
    [liveFloorPlanIds],
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
  // refresh on the LAYER_ROWS_POLL_MS tick.
  useEffect(
    () =>
      subscribeExternalSSE((kind) => {
        if (kind === 'data-sources') queryCache.invalidate('layer-rows')
      }),
    [],
  )

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
  //       just-installed layers.
  //   (b) On every `styledata` event, re-raise the surviving `dl-*`
  //       layers to the top of the stack so widgets stay visible
  //       above any overlay whose layers get pushed on top of ours
  //       during a style swap.
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
    // (a) One-shot orphan removal on activeConfigs change.
    try {
      const style = map.getStyle()
      if (style) {
        for (const l of style.layers ?? []) {
          if (typeof l.id !== 'string') continue
          const cfgId = parseConfigId(l.id)
          if (cfgId === null || activeIds.has(cfgId)) continue
          try { map.removeLayer(l.id) } catch { /* concurrent */ }
        }
        for (const sourceId of Object.keys(style.sources ?? {})) {
          const cfgId = parseConfigId(sourceId)
          if (cfgId === null || activeIds.has(cfgId)) continue
          try { map.removeSource(sourceId) } catch { /* concurrent */ }
        }
      }
    } catch { /* style not ready */ }
    // (b) Ongoing raise-to-top on styledata (no removals here).
    const raise = () => {
      try {
        for (const l of map.getStyle()?.layers ?? []) {
          if (typeof l.id !== 'string' || !l.id.startsWith('dl-')) continue
          try { map.moveLayer(l.id) } catch { /* mid-swap */ }
        }
      } catch { /* style not ready */ }
    }
    raise()
    map.on('styledata', raise)
    return () => {
      map.off('styledata', raise)
    }
  }, [map, activeConfigs])

  if (!map || !enabled || activeZoneId === null) return null

  return (
    <DataLinkTooltipContext.Provider
      value={{ disable: disableTooltips, onEntityViewMore }}
    >
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
      />
    </DataLinkTooltipContext.Provider>
  )
}

/**
 * Split out so the parent's `activeConfigs.map(config => ...)` can
 * memo the shape props array ONCE per parent render instead of once
 * per config. The individual sub-renderer components stay
 * unmemoised for now (memoising them would need stable per-config
 * `filter` refs which we compute here).
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
            return <PointAtCoordSubRenderer key={k} {...commonProps} />
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
function PointAtCoordSubRenderer({
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
}: SubRendererProps) {
  const configId = config.id
  const tenantId = useCurrentTenantId()

  // Poll the stream's entities on `LAYER_ROWS_POLL_MS` (30s) — the
  // safety net. Every scheduled / manual rerun invalidates the
  // `layer-rows` cache from `rerunDataSource`, which triggers an
  // immediate refetch, so the poll only kicks in as a backstop for
  // cross-tab updates.
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: LAYER_ROWS_POLL_MS, enabled },
  )
  const { entities } = useEffectiveEntities(config, query.data)
  useLayerLoading(config.id, config.name, query.isLoading)

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
  const tooltipLayerIds = useMemo(
    () => [ids.point, ids.icon, ids.label],
    [ids.point, ids.icon, ids.label],
  )

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
          installSourcesAndLayers(map, ids, config)
          installedRef.current = true
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.debug(`[map-dl:${config.name}] install complete`, {
              entities: entities.length,
              configId: config.id,
            })
          }
          setInstallTick((t) => t + 1)
          pushFeatures(map, ids, config, entities, styleRules, polygons)
          pushVisibility(map, ids, visible)
        })
      },
      `[map-dl:${config.name}]`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, ids.point, ids.cluster, config.style.cluster])

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
      if (map.getLayer(ids.point)) {
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

  // ---- pre-filter entities: layer filter + active-floor gate ---------
  // Applied before `pushFeatures` so both the ingest and re-emit paths
  // agree on what makes it to the map. The floor gate honours the
  // config's `fieldMapping.floorScope` (auto | all | specific) and
  // treats orphan floor references (payload floor id no longer in
  // `liveFloorPlanIds`) as unknown — so entities whose data references
  // a deleted floor keep rendering instead of vanishing on the current
  // floor.
  const floorScope = config.fieldMapping.floorScope
  const filteredEntities = useMemo(() => {
    return entities.filter((e) => {
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
  }, [entities, filter, floorScope, activeFloorPlanId, liveFloorPlanIds])

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
    entities,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // ---- push new features whenever data changes ----------------------------
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    pushFeatures(map, ids, config, filteredEntities, styleRules, polygons, occludedRef.current)
    // Belt-and-suspenders: keep this overlay's layers above later
    // additions. `styledata` listener below covers most cases; this
    // catches the poll-tick path where no styledata fires.
    raiseToTop(map, ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ids, config, filteredEntities, enabled, styleRules, polygons, installTick, occludedVersion])

  // Pin to top on every style mutation. Guarded to prevent infinite
  // moveLayer → styledata → moveLayer recursion.
  useEffect(() => {
    if (!map || !enabled) return
    const onStyleData = () => raiseToTop(map, ids)
    map.on('styledata', onStyleData)
    return () => {
      map.off('styledata', onStyleData)
    }
  }, [map, ids, enabled])

  // ---- visibility toggling -----------------------------------------------
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    pushVisibility(map, ids, visible)
  }, [map, ids, visible, enabled, installTick])

  return (
    <TooltipManager
      map={map}
      config={config}
      layerIds={tooltipLayerIds}
      occludedKeysRef={occludedRef}
    />
  )
}

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
  const shouldCluster = config.style.cluster === true && !useManualCluster
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
  }

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
  addLayerGuarded({
    id: ids.point,
    type: 'symbol',
    source: ids.source,
    filter: (shouldCluster || useManualCluster) ? nonClusterFilter : (['literal', true] as mapboxgl.ExpressionSpecification),
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
      // until the user zoomed in enough. Fold `feature-state.occluded`
      // (set by the effect in `PointAtCoordSubRenderer`) directly
      // into the opacity so hiding is deterministic at every zoom.
      'text-opacity': [
        'case',
        ['boolean', ['get', 'occluded'], false],
        0,
        ['/', ['coalesce', ['get', 'opacity'], 1], 1],
      ],
      'text-halo-color': '#ffffff',
      'text-halo-width': 2,
      'symbol-z-offset': Z_OFFSET,
      'text-occlusion-opacity': 0,
    },
  })

  // Lucide icon symbol layer. `feature.icon` is stamped in
  // `pushFeatures` per config.style.defaultIcon. The sprite is
  // registered via `ensureDataLinkSprites` before install; missing
  // icons fall through to the coloured disc above so the marker
  // stays visible.
  addLayerGuarded({
    id: ids.icon,
    type: 'symbol',
    source: ids.source,
    filter: (shouldCluster || useManualCluster) ? nonClusterFilter : (['literal', true] as mapboxgl.ExpressionSpecification),
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
    },
    paint: {
      'symbol-z-offset': Z_OFFSET,
      // v5.4 — analytic occlusion (see disc layer comment above).
      'icon-opacity': [
        'case',
        ['boolean', ['get', 'occluded'], false],
        0,
        1,
      ],
      'icon-occlusion-opacity': 0,
    },
  })

  // Text label — only visible when the payload key referenced by
  // `fieldMapping.labelField` resolved to a string on the feature.
  addLayerGuarded({
    id: ids.label,
    type: 'symbol',
    source: ids.source,
    filter: (shouldCluster || useManualCluster) ? nonClusterFilter : (['literal', true] as mapboxgl.ExpressionSpecification),
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
      // v5.4 — analytic occlusion (see disc layer comment above).
      'text-opacity': [
        'case',
        ['boolean', ['get', 'occluded'], false],
        0,
        1,
      ],
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.5,
      'symbol-z-offset': Z_OFFSET,
      'text-occlusion-opacity': 0,
    },
  })
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
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  }
  if (map.getSource(ids.source)) map.removeSource(ids.source)
}

/**
 * Build the GeoJSON FeatureCollection from the config's field mapping.
 * Skips entities whose payload doesn't yield a usable (lng, lat) — those
 * won't render, but we don't error, since the ingest pipeline accepts
 * arbitrary payloads.
 */
function pushFeatures(
  map: MapboxMapInstance,
  ids: OverlayIds,
  config: DataLinkConfig,
  entities: EntityState[],
  styleRules: ReadonlyArray<StyleRule>,
  polygons?: ReadonlyArray<PolygonShape>,
  /** v5.4 — entity keys currently occluded. Stamped as `occluded:
   *  true` on each feature's properties so the paint expression can
   *  `['case', ['get', 'occluded'], ...]` hide them. Empty / omitted
   *  means nothing hidden. */
  occludedKeys?: ReadonlySet<string>,
): void {
  const lngKey = config.fieldMapping.coordFields?.lng ?? 'lng'
  const latKey = config.fieldMapping.coordFields?.lat ?? 'lat'
  const labelKey = config.fieldMapping.labelField ?? 'label'
  const colorKey = config.fieldMapping.colorField
  const elevationKey = config.fieldMapping.elevationField
  const groupKey = config.fieldMapping.clusterGroupField

  // Polygon-id → elevation lookup. Built once per feature push so the
  // fallback in the loop below is O(1). Only populated when the user
  // has set `clusterGroupField` (typically `currentRoomId`); otherwise
  // there's no join key so the fallback can't fire.
  //
  // When the entity payload doesn't carry an `elevation` field, we
  // lift the marker to the room's own altitude. This is what makes
  // the mock work without emitting elevation per row — the polygon
  // knows how high its floor is (from config.elevation), and every
  // marker in that room inherits that height.
  const roomElevationById = new Map<number, number>()
  if (groupKey && polygons) {
    for (const p of polygons) {
      if (p.id === undefined) continue
      const z = p.config?.elevation
      if (typeof z === 'number' && Number.isFinite(z)) {
        roomElevationById.set(p.id, z)
      }
    }
  }

  const features: GeoJSON.Feature<GeoJSON.Point>[] = []
  let skippedCount = 0
  for (const e of entities) {
    // v5.4 — hard-hide via source. When the analytic occlusion pass
    // has marked this entity's key, we skip it entirely — no
    // feature enters the source, so Mapbox has nothing to draw,
    // hit-test, or hover. Opacity / filter-based approaches leak
    // through `queryRenderedFeatures` and let the user click on
    // invisible markers; skipping at push time is the only way to
    // guarantee "if it's behind something, it doesn't exist".
    if (occludedKeys && occludedKeys.has(e.entityKey)) {
      skippedCount++
      continue
    }
    // Prefer the payload's coord fields (arbitrary schema); fall
    // back to the backend-extracted `position` (only present when
    // the ingest included a top-level `[lng, lat]`).
    // Supports the same array-index / dotted-path syntax the resolver
    // uses (`currentPosition[0]`, `location.lng`, plain key), so a
    // REST source that only exposes an array position works without
    // a translation layer.
    let lng: number | undefined
    let lat: number | undefined
    const rawLng = readPayloadPath(e.payload, lngKey)
    const rawLat = readPayloadPath(e.payload, latKey)
    // File-imported sources (CSV / XLSX / JSON) preserve every value
    // as a string in `data_source_rows.payload` — the parser doesn't
    // coerce because a JSONB column is schema-less. Number() + isFinite
    // handles that path AND the native-number path from streaming
    // publishers uniformly.
    const numLng = coerceCoord(rawLng)
    const numLat = coerceCoord(rawLat)
    if (numLng !== undefined && numLat !== undefined) {
      lng = numLng
      lat = numLat
    } else if (e.position) {
      lng = e.position[0]
      lat = e.position[1]
    }
    if (lng === undefined || lat === undefined) continue

    // Read the elevation (metres above ground) — used by Mapbox
    // symbol layers to lift the marker + icon + label off the floor
    // plan raster to their real z.
    //
    // Three sources, in order of preference:
    //
    //   1. v5.3 `elevation` spec (static / field / rules) — the
    //      layer author's explicit intent wins.
    //   2. Legacy `elevationField` on the payload (pre-v5.3 configs).
    //   3. The ROOM's elevation via the polygon lookup built above.
    //      Kicks in when the entity payload has no z but the config
    //      has `clusterGroupField` mapping the payload → a polygon id
    //      (e.g. `currentRoomId`). Lets a REST source that only
    //      knows "you're in room 42" render on the right floor.
    //
    // Silent 0 when nothing hits — old data links keep rendering at
    // ground level.
    let elevationM = 0
    let elevationFromPayload = false
    const specHit = resolveFromElevationSpec(e.payload, config.fieldMapping.elevation)
    if (specHit !== undefined) {
      elevationM = specHit
      elevationFromPayload = true
    } else if (elevationKey) {
      const rawZ = readPayloadPath(e.payload, elevationKey)
      const parsed = typeof rawZ === 'number' ? rawZ : Number(rawZ)
      if (Number.isFinite(parsed)) {
        elevationM = parsed
        elevationFromPayload = true
      }
    }
    if (!elevationFromPayload && groupKey && roomElevationById.size > 0) {
      const rawGroup = readPayloadPath(e.payload, groupKey)
      // Polygon ids are integers in Postgres → the group value may
      // arrive as either a number OR its stringified form (JSON
      // preserves numeric strings sometimes). Try both.
      const asNum =
        typeof rawGroup === 'number' ? rawGroup : Number(rawGroup)
      if (Number.isFinite(asNum) && roomElevationById.has(asNum)) {
        elevationM = roomElevationById.get(asNum) ?? 0
      }
    }

    let label =
      typeof e.payload[labelKey] === 'string' || typeof e.payload[labelKey] === 'number'
        ? String(e.payload[labelKey])
        : e.entityKey
    let color =
      colorKey && typeof e.payload[colorKey] === 'string'
        ? (e.payload[colorKey] as string)
        : undefined
    let opacity: number | undefined

    // Slice-4 style-rule overrides: rules matched by the entity's
    // payload can override color/label/opacity before the paint
    // expressions consume them.
    const override = evaluateEntityRules(
      styleRules,
      config.styleRuleIds,
      e.payload,
    )
    if (override) {
      if (override.fillColor) color = override.fillColor
      if (override.iconColor) color = override.iconColor
      if (override.labelText)
        label = resolveLabelTemplate(override.labelText, e.payload)
      if (override.fillOpacity !== undefined) opacity = override.fillOpacity / 100
    }

    // Per-feature icon id — the sub-renderer's install pass
    // registered `dl-icon-<id>-<color>` via ensureDataLinkSpritesFor()
    // before this feature-push runs, so referencing the mapbox image
    // name here just works. Falls back to `map-pin` @ default color.
    const iconName = mapboxImageIdFor(
      config.style.defaultIcon ?? 'map-pin',
      config.style.iconColor,
    )

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        entityKey: e.entityKey,
        streamId: e.streamId,
        configId: config.id,
        label,
        color,
        opacity,
        elevation: elevationM,
        icon: iconName,
        // v5.4 — analytic occlusion flag. See pushFeatures signature
        // + OCCLUSION_TEXT_OPACITY at the top of this file.
        occluded: occludedKeys?.has(e.entityKey) ?? false,
        // v4 — feature-level size stamps. The disc + icon layers use
        // `['coalesce', ['get', 'discSize'], 22]` / `['coalesce',
        // ['get', 'iconSize'], 0.7]` at install so re-emitting the
        // source (via source.setData) picks up any slider change on
        // the fast path. See Mapbox perf guide + the
        // docs/pitfalls-frontend.md pitfall note on setLayoutProperty
        // text-size lag.
        discSize: config.style.markerSize ?? 22,
        iconSize: config.style.iconSize ?? 0.7,
        // groupKey is used by the manual cluster aggregator below.
        // Stamped even when the config doesn't cluster, so a later
        // toggle to enable clustering doesn't require a full source
        // rebuild.
        groupKey:
          groupKey && readPayloadPath(e.payload, groupKey) !== undefined
            ? String(readPayloadPath(e.payload, groupKey))
            : null,
        payload: JSON.stringify(e.payload),
      },
    })
  }

  // Manual clustering by `clusterGroupField`. Since Mapbox's built-in
  // cluster is geographic-only, we group features here by their
  // `groupKey` (e.g. `currentRoomId`). Groups with more than one point
  // are replaced by a single aggregate feature at the group's centroid
  // with `manualCluster: true` + `point_count: N`. Groups of size 1
  // pass through as individual features. This guarantees no bubble
  // ever straddles a group boundary — the same room's markers merge,
  // and adjacent rooms stay visually distinct.
  //
  // Only runs when `clusterGroupField` is set AND the config asks for
  // cluster mode. Otherwise the raw feature list is pushed and the
  // native cluster (or no cluster at all) draws it.
  let outFeatures: GeoJSON.Feature<GeoJSON.Point>[] = features
  const manualClusterActive =
    config.style.cluster === true && !!groupKey && features.length > 0
  if (manualClusterActive) {
    const groups = new Map<string, GeoJSON.Feature<GeoJSON.Point>[]>()
    for (const f of features) {
      const k = String(f.properties?.groupKey ?? '__ungrouped__')
      const arr = groups.get(k)
      if (arr) arr.push(f)
      else groups.set(k, [f])
    }
    outFeatures = []
    for (const arr of groups.values()) {
      if (arr.length === 1) {
        outFeatures.push(arr[0])
        continue
      }
      let cx = 0
      let cy = 0
      let cz = 0
      for (const f of arr) {
        cx += f.geometry.coordinates[0]
        cy += f.geometry.coordinates[1]
        cz += Number(f.properties?.elevation ?? 0)
      }
      cx /= arr.length
      cy /= arr.length
      cz /= arr.length
      const sample = arr[0].properties ?? {}
      outFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [cx, cy] },
        properties: {
          manualCluster: true,
          point_count: arr.length,
          point_count_abbreviated: String(arr.length),
          groupKey: sample.groupKey,
          elevation: cz,
          // Preserve the config id so the click handler can trace back.
          configId: sample.configId,
        },
      })
    }
  }

  // Stash the un-aggregated feature list so the /view drawer can
  // expand manual clusters into their leaves later.
  if (manualClusterActive && config.id !== undefined) {
    manualClusterLeaves.set(config.id, features)
  } else if (config.id !== undefined) {
    manualClusterLeaves.delete(config.id)
  }

  const src = map.getSource(ids.source) as unknown as
    | { setData: (data: GeoJSON.FeatureCollection) => void }
    | undefined
  if (src && typeof src.setData === 'function') {
    src.setData({ type: 'FeatureCollection', features: outFeatures })
  }
  // v5.4 DEBUG — see whether the skip is firing.
  // eslint-disable-next-line no-console
  console.log(`[dl-push:${config.id}]`, {
    entities: entities.length,
    occluded_key_set_size: occludedKeys?.size ?? 0,
    skipped_at_push: skippedCount,
    features_pushed: outFeatures.length,
    sample_occluded_key: occludedKeys ? [...occludedKeys][0] : null,
  })
}

function pushVisibility(map: MapboxMapInstance, ids: OverlayIds, visible: boolean): void {
  const value = visible ? 'visible' : 'none'
  for (const layerId of [ids.cluster, ids.clusterCount, ids.point, ids.icon, ids.label]) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', value)
    }
  }
}

/**
 * Move this overlay's layers to the top of the Mapbox z-stack. Same
 * needs-raise guard as the deleted `map-asset-overlay.tsx` had so the
 * `styledata` listener doesn't recurse on its own move events.
 */
function raiseToTop(map: MapboxMapInstance, ids: OverlayIds): void {
  const ownLayerIds = [ids.cluster, ids.clusterCount, ids.point, ids.icon, ids.label]
  const ownSet = new Set(ownLayerIds)
  const layers = map.getStyle()?.layers ?? []
  let lastOwnIdx = -1
  for (let i = 0; i < layers.length; i++) {
    if (ownSet.has(layers[i].id)) lastOwnIdx = i
  }
  if (lastOwnIdx < 0) return
  let needsRaise = false
  for (let i = lastOwnIdx + 1; i < layers.length; i++) {
    if (!ownSet.has(layers[i].id)) {
      needsRaise = true
      break
    }
  }
  if (!needsRaise) return
  for (const id of ownLayerIds) {
    if (map.getLayer(id)) {
      try {
        map.moveLayer(id)
      } catch {
        /* swallowed — the layer went away between check + move */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers for the shape-anchored sub-renderers below
// ---------------------------------------------------------------------------

/**
 * Compute the [lng, lat] centroid for any shape kind the resolver may
 * return, from a concrete shape object. Used by the v2 iter helper
 * below.
 */
function centroidForShape(
  shape: import('@/lib/data-link/match-resolver').MatchableShape,
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
 * Altitude of a shape's TOP face in metres. Used where a data-link
 * feature has to sit ON a shape (the tint fill) rather than at it.
 * Matches the slab exactly as its overlay draws it:
 * map-polygon-overlay floors the base at 0.11 m (POLYGON_MIN_BASE_M) and
 * both overlays floor the thickness at 0.05 m. A tint at elevation +
 * height (0 for a flat area) would sit inside that slab and never show.
 */
function slabTopM(shape: { config?: { elevation?: number; height?: number } }, minBase: number): number {
  const base = shape.config?.elevation
  const h = shape.config?.height
  return (
    Math.max(typeof base === 'number' && Number.isFinite(base) ? base : 0, minBase) +
    Math.max(typeof h === 'number' && Number.isFinite(h) ? h : 0, 0.05)
  )
}

/**
 * Metres above ground for one entity, in preference order:
 *
 *   1. the payload's own `elevationField` — the source knows its true
 *      altitude best (e.g. RTLS with vertical accuracy);
 *   2. the altitude of the shape it is anchored to — a sensor bolted to
 *      a first-floor rack belongs at that rack's height even when the
 *      payload says nothing about z;
 *   3. ground.
 *
 * Tier 2 is what puts every shape-anchored render mode on the right
 * floor without asking the operator to emit z per row.
 */
function resolveAnchorElevation(
  payload: Record<string, unknown>,
  config: DataLinkConfig,
  shape: import('@/lib/data-link/match-resolver').MatchableShape | null,
): number {
  const fromSpec = resolveFromElevationSpec(payload, config.fieldMapping.elevation)
  if (fromSpec !== undefined) return fromSpec
  // Legacy path — configs written before v5.3 only had `elevationField`.
  const legacyKey = config.fieldMapping.elevationField
  if (legacyKey) {
    const raw = readPayloadPath(payload, legacyKey)
    // File-imported sources keep every value as a string, so coerce
    // rather than type-check (same reasoning as coerceCoord).
    const parsed = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  const z = (shape as { config?: { elevation?: number } } | null)?.config
    ?.elevation
  return typeof z === 'number' && Number.isFinite(z) ? z : 0
}

/**
 * v5.3 elevation spec evaluator. Returns `undefined` when the spec
 * can't produce a definite number for this record — the caller then
 * falls through to the shape-anchor / legacy path so a partly-typed
 * spec doesn't silently pin every marker to 0.
 */
function resolveFromElevationSpec(
  payload: Record<string, unknown>,
  spec: ElevationSpec | undefined,
): number | undefined {
  if (!spec) return undefined
  switch (spec.kind) {
    case 'static':
      return Number.isFinite(spec.value) ? spec.value : undefined
    case 'field': {
      if (!spec.field) return undefined
      const raw = readPayloadPath(payload, spec.field)
      const parsed = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'rules': {
      for (const rule of spec.rules) {
        if (!rule.field || !rule.op) continue
        const raw = readPayloadPath(payload, rule.field)
        if (raw === undefined || raw === null) continue
        const haystack = String(raw)
        const needle = rule.match
        let hit = false
        switch (rule.op) {
          case 'equals':
            hit = haystack === needle
            break
          case 'contains':
            hit = haystack.includes(needle)
            break
          case 'startsWith':
            hit = haystack.startsWith(needle)
            break
          case 'endsWith':
            hit = haystack.endsWith(needle)
            break
        }
        if (hit && Number.isFinite(rule.value)) return rule.value
      }
      return typeof spec.fallback === 'number' && Number.isFinite(spec.fallback)
        ? spec.fallback
        : undefined
    }
  }
}

/**
 * v2 iterator — feeds each (entity, matched-shape) pair to the
 * caller's build function. Attribute-join with multiple matches yields
 * one call per pair. Explicit-shape yields at most one. Coord mode
 * yields at most one with `shape=null` + the payload's own position.
 *
 * The `snapshot` argument is a live reference to the useSpatialStore
 * slices the resolver reads (bins + every shape kind). Callers should
 * build it via `useMatchSnapshot()` below.
 *
 * `elevation` is resolved here rather than in each sub-renderer so that
 * every mode lands on the same floor for the same entity.
 */
function forEachEntityAnchor(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  snapshot: import('@/lib/data-link/match-resolver').MatchStoreSnapshot,
  visit: (a: {
    entity: EntityState
    shape: import('@/lib/data-link/match-resolver').MatchableShape | null
    position: [number, number]
    elevation: number
  }) => void,
  opts?: {
    /** v4 — drop entities whose resolved floor doesn't match. */
    activeFloorPlanId?: ActiveFloors
    /** Set of currently-live floor plan ids for orphan detection. */
    liveFloorPlanIds?: ReadonlySet<number>
    /** v4 — drop entities whose payload fails the layer filter. */
    filter?: DataLinkFilter | null
  },
): void {
  const activeFloor = opts?.activeFloorPlanId ?? null
  const liveIds = opts?.liveFloorPlanIds
  const filter = opts?.filter ?? null
  const floorScope = config.fieldMapping.floorScope
  let matched = 0
  let firstReason: string | null = null
  for (const entity of entities) {
    // v4 — payload filter first (cheapest, drops before match).
    if (filter && !evaluateDataLinkFilter(entity.payload, filter)) continue
    const result = resolveMatchTargets(entity.payload, config, snapshot)
    if (result.kind === 'coord') {
      // Coord path — no shape anchor. Floor gate is payload-only, but
      // still respects the config's floorScope and treats orphan floors
      // as unknown so a stale id doesn't hide the row.
      if (
        !passesFloorScope(entity.payload, floorScope, activeFloor, liveIds)
      ) {
        continue
      }
      visit({
        entity,
        shape: null,
        position: result.position,
        elevation: resolveAnchorElevation(entity.payload, config, null),
      })
      matched++
      continue
    }
    if (result.kind !== 'shapes') {
      if (firstReason === null && result.kind === 'none') firstReason = result.reason
      continue
    }
    let visited = false
    for (const shape of result.shapes) {
      // Shape-anchored path: pass the matched shape's floor as the
      // fallback source for `auto` mode. `passesFloorScope` still wins
      // the mode (`all` / `specific` short-circuit before the shape
      // floor is read).
      const shapeFloor =
        (shape as unknown as { floorPlanId?: number }).floorPlanId ?? null
      if (
        !shapeOnEntityFloor(entity.payload, floorScope, shapeFloor) ||
        !passesFloorScope(
          entity.payload,
          floorScope,
          activeFloor,
          liveIds,
          shapeFloor,
        )
      ) {
        continue
      }
      const pos = centroidForShape(shape, config.targetKind)
      if (!pos) continue
      visit({
        entity,
        shape,
        position: pos,
        elevation: resolveAnchorElevation(entity.payload, config, shape),
      })
      visited = true
    }
    if (visited) matched++
  }
  // Debug aid: when a layer has entities flowing in but none of them
  // resolve to an anchor, the sub-renderer renders 0 features and the
  // layer appears empty on the map. Log the first failure reason so
  // the operator can see WHY the match is failing (e.g. payloadField
  // not present, shape name not in store, targetShapeId stale) and
  // fix the config without bouncing through the data-link manager.
  if (entities.length > 0 && matched === 0 && firstReason !== null) {
    const firstEntity = entities[0]
    const match = config.fieldMapping?.match
    const joinDesc =
      match?.mode === 'attribute-join' || match?.mode === 'external-code'
        ? `${match.mode}(payloadField="${match.join?.payloadField}", shapeSide=${match.join?.shapeFieldSource}${match.join?.shapeField ? `(${match.join.shapeField})` : ''})`
        : match?.mode ?? 'coord'
    console.warn(
      `[data-link] no entities matched for "${config.name}"\n` +
        `  renderMode: ${config.renderMode}\n` +
        `  targetKind: ${config.targetKind}\n` +
        `  match: ${joinDesc}\n` +
        `  entityCount: ${entities.length}\n` +
        `  firstReason: ${firstReason}\n` +
        `  firstEntity.entityKey: ${firstEntity?.entityKey ?? '(none)'}\n` +
        `  firstEntity.position: ${JSON.stringify(firstEntity?.position ?? null)}\n` +
        `  firstEntity.payload: ${JSON.stringify(firstEntity?.payload ?? {})}`,
    )
  }
}

/**
 * Hook that snapshots every store slice the resolver needs. Zustand
 * hands back the current object refs so downstream memoisation +
 * WeakMap caches inside the resolver stay valid across renders.
 *
 * `overrides` lets callers substitute prop-supplied shape arrays for
 * store slices. Share-link / public-view code paths render without
 * `useSpatialStore` populated — the shapes arrive as props from the
 * share endpoint — so an attribute-join sub-renderer must feed those
 * props into the resolver, otherwise every match returns "no polygon
 * where name = X" even though the map draws them fine.
 */
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
 * not the data. Updates via `setFeatureState({source, id, occluded})`
 * so paint expressions (`text-opacity`, `icon-opacity`, `fill-opacity`,
 * `line-opacity`, `circle-opacity`, `heatmap-weight`, …) can fold in
 * `['boolean', ['get', 'occluded'], false]`.
 *
 * Returns a ref pointing at the current occluded-key set so the
 * TooltipManager can also skip hover / click on hidden entities —
 * `queryRenderedFeatures` doesn't respect paint opacity and would
 * otherwise open a tooltip over a marker the user can't see.
 *
 * `sourceId` MUST match the actual source id the sub-renderer uses,
 * and the source MUST have `promoteId: 'entityKey'` so setFeatureState
 * can key by entity string id.
 */
function useDataLinkOcclusion({
  map,
  enabled,
  installTick: _installTick,
  config,
  entities,
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
  entities: readonly EntityState[]
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
   * pushFeatures deps so features re-stamp `occluded` when hiding
   * changes. `feature-state` is not usable here because
   * `source.setData(...)` wipes it, so we stamp in the properties
   * instead — properties are copied verbatim into the source cache.
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
  const storeImages = propImages ?? []
  const storePolygons = propPolygons ?? []
  const storeCircles = propCircles ?? []
  const storeLines = propLines ?? []
  const storeStairs = propStairs ?? []
  const prisms = useMemo(
    () => {
      const built = buildOccluders({
        images: storeImages,
        polygons: storePolygons,
        circles: storeCircles,
        lines: storeLines,
        stairs: storeStairs,
      })
      // v5.4 DEBUG — see what feeds the occluder builder + what it returns.
      // eslint-disable-next-line no-console
      console.log(`[dl-prisms:${config.id}]`, {
        input_images: (storeImages ?? []).length,
        input_polygons: (storePolygons ?? []).length,
        input_lines: (storeLines ?? []).length,
        input_stairs: (storeStairs ?? []).length,
        input_circles: (storeCircles ?? []).length,
        built_prisms: built.length,
        first_polygon_visible: (storePolygons ?? [])[0]?.visible,
        first_polygon_zoneId: (storePolygons ?? [])[0]?.zoneId,
        first_polygon_config: (storePolygons ?? [])[0]?.config,
      })
      return built
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeImages, storePolygons, storeCircles, storeLines, storeStairs],
  )
  const occludedRef = useRef<Set<string>>(new Set())
  const [occludedVersion, setOccludedVersion] = useState(0)
  // v5.4 DEBUG — temporary diagnostic logs. Remove once the analytic
  // occlusion is proven end-to-end.
  const DBG = `[dl-occlude:${config.id}]`
  useEffect(() => {
    if (!map || !enabled) {
      // eslint-disable-next-line no-console
      console.log(DBG, 'effect skipped', { map: !!map, enabled })
      return
    }
    const targets: OccludableTarget[] = []
    const keyById = new Map<number, string>()
    let nextId = 0
    for (const e of entities) {
      if (!e.entityKey) continue
      const lngLat = resolvePayloadCoord(e.payload, config) ?? e.position
      if (!lngLat) continue
      const altitudeM = resolveAnchorElevation(e.payload, config, null)
      const id = nextId++
      keyById.set(id, e.entityKey)
      targets.push({
        id,
        position: lngLat,
        elevationM: altitudeM,
        floorPlanId: (e.payload?.floorPlanId as number | undefined) ?? undefined,
      })
    }
    // eslint-disable-next-line no-console
    console.log(DBG, 'effect setup', {
      entities: entities.length,
      targets: targets.length,
      prisms: prisms.length,
      sampleTarget: targets[0],
      samplePrism: prisms[0]
        ? { key: prisms[0].key, baseM: prisms[0].baseM, topM: prisms[0].topM, floorPlanId: prisms[0].floorPlanId }
        : null,
    })
    const setsEqual = (a: Set<string>, b: Set<string>) => {
      if (a.size !== b.size) return false
      for (const k of a) if (!b.has(k)) return false
      return true
    }
    let ranOnce = false
    const apply = () => {
      const occludedIds = computeOccludedIds(map, targets, prisms)
      const next = new Set<string>()
      for (const id of occludedIds) {
        const k = keyById.get(id)
        if (k) next.add(k)
      }
      if (!ranOnce) {
        ranOnce = true
        // eslint-disable-next-line no-console
        console.log(DBG, 'first apply', {
          targets: targets.length,
          prisms: prisms.length,
          occluded_count: next.size,
          occluded_keys: [...next].slice(0, 10),
        })
      }
      if (setsEqual(occludedRef.current, next)) return
      occludedRef.current = next
      // eslint-disable-next-line no-console
      console.log(DBG, 'occluded set changed', {
        size: next.size,
        keys: [...next].slice(0, 10),
      })
      // Trigger a re-push so features carry the new `occluded` flag.
      // Only bumps on set-diff so a slow pan (same visibility for every
      // frame) doesn't spam setData.
      setOccludedVersion((v) => v + 1)
    }
    apply()
    map.on('move', apply)
    return () => {
      map.off('move', apply)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, _installTick, entities, prisms, config])

  return { occludedRef, occludedVersion }
}

function useMatchSnapshot(
  overrides?: Partial<import('@/lib/data-link/match-resolver').MatchStoreSnapshot>,
): import('@/lib/data-link/match-resolver').MatchStoreSnapshot {
  const bins = useSpatialStore((s) => s.bins)
  const polygons = useSpatialStore((s) => s.polygons)
  const circles = useSpatialStore((s) => s.circles)
  const markers = useSpatialStore((s) => s.markers)
  const lines = useSpatialStore((s) => s.lines)
  const stairs = useSpatialStore((s) => s.stairs)
  const doors = useSpatialStore((s) => s.doors)
  const images = useSpatialStore((s) => s.images)
  const imagePlanes = useSpatialStore((s) => s.imagePlanes)
  const models = useSpatialStore((s) => s.models)
  const textLabels = useSpatialStore((s) => s.textLabels)
  return {
    bins: overrides?.bins ?? bins,
    polygons: overrides?.polygons ?? polygons,
    circles: overrides?.circles ?? circles,
    markers: overrides?.markers ?? markers,
    lines: overrides?.lines ?? lines,
    stairs: overrides?.stairs ?? stairs,
    doors: overrides?.doors ?? doors,
    images: overrides?.images ?? images,
    imagePlanes: overrides?.imagePlanes ?? imagePlanes,
    models: overrides?.models ?? models,
    textLabels: overrides?.textLabels ?? textLabels,
  }
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
 * Small helper: raise a set of layers to the top with the same
 * needs-raise guard as `raiseToTop` — accepts any layer id list so
 * each sub-renderer can pin its own layers without duplicating the
 * loop.
 */
function raiseLayerListToTop(map: MapboxMapInstance, layerIds: string[]): void {
  const ownSet = new Set(layerIds)
  // getStyle() throws "Style is not done loading" mid basemap swap; skip —
  // the `styledata` listener calls this again once the new style is in.
  let layers: ReturnType<MapboxMapInstance['getStyle']>['layers']
  try {
    layers = map.getStyle()?.layers ?? []
  } catch {
    return
  }
  let lastOwnIdx = -1
  for (let i = 0; i < layers.length; i++) {
    if (ownSet.has(layers[i].id)) lastOwnIdx = i
  }
  if (lastOwnIdx < 0) return
  let needsRaise = false
  for (let i = lastOwnIdx + 1; i < layers.length; i++) {
    if (!ownSet.has(layers[i].id)) {
      needsRaise = true
      break
    }
  }
  if (!needsRaise) return
  for (const id of layerIds) {
    if (map.getLayer(id)) {
      try {
        map.moveLayer(id)
      } catch {
        /* swallowed — the layer went away between check + move */
      }
    }
  }
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
function PointOnShapeSubRenderer({
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
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: LAYER_ROWS_POLL_MS, enabled },
  )
  const { entities } = useEffectiveEntities(config, query.data)
  useLayerLoading(config.id, config.name, query.isLoading)

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

  const shapeProps: ShapeAnchorProps = useMemo(
    () => ({ polygons, circles, markers, lines, models }),
    [polygons, circles, markers, lines, models],
  )

  const teardownFn = () => {
    if (map.getLayer(labelId)) map.removeLayer(labelId)
    if (map.getLayer(iconId)) map.removeLayer(iconId)
    if (map.getLayer(pointId)) map.removeLayer(pointId)
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
      map.addSource(sourceId, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey' })
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
          'text-opacity': OCCLUSION_TEXT_OPACITY,
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': 0,
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
          'icon-opacity': OCCLUSION_ICON_OPACITY,
          'icon-occlusion-opacity': 0,
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
          'text-opacity': OCCLUSION_TEXT_OPACITY,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': 0,
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
      if (map.getLayer(pointId)) {
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

  const snapshot = useMatchSnapshot({ polygons, circles, markers, lines, models })

  // v5.4 — analytic occlusion. Declared before the push effect so
  // `occludedVersion` is available as a dep — the push re-runs when
  // the occluded set changes so each feature's `occluded` property
  // re-stamps.
  const { occludedRef: pointOnShapeOccludedRef, occludedVersion: pointOnShapeOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities,
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
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const labelKey = config.fieldMapping.labelField ?? 'label'
    const colorKey = config.fieldMapping.colorField
    const iconName = mapboxImageIdFor(
      config.style.defaultIcon ?? 'map-pin',
      config.style.iconColor,
    )
    const features: GeoJSON.Feature<GeoJSON.Point>[] = []

    forEachEntityAnchor(entities, config, snapshot, ({ entity: e, position, elevation }) => {
      // v5.4 — hard-hide: occluded entities never enter the source.
      if (pointOnShapeOccludedRef.current.has(e.entityKey)) return
      let label =
        typeof e.payload[labelKey] === 'string' || typeof e.payload[labelKey] === 'number'
          ? String(e.payload[labelKey])
          : e.entityKey
      let color =
        colorKey && typeof e.payload[colorKey] === 'string'
          ? (e.payload[colorKey] as string)
          : undefined
      let opacity: number | undefined
      const override = evaluateEntityRules(
        styleRules,
        config.styleRuleIds,
        e.payload,
      )
      if (override) {
        if (override.fillColor) color = override.fillColor
        if (override.iconColor) color = override.iconColor
        if (override.labelText)
          label = resolveLabelTemplate(override.labelText, e.payload)
        if (override.fillOpacity !== undefined)
          opacity = override.fillOpacity / 100
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: position },
        properties: {
          entityKey: e.entityKey,
          streamId: e.streamId,
          configId: config.id,
          label,
          color,
          opacity,
          elevation,
          icon: iconName,
          occluded: pointOnShapeOccludedRef.current.has(e.entityKey),
          // v4 — feature-level sizes, read by data-driven expressions
          // on the disc + icon layers. Fast source.setData update path.
          discSize: config.style.markerSize ?? 11,
          iconSize: config.style.iconSize ?? 0.7,
          payload: JSON.stringify(e.payload),
        },
      })
    }, { activeFloorPlanId, liveFloorPlanIds, filter })
    setGeoJSONData(map, sourceId, { type: 'FeatureCollection', features })
    raiseLayerListToTop(map, ownLayerIds)
  }, [
    map,
    sourceId,
    ownLayerIds,
    config,
    entities,
    enabled,
    shapeProps,
    styleRules,
    snapshot,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    pointOnShapeOccludedVersion,
  ])

  useEffect(() => {
    if (!enabled) return
    const onStyleData = () => raiseLayerListToTop(map, ownLayerIds)
    map.on('styledata', onStyleData)
    return () => {
      map.off('styledata', onStyleData)
    }
  }, [map, ownLayerIds, enabled])

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])


  return (
    <TooltipManager
      map={map}
      config={config}
      layerIds={ownLayerIds}
      occludedKeysRef={pointOnShapeOccludedRef}
    />
  )
}

// ---------------------------------------------------------------------------
// gauge-on-shape sub-renderer
// ---------------------------------------------------------------------------

/**
 * Value badge stacked at a shape's centroid. Circle background + text
 * for each entity — the typical case is one sensor per shape so the
 * stack is a single badge.
 */
function GaugeOnShapeSubRenderer({
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
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: LAYER_ROWS_POLL_MS, enabled },
  )
  const { entities } = useEffectiveEntities(config, query.data)
  useLayerLoading(config.id, config.name, query.isLoading)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const bgId = `dl-${config.id}-gauge-bg`
  const textId = `dl-${config.id}-gauge-text`
  const ownLayerIds = useMemo(() => [bgId, textId], [bgId, textId])

  const shapeProps: ShapeAnchorProps = useMemo(
    () => ({ polygons, circles, markers, lines, models }),
    [polygons, circles, markers, lines, models],
  )

  const teardownFn = () => {
    if (map.getLayer(textId)) map.removeLayer(textId)
    if (map.getLayer(bgId)) map.removeLayer(bgId)
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }

  useStyleReadyInstall(
    map,
    enabled,
    () => {
      if (map.getSource(sourceId)) teardownFn()
      map.addSource(sourceId, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey' })
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
          'text-color': defaultColor,
          // v5.4 — analytic occlusion fold. Multiplied against the
          // gauge's authored 0.92 so occluded features hard-hide (0)
          // while visible ones keep the original translucency.
          'text-opacity': [
            'case',
            ['boolean', ['get', 'occluded'], false],
            0,
            0.92,
          ],
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': 0,
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
          'text-opacity': OCCLUSION_TEXT_OPACITY,
          'text-halo-color': 'rgba(0,0,0,0.35)',
          'text-halo-width': 1,
          'symbol-z-offset': Z_OFFSET,
          'text-occlusion-opacity': 0,
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
      if (map.getLayer(bgId)) {
        // Size rides on the feature's `badgeSize` stamp (see install);
        // only the colour needs an explicit paint sync.
        map.setPaintProperty(bgId, 'text-color', defaultColor)
      }
    } catch { /* mid-teardown */ }
  }, [map, enabled, installTick, bgId, config.style.badgeSize, config.style.defaultColor])

  const snapshot = useMatchSnapshot({ polygons, circles, markers, lines, models })

  // v5.4 — analytic occlusion. See useDataLinkOcclusion + the point-
  // at-coord sub-renderer's usage for the pattern.
  const { occludedRef: gaugeOccludedRef, occludedVersion: gaugeOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // Uses the mapping's labelField as the value source; if the caller
    // hasn't set one, falls back to a `value` key (common convention
    // for sensor payloads). Future: a dedicated valueField on the
    // mapping — for now labelField ?? 'value' keeps the surface small.
    const valueKey = config.fieldMapping.labelField ?? 'value'
    const features: GeoJSON.Feature<GeoJSON.Point>[] = []

    forEachEntityAnchor(entities, config, snapshot, ({ entity: e, position, elevation }) => {
      // v5.4 — hard-hide: occluded entities never enter the source.
      if (gaugeOccludedRef.current.has(e.entityKey)) return
      const raw = e.payload[valueKey]
      let value =
        typeof raw === 'string' || typeof raw === 'number'
          ? String(raw)
          : e.entityKey
      let color: string | undefined
      let opacity: number | undefined
      const override = evaluateEntityRules(
        styleRules,
        config.styleRuleIds,
        e.payload,
      )
      if (override) {
        if (override.fillColor) color = override.fillColor
        if (override.iconColor) color = override.iconColor
        if (override.labelText)
          value = resolveLabelTemplate(override.labelText, e.payload)
        if (override.fillOpacity !== undefined)
          opacity = override.fillOpacity / 100
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: position },
        properties: {
          entityKey: e.entityKey,
          streamId: e.streamId,
          configId: config.id,
          value,
          label: value,
          color,
          opacity,
          elevation,
          badgeSize: config.style.badgeSize ?? 18,
          occluded: gaugeOccludedRef.current.has(e.entityKey),
          payload: JSON.stringify(e.payload),
        },
      })
    }, { activeFloorPlanId, liveFloorPlanIds, filter })
    setGeoJSONData(map, sourceId, { type: 'FeatureCollection', features })
    raiseLayerListToTop(map, ownLayerIds)
  }, [
    map,
    sourceId,
    ownLayerIds,
    config,
    entities,
    enabled,
    shapeProps,
    styleRules,
    snapshot,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    gaugeOccludedVersion,
  ])

  useEffect(() => {
    if (!enabled) return
    const onStyleData = () => raiseLayerListToTop(map, ownLayerIds)
    map.on('styledata', onStyleData)
    return () => {
      map.off('styledata', onStyleData)
    }
  }, [map, ownLayerIds, enabled])

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])


  return (
    <TooltipManager
      map={map}
      config={config}
      layerIds={ownLayerIds}
      occludedKeysRef={gaugeOccludedRef}
    />
  )
}

// ---------------------------------------------------------------------------
// shape-tint sub-renderer
// ---------------------------------------------------------------------------

/**
 * Paints a fill layer over the bound polygon/circle using the config's
 * defaultColor. Renders even when 0 entities exist — the tint IS the
 * point; data-driven tint is a Slice 4 (style rules) job.
 */
function ShapeTintSubRenderer({
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
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: LAYER_ROWS_POLL_MS, enabled },
  )
  const { entities } = useEffectiveEntities(config, query.data)
  useLayerLoading(config.id, config.name, query.isLoading)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const tintId = `dl-${config.id}-tint`
  const ownLayerIds = useMemo(() => [tintId], [tintId])

  const teardownFn = () => {
    if (map.getLayer(tintId)) map.removeLayer(tintId)
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
  useEffect(() => {
    if (!enabled || !map) return
    const fillOpacity = config.style.fillOpacity ?? 0.5
    const defaultColor = config.style.defaultColor ?? '#3b82f6'
    try {
      if (map.getLayer(tintId)) {
        map.setPaintProperty(tintId, 'fill-opacity', [
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

  // Live snapshot of every store slice the resolver may read. Grabbing
  // the whole state on each rebuild is cheap (Zustand hands back the
  // current object reference) and ensures attribute-join sees fresh
  // bins + shapes.
  const storeBins = useSpatialStore((s) => s.bins)
  const storeMarkers = useSpatialStore((s) => s.markers)
  const storeLines = useSpatialStore((s) => s.lines)
  const storeStairs = useSpatialStore((s) => s.stairs)
  const storeDoors = useSpatialStore((s) => s.doors)
  const storeImages = useSpatialStore((s) => s.images)
  const storeImagePlanes = useSpatialStore((s) => s.imagePlanes)
  const storeModels = useSpatialStore((s) => s.models)
  const storeTextLabels = useSpatialStore((s) => s.textLabels)

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
    entities,
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
  useEffect(() => {
    if (!enabled || !installedRef.current) return

    const snapshot = {
      bins: storeBins,
      polygons: [...polygons],
      circles: [...circles],
      markers: [...storeMarkers],
      lines: [...storeLines],
      stairs: [...storeStairs],
      doors: [...storeDoors],
      images: [...storeImages],
      imagePlanes: [...storeImagePlanes],
      models: [...storeModels],
      textLabels: [...storeTextLabels],
    }

    // shapeId → { color?, opacity?, payload? } — last write wins when
    // multiple entities target the same shape.
    const perShape = new Map<
      number,
      { color?: string; opacity?: number; payload?: Record<string, unknown> }
    >()

    // If the config has no entities YET but IS bound to a single shape
    // (explicit or legacy), still tint that shape with the defaults so
    // the visual isn't invisible until the first stream event.
    const alwaysTintFallback = (() => {
      const result = resolveMatchTargets({}, config, snapshot)
      if (result.kind === 'shapes') {
        for (const s of result.shapes) {
          if (s.id !== undefined && !perShape.has(s.id)) {
            perShape.set(s.id, {})
          }
        }
      }
    })

    if (entities.length === 0) {
      alwaysTintFallback()
    } else {
      for (const e of entities) {
        // v5.4 — hard-hide: occluded entities do not tint their shape.
        if (tintOccludedRef.current.has(e.entityKey)) continue
        // v4 — layer filter first (cheapest gate).
        if (filter && !evaluateDataLinkFilter(e.payload, filter)) continue
        const target = resolveMatchTargets(e.payload, config, snapshot)
        if (target.kind !== 'shapes') continue
        const override = evaluateEntityRules(
          styleRules,
          config.styleRuleIds,
          e.payload,
        )
        const patch: {
          color?: string
          opacity?: number
          payload?: Record<string, unknown>
        } = {}
        if (override?.fillColor) patch.color = override.fillColor
        else if (override?.iconColor) patch.color = override.iconColor
        if (override?.fillOpacity !== undefined) patch.opacity = override.fillOpacity / 100
        patch.payload = e.payload as Record<string, unknown>
        for (const s of target.shapes) {
          if (s.id === undefined) continue
          // Floor gate honours the config's floorScope + treats orphan
          // shape/payload floor references as unknown. The tinted shape's
          // own floorPlanId is passed as the fallback for `auto` mode.
          const shapeFloor =
            (s as unknown as { floorPlanId?: number }).floorPlanId ?? null
          if (
            !shapeOnEntityFloor(e.payload as Record<string, unknown>, config.fieldMapping.floorScope, shapeFloor) ||
            !passesFloorScope(
              e.payload as Record<string, unknown>,
              config.fieldMapping.floorScope,
              activeFloorPlanId ?? null,
              liveFloorPlanIds,
              shapeFloor,
            )
          ) {
            continue
          }
          perShape.set(s.id, patch)
        }
      }
    }

    const features: GeoJSON.Feature<GeoJSON.Polygon>[] = []
    for (const [shapeId, styleForShape] of perShape) {
      const props = {
        configId: config.id,
        color: styleForShape.color,
        opacity: styleForShape.opacity,
        payload: styleForShape.payload
          ? JSON.stringify(styleForShape.payload)
          : undefined,
      }
      if (config.targetKind === 'polygon') {
        const p = polygons.find((x) => x.id === shapeId)
        if (p && p.vertices.length >= 3) {
          const ring: [number, number][] = [...p.vertices, p.vertices[0]]
          features.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            // Top face, not the base: tinting an extruded room at its
            // base would bury the tint inside the solid. A flat room
            // still draws as a thin slab, so use its drawn top.
            properties: { ...props, elevation: slabTopM(p, 0.11) },
          })
        }
      } else if (config.targetKind === 'circle') {
        const c = circles.find((x) => x.id === shapeId)
        if (c) {
          for (const feat of buildCircleFeatures(c)) {
            features.push({
              type: 'Feature',
              geometry: feat.geometry,
              properties: { ...props, elevation: slabTopM(c, 0) },
            })
          }
        }
      }
    }
    setGeoJSONData(map, sourceId, { type: 'FeatureCollection', features })
    raiseLayerListToTop(map, ownLayerIds)
  }, [
    map,
    sourceId,
    ownLayerIds,
    config,
    polygons,
    circles,
    enabled,
    entities,
    styleRules,
    storeBins,
    storeMarkers,
    storeLines,
    storeStairs,
    storeDoors,
    storeImages,
    storeImagePlanes,
    storeModels,
    storeTextLabels,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    tintOccludedVersion,
  ])

  useEffect(() => {
    if (!enabled) return
    const onStyleData = () => raiseLayerListToTop(map, ownLayerIds)
    map.on('styledata', onStyleData)
    return () => {
      map.off('styledata', onStyleData)
    }
  }, [map, ownLayerIds, enabled])

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return <TooltipManager map={map} config={config} layerIds={ownLayerIds} />
}

// ---------------------------------------------------------------------------
// heatmap sub-renderer
// ---------------------------------------------------------------------------

/**
 * Renders a Mapbox `heatmap` layer over the layer's records.
 * Falls back to a per-point circle at high zoom so individual points
 * remain visible past the point where the heatmap fades.
 */
function HeatmapSubRenderer({
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
  const historyQuery = useApiQuery<TableRowEvent[]>(
    () =>
      config.sourceId !== undefined && useHistorySource
        ? listTableEvents(config.sourceId, {
            windowSec: historyWindowSec,
            limit: 5000,
          })
        : Promise.resolve([]),
    ['heatmap-events', tenantId, config.sourceId ?? 0, historyWindowSec],
    { intervalMs: LAYER_ROWS_POLL_MS, enabled: enabled && useHistorySource },
  )
  const liveQuery = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: LAYER_ROWS_POLL_MS, enabled: enabled && !useHistorySource },
  )
  const liveEntities = useMemo(
    () =>
      useHistorySource
        ? eventsToEntities(historyQuery.data ?? [])
        : liveQuery.data ?? [],
    [useHistorySource, historyQuery.data, liveQuery.data],
  )
  const { entities } = useEffectiveEntities(config, liveEntities)
  useLayerLoading(
    config.id,
    config.name,
    useHistorySource ? historyQuery.isLoading : liveQuery.isLoading,
  )

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const heatmapId = `dl-${config.id}-heatmap`
  const heatpointId = `dl-${config.id}-heatmap-point`
  const ownLayerIds = useMemo(() => [heatmapId, heatpointId], [heatmapId, heatpointId])

  const teardownFn = () => {
    if (map.getLayer(heatpointId)) map.removeLayer(heatpointId)
    if (map.getLayer(heatmapId)) map.removeLayer(heatmapId)
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
          'text-occlusion-opacity': 0,
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
      if (map.getLayer(heatmapId)) {
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
    entities,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const features: GeoJSON.Feature<GeoJSON.Point>[] = []
    // v2: coord lookup via resolvePayloadCoord() so legacy configs
    // AND explicit `match.mode='coord'` configs both work through the
    // same code path. resolveMatchTargets returns kind='coord' with
    // the resolved position, which we destructure here.
    for (const e of entities) {
      // v5.4 — hard-hide: occluded entities do not contribute to density.
      if (heatmapOccludedRef.current.has(e.entityKey)) continue
      // Layer filter + floor gate. Heatmap has no matched shape, so
      // `passesFloorScope` reads floor from the payload only (and
      // treats orphan ids as unknown).
      if (filter && !evaluateDataLinkFilter(e.payload, filter)) continue
      if (
        !passesFloorScope(
          e.payload,
          config.fieldMapping.floorScope,
          activeFloorPlanId ?? null,
          liveFloorPlanIds,
        )
      ) {
        continue
      }
      const position = resolvePayloadCoord(e.payload, config)
      if (!position) continue
      const [rawLng, rawLat] = position
      let color: string | undefined
      let opacity: number | undefined
      const override = evaluateEntityRules(
        styleRules,
        config.styleRuleIds,
        e.payload,
      )
      if (override) {
        if (override.fillColor) color = override.fillColor
        if (override.iconColor && !color) color = override.iconColor
        if (override.fillOpacity !== undefined)
          opacity = override.fillOpacity / 100
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [rawLng, rawLat] },
        properties: {
          entityKey: e.entityKey,
          streamId: e.streamId,
          configId: config.id,
          // v5: heatmap-weight expression coalesces on `weight`, so
          // rules that lower a point's opacity (e.g. "weak-signal RFID"
          // at 40%) also lower its contribution to the density gradient.
          // Defaults to 1 when no rule matches.
          weight: opacity ?? 1,
          color,
          opacity,
          // Only feeds the high-zoom dot layer — the heatmap pass
          // itself is screen-space and has no notion of altitude.
          elevation: resolveAnchorElevation(e.payload, config, null),
          payload: JSON.stringify(e.payload),
        },
      })
    }
    setGeoJSONData(map, sourceId, { type: 'FeatureCollection', features })
    raiseLayerListToTop(map, ownLayerIds)
  }, [map, sourceId, ownLayerIds, config, entities, enabled, styleRules, activeFloorPlanId, liveFloorPlanIds, filter, installTick, heatmapOccludedVersion])

  useEffect(() => {
    if (!enabled) return
    const onStyleData = () => raiseLayerListToTop(map, ownLayerIds)
    map.on('styledata', onStyleData)
    return () => {
      map.off('styledata', onStyleData)
    }
  }, [map, ownLayerIds, enabled])

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return <TooltipManager map={map} config={config} layerIds={ownLayerIds} occludedKeysRef={heatmapOccludedRef} />
}

// ---------------------------------------------------------------------------
// track sub-renderer
// ---------------------------------------------------------------------------

/**
 * Per-entity breadcrumb LineString + a `circle` for each entity's
 * latest position. Groups events by entityKey, sorts by ts ascending,
 * connects the dots.
 */
function TrackSubRenderer({
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
  const query = useApiQuery(
    () => listEntityEventsForStream(config.streamId, { windowSec: 300 }),
    ['entity-events', tenantId, config.streamId, 300],
    { intervalMs: LAYER_ROWS_POLL_MS, enabled },
  )
  const events = useMemo(() => query.data ?? [], [query.data])
  useLayerLoading(config.id, config.name, query.isLoading)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const lineSrc = `dl-${config.id}-track-line-src`
  const headSrc = `dl-${config.id}-track-head-src`
  const lineId = `dl-${config.id}-track-line`
  const headId = `dl-${config.id}-track-head`
  const ownLayerIds = useMemo(() => [lineId, headId], [lineId, headId])

  const teardownFn = () => {
    if (map.getLayer(headId)) map.removeLayer(headId)
    if (map.getLayer(lineId)) map.removeLayer(lineId)
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
          'text-occlusion-opacity': 0,
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
      if (map.getLayer(lineId)) {
        map.setPaintProperty(lineId, 'line-width', lineWidth)
        map.setPaintProperty(lineId, 'line-color', [
          'coalesce', ['get', 'color'], defaultColor,
        ])
      }
      if (map.getLayer(headId)) {
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
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  useEffect(() => {
    if (!enabled || !installedRef.current) return

    // Bucket by entity key. v2: coord read via resolvePayloadCoord()
    // so track shares the same coord path as heatmap + point-at-coord.
    const buckets = new Map<string, Array<{ event: EntityEvent; pos: [number, number] }>>()
    for (const e of events) {
      // v5.4 — hard-hide: drop every event belonging to an occluded track.
      if (trackOccludedRef.current.has(e.entityKey)) continue
      // Layer filter + floor gate. Track has no matched shape, so
      // `passesFloorScope` reads floor from the payload only (and
      // treats orphan ids as unknown).
      if (filter && !evaluateDataLinkFilter(e.payload, filter)) continue
      if (
        !passesFloorScope(
          e.payload,
          config.fieldMapping.floorScope,
          activeFloorPlanId ?? null,
          liveFloorPlanIds,
        )
      ) {
        continue
      }
      const pos = resolvePayloadCoord(e.payload, config)
      if (!pos) continue
      const bucket = buckets.get(e.entityKey) ?? []
      bucket.push({ event: e, pos })
      buckets.set(e.entityKey, bucket)
    }

    const lineFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = []
    const headFeatures: GeoJSON.Feature<GeoJSON.Point>[] = []
    for (const [entityKey, entries] of buckets) {
      // Sort ascending by ts so the LineString flows past → present.
      entries.sort((a, b) => a.event.ts.getTime() - b.event.ts.getTime())
      const bucket = entries.map((x) => x.event)
      const coords: [number, number][] = entries.map((x) => x.pos)
      // Style-rule override applies against the most recent event's
      // payload — one entity's whole track shares the same color.
      const latestEvent = bucket[bucket.length - 1]
      let color: string | undefined
      let opacity: number | undefined
      let label: string | undefined
      const override = latestEvent
        ? evaluateEntityRules(
            styleRules,
            config.styleRuleIds,
            latestEvent.payload,
          )
        : null
      if (override) {
        if (override.fillColor) color = override.fillColor
        if (override.iconColor && !color) color = override.iconColor
        if (override.labelText)
          label = resolveLabelTemplate(override.labelText, latestEvent.payload)
        if (override.fillOpacity !== undefined)
          opacity = override.fillOpacity / 100
      }
      const trackPayload = latestEvent
        ? JSON.stringify(latestEvent.payload)
        : undefined
      // `line-z-offset` lifts a whole feature, not a vertex, so the
      // breadcrumb rides at the floor the entity is on NOW. A track
      // that crossed floors mid-history is drawn at its latest one.
      const trackElevation = latestEvent
        ? resolveAnchorElevation(latestEvent.payload, config, null)
        : 0
      if (coords.length >= 2) {
        lineFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: {
            entityKey,
            configId: config.id,
            color,
            opacity,
            label,
            elevation: trackElevation,
            payload: trackPayload,
          },
        })
      }
      const latest = coords[coords.length - 1]
      if (latest) {
        headFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: latest },
          properties: {
            entityKey,
            configId: config.id,
            color,
            opacity,
            label,
            elevation: trackElevation,
            payload: trackPayload,
          },
        })
      }
    }
    setGeoJSONData(map, lineSrc, { type: 'FeatureCollection', features: lineFeatures })
    setGeoJSONData(map, headSrc, { type: 'FeatureCollection', features: headFeatures })
    raiseLayerListToTop(map, ownLayerIds)
  }, [map, lineSrc, headSrc, ownLayerIds, config, events, enabled, styleRules, activeFloorPlanId, liveFloorPlanIds, filter, installTick, trackOccludedVersion])

  useEffect(() => {
    if (!enabled) return
    const onStyleData = () => raiseLayerListToTop(map, ownLayerIds)
    map.on('styledata', onStyleData)
    return () => {
      map.off('styledata', onStyleData)
    }
  }, [map, ownLayerIds, enabled])

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return <TooltipManager map={map} config={config} layerIds={ownLayerIds} occludedKeysRef={trackOccludedRef} />
}

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
function FovConeSubRenderer({
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
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: LAYER_ROWS_POLL_MS, enabled },
  )
  const { entities } = useEffectiveEntities(config, query.data)
  useLayerLoading(config.id, config.name, query.isLoading)

  const installedRef = useRef(false)
  const [installTick, setInstallTick] = useState(0)
  const sourceId = `dl-${config.id}-src`
  const fillId = `dl-${config.id}-fov-fill`
  const outlineId = `dl-${config.id}-fov-outline`
  const ownLayerIds = useMemo(() => [fillId, outlineId], [fillId, outlineId])

  const shapeProps: ShapeAnchorProps = useMemo(
    () => ({ polygons, circles, markers, lines, models }),
    [polygons, circles, markers, lines, models],
  )

  const teardownFn = () => {
    if (map.getLayer(outlineId)) map.removeLayer(outlineId)
    if (map.getLayer(fillId)) map.removeLayer(fillId)
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
  useEffect(() => {
    if (!enabled || !map) return
    const fillOpacity = config.style.fillOpacity ?? 0.3
    const outlineWidth = config.style.outlineWidth ?? 1.5
    const defaultColor = config.style.defaultColor ?? '#3b82f6'
    try {
      if (map.getLayer(fillId)) {
        map.setPaintProperty(fillId, 'fill-opacity', [
          'coalesce', ['get', 'opacity'], fillOpacity,
        ])
        map.setPaintProperty(fillId, 'fill-color', [
          'coalesce', ['get', 'color'], defaultColor,
        ])
      }
      if (map.getLayer(outlineId)) {
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

  const snapshot = useMatchSnapshot({ polygons, circles, markers, lines, models })

  // v5.4 — analytic occlusion. A camera bolted to a wall on the
  // ground floor doesn't throw its cone through the ceiling of the
  // floor above; hide the cone entirely when its apex is under a slab.
  const { occludedRef: fovOccludedRef, occludedVersion: fovOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    // Field keys — hardcoded per the current design; future work can
    // expose these as `config.fieldMapping.fovFields.{yaw,fov,distance}`.
    const YAW_KEY = 'yaw'
    const FOV_KEY = 'fovDeg'
    const DIST_KEY = 'viewDistanceM'
    const metersPerDegLat = 111320

    const features: GeoJSON.Feature<GeoJSON.Polygon>[] = []
    forEachEntityAnchor(entities, config, snapshot, ({ entity: e, position: anchor, elevation }) => {
      // v5.4 — hard-hide: occluded entities never emit a cone.
      if (fovOccludedRef.current.has(e.entityKey)) return
      const yaw = typeof e.payload[YAW_KEY] === 'number' ? (e.payload[YAW_KEY] as number) : 0
      const fovDeg =
        typeof e.payload[FOV_KEY] === 'number' ? (e.payload[FOV_KEY] as number) : 60
      const dist =
        typeof e.payload[DIST_KEY] === 'number' ? (e.payload[DIST_KEY] as number) : 10
      const halfFov = ((fovDeg / 2) * Math.PI) / 180
      const yawRad = (yaw * Math.PI) / 180
      // Rough m → deg conversion at the anchor's latitude. Computed
      // per-anchor because attribute-join can spread the cones across
      // shapes at different latitudes.
      const metersPerDegLng = 111320 * Math.cos((anchor[1] * Math.PI) / 180)

      const baseCenterMx = Math.sin(yawRad) * dist
      const baseCenterMy = Math.cos(yawRad) * dist
      const halfBase = dist * Math.tan(halfFov)
      const perpMx = Math.cos(yawRad)
      const perpMy = -Math.sin(yawRad)

      const leftM: [number, number] = [
        baseCenterMx - perpMx * halfBase,
        baseCenterMy - perpMy * halfBase,
      ]
      const rightM: [number, number] = [
        baseCenterMx + perpMx * halfBase,
        baseCenterMy + perpMy * halfBase,
      ]

      const toLngLat = (mx: number, my: number): [number, number] => [
        anchor[0] + mx / metersPerDegLng,
        anchor[1] + my / metersPerDegLat,
      ]

      const apex = anchor
      const left = toLngLat(leftM[0], leftM[1])
      const right = toLngLat(rightM[0], rightM[1])
      const ring: [number, number][] = [apex, left, right, apex]

      let color: string | undefined
      let opacity: number | undefined
      const override = evaluateEntityRules(
        styleRules,
        config.styleRuleIds,
        e.payload,
      )
      if (override) {
        if (override.fillColor) color = override.fillColor
        if (override.iconColor && !color) color = override.iconColor
        if (override.fillOpacity !== undefined)
          opacity = override.fillOpacity / 100
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {
          entityKey: e.entityKey,
          streamId: e.streamId,
          configId: config.id,
          color,
          opacity,
          elevation,
          payload: JSON.stringify(e.payload),
        },
      })
    }, { activeFloorPlanId, liveFloorPlanIds, filter })
    setGeoJSONData(map, sourceId, { type: 'FeatureCollection', features })
    raiseLayerListToTop(map, ownLayerIds)
  }, [
    map,
    sourceId,
    ownLayerIds,
    config,
    entities,
    enabled,
    shapeProps,
    styleRules,
    snapshot,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    fovOccludedVersion,
  ])

  useEffect(() => {
    if (!enabled) return
    const onStyleData = () => raiseLayerListToTop(map, ownLayerIds)
    map.on('styledata', onStyleData)
    return () => {
      map.off('styledata', onStyleData)
    }
  }, [map, ownLayerIds, enabled])

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return <TooltipManager map={map} config={config} layerIds={ownLayerIds} occludedKeysRef={fovOccludedRef} />
}

// ---------------------------------------------------------------------------
// roi-pulse sub-renderer
// ---------------------------------------------------------------------------

/**
 * Pulsing ring at a shape's centroid + a count badge showing how many
 * entities the stream currently has bound to this config. The ring's
 * radius animates on a 1 s cycle via a 100 ms setInterval.
 */
function RoiPulseSubRenderer({
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
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId }),
    // v4 — filter + floor participate in the cache key so a config
    // toggled between "no filter" and "status=active" doesn't stale
    // its cache. JSON.stringify on the filter tree is fine — the tree
    // is small and stable across renders when the widget isn't open.
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloorPlanId), JSON.stringify(filter ?? null)],
    { intervalMs: LAYER_ROWS_POLL_MS, enabled },
  )
  const { entities } = useEffectiveEntities(config, query.data)
  useLayerLoading(config.id, config.name, query.isLoading)

  const installedRef = useRef(false)
  // The halo pulses by fading, not by growing: its size is now
  // `text-size`, a LAYOUT property, and re-setting layout on a 100 ms
  // timer would re-run symbol layout every tick. Opacity is paint, so
  // it animates for free.
  const [haloOpacity, setHaloOpacity] = useState(0.35)
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

  const shapeProps: ShapeAnchorProps = useMemo(
    () => ({ polygons, circles, markers, lines, models }),
    [polygons, circles, markers, lines, models],
  )

  const teardownFn = () => {
    if (map.getLayer(countId)) map.removeLayer(countId)
    if (map.getLayer(discId)) map.removeLayer(discId)
    if (map.getLayer(ringId)) map.removeLayer(ringId)
    if (map.getLayer(haloId)) map.removeLayer(haloId)
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }

  useStyleReadyInstall(
    map,
    enabled,
    () => {
      if (map.getSource(sourceId)) teardownFn()
      map.addSource(sourceId, { type: 'geojson', data: emptyFC(), promoteId: 'entityKey' })
      const defaultColor = config.style.defaultColor ?? '#ef4444'
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
          'text-occlusion-opacity': 0,
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
          'text-occlusion-opacity': 0,
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
          'text-occlusion-opacity': 0,
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
          'text-occlusion-opacity': 0,
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
      setHaloOpacity(0.35 * (1 - phase))
    }, 100)
    return () => clearInterval(interval)
  }, [enabled])

  const snapshot = useMatchSnapshot({ polygons, circles, markers, lines, models })

  // v5.4 — analytic occlusion. Occluded entities never contribute to a
  // ring; a ring whose every entity is occluded therefore disappears.
  const { occludedRef: roiOccludedRef, occludedVersion: roiOccludedVersion } = useDataLinkOcclusion({
    map,
    enabled: enabled && installTick > 0,
    installTick,
    config,
    entities,
    images: occluderImages,
    polygons: occluderPolygons,
    circles: occluderCircles,
    lines: occluderLines,
    stairs: occluderStairs,
  })

  // Push one ring per matched shape (attribute-join can hit many); the
  // count on each ring is the number of entities whose payload resolved
  // to that particular shape. Explicit-shape produces exactly one ring.
  useEffect(() => {
    if (!enabled || !installedRef.current) return

    // Group by (matched shape id, or the coord anchor as a fallback).
    // First entity's style-rule override becomes the ring's colour.
    const perAnchor = new Map<
      string,
      {
        position: [number, number]
        elevation: number
        entities: EntityState[]
        color?: string
        opacity?: number
        payload?: Record<string, unknown>
      }
    >()

    forEachEntityAnchor(
      entities,
      config,
      snapshot,
      ({ entity: e, shape, position, elevation }) => {
        // v5.4 — hard-hide: don't count occluded entities toward the ring.
        if (roiOccludedRef.current.has(e.entityKey)) return
        const key = shape?.id !== undefined ? `s:${shape.id}` : `p:${position[0]},${position[1]}`
        let bucket = perAnchor.get(key)
        if (!bucket) {
          bucket = { position, elevation, entities: [] }
          perAnchor.set(key, bucket)
        }
        bucket.entities.push(e)
        if (!bucket.color) {
          const override = evaluateEntityRules(
            styleRules,
            config.styleRuleIds,
            e.payload,
          )
          if (override) {
            if (override.fillColor) bucket.color = override.fillColor
            if (override.iconColor && !bucket.color) bucket.color = override.iconColor
            if (override.fillOpacity !== undefined)
              bucket.opacity = override.fillOpacity / 100
            bucket.payload = e.payload
          }
        }
        if (!bucket.payload) bucket.payload = e.payload
      },
      { activeFloorPlanId, liveFloorPlanIds, filter },
    )

    // One row per anchor (a reader, a door sensor) always counts "1";
    // show its `labelField` value instead when one is configured.
    const labelField = config.fieldMapping.labelField
    const badgeText = (bucket: { entities: EntityState[] }): string => {
      if (labelField && bucket.entities.length === 1) {
        const v = readPayloadPath(bucket.entities[0].payload, labelField)
        if (v !== undefined && v !== null && v !== '') return String(v)
      }
      return String(bucket.entities.length)
    }
    const features: GeoJSON.Feature<GeoJSON.Point>[] = []
    for (const bucket of perAnchor.values()) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: bucket.position },
        properties: {
          configId: config.id,
          count: badgeText(bucket),
          color: bucket.color,
          opacity: bucket.opacity,
          elevation: bucket.elevation,
          payload: bucket.payload ? JSON.stringify(bucket.payload) : undefined,
        },
      })
    }
    setGeoJSONData(map, sourceId, { type: 'FeatureCollection', features })
    raiseLayerListToTop(map, ownLayerIds)
  }, [
    map,
    sourceId,
    ownLayerIds,
    config,
    entities,
    enabled,
    shapeProps,
    styleRules,
    snapshot,
    activeFloorPlanId,
    liveFloorPlanIds,
    filter,
    installTick,
    roiOccludedVersion,
  ])

  // Drive the halo pulse via paint properties. `setPaintProperty`
  // is fine for scalar values — no data expression needed.
  useEffect(() => {
    if (!enabled || !installedRef.current) return
    if (map.getLayer(haloId)) {
      try {
        map.setPaintProperty(haloId, 'text-opacity', haloOpacity)
      } catch {
        /* swallowed — layer went away between check + set */
      }
    }
  }, [map, haloId, haloOpacity, enabled, installTick])

  useEffect(() => {
    if (!enabled) return
    const onStyleData = () => raiseLayerListToTop(map, ownLayerIds)
    map.on('styledata', onStyleData)
    return () => {
      map.off('styledata', onStyleData)
    }
  }, [map, ownLayerIds, enabled])

  useEffect(() => {
    if (!enabled || !installedRef.current) return
    const value = visible ? 'visible' : 'none'
    for (const id of ownLayerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value)
    }
  }, [map, ownLayerIds, visible, enabled, installTick])

  return <TooltipManager map={map} config={config} layerIds={ownLayerIds} occludedKeysRef={roiOccludedRef} />
}

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
    let allPresent = layerIds.every((id) => map.getLayer(id) !== undefined)
    const onStyleData = () => {
      const nowAllPresent = layerIds.every(
        (id) => map.getLayer(id) !== undefined,
      )
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
    const liveLayerIds = layerIds.filter((id) => map.getLayer(id) !== undefined)
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

    const onMouseMove = (e: mapboxgl.MapMouseEvent) => {
      if (trigger !== 'hover') return
      if (owner === 'click') return
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

    if (trigger === 'hover') {
      // Layer-scoped mousemove: fires only for our layers.
      for (const id of liveLayerIds) {
        map.on('mousemove', id, onMouseMove)
        map.on('mouseleave', id, onMouseLeave)
      }
    } else {
      for (const id of liveLayerIds) {
        map.on('click', id, onLayerClick)
      }
      map.on('click', onMapClick)
    }

    return () => {
      if (trigger === 'hover') {
        for (const id of liveLayerIds) {
          map.off('mousemove', id, onMouseMove)
          map.off('mouseleave', id, onMouseLeave)
        }
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
  }, [map, config, layerIds, styleGen, shapeAnchoredMode])

  return null
}
