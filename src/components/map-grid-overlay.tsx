import {
  buildGrid,
  buildGridFromLine,
  rotatedBboxCorners,
  rotatePointAroundPivot,
  type GridCell,
  type GridCellProps,
  type GridConfig,
} from '@/lib/grid-generators'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import {
  buildOccluders,
  computeOccludedIds,
  type GridOccluderInput,
  type OccludableTarget,
} from '@/lib/marker-occlusion'
import type {
  CircleShape,
  ImageShape,
  LineShape,
  PolygonShape,
  StairShape,
} from '@/lib/shapes'
import type { FeatureCollection, Polygon } from 'geojson'
import type {
  GeoJSONSource,
  Map as MapboxMapInstance,
  MapLayerMouseEvent,
  MapMouseEvent,
} from 'mapbox-gl'
import { useEffect, useMemo, useRef, useState } from 'react'

const FILL_SOURCE = 'grid-fill-source'
const FILL_LAYER = 'grid-fill-layer'
const LINE_SOURCE = 'grid-line-source'
const LINE_LAYER = 'grid-line-layer'
// In-flight sources — hold ONLY the grid currently being moved / rotated
// / scaled. Filter out the transforming id from FILL / EXTRUDE-op* /
// LINE / LINE_BOTTOM / LABEL layers while the drag is live, and push
// the fresh cell tessellation into the in-flight sources from the drag
// handler's RAF. Same pattern as the polygon / circle / door / image
// overlays. The extrude in-flight layer carries a constant
// fill-extrusion-opacity — the in-flight population effect rewrites it
// via setPaintProperty on transform start.
const FILL_INFLIGHT_SOURCE = 'grid-fill-inflight-source'
const FILL_INFLIGHT_LAYER = 'grid-fill-inflight-layer'
const EXTRUDE_INFLIGHT_LAYER = 'grid-extrude-inflight-layer'
const LINE_INFLIGHT_SOURCE = 'grid-line-inflight-source'
const LINE_INFLIGHT_LAYER = 'grid-line-inflight-layer'
const LINE_BOTTOM_INFLIGHT_LAYER = 'grid-line-bottom-inflight-layer'
const LABEL_INFLIGHT_SOURCE = 'grid-label-inflight-source'
const LABEL_INFLIGHT_LAYER = 'grid-label-inflight-layer'
const SELECTION_INFLIGHT_LAYER = 'grid-selection-inflight-layer'
const SELECTION_TINT_INFLIGHT_LAYER = 'grid-selection-tint-inflight-layer'
/**
 * Bottom-edge border for 3D-extruded cells. Renders the same cell
 * rings as `LINE_LAYER` but at `line-z-offset = elevation` (the
 * extrusion base) instead of the rooftop, so each rack cell has a
 * visible horizontal frame at both its top AND bottom when viewed
 * from the side. Combined with the per-cell inset in
 * `grid-generators`, this is what makes the rack read as a stack
 * of distinct boxes from any camera angle — without it, the
 * side wall is just a single colored block with a thin line at
 * the very top.
 *
 * Flat cells (`elevation == 0 && height == 0`) are filtered out
 * because their bottom edge sits on the ground at the exact same
 * altitude as the `LINE_LAYER` — drawing twice would just z-fight.
 */
const LINE_BOTTOM_LAYER = 'grid-line-bottom-layer'
const EXTRUDE_SOURCE = 'grid-extrude-source'

// `fill-extrusion-opacity` rejects ALL data expressions (including
// feature-state) in Mapbox GL JS 3.x. To still get per-grid opacity in
// 3D we pre-create one fill-extrusion layer per discrete opacity bucket
// (every 10%), each carrying its own constant `fill-extrusion-opacity`.
// The generator stamps `properties.opacityBucket` on every cell and
// each layer's filter routes the cell into the matching bucket.
const OPACITY_BUCKETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
const EXTRUDE_LAYER_BASE = 'grid-extrude-layer'
const EXTRUDE_LAYER_IDS = OPACITY_BUCKETS.map((b) => `${EXTRUDE_LAYER_BASE}-op${b}`)
const extrudeLayerId = (bucket: number) => `${EXTRUDE_LAYER_BASE}-op${bucket}`
const LABEL_SOURCE = 'grid-label-source'
const LABEL_LAYER = 'grid-label-layer'
const CLIP_SOURCE = 'grid-clip-source'
const CLIP_LAYER = 'grid-clip-layer'

/** A committed (saved) grid line, rendered persistently on the map. */
export interface CommittedLine {
  id: number
  start: [number, number]
  current: [number, number]
  config: GridConfig
  /** v14. Row-level layer visibility — false hides the grid + its bins. */
  visible?: boolean
}

interface MapGridOverlayProps {
  map: MapboxMapInstance | null
  /** A fixed bounding box (lng, lat, lng, lat) — renders a committed grid. */
  bbox: [number, number, number, number] | null
  /**
   * A live draw line: start point + current cursor. When set, renders the
   * in-progress grid with one cell flagged as `future` for the leading edge.
   */
  line: { start: [number, number]; current: [number, number] } | null
  /**
   * Committed (already-saved) grids, each rendered as a persistent 1D row
   * along the X-axis defined by its own config.rotation.
   */
  committedLines?: CommittedLine[]
  config: GridConfig
  /** When true, also render the bbox outline + center marker. */
  showBbox?: boolean
  /**
   * IDs of committed grids to highlight as selected. Cells of these grids
   * are rendered into a separate thicker-line layer on top of everything.
   * Multiple IDs are supported for multi-grid selection.
   */
  selectedGridIds?: ReadonlySet<number>
  /**
   * Fired when the user clicks a cell belonging to a committed grid.
   * - `gridId` identifies the parent grid (Dexie primary key).
   * - `row` / `col` are the cell's 0-based coordinates inside the grid.
   * - `level` is the vertical rack level (0 for single-level grids).
   * - `originalEvent` is the Mapbox `originalEvent` (so the caller can
   *   detect shift-click for multi-select).
   */
  onCellClick?: (
    gridId: number,
    row: number,
    col: number,
    level: number,
    originalEvent: MouseEvent,
  ) => void
  /**
   * Fired when the user clicks empty space (no cell was hit). Useful for
   * clearing the current selection.
   */
  onMapClickEmpty?: () => void
  /**
   * Master visibility toggle for every committed-grid layer (fill, line,
   * label, selection). When `false`, the layers are hidden via
   * `setLayoutProperty('visibility', 'none')`. The live-draw and bbox
   * layers are not affected — those are always visible while drawing.
   */
  committedVisible?: boolean
  /**
   * When false, clicks on grids pass through to the map (no selection
   * callback, no "empty click" deselect). Set to false during create-*
   * tool modes so the user can drop a new shape on top of an existing
   * grid without first deselecting it.
   */
  selectionEnabled?: boolean
  /**
   * When set, the overlay renders interactive move/rotate handles for
   * the given grid. While the user drags, `onTransformChange` is called
   * on every pointer move; on mouse up, `onTransformChange(_, _, _, true)`
   * signals commit (persist the new geometry).
   */
  transformState?: { gridId: number; kind: 'move' | 'rotate' | 'scale'; draft: { start: [number, number]; current: [number, number]; rotation: number } } | null
  onTransformChange?: (start: [number, number], current: [number, number], rotation: number, commit: boolean) => void
  /**
   * Unsaved config override the sidebar is dragging. Grids with an id in
   * `gridIds` are re-tessellated with `config` instead of their stored
   * one — that's how the slider/color-picker hot path drives the live
   * preview without thrashing IndexedDB.
   */
  draftOverride?: { gridIds: ReadonlySet<number>; config: GridConfig } | null
  /**
   * Per-cell style overrides produced by the style-rules engine. Keys
   * are `"<gridId>-<row>-<col>-<level>"`; values carry hex colours,
   * opacities, etc. that should replace the parent grid's defaults.
   * Empty / undefined → no rules in effect.
   */
  cellStyleOverrides?: ReadonlyMap<string, { style: CellStyleOverride }> | null
  /**
   * Geometry the rack cell labels can hide behind. Same shape the
   * marker + text-label overlays accept. Feeds the analytic occlusion
   * pass — flips `feature-state.occluded` per label on every camera
   * move so labels standing behind floor plates or walls fade out
   * instead of poking through. Omit for pre-occlusion behaviour.
   */
  occluders?: {
    images?: ReadonlyArray<ImageShape>
    polygons?: ReadonlyArray<PolygonShape>
    circles?: ReadonlyArray<CircleShape>
    lines?: ReadonlyArray<LineShape>
    stairs?: ReadonlyArray<StairShape>
    grids?: ReadonlyArray<GridOccluderInput>
  }
  /** Master switch — matches sibling overlays' flag. */
  occlusionEnabled?: boolean
}

/** Per-cell paint overrides the resolver can produce. */
export interface CellStyleOverride {
  fillColor?: string
  fillOpacity?: number
  borderColor?: string
  borderWidth?: number
  elevation?: number
  height?: number
  labelColor?: string
  labelText?: string
}

const FUTURE_FILL_OPACITY = 0.35
const FUTURE_BORDER_WIDTH_BOOST = 1

/**
 * Return a copy of the cell with rule-driven paint properties merged
 * into `properties`. The base Mapbox paint expressions already read
 * via `['get', 'color']` / `['get', 'opacity']` / etc., so dropping
 * the override into the property bag is enough — no layer config
 * change required.
 */
function applyCellStyleOverride(
  cell: GridCell,
  style: CellStyleOverride,
): GridCell {
  if (
    style.fillColor === undefined &&
    style.fillOpacity === undefined &&
    style.borderColor === undefined &&
    style.borderWidth === undefined &&
    style.elevation === undefined &&
    style.height === undefined &&
    style.labelColor === undefined &&
    style.labelText === undefined
  ) {
    return cell
  }
  // Spread into a new object so the cache copy stays untouched.
  const next: GridCell = {
    ...cell,
    properties: { ...cell.properties },
  }
  const p = next.properties as GridCellProps & {
    color?: string
    opacity?: number
    borderColor?: string
    borderWidth?: number
    labelColor?: string
    labelText?: string
    elevation?: number
    height?: number
    opacityBucket?: number
  }
  if (style.fillColor !== undefined) p.color = style.fillColor
  if (style.fillOpacity !== undefined) {
    p.opacity = style.fillOpacity
    // The extrude layer routes by `opacityBucket` (0..100 in tens), so
    // an opacity override has to land in the same bucket the layer
    // filter expects, otherwise the cell silently disappears off the
    // 3D layer.
    p.opacityBucket = Math.round(Math.max(0, Math.min(100, style.fillOpacity)) / 10) * 10
  }
  if (style.borderColor !== undefined) p.borderColor = style.borderColor
  if (style.borderWidth !== undefined) p.borderWidth = style.borderWidth
  if (style.elevation !== undefined) p.elevation = style.elevation
  if (style.height !== undefined) p.height = style.height
  if (style.labelColor !== undefined) p.labelColor = style.labelColor
  if (style.labelText !== undefined) p.labelText = style.labelText
  return next
}
// Live-preview "halo" color. White was invisible on light map styles
// (the user's map was a beige streets style, so the preview cells
// blended into the background). We use a light grey that's visible on
// both light and dark backgrounds while still being subtle.
const FUTURE_HALO_COLOR = '#94a3b8'

export function MapGridOverlay({
  map,
  bbox,
  line,
  committedLines,
  config,
  showBbox = true,
  selectedGridIds,
  onCellClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
  transformState = null,
  onTransformChange,
  draftOverride = null,
  cellStyleOverrides = null,
  occluders,
  occlusionEnabled = true,
}: MapGridOverlayProps) {
  /**
   * Cache for `buildGridFromLine` results keyed by gridId. We replay the
   * cells we built last frame whenever the inputs that fed them haven't
   * changed — most of the time the user is editing one grid, so the rest
   * of the workspace can short-circuit the (possibly large) tessellation.
   * Refs survive renders without invalidating the memo.
   */
  const cellsCacheRef = useRef<
    Map<
      number,
      {
        config: GridConfig
        start: [number, number]
        current: [number, number]
        cells: GridCell[]
      }
    >
  >(new Map())
  const bboxSourceId = 'grid-bbox-source'
  const bboxLayerId = 'grid-bbox-layer'
  const centerSourceId = 'grid-center-source'
  const centerLayerId = 'grid-center-layer'
  const selectionSourceId = 'grid-selection-source'
  const selectionLineLayerId = 'grid-selection-line-layer'
  const selectionTintLayerId = 'grid-selection-tint-layer'
  // Transform handles: a circle marker rendered above the selected grid
  // when a move/rotate transform is active. The user can drag the marker
  // to update the grid's geometry in real time. We use a single source
  // (updated via setData) and a single circle layer to keep this simple.
  const transformSourceId = 'grid-transform-source'
  const transformLayerId = 'grid-transform-layer'

  // Combined cells: live preview (with "future" flag) + committed grids.
  // `committedLines` is memoized at the call site so it has a stable reference.
  const data = useMemo<FeatureCollection<Polygon> | null>(() => {
    if (!config.visible && (!committedLines || committedLines.length === 0)) return null
    const allFeatures: GridCell[] = []
    if (line && config.visible) {
      const { start, current } = line
      try {
        const result = buildGridFromLine(start, current, config)
        for (const c of result.cells) {
          // Tag preview cells so the fill/line/extrude layer filters keep
          // them (committed cells are kept by `has gridId`; preview cells
          // have no gridId yet, so they need a separate marker).
          c.properties.preview = true
          allFeatures.push(c)
        }
      } catch (err) {
        console.warn('[MapGridOverlay] live preview build failed', err)
      }
    }
    if (committedLines) {
      const liveIds = new Set<number>()
      for (const cl of committedLines) {
        liveIds.add(cl.id)
        // Row-level per-rack layer visibility (v14) — the sidebar's eye
        // toggle sets this. Missing/undefined stays visible so older rows
        // that predate the field render as before.
        if (cl.visible === false) continue
        // Treat missing/undefined `visible` as visible (back-compat with
        // older IndexedDB rows that predate the `visible` field).
        const baseConfig =
          draftOverride && draftOverride.gridIds.has(cl.id)
            ? draftOverride.config
            : cl.config
        if (baseConfig?.visible === false) continue
        // If this grid is the one being transformed, render it with the
        // live draft values (start/current from the drag, and rotation
        // from the drag) so the user sees the move/rotate in real time.
        // On commit, `transformState` is cleared and the committed
        // values pick up where the draft left off.
        const isLive =
          transformState && transformState.gridId === cl.id
        const tDraft = isLive ? transformState.draft : null
        const start = tDraft ? tDraft.start : cl.start
        const current = tDraft ? tDraft.current : cl.current
        const cfg = tDraft
          ? { ...baseConfig, rotation: tDraft.rotation }
          : baseConfig
        // Cache lookup: if the inputs are identical to what we built last
        // time for this grid, reuse the cells. This keeps the cost of a
        // draft slider linear in the *edited* grid's cells, not in the
        // whole workspace. Reading/writing the cache during render is
        // intentional — the cache is a pure performance optimization
        // (idempotent under StrictMode double-render), not state that
        // affects what the component returns.
        // eslint-disable-next-line react-hooks/refs
        const cached = cellsCacheRef.current.get(cl.id)
        let cellsForGrid: GridCell[] | null = null
        if (
          cached &&
          cached.config === cfg &&
          cached.start === start &&
          cached.current === current
        ) {
          cellsForGrid = cached.cells
        } else {
          try {
            const result = buildGridFromLine(start, current, cfg, {
              committed: true,
              gridId: cl.id,
            })
            // eslint-disable-next-line react-hooks/refs
            cellsCacheRef.current.set(cl.id, {
              config: cfg,
              start,
              current,
              cells: result.cells,
            })
            cellsForGrid = result.cells
          } catch (err) {
            // One bad grid must NOT take down the rest. Log and skip.
            console.warn('[MapGridOverlay] committed grid build failed', err, cl)
          }
        }
        if (cellsForGrid) {
          // Per-cell rule overrides — applied here (not in the cached
          // build) so a rule edit / bin change just re-stamps the
          // top-level paint properties without invalidating the
          // (potentially large) tessellation. When no overrides exist
          // for the grid we push the cached cells straight through.
          for (const c of cellsForGrid) {
            const override = cellStyleOverrides?.get(
              `${cl.id}-${c.properties.row}-${c.properties.col}-${c.properties.level ?? 0}`,
            )
            if (override) {
              allFeatures.push(applyCellStyleOverride(c, override.style))
            } else {
              allFeatures.push(c)
            }
          }
        }
      }
      // Evict cache entries for grids that are no longer in the workspace
      // (deleted or filtered out). Otherwise the cache grows unbounded
      // across the session.
      // eslint-disable-next-line react-hooks/refs
      for (const id of cellsCacheRef.current.keys()) {
        // eslint-disable-next-line react-hooks/refs
        if (!liveIds.has(id)) cellsCacheRef.current.delete(id)
      }
    }
    if (bbox && config.visible) {
      try {
        const fc = buildGrid(bbox, config)
        for (const c of fc.features as GridCell[]) allFeatures.push(c)
      } catch (err) {
        console.warn('[MapGridOverlay] bbox build failed', err)
      }
    }
    if (allFeatures.length === 0) return null
    if (import.meta.env.DEV) {
      // Helpful while debugging "cells don't show up" issues. Stripped in prod.
      console.debug(
        `[MapGridOverlay] pushing ${allFeatures.length} cells (committed=${committedLines?.length ?? 0}, line=${line ? 1 : 0}, bbox=${bbox ? 1 : 0})`
      )
    }
    return {
      type: 'FeatureCollection',
      features: allFeatures,
    }
  }, [bbox, line, config, committedLines, transformState, draftOverride, cellStyleOverrides])

  const lineData = useMemo<GeoJSON.FeatureCollection<GeoJSON.LineString> | null>(() => {
    if (!data) return null
    return {
      type: 'FeatureCollection',
      features: data.features.map((f) => ({
        type: 'Feature',
        properties: f.properties as GeoJSON.GeoJsonProperties,
        geometry: { type: 'LineString', coordinates: f.geometry.coordinates[0] },
      })),
    }
  }, [data])

  // Label positions as 2D Point features at the cell centroid.
  //
  // The LABEL_LAYER sets `symbol-z-elevate: true`, which makes Mapbox
  // automatically lift the symbol to the rooftop of any fill-extrusion
  // directly beneath it (= `elevation + height` in our case). We must
  // NOT also add `elevation + height` via `symbol-z-offset`, or the
  // label ends up at *twice* the altitude.
  //
  // `symbol-z-offset` is therefore only the per-cell *extra* lift the
  // user requested via `labelAltitude` (default 0 → label sits flush
  // on the rooftop).
  const labelPointData = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point> | null>(() => {
    if (!data) return null
    // Emit one label per cell feature — for a multi-level rack that
    // means N labels per footprint (one for each shelf). Each label's
    // altitude is computed from its own cell's `elevation` so the
    // label sits *on its own shelf* rather than all collapsing onto
    // the rack's rooftop. The label layer downstream sets
    // `text-allow-overlap: true` so Mapbox doesn't cull the stack as
    // a placement collision — without that, only one label per
    // (lng, lat) survives the symbol-placement pass and the rack
    // shows a single floating label instead of the per-shelf codes.
    //
    // v5.5 — filter at the SOURCE level, not just via the LABEL_LAYER
    // filter expression, so a `showLabels: false` toggle unambiguously
    // clears the label source. The layer filter alone left labels on
    // the map in some paths (the exact filter path wasn't
    // re-triggering after the cell cache short-circuited a rebuild);
    // dropping the feature from setData is the definitive fix.
    const features: GeoJSON.Feature<GeoJSON.Point>[] = []
    for (const f of data.features) {
      const props = (f.properties ?? {}) as GridCellProps
      // Default true when the property is missing so old rows keep
      // painting labels (same semantics as the layer's coalesce).
      const show = (props as { showLabels?: boolean }).showLabels
      if (show === false) continue
      const ring = f.geometry.coordinates[0] as [number, number][]
      let sx = 0
      let sy = 0
      const n = ring.length - 1
      for (let i = 0; i < n; i++) {
        sx += ring[i][0]
        sy += ring[i][1]
      }
      const cx = sx / n
      const cy = sy / n
      const cellElevation = props.elevation ?? 0
      const cellHeight = props.height ?? 0
      const userLift = props.labelAltitude ?? 0
      const totalLevels = props.totalLevels ?? 1
      // For multi-level pallet racks, each cell already sits at its
      // own shelf altitude (elevation = base + level*levelHeight),
      // and we lift the label to that shelf's rooftop. Adding
      // `labelAltitude` on top would push every shelf's label up by
      // the same amount — which the VerticalControls auto-lift used
      // to do, sending every label above the entire rack. Skip
      // `labelAltitude` entirely for multi-level so each label
      // lands cleanly on its shelf.
      //
      // For single-level grids (the legacy path) we preserve the
      // existing semantics: `labelAltitude` is an absolute extra
      // lift above the cell rooftop.
      const altitudeMeters =
        totalLevels > 1
          ? cellElevation + cellHeight
          : cellElevation + cellHeight + userLift
      // Synthesise a numeric label id from (gridId, row, col, level) so
      // the occlusion pass can address each label individually via
      // `setFeatureState` (Mapbox's `promoteId` needs one scalar key).
      // Safe up to ~90M grids × 1000 rows × 1000 cols × 100 levels.
      // Live-preview features have no gridId; skip the labelId — those
      // labels can never be occluders' targets since they don't persist.
      const gid = props.gridId
      const labelId =
        gid !== undefined
          ? gid * 100_000_000 + props.row * 100_000 + props.col * 100 + props.level
          : undefined
      features.push({
        type: 'Feature',
        properties: {
          ...f.properties,
          altitudeMeters,
          ...(labelId !== undefined ? { labelId } : {}),
        } as GeoJSON.GeoJsonProperties,
        geometry: {
          type: 'Point',
          coordinates: [cx, cy],
        },
      })
    }
    return { type: 'FeatureCollection', features }
  }, [data])

  // Clip data: one polygon per grid (live preview + committed). Used as a
  // Mapbox `clip` layer to erase 3D buildings, symbols, and other basemap
  // content within the grid area so the grid is the visual focus. Only
  // emits features when there is something visible to clip (i.e. grids
  // are present and not globally hidden). The Mapbox `clip` layer type
  // is a v3 feature that works with the Mapbox Standard Style; on styles
  // that don't support it, the layer is harmlessly ignored.
  const clipData = useMemo<GeoJSON.FeatureCollection<GeoJSON.Polygon> | null>(() => {
    if (!data) return null
    const features: GeoJSON.Feature<GeoJSON.Polygon>[] = []
    for (const f of data.features) {
      const ring = f.geometry.coordinates[0] as [number, number][]
      if (ring.length < 4) continue
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [data])

  const bboxLineData = useMemo<GeoJSON.FeatureCollection<GeoJSON.LineString> | null>(() => {
    if (!showBbox) return null
    // Derive bbox from `line` (live preview) if no explicit bbox is given.
    let b: [number, number, number, number] | null = bbox
    if (!b && line) {
      b = [
        Math.min(line.start[0], line.current[0]),
        Math.min(line.start[1], line.current[1]),
        Math.max(line.start[0], line.current[0]),
        Math.max(line.start[1], line.current[1]),
      ]
    }
    if (!b) return null
    // Rotate the 4 bbox corners by `config.rotation` so the outline matches
    // the (rotated) cell polygons. Cells rotate around the start point
    // (see grid-generators.ts `buildGrid`), so the outline must use the
    // same pivot. For the fixed-`bbox` path (no `line`), pass undefined
    // so `rotatedBboxCorners` falls back to the bbox center.
    const pivot: [number, number] | undefined = line?.start
    const rotated = rotatedBboxCorners(b, config.rotation, pivot)
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [...rotated, rotated[0]],
          },
        },
      ],
    }
  }, [bbox, line, showBbox, config.rotation])

  const centerData = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point> | null>(() => {
    const focus: [number, number] | null = line
      ? line.start
      : bbox
        ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
        : null
    if (!focus || !showBbox) return null
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: focus },
        },
      ],
    }
  }, [line, bbox, showBbox])

  // Outline cells for the currently selected grid(s). Drawn on top of the
  // regular line layer with a thick high-contrast stroke so the user can
  // see which grid is active.
  const selectionData = useMemo<GeoJSON.FeatureCollection<GeoJSON.LineString> | null>(() => {
    if (!data || !selectedGridIds || selectedGridIds.size === 0) return null
    const features: GeoJSON.Feature<GeoJSON.LineString>[] = []
    for (const cell of data.features) {
      const gridId = cell.properties?.gridId
      if (gridId === undefined) continue
      if (!selectedGridIds.has(gridId)) continue
      // Carry `elevation`/`height` through to the selection feature so
      // the layer's `line-z-offset` expression can read them. Without
      // these, the yellow outline always sits on the ground (z = 0.1)
      // even when the underlying grid is extruded.
      features.push({
        type: 'Feature',
        properties: {
          gridId,
          elevation: cell.properties?.elevation ?? 0,
          height: cell.properties?.height ?? 0,
        },
        geometry: { type: 'LineString', coordinates: cell.geometry.coordinates[0] },
      })
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [data, selectedGridIds])

  // Track style readiness as STATE (not a ref) so dependent effects re-run
  // when the style is ready. Otherwise setData never gets called if the
  // data effect runs before the style is ready.
  const [styleLoaded, setStyleLoaded] = useState(false)
  // styleGen increments on every style.load. Source/layer effect deps
  // include it so basemap swaps force a clean re-mount — Mapbox wipes
  // user-added layers on swap, and the boolean `styleLoaded` stays
  // true across the swap so without this counter the setup effect
  // never re-runs.
  const [styleGen, setStyleGen] = useState(0)

  useEffect(() => {
    if (!map) {
      // Reset on map teardown so a new map instance starts clean.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStyleLoaded(false)
      return
    }
    const setReady = () => {
      setStyleLoaded(true)
      setStyleGen((g) => g + 1)
    }
    if (map.isStyleLoaded()) {
      setReady()
      return
    }
    // The style may already be in the process of loading. The `load` and
    // `style.load` events have already fired on this map (or will not fire
    // again on this instance), so listening for them is unreliable here.
    // Poll every 100ms until `isStyleLoaded()` returns true.
    const interval = setInterval(() => {
      if (map.isStyleLoaded()) {
        setReady()
        clearInterval(interval)
      }
    }, 100)
    map.on('style.load', setReady)
    map.on('load', setReady)
    return () => {
      clearInterval(interval)
      map.off('style.load', setReady)
      map.off('load', setReady)
    }
    // Deps are `[map]` only. `styleLoaded` / `styleGen` are set INSIDE this
    // effect — including them in the deps causes an infinite re-render loop
    // (React's "Maximum update depth exceeded"). Downstream data effects
    // already depend on those values so they still react to style swaps.
  }, [map])

  // (Removed) Old URL-polling style-swap detector. The `style.load`
  // listener above now bumps `styleGen`, which is in every effect's
  // deps below — that handles swaps deterministically. The polling
  // fought the new mechanism by resetting `styleLoaded` after a swap
  // with no follow-up event to bring it back.

  // ---- Theme-tinted handle icons -----------------------------------------
  // Same pattern as image / polygon / line overlays. See
  // `@/lib/map-transform-handles` for the shared render + subscription
  // helpers. Registered here (before the layer setup effect) so
  // TRANSFORM_LAYER's icon-image references always resolve.
  const [primaryHex, setPrimaryHex] = useState<string>(() =>
    readThemePrimaryHex(),
  )
  const [primaryFgHex, setPrimaryFgHex] = useState<string>(() =>
    readThemePrimaryForegroundHex(),
  )
  useEffect(() => {
    const refresh = () => {
      setPrimaryHex(readThemePrimaryHex())
      setPrimaryFgHex(readThemePrimaryForegroundHex())
    }
    refresh()
    return subscribeThemeChanges(refresh)
  }, [])
  useEffect(() => {
    if (!map || !styleLoaded) return
    registerTransformHandleIcons(map, primaryHex, primaryFgHex)
  }, [map, styleLoaded, styleGen, primaryHex, primaryFgHex])

  // Cleanup handler for the if-style-already-loaded branch above. It
  // needs to live next to the `if (map.isStyleLoaded())` branch because
  // Add sources/layers once (on first map load + when style becomes ready).
  useEffect(() => {
    if (!map || !styleLoaded) return
    let cancelled = false

    const setup = () => {
      if (cancelled) return
      try {
        if (!map.getSource(FILL_SOURCE)) {
          map.addSource(FILL_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getSource(LINE_SOURCE)) {
          map.addSource(LINE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getSource(EXTRUDE_SOURCE)) {
          map.addSource(EXTRUDE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getSource(LABEL_SOURCE)) {
          map.addSource(LABEL_SOURCE, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            // Expose `properties.labelId` (packed from gridId/row/col/
            // level) as the feature-state key so the occlusion pass
            // can `setFeatureState({id, occluded})` per-cell without
            // regenerating the label FC on every camera move.
            promoteId: 'labelId',
          })
        }
        if (!map.getSource(bboxSourceId)) {
          map.addSource(bboxSourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getSource(centerSourceId)) {
          map.addSource(centerSourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getSource(selectionSourceId)) {
          map.addSource(selectionSourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getSource(CLIP_SOURCE)) {
          map.addSource(CLIP_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }

        if (!map.getLayer(FILL_LAYER)) {
          map.addLayer({
            id: FILL_LAYER,
            type: 'fill',
            source: FILL_SOURCE,
            // Filter keeps two kinds of features and excludes elevated cells:
            //   * Committed flat cells (`gridId` present, elevation+height==0).
            //   * Live-preview flat cells (`preview` present, elevation+height==0).
            // Elevated cells fall through to `EXTRUDE_LAYER`. Each cell now
            // carries its own `color`/`opacity`/`elevation`/`height` so a
            // mix of flat and 3D grids can coexist without a global toggle.
            // Referencing the property names in filter/paint also preserves
            // them on rendered features (Mapbox strips unreferenced
            // properties from `queryRenderedFeatures` results).
            filter: [
              'all',
              ['any', ['has', 'gridId'], ['has', 'preview']],
              [
                '<=',
                ['+', ['coalesce', ['get', 'elevation'], 0], ['coalesce', ['get', 'height'], 0]],
                0,
              ],
            ],
            paint: {
              'fill-color': [
                'case',
                ['==', ['get', 'future'], true], FUTURE_HALO_COLOR,
                ['coalesce', ['get', 'color'], '#6366f1'],
              ],
              'fill-opacity': [
                'case',
                ['==', ['get', 'future'], true], FUTURE_FILL_OPACITY,
                ['/', ['coalesce', ['get', 'opacity'], 50], 100],
              ],
            },
          })
        }
        // One fill-extrusion layer per opacity bucket, each with a
        // CONSTANT `fill-extrusion-opacity`. Added BEFORE LINE_LAYER so
        // the cell borders stay on top (Mapbox doesn't auto-promote
        // elevated lines above 3D geometry — without this order the
        // border vanishes behind extrusion tops at high opacity).
        for (const bucket of OPACITY_BUCKETS) {
          const layerId = extrudeLayerId(bucket)
          if (map.getLayer(layerId)) continue
          try {
            map.addLayer({
              id: layerId,
              type: 'fill-extrusion',
              source: EXTRUDE_SOURCE,
              filter: [
                'all',
                ['any', ['has', 'gridId'], ['has', 'preview']],
                [
                  '>',
                  ['+', ['coalesce', ['get', 'elevation'], 0], ['coalesce', ['get', 'height'], 0]],
                  0,
                ],
                // Route only cells whose bucket matches this layer's value.
                // The `coalesce` defaults preview cells (or any cell without
                // a stamped bucket) to 100 so they land in the full-opacity
                // layer and never silently disappear.
                ['==', ['coalesce', ['get', 'opacityBucket'], 100], bucket],
              ],
              paint: {
                // `fill-extrusion-color` IGNORES alpha — solid hex only.
                'fill-extrusion-color': [
                  'case',
                  ['==', ['get', 'future'], true], FUTURE_HALO_COLOR,
                  ['coalesce', ['get', 'color'], '#6366f1'],
                ],
                // CONSTANT per layer — the "data-driven opacity" comes from
                // the bucket routing in the filter above.
                'fill-extrusion-opacity': bucket / 100,
                'fill-extrusion-base': ['get', 'elevation'],
                // Floor the top at `elevation + 5 cm` — same rationale
                // as in `map-polygon-overlay.tsx`. Zero-thickness cells
                // (elevation > 0, height = 0 — e.g. a floor-2 shelf
                // sitting above a floor plan raster) render as a
                // degenerate slab that flickers under zoom + pitch and
                // can knock out the underlying raster. 5 cm is
                // invisible at warehouse scale.
                'fill-extrusion-height': [
                  '+',
                  ['get', 'elevation'],
                  ['max', ['get', 'height'], 0.05],
                ],
                'fill-extrusion-vertical-gradient': false,
              },
            })
          } catch (err) {
            console.warn('[MapGridOverlay] failed to add extrude bucket', bucket, err)
          }
        }
        if (!map.getLayer(LINE_LAYER)) {
          map.addLayer({
            id: LINE_LAYER,
            type: 'line',
            source: LINE_SOURCE,
            // Borders show for every cell in 2D and 3D (lifted to the cell
            // top via `line-z-offset`). Keep `gridId`/`preview` filter to
            // preserve those properties for the click handler.
            filter: ['any', ['has', 'gridId'], ['has', 'preview']],
            // Lift the cell border to the top of the 3D extrusion (or to
            // sea level when the cell is flat). `line-elevation-reference`
            // 'sea' tells Mapbox the offset is measured from sea level
            // (z=0); `line-z-offset` is the per-cell vertical offset in
            // meters, computed from the cell's `elevation` (base) and
            // `height` (top − base). With both set to 0, the line sits
            // on the ground (default 2D behaviour). When either is > 0,
            // the line floats on top of the fill-extrusion so the border
            // remains visible above the ground.
            // Requires Mapbox GL JS v3.5+ (line-z-offset) and v3.8+
            // (line-elevation-reference). Our project pins ^3.24.0.
            paint: {
              'line-color': [
                'case',
                ['==', ['get', 'future'], true], FUTURE_HALO_COLOR,
                ['coalesce', ['get', 'borderColor'], '#4338ca'],
              ],
              'line-width': [
                'case',
                ['==', ['get', 'future'], true],
                ['+', ['coalesce', ['get', 'borderWidth'], 1], FUTURE_BORDER_WIDTH_BOOST],
                ['coalesce', ['get', 'borderWidth'], 1],
              ],
              'line-dasharray': [
                'case',
                ['==', ['get', 'future'], true], [2, 1],
                [1],
              ],
              'line-opacity': 0.9,
              // Under the v3 lighting model, line color is multiplied by
              // ambient light. A border sitting on top of a 3D extrusion
              // ends up shaded almost to black. emissive-strength 1.0
              // makes the line render at its source color regardless of
              // lighting — required for a visible border on a 3D top.
              'line-emissive-strength': 1,
            },
            layout: {
              'line-elevation-reference': 'sea',
              // Lift the border to `elevation + height + 2 cm`. The
              // epsilon has to be large enough to win WebGL's depth
              // test against the extrusion top at long view distances
              // (a sub-mm offset gets quantized away by the depth
              // buffer and the border vanishes under the roof). 2 cm
              // is invisible at any practical zoom but reliably
              // separated. We deliberately do NOT set
              // `line-occlusion-opacity` here — the spec default of 0
              // gives proper depth occlusion, so a 3D model / truck /
              // building in front of the rack hides the borders it
              // occludes. Setting it to 1 produces an "x-ray" effect
              // where borders bleed through every occluder.
              'line-z-offset': [
                '+',
                ['coalesce', ['get', 'elevation'], 0],
                ['coalesce', ['get', 'height'], 0],
                0.02,
              ],
            },
          })
        }
        // Bottom-edge border for 3D-extruded cells — see the
        // `LINE_BOTTOM_LAYER` const docstring above for the
        // rationale. Same source and most paint as the rooftop
        // border, but the z-offset reads only `elevation` (no
        // height) so the line sits at the extrusion BASE. The
        // filter strips out fully-flat cells so we don't z-fight
        // with the top-edge layer on the ground plane.
        if (!map.getLayer(LINE_BOTTOM_LAYER)) {
          map.addLayer({
            id: LINE_BOTTOM_LAYER,
            type: 'line',
            source: LINE_SOURCE,
            filter: [
              'all',
              ['any', ['has', 'gridId'], ['has', 'preview']],
              [
                '>',
                ['+', ['coalesce', ['get', 'elevation'], 0], ['coalesce', ['get', 'height'], 0]],
                0,
              ],
            ],
            paint: {
              'line-color': [
                'case',
                ['==', ['get', 'future'], true], FUTURE_HALO_COLOR,
                ['coalesce', ['get', 'borderColor'], '#4338ca'],
              ],
              'line-width': [
                'case',
                ['==', ['get', 'future'], true],
                ['+', ['coalesce', ['get', 'borderWidth'], 1], FUTURE_BORDER_WIDTH_BOOST],
                ['coalesce', ['get', 'borderWidth'], 1],
              ],
              'line-opacity': 0.9,
              'line-emissive-strength': 1,
            },
            layout: {
              'line-elevation-reference': 'sea',
              // Sit the line just above the base (2 cm epsilon) so it
              // wins the depth test against the ground / floor.
              'line-z-offset': [
                '+',
                ['coalesce', ['get', 'elevation'], 0],
                0.02,
              ],
            },
          })
        }
        if (!map.getLayer(LABEL_LAYER)) {
          // Labels are point symbols at the cell centroid. Altitude lives
          // in `properties.altitudeMeters` (the Point's z component is
          // ignored by symbol layers). `symbol-z-elevate: true` enables
          // symbol elevation; `symbol-z-offset` then reads the per-cell
          // altitude. Together they lift the label to the top of each
          // extruded cell. Requires Mapbox GL JS v3.0+ (symbol-z-elevate)
          // and v3.7+ (symbol-z-offset).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const labelLayout: any = {
            'text-field': ['coalesce', ['get', 'label'], ['to-string', ['get', 'index']]],
            'text-size': ['coalesce', ['get', 'labelSize'], 11],
            // Multi-level racks place N labels at the same (lng, lat)
            // but at different altitudes (one per shelf). Mapbox's
            // default placement engine treats them as a 2D collision
            // and drops all but one. Allowing overlap + ignoring
            // placement keeps every per-level label visible. The
            // tradeoff is that adjacent footprints can show overlapping
            // text when zoomed out — acceptable since the rack-cell
            // labels are the primary user-facing affordance for binning.
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-padding': 2,
            'symbol-placement': 'point',
            'symbol-z-order': 'auto',
            // Symbol-z-elevate auto-lifts the label to the topmost
            // fill-extrusion roof directly beneath it. For multi-level
            // racks that means EVERY level's label gets snapped to the
            // rack-top — collapsing the per-shelf labels back into a
            // single floating label. We disable it and instead compute
            // each label's absolute altitude in the source feature
            // (`altitudeMeters` = cell elevation + cell height + the
            // user's labelAltitude offset). That lets every level keep
            // its own altitude. Single-level grids land at the same
            // final position as the old `symbol-z-elevate: true` path
            // — extrusion_top + labelAltitude — so legacy grids look
            // unchanged.
            'symbol-z-elevate': false,
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const labelPaint: any = {
            'text-color': [
              'case',
              ['==', ['get', 'future'], true], '#000000',
              ['coalesce', ['get', 'labelColor'], '#ffffff'],
            ],
            'text-halo-color': [
              'case',
              ['==', ['get', 'future'], true], FUTURE_HALO_COLOR,
              '#ffffff',
            ],
            'text-halo-width': 1.2,
            // Per-cell altitude in meters. Gated by `symbol-z-elevate: true`
            // above; without that gate, this is ignored.
            'symbol-z-offset': ['coalesce', ['get', 'altitudeMeters'], 0],
            // Symbol emissive strength so labels render at full color
            // brightness when sitting on top of a lit 3D extrusion under
            // the v3 lighting model.
            'text-emissive-strength': 1,
            // Fold analytic occlusion into text-opacity: labels with
            // `feature-state.occluded: true` fade to 0 while everything
            // else keeps full opacity. Mirrors map-text-label-overlay's
            // pattern so rack labels stop poking through floor plates
            // and adjacent walls at a tilt.
            'text-opacity': [
              'case',
              ['boolean', ['feature-state', 'occluded'], false],
              0,
              1,
            ],
            // Force x-ray (1) so the GL depth buffer doesn't second-
            // guess our analytic pass — same reasoning that made the
            // text-label overlay disable native occlusion in v5.4.
            'text-occlusion-opacity': 1,
          }
          map.addLayer({
            id: LABEL_LAYER,
            type: 'symbol',
            source: LABEL_SOURCE,
            // Per-cell visibility: render only if the cell's grid has
            // `showLabels` true. Default-true if missing (older DB rows).
            filter: ['!=', ['coalesce', ['get', 'showLabels'], true], false],
            layout: labelLayout,
            paint: labelPaint,
          })
        }
        if (!map.getLayer(bboxLayerId)) {
          map.addLayer({
            id: bboxLayerId,
            type: 'line',
            source: bboxSourceId,
            paint: {
              'line-color': '#ffffff',
              'line-width': 1.5,
              'line-dasharray': [3, 2],
              'line-opacity': 0.8,
            },
          })
        }
        if (!map.getLayer(centerLayerId)) {
          map.addLayer({
            id: centerLayerId,
            type: 'circle',
            source: centerSourceId,
            paint: {
              'circle-radius': 5,
              'circle-color': '#ffffff',
              'circle-stroke-color': '#1f2937',
              'circle-stroke-width': 2,
            },
          })
        }
        if (!map.getLayer(selectionLineLayerId)) {
          map.addLayer({
            id: selectionLineLayerId,
            type: 'line',
            source: selectionSourceId,
            paint: {
              'line-color': '#facc15',
              'line-width': 3,
              'line-opacity': 0.95,
              // See `grid-line-layer` for why we skip
              // `line-occlusion-opacity` — the spec default of 0 lets
              // 3D models / other racks properly occlude this outline.
              'line-emissive-strength': 1,
            },
            // Mirror the `grid-line-layer` elevation setup so the selection
            // outline sits on top of the 3D extrusion in 3D mode (and on
            // the ground in 2D mode) — otherwise the yellow outline floats
            // under the cells when `elevation > 0` or `height > 0`. The
            // epsilon is 0.5 cm larger than the regular border so the
            // selection lands cleanly on top of it without z-fighting.
            layout: {
              visibility: 'visible',
              'line-elevation-reference': 'sea',
              'line-z-offset': [
                '+',
                ['coalesce', ['get', 'elevation'], 0],
                ['coalesce', ['get', 'height'], 0],
                0.025,
              ],
            },
          })
        }
        if (!map.getLayer(CLIP_LAYER)) {
          // The `clip` layer type erases 3D buildings, symbols, and other
          // basemap content inside the polygon(s) of its source. Requires
          // Mapbox GL JS v3 + a style that supports basemap clipping
          // (e.g. mapbox://styles/mapbox/standard). On other styles the
          // layer is silently ignored, so it's safe to always add.
          // See: https://docs.mapbox.com/mapbox-gl-js/example/clip-layer/
          try {

            map.addLayer({
              id: CLIP_LAYER,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              type: 'clip' as any,
              source: CLIP_SOURCE,
              layout: {
                // `clip-layer-types` only accepts 'symbol' and 'model'.
                // 3D buildings in the Mapbox Standard style are 'model'
                // layers, so this covers them. 'fill-extrusion' is NOT
                // a valid value (Mapbox throws a validation error if
                // you include it).
                'clip-layer-types': ['symbol', 'model'],
                'clip-layer-scope': ['basemap'],
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any)
          } catch (err) {
            // The style doesn't support the `clip` layer type — that's fine,
            // buildings will just remain visible.
            if (import.meta.env.DEV) console.debug('[MapGridOverlay] clip layer not supported by this style', err)
          }
        }
        // Transform handle layer — theme-tinted symbol layer with
        // canvas icons. See `@/lib/map-transform-handles`.
        //   - Move: single handle at bbox center (rotated around start)
        //   - Scale: 4 handles at rotated bbox corners
        //   - Rotate: 2 handles at SE + NE corners (start-pivot means
        //     the SW corner handle would be a no-op; SE + NE give
        //     good levers on the far side)
        // The transform push effect below emits features with
        // cornerIndex / iconId / imageRotation / elevation / height
        // stamped so the layer's expressions resolve.
        if (!map.getSource(transformSourceId)) {
          map.addSource(transformSourceId, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })
        }
        // HMR safety: force-remove the OLD circle-typed layer if it
        // survived a hot reload. Without this, the guarded
        // `if (!getLayer)` below skips re-add and users keep seeing
        // the pre-refresh orange circle handle.
        const existingTransform = map.getStyle()?.layers?.find(
          (l) => l.id === transformLayerId,
        ) as { type?: string } | undefined
        if (existingTransform && existingTransform.type !== 'symbol') {
          try { map.removeLayer(transformLayerId) } catch { /* ignore */ }
        }
        // Defunct: the old TRANSFORM_ICON_LAYER (a small inner circle
        // for the rotate handle). Force-remove any stale copy.
        try {
          if (map.getLayer('grid-transform-icon-layer')) {
            map.removeLayer('grid-transform-icon-layer')
          }
        } catch { /* ignore */ }
        if (!map.getLayer(transformLayerId)) {
          const transformLayerDef = {
            id: transformLayerId,
            type: 'symbol',
            source: transformSourceId,
            layout: {
              'icon-image': [
                'coalesce',
                ['get', 'iconId'],
                TRANSFORM_ICON.move,
              ],
              'icon-size': 1,
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
              // Per-kind icon orientation. Grid corner index
              // convention (from `rotatedBboxCorners`): 0=SW, 1=SE,
              // 2=NE, 3=NW.
              //
              // Scale: 2 handles at SW (idx 0) + NE (idx 2). Both
              // sit on the NE-SW diagonal so both icons rotate 90°
              // (drawing `/` from the default `\`). Plus the grid's
              // own rotation from `imageRotation` so the arrow
              // visually tracks the rack's actual orientation.
              //
              // Rotate: 2 handles at SE (idx 1) + NE (idx 2). Curl
              // 90° for SE (curl in SE quadrant), 0° for NE (default
              // NE curl). Plus the grid's own rotation.
              'icon-rotate': [
                '+',
                [
                  'match',
                  ['get', 'kind'],
                  'move', 0,
                  'scale',
                  [
                    'match',
                    ['get', 'cornerIndex'],
                    0, 90,
                    2, 90,
                    0,
                  ],
                  'rotate',
                  [
                    'match',
                    ['get', 'cornerIndex'],
                    1, 90,
                    2, 0,
                    0,
                  ],
                  0,
                ],
                // Move icon stays screen-space (4-way cross would
                // read as a diamond if tilted); the grid rotation
                // still applies to scale + rotate arrows so they
                // track the visual orientation of the rack.
                [
                  'match',
                  ['get', 'kind'],
                  'move', 0,
                  ['coalesce', ['to-number', ['get', 'imageRotation']], 0],
                ],
              ],
              // z-elevate FALSE — see polygon overlay comment. With
              // z-elevate:true Mapbox stacks z-offset ON TOP of the
              // extrusion top, giving 2 × (elevation+height).
              'symbol-z-elevate': false,
              'symbol-elevation-reference': 'sea',
            },
            paint: {
              'icon-emissive-strength': 1,
              'symbol-z-offset': [
                '+',
                ['coalesce', ['to-number', ['get', 'elevation']], 0],
                ['coalesce', ['to-number', ['get', 'height']], 0],
              ],
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any
          map.addLayer(transformLayerDef)
        }
        // Whole-grid selection tint — theme-primary fill-extrusion
        // over every cell of the selected grid(s). Filter driven by
        // a dedicated effect (see below) matches `gridId` against
        // `selectedGridIds`. Same paper-thin slab trick from AGENTS.md
        // so flat grids still render a visible wash.
        if (!map.getLayer(selectionTintLayerId)) {
          const tintLayerDef = {
            id: selectionTintLayerId,
            type: 'fill-extrusion',
            source: FILL_SOURCE,
            filter: ['==', ['get', 'gridId'], -1],
            paint: {
              'fill-extrusion-color': '#facc15', // theme effect overwrites
              'fill-extrusion-opacity': 0.18,
              'fill-extrusion-base': [
                'coalesce',
                ['to-number', ['get', 'elevation']],
                0,
              ],
              'fill-extrusion-height': [
                '+',
                ['coalesce', ['to-number', ['get', 'elevation']], 0],
                [
                  'max',
                  ['coalesce', ['to-number', ['get', 'height']], 0],
                  0.05,
                ],
              ],
              'fill-extrusion-vertical-gradient': false,
              'fill-extrusion-emissive-strength': 1,
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any
          map.addLayer(tintLayerDef)
        }

        // ---- In-flight sources + layers (transforming grid) ------------
        // Same paint recipes as FILL / EXTRUDE / LINE / LINE_BOTTOM /
        // LABEL / SELECTION so the moving grid renders identically.
        // Single-grid sources → per-frame updates only tessellate that
        // one grid via `buildGridFromLine`, not all N committed grids.
        if (!map.getSource(FILL_INFLIGHT_SOURCE)) {
          map.addSource(FILL_INFLIGHT_SOURCE, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })
        }
        if (!map.getSource(LINE_INFLIGHT_SOURCE)) {
          map.addSource(LINE_INFLIGHT_SOURCE, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })
        }
        if (!map.getSource(LABEL_INFLIGHT_SOURCE)) {
          map.addSource(LABEL_INFLIGHT_SOURCE, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })
        }
        if (!map.getLayer(FILL_INFLIGHT_LAYER)) {
          map.addLayer({
            id: FILL_INFLIGHT_LAYER,
            type: 'fill',
            source: FILL_INFLIGHT_SOURCE,
            filter: [
              '<=',
              ['+', ['coalesce', ['get', 'elevation'], 0], ['coalesce', ['get', 'height'], 0]],
              0,
            ],
            paint: {
              'fill-color': [
                'case',
                ['==', ['get', 'future'], true], FUTURE_HALO_COLOR,
                ['coalesce', ['get', 'color'], '#6366f1'],
              ],
              'fill-opacity': [
                'case',
                ['==', ['get', 'future'], true], FUTURE_FILL_OPACITY,
                ['/', ['coalesce', ['get', 'opacity'], 50], 100],
              ],
            },
          })
        }
        if (!map.getLayer(EXTRUDE_INFLIGHT_LAYER)) {
          map.addLayer({
            id: EXTRUDE_INFLIGHT_LAYER,
            type: 'fill-extrusion',
            source: FILL_INFLIGHT_SOURCE,
            filter: [
              '>',
              ['+', ['coalesce', ['get', 'elevation'], 0], ['coalesce', ['get', 'height'], 0]],
              0,
            ],
            paint: {
              'fill-extrusion-color': [
                'case',
                ['==', ['get', 'future'], true], FUTURE_HALO_COLOR,
                ['coalesce', ['get', 'color'], '#6366f1'],
              ],
              // Constant opacity — the in-flight population effect
              // rewrites this via setPaintProperty from the moving
              // grid's config on transform start.
              'fill-extrusion-opacity': 1,
              'fill-extrusion-base': ['to-number', ['get', 'elevation']],
              'fill-extrusion-height': [
                '+',
                ['to-number', ['get', 'elevation']],
                ['max', ['to-number', ['get', 'height']], 0.05],
              ],
              'fill-extrusion-vertical-gradient': false,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-cast-shadows' as any]: true,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-ambient-occlusion-intensity' as any]: 0.35,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-ambient-occlusion-radius' as any]: 2.5,
            },
          })
        }
        if (!map.getLayer(LINE_INFLIGHT_LAYER)) {
          map.addLayer({
            id: LINE_INFLIGHT_LAYER,
            type: 'line',
            source: LINE_INFLIGHT_SOURCE,
            paint: {
              'line-color': ['coalesce', ['get', 'borderColor'], '#1f2937'],
              'line-width': ['coalesce', ['to-number', ['get', 'borderWidth']], 1],
              'line-emissive-strength': 1,
            },
            layout: {
              'line-elevation-reference': 'sea',
              'line-z-offset': [
                '+',
                ['coalesce', ['get', 'elevation'], 0],
                ['coalesce', ['get', 'height'], 0],
                0.0001,
              ],
            },
          })
        }
        if (!map.getLayer(LINE_BOTTOM_INFLIGHT_LAYER)) {
          map.addLayer({
            id: LINE_BOTTOM_INFLIGHT_LAYER,
            type: 'line',
            source: LINE_INFLIGHT_SOURCE,
            filter: [
              '>',
              ['+', ['coalesce', ['get', 'elevation'], 0], ['coalesce', ['get', 'height'], 0]],
              0,
            ],
            paint: {
              'line-color': ['coalesce', ['get', 'borderColor'], '#1f2937'],
              'line-width': ['coalesce', ['to-number', ['get', 'borderWidth']], 1],
              'line-emissive-strength': 1,
            },
            layout: {
              'line-elevation-reference': 'sea',
              'line-z-offset': ['coalesce', ['get', 'elevation'], 0],
            },
          })
        }
        if (!map.getLayer(LABEL_INFLIGHT_LAYER)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const layout: any = {
            'text-field': ['coalesce', ['get', 'label'], ''],
            'text-size': ['coalesce', ['get', 'labelSize'], 12],
            'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'symbol-z-elevate': true,
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const paint: any = {
            'text-color': ['coalesce', ['get', 'labelColor'], '#ffffff'],
            'text-halo-color': '#000000',
            'text-halo-width': 1.2,
            'text-emissive-strength': 1,
          }
          map.addLayer({
            id: LABEL_INFLIGHT_LAYER,
            type: 'symbol',
            source: LABEL_INFLIGHT_SOURCE,
            layout,
            paint,
          })
        }
        // Selection tint + halo mirrors on the in-flight source. No
        // filters — the source only holds the transforming grid's cells,
        // and the drag handler only pushes cells when the grid is in
        // active transform.
        if (!map.getLayer(SELECTION_TINT_INFLIGHT_LAYER)) {
          const tintInflightDef = {
            id: SELECTION_TINT_INFLIGHT_LAYER,
            type: 'fill-extrusion',
            source: FILL_INFLIGHT_SOURCE,
            paint: {
              'fill-extrusion-color': '#facc15',
              'fill-extrusion-opacity': 0.18,
              'fill-extrusion-base': [
                'coalesce',
                ['to-number', ['get', 'elevation']],
                0,
              ],
              'fill-extrusion-height': [
                '+',
                ['coalesce', ['to-number', ['get', 'elevation']], 0],
                [
                  'max',
                  ['coalesce', ['to-number', ['get', 'height']], 0],
                  0.05,
                ],
              ],
              'fill-extrusion-vertical-gradient': false,
              'fill-extrusion-emissive-strength': 1,
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any
          map.addLayer(tintInflightDef)
        }
        if (!map.getLayer(SELECTION_INFLIGHT_LAYER)) {
          map.addLayer({
            id: SELECTION_INFLIGHT_LAYER,
            type: 'line',
            source: LINE_INFLIGHT_SOURCE,
            paint: {
              'line-color': '#fde047',
              'line-width': 3,
              'line-blur': 0.5,
              'line-emissive-strength': 1,
            },
            layout: {
              'line-elevation-reference': 'sea',
              'line-z-offset': [
                '+',
                ['coalesce', ['get', 'elevation'], 0],
                ['coalesce', ['get', 'height'], 0],
                0.0002,
              ],
            },
          })
        }
      } catch (err) {
        console.error('[MapGridOverlay] setup() threw:', err)
      }
    }

    setup()

    // Re-run setup on every `style.load` event. When the user switches
    // styles (e.g. streets -> standard), Mapbox tears down all custom
    // sources/layers. The `style.load` event fires when the new style
    // is fully loaded, which is the right time to re-add them. We also
    // listen for `styledata` with `dataType === 'style'` to catch
    // style reloads triggered by `setConfigProperty` on the Mapbox
    // Standard Style.
    const onStyleLoad = () => {
      // Small delay to ensure the style is fully ready before adding
      // layers. Without it, `addLayer` can silently fail.
      setTimeout(() => {
        if (!cancelled) setup()
      }, 50)
    }
    map.on('style.load', onStyleLoad)

    return () => {
      cancelled = true
      map.off('style.load', onStyleLoad)
      // After `map.remove()` runs (e.g. on unmount or route change), the
      // map's internal `style` is undefined, so `getLayer`/`getSource`
      // crash with "Cannot read properties of undefined (reading
      // 'getOwnLayer')". Bail out early in that case.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(map as any).style) return
      const safeRemove = (id: string) => {
        try { if (map.getLayer(id)) map.removeLayer(id) } catch { /* style torn down */ }
      }
      const safeRemoveSource = (id: string) => {
        try { if (map.getSource(id)) map.removeSource(id) } catch { /* style torn down */ }
      }
      safeRemove(selectionLineLayerId)
      safeRemove(selectionTintLayerId)
      safeRemove(LABEL_INFLIGHT_LAYER)
      safeRemove(SELECTION_INFLIGHT_LAYER)
      safeRemove(SELECTION_TINT_INFLIGHT_LAYER)
      safeRemove(LINE_BOTTOM_INFLIGHT_LAYER)
      safeRemove(LINE_INFLIGHT_LAYER)
      safeRemove(EXTRUDE_INFLIGHT_LAYER)
      safeRemove(FILL_INFLIGHT_LAYER)
      safeRemove(LABEL_LAYER)
      for (const id of EXTRUDE_LAYER_IDS) safeRemove(id)
      safeRemove(LINE_BOTTOM_LAYER)
      safeRemove(LINE_LAYER)
      safeRemove(FILL_LAYER)
      safeRemove(bboxLayerId)
      safeRemove(centerLayerId)
      safeRemove(CLIP_LAYER)
      safeRemove(transformLayerId)
      safeRemove('grid-transform-icon-layer')
      safeRemoveSource(selectionSourceId)
      safeRemoveSource(LABEL_INFLIGHT_SOURCE)
      safeRemoveSource(LINE_INFLIGHT_SOURCE)
      safeRemoveSource(FILL_INFLIGHT_SOURCE)
      safeRemoveSource(LABEL_SOURCE)
      safeRemoveSource(EXTRUDE_SOURCE)
      safeRemoveSource(LINE_SOURCE)
      safeRemoveSource(FILL_SOURCE)
      safeRemoveSource(bboxSourceId)
      safeRemoveSource(centerSourceId)
      safeRemoveSource(CLIP_SOURCE)
      safeRemoveSource(transformSourceId)
    }
    // styleGen forces a fresh setup pass on every basemap swap, since
    // Mapbox tears down user-added sources/layers but `styleLoaded`
    // stays true and would otherwise short-circuit this effect.
  }, [map, styleLoaded, styleGen])

  // Push data into the fill/line/extrude/label sources when the grid changes.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const fillSrc = map.getSource(FILL_SOURCE) as GeoJSONSource | undefined
    const lineSrc = map.getSource(LINE_SOURCE) as GeoJSONSource | undefined
    const extrudeSrc = map.getSource(EXTRUDE_SOURCE) as GeoJSONSource | undefined
    const labelSrc = map.getSource(LABEL_SOURCE) as GeoJSONSource | undefined
    if (import.meta.env.DEV) {
      // Helpful while debugging "cells don't show up" issues. Stripped in prod.
      // (Intentionally minimal — too verbose logs make the console unreadable.)
    }
    if (fillSrc) fillSrc.setData(data ?? { type: 'FeatureCollection', features: [] })
    if (lineSrc) lineSrc.setData(lineData ?? { type: 'FeatureCollection', features: [] })
    if (extrudeSrc) extrudeSrc.setData(data ?? { type: 'FeatureCollection', features: [] })
    if (labelSrc) labelSrc.setData(labelPointData ?? { type: 'FeatureCollection', features: [] })
    const clipSrc = map.getSource(CLIP_SOURCE) as GeoJSONSource | undefined
    if (clipSrc) clipSrc.setData(clipData ?? { type: 'FeatureCollection', features: [] })
  }, [data, lineData, labelPointData, clipData, map, styleLoaded])

  // ---- Label occlusion (same solver as markers / text labels) ----------
  // Rack cell labels sit on the top of each cell's extrusion (or higher
  // via `labelAltitude`) and otherwise poke through floor plates and
  // adjacent walls at a tilt. Run the analytic solver on every `move`
  // and flip `feature-state.occluded` per label so the paint expression
  // fades the hidden ones to opacity 0. Targets are built directly from
  // `labelPointData` so the ids match what the layer stamped (the same
  // labelId lands in both places).
  const occludeImages = occluders?.images
  const occludePolygons = occluders?.polygons
  const occludeCircles = occluders?.circles
  const occludeLines = occluders?.lines
  const occludeStairs = occluders?.stairs
  const occludeGrids = occluders?.grids
  const prisms = useMemo(
    () =>
      occlusionEnabled
        ? buildOccluders({
            images: occludeImages,
            polygons: occludePolygons,
            circles: occludeCircles,
            lines: occludeLines,
            stairs: occludeStairs,
            grids: occludeGrids,
          })
        : [],
    [
      occlusionEnabled,
      occludeImages,
      occludePolygons,
      occludeCircles,
      occludeLines,
      occludeStairs,
      occludeGrids,
    ],
  )
  const occludedIdsRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (!map || !styleLoaded) return
    const targets: OccludableTarget[] = []
    if (committedVisible && labelPointData) {
      for (const f of labelPointData.features) {
        const props = (f.properties ?? {}) as {
          labelId?: number
          altitudeMeters?: number
          floorPlanId?: number
        }
        if (props.labelId === undefined) continue
        const coords = f.geometry.coordinates as [number, number]
        targets.push({
          id: props.labelId,
          position: coords,
          elevationM: props.altitudeMeters ?? 0,
          floorPlanId: props.floorPlanId,
        })
      }
    }
    const apply = () => {
      const nextOccluded = computeOccludedIds(map, targets, prisms)
      const prev = occludedIdsRef.current
      for (const id of prev) {
        if (nextOccluded.has(id)) continue
        try {
          map.setFeatureState(
            { source: LABEL_SOURCE, id },
            { occluded: false },
          )
        } catch { /* source went away */ }
      }
      for (const id of nextOccluded) {
        try {
          map.setFeatureState(
            { source: LABEL_SOURCE, id },
            { occluded: true },
          )
        } catch { /* source went away */ }
      }
      occludedIdsRef.current = nextOccluded
    }
    apply()
    map.on('move', apply)
    return () => {
      map.off('move', apply)
    }
  }, [map, styleLoaded, labelPointData, prisms, committedVisible])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const bboxSrc = map.getSource(bboxSourceId) as GeoJSONSource | undefined
    const centerSrc = map.getSource(centerSourceId) as GeoJSONSource | undefined
    if (bboxSrc) bboxSrc.setData(bboxLineData ?? { type: 'FeatureCollection', features: [] })
    if (centerSrc) centerSrc.setData(centerData ?? { type: 'FeatureCollection', features: [] })
  }, [bboxLineData, centerData, map, styleLoaded])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const selSrc = map.getSource(selectionSourceId) as GeoJSONSource | undefined
    if (selSrc) selSrc.setData(selectionData ?? { type: 'FeatureCollection', features: [] })
  }, [selectionData, map, styleLoaded])

  // Click + hover on grid cells. Cells belonging to a committed grid have
  // `properties.gridId`; live preview cells do not. Hover changes the
  // cursor to a pointer so the user knows the cells are clickable.
  // Skipped entirely when `selectionEnabled` is false (a create-* tool
  // is active) so create clicks pass through cleanly.
  useEffect(() => {
    if (!map || !styleLoaded || !selectionEnabled) return
    const canvas = map.getCanvas()
    // 3D model layers sit visually on top of grid cells, but Mapbox
    // dispatches layer-specific click handlers (grid) before map-level
    // ones (the model overlay), so without a yield check the grid would
    // claim every click on a model that happens to overlap a cell.
    // Resolve the dynamic `model-shapes-layer-*` ids from the live style
    // at click time — they come and go as the user adds/removes assets.
    const modelLayersAtPoint = (point: { x: number; y: number }): boolean => {
      const styleLayers = (map.getStyle()?.layers ?? []) as Array<{ id: string }>
      const modelLayers = styleLayers
        .filter((l) => l.id.startsWith('model-shapes-layer-'))
        .map((l) => l.id)
      if (modelLayers.length === 0) return false
      // Match the buffer the model overlay uses for its own hit test —
      // single-pixel `queryRenderedFeatures` misses model mesh edges.
      const HIT_BUFFER = 6
      const bbox: [[number, number], [number, number]] = [
        [point.x - HIT_BUFFER, point.y - HIT_BUFFER],
        [point.x + HIT_BUFFER, point.y + HIT_BUFFER],
      ]
      try {
        return map.queryRenderedFeatures(bbox, { layers: modelLayers }).length > 0
      } catch {
        return false
      }
    }
    const handleCellClick = (e: MapLayerMouseEvent) => {
      // Skip click handling during a transform drag (see handleMapClick).
      if (dragStateRef.current?.dragging) return
      // Bail if another overlay (polygon, circle, line, image, marker)
      // already consumed this click on its own shape. Without this,
      // clicking e.g. a polygon that visually overlaps a grid cell
      // would fire BOTH the polygon-selected handler AND open the
      // BinEditor for the cell underneath. The convention across the
      // other overlays is the same: call `preventDefault()` on the
      // shape-hit path, check `defaultPrevented` on the
      // grid-cell-hit path.
      if (e.originalEvent?.defaultPrevented) return
      // Model is visually on top — defer to it. The model overlay's own
      // (map-level) click handler runs next and will select the model
      // because we never call preventDefault.
      if (modelLayersAtPoint(e.point)) return
      const features = e.features ?? []
      if (features.length === 0) return
      // The click handler is registered on fill, line, and extrude
      // layers. Any of them can fire. We need to find a feature from
      // one of OUR grid layers (not the mapbox-draw plugin's layers)
      // and read its `gridId` property.
      // Cell features can come from any of: FILL_LAYER, LINE_LAYER, or
      // any of the per-bucket extrude layers. The prefix check covers
      // all bucket layer ids at once.
      const isGridLayer = (id: string | undefined) =>
        id === FILL_LAYER || id === LINE_LAYER || (id !== undefined && id.startsWith(EXTRUDE_LAYER_BASE))
      const cellFeat = features.find((f) => isGridLayer(f.layer?.id))
      if (!cellFeat) return
      const gridId = cellFeat.properties?.gridId
      if (typeof gridId !== 'number') return
      const row = cellFeat.properties?.row
      const col = cellFeat.properties?.col
      const level = cellFeat.properties?.level
      // Claim the click. Without this, every other overlay's map-click
      // handler will see `defaultPrevented === false`, query its OWN
      // layers, find zero hits, and call `onMapClickEmpty` — wiping the
      // selection we just set.
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      onCellClick?.(
        gridId,
        typeof row === 'number' ? row : -1,
        typeof col === 'number' ? col : -1,
        typeof level === 'number' ? level : 0,
        e.originalEvent,
      )
    }
    const handleMapClick = (e: MapMouseEvent) => {
      // Skip click handling if a transform drag is in progress. Mapbox
      // fires a `click` event at the end of a drag (mouseup), and that
      // click point may not hit the grid (which has been moved/rotated),
      // causing the selection to be cleared. Suppress it.
      if (dragStateRef.current?.dragging) return
      // Bail when a shape overlay consumed the click — otherwise
      // selecting a polygon / line / etc. would also fire the
      // "clicked empty" path and clear the grid selection that some
      // callers rely on.
      if (e.originalEvent?.defaultPrevented) return
      // Only treat it as "empty" if no features are hit at the click point.
      // `queryRenderedFeatures` needs a `[x, y]` tuple, not a plain object,
      // and throws on any layer id that isn't mounted — so filter first.
      const layers = [FILL_LAYER, LINE_LAYER, ...EXTRUDE_LAYER_IDS].filter((l) => map.getLayer(l))
      const hits = layers.length
        ? map.queryRenderedFeatures([e.point.x, e.point.y], { layers })
        : []
      if (hits.length === 0) {
        onMapClickEmpty?.()
      }
    }
    const handleEnter = () => { canvas.style.cursor = 'pointer' }
    const handleLeave = () => { canvas.style.cursor = '' }
    map.on('click', FILL_LAYER, handleCellClick)
    map.on('click', LINE_LAYER, handleCellClick)
    for (const id of EXTRUDE_LAYER_IDS) map.on('click', id, handleCellClick)
    // Global click handler as a fallback: the mapbox-draw plugin's
    // `simple_select` mode can consume layer-specific click events.
    // A global `map.on('click', ...)` fires for every click on the map,
    // regardless of whether the draw plugin processed it. We query
    // features at the click point and dispatch to onCellClick if we
    // hit a grid cell.
    const handleGlobalClick = (e: MapMouseEvent) => {
      // Skip click handling during a transform drag (see handleMapClick).
      if (dragStateRef.current?.dragging) return
      // Same gate as `handleCellClick` above: if a shape overlay
      // (polygon, circle, line, image, marker) consumed the click on
      // its own feature, do not also open the bin editor for any
      // grid cell that happens to underlap the click point.
      if (e.originalEvent?.defaultPrevented) return
      // Defer to the model overlay if a model is at this point — same
      // reason as the layer-specific handler above.
      if (modelLayersAtPoint(e.point)) return
      // `queryRenderedFeatures` accepts a `[x, y]` tuple or a `Point`
      // instance, but NOT a plain `{x, y}` object. Convert explicitly.
      // Unmounted layer ids throw, so filter before querying.
      const layers = [FILL_LAYER, LINE_LAYER, ...EXTRUDE_LAYER_IDS].filter((l) => map.getLayer(l))
      if (layers.length === 0) return
      const hits = map.queryRenderedFeatures([e.point.x, e.point.y], { layers })
      if (hits.length === 0) return
      const cellFeat = hits.find(
        (f) =>
          f.layer?.id === FILL_LAYER ||
          f.layer?.id === LINE_LAYER ||
          (f.layer?.id !== undefined && f.layer.id.startsWith(EXTRUDE_LAYER_BASE)),
      )
      if (!cellFeat) return
      const gridId = cellFeat.properties?.gridId
      if (typeof gridId !== 'number') return
      const row = cellFeat.properties?.row
      const col = cellFeat.properties?.col
      const level = cellFeat.properties?.level
      // Claim the click so other overlays' map-click handlers don't
      // treat it as an empty click and wipe the selection.
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      onCellClick?.(
        gridId,
        typeof row === 'number' ? row : -1,
        typeof col === 'number' ? col : -1,
        typeof level === 'number' ? level : 0,
        e.originalEvent,
      )
    }
    map.on('click', handleGlobalClick)
    map.on('mouseenter', FILL_LAYER, handleEnter)
    map.on('mouseenter', LINE_LAYER, handleEnter)
    map.on('mouseleave', FILL_LAYER, handleLeave)
    map.on('mouseleave', LINE_LAYER, handleLeave)
    for (const id of EXTRUDE_LAYER_IDS) {
      map.on('mouseenter', id, handleEnter)
      map.on('mouseleave', id, handleLeave)
    }
    map.on('click', handleMapClick)
    return () => {
      map.off('click', FILL_LAYER, handleCellClick)
      map.off('click', LINE_LAYER, handleCellClick)
      for (const id of EXTRUDE_LAYER_IDS) {
        map.off('click', id, handleCellClick)
        map.off('mouseenter', id, handleEnter)
        map.off('mouseleave', id, handleLeave)
      }
      map.off('click', handleGlobalClick)
      map.off('mouseenter', FILL_LAYER, handleEnter)
      map.off('mouseenter', LINE_LAYER, handleEnter)
      map.off('mouseleave', FILL_LAYER, handleLeave)
      map.off('mouseleave', LINE_LAYER, handleLeave)
      map.off('click', handleMapClick)
      canvas.style.cursor = ''
    }
  }, [map, styleLoaded, styleGen, selectionEnabled, onCellClick, onMapClickEmpty])

  // Paint/visibility used to be re-pushed here whenever the panel `config`
  // changed, which forced every grid on the map to share one color, one
  // border, and one 2D/3D mode (the currently active config). The paint
  // expressions are now data-driven via `['get', 'color']`/`['get',
  // 'borderColor']`/etc., and the 2D vs 3D split is per-feature via the
  // FILL_LAYER / EXTRUDE_LAYER filters on `elevation + height`. Cell
  // properties carry each grid's saved style (stamped by `makeCellProps`)
  // so the layers re-style automatically when the data source updates —
  // no global rebroadcast is needed. The live preview also flows through
  // this path: its cells are stamped with the active panel config so the
  // in-progress draw reflects the user's current settings.

  // Master visibility toggle for committed-grid layers. Used by the
  // toolbar's "Toggle Grid" button.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const vis = committedVisible ? 'visible' : 'none'
    for (const id of [FILL_LAYER, ...EXTRUDE_LAYER_IDS, LINE_LAYER, LINE_BOTTOM_LAYER, LABEL_LAYER, selectionTintLayerId, 'grid-selection-line-layer']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
    }
  }, [committedVisible, map, styleLoaded])

  // Transform handles: emit draggable feature(s) for the active
  // transform mode. All handles pivot around the same point the grid
  // renders around (`start`) so they stick to the visual corners /
  // center of the rotated bbox.
  //
  //   - move   → single handle at bbox center
  //   - scale  → 4 handles at rotated bbox corners (grab any to
  //              resize; existing drag math uses |cursor - centre|
  //              on both axes so any corner works)
  //   - rotate → 2 handles at SE (corners[1]) and NE (corners[2]).
  //              Emitting SW would be a no-op (rotation pivots on
  //              SW = start, so grabbing it yields no angle delta).
  //              SE + NE both give strong levers on the far side.
  //
  // Each feature carries iconId + cornerIndex + imageRotation for
  // the layer's icon-image / icon-rotate expressions, plus elevation
  // + height for the symbol-z-offset that lifts the handle to the
  // rack's top face.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(transformSourceId) as mapboxgl.GeoJSONSource | undefined
    if (!src) return
    if (!transformState) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    const [sx, sy] = transformState.draft.start
    const [cx, cy] = transformState.draft.current
    const bbox: [number, number, number, number] = [
      Math.min(sx, cx),
      Math.min(sy, cy),
      Math.max(sx, cx),
      Math.max(sy, cy),
    ]
    const rotPivot: [number, number] = [sx, sy]
    // Grid rotation applied at the icon-rotate expression level.
    const rot = transformState.draft.rotation

    // Look up the grid's config for elevation + level fields (not
    // carried on the transform draft — only geometric fields are).
    const activeGrid = committedLines?.find(
      (g) => g.id === transformState.gridId,
    )
    const activeCfg = activeGrid?.config ?? config
    const elev = activeCfg.elevation ?? 0
    // Compute the ACTUAL top-face altitude of a multi-level rack.
    // The extrusion layer uses `elevation + height` per cell, but
    // that's the top of the current LEVEL — for a multi-level rack
    // (levels > 1) each level extrudes `levelHeight` above the
    // previous with `levelGap` spacing between shelves. So the
    // top face of the highest level is:
    //   elevation + (levels - 1) * (levelHeight + levelGap) + levelHeight
    // Feeding this as the feature's `height` makes the symbol-z-
    // offset expression `elevation + height` land on the rack's
    // roof regardless of level count.
    const levels = Math.max(1, Math.floor(activeCfg.levels ?? 1))
    const levelHeight = Math.max(0, activeCfg.levelHeight ?? 0)
    const levelGap = Math.max(0, activeCfg.levelGap ?? 0)
    const heightConfig = activeCfg.height ?? 0
    const totalHeight =
      levels > 1
        ? (levels - 1) * (levelHeight + levelGap) + levelHeight
        : heightConfig
    const hgt = totalHeight

    const features: GeoJSON.Feature<GeoJSON.Point>[] = []
    if (transformState.kind === 'move') {
      const bcx = (sx + cx) / 2
      const bcy = (sy + cy) / 2
      const handlePos = rotatePointAroundPivot(
        bcx,
        bcy,
        rotPivot[0],
        rotPivot[1],
        rot,
      )
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: handlePos },
        properties: {
          kind: 'move',
          iconId: TRANSFORM_ICON.move,
          cornerIndex: -1,
          imageRotation: rot,
          elevation: elev,
          height: hgt,
        },
      })
    } else if (transformState.kind === 'scale') {
      // rotatedBboxCorners returns [SW, SE, NE, NW].
      // Scale gets TWO handles on the NE-SW diagonal:
      //   corners[0] = SW = grid start = "start point of the start cell"
      //   corners[2] = NE = grid current = "end point of the end cell"
      // Both handles sit on the rack's roof and both scale
      // symmetrically around the bbox centre (the existing drag
      // math uses |dx|/|dy| so it's indifferent to which diagonal
      // corner is grabbed).
      const corners = rotatedBboxCorners(bbox, rot, rotPivot) as [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ]
      for (const i of [0, 2]) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: corners[i] },
          properties: {
            kind: 'scale',
            iconId: TRANSFORM_ICON.scale,
            cornerIndex: i,
            imageRotation: rot,
            elevation: elev,
            height: hgt,
          },
        })
      }
    } else {
      // rotate → SE (idx 1) + NE (idx 2).
      const corners = rotatedBboxCorners(bbox, rot, rotPivot) as [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ]
      for (const i of [1, 2]) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: corners[i] },
          properties: {
            kind: 'rotate',
            iconId: TRANSFORM_ICON.rotate,
            cornerIndex: i,
            imageRotation: rot,
            elevation: elev,
            height: hgt,
          },
        })
      }
    }
    src.setData({ type: 'FeatureCollection', features })
  }, [transformState, map, styleLoaded, committedLines, config])

  // Selection tint filter — mirror the outline's per-cell scoping.
  // The tint layer is bound to FILL_SOURCE (all grid cells) so the
  // filter constrains it to cells whose gridId is in the selection.
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!map.getLayer(selectionTintLayerId)) return
    const ids =
      selectedGridIds && selectedGridIds.size > 0
        ? [...selectedGridIds]
        : [-1]
    // Compose with the transform exclusion — while a transform is
    // active, the committed halo/tint are suppressed and
    // SELECTION_INFLIGHT_LAYER / SELECTION_TINT_INFLIGHT_LAYER pick
    // them up on the moving grid at full quality.
    const excludeId = transformState?.gridId
    const idFilter = ['in', ['get', 'gridId'], ['literal', ids]]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: any = excludeId != null
      ? ['all', idFilter, ['!=', ['get', 'gridId'], excludeId]]
      : idFilter
    try {
      map.setFilter(selectionTintLayerId, filter)
    } catch { /* ignore */ }
  }, [map, styleLoaded, selectedGridIds, styleGen, selectionTintLayerId, transformState])

  // ---- Exclusion filter (committed base layers) ------------------------
  // While a transform is active, hide the moving grid from FILL /
  // EXTRUDE-op* / LINE / LINE_BOTTOM / LABEL / selectionLine so it
  // doesn't render twice — once at its stale committed geometry, once
  // at its live drag position on FILL_INFLIGHT_SOURCE. FILL / EXTRUDE
  // / LINE_BOTTOM already carry filters we preserve by composing.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const excludeId = transformState?.gridId
    const notMe = excludeId != null
      ? ['!=', ['get', 'gridId'], excludeId]
      : null
    // FILL_LAYER — `all [any gridId/preview], elevation+height <= 0`.
    try {
      if (map.getLayer(FILL_LAYER)) {
        const base: unknown[] = [
          'all',
          ['any', ['has', 'gridId'], ['has', 'preview']],
          [
            '<=',
            ['+', ['coalesce', ['get', 'elevation'], 0], ['coalesce', ['get', 'height'], 0]],
            0,
          ],
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filter: any = notMe ? [...base, notMe] : base
        map.setFilter(FILL_LAYER, filter)
      }
    } catch { /* ignore */ }
    // EXTRUDE_LAYER_op* — bucket + elevation/height + gridId-or-preview.
    for (const bucket of OPACITY_BUCKETS) {
      const layerId = extrudeLayerId(bucket)
      try {
        if (!map.getLayer(layerId)) continue
        const base: unknown[] = [
          'all',
          ['any', ['has', 'gridId'], ['has', 'preview']],
          [
            '>',
            ['+', ['coalesce', ['get', 'elevation'], 0], ['coalesce', ['get', 'height'], 0]],
            0,
          ],
          ['==', ['coalesce', ['get', 'opacityBucket'], 100], bucket],
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filter: any = notMe ? [...base, notMe] : base
        map.setFilter(layerId, filter)
      } catch { /* ignore */ }
    }
    // LINE_LAYER + LINE_BOTTOM_LAYER + LABEL_LAYER + selectionLineLayerId
    // — no default filter (or an elevation-only base for LINE_BOTTOM).
    for (const layerId of [LINE_LAYER, LABEL_LAYER]) {
      try {
        if (map.getLayer(layerId)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map.setFilter(layerId, (notMe ?? null) as any)
        }
      } catch { /* ignore */ }
    }
    // LINE_BOTTOM_LAYER may carry its own elevation base filter; use
    // notMe alone (the layer isn't visually critical during drag).
    try {
      if (map.getLayer(LINE_BOTTOM_LAYER)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(LINE_BOTTOM_LAYER, (notMe ?? null) as any)
      }
    } catch { /* ignore */ }
    // Committed selection line reads from selectionSourceId — filter
    // there too so the halo doesn't stay on the OLD position.
    try {
      if (map.getLayer(selectionLineLayerId)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(selectionLineLayerId, (notMe ?? null) as any)
      }
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, transformState, selectionLineLayerId])

  // Push the theme primary hex into paint props whose value has to
  // track the palette / mode. Grid selection outline + tint + label
  // ring share the same primary tint. Also targets the in-flight
  // halo/tint mirrors so the moving grid's highlight matches.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const trySetPaint = (id: string, prop: string, value: unknown) => {
      try {
        if (map.getLayer(id)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map.setPaintProperty(id, prop as any, value)
        }
      } catch { /* ignore */ }
    }
    trySetPaint(selectionLineLayerId, 'line-color', primaryHex)
    trySetPaint(selectionTintLayerId, 'fill-extrusion-color', primaryHex)
    trySetPaint(SELECTION_INFLIGHT_LAYER, 'line-color', primaryHex)
    trySetPaint(SELECTION_TINT_INFLIGHT_LAYER, 'fill-extrusion-color', primaryHex)
  }, [
    map,
    styleLoaded,
    styleGen,
    primaryHex,
    selectionLineLayerId,
    selectionTintLayerId,
  ])

  // Keep selection tint, outline, in-flight surfaces, and transform
  // handle at the top of the layer stack so late-mounted overlays
  // can't shove above. Deps include `transformState` so handles
  // re-elevate the moment the user clicks Move / Rotate / Scale;
  // omitting it hides the handle behind overlays that mounted after
  // us. `committedLines` + `selectedGridIds` are OMITTED — the drag
  // handler bypasses React state during a drag so committedLines
  // doesn't churn.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const id of [
      selectionTintLayerId,
      selectionLineLayerId,
      FILL_INFLIGHT_LAYER,
      EXTRUDE_INFLIGHT_LAYER,
      LINE_INFLIGHT_LAYER,
      LINE_BOTTOM_INFLIGHT_LAYER,
      LABEL_INFLIGHT_LAYER,
      SELECTION_TINT_INFLIGHT_LAYER,
      SELECTION_INFLIGHT_LAYER,
      transformLayerId,
    ]) {
      try {
        if (map.getLayer(id)) map.moveLayer(id)
      } catch { /* ignore */ }
    }
  }, [
    map,
    styleLoaded,
    styleGen,
    transformState,
    selectionTintLayerId,
    selectionLineLayerId,
    transformLayerId,
  ])

  // Pointer event handling for the move/rotate drag. We attach the
  // listeners to the map (not the handle layer) so the drag works even
  // if the user moves the cursor off the marker mid-drag.
  //
  // IMPORTANT: the drag state is held in a ref so it persists across
  // effect re-runs. Every onTransformChange call causes the parent to
  // re-create the callback (via useCallback), which re-runs this
  // effect. If we used a local const, the new effect closure would
  // see a fresh, empty dragState and mouseup would think we're not
  // dragging.

  // Ref-mirror of `committedLines` so the drag effect can find the
  // transforming grid's config without re-mounting when the array
  // reference changes.
  const committedLinesRef = useRef(committedLines)
  useEffect(() => { committedLinesRef.current = committedLines }, [committedLines])
  const onTransformChangeRef = useRef(onTransformChange)
  useEffect(() => { onTransformChangeRef.current = onTransformChange }, [onTransformChange])

  // ---- In-flight source population ------------------------------------
  // When a transform starts, immediately push the target grid's cells
  // into FILL_INFLIGHT / LINE_INFLIGHT / LABEL_INFLIGHT so the moving
  // grid renders identically from the moment transformState flips.
  // Also pins EXTRUDE_INFLIGHT_LAYER opacity from the grid's config so
  // the moving 3D fill matches the committed bucket. Emptied on
  // transform end so no ghost feature lingers after the committed
  // source rebuilds.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const fillSrc = map.getSource(FILL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const lineSrc = map.getSource(LINE_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const labelSrc = map.getSource(LABEL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
    if (!transformState) {
      fillSrc?.setData(emptyFC)
      lineSrc?.setData(emptyFC)
      labelSrc?.setData(emptyFC)
      return
    }
    const g = (committedLines ?? []).find((c) => c.id === transformState.gridId)
    if (!g) {
      fillSrc?.setData(emptyFC)
      lineSrc?.setData(emptyFC)
      labelSrc?.setData(emptyFC)
      return
    }
    try {
      const cfg = { ...g.config, rotation: transformState.draft.rotation }
      const result = buildGridFromLine(
        transformState.draft.start,
        transformState.draft.current,
        cfg,
        { committed: true, gridId: g.id },
      )
      const cells = result.cells as GeoJSON.Feature<GeoJSON.Polygon>[]
      fillSrc?.setData({ type: 'FeatureCollection', features: cells })
      // Border LineStrings derived from polygon outer rings.
      lineSrc?.setData({
        type: 'FeatureCollection',
        features: cells.map((f) => ({
          type: 'Feature',
          properties: f.properties as GeoJSON.GeoJsonProperties,
          geometry: {
            type: 'LineString',
            coordinates: f.geometry.coordinates[0],
          },
        })),
      })
      // Labels — one Point per cell if the grid opts in.
      const showLabels = (cfg as { showLabels?: boolean }).showLabels ?? false
      if (showLabels) {
        const labels: GeoJSON.Feature<GeoJSON.Point>[] = []
        for (const cell of cells) {
          const ring = cell.geometry.coordinates[0]
          if (!ring || ring.length < 3) continue
          let cx = 0
          let cy = 0
          const n = ring.length - 1
          for (let i = 0; i < n; i++) {
            cx += ring[i][0]
            cy += ring[i][1]
          }
          labels.push({
            type: 'Feature',
            properties: cell.properties as GeoJSON.GeoJsonProperties,
            geometry: { type: 'Point', coordinates: [cx / n, cy / n] },
          })
        }
        labelSrc?.setData({ type: 'FeatureCollection', features: labels })
      } else {
        labelSrc?.setData(emptyFC)
      }
      // Sync EXTRUDE_INFLIGHT_LAYER opacity to the config.
      const op = Math.max(
        0,
        Math.min(1, ((g.config as { opacity?: number }).opacity ?? 100) / 100),
      )
      map.setPaintProperty(EXTRUDE_INFLIGHT_LAYER, 'fill-extrusion-opacity', op)
    } catch (err) {
      console.warn('[MapGridOverlay] in-flight population failed', err)
    }
  }, [map, styleLoaded, styleGen, transformState, committedLines])

  const dragStateRef = useRef<{
    dragging: boolean
    originalStart: [number, number] | null
    originalCurrent: [number, number] | null
    originalRotation: number
    downLngLat: [number, number] | null
    downAngle: number | null
    pivotLng: number
    pivotLat: number
    lastStart: [number, number] | null
    lastCurrent: [number, number] | null
    lastRotation: number
    shiftHeld: boolean
    // RAF-coalescing state for the direct in-flight push.
    pendingLngLat: [number, number] | null
    rafId: number
  } | null>(null)
  useEffect(() => {
    if (!map || !transformState) return
    if (!dragStateRef.current) {
      dragStateRef.current = {
        dragging: false,
        originalStart: null,
        originalCurrent: null,
        originalRotation: 0,
        downLngLat: null,
        downAngle: null,
        pivotLng: 0,
        pivotLat: 0,
        lastStart: null,
        lastCurrent: null,
        lastRotation: 0,
        shiftHeld: false,
        pendingLngLat: null,
        rafId: 0,
      }
    }
    const dragState = dragStateRef.current

    // Compute the new start/current/rotation for the current cursor.
    // Mirrors the pre-refactor per-kind math but returns instead of
    // firing onTransformChange — the RAF flush pushes directly to
    // in-flight sources without touching React state.
    const computeNext = (lngLat: [number, number]): {
      start: [number, number]
      current: [number, number]
      rotation: number
    } | null => {
      if (
        !dragState.originalStart ||
        !dragState.originalCurrent ||
        !dragState.downLngLat ||
        dragState.downAngle === null
      ) return null
      if (transformState.kind === 'move') {
        const dLng = lngLat[0] - dragState.downLngLat[0]
        const dLat = lngLat[1] - dragState.downLngLat[1]
        return {
          start: [dragState.originalStart[0] + dLng, dragState.originalStart[1] + dLat],
          current: [dragState.originalCurrent[0] + dLng, dragState.originalCurrent[1] + dLat],
          rotation: dragState.originalRotation,
        }
      }
      if (transformState.kind === 'scale') {
        const dx = lngLat[0] - dragState.pivotLng
        const dy = lngLat[1] - dragState.pivotLat
        const rotRad = (-dragState.originalRotation * Math.PI) / 180
        const cos = Math.cos(rotRad)
        const sin = Math.sin(rotRad)
        const localX = dx * cos - dy * sin
        const localY = dx * sin + dy * cos
        const eps = 1e-9
        let newHalfW = Math.max(eps, Math.abs(localX))
        let newHalfH = Math.max(eps, Math.abs(localY))
        const origHalfW = Math.max(eps, Math.abs(dragState.originalCurrent[0] - dragState.originalStart[0]) / 2)
        const origHalfH = Math.max(eps, Math.abs(dragState.originalCurrent[1] - dragState.originalStart[1]) / 2)
        if (dragState.shiftHeld) {
          const ratio = Math.max(
            eps / origHalfW,
            Math.hypot(localX, localY) / Math.hypot(origHalfW, origHalfH),
          )
          newHalfW = origHalfW * ratio
          newHalfH = origHalfH * ratio
        }
        return {
          start: [dragState.pivotLng - newHalfW, dragState.pivotLat - newHalfH],
          current: [dragState.pivotLng + newHalfW, dragState.pivotLat + newHalfH],
          rotation: dragState.originalRotation,
        }
      }
      // Rotate.
      const dx = lngLat[0] - dragState.originalStart[0]
      const dy = lngLat[1] - dragState.originalStart[1]
      if (dx === 0 && dy === 0) return null
      const angle = Math.atan2(dx, dy) * (180 / Math.PI)
      const delta = angle - dragState.downAngle
      return {
        start: dragState.originalStart,
        current: dragState.originalCurrent,
        rotation: dragState.originalRotation + delta,
      }
    }

    // Push the transforming grid's cells directly to the in-flight
    // sources. Never touches React state. Cost per frame: 1 ×
    // buildGridFromLine (only the transforming grid — no rebuild of
    // the N-1 committed grids) + 3 × setData.
    const pushInflight = (next: {
      start: [number, number]
      current: [number, number]
      rotation: number
    }) => {
      const g = (committedLinesRef.current ?? []).find(
        (c) => c.id === transformState.gridId,
      )
      if (!g) return
      try {
        const cfg = { ...g.config, rotation: next.rotation }
        const result = buildGridFromLine(next.start, next.current, cfg, {
          committed: true,
          gridId: g.id,
        })
        const cells = result.cells as GeoJSON.Feature<GeoJSON.Polygon>[]
        const fillSrc = map.getSource(FILL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
        const lineSrc = map.getSource(LINE_INFLIGHT_SOURCE) as GeoJSONSource | undefined
        const labelSrc = map.getSource(LABEL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
        fillSrc?.setData({ type: 'FeatureCollection', features: cells })
        lineSrc?.setData({
          type: 'FeatureCollection',
          features: cells.map((f) => ({
            type: 'Feature',
            properties: f.properties as GeoJSON.GeoJsonProperties,
            geometry: { type: 'LineString', coordinates: f.geometry.coordinates[0] },
          })),
        })
        const showLabels = (cfg as { showLabels?: boolean }).showLabels ?? false
        if (labelSrc) {
          if (showLabels) {
            const labels: GeoJSON.Feature<GeoJSON.Point>[] = []
            for (const cell of cells) {
              const ring = cell.geometry.coordinates[0]
              if (!ring || ring.length < 3) continue
              let cx = 0
              let cy = 0
              const n = ring.length - 1
              for (let i = 0; i < n; i++) {
                cx += ring[i][0]
                cy += ring[i][1]
              }
              labels.push({
                type: 'Feature',
                properties: cell.properties as GeoJSON.GeoJsonProperties,
                geometry: { type: 'Point', coordinates: [cx / n, cy / n] },
              })
            }
            labelSrc.setData({ type: 'FeatureCollection', features: labels })
          } else {
            labelSrc.setData({ type: 'FeatureCollection', features: [] })
          }
        }
      } catch (err) {
        console.warn('[MapGridOverlay] drag pushInflight failed', err)
      }
    }

    const flushDragFrame = () => {
      dragState.rafId = 0
      if (!dragState.dragging || !dragState.pendingLngLat) return
      const next = computeNext(dragState.pendingLngLat)
      if (!next) return
      dragState.lastStart = next.start
      dragState.lastCurrent = next.current
      dragState.lastRotation = next.rotation
      pushInflight(next)
    }
    const scheduleFlush = () => {
      if (dragState.rafId !== 0) return
      dragState.rafId = requestAnimationFrame(flushDragFrame)
    }

    const onDown = (e: mapboxgl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: [transformLayerId] })
      if (features.length === 0) return
      dragState.dragging = true
      dragState.shiftHeld = (e.originalEvent as MouseEvent | undefined)?.shiftKey ?? false
      dragState.originalStart = transformState.draft.start
      dragState.originalCurrent = transformState.draft.current
      dragState.originalRotation = transformState.draft.rotation
      dragState.pivotLng = (dragState.originalStart[0] + dragState.originalCurrent[0]) / 2
      dragState.pivotLat = (dragState.originalStart[1] + dragState.originalCurrent[1]) / 2
      dragState.downLngLat = [e.lngLat.lng, e.lngLat.lat]
      const angleAnchor: [number, number] =
        transformState.kind === 'rotate'
          ? dragState.originalStart
          : [dragState.pivotLng, dragState.pivotLat]
      const dx = dragState.downLngLat[0] - angleAnchor[0]
      const dy = dragState.downLngLat[1] - angleAnchor[1]
      dragState.downAngle = dx === 0 && dy === 0 ? 0 : Math.atan2(dx, dy) * (180 / Math.PI)
      dragState.lastStart = dragState.originalStart
      dragState.lastCurrent = dragState.originalCurrent
      dragState.lastRotation = dragState.originalRotation
      map.getCanvas().style.cursor =
        transformState.kind === 'move'
          ? 'grabbing'
          : transformState.kind === 'scale'
            ? 'nwse-resize'
            : 'crosshair'
      e.preventDefault?.()
    }
    const onNativeMove = (ev: MouseEvent) => {
      if (!dragState.dragging) return
      dragState.shiftHeld = ev.shiftKey
      const rect = map.getCanvas().getBoundingClientRect()
      const point = { x: ev.clientX - rect.left, y: ev.clientY - rect.top } as unknown as [number, number]
      const ll = map.unproject(point)
      dragState.pendingLngLat = [ll.lng, ll.lat]
      scheduleFlush()
    }
    const onUp = () => {
      if (!dragState.dragging) return
      dragState.dragging = false
      dragState.downLngLat = null
      dragState.downAngle = null
      map.getCanvas().style.cursor = ''
      if (dragState.rafId !== 0) {
        cancelAnimationFrame(dragState.rafId)
        dragState.rafId = 0
      }
      dragState.pendingLngLat = null
      const s = dragState.lastStart ?? dragState.originalStart
      const c = dragState.lastCurrent ?? dragState.originalCurrent
      if (s && c) {
        onTransformChangeRef.current?.(s, c, dragState.lastRotation, true)
      }
    }
    const onNativeUp = (_ev: MouseEvent) => {
      onUp()
    }

    map.on('mousedown', onDown)
    // Listen on the document for mousemove/mouseup so the drag continues
    // even if the cursor leaves the canvas. The draw plugin's
    // simple_select mode can otherwise swallow map-level mousemove events.
    document.addEventListener('mousemove', onNativeMove)
    document.addEventListener('mouseup', onNativeUp)
    return () => {
      map.off('mousedown', onDown)
      document.removeEventListener('mousemove', onNativeMove)
      document.removeEventListener('mouseup', onNativeUp)
      if (dragState.rafId !== 0) {
        cancelAnimationFrame(dragState.rafId)
        dragState.rafId = 0
      }
    }
  }, [map, transformState, transformLayerId])

  return null
}

// Avoid unused import warning on type-only re-export.
export type { GridCell }
