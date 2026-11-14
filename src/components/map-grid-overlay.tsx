import { sameClipFootprints, syncBasemapClipLayer, useBasemapClipNeeded } from '@/lib/basemap-clip'
import { isFocusFlying } from '@/lib/focus/focus-camera'
import { gridCutPlan, type GridCutPlan } from '@/lib/focus/focus-cutaway'
import { canLiftExtrusions, FOCUS_LIFT_STATE, withFocusLift } from '@/lib/focus/focus-fade'
import { nearIdsOf } from '@/lib/focus/focus-near'
import {
  blockerPierceOf,
  FOCUS_FACTOR,
  focusedCellOf,
  focusedIdOf,
  focusTier,
  GHOST_OCCLUDED_OPACITY,
  NO_BLOCKERS,
  NO_PIERCE,
  useFocusBlockers,
  useFocusScene,
  type FocusBlockers,
  type FocusDiscs,
  type FocusScene,
} from '@/lib/focus/focus-scene'
import type { FocusCell } from '@/lib/focus/focus-target'
import { useGraphicsSettings } from '@/lib/graphics-settings'
import {
  buildGrid,
  buildGridFromLine,
  gridClipRings,
  rotatedBboxCorners,
  rotatePointAroundPivot,
  type GridCell,
  type GridCellProps,
  type GridConfig,
} from '@/lib/grid-generators'
import { compactRing, isPathGrid, pathGridVertices } from '@/lib/grid-path'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import {
  buildOccluders,
  createOcclusionState,
  resetOcclusionState,
  updateOcclusion,
  type GridOccluderInput,
  type OccludableTarget,
  type OcclusionState,
} from '@/lib/marker-occlusion'
import type {
  CircleShape,
  ImageShape,
  LineShape,
  PolygonShape,
  StairShape,
} from '@/lib/shapes'
import type { FeatureCollection } from 'geojson'
import type {
  FillExtrusionLayerSpecification,
  FillLayerSpecification,
  GeoJSONSource,
  LineLayerSpecification,
  Map as MapboxMapInstance,
  MapLayerMouseEvent,
  MapMouseEvent,
  SymbolLayerSpecification,
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
/**
 * Selection tint cells — only the selected grids' polygons, so selecting
 * a grid is a setData on a few hundred features instead of a setFilter
 * that re-tiles every cell on the map.
 */
const SELECTION_TINT_SOURCE = 'grid-selection-tint-source'
// Live preview (the grid being drawn, `line` / `bbox`): its own small
// sources, so a pointer move re-uploads the preview only, never the
// committed cells. Each preview layer is the committed layer's spec on
// the preview source, inserted directly BELOW its committed twin — the
// order the preview cells had when they shared the committed sources
// (preview features came first, so they drew first).
const PREVIEW_POLY_SOURCE = 'grid-preview-poly-source'
const PREVIEW_LINE_SOURCE = 'grid-preview-line-source'
const PREVIEW_LABEL_SOURCE = 'grid-preview-label-source'
const PREVIEW_FILL_LAYER = 'grid-preview-fill-layer'
/** One layer: every preview cell shares the panel config, hence one opacity bucket. */
const PREVIEW_EXTRUDE_LAYER = 'grid-preview-extrude-layer'
const PREVIEW_LINE_LAYER = 'grid-preview-line-layer'
const PREVIEW_LINE_BOTTOM_LAYER = 'grid-preview-line-bottom-layer'
const PREVIEW_LABEL_LAYER = 'grid-preview-label-layer'

/**
 * Tile buffer (px of a 512 px tile) for the cell polygon / border
 * sources. Mapbox's default 128 copies a quarter tile of every
 * neighbour into each tile — ~1.7× the features on a seat stand — and
 * none of it reaches a pixel here: fills are stencil-clipped to their
 * tile, fill-extrusions drop walls on buffer-clip edges and stencil out
 * duplicate roofs, and the borders (`line-elevation-reference: 'sea'`)
 * are clipped by Mapbox's own line bucket to 2 units past the tile.
 * Not 0: a ring vertex exactly on the tile edge would then count as
 * inside, and its seam wall would draw.
 */
const CELL_SOURCE_BUFFER = 8

/**
 * The layers a grid cell can be clicked / hovered on, in the order the
 * click handler was historically registered on them (one listener per
 * layer, first layer with a gridId hit won). One shared array instance —
 * Mapbox's `off` needs the same layer list it was given to `on`.
 */
const CELL_HIT_LAYERS: string[] = [FILL_LAYER, LINE_LAYER, ...EXTRUDE_LAYER_IDS]

// ---- Focus mode (src/lib/focus/) ----------------------------------------------
// A focused item must never hide behind a rack, and nothing else may crowd
// it. Only two kinds of rack / seat section fade:
//  - line-of-sight blockers (`useFocusBlockers`) → FOCUS_FACTOR.ghost;
//  - sections in the NEAR column around the item (`scene.near.grids`,
//    `focus-near.ts`) → FOCUS_FACTOR.near.
// Every other section — its cells, borders and labels — stays exactly as
// it is with focus off: no bucket dim, no border dim, no ordering pins.
//
// Cell scoping (`gridCellRule` over `gridCutPlan`, focus-cutaway.ts). A
// section no bigger than the region fades whole ('whole'). A section much
// larger than it (bbox diagonal > 3R or area > 4πR², R = 5 m) fades only
// the cells in the region ('cells'):
//  - near: the NEAR column's cells (`scene.near.gridCells`, within 5 m of
//    the item);
//  - ghost: those, the cells whose centroid lies in R_item ∪ the pierce
//    discs (`blockers.pierce.grids`), and the exact blocking cells
//    (`blockers.gridCells`, so a blocker always clears the line of sight).
// The rest of the section is drawn as before. The bin overlay tests its
// tints with the same `gridCellRule`.
//
// The cell sources hold up to 30k cells, so none of this may re-stamp or
// setData them. Instead:
//
//  - Lift + twin. Each bucket layer's `fill-extrusion-color` is wrapped
//    once at install (`withFocusLift`): a grid whose feature-state says
//    `focusLift` gets alpha 0, which GL 3.25's fill-extrusion shaders drop.
//    All cells of a grid share feature id = gridId, so ONE write per grid
//    lifts a whole rack / seat section out of its bucket layer. Lifted
//    grids (near ∪ blockers) are redrawn from their cached per-grid parts
//    on small twin sources:
//      FOCUS_GHOST_LAYER — the blockers' fading cells (whole sections in
//        'whole' mode), at FOCUS_FACTOR.ghost.
//      FOCUS_NEAR_LAYER — the near-tier fading cells of EVERY section of
//        the NEAR column, at FOCUS_FACTOR.near. Per focus: it never
//        depends on the blockers. A near section that is also a blocker
//        right now is hidden ON this twin by the same `focusLift`
//        feature-state (its colour is wrapped too) and drawn by the ghost
//        and rest twins instead.
//      FOCUS_REST_LAYER — the cells of 'cells' sections that do NOT fade,
//        at one constant opacity: the mode bucket of those cells (chosen
//        from the near sections first, so it never moves the near twin).
//        A section whose rest cells are not all in that bucket falls back
//        to 'whole'. At bucket 100 it is opaque and sits home right after
//        -op100, where those cells were drawn.
//      FOCUS_TWIN_LAYER — only the focused bin, when its own section is
//        lifted, at the bin's own opacity (a whole-rack target is not
//        lifted at all: it stays in its bucket with the host's selection).
//    Twins cast no shadow (an empty or faint twin must never move the
//    ground-shadow pass), so with Graphics → Shadows on a lifted section's
//    rest cells lose their cast shadow while focused.
//    A twin is written first; the lift is applied on the first `render`
//    where the twin sources are loaded, and a lift is removed before a twin
//    lets go of the section, so a rack never blinks out. Lifted cells still
//    answer queryRenderedFeatures through their bucket layer (the test is
//    geometric), so clicks and hover work.
//  - Settling. Entering, leaving or switching focus, and a focus fly,
//    apply at once. Every other change of the same focus (a blocker set
//    that changed at a throttled tick or at moveend, a near section
//    turning into a blocker) waits for the next `moveend`, or `idle`
//    outside any move (`onNextCameraSettle`). Camera motion is a
//    movestart / moveend count, not `map.isMoving()`, which reads false
//    between the frames of a jumpTo- or animation-driven orbit. So the
//    ghost / rest twins are written at most once per settle and never
//    mid-move; the near and focus twins only with the focus.
//  - Flat cells (a 2D fill with data-driven opacity) fold a `focusScale`
//    feature-state into `fill-opacity`, written per GRID on change. Flat
//    cells share feature id = gridId, so they can't be cell-scoped: a
//    flat section fades whole even in 'cells' mode.
//  - Rack labels of NEAR sections fold a `focusScale` feature-state
//    (FOCUS_FACTOR.near) into `text-opacity`, written per label on change;
//    in 'cells' mode only the labels of fading cells.
//  - Borders stay as drawn: LINE_SOURCE features carry no feature id (its
//    queryRenderedFeatures hits stay per cell), so there is nothing to hang
//    a per-section feature-state on, and a filter / data-driven paint swap
//    would re-tile the 30k-cell border source.
//
// Viewer, reports, share links and the editor all use this one policy.
//
// When `canLiftExtrusions()` is false (any GL JS other than 3.25.x — the
// alpha-0 discard is an audited shader detail) there is no lift and no
// twin: only flat cells and labels fade.
const FOCUS_TWIN_SOURCE = 'grid-focus-source'
const FOCUS_TWIN_LAYER = 'grid-focus-layer'
const FOCUS_GHOST_SOURCE = 'grid-focus-ghost-source'
const FOCUS_GHOST_LAYER = 'grid-focus-ghost-layer'
const FOCUS_NEAR_SOURCE = 'grid-focus-near-source'
const FOCUS_NEAR_LAYER = 'grid-focus-near-layer'
const FOCUS_REST_SOURCE = 'grid-focus-rest-source'
const FOCUS_REST_LAYER = 'grid-focus-rest-layer'
const FOCUS_TWIN_LAYERS = [FOCUS_TWIN_LAYER, FOCUS_GHOST_LAYER, FOCUS_NEAR_LAYER, FOCUS_REST_LAYER] as const
const FOCUS_TWIN_SOURCES = [FOCUS_TWIN_SOURCE, FOCUS_GHOST_SOURCE, FOCUS_NEAR_SOURCE, FOCUS_REST_SOURCE] as const
/** Feature-state key folded into FILL_LAYER's `fill-opacity` (flat cells) and LABEL_LAYER's `text-opacity`. */
const FOCUS_SCALE_STATE = 'focusScale'
/** `focusScale` as a factor: 1 while the feature carries none (a fresh array per use). */
const focusScaleFactor = () => ['coalesce', ['feature-state', FOCUS_SCALE_STATE], 1]
/** GL JS 3.25.x only — see the block comment above. */
const LIFTABLE = canLiftExtrusions()
/** `line-opacity` of the committed border layers. */
const GRID_LINE_OPACITY = 0.9

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
   * `setLayoutProperty('visibility', 'none')`. The live-draw cell layers
   * (`grid-preview-*`) are hidden with them; the bbox outline and centre
   * dot are not affected — those stay visible while drawing.
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

// ---- Layer specs ------------------------------------------------------------
// Functions, not inline literals, so a committed layer and its live-preview
// twin are the same spec on different sources, and so the exclusion effect
// can re-compose each layer's base filter instead of replacing it.

/** `elevation + height`, exactly as every cell filter computes it. */
const cellTopExpr = () => ['+', ['coalesce', ['get', 'elevation'], 0], ['coalesce', ['get', 'height'], 0]]
/** Committed cells carry `gridId`, live-preview cells `preview`. */
const cellKeyFilter = () => ['any', ['has', 'gridId'], ['has', 'preview']]
const fillBaseFilter = () => ['all', cellKeyFilter(), ['<=', cellTopExpr(), 0]]
/**
 * Route only cells whose bucket matches this layer's value. The
 * `coalesce` defaults preview cells (or any cell without a stamped
 * bucket) to 100 so they land in the full-opacity layer and never
 * silently disappear.
 */
const extrudeBaseFilter = (bucket: number) => [
  'all',
  cellKeyFilter(),
  ['>', cellTopExpr(), 0],
  ['==', ['coalesce', ['get', 'opacityBucket'], 100], bucket],
]
const lineBaseFilter = () => cellKeyFilter()
/**
 * Every cell, flat ones included. A flat cell's (`elevation + height <= 0`)
 * bottom edge sits at the altitude of its top border, so it draws that
 * border a second time — and that double pass IS the established look:
 * the pre-split exclusion effect nulled this layer's filter on mount, so
 * flat borders always composited twice (~0.99 alpha, a denser fringe),
 * and the live preview's dashed leading (`future`) cell read as solid.
 * Do not narrow this to elevated cells: flat borders turn visibly lighter.
 */
const lineBottomBaseFilter = () => cellKeyFilter()
/** Render only if the cell's grid has `showLabels` true. Default-true if missing (older DB rows). */
const labelBaseFilter = () => ['!=', ['coalesce', ['get', 'showLabels'], true], false]

function fillLayerSpec(id: string, source: string): FillLayerSpecification {
  return {
    id,
    type: 'fill',
    source,
    // Filter keeps two kinds of features and excludes elevated cells:
    //   * Committed flat cells (`gridId` present, elevation+height==0).
    //   * Live-preview flat cells (`preview` present, elevation+height==0).
    // Elevated cells fall through to the extrude layers. Each cell
    // carries its own `color`/`opacity`/`elevation`/`height` so a mix of
    // flat and 3D grids can coexist without a global toggle.
    filter: fillBaseFilter() as never,
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
  }
}

function extrudeLayerSpec(id: string, source: string, bucket: number): FillExtrusionLayerSpecification {
  return {
    id,
    type: 'fill-extrusion',
    source,
    filter: extrudeBaseFilter(bucket) as never,
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
  }
}

/**
 * Cell borders. `dashed` adds the live-preview leading-cell dash
 * (`future` cells); committed cells never carry `future`, and their old
 * `[1]` dash was a single seamless dash — a solid line drawn through the
 * dash shader — so committed borders simply leave the dash out.
 */
function lineLayerSpec(id: string, source: string, dashed: boolean): LineLayerSpecification {
  return {
    id,
    type: 'line',
    source,
    // Borders show for every cell in 2D and 3D (lifted to the cell
    // top via `line-z-offset`). Keep `gridId`/`preview` filter to
    // preserve those properties for the click handler.
    filter: lineBaseFilter() as never,
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
      ...(dashed
        ? {
            'line-dasharray': [
              'case',
              ['==', ['get', 'future'], true], [2, 1],
              [1],
            ],
          }
        : {}),
      'line-opacity': GRID_LINE_OPACITY,
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
  }
}

/**
 * Bottom-edge border for 3D-extruded cells — see the `LINE_BOTTOM_LAYER`
 * const docstring. Same source and most paint as the rooftop border, but
 * the z-offset reads only `elevation` (no height) so the line sits at the
 * extrusion BASE.
 */
function lineBottomLayerSpec(id: string, source: string): LineLayerSpecification {
  return {
    id,
    type: 'line',
    source,
    filter: lineBottomBaseFilter() as never,
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
      'line-opacity': GRID_LINE_OPACITY,
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
  }
}

/**
 * `rest` is the `text-opacity` of labels the occlusion pass did not hide:
 * 1 for the preview, `focusScaleFactor()` for LABEL_LAYER (1 until focus mode
 * writes a `focusScale` on a near section's labels — the same value as 1
 * for every label while focus is off).
 */
function labelLayerSpec(id: string, source: string, rest: unknown = 1): SymbolLayerSpecification {
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
    // and adjacent walls at a tilt. (Graphics → faint ghosts swaps the
    // occluded branch through the same builder; `rest` stays as installed.)
    'text-opacity': gridLabelOpacity(0, rest),
    // Force x-ray (1) so the GL depth buffer doesn't second-
    // guess our analytic pass — same reasoning that made the
    // text-label overlay disable native occlusion in v5.4.
    'text-occlusion-opacity': 1,
  }
  return {
    id,
    type: 'symbol',
    source,
    filter: labelBaseFilter() as never,
    layout: labelLayout,
    paint: labelPaint,
  }
}

/** Exclusion-effect bookkeeping: each committed cell layer and the filter it was added with. */
const COMMITTED_BASE_FILTERS: ReadonlyArray<readonly [string, () => unknown[] | null]> = [
  [FILL_LAYER, fillBaseFilter],
  ...OPACITY_BUCKETS.map((b) => [extrudeLayerId(b), () => extrudeBaseFilter(b)] as const),
  [LINE_LAYER, lineBaseFilter],
  [LINE_BOTTOM_LAYER, lineBottomBaseFilter],
  [LABEL_LAYER, labelBaseFilter],
  ['grid-selection-line-layer', () => null],
]

// ---- Focus-mode specs ----------------------------------------------------------

/**
 * Rack-label `text-opacity`: `occluded` for labels the occlusion pass hid
 * (0, or GHOST_OCCLUDED_OPACITY with Graphics → faint ghosts), `rest` for
 * the others. `gridLabelOpacity(0, 1)` is the exact expression the layer
 * had before focus mode (still the preview's); LABEL_LAYER installs
 * `gridLabelOpacity(0, focusScaleFactor())`, which evaluates the same until
 * a near section's labels carry a `focusScale` feature-state. Only the
 * occluded branch is ever swapped (the ghosts toggle).
 */
export function gridLabelOpacity(occluded: number, rest: unknown): unknown[] {
  return ['case', ['boolean', ['feature-state', 'occluded'], false], occluded, rest]
}

/** The `labelId` `labelFeatureOf` stamps on a committed cell's label. */
function labelIdOf(gridId: number, row: number, col: number, level: number): number {
  return gridId * 100_000_000 + row * 100_000 + col * 100 + level
}

/**
 * A committed bucket layer, its colour wrapped with `withFocusLift` when
 * lifting is supported. Without a `focusLift` feature-state the case falls
 * through to the original colour, so this draws exactly what it did.
 */
function liftableExtrudeLayerSpec(bucket: number): FillExtrusionLayerSpecification {
  const spec = extrudeLayerSpec(extrudeLayerId(bucket), EXTRUDE_SOURCE, bucket)
  if (!LIFTABLE) return spec
  return {
    ...spec,
    paint: { ...spec.paint, 'fill-extrusion-color': withFocusLift(spec.paint?.['fill-extrusion-color']) },
  }
}

/**
 * FILL_LAYER with `fill-opacity` scaled by the `focusScale` feature-state
 * (flat cells of a near / blocking grid). ×1 when the state is absent.
 */
function focusScaledFillLayerSpec(spec: FillLayerSpecification): FillLayerSpecification {
  return {
    ...spec,
    paint: {
      ...spec.paint,
      'fill-opacity': ['*', focusScaleFactor(), spec.paint?.['fill-opacity']] as never,
    },
  }
}

/**
 * A focus twin: the bucket-layer spec on its own small source, without the
 * bucket clause (one constant opacity for everything it holds), casting no
 * shadow (an empty or faint twin must never move the ground-shadow pass)
 * and with no opacity transition (a paint change must not fade through
 * 100 % on a ghost). Added at opacity 1 — opaque, directly after
 * `-op100` — so an idle twin never changes how the translucent-order pass
 * arranges the existing layers. `liftable`: the colour is wrapped with
 * `withFocusLift` too, so one section can be hidden on the twin itself
 * (the near twin: a near section that is currently a blocker).
 */
function focusTwinLayerSpec(id: string, source: string, liftable = false): FillExtrusionLayerSpecification {
  const spec = extrudeLayerSpec(id, source, 100)
  return {
    ...spec,
    filter: ['all', cellKeyFilter(), ['>', cellTopExpr(), 0]] as never,
    paint: {
      ...spec.paint,
      ...(liftable ? { 'fill-extrusion-color': withFocusLift(spec.paint?.['fill-extrusion-color']) } : {}),
      'fill-extrusion-opacity': 1,
      'fill-extrusion-opacity-transition': { duration: 0, delay: 0 },
      'fill-extrusion-cast-shadows': false,
    },
  }
}

// ---- Per-grid render parts ---------------------------------------------------

/**
 * How far (m) a compacted ring may sit from the generator's ring: 0.5 mm,
 * a thirtieth of Mapbox's own vertex quantum on a z18 tile (~1.6 cm).
 */
const RING_COMPACT_EPS_M = 0.0005

/**
 * One committed grid's share of every cell source, built once per
 * tessellation (and once per distinct style-rule stamp), then reused by
 * identity until the grid changes. Each source only receives what one of
 * its layers draws, with only the properties those layers (and the click
 * / hover / region-select readers: `gridId`, `row`, `col`, `level`,
 * `elevation`, `height`) read:
 *
 *   - `flat`    → FILL_SOURCE    (color, opacity)
 *   - `extrude` → EXTRUDE_SOURCE (color, opacityBucket)
 *   - `line`    → LINE_SOURCE    (borderColor, borderWidth)
 *
 * The layers keep their full filters, and a cell whose routing can't be
 * decided here (a non-numeric elevation / height) goes to both sources —
 * the filters still pick exactly the cells they always did.
 */
export interface GridRenderParts {
  flat: GeoJSON.Feature<GeoJSON.Polygon>[]
  extrude: GeoJSON.Feature<GeoJSON.Polygon>[]
  line: GeoJSON.Feature<GeoJSON.LineString>[]
  /** Label points — built from the full-precision rings, as before. */
  labels: GeoJSON.Feature<GeoJSON.Point>[]
  /** Opacity buckets at least one `extrude` feature routes to. */
  buckets: number[]
  /** The cells as drawn (style-rule overrides applied, full precision). */
  cells: GridCell[]
  /** Compacted outer ring per cell, index-aligned with `cells`. */
  rings: GeoJSON.Position[][]
}

/**
 * `['coalesce', ['get', key], 0]` as Mapbox's worker sees the value after
 * setData's JSON round trip (NaN / ±Infinity arrive as null), or
 * undefined when it isn't a number Mapbox could add.
 */
function jsonNumberOr0(v: unknown): number | undefined {
  if (v === undefined || v === null) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  return undefined
}

/** `['coalesce', ['get', 'opacityBucket'], 100]` after the JSON round trip; undefined for a non-number. */
function jsonBucket(v: unknown): number | undefined {
  if (v === undefined || v === null) return 100
  if (typeof v === 'number') return Number.isFinite(v) ? v : 100
  return undefined
}

/** One label point per cell — the pre-split `labelPointData` logic, verbatim. */
function labelFeatureOf(f: GridCell): GeoJSON.Feature<GeoJSON.Point> | null {
  const props = (f.properties ?? {}) as GridCellProps
  // Default true when the property is missing so old rows keep
  // painting labels (same semantics as the layer's coalesce).
  const show = (props as { showLabels?: boolean }).showLabels
  if (show === false) return null
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
  return {
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
  }
}

/** Border LineStrings of the preview cells — the pre-split `lineData` logic. */
function previewLineFeatures(cells: ReadonlyArray<GridCell>): GeoJSON.Feature<GeoJSON.LineString>[] {
  return cells.map((f) => ({
    type: 'Feature',
    properties: f.properties as GeoJSON.GeoJsonProperties,
    geometry: { type: 'LineString', coordinates: f.geometry.coordinates[0] },
  }))
}

/**
 * Split one grid's cells into the per-source features (see
 * `GridRenderParts`). `overrides` is the style-rule map; a cell's entry
 * is looked up under `${gridId}-${row}-${col}-${level}` and applied
 * BEFORE routing, so an elevation / height rule can move a cell between
 * the flat and extruded sources and an opacity rule between buckets.
 */
export function buildGridRenderParts(
  gridId: number,
  cells: ReadonlyArray<GridCell>,
  rings: ReadonlyArray<GeoJSON.Position[]>,
  overrides: ReadonlyMap<string, { style: CellStyleOverride }> | null | undefined,
): GridRenderParts {
  const parts: GridRenderParts = {
    flat: [],
    extrude: [],
    line: [],
    labels: [],
    buckets: [],
    cells: [],
    rings: rings as GeoJSON.Position[][],
  }
  const buckets = new Set<number>()
  for (let i = 0; i < cells.length; i++) {
    const base = cells[i]
    let cell = base
    if (overrides) {
      const override = overrides.get(
        `${gridId}-${base.properties.row}-${base.properties.col}-${base.properties.level ?? 0}`,
      )
      if (override) cell = applyCellStyleOverride(base, override.style)
    }
    parts.cells.push(cell)
    const p = cell.properties
    const ring = rings[i]
    const e = jsonNumberOr0(p.elevation)
    const h = jsonNumberOr0(p.height)
    const known = e !== undefined && h !== undefined
    const top = known ? e + h : NaN
    if (!known || top <= 0) {
      parts.flat.push({
        type: 'Feature',
        // Keep the generator's `feature.id` (= gridId, or the preview
        // sentinel): queryRenderedFeatures de-duplicates by it, so a box
        // or point query returns one hit per grid per tile as before,
        // not one per cell (30k at stadium scale).
        ...(cell.id !== undefined ? { id: cell.id } : {}),
        properties: {
          gridId: p.gridId,
          row: p.row,
          col: p.col,
          level: p.level,
          elevation: p.elevation,
          height: p.height,
          color: p.color,
          opacity: p.opacity,
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
    }
    if (!known || top > 0) {
      parts.extrude.push({
        type: 'Feature',
        ...(cell.id !== undefined ? { id: cell.id } : {}),
        properties: {
          gridId: p.gridId,
          row: p.row,
          col: p.col,
          level: p.level,
          elevation: p.elevation,
          height: p.height,
          color: p.color,
          opacityBucket: p.opacityBucket,
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
      const b = jsonBucket(p.opacityBucket)
      if (b !== undefined && (OPACITY_BUCKETS as readonly number[]).includes(b)) buckets.add(b === 0 ? 0 : b)
    }
    // A zero-width border draws nothing (Mapbox's line shader collapses a
    // zero half-width to no geometry), so it isn't shipped at all.
    if (p.borderWidth !== 0) {
      parts.line.push({
        type: 'Feature',
        // No `id` here: the old line source was built without one, so its
        // queryRenderedFeatures results stay per cell, exactly as before.
        properties: {
          gridId: p.gridId,
          row: p.row,
          col: p.col,
          level: p.level,
          elevation: p.elevation,
          height: p.height,
          borderColor: p.borderColor,
          borderWidth: p.borderWidth,
        },
        geometry: { type: 'LineString', coordinates: ring },
      })
    }
    const label = labelFeatureOf(cell)
    if (label) parts.labels.push(label)
  }
  parts.buckets = [...buckets].sort((a, b) => a - b)
  return parts
}

/** Selection-outline features of one grid's parts (built on first use). */
const selectionFeatureCache = new WeakMap<GridRenderParts, GeoJSON.Feature<GeoJSON.LineString>[]>()
function selectionFeaturesOf(parts: GridRenderParts): GeoJSON.Feature<GeoJSON.LineString>[] {
  let out = selectionFeatureCache.get(parts)
  if (out) return out
  out = []
  for (let i = 0; i < parts.cells.length; i++) {
    const p = parts.cells[i].properties
    if (p?.gridId === undefined) continue
    // Carry `elevation`/`height` through to the selection feature so
    // the layer's `line-z-offset` expression can read them. Without
    // these, the yellow outline always sits on the ground (z = 0.1)
    // even when the underlying grid is extruded.
    out.push({
      type: 'Feature',
      properties: { gridId: p.gridId, elevation: p.elevation ?? 0, height: p.height ?? 0 },
      geometry: { type: 'LineString', coordinates: parts.rings[i] },
    })
  }
  selectionFeatureCache.set(parts, out)
  return out
}

/** Selection-tint features of one grid's parts (built on first use). */
const tintFeatureCache = new WeakMap<GridRenderParts, GeoJSON.Feature<GeoJSON.Polygon>[]>()
function tintFeaturesOf(parts: GridRenderParts): GeoJSON.Feature<GeoJSON.Polygon>[] {
  let out = tintFeatureCache.get(parts)
  if (out) return out
  out = []
  for (let i = 0; i < parts.cells.length; i++) {
    const p = parts.cells[i].properties
    if (p?.gridId === undefined) continue
    out.push({
      type: 'Feature',
      properties: { gridId: p.gridId, row: p.row, col: p.col, level: p.level, elevation: p.elevation, height: p.height },
      geometry: { type: 'Polygon', coordinates: [parts.rings[i]] },
    })
  }
  tintFeatureCache.set(parts, out)
  return out
}

/**
 * A committed grid's tessellation and everything derived from it. Lives
 * as long as its config object (WeakMap key) — the store keeps an
 * unchanged grid's config the same object, so toggling floors, editing
 * another grid or re-rendering never re-tessellates it.
 */
interface GridEntry {
  start: [number, number]
  current: [number, number]
  cfg: GridConfig
  cells: GridCell[]
  base: GridRenderParts
  /** Parts with the last style-rule stamp applied, keyed by its signature. */
  stamped: { sig: string; parts: GridRenderParts } | null
  /** Basemap clip footprint features (built on first use). */
  clip?: GeoJSON.Feature<GeoJSON.Polygon>[]
}

/** config object → grid id → entry (one config object can serve several grids). */
const gridEntries = new WeakMap<GridConfig, Map<number, GridEntry>>()

function gridEntryFor(id: number, start: [number, number], current: [number, number], cfg: GridConfig): GridEntry {
  let byId = gridEntries.get(cfg)
  const hit = byId?.get(id)
  if (hit && hit.start === start && hit.current === current) return hit
  const { cells } = buildGridFromLine(start, current, cfg, { committed: true, gridId: id })
  // Stacked levels share one ring array; compact each distinct ring once.
  const compacted = new Map<GeoJSON.Position[], GeoJSON.Position[]>()
  const rings = cells.map((c) => {
    const ring = c.geometry.coordinates[0]
    let out = compacted.get(ring)
    if (!out) {
      out = compactRing(ring as [number, number][], RING_COMPACT_EPS_M)
      compacted.set(ring, out)
    }
    return out
  })
  const entry: GridEntry = {
    start,
    current,
    cfg,
    cells,
    base: buildGridRenderParts(id, cells, rings, null),
    stamped: null,
  }
  if (!byId) {
    byId = new Map()
    gridEntries.set(cfg, byId)
  }
  byId.set(id, entry)
  return entry
}

/**
 * (row, col, level) → cell, per tessellation (built on first use). A key
 * shared by several cells maps to null: triangle grids split each square
 * into an A and a B triangle with the same row / col / level, so the key
 * alone can't say which one is under the cursor.
 */
const cellIndexCache = new WeakMap<GridCell[], Map<string, GridCell | null>>()

/**
 * The full-precision ring of one committed cell, as this overlay last
 * tessellated its grid — null when it hasn't (nothing is built here), or
 * when (row, col, level) doesn't name exactly one cell (triangle grids),
 * so the caller keeps the rendered feature's own geometry.
 * For code that starts from a rendered cell feature (the bin overlay's
 * hover outline): `queryRenderedFeatures` hands back the cell's tile copy
 * (quantised, clipped at the tile buffer, compacted); this is the cell.
 */
export function committedCellRing(
  line: Pick<CommittedLine, 'id' | 'start' | 'current' | 'config'>,
  row: number,
  col: number,
  level: number,
): GeoJSON.Position[] | null {
  const entry = gridEntries.get(line.config)?.get(line.id)
  if (!entry || entry.start !== line.start || entry.current !== line.current) return null
  let index = cellIndexCache.get(entry.cells)
  if (!index) {
    index = new Map()
    for (const c of entry.cells) {
      const key = `${c.properties.row}-${c.properties.col}-${c.properties.level ?? 0}`
      index.set(key, index.has(key) ? null : c)
    }
    cellIndexCache.set(entry.cells, index)
  }
  return index.get(`${row}-${col}-${level}`)?.geometry.coordinates[0] ?? null
}

/** The entry's parts under the current style-rule overrides (`sig` = that grid's override signature). */
function partsFor(
  id: number,
  entry: GridEntry,
  overrides: ReadonlyMap<string, { style: CellStyleOverride }> | null,
  sig: string | undefined,
): GridRenderParts {
  if (!overrides || sig === undefined) return entry.base
  if (entry.stamped?.sig === sig) return entry.stamped.parts
  const parts = buildGridRenderParts(id, entry.cells, entry.base.rings, overrides)
  entry.stamped = { sig, parts }
  return parts
}

/** Lazily built clip-footprint features for a tessellation. */
function clipFeaturesFor(
  start: [number, number],
  current: [number, number],
  cfg: GridConfig,
  cells: ReadonlyArray<GridCell>,
): GeoJSON.Feature<GeoJSON.Polygon>[] {
  return gridClipRings(start, current, cfg, cells).map((ring) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring] },
  }))
}

/** Exact text of one override field, so equal styles give equal signatures (and null ≠ undefined ≠ NaN). */
function sigValue(v: unknown): string {
  if (v === undefined) return 'u'
  if (v === null) return 'z'
  if (typeof v === 'number') return `n${Object.is(v, -0) ? '-0' : String(v)}`
  if (typeof v === 'string') return `s${JSON.stringify(v)}`
  return `o${JSON.stringify(v)}`
}

/**
 * Per grid (keyed by the `gridId` prefix of the override key), a string
 * that changes exactly when that grid's overrides change in value. The
 * resolver hands out a new Map on every resolve; the signature is what
 * lets an unchanged grid keep its stamped parts — and its sources skip
 * the setData.
 */
function overrideSignatures(
  overrides: ReadonlyMap<string, { style: CellStyleOverride }> | null | undefined,
): Map<string, string> {
  const parts = new Map<string, string[]>()
  if (!overrides) return new Map()
  for (const [key, value] of overrides) {
    // The gridId is everything before the first '-' after position 0.
    const dash = key.indexOf('-', 1)
    const gid = dash === -1 ? key : key.slice(0, dash)
    const s = value?.style ?? {}
    let list = parts.get(gid)
    if (!list) {
      list = []
      parts.set(gid, list)
    }
    list.push(
      `${key}|${sigValue(s.fillColor)}|${sigValue(s.fillOpacity)}|${sigValue(s.borderColor)}|${sigValue(s.borderWidth)}|${sigValue(s.elevation)}|${sigValue(s.height)}|${sigValue(s.labelColor)}|${sigValue(s.labelText)}`,
    )
  }
  const out = new Map<string, string>()
  for (const [gid, list] of parts) out.set(gid, list.join('\n'))
  return out
}

/**
 * Concatenate per-grid feature lists into one FeatureCollection, handing
 * back the PREVIOUS collection when the lists are the same arrays in the
 * same order — so a re-render that changed nothing a source holds (a new
 * `committedLines` array, a new override Map with equal values) costs no
 * setData. `slot` remembers the last call (a ref the caller owns).
 */
export type CollectionSlot<G extends GeoJSON.Geometry> = {
  lists: ReadonlyArray<ReadonlyArray<GeoJSON.Feature<G>>>
  fc: FeatureCollection<G>
} | null

export function stableCollection<G extends GeoJSON.Geometry>(
  slot: { current: CollectionSlot<G> },
  lists: ReadonlyArray<ReadonlyArray<GeoJSON.Feature<G>>>,
): FeatureCollection<G> {
  const prev = slot.current
  if (prev && prev.lists.length === lists.length && prev.lists.every((l, i) => l === lists[i])) return prev.fc
  const features: GeoJSON.Feature<G>[] = []
  for (const list of lists) for (const f of list) features.push(f)
  const fc: FeatureCollection<G> = { type: 'FeatureCollection', features }
  slot.current = { lists, fc }
  return fc
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Push `data` into one of the overlay's GeoJSON sources whenever the
 * collection object changes (empty when null). `styleGen` re-pushes into
 * the fresh source a basemap swap's setup pass re-creates.
 */
function useSourceData(
  map: MapboxMapInstance | null,
  styleLoaded: boolean,
  styleGen: number,
  sourceId: string,
  data: GeoJSON.FeatureCollection | null,
) {
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(sourceId) as GeoJSONSource | undefined
    src?.setData(data ?? EMPTY_FC)
  }, [map, styleLoaded, styleGen, sourceId, data])
}

// ---- Focus plan ------------------------------------------------------------------

/** One committed grid as the focus plan sees it (a `committedGrids` entry). */
export interface GridFocusInput {
  id: number
  cfg: GridConfig
  parts: GridRenderParts
}

/**
 * What focus mode wants the grid layers to show. Rebuilt in render (cheap:
 * one tier per grid, cached per-grid lists and splits), written by
 * `syncGridFocus`.
 */
export interface GridFocusPlan {
  /** focusKey of the scene; '' = focus off. */
  key: string
  /** Grids lifted out of the bucket layers — the near sections and the blockers (twins draw them). */
  lifted: ReadonlySet<number>
  /** `lifted`, sorted and joined. */
  liftedKey: string
  /** FOCUS_GHOST_SOURCE content: the blockers' fading cells (null = empty). */
  ghost: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  /**
   * FOCUS_NEAR_SOURCE content: the near-tier fading cells of EVERY section
   * of the NEAR column, blockers included, so it changes only with the
   * focus (null = empty).
   */
  near: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  /** Near sections that are blockers right now: hidden on the near twin (the ghost / rest twins draw them). */
  nearHidden: ReadonlySet<number>
  /** FOCUS_REST_SOURCE content: the cells of lifted 'cells' sections that don't fade (null = empty). */
  rest: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  /** FOCUS_REST_LAYER's constant opacity, 0–1 (the rest cells' one bucket). */
  restOpacity: number
  /** FOCUS_TWIN_SOURCE content: the focused bin, when its section is lifted (null = empty). */
  focus: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  /** FOCUS_TWIN_LAYER's constant opacity, 0–1 (the focused cells' own bucket). */
  focusOpacity: number
  /** gridId → `focusScale` for flat cells (factors ≠ 1 only). */
  flatScale: ReadonlyMap<number, number>
}

const NO_GRID_IDS: ReadonlySet<number> = new Set()
const NO_FLAT_SCALES: ReadonlyMap<number, number> = new Map()
const NO_LABEL_IDS: readonly number[] = []
const NO_CELL_KEYS: ReadonlySet<string> = new Set()

export const GRID_FOCUS_OFF: GridFocusPlan = Object.freeze({
  key: '',
  lifted: NO_GRID_IDS,
  liftedKey: '',
  ghost: null,
  near: null,
  nearHidden: NO_GRID_IDS,
  rest: null,
  restOpacity: 1,
  focus: null,
  focusOpacity: 1,
  flatScale: NO_FLAT_SCALES,
})

/** stableCollection slots for the four twin sources (refs the component owns). */
export interface GridFocusSlots {
  ghost: { current: CollectionSlot<GeoJSON.Polygon> }
  near: { current: CollectionSlot<GeoJSON.Polygon> }
  rest: { current: CollectionSlot<GeoJSON.Polygon> }
  focus: { current: CollectionSlot<GeoJSON.Polygon> }
}

type CellFeature = GeoJSON.Feature<GeoJSON.Polygon>

/**
 * The extruded cells a twin may redraw: bucket 0 (an invisible, hit-only
 * cell) and cells whose bucket routes to no layer are left out, since a
 * twin has no bucket filter. The parts' own array when nothing is left out.
 */
const twinFeatureCache = new WeakMap<GridRenderParts, CellFeature[]>()
function twinFeaturesOf(parts: GridRenderParts): CellFeature[] {
  let out = twinFeatureCache.get(parts)
  if (out) return out
  const kept = parts.extrude.filter((f) => {
    const b = jsonBucket(f.properties?.opacityBucket)
    return b !== undefined && b > 0 && (OPACITY_BUCKETS as readonly number[]).includes(b)
  })
  out = kept.length === parts.extrude.length ? parts.extrude : kept
  twinFeatureCache.set(parts, out)
  return out
}

/**
 * A list split into the focused bin's cells and the rest, cached per list
 * and bin. Triangle grids give two cells (A and B share row / col / level),
 * and both are kept — the key alone can't say which one was meant.
 */
const cellSplitCache = new WeakMap<readonly CellFeature[], Map<string, { cell: CellFeature[]; rest: CellFeature[] }>>()
function splitFocusedCell(list: readonly CellFeature[], cell: FocusCell): { cell: CellFeature[]; rest: CellFeature[] } {
  const key = `${cell.row}:${cell.col}:${cell.level}`
  let byKey = cellSplitCache.get(list)
  const hit = byKey?.get(key)
  if (hit) return hit
  const inCell: CellFeature[] = []
  const rest: CellFeature[] = []
  for (const f of list) {
    const p = f.properties as { row?: unknown; col?: unknown; level?: unknown } | null
    if (p && p.row === cell.row && p.col === cell.col && (p.level ?? 0) === cell.level) inCell.push(f)
    else rest.push(f)
  }
  const out = { cell: inCell, rest: inCell.length === 0 ? (list as CellFeature[]) : rest }
  if (!byKey) {
    byKey = new Map()
    cellSplitCache.set(list, byKey)
  }
  byKey.set(key, out)
  return out
}

/** The bucket most of `list` routes to (ties: the first seen) — the focus twin's one constant. */
const modeBucketCache = new WeakMap<readonly CellFeature[], number>()
function modeBucketOf(list: readonly CellFeature[]): number {
  const hit = modeBucketCache.get(list)
  if (hit !== undefined) return hit
  const counts = new Map<number, number>()
  let best = 100
  let bestN = 0
  for (const f of list) {
    const b = jsonBucket(f.properties?.opacityBucket) ?? 100
    const n = (counts.get(b) ?? 0) + 1
    counts.set(b, n)
    if (n > bestN) {
      best = b
      bestN = n
    }
  }
  modeBucketCache.set(list, best)
  return best
}

// ---- Focus: cell scoping -------------------------------------------------------

const METERS_PER_DEG = 111_320

/** A committed grid's extent as `gridCutPlan` reads it. */
export interface GridCutStats {
  /** [w, s, e, n] over every cell vertex. */
  bbox: [number, number, number, number]
  /** Footprint area, m² — the cells of the lowest level (stacked levels share one footprint). */
  areaM2: number
}

/**
 * bbox and footprint area of a grid's cells, cached per cells array. Both
 * overlays pass cells of the same generator call (`buildGridFromLine`), so
 * they get the same numbers — and so the same 'whole' / 'cells' mode.
 */
const cutStatsCache = new WeakMap<ReadonlyArray<GridCell>, GridCutStats>()
export function gridCutStatsOf(cells: ReadonlyArray<GridCell>): GridCutStats {
  const hit = cutStatsCache.get(cells)
  if (hit) return hit
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  let minLevel = Infinity
  for (const c of cells) {
    const level = c.properties?.level ?? 0
    if (level < minLevel) minLevel = level
    for (const v of c.geometry.coordinates[0] ?? []) {
      const x = v[0]
      const y = v[1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < w) w = x
      if (x > e) e = x
      if (y < s) s = y
      if (y > n) n = y
    }
  }
  let areaM2 = 0
  for (const c of cells) {
    if ((c.properties?.level ?? 0) !== minLevel) continue
    const ring = c.geometry.coordinates[0]
    if (!ring || ring.length < 3) continue
    const kx = Math.cos((ring[0][1] * Math.PI) / 180) * METERS_PER_DEG
    let a = 0
    for (let p = 0, q = ring.length - 1; p < ring.length; q = p++) {
      a += (ring[q][0] - ring[0][0]) * kx * ((ring[p][1] - ring[0][1]) * METERS_PER_DEG)
      a -= (ring[p][0] - ring[0][0]) * kx * ((ring[q][1] - ring[0][1]) * METERS_PER_DEG)
    }
    if (Number.isFinite(a)) areaM2 += Math.abs(a / 2)
  }
  const out: GridCutStats = { bbox: [w, s, e, n], areaM2 }
  cutStatsCache.set(cells, out)
  return out
}

/**
 * Area centroid of a cell ring, [lng, lat] (the vertex mean for a
 * degenerate ring), cached per ring array — stacked levels share theirs.
 * The twin cells (compacted rings) and the bin tints (full-precision
 * rings) land within the compaction tolerance of each other.
 */
const centroidCache = new WeakMap<GeoJSON.Position[], readonly [number, number]>()
export function cellRingCentroid(ring: GeoJSON.Position[]): readonly [number, number] {
  const hit = centroidCache.get(ring)
  if (hit) return hit
  let count = ring.length
  if (count > 1 && ring[0][0] === ring[count - 1][0] && ring[0][1] === ring[count - 1][1]) count--
  let out: readonly [number, number] = [NaN, NaN]
  if (count > 0) {
    const ox = ring[0][0]
    const oy = ring[0][1]
    let a2 = 0
    let cx = 0
    let cy = 0
    let mx = 0
    let my = 0
    for (let i = 0; i < count; i++) {
      const x0 = ring[i][0] - ox
      const y0 = ring[i][1] - oy
      const j = i + 1 === count ? 0 : i + 1
      const x1 = ring[j][0] - ox
      const y1 = ring[j][1] - oy
      const cross = x0 * y1 - x1 * y0
      a2 += cross
      cx += (x0 + x1) * cross
      cy += (y0 + y1) * cross
      mx += x0
      my += y0
    }
    out = Math.abs(a2) > 1e-18 ? [ox + cx / (3 * a2), oy + cy / (3 * a2)] : [ox + mx / count, oy + my / count]
  }
  centroidCache.set(ring, out)
  return out
}

/** The NEAR-column key of one cell (`scene.near.gridCells` / `blockers.gridCells`). */
function cellKeyOf(gridId: number, row: number, col: number, level: number): string {
  return `${gridId}:${row}:${col}:${level}`
}

/** How one near / blocker section fades, cell by cell. */
export interface GridCellRule {
  plan: GridCutPlan
  /**
   * Does this cell fade? `plan.fades`, plus — for a 'cells' blocker — its
   * exact blocking cells (`blockers.gridCells`). Always true in 'whole' mode.
   */
  fades(row: number, col: number, level: number, lng: number, lat: number): boolean
}

const ruleCache = new WeakMap<GridCutPlan, WeakMap<ReadonlySet<string>, GridCellRule>>()

/**
 * The cell rule of grid `gridId` (null for a 'normal' or 'focus' grid).
 * `cells` are its tessellated cells (for the extent). The same object for
 * the same plan and blocking cells — a safe cache key.
 */
export function gridCellRule(
  scene: FocusScene,
  blockers: FocusBlockers,
  gridId: number,
  cells: ReadonlyArray<GridCell>,
): GridCellRule | null {
  const tier = focusTier(scene, blockers, 'grids', gridId)
  if (tier !== 'near' && tier !== 'ghost') return null
  const stats = gridCutStatsOf(cells)
  const plan = gridCutPlan(scene, blockers, gridId, stats.bbox, stats.areaM2)
  if (!plan) return null
  const blocking = plan.tier === 'ghost' && plan.mode === 'cells' ? blockers.gridCells ?? NO_CELL_KEYS : NO_CELL_KEYS
  let byCells = ruleCache.get(plan)
  const hit = byCells?.get(blocking)
  if (hit) return hit
  const rule: GridCellRule = Object.freeze({
    plan,
    fades(row: number, col: number, level: number, lng: number, lat: number): boolean {
      if (plan.fades(row, col, level, lng, lat)) return true
      return blocking.size > 0 && blocking.has(cellKeyOf(gridId, row, col, level))
    },
  })
  if (!byCells) {
    byCells = new WeakMap()
    ruleCache.set(plan, byCells)
  }
  byCells.set(blocking, rule)
  return rule
}

/** A section's twin cells split by a rule. */
interface RuleSplit {
  fade: CellFeature[]
  rest: CellFeature[]
  /** The one bucket every rest cell routes to; -1 = mixed; null = no rest cells. */
  restBucket: number | null
}

const ruleSplitCache = new WeakMap<readonly CellFeature[], WeakMap<GridCellRule, RuleSplit>>()

/** `list` split into the cells `rule` fades and the rest, cached per (list, rule). */
function splitByRule(list: readonly CellFeature[], rule: GridCellRule): RuleSplit {
  let byRule = ruleSplitCache.get(list)
  const hit = byRule?.get(rule)
  if (hit) return hit
  const fade: CellFeature[] = []
  const rest: CellFeature[] = []
  let restBucket: number | null = null
  for (const f of list) {
    const p = f.properties as { row?: unknown; col?: unknown; level?: unknown; opacityBucket?: unknown } | null
    const row = typeof p?.row === 'number' ? p.row : NaN
    const col = typeof p?.col === 'number' ? p.col : NaN
    const level = typeof p?.level === 'number' ? p.level : 0
    const c = cellRingCentroid(f.geometry.coordinates[0])
    if (rule.fades(row, col, level, c[0], c[1])) {
      fade.push(f)
      continue
    }
    rest.push(f)
    const b = jsonBucket(p?.opacityBucket) ?? 100
    restBucket = restBucket === null ? b : restBucket === b ? b : -1
  }
  const out: RuleSplit = { fade, rest, restBucket }
  if (!byRule) {
    byRule = new WeakMap()
    ruleSplitCache.set(list, byRule)
  }
  byRule.set(rule, out)
  return out
}

/** The bucket most rest cells route to over uniform splits (ties: the first seen); null when none. */
function restModeBucket(splits: readonly RuleSplit[]): number | null {
  const counts = new Map<number, number>()
  let best: number | null = null
  let bestN = 0
  for (const sp of splits) {
    if (sp.restBucket === null || sp.restBucket < 0) continue
    const n = (counts.get(sp.restBucket) ?? 0) + sp.rest.length
    counts.set(sp.restBucket, n)
    if (n > bestN) {
      best = sp.restBucket
      bestN = n
    }
  }
  return best
}

/**
 * `blockers` reduced to what the grid focus reads — the grid set, the grid
 * pierce discs and the blocking cells — so a change of another kind's
 * blockers hands back the same object (a safe memo dep).
 */
const gridOnlyBlockers = new WeakMap<
  ReadonlySet<number>,
  WeakMap<ReadonlyMap<number, FocusDiscs>, WeakMap<ReadonlySet<string>, FocusBlockers>>
>()
export function gridBlockersOf(blockers: FocusBlockers): FocusBlockers {
  const grids = blockers.grids
  if (grids.size === 0) return NO_BLOCKERS
  const pierce = blockerPierceOf(blockers, 'grids')
  const cells = blockers.gridCells ?? NO_CELL_KEYS
  let byPierce = gridOnlyBlockers.get(grids)
  if (!byPierce) {
    byPierce = new WeakMap()
    gridOnlyBlockers.set(grids, byPierce)
  }
  let byCells = byPierce.get(pierce)
  if (!byCells) {
    byCells = new WeakMap()
    byPierce.set(pierce, byCells)
  }
  let out = byCells.get(cells)
  if (!out) {
    out = Object.freeze({ ...NO_BLOCKERS, key: 'grids', grids, gridCells: cells, pierce: { ...NO_PIERCE, grids: pierce } })
    byCells.set(cells, out)
  }
  return out
}

/**
 * Per focus: the NEAR sections drawn cell-scoped and the rest twin's
 * bucket. Depends only on the scene and the grids, never on the blockers,
 * so the near twin and the near labels change only with the focus.
 */
export interface GridNearCuts {
  /** Near sections drawn cell-scoped: gridId → near-tier rule (near twin, rest twin, labels). */
  cells: ReadonlyMap<number, GridCellRule>
  /** The rest twin's bucket, chosen from those sections' rest cells; null when none has any. */
  restBucket: number | null
}

export const GRID_NO_NEAR_CUTS: GridNearCuts = Object.freeze({ cells: new Map(), restBucket: null })

export interface GridFocusOptions {
  visible: boolean
  excludeId: number | null
  liftable: boolean
}

/**
 * The near sections in 'cells' mode. Twin-drawn ones keep it only when
 * their rest cells all route to `restBucket` (the mode bucket over every
 * such section's rest cells); the others fall back to 'whole'. A section
 * with no twin (flat-only, lifting unsupported, grids hidden) keeps 'cells'
 * for its labels.
 */
export function buildGridNearCuts(
  scene: FocusScene,
  grids: readonly GridFocusInput[],
  opts: GridFocusOptions,
): GridNearCuts {
  if (!scene.active) return GRID_NO_NEAR_CUTS
  const nearGrids = nearIdsOf(scene.near, 'grids')
  if (nearGrids.size === 0) return GRID_NO_NEAR_CUTS
  const cell = focusedCellOf(scene)
  const cells = new Map<number, GridCellRule>()
  const candidates: { id: number; rule: GridCellRule; split: RuleSplit }[] = []
  for (const g of grids) {
    if (g.id === opts.excludeId || !nearGrids.has(g.id)) continue
    // The near-tier rule, whatever the blockers say right now.
    const rule = gridCellRule(scene, NO_BLOCKERS, g.id, g.parts.cells)
    if (!rule || rule.plan.mode !== 'cells') continue
    const drawn = opts.liftable && opts.visible ? twinFeaturesOf(g.parts) : null
    if (!drawn || drawn.length === 0) {
      cells.set(g.id, rule)
      continue
    }
    const list = cell !== null && cell.gridId === g.id ? splitFocusedCell(drawn, cell).rest : drawn
    candidates.push({ id: g.id, rule, split: splitByRule(list, rule) })
  }
  const restBucket = restModeBucket(candidates.map((c) => c.split))
  for (const c of candidates) {
    if (c.split.restBucket === null || c.split.restBucket === restBucket) cells.set(c.id, c.rule)
  }
  if (cells.size === 0 && restBucket === null) return GRID_NO_NEAR_CUTS
  return { cells, restBucket }
}

/**
 * The plan for one focus scene. Per grid, `focusTier(scene, blockers,
 * 'grids', id)`:
 *  - 'ghost' (a blocker) and 'near' (in the NEAR column): lifted out of
 *    the bucket layers and redrawn by the twins — whole, or in 'cells'
 *    mode only the fading cells on the ghost / near twin and the rest on
 *    the rest twin;
 *  - 'focus' (the focused rack) and 'normal': left in their buckets,
 *    exactly as drawn with focus off.
 * The near twin holds every near section's near-tier fading cells
 * whatever its tier (`nearCuts`), so it changes only with the focus; a
 * near section that is a blocker right now is in `nearHidden` (hidden on
 * the near twin, drawn by the ghost and rest twins). A blocker in 'cells'
 * mode whose rest cells don't all route to the rest twin's bucket — and a
 * near section `nearCuts` drew whole — fades whole.
 * A focused bin is split out of its lifted section onto the focus twin at
 * its own opacity; a bin whose section is not lifted needs nothing.
 * Flat cells take the tier's factor through `focusScale` per section,
 * except the focused bin's own grid (a flat bin can't leave its layer).
 * `blockers` must be `gridBlockersOf(...)` (or any FocusBlockers).
 */
export function buildGridFocusPlan(
  scene: FocusScene,
  blockers: FocusBlockers,
  grids: readonly GridFocusInput[],
  nearCuts: GridNearCuts,
  opts: GridFocusOptions & { slots: GridFocusSlots },
): GridFocusPlan {
  if (!scene.active) return GRID_FOCUS_OFF
  const nearGrids = nearIdsOf(scene.near, 'grids')
  const cell = focusedCellOf(scene)
  const lifted = new Set<number>()
  const nearHidden = new Set<number>()
  const ghostLists: (readonly CellFeature[])[] = []
  const nearLists: (readonly CellFeature[])[] = []
  const restLists: (readonly CellFeature[])[] = []
  const ghostCuts: { list: readonly CellFeature[]; split: RuleSplit }[] = []
  let focusList: readonly CellFeature[] | null = null
  const flatScale = new Map<number, number>()
  for (const g of grids) {
    if (g.id === opts.excludeId) continue
    const tier = focusTier(scene, blockers, 'grids', g.id)
    if (tier !== 'ghost' && tier !== 'near') continue
    const ownsCell = cell !== null && cell.gridId === g.id
    if (!ownsCell && g.parts.flat.length > 0) flatScale.set(g.id, FOCUS_FACTOR[tier])
    if (!opts.liftable || !opts.visible) continue
    const drawn = twinFeaturesOf(g.parts)
    if (drawn.length === 0) continue
    let list: readonly CellFeature[] = drawn
    if (ownsCell) {
      const split = splitFocusedCell(drawn, cell)
      list = split.rest
      focusList = split.cell
    }
    lifted.add(g.id)
    const isNear = nearGrids.has(g.id)
    const nearRule = isNear ? nearCuts.cells.get(g.id) : undefined
    const nearSplit = nearRule ? splitByRule(list, nearRule) : null
    if (isNear) nearLists.push(nearSplit ? nearSplit.fade : list)
    if (tier === 'near') {
      if (nearSplit && nearSplit.rest.length > 0) restLists.push(nearSplit.rest)
      continue
    }
    // A blocker.
    if (isNear) nearHidden.add(g.id)
    const rule = isNear && !nearRule ? null : gridCellRule(scene, blockers, g.id, g.parts.cells)
    if (!rule || rule.plan.mode !== 'cells') {
      ghostLists.push(list)
      continue
    }
    ghostCuts.push({ list, split: splitByRule(list, rule) })
  }
  // The rest twin's one bucket: the near sections chose it; without any, the blockers do.
  let restBucket = nearCuts.restBucket
  if (ghostCuts.length > 0) {
    restBucket ??= restModeBucket(ghostCuts.map((c) => c.split))
    for (const c of ghostCuts) {
      if (c.split.restBucket === null) ghostLists.push(c.split.fade)
      else if (c.split.restBucket === restBucket) {
        ghostLists.push(c.split.fade)
        restLists.push(c.split.rest)
      } else ghostLists.push(c.list)
    }
  }
  const ghost = ghostLists.length > 0 ? stableCollection<GeoJSON.Polygon>(opts.slots.ghost, ghostLists) : null
  const near = nearLists.length > 0 ? stableCollection<GeoJSON.Polygon>(opts.slots.near, nearLists) : null
  const rest = restLists.length > 0 ? stableCollection<GeoJSON.Polygon>(opts.slots.rest, restLists) : null
  const focus = focusList && focusList.length > 0 ? stableCollection<GeoJSON.Polygon>(opts.slots.focus, [focusList]) : null
  const restNonEmpty = rest && rest.features.length > 0 ? rest : null
  return {
    key: scene.key,
    lifted: lifted.size > 0 ? lifted : NO_GRID_IDS,
    liftedKey: [...lifted].sort((a, b) => a - b).join(','),
    ghost: ghost && ghost.features.length > 0 ? ghost : null,
    near: near && near.features.length > 0 ? near : null,
    nearHidden: nearHidden.size > 0 ? nearHidden : NO_GRID_IDS,
    rest: restNonEmpty,
    restOpacity: restNonEmpty && restBucket !== null ? restBucket / 100 : 1,
    focus,
    focusOpacity: focus && focusList ? modeBucketOf(focusList) / 100 : 1,
    flatScale: flatScale.size > 0 ? flatScale : NO_FLAT_SCALES,
  }
}

// ---- Focus: camera settle ----------------------------------------------------------

/** movestart / moveend depth of one map (`trackCameraMotion`). */
export interface CameraMotion {
  /** Moves in progress: > 0 between a movestart and its moveend. */
  depth: number
  /** moveend events seen. */
  ends: number
}

const cameraMotions = new WeakMap<MapboxMapInstance, CameraMotion>()

/**
 * The camera-motion count of `map`, installed on first use (listeners for
 * the map's lifetime). `map.isMoving()` can't tell "settled": it reads
 * false between the frames of a jumpTo- or animation-driven orbit, where
 * each frame is its own movestart → moveend. An unbalanced count (a move
 * torn down without its moveend) heals at the next idle.
 */
export function trackCameraMotion(map: MapboxMapInstance): CameraMotion {
  const hit = cameraMotions.get(map)
  if (hit) return hit
  const motion: CameraMotion = { depth: 0, ends: 0 }
  map.on('movestart', () => {
    motion.depth++
  })
  map.on('moveend', () => {
    motion.depth = Math.max(0, motion.depth - 1)
    motion.ends++
  })
  map.on('idle', () => {
    if (!map.isMoving()) motion.depth = 0
  })
  cameraMotions.set(map, motion)
  return motion
}

/**
 * Run `apply` once at the next camera settle: the next `moveend`, or the
 * next `idle` while no move is in progress — never between a movestart and
 * its moveend. Returns the disarm.
 */
export function onNextCameraSettle(map: MapboxMapInstance, apply: () => void): () => void {
  const motion = trackCameraMotion(map)
  let armed = true
  function disarm(): void {
    if (!armed) return
    armed = false
    map.off('moveend', onEnd)
    map.off('idle', onIdle)
  }
  function onEnd(): void {
    if (!armed) return
    disarm()
    apply()
  }
  function onIdle(): void {
    if (!armed || motion.depth > 0) return
    disarm()
    apply()
  }
  map.on('moveend', onEnd)
  map.on('idle', onIdle)
  // A still map fires no idle until something renders.
  if (motion.depth === 0) map.triggerRepaint()
  return disarm
}

// ---- Focus runtime (what is on the map) ----------------------------------------------

/**
 * Bookkeeping of the focus writes on one map: which grids carry
 * `focusLift` (bucket layers, near twin) / `focusScale` (flat cells), what
 * the twins hold and their paint. Tied to the EXTRUDE_SOURCE object it was
 * written against: a re-created source (style swap, StrictMode re-mount,
 * HMR) resets it, since fresh layers and sources carry none of it.
 */
export interface GridFocusRuntime {
  map: MapboxMapInstance | null
  epoch: unknown
  /** Latest plan (the component sets it; a deferred pass reads it). */
  plan: GridFocusPlan
  /** The plan the twins / lifts on the map belong to. */
  applied: GridFocusPlan
  liftSource: unknown
  /** Grids lifted out of the bucket layers. */
  lifted: Set<number>
  nearLiftSource: unknown
  /** Grids hidden on the near twin. */
  nearLifted: Set<number>
  scaleSource: unknown
  scaled: Map<number, number>
  ghostData: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  nearData: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  restData: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  focusData: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  ghostPaint: number
  nearPaint: number
  restPaint: number
  focusPaint: number
  disarmRender: (() => void) | null
  disarmSettle: (() => void) | null
}

export function createGridFocusRuntime(): GridFocusRuntime {
  return {
    map: null,
    epoch: null,
    plan: GRID_FOCUS_OFF,
    applied: GRID_FOCUS_OFF,
    liftSource: null,
    lifted: new Set(),
    nearLiftSource: null,
    nearLifted: new Set(),
    scaleSource: null,
    scaled: new Map(),
    ghostData: null,
    nearData: null,
    restData: null,
    focusData: null,
    ghostPaint: 1,
    nearPaint: 1,
    restPaint: 1,
    focusPaint: 1,
    disarmRender: null,
    disarmSettle: null,
  }
}

/** Stop listening and forget the map (unmount / map change / a re-created source). */
export function disposeGridFocusRuntime(rt: GridFocusRuntime): void {
  rt.disarmRender?.()
  rt.disarmSettle?.()
  Object.assign(rt, createGridFocusRuntime(), { plan: rt.plan })
}

/** `style.getOwnLayer` (the live layer object) — `map.getLayer` serialises it. */
function ownLayerObject(map: MapboxMapInstance, id: string): unknown {
  const style = (map as unknown as { style?: { getOwnLayer?: (id: string) => unknown } }).style
  if (style && typeof style.getOwnLayer === 'function') {
    try {
      return style.getOwnLayer(id)
    } catch {
      return undefined
    }
  }
  try {
    return map.getLayer(id)
  } catch {
    return undefined
  }
}

/** Root layer ids in root order (`moveLayer`'s order). */
function rootOrder(map: MapboxMapInstance): readonly string[] {
  const order = (map as unknown as { style?: { _order?: unknown } }).style?._order
  if (Array.isArray(order)) return order as string[]
  try {
    return (map.getStyle()?.layers ?? []).map((l) => l.id)
  } catch {
    return []
  }
}

function isTwinLayer(id: string | undefined): boolean {
  return (FOCUS_TWIN_LAYERS as readonly (string | undefined)[]).includes(id)
}

/**
 * Where an idle (opaque) twin lives: directly after `-op100`, before the
 * first non-twin layer that follows it. An opaque 3D layer inserted right
 * after another opaque one leaves the translucent-order pass's verdict on
 * every other layer unchanged — whether or not op100 was the last opaque
 * 3D layer, everything after it is still after the twin.
 */
function twinHomeBefore(map: MapboxMapInstance): string | undefined {
  const order = rootOrder(map)
  const i = order.indexOf(extrudeLayerId(100))
  if (i < 0) return undefined
  let k = i + 1
  while (k < order.length && isTwinLayer(order[k])) k++
  return order[k]
}

/**
 * Put every twin whose paint is opaque again back home (see
 * twinHomeBefore), in install order among the twins already there — so a
 * full exit restores the exact root order the setup pass produced.
 */
function moveTwinsHome(map: MapboxMapInstance, rt: GridFocusRuntime): void {
  const twins: [string, number][] = [
    [FOCUS_TWIN_LAYER, rt.focusPaint],
    [FOCUS_GHOST_LAYER, rt.ghostPaint],
    [FOCUS_NEAR_LAYER, rt.nearPaint],
    [FOCUS_REST_LAYER, rt.restPaint],
  ]
  const rank = (id: string) => (FOCUS_TWIN_LAYERS as readonly string[]).indexOf(id)
  for (const [id, paint] of twins) {
    if (paint < 1 || !ownLayerObject(map, id)) continue
    const order = rootOrder(map)
    const i = order.indexOf(extrudeLayerId(100))
    if (i < 0) return
    let k = i + 1
    let home = false
    let before: string | undefined
    while (k < order.length && isTwinLayer(order[k])) {
      if (order[k] === id) home = true
      else if (before === undefined && rank(order[k]) > rank(id)) before = order[k]
      k++
    }
    if (home) continue
    try {
      map.moveLayer(id, before ?? order[k])
    } catch { /* style torn down */ }
  }
}

function setState(map: MapboxMapInstance, source: string, id: number, state: Record<string, unknown>): void {
  try {
    map.setFeatureState({ source, id }, state)
  } catch { /* source went away */ }
}

function removeState(map: MapboxMapInstance, source: string, id: number, key: string): void {
  try {
    map.removeFeatureState({ source, id }, key)
  } catch { /* source went away */ }
}

function setTwinOpacity(map: MapboxMapInstance, layerId: string, opacity: number): boolean {
  if (!ownLayerObject(map, layerId)) return false
  try {
    map.setPaintProperty(layerId, 'fill-extrusion-opacity', opacity)
    return true
  } catch {
    return false
  }
}

function twinsLoaded(map: MapboxMapInstance): boolean {
  for (const id of FOCUS_TWIN_SOURCES) {
    try {
      if (map.getSource(id) && !map.isSourceLoaded(id)) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Write every lift of the applied plan that isn't written yet: sections
 * out of their bucket layers, and near sections that are blockers out of
 * the near twin (the ghost / rest twins draw them now).
 */
function writeLifts(map: MapboxMapInstance, rt: GridFocusRuntime): void {
  const src = map.getSource(EXTRUDE_SOURCE)
  if (src) {
    if (src !== rt.liftSource) {
      rt.liftSource = src
      rt.lifted = new Set()
    }
    for (const id of rt.applied.lifted) {
      if (rt.lifted.has(id)) continue
      setState(map, EXTRUDE_SOURCE, id, { [FOCUS_LIFT_STATE]: true })
      rt.lifted.add(id)
    }
  }
  const near = map.getSource(FOCUS_NEAR_SOURCE)
  if (near) {
    if (near !== rt.nearLiftSource) {
      rt.nearLiftSource = near
      rt.nearLifted = new Set()
    }
    for (const id of rt.applied.nearHidden) {
      if (rt.nearLifted.has(id)) continue
      setState(map, FOCUS_NEAR_SOURCE, id, { [FOCUS_LIFT_STATE]: true })
      rt.nearLifted.add(id)
    }
  }
}

/**
 * Lift on the first `render` in which every twin source is loaded —
 * `render` fires after `style.update` applied the pending reload, so the
 * twin draws the rack in the same frame its old layer stops drawing it.
 */
function armLift(map: MapboxMapInstance, rt: GridFocusRuntime): void {
  if (rt.disarmRender) return
  const onRender = () => {
    if (!twinsLoaded(map)) return
    map.off('render', onRender)
    rt.disarmRender = null
    writeLifts(map, rt)
  }
  map.on('render', onRender)
  rt.disarmRender = () => map.off('render', onRender)
  map.triggerRepaint()
}

/** setData on a twin source when the plan's collection differs from what it holds. */
function pushTwin(
  map: MapboxMapInstance,
  source: string,
  next: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null,
  held: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null,
): GeoJSON.FeatureCollection<GeoJSON.Polygon> | null {
  if (next !== held) (map.getSource(source) as GeoJSONSource | undefined)?.setData(next ?? EMPTY_FC)
  return next
}

function applyGridFocus(map: MapboxMapInstance, rt: GridFocusRuntime, plan: GridFocusPlan): void {
  // 1. Flat cells.
  const fill = map.getSource(FILL_SOURCE)
  if (fill !== rt.scaleSource) {
    rt.scaleSource = fill
    rt.scaled = new Map()
  }
  if (fill) {
    for (const id of [...rt.scaled.keys()]) {
      if (plan.flatScale.has(id)) continue
      removeState(map, FILL_SOURCE, id, FOCUS_SCALE_STATE)
      rt.scaled.delete(id)
    }
    for (const [id, f] of plan.flatScale) {
      if (rt.scaled.get(id) === f) continue
      setState(map, FILL_SOURCE, id, { [FOCUS_SCALE_STATE]: f })
      rt.scaled.set(id, f)
    }
  }
  // 2. Un-lift first: a rack leaving a twin is drawn again where it goes
  //    (its bucket, or the near twin) before the twin lets go of it — both
  //    draw it for a frame, never neither.
  const extrude = map.getSource(EXTRUDE_SOURCE)
  if (extrude !== rt.liftSource) {
    rt.liftSource = extrude
    rt.lifted = new Set()
  }
  if (extrude) {
    for (const id of [...rt.lifted]) {
      if (plan.lifted.has(id)) continue
      removeState(map, EXTRUDE_SOURCE, id, FOCUS_LIFT_STATE)
      rt.lifted.delete(id)
    }
  }
  const nearSource = map.getSource(FOCUS_NEAR_SOURCE)
  if (nearSource !== rt.nearLiftSource) {
    rt.nearLiftSource = nearSource
    rt.nearLifted = new Set()
  }
  if (nearSource) {
    for (const id of [...rt.nearLifted]) {
      if (plan.nearHidden.has(id)) continue
      removeState(map, FOCUS_NEAR_SOURCE, id, FOCUS_LIFT_STATE)
      rt.nearLifted.delete(id)
    }
  }
  // 3. Twin data, then paint. A twin's paint only goes translucent while
  //    focus is on (the order pass then files it with the translucent
  //    layers) and back to 1 — and home — on exit, so focus off leaves the
  //    root order exactly as it found it.
  rt.ghostData = pushTwin(map, FOCUS_GHOST_SOURCE, plan.ghost, rt.ghostData)
  rt.nearData = pushTwin(map, FOCUS_NEAR_SOURCE, plan.near, rt.nearData)
  rt.restData = pushTwin(map, FOCUS_REST_SOURCE, plan.rest, rt.restData)
  rt.focusData = pushTwin(map, FOCUS_TWIN_SOURCE, plan.focus, rt.focusData)
  const off = plan.key === ''
  const ghostPaint = plan.ghost ? FOCUS_FACTOR.ghost : off ? 1 : rt.ghostPaint
  const nearPaint = plan.near ? FOCUS_FACTOR.near : off ? 1 : rt.nearPaint
  const restPaint = plan.rest ? plan.restOpacity : off ? 1 : rt.restPaint
  const focusPaint = plan.focus ? plan.focusOpacity : off ? 1 : rt.focusPaint
  let goHome = false
  if (ghostPaint !== rt.ghostPaint && setTwinOpacity(map, FOCUS_GHOST_LAYER, ghostPaint)) {
    rt.ghostPaint = ghostPaint
    if (ghostPaint >= 1) goHome = true
  }
  if (nearPaint !== rt.nearPaint && setTwinOpacity(map, FOCUS_NEAR_LAYER, nearPaint)) {
    rt.nearPaint = nearPaint
    if (nearPaint >= 1) goHome = true
  }
  if (restPaint !== rt.restPaint && setTwinOpacity(map, FOCUS_REST_LAYER, restPaint)) {
    rt.restPaint = restPaint
    if (restPaint >= 1) goHome = true
  }
  if (focusPaint !== rt.focusPaint && setTwinOpacity(map, FOCUS_TWIN_LAYER, focusPaint)) {
    rt.focusPaint = focusPaint
    if (focusPaint >= 1) goHome = true
  }
  if (goHome) moveTwinsHome(map, rt)
  rt.applied = plan
  // 4. Lift what the twins now hold, once they have drawn it.
  let pending = false
  for (const id of plan.lifted) {
    if (!rt.lifted.has(id)) {
      pending = true
      break
    }
  }
  if (!pending) {
    for (const id of plan.nearHidden) {
      if (!rt.nearLifted.has(id)) {
        pending = true
        break
      }
    }
  }
  if (pending) armLift(map, rt)
}

function sameIds(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/** Plans that write the same thing (a re-render that changed nothing on the map). */
function sameGridPlan(a: GridFocusPlan, b: GridFocusPlan): boolean {
  if (a.key !== b.key || a.liftedKey !== b.liftedKey) return false
  if (a.ghost !== b.ghost || a.near !== b.near || a.rest !== b.rest || a.focus !== b.focus) return false
  if (a.restOpacity !== b.restOpacity || a.focusOpacity !== b.focusOpacity) return false
  if (!sameIds(a.nearHidden, b.nearHidden) || a.flatScale.size !== b.flatScale.size) return false
  for (const [id, f] of a.flatScale) if (b.flatScale.get(id) !== f) return false
  return true
}

/**
 * Bring the map to `rt.plan`. Entering, leaving and switching focus apply
 * at once, and so does anything during a focus fly (`flyToFocus`:
 * blockers at the destination fade before the camera arrives). Every
 * other change of the same focus — a blocker set that changed at a
 * throttled tick or at moveend, a near section turning into a blocker —
 * waits for the next camera settle (`onNextCameraSettle`: a moveend, or
 * idle outside any move), so the ghost / rest twins are never re-uploaded
 * mid-move. `settled`: called from that settle.
 */
export function syncGridFocus(map: MapboxMapInstance, rt: GridFocusRuntime, settled = false): void {
  const epoch = map.getSource(EXTRUDE_SOURCE) ?? null
  if (rt.map !== map || rt.epoch !== epoch) {
    const plan = rt.plan
    disposeGridFocusRuntime(rt)
    rt.map = map
    rt.epoch = epoch
    rt.plan = plan
  }
  const plan = rt.plan
  const applied = rt.applied
  if (
    !settled &&
    plan !== applied &&
    plan.key !== '' &&
    plan.key === applied.key &&
    !isFocusFlying(map) &&
    !sameGridPlan(plan, applied)
  ) {
    if (!rt.disarmSettle) {
      rt.disarmSettle = onNextCameraSettle(map, () => {
        rt.disarmSettle = null
        if (rt.map === map) syncGridFocus(map, rt, true)
      })
    }
    return
  }
  if (rt.disarmSettle) {
    rt.disarmSettle()
    rt.disarmSettle = null
  }
  applyGridFocus(map, rt, plan)
}

/** The paint value a layer object was last given by `syncLayerPaint`. */
interface LayerPaintRecord {
  layer: unknown
  json: string
}

/** LABEL_LAYER's install-time `text-opacity` (see `labelLayerSpec`). */
const LABEL_OPACITY_INSTALL_JSON = JSON.stringify(gridLabelOpacity(0, focusScaleFactor()))
/** PREVIEW_LABEL_LAYER's install-time `text-opacity` — the pre-focus expression. */
const PREVIEW_LABEL_OPACITY_INSTALL_JSON = JSON.stringify(gridLabelOpacity(0, 1))

/**
 * Set a paint property only when it differs from what this layer OBJECT
 * holds — a re-created layer (style swap, re-mount) starts from its spec
 * value (`installJson`), so it is re-written when it needs to be.
 */
function syncLayerPaint(
  map: MapboxMapInstance,
  layerId: string,
  prop: string,
  value: unknown,
  rec: LayerPaintRecord,
  installJson: string,
): void {
  const layer = ownLayerObject(map, layerId)
  if (!layer) return
  if (rec.layer !== layer) {
    rec.layer = layer
    rec.json = installJson
  }
  const json = JSON.stringify(value)
  if (json === rec.json) return
  try {
    map.setPaintProperty(layerId, prop as never, value as never)
    rec.json = json
  } catch { /* style torn down */ }
}

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

  // The parent builds `transformState` inline on every render, so every
  // effect keys on its three fields instead of the object — otherwise
  // each render while a transform is active re-filters 15 layers,
  // re-tessellates the in-flight grid and re-subscribes the drag.
  const tId = transformState?.gridId ?? null
  const tKind = transformState?.kind ?? null
  const tDraft = transformState?.draft ?? null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableTransform = useMemo(() => transformState, [tId, tKind, tDraft])

  // Whether the current basemap has anything a clip layer can hide
  // (`src/lib/basemap-clip.ts`). Classic styles don't, and a clip layer
  // there is pure per-frame cost, so CLIP_LAYER only exists while true.
  const basemapClip = useBasemapClipNeeded(map)

  // ---- Committed cells ------------------------------------------------
  // Per grid: tessellate once (`gridEntryFor`, cached by config object —
  // survives floor toggles and edits to other grids), split into the
  // per-source parts once, re-stamp style-rule overrides only when that
  // grid's overrides change in value. The moving grid of a transform is
  // NOT drawn from its draft here: the exclusion filter hides it from the
  // committed layers and the in-flight sources draw it.
  const overrideSigs = useMemo(() => overrideSignatures(cellStyleOverrides), [cellStyleOverrides])
  const committedGrids = useMemo(() => {
    const out: { id: number; cfg: GridConfig; entry: GridEntry; parts: GridRenderParts }[] = []
    for (const cl of committedLines ?? []) {
      // Row-level per-rack layer visibility (v14) — the sidebar's eye
      // toggle sets this. Missing/undefined stays visible so older rows
      // that predate the field render as before.
      if (cl.visible === false) continue
      const cfg =
        draftOverride && draftOverride.gridIds.has(cl.id)
          ? draftOverride.config
          : cl.config
      if (cfg?.visible === false) continue
      let entry: GridEntry
      try {
        entry = gridEntryFor(cl.id, cl.start, cl.current, cfg)
      } catch (err) {
        // One bad grid must NOT take down the rest. Log and skip.
        console.warn('[MapGridOverlay] committed grid build failed', err, cl)
        continue
      }
      out.push({
        id: cl.id,
        cfg,
        entry,
        parts: partsFor(cl.id, entry, cellStyleOverrides, overrideSigs.get(String(cl.id))),
      })
    }
    return out
  }, [committedLines, draftOverride, cellStyleOverrides, overrideSigs])

  // One FeatureCollection per source, each kept by identity while its
  // per-grid lists are unchanged — the push effects below only run (and
  // Mapbox only re-serialises and re-tiles) when that source's content
  // actually changed.
  const fillSlot = useRef<CollectionSlot<GeoJSON.Polygon>>(null)
  const extrudeSlot = useRef<CollectionSlot<GeoJSON.Polygon>>(null)
  const lineSlot = useRef<CollectionSlot<GeoJSON.LineString>>(null)
  const labelSlot = useRef<CollectionSlot<GeoJSON.Point>>(null)
  // The slots are memo caches, written idempotently during render (same
  // contract as the old per-grid cell cache: a pure performance cache).
  const fillData = useMemo(
    // eslint-disable-next-line react-hooks/refs
    () => stableCollection<GeoJSON.Polygon>(fillSlot, committedGrids.map((g) => g.parts.flat)),
    [committedGrids],
  )
  const extrudeData = useMemo(
    // eslint-disable-next-line react-hooks/refs
    () => stableCollection<GeoJSON.Polygon>(extrudeSlot, committedGrids.map((g) => g.parts.extrude)),
    [committedGrids],
  )
  const lineData = useMemo(
    // eslint-disable-next-line react-hooks/refs
    () => stableCollection<GeoJSON.LineString>(lineSlot, committedGrids.map((g) => g.parts.line)),
    [committedGrids],
  )
  // Label positions as 2D Point features at the cell centroid (see
  // `labelFeatureOf`) — one per cell, so a multi-level rack shows one
  // label per shelf. Cells whose grid has `showLabels: false` are
  // dropped at the SOURCE level, not just by the layer filter.
  const labelPointData = useMemo(
    // eslint-disable-next-line react-hooks/refs
    () => stableCollection<GeoJSON.Point>(labelSlot, committedGrids.map((g) => g.parts.labels)),
    [committedGrids],
  )
  // Opacity buckets some committed cell routes to — every other bucket
  // layer is hidden (an empty bucket layer still costs a filter pass per
  // feature and an empty bucket per tile in the worker).
  const bucketKey = useMemo(() => {
    const set = new Set<number>()
    for (const g of committedGrids) for (const b of g.parts.buckets) set.add(b)
    return [...set].sort((a, b) => a - b).join(',')
  }, [committedGrids])
  const presentBuckets = useMemo(
    () => new Set(bucketKey === '' ? [] : bucketKey.split(',').map(Number)),
    [bucketKey],
  )
  useEffect(() => {
    if (!import.meta.env.DEV) return
    // Helpful while debugging "cells don't show up" issues. Stripped in prod.
    console.debug(
      `[MapGridOverlay] ${fillData.features.length} flat / ${extrudeData.features.length} extruded committed cells (committed=${committedLines?.length ?? 0})`,
    )
  }, [fillData, extrudeData, committedLines])

  // ---- Live preview ---------------------------------------------------
  // The in-progress draw (`line`, with its leading `future` cell) and the
  // fixed `bbox` grid, stamped from the panel `config`. Their own sources
  // (see PREVIEW_*), so a pointer move re-uploads only these cells. Same
  // features the committed sources used to carry for them.
  const preview = useMemo(() => {
    if (!config.visible) return null
    const lineCells: GridCell[] = []
    if (line) {
      try {
        const result = buildGridFromLine(line.start, line.current, config)
        for (const c of result.cells) {
          // Tag preview cells so the fill/line/extrude layer filters keep
          // them (committed cells are kept by `has gridId`; preview cells
          // have no gridId yet, so they need a separate marker).
          c.properties.preview = true
          lineCells.push(c)
        }
      } catch (err) {
        console.warn('[MapGridOverlay] live preview build failed', err)
      }
    }
    const bboxCells: GridCell[] = []
    if (bbox) {
      try {
        const fc = buildGrid(bbox, config)
        for (const c of fc.features as GridCell[]) bboxCells.push(c)
      } catch (err) {
        console.warn('[MapGridOverlay] bbox build failed', err)
      }
    }
    if (lineCells.length === 0 && bboxCells.length === 0) return null
    const cells = [...lineCells, ...bboxCells]
    // Every preview cell is stamped from `config`, so they share one
    // opacity bucket — the one PREVIEW_EXTRUDE_LAYER is set to.
    let bucket = 100
    for (const c of cells) {
      const b = jsonBucket(c.properties.opacityBucket)
      if (b !== undefined) {
        if ((OPACITY_BUCKETS as readonly number[]).includes(b)) bucket = b === 0 ? 0 : b
        break
      }
    }
    const labels: GeoJSON.Feature<GeoJSON.Point>[] = []
    for (const c of cells) {
      const label = labelFeatureOf(c)
      if (label) labels.push(label)
    }
    return {
      lineStart: line?.start ?? null,
      lineEnd: line?.current ?? null,
      config,
      lineCells,
      bboxCells,
      bucket,
      poly: { type: 'FeatureCollection', features: cells } as FeatureCollection<GeoJSON.Polygon>,
      line: { type: 'FeatureCollection', features: previewLineFeatures(cells) } as FeatureCollection<GeoJSON.LineString>,
      labels: { type: 'FeatureCollection', features: labels } as FeatureCollection<GeoJSON.Point>,
    }
  }, [line, bbox, config])

  // ---- Basemap clip ---------------------------------------------------
  // One footprint per grid (`gridClipRings`) erases the 3D buildings,
  // landmarks and POI symbols of a Standard basemap under the grids. A
  // footprint per CELL made Mapbox re-sort and re-test ~30k replacement
  // regions every frame on a stadium. The grid being transformed clips at
  // its draft geometry, as its cells did when they were drawn from it.
  // (Keyed on the moving grid's config, not `committedGrids`, which a
  // style-rule tick replaces.)
  const transformCfg = stableTransform ? committedGrids.find((x) => x.id === stableTransform.gridId)?.cfg ?? null : null
  const transformClip = useMemo(() => {
    if (!basemapClip || !stableTransform || !transformCfg) return null
    const { draft, gridId } = stableTransform
    const cfg = { ...transformCfg, rotation: draft.rotation }
    try {
      const { cells } = buildGridFromLine(draft.start, draft.current, cfg, { committed: true, gridId })
      return { id: gridId, features: clipFeaturesFor(draft.start, draft.current, cfg, cells) }
    } catch (err) {
      console.warn('[MapGridOverlay] committed grid build failed', err, gridId)
      return { id: gridId, features: [] as GeoJSON.Feature<GeoJSON.Polygon>[] }
    }
  }, [basemapClip, stableTransform, transformCfg])
  const clipData = useMemo<GeoJSON.FeatureCollection<GeoJSON.Polygon> | null>(() => {
    if (!basemapClip) return null
    const features: GeoJSON.Feature<GeoJSON.Polygon>[] = []
    if (preview && preview.lineStart && preview.lineEnd && preview.lineCells.length > 0) {
      features.push(...clipFeaturesFor(preview.lineStart, preview.lineEnd, preview.config, preview.lineCells))
    }
    for (const g of committedGrids) {
      if (transformClip && transformClip.id === g.id) {
        features.push(...transformClip.features)
        continue
      }
      const { entry } = g
      entry.clip ??= clipFeaturesFor(entry.start, entry.current, entry.cfg, entry.cells)
      features.push(...entry.clip)
    }
    for (const cell of preview?.bboxCells ?? []) {
      const ring = cell.geometry.coordinates[0] as [number, number][]
      if (ring.length < 4) continue
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } })
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [basemapClip, preview, committedGrids, transformClip])

  // ---- Selection ------------------------------------------------------
  // Outline cells for the currently selected grid(s). Drawn on top of the
  // regular line layer with a thick high-contrast stroke so the user can
  // see which grid is active.
  const selectionSlot = useRef<CollectionSlot<GeoJSON.LineString>>(null)
  const tintSlot = useRef<CollectionSlot<GeoJSON.Polygon>>(null)
  const selectionData = useMemo<GeoJSON.FeatureCollection<GeoJSON.LineString> | null>(() => {
    if (!selectedGridIds || selectedGridIds.size === 0) return null
    const lists = committedGrids.filter((g) => selectedGridIds.has(g.id)).map((g) => selectionFeaturesOf(g.parts))
    // eslint-disable-next-line react-hooks/refs
    const fc = stableCollection<GeoJSON.LineString>(selectionSlot, lists)
    return fc.features.length > 0 ? fc : null
  }, [committedGrids, selectedGridIds])
  // Whole-grid tint cells of the selection — every cell of the selected
  // grid(s), minus the one being transformed (its in-flight tint mirror
  // draws it at the drag position).
  const tintData = useMemo<GeoJSON.FeatureCollection<GeoJSON.Polygon> | null>(() => {
    if (!selectedGridIds || selectedGridIds.size === 0) return null
    const lists = committedGrids
      .filter((g) => selectedGridIds.has(g.id) && g.id !== tId)
      .map((g) => tintFeaturesOf(g.parts))
    // eslint-disable-next-line react-hooks/refs
    const fc = stableCollection<GeoJSON.Polygon>(tintSlot, lists)
    return fc.features.length > 0 ? fc : null
  }, [committedGrids, selectedGridIds, tId])

  // The draw line's ends as plain values. (A `.current` property read
  // inside a memo looks like a ref read to the React Compiler lint.)
  const lineStart = line?.start ?? null
  const lineEnd = line?.current ?? null
  const bboxLineData = useMemo<GeoJSON.FeatureCollection<GeoJSON.LineString> | null>(() => {
    if (!showBbox) return null
    // Path-layout preview: the guide is the drawn path itself, not a box.
    if (lineStart && lineEnd && isPathGrid(config)) {
      return {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pathGridVertices(lineStart, lineEnd, config.path ?? []) } }],
      }
    }
    // Derive bbox from `line` (live preview) if no explicit bbox is given.
    let b: [number, number, number, number] | null = bbox
    if (!b && lineStart && lineEnd) {
      b = [
        Math.min(lineStart[0], lineEnd[0]),
        Math.min(lineStart[1], lineEnd[1]),
        Math.max(lineStart[0], lineEnd[0]),
        Math.max(lineStart[1], lineEnd[1]),
      ]
    }
    if (!b) return null
    // Rotate the 4 bbox corners by `config.rotation` so the outline matches
    // the (rotated) cell polygons. Cells rotate around the start point
    // (see grid-generators.ts `buildGrid`), so the outline must use the
    // same pivot. For the fixed-`bbox` path (no `line`), pass undefined
    // so `rotatedBboxCorners` falls back to the bbox center.
    const pivot: [number, number] | undefined = lineStart ?? undefined
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
  }, [bbox, lineStart, lineEnd, showBbox, config])

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
        // Cell polygon / border sources hold a slim copy of each cell (see
        // `GridRenderParts`) and a small tile buffer (CELL_SOURCE_BUFFER).
        const cellSource = (id: string) => {
          if (!map.getSource(id)) {
            map.addSource(id, { type: 'geojson', data: EMPTY_FC, buffer: CELL_SOURCE_BUFFER })
          }
        }
        cellSource(FILL_SOURCE)
        cellSource(LINE_SOURCE)
        cellSource(EXTRUDE_SOURCE)
        cellSource(SELECTION_TINT_SOURCE)
        cellSource(PREVIEW_POLY_SOURCE)
        cellSource(PREVIEW_LINE_SOURCE)
        if (!map.getSource(LABEL_SOURCE)) {
          map.addSource(LABEL_SOURCE, {
            type: 'geojson',
            data: EMPTY_FC,
            // Expose `properties.labelId` (packed from gridId/row/col/
            // level) as the feature-state key so the occlusion pass
            // can `setFeatureState({id, occluded})` per-cell without
            // regenerating the label FC on every camera move.
            promoteId: 'labelId',
          })
        }
        if (!map.getSource(PREVIEW_LABEL_SOURCE)) {
          map.addSource(PREVIEW_LABEL_SOURCE, { type: 'geojson', data: EMPTY_FC })
        }
        if (!map.getSource(bboxSourceId)) {
          map.addSource(bboxSourceId, { type: 'geojson', data: EMPTY_FC })
        }
        if (!map.getSource(centerSourceId)) {
          map.addSource(centerSourceId, { type: 'geojson', data: EMPTY_FC })
        }
        if (!map.getSource(selectionSourceId)) {
          map.addSource(selectionSourceId, { type: 'geojson', data: EMPTY_FC, buffer: CELL_SOURCE_BUFFER })
        }
        if (!map.getSource(CLIP_SOURCE)) {
          map.addSource(CLIP_SOURCE, { type: 'geojson', data: EMPTY_FC })
        }

        // Each committed cell layer, then its live-preview twin directly
        // below it (see PREVIEW_* above). Both from the same spec builder.
        const addPair = (
          committed: FillLayerSpecification | FillExtrusionLayerSpecification | LineLayerSpecification | SymbolLayerSpecification,
          twin: FillLayerSpecification | FillExtrusionLayerSpecification | LineLayerSpecification | SymbolLayerSpecification | null,
          twinBefore: string = committed.id,
        ) => {
          if (!map.getLayer(committed.id)) map.addLayer(committed)
          if (twin && !map.getLayer(twin.id)) map.addLayer(twin, map.getLayer(twinBefore) ? twinBefore : undefined)
        }
        addPair(
          focusScaledFillLayerSpec(fillLayerSpec(FILL_LAYER, FILL_SOURCE)),
          fillLayerSpec(PREVIEW_FILL_LAYER, PREVIEW_POLY_SOURCE),
        )
        // One fill-extrusion layer per opacity bucket, each with a
        // CONSTANT `fill-extrusion-opacity`. Added BEFORE LINE_LAYER so
        // the cell borders stay on top (Mapbox doesn't auto-promote
        // elevated lines above 3D geometry — without this order the
        // border vanishes behind extrusion tops at high opacity).
        for (const bucket of OPACITY_BUCKETS) {
          try {
            addPair(liftableExtrudeLayerSpec(bucket), null)
          } catch (err) {
            console.warn('[MapGridOverlay] failed to add extrude bucket', bucket, err)
          }
        }
        // Focus twins (see the "Focus mode" block comment): empty — so the
        // empty-layer gate keeps them hidden — and opaque, directly after
        // -op100, until focus mode fills them. Only where lifting works.
        // The near twin's colour is lift-wrapped too (a near section that
        // is currently a blocker is hidden on it).
        if (LIFTABLE) {
          FOCUS_TWIN_LAYERS.forEach((layerId, i) => {
            cellSource(FOCUS_TWIN_SOURCES[i])
            if (!map.getLayer(layerId)) {
              map.addLayer(
                focusTwinLayerSpec(layerId, FOCUS_TWIN_SOURCES[i], layerId === FOCUS_NEAR_LAYER),
                twinHomeBefore(map),
              )
            }
          })
        }
        // The preview's single extrude layer starts in bucket 100's slot;
        // the preview push effect moves it when the panel opacity changes.
        if (!map.getLayer(PREVIEW_EXTRUDE_LAYER)) {
          map.addLayer(
            extrudeLayerSpec(PREVIEW_EXTRUDE_LAYER, PREVIEW_POLY_SOURCE, 100),
            map.getLayer(extrudeLayerId(100)) ? extrudeLayerId(100) : undefined,
          )
        }
        addPair(lineLayerSpec(LINE_LAYER, LINE_SOURCE, false), lineLayerSpec(PREVIEW_LINE_LAYER, PREVIEW_LINE_SOURCE, true))
        addPair(lineBottomLayerSpec(LINE_BOTTOM_LAYER, LINE_SOURCE), lineBottomLayerSpec(PREVIEW_LINE_BOTTOM_LAYER, PREVIEW_LINE_SOURCE))
        // LABEL_LAYER's rest opacity reads the `focusScale` feature-state
        // (near sections' labels in focus mode) — installed with the layer,
        // never swapped in later (a data-driven swap re-tiles the source).
        // It is also LABEL_SOURCE's only symbol layer, and GL 3.25's
        // SymbolBucket.update needs every symbol layer on a source that
        // carries feature-state to have a state-dependent paint (`occluded`
        // keeps it one in both branches of the ghosts toggle).
        addPair(
          labelLayerSpec(LABEL_LAYER, LABEL_SOURCE, focusScaleFactor()),
          labelLayerSpec(PREVIEW_LABEL_LAYER, PREVIEW_LABEL_SOURCE),
        )
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
        // CLIP_LAYER sits here (before the transform layer) — added by the
        // basemap-clip effect below, only on styles where it clips anything.
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
        // over every cell of the selected grid(s). Its source holds just
        // those cells (`tintData`), so it needs no filter. Same
        // paper-thin slab trick from CLAUDE.md so flat grids still
        // render a visible wash.
        if (!map.getLayer(selectionTintLayerId)) {
          const tintLayerDef = {
            id: selectionTintLayerId,
            type: 'fill-extrusion',
            source: SELECTION_TINT_SOURCE,
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
      safeRemove(PREVIEW_LABEL_LAYER)
      for (const id of FOCUS_TWIN_LAYERS) safeRemove(id)
      for (const id of EXTRUDE_LAYER_IDS) safeRemove(id)
      safeRemove(PREVIEW_EXTRUDE_LAYER)
      safeRemove(LINE_BOTTOM_LAYER)
      safeRemove(PREVIEW_LINE_BOTTOM_LAYER)
      safeRemove(LINE_LAYER)
      safeRemove(PREVIEW_LINE_LAYER)
      safeRemove(FILL_LAYER)
      safeRemove(PREVIEW_FILL_LAYER)
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
      for (const id of FOCUS_TWIN_SOURCES) safeRemoveSource(id)
      safeRemoveSource(LINE_SOURCE)
      safeRemoveSource(FILL_SOURCE)
      safeRemoveSource(SELECTION_TINT_SOURCE)
      safeRemoveSource(PREVIEW_POLY_SOURCE)
      safeRemoveSource(PREVIEW_LINE_SOURCE)
      safeRemoveSource(PREVIEW_LABEL_SOURCE)
      safeRemoveSource(bboxSourceId)
      safeRemoveSource(centerSourceId)
      safeRemoveSource(CLIP_SOURCE)
      safeRemoveSource(transformSourceId)
    }
    // styleGen forces a fresh setup pass on every basemap swap, since
    // Mapbox tears down user-added sources/layers but `styleLoaded`
    // stays true and would otherwise short-circuit this effect.
  }, [map, styleLoaded, styleGen])

  // ---- Basemap clip layer ------------------------------------------------
  // Runs right after the setup pass above (same commit on style.load), so
  // CLIP_LAYER lands at its old slot before the transform layer. The setup
  // cleanup still removes it ahead of CLIP_SOURCE. Not tied to
  // `committedVisible` — hidden grids kept clipping before, and still do.
  useEffect(() => {
    if (!map || !styleLoaded) return
    syncBasemapClipLayer(map, {
      layerId: CLIP_LAYER,
      sourceId: CLIP_SOURCE,
      needed: basemapClip,
      beforeId: transformLayerId,
      label: 'MapGridOverlay',
    })
  }, [map, styleLoaded, styleGen, basemapClip])

  // ---- Source pushes -------------------------------------------------------
  // One effect per source, each keyed on that source's own collection:
  // setData serialises the whole collection on the main thread and the
  // worker re-indexes and re-tiles it, so a source is only pushed when
  // what it holds changed. `styleGen` re-pushes into the fresh sources
  // a basemap swap leaves behind.
  useSourceData(map, styleLoaded, styleGen, FILL_SOURCE, fillData)
  useSourceData(map, styleLoaded, styleGen, LINE_SOURCE, lineData)
  useSourceData(map, styleLoaded, styleGen, LABEL_SOURCE, labelPointData)
  useSourceData(map, styleLoaded, styleGen, PREVIEW_POLY_SOURCE, preview?.poly ?? null)
  useSourceData(map, styleLoaded, styleGen, PREVIEW_LINE_SOURCE, preview?.line ?? null)
  useSourceData(map, styleLoaded, styleGen, PREVIEW_LABEL_SOURCE, preview?.labels ?? null)
  useSourceData(map, styleLoaded, styleGen, SELECTION_TINT_SOURCE, tintData)

  // Extrusions + opacity-bucket gating. A bucket layer is shown only
  // while some committed cell routes to it — an unused bucket layer has
  // nothing to draw, yet the worker still filter-tests every feature for
  // it and ships an empty bucket per tile. Visibility and data change in
  // the same tick, so Mapbox folds both into one tile reload (a layer's
  // visibility reaches the worker before the reload it schedules). This
  // effect is the only writer of the bucket layers' visibility.
  // The setData is skipped when this source object already holds this
  // exact collection (`lastExtrudePushRef`, keyed by the source object,
  // which a style swap or re-mount replaces): a `committedVisible` toggle
  // only flips visibility, as it always did, instead of re-serialising
  // and re-indexing every extruded cell (30k on a seat stand).
  const lastExtrudePushRef = useRef<{
    source: GeoJSONSource
    data: GeoJSON.FeatureCollection<GeoJSON.Polygon>
  } | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(EXTRUDE_SOURCE) as GeoJSONSource | undefined
    for (const bucket of OPACITY_BUCKETS) {
      const id = extrudeLayerId(bucket)
      if (!map.getLayer(id)) continue
      map.setLayoutProperty(id, 'visibility', committedVisible && presentBuckets.has(bucket) ? 'visible' : 'none')
    }
    if (!src) return
    const last = lastExtrudePushRef.current
    if (last && last.source === src && last.data === extrudeData) return
    src.setData(extrudeData)
    lastExtrudePushRef.current = { source: src, data: extrudeData }
  }, [map, styleLoaded, styleGen, extrudeData, presentBuckets, committedVisible])

  // The preview extrude layer follows the preview's opacity bucket:
  // same filter and constant opacity as that bucket's committed layer,
  // and drawn in that layer's slot (directly below it), as the preview
  // cells were when they routed through the bucket layers themselves.
  const previewBucket = preview?.bucket ?? 100
  // Bucket whose slot the preview layer was last placed in, per setup
  // pass (setup adds it in bucket 100's slot).
  const previewSlotRef = useRef<{ gen: number; bucket: number }>({ gen: -1, bucket: 100 })
  useEffect(() => {
    if (!map || !styleLoaded || !map.getLayer(PREVIEW_EXTRUDE_LAYER)) return
    if (previewSlotRef.current.gen !== styleGen) previewSlotRef.current = { gen: styleGen, bucket: 100 }
    try {
      map.setFilter(PREVIEW_EXTRUDE_LAYER, extrudeBaseFilter(previewBucket) as never)
      map.setPaintProperty(PREVIEW_EXTRUDE_LAYER, 'fill-extrusion-opacity', previewBucket / 100)
      const before = extrudeLayerId(previewBucket)
      if (previewSlotRef.current.bucket !== previewBucket && map.getLayer(before)) {
        map.moveLayer(PREVIEW_EXTRUDE_LAYER, before)
        previewSlotRef.current.bucket = previewBucket
      }
    } catch { /* style torn down */ }
  }, [map, styleLoaded, styleGen, previewBucket])

  // Clip footprints get their own push, skipped when the source already
  // holds the same footprints (`lastClipPushRef` is keyed by the source
  // object, which a style swap or re-mount replaces). Nothing reads the
  // source while CLIP_LAYER is absent, so it isn't fed at all then.
  const lastClipPushRef = useRef<{
    source: GeoJSONSource
    data: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  } | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded || !basemapClip) return
    const clipSrc = map.getSource(CLIP_SOURCE) as GeoJSONSource | undefined
    if (!clipSrc) return
    const last = lastClipPushRef.current
    if (last && last.source === clipSrc && sameClipFootprints(last.data, clipData)) return
    clipSrc.setData(clipData ?? EMPTY_FC)
    lastClipPushRef.current = { source: clipSrc, data: clipData }
  }, [map, styleLoaded, styleGen, basemapClip, clipData])

  // ---- Focus mode: what the host focused ----------------------------------
  // Read from context (`FocusSceneContext` / `FocusBlockersContext`); outside
  // a provider these are FOCUS_OFF / NO_BLOCKERS and nothing below writes.
  const focusScene = useFocusScene()
  const focusBlockers = useFocusBlockers()
  // The grid set, grid pierce discs and blocking cells only: the same
  // object while those are unchanged (a safe memo dep).
  const gridFocusBlockers = gridBlockersOf(focusBlockers)
  const occlusionGhosts = useGraphicsSettings((s) => s.occlusionGhosts)
  const focusedCell = focusedCellOf(focusScene)
  /** The focused rack (whole-grid target), or null — a bin target is `focusedCell`. */
  const focusedGridId = focusedCell ? null : focusedIdOf(focusScene, 'grids')
  const focusedLabelId = focusedCell
    ? labelIdOf(focusedCell.gridId, focusedCell.row, focusedCell.col, focusedCell.level)
    : null

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
  // The targets: every committed label with an id (live-preview labels
  // have none). Built once per label collection, not per camera move.
  // The focused rack's labels (or the focused bin's) are never targets: a
  // focused item is never hidden, and a label leaving the list is reported
  // in `left`, so only it is un-hidden.
  const labelTargets = useMemo<OccludableTarget[]>(() => {
    const targets: OccludableTarget[] = []
    if (!committedVisible) return targets
    for (const f of labelPointData.features) {
      const props = (f.properties ?? {}) as {
        labelId?: number
        gridId?: number
        altitudeMeters?: number
        floorPlanId?: number
      }
      if (props.labelId === undefined) continue
      if (props.labelId === focusedLabelId || (focusedGridId !== null && props.gridId === focusedGridId)) continue
      const coords = f.geometry.coordinates as [number, number]
      targets.push({
        id: props.labelId,
        position: coords,
        elevationM: props.altitudeMeters ?? 0,
        floorPlanId: props.floorPlanId,
      })
    }
    return targets
  }, [labelPointData, committedVisible, focusedLabelId, focusedGridId])
  // No label targets (rack labels off — e.g. every stadium seat), no
  // occluder prisms: the solver would have nothing to test them against.
  const hasLabelTargets = labelTargets.length > 0
  const prisms = useMemo(
    () =>
      occlusionEnabled && hasLabelTargets
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
      hasLabelTargets,
      occludeImages,
      occludePolygons,
      occludeCircles,
      occludeLines,
      occludeStairs,
      occludeGrids,
    ],
  )
  // Running occlusion pass: `updateOcclusion` skips repeat camera
  // positions and reports only the labels whose occluded flag flipped,
  // so a move writes feature-state for those alone.
  // What LABEL_SOURCE's feature-state says, tied to the source object (and
  // style generation) it was written to — same pattern as the text-label
  // overlay. Kept across re-subscriptions (new label collection, focus
  // change, new prisms), so those write only what flipped. A NEW source
  // starts with no feature-state (style swap, StrictMode re-mount, HMR):
  // fresh state, the first pass writes every occluded label again. Same
  // source, new style generation: reset, and un-hide what was forgotten.
  const occlusionRef = useRef<{ source: unknown; gen: number; state: OcclusionState } | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded) return
    const write = (id: number, occluded: boolean) => {
      try {
        map.setFeatureState({ source: LABEL_SOURCE, id }, { occluded })
      } catch { /* source went away */ }
    }
    const sync = () => {
      const source = map.getSource(LABEL_SOURCE)
      // Mid style swap: nothing to write to; the next pass picks it up.
      if (!source) return
      let o = occlusionRef.current
      let forgotten: ReadonlySet<number> | null = null
      if (!o || o.source !== source) {
        o = { source, gen: styleGen, state: createOcclusionState() }
        occlusionRef.current = o
      } else if (o.gen !== styleGen) {
        forgotten = resetOcclusionState(o.state)
        o.gen = styleGen
      }
      const { occluded, entered, left } = updateOcclusion(map, labelTargets, prisms, o.state)
      if (forgotten) for (const id of forgotten) if (!occluded.has(id)) write(id, false)
      for (const id of left) write(id, false)
      for (const id of entered) write(id, true)
    }
    sync()
    // Nothing to test (no labels, or no occluders): the result can't
    // depend on the camera.
    if (labelTargets.length === 0 || prisms.length === 0) return
    map.on('move', sync)
    return () => {
      map.off('move', sync)
    }
  }, [map, styleLoaded, styleGen, labelTargets, prisms])

  // ---- Focus mode: grid layers ------------------------------------------
  // See the "Focus mode" block comment at the top. The plan is rebuilt when
  // the scene (its NEAR column included), the blocking racks or the grids
  // change; `syncGridFocus` writes only what differs from what is on the
  // map. Declared after the setup and push effects, so a style swap
  // re-creates the layers first.
  const ghostSlot = useRef<CollectionSlot<GeoJSON.Polygon>>(null)
  const nearSlot = useRef<CollectionSlot<GeoJSON.Polygon>>(null)
  const restSlot = useRef<CollectionSlot<GeoJSON.Polygon>>(null)
  const focusSlot = useRef<CollectionSlot<GeoJSON.Polygon>>(null)
  // Per focus (never per blocker change): the near sections drawn
  // cell-scoped and the rest twin's bucket — what the near twin and the
  // near labels read.
  const nearCuts = useMemo(
    () => buildGridNearCuts(focusScene, committedGrids, { visible: committedVisible, excludeId: tId, liftable: LIFTABLE }),
    [focusScene, committedGrids, committedVisible, tId],
  )
  // The slots are memo caches written idempotently during render, like the
  // per-source slots above.
  const focusPlan = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      buildGridFocusPlan(focusScene, gridFocusBlockers, committedGrids, nearCuts, {
        visible: committedVisible,
        excludeId: tId,
        liftable: LIFTABLE,
        slots: { ghost: ghostSlot, near: nearSlot, rest: restSlot, focus: focusSlot },
      }),
    [focusScene, gridFocusBlockers, committedGrids, nearCuts, committedVisible, tId],
  )
  const focusRtRef = useRef<GridFocusRuntime | null>(null)
  useEffect(() => {
    if (!map) return
    // Count camera moves from now on, so a same-focus change knows
    // whether it lands inside a move (see `onNextCameraSettle`).
    trackCameraMotion(map)
    const rt = (focusRtRef.current ??= createGridFocusRuntime())
    return () => disposeGridFocusRuntime(rt)
  }, [map])
  useEffect(() => {
    if (!map || !styleLoaded) return
    const rt = (focusRtRef.current ??= createGridFocusRuntime())
    rt.plan = focusPlan
    syncGridFocus(map, rt)
  }, [map, styleLoaded, styleGen, focusPlan])

  // ---- Focus mode: rack labels of near sections ---------------------------
  // A NEAR section's labels fade with it: `focusScale` = FOCUS_FACTOR.near
  // on each label (LABEL_LAYER's install-time `text-opacity` folds it in),
  // except the focused bin's own label — in a 'cells' section only the
  // labels of its fading cells (`nearCuts`, matched by row / col / level).
  // Keyed on the NEAR column, not on the blockers, so nothing is written
  // per camera settle; a blocking section's labels are left as they are.
  // Change-only writes, tied to the LABEL_SOURCE object (and style
  // generation) they went to.
  const hasRackLabels = labelPointData.features.length > 0
  const nearGridIds = nearIdsOf(focusScene.near, 'grids')
  const nearLabelIds = useMemo<readonly number[]>(() => {
    if (!focusScene.active || nearGridIds.size === 0 || !hasRackLabels) return NO_LABEL_IDS
    const out: number[] = []
    for (const g of committedGrids) {
      if (!nearGridIds.has(g.id) || g.id === focusedGridId) continue
      const rule = nearCuts.cells.get(g.id)
      for (const f of g.parts.labels) {
        const p = f.properties as { labelId?: unknown; row?: unknown; col?: unknown; level?: unknown } | null
        const id = p?.labelId
        if (typeof id !== 'number' || id === focusedLabelId) continue
        if (rule) {
          const [lng, lat] = f.geometry.coordinates
          const row = typeof p?.row === 'number' ? p.row : NaN
          const col = typeof p?.col === 'number' ? p.col : NaN
          const level = typeof p?.level === 'number' ? p.level : 0
          if (!rule.fades(row, col, level, lng, lat)) continue
        }
        out.push(id)
      }
    }
    return out.length > 0 ? out : NO_LABEL_IDS
  }, [focusScene.active, nearGridIds, hasRackLabels, committedGrids, nearCuts, focusedGridId, focusedLabelId])
  const labelScaleRef = useRef<{ source: unknown; gen: number; written: Set<number> } | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded) return
    const source = map.getSource(LABEL_SOURCE)
    if (!source) return
    let r = labelScaleRef.current
    if (!r || r.source !== source) {
      // A new source carries no feature-state.
      r = { source, gen: styleGen, written: new Set() }
      labelScaleRef.current = r
    }
    const want = new Set(nearLabelIds)
    const regen = r.gen !== styleGen
    r.gen = styleGen
    for (const id of [...r.written]) {
      if (want.has(id)) continue
      removeState(map, LABEL_SOURCE, id, FOCUS_SCALE_STATE)
      r.written.delete(id)
    }
    for (const id of want) {
      // Same source, new style generation: write again rather than trust it.
      if (!regen && r.written.has(id)) continue
      setState(map, LABEL_SOURCE, id, { [FOCUS_SCALE_STATE]: FOCUS_FACTOR.near })
      r.written.add(id)
    }
  }, [map, styleLoaded, styleGen, nearLabelIds])

  // Rack-label opacity: Graphics → faint ghosts raises the occluded branch
  // (a relayout of LABEL_SOURCE, once per toggle — never per camera move).
  // The rest branch stays the installed `focusScale` factor.
  const occludedLabelOpacity = occlusionGhosts ? GHOST_OCCLUDED_OPACITY : 0
  const labelOpacity = useMemo(
    () => gridLabelOpacity(occludedLabelOpacity, focusScaleFactor()),
    [occludedLabelOpacity],
  )
  const previewLabelOpacity = useMemo(() => gridLabelOpacity(occludedLabelOpacity, 1), [occludedLabelOpacity])
  const labelPaintRef = useRef<{ main: LayerPaintRecord; preview: LayerPaintRecord } | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded) return
    const rec = (labelPaintRef.current ??= {
      main: { layer: null, json: LABEL_OPACITY_INSTALL_JSON },
      preview: { layer: null, json: PREVIEW_LABEL_OPACITY_INSTALL_JSON },
    })
    syncLayerPaint(map, LABEL_LAYER, 'text-opacity', labelOpacity, rec.main, LABEL_OPACITY_INSTALL_JSON)
    syncLayerPaint(
      map,
      PREVIEW_LABEL_LAYER,
      'text-opacity',
      previewLabelOpacity,
      rec.preview,
      PREVIEW_LABEL_OPACITY_INSTALL_JSON,
    )
  }, [map, styleLoaded, styleGen, labelOpacity, previewLabelOpacity])

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

  // Transform-drag state — declared ahead of the click handlers, which
  // ignore clicks while a drag is in flight. Held in a ref so it persists
  // across effect re-runs (see the drag effect below).
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
    // One delegated listener for every cell layer (CELL_HIT_LAYERS): Mapbox
    // runs one queryRenderedFeatures over them all instead of one per
    // layer. It used to be one listener per layer, fired in list order,
    // each seeing only its own layer's hits — the first whose top hit had
    // a gridId claimed the click. `e.features` (all layers, render order)
    // restricted to one layer is that layer's own hit list, so walking
    // the layers in the same order picks the same cell.
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
      const features = e.features ?? []
      if (features.length === 0) return
      // Model is visually on top — defer to it. The model overlay's own
      // (map-level) click handler runs next and will select the model
      // because we never call preventDefault.
      if (modelLayersAtPoint(e.point)) return
      for (const layerId of CELL_HIT_LAYERS) {
        const cellFeat = features.find((f) => f.layer?.id === layerId)
        if (!cellFeat) continue
        const gridId = cellFeat.properties?.gridId
        if (typeof gridId !== 'number') continue
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
        return
      }
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
    map.on('click', CELL_HIT_LAYERS, handleCellClick)
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
    // Pointer cursor while over any cell layer. One enter / leave pair
    // over the whole list (two queries per mousemove, not 26), and moving
    // from one cell layer to another no longer flashes the cursor back.
    map.on('mouseenter', CELL_HIT_LAYERS, handleEnter)
    map.on('mouseleave', CELL_HIT_LAYERS, handleLeave)
    map.on('click', handleMapClick)
    return () => {
      map.off('click', CELL_HIT_LAYERS, handleCellClick)
      map.off('click', handleGlobalClick)
      map.off('mouseenter', CELL_HIT_LAYERS, handleEnter)
      map.off('mouseleave', CELL_HIT_LAYERS, handleLeave)
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
  // toolbar's "Toggle Grid" button. (The extrude bucket layers follow it
  // in the extrusion push effect, which also gates unused buckets.)
  // The live-preview twins follow it too: the preview cells used to live
  // in the committed layers, so hiding grids hid them as well and a draw
  // showed only the bbox outline and centre dot.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const vis = committedVisible ? 'visible' : 'none'
    for (const id of [
      FILL_LAYER, LINE_LAYER, LINE_BOTTOM_LAYER, LABEL_LAYER, selectionTintLayerId, 'grid-selection-line-layer',
      PREVIEW_FILL_LAYER, PREVIEW_EXTRUDE_LAYER, PREVIEW_LINE_LAYER, PREVIEW_LINE_BOTTOM_LAYER, PREVIEW_LABEL_LAYER,
    ]) {
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
  // Source the handles were last cleared on — while no transform is
  // active, a re-render (the draw tool's per-move `config`) needn't
  // re-send the empty collection.
  const handlesClearedOnRef = useRef<mapboxgl.GeoJSONSource | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(transformSourceId) as mapboxgl.GeoJSONSource | undefined
    if (!src) return
    const transformState = stableTransform
    if (!transformState) {
      if (handlesClearedOnRef.current !== src) {
        src.setData({ type: 'FeatureCollection', features: [] })
        handlesClearedOnRef.current = src
      }
      return
    }
    handlesClearedOnRef.current = null
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
  }, [stableTransform, map, styleLoaded, committedLines, config])

  // ---- Exclusion filter (committed base layers) ------------------------
  // While a transform is active, hide the moving grid from FILL /
  // EXTRUDE-op* / LINE / LINE_BOTTOM / LABEL / selectionLine so it
  // doesn't render twice — once at its stale committed geometry, once
  // at its live drag position on FILL_INFLIGHT_SOURCE. Each layer keeps
  // the base filter it was added with; `notMe` is composed onto it.
  // (LINE_BOTTOM's base keeps flat cells — see `lineBottomBaseFilter`.)
  // Keyed on the moving grid's id only — a setFilter re-tiles the
  // layer's whole source.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const notMe = tId != null ? ['!=', ['get', 'gridId'], tId] : null
    for (const [layerId, baseFilter] of COMMITTED_BASE_FILTERS) {
      try {
        if (!map.getLayer(layerId)) continue
        const base = baseFilter()
        const filter = notMe
          ? base
            ? base[0] === 'all'
              ? [...base, notMe]
              : ['all', base, notMe]
            : notMe
          : base
        map.setFilter(layerId, filter as never)
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, tId])

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
  // can't shove above. Deps include the transform (`stableTransform`)
  // so handles re-elevate the moment the user clicks Move / Rotate / Scale;
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
    stableTransform,
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
    const transformState = stableTransform
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
  }, [map, styleLoaded, styleGen, stableTransform, committedLines])

  useEffect(() => {
    const transformState = stableTransform
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
  }, [map, stableTransform, transformLayerId])

  return null
}

// Avoid unused import warning on type-only re-export.
export type { GridCell }
