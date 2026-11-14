/**
 * v2 report / dashboard spec — the Evidence-inspired shape.
 *
 * The whole spec is one JSON document that describes:
 *   - `sources`    : which data sources this report reads from
 *   - `params`     : runtime inputs (dropdown, dateRange, dimensionGrid, …)
 *   - `queries`    : named SQL specs that each widget can reference
 *   - `layout`     : grid canvas metrics (columns, row height, gap)
 *   - `widgets`    : cells on the canvas, each pinned to a query name
 *
 * The backend counterpart lives in
 * `backend/internal/reports/v2/spec.go`. Field names + shapes MUST
 * stay in lockstep; a v2 spec written on the frontend has to
 * round-trip through the backend without mutation.
 */
import type { FilterNode, Metric, ReportSourceRef, SortKey } from '@/lib/reports-client'

/** Discriminant carried inside the JSON blob. */
export const REPORT_SPEC_VERSION = 2 as const

/** Widget kinds — union of v1 kinds + everything v2 adds. */
export type WidgetKindV2 =
  // v1 carry-overs (unchanged renderers)
  | 'kpi'
  | 'table'
  | 'line'
  | 'bar'
  | 'area'
  | 'pie'
  | 'donut'
  | 'history'
  | 'markdown'
  | 'divider'
  // v2 additions
  | 'bigValue'
  | 'dataTable'
  | 'scatter'
  | 'heatmap'
  | 'sankey'
  | 'note'
  | 'alert'
  | 'tabs'
  | 'accordion'
  | 'dimensionGrid'
  | 'map'
  | 'editableTable'
  /** List + detail panel + live facility map over built-in facility
   *  sources (src/components/reports/widgets/facility-explorer/). */
  | 'facilityExplorer'

/** Every input kind the params panel can render. */
export type ParamInputKind =
  | 'dropdown'
  | 'buttonGroup'
  | 'dateRange'
  | 'dateInput'
  | 'slider'
  | 'textInput'
  | 'dimensionGrid'
  | 'checkbox'

/** Static or query-driven option universe for dropdown-family inputs. */
export interface ParamOptionSource {
  /** Static { value, label } pairs — no query fired. */
  static?: Array<{ value: unknown; label: string }>
  /** Reference to a named query whose result rows supply the options. */
  fromQuery?: string
  /** Result column that carries the value. */
  valueColumn?: string
  /** Optional result column that carries the display label. Defaults to `valueColumn`. */
  labelColumn?: string
}

/** Per-input-kind configuration bag. */
export interface ParamInput {
  kind: ParamInputKind
  /** Only meaningful for dropdown / buttonGroup / dimensionGrid. */
  options?: ParamOptionSource
  /** Dropdown multi-select toggle. */
  multi?: boolean
  /** DateRange presets ("last7", "last30", …) rendered as quick buttons. */
  presets?: string[]
  /** DateInput granularity. */
  granularity?: 'day' | 'month' | 'year'
  /** Slider bounds. */
  min?: number
  max?: number
  step?: number
  /** TextInput placeholder (translated on the frontend). */
  placeholder?: string
  /** DimensionGrid: which columns to pivot on. */
  columns?: string[]
  /** DimensionGrid: source override when options come from a source directly. */
  sourceRef?: ReportSourceRef
}

/** How a viewer filter is shown in the filter bar. */
export type ViewerFilterKind = 'dropdown' | 'multi' | 'buttons' | 'search' | 'dateRange' | 'yesNo'

/**
 * A filter viewers change from the report's filter bar, authored in the
 * builder's Viewer filters step (src/lib/reports/viewer-filters.ts).
 * Saved twice: as a param (what the runtime reads) plus the conditions
 * it injects into every query on `sourceIds`, and here as metadata so
 * the step can edit it again. Param id = `id` (prefix `vf_`).
 */
export interface ViewerFilter {
  id: string
  field: string
  label: string
  kind: ViewerFilterKind
  /** Sources whose queries this filter narrows. */
  sourceIds: number[]
  /** Where the dropdown / buttons options come from — defaults to
   *  distinct `field` values of `sourceIds[0]`. `sortField` lists raw
   *  rows in that order instead (floors by height). */
  options?: {
    sourceId?: number
    valueColumn?: string
    sortField?: string
    /** Fixed conditions for the options query (e.g. facility_id = 71) —
     *  otherwise taken from the report's first query on that source. */
    filters?: FilterNode
    trueLabel?: string
    falseLabel?: string
    /** Search-box placeholder (defaults to the label). */
    placeholder?: string
  }
}

/** Data-driven default — computed after a query result lands. */
export interface DefaultFromQuery {
  query: string
  column: string
  reduce?: 'first' | 'min' | 'max'
}

/** One typed runtime input the viewer surfaces. */
export interface ReportParam {
  /** Stable id — used in URL keys and `{{param.<id>}}` references. */
  id: string
  label?: string
  input: ParamInput
  /** Hard-coded fallback when no URL / user / data default fires. */
  defaultValue?: unknown
  /** Data-driven default (Evidence's `select_first`-style). */
  defaultFromQuery?: DefaultFromQuery
  /** Whether user-set values sync to `?<id>=value` in the URL. Defaults to true. */
  urlPersist?: boolean
}

/**
 * One named query in the dashboard. Filter values may embed
 * `{{param.<id>}}` markers — they resolve to bound `$N` args on the
 * server, never string-substituted.
 */
export interface ReportQueryV2 {
  name: string
  sourceRef: ReportSourceRef
  filters?: FilterNode
  groupBy?: string[]
  metrics?: Metric[]
  sort?: SortKey[]
  limit?: number
  offset?: number
  /**
   * Optional WHERE-fragment template. This is the DimensionGrid slot:
   *   `[[ {{param.selection}} ]]`
   * Anything else the server rejects.
   */
  extraFilter?: string
  /** Explicit dependency listing. When absent the runtime scans for `{{param.x}}` markers. */
  paramRefs?: string[]
  /**
   * Client-side computed columns — evaluated after the executor
   * returns rows. Never touch SQL. See
   * `@/lib/reports/computed-columns` for the shape + evaluator.
   */
  computedColumns?: unknown[]
}

/** Where a widget floats in the full-map layout (src/lib/reports/map-layout.ts). */
export type MapSlot = 'kpi' | 'insights' | 'hidden'

/** Layout metrics. `document` = Evidence-style vertical flow (default);
 *  `grid` = 12-col drag/resize canvas for pixel-precise dashboards;
 *  `map` = the facility map & list fills the page, widgets float over it. */
export interface LayoutConfig {
  kind?: 'document' | 'grid' | 'map'
  /** Map mode only — per-widget slot overrides, keyed by widget id. */
  mapSlots?: Record<string, MapSlot>
  /** Grid mode only. */
  cols?: number
  rowHeightPx?: number
  gapPx?: number
  mobileBreakpointPx?: number
  /** Document mode only — max content width in px. Defaults to 1152 (6xl). */
  maxContentPx?: number
  /** Hide the runtime params bar in the viewer. Off by default —
   *  when the report has any declared params the bar renders and
   *  gives viewers filters to interact with. */
  hideParamsBar?: boolean
  /** Per-widget position overrides. Keyed by widget id. Overrides
   *  what the widget's own `position` field carries — used by the
   *  Layout step so users can freely place auto-generated primary
   *  widgets without the report-type recipe stomping on their edits
   *  on the next save. */
  widgetPositions?: Record<string, WidgetPosition>
}

/** Cross-filter emit — widget click writes a param value. */
export interface CrossFilterAction {
  /** Param id to write. */
  setParam: string
  /** Column / feature-property key whose value is written. */
  from: string
  /** When true, clicking the currently-selected cell clears the param. */
  toggle?: boolean
}

/** Widget position on the grid canvas. */
export interface WidgetPosition {
  x: number
  y: number
  w: number
  h: number
}

/** Inline data config for a widget. Presence of this field means the
 *  serialiser should synthesize a private per-widget query with a
 *  stable id (`w_<widgetId>`) — the widget then binds to that query.
 *  Widgets can still use `queryRef` alone to bind to a named / shared
 *  query when `data` is omitted, so existing dashboards keep working. */
export interface WidgetDataConfig {
  /** Source override — falls back to the report's primary source
   *  when unset. Setting this to a different source lets a widget
   *  pull from any tenant table the user can read. */
  sourceRef?: ReportSourceRef
  /** Aggregation shape. `raw` returns rows; `aggregate` rolls them
   *  up via `groupBy` + `metrics`. */
  agg: 'raw' | 'aggregate'
  /** Group-by fields (chart x-axis, table dimension). Required for
   *  `agg: 'aggregate'`; ignored in raw mode. */
  groupBy?: string[]
  /** Metric definitions for aggregate mode. Each becomes a metric on
   *  the synthesized query. */
  metrics?: Metric[]
  /** Widget-specific filters — added on top of the widget query. */
  filters?: FilterNode
  /** Sort keys — apply after aggregation. */
  sort?: SortKey[]
  /** Row limit for the synthesized query. */
  limit?: number
}

/** One placed cell on the canvas / block in the document. */
export interface ReportWidgetV2 {
  id: string
  kind: WidgetKindV2
  title?: string
  /** Which query supplies data. Omitted for presentation-only kinds.
   *  When `data` is set, this is auto-populated with `w_<id>`. */
  queryRef?: string
  /** Inline data config — presence means the widget owns its query. */
  data?: WidgetDataConfig
  /** Position in the 12-col grid — used when layout.kind === 'grid'. */
  position: WidgetPosition
  /** Document-flow order — used when layout.kind === 'document'. Widgets
   *  without an order fall back to position.y for backward compat. */
  order?: number
  /** Half-width pairing hint for document mode. Two consecutive
   *  `columnSpan:2` widgets share a 2-col row; otherwise widgets flow
   *  full width. */
  columnSpan?: 1 | 2
  /** Per-widget-kind bindings bag; loosely typed so widget renderers own the shape. */
  bindings?: Record<string, unknown>
  icon?: string
  color?: string
}

/** Report authoring type — drives the wizard flow and the
 *  auto-generated primary widget. Runtime execution is type-agnostic;
 *  this field is metadata for the builder. */
export type ReportType = 'detail' | 'summary' | 'editable' | 'history'

/** Top-level v2 spec document. */
export interface ReportSpecV2 {
  v: typeof REPORT_SPEC_VERSION
  /** Classifier that drives the builder wizard — omitted specs default
   *  to 'detail' in the wizard. */
  reportType?: ReportType
  sources?: ReportSourceRef[]
  params?: ReportParam[]
  queries?: ReportQueryV2[]
  layout?: LayoutConfig
  widgets?: ReportWidgetV2[]
  /** Optional page-level cosmetics — passed through verbatim. */
  presentation?: unknown
  /** Viewer filters authored in the builder (see ViewerFilter). */
  viewerFilters?: ViewerFilter[]
  /** Where a generated report came from — the facility report set
   *  stamps `{kind: 'facility-set', key, zoneId}`; carried through
   *  edits so the backfill still recognises it. */
  origin?: { kind: string; key?: string; zoneId?: number; /** A generator's own settings (the master report's setup). */ config?: unknown }
}

/** Default layout the FE creates for fresh dashboards / migrated v1 rows.
 *  Documents-mode default matches Evidence's reading-first UX. */
export const DEFAULT_LAYOUT: Required<LayoutConfig> = {
  kind: 'document',
  cols: 12,
  rowHeightPx: 48,
  gapPx: 12,
  mobileBreakpointPx: 640,
  maxContentPx: 1152,
  hideParamsBar: false,
  widgetPositions: {},
  mapSlots: {},
}

/** Widget kinds that render without data (no queryRef needed). */
export const PRESENTATION_ONLY_KINDS: readonly WidgetKindV2[] = [
  'markdown',
  'note',
  'divider',
  'alert',
]

export function isPresentationOnly(kind: WidgetKindV2): boolean {
  return PRESENTATION_ONLY_KINDS.includes(kind)
}
