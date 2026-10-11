/**
 * Client for the Dynamic Report Builder. Backed by `/api/v1/reports`
 * (see `backend/internal/handlers/reports.go`).
 *
 * A Report is a JSON spec that references user-defined tables and
 * data_source rows (kind=`table` | `rest` | `webhook` | `file`), a
 * filter DSL, aggregations, sort/pagination, and an ordered list of
 * widgets (KPI, table, chart, map, markdown, ...). The Phase 2
 * executor runs the spec; this file only handles CRUD + ACL + history.
 *
 * Permission model:
 *   - Only tenant owners/admins can CREATE / UPDATE / ARCHIVE / DELETE.
 *   - A report is VISIBLE to: tenant admins always, the creator always,
 *     plus any tenant member explicitly listed on `permissions`.
 *   - `canEdit` in the response tells the UI whether to render the
 *     builder actions on this report.
 */

import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api-client'
import { queryCache } from '@/lib/useApiQuery'
import { facilityEntityName, facilityFieldLabel } from '@/lib/reports/facility-sources'
import { isPresentationOnly, type WidgetKindV2 } from '@/lib/reports/v2-types'

// ================================================================ types

/** A single widget rendered inside a report. */
export type WidgetKind =
  // v1 widget kinds (still shipped)
  | 'kpi'
  | 'table'
  | 'line'
  | 'bar'
  | 'pie'
  | 'donut'
  | 'area'
  | 'history'
  | 'markdown'
  | 'divider'
  // v2 additions (Evidence-inspired catalog)
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
  | 'facilityExplorer'

/** Field data type. Mirrors backend `reports.FieldType`. */
export type ReportFieldType = 'text' | 'number' | 'boolean' | 'date' | 'datetime'

/** One column on a source's schema (from GET /reports/_/sources/:id/fields). */
export interface ReportSourceField {
  key: string
  label: string
  type: ReportFieldType
}

/** Source hint from GET /reports/_/sources. */
export interface ReportSourceHint {
  id: number
  /** `facility` = built-in source over the facility's shapes (areas,
   *  markers, racks, …) — see src/lib/reports/facility-sources.ts. */
  kind: 'table' | 'rest' | 'webhook' | 'file' | 'facility'
  name: string
  entityKind?: string
  /** Facility sources only: catalog key ("areas") and shape API kind. */
  facilityEntity?: string
  apiKind?: string
}

/** Source schema — resolved via /reports/_/sources/:id/fields. */
export interface ReportSourceSchema {
  id: number
  kind: ReportSourceHint['kind']
  name: string
  fields: ReportSourceField[]
  facilityEntity?: string
  apiKind?: string
}

/** Filter operators — mirror backend. */
export type FilterOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'nin'
  | 'contains'
  | 'starts'
  | 'ends'
  | 'isnull'
  | 'notnull'
  | 'between'
  /** Whole calendar days (viewer date-range filters). */
  | 'onOrAfter'
  | 'onOrBefore'

export interface FilterCond {
  field: string
  op: FilterOp
  value?: unknown
}

/** One node of the filter tree. Exactly one of `and`/`or`/`cond` populated. */
export interface FilterNode {
  and?: FilterNode[]
  or?: FilterNode[]
  cond?: FilterCond
}

export type MetricFn = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'

export interface Metric {
  fn: MetricFn
  field?: string
  as: string
}

export interface SortKey {
  field: string
  dir: 'asc' | 'desc'
}

/**
 * Report spec — the shape stored in `reports.spec` JSONB. This is the
 * single source of truth for the builder + viewer + executor. Kept
 * intentionally loose here so the Phase 1 CRUD paths compile before the
 * Phase 2 filter DSL + widget schemas are frozen.
 */
export interface ReportSpec {
  /** One or more sources — each addresses a user-defined table or data-source row set. */
  sources?: ReportSourceRef[]
  /** Root filter group. Empty means "no filters". */
  filters?: FilterNode
  /** GROUP BY field keys. */
  groupBy?: string[]
  /** Aggregations to compute per group. */
  metrics?: Metric[]
  /** Sort keys. */
  sort?: SortKey[]
  /** Row cap on the underlying query — clamped server-side. */
  limit?: number
  /** Ordered widget list — this is what makes a report "detail" vs "summary" vs "map" vs "history". */
  widgets?: ReportWidget[]
  /** Optional page-level presentation. */
  presentation?: {
    header?: string
    footer?: string
    theme?: 'compact' | 'comfortable'
  }
}

export interface ReportSourceRef {
  /** `dataSource:<id>` addresses any `data_sources` row (kind=table|rest|webhook|file). */
  kind: 'table' | 'dataSource'
  id: number
}

/** Per-widget conditional rendering rule. Applied to a column value. */
export interface WidgetCondition {
  /** Column name (from the result set) this rule tests. */
  column: string
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'contains'
  value: string | number
  /** Tailwind classes to apply when the rule fires. Kept as a small allow-list at render time. */
  className: string
}

/** Chart widget bindings — used by Line / Bar / Area / Pie / Donut. */
export interface ChartBindings {
  /** For xy charts (line/bar/area): the x-axis column. For pie/donut: the label column. */
  xAxis?: string
  /** Value column names — line/bar/area render one series per name; pie/donut only reads [0]. */
  series?: string[]
  /** Whether to stack series (bar/area). */
  stacked?: boolean
  /** Explicit palette override — one CSS color per series. Falls back to token colors. */
  colors?: string[]
  /** Hide the legend (small dashboards where the chart title is enough). */
  hideLegend?: boolean
  /** Display names for series columns (legend + tooltip); falls back to
   *  the humanised column name. */
  seriesLabels?: Record<string, string>
}


/** History widget bindings — reads /reports/_/history over one source. */
export interface HistoryBindings {
  sourceId: number
  windowDays?: number
  bucket?: 'hour' | 'day' | 'week' | 'month'
  /** Which operation columns to render in the chart. Defaults to all three. */
  operations?: Array<'insert' | 'update' | 'delete'>
  /** How many recent events to list under the chart. 0 hides the list. */
  recent?: number
}

/** KPI widget bindings — pulls a single value from the shaped result. */
export interface KpiBindings {
  /** Column name whose value is displayed as the KPI. */
  value: string
  /** Column name for an optional subtitle line. */
  label?: string
  /** Which result row to read (default 0). */
  rowIndex?: number
  /** Value formatter — auto-detected from column type when unset. */
  format?: 'number' | 'percent' | 'currency' | 'text' | 'date'
  /** Static prefix / suffix for the display (e.g. "$", "%"). */
  prefix?: string
  suffix?: string
  /** Tone — same 4 KPI palette tokens the directory uses. */
  tone?: 'blue' | 'purple' | 'emerald' | 'amber'
}

/** Per-column config in the table widget. */
export interface TableColumnConfig {
  /** Display label — falls back to the column name. */
  label?: string
  format?: 'number' | 'percent' | 'currency' | 'text' | 'date' | 'datetime'
  align?: 'left' | 'center' | 'right'
  /** Hide the column but keep it in the underlying shaped set (useful for conditions). */
  hidden?: boolean
  /** Conditional CELL classes — applied per-row based on this column's value. */
  conditions?: WidgetCondition[]
  /**
   * Render each distinct value as a colored chip. The chip color is
   * derived deterministically from the value string so the same value
   * always gets the same color across rows. Best for status-ish
   * columns with a small vocabulary.
   */
  chip?: boolean
  /**
   * Column-footer aggregation. Renders one value in a summary row at
   * the bottom of the table, computed client-side across every row
   * that passed the executor's WHERE clause (before pagination).
   */
  footer?: 'sum' | 'avg' | 'min' | 'max' | 'count'
}

/** Table widget bindings — picks columns + per-column presentation. */
export interface TableBindings {
  /** Column names to render, in order. Empty = every column. */
  columns?: string[]
  /** Per-column overrides. Key = column name. */
  columnConfig?: Record<string, TableColumnConfig>
  /** Rows per page — clamped by the shaped result size. */
  pageSize?: number
}

/** Markdown widget bindings. */
export interface MarkdownBindings {
  content: string
}

export interface ReportWidget {
  id: string
  kind: WidgetKind
  title?: string
  /** Field key mapping — meaning depends on `kind`. */
  bindings?:
    | KpiBindings
    | TableBindings
    | MarkdownBindings
    | ChartBindings
    | HistoryBindings
    | Record<string, unknown>
  /** Per-widget presentation: icon (lucide name), color (token or hsl string). */
  icon?: string
  color?: string
}

export interface ReportPermission {
  userId: number
  userEmail?: string
  canEdit: boolean
  grantedAt?: string
  grantedBy?: number
}

export interface Report {
  id: number
  tenantId: number
  name: string
  description: string
  icon: string
  color: string
  spec: ReportSpec
  specVersion: number
  isArchived: boolean
  createdBy?: number
  createdAt: string
  updatedAt: string
  /**
   * Facility pin (migration 0040). `null` or missing = "cross-facility"
   * — the report shows under every facility filter as a shared card.
   * A numeric value pins it to that zone; the dashboard uses this for
   * the tab-strip filter.
   */
  zoneId?: number | null
  canEdit: boolean
  permissions?: ReportPermission[]
}

export interface CreateReportRequest {
  name: string
  description?: string
  icon?: string
  color?: string
  spec?: ReportSpec
  specVersion?: number
  /** Facility scope. Omit or set null for "cross-facility". */
  zoneId?: number | null
  permissions?: Array<{ userId: number; canEdit: boolean }>
}

export interface UpdateReportRequest {
  name: string
  description?: string
  icon?: string
  color?: string
  spec?: ReportSpec
  specVersion?: number
  /** Facility scope. PUT is full-replace — send the value you want. */
  zoneId?: number | null
  permissions?: Array<{ userId: number; canEdit: boolean }>
}

export interface ReportRun {
  id: number
  reportId: number
  specSnapshot: ReportSpec
  filtersApplied: Record<string, unknown>
  rowCount: number
  msElapsed: number
  status: 'ok' | 'error'
  error?: string
  ranBy?: number
  ranAt: string
}

/** Candidate for the ACL user picker in the builder. */
export interface ReportMemberCandidate {
  userId: number
  userEmail: string
  role: 'owner' | 'admin' | 'editor' | 'viewer'
}

// ================================================================ wire shapes

interface ReportWire extends Omit<Report, 'spec'> {
  spec: ReportSpec | string
}

function normalizeReport(row: ReportWire): Report {
  // Backend serializes `spec` as JSON directly. It's already an object
  // in the response, but defensively handle the string case in case a
  // future middleware double-encodes.
  const spec: ReportSpec =
    typeof row.spec === 'string' ? (JSON.parse(row.spec) as ReportSpec) : (row.spec ?? {})
  return {
    ...row,
    spec,
  }
}

// ================================================================ CRUD

/**
 * Directory list. Pass `{ zoneId: N }` to narrow to one facility;
 * omitting `zoneId` (or passing `null`) returns every report the
 * caller can see across the tenant. The backend intentionally includes
 * cross-facility (zoneId=null) rows in a zone-scoped query so shared
 * definitions surface everywhere.
 */
export async function listReports(opts?: { zoneId?: number | null }): Promise<Report[]> {
  const qs = opts?.zoneId != null ? `?zoneId=${opts.zoneId}` : ''
  const res = await apiGet<ReportWire[]>(`/reports${qs}`)
  return res.map(normalizeReport)
}

export async function getReport(id: number): Promise<Report> {
  const res = await apiGet<ReportWire>(`/reports/${id}`)
  return normalizeReport(res)
}

export async function createReport(req: CreateReportRequest): Promise<Report> {
  const res = await apiPost<ReportWire>('/reports', {
    name: req.name,
    description: req.description ?? '',
    icon: req.icon ?? '',
    color: req.color ?? '',
    spec: req.spec ?? {},
    specVersion: req.specVersion ?? 1,
    // Facility scope. It used to be dropped here, so duplicates, imports
    // and new reports all landed as "Shared" whatever was picked.
    zoneId: req.zoneId ?? null,
    permissions: req.permissions ?? [],
  })
  queryCache.invalidate('reports')
  return normalizeReport(res)
}

export async function updateReport(
  id: number,
  req: UpdateReportRequest,
): Promise<Report> {
  const res = await apiPut<ReportWire>(`/reports/${id}`, {
    name: req.name,
    description: req.description ?? '',
    icon: req.icon ?? '',
    color: req.color ?? '',
    spec: req.spec ?? {},
    specVersion: req.specVersion ?? 1,
    // PUT is a full replace: an omitted zoneId sets the column to NULL,
    // so every builder save used to move the report to "Shared".
    zoneId: req.zoneId ?? null,
    permissions: req.permissions ?? [],
  })
  queryCache.invalidate('reports')
  return normalizeReport(res)
}

/** Soft-delete — hides from the directory but keeps run history. */
export async function archiveReport(id: number): Promise<void> {
  await apiDelete<void>(`/reports/${id}`)
  queryCache.invalidate('reports')
}

/** Undo an archive (owner/admin). */
export async function restoreReport(id: number): Promise<void> {
  await apiPost<void>(`/reports/${id}/restore`, {})
  queryCache.invalidate('reports')
}

// ================================================================ ACL picker

export async function listReportMemberCandidates(): Promise<ReportMemberCandidate[]> {
  return apiGet<ReportMemberCandidate[]>('/reports/_/members')
}

// ================================================================ runs (history)

export async function listReportRuns(reportId: number, limit = 50): Promise<ReportRun[]> {
  return apiGet<ReportRun[]>(`/reports/${reportId}/runs?limit=${limit}`)
}

/** Shaped column returned by the executor. */
export interface RunColumn {
  name: string
  type: ReportFieldType
}

/** Successful run response. */
export interface RunReportResult {
  runId: number
  columns: RunColumn[]
  rows: unknown[][]
  rowCount: number
  msElapsed: number
  spec: ReportSpec
}

/** One query's result inside a v2 dashboard run. */
export interface QueryRunResult {
  columns: RunColumn[]
  rows: unknown[][]
  rowCount: number
  msElapsed: number
  error?: string
}

/** v2 dashboard run response — the shape POST /reports/:id/run returns. */
export interface RunReportV2Response {
  runId: number
  msElapsed: number
  queries: Record<string, QueryRunResult>
  spec: ReportSpec
}

/** Body for POST /reports/:id/run (v2). */
export interface RunReportV2Request {
  params?: Record<string, unknown>
  queryNames?: string[]
}

/**
 * v2 executor entry point — runs every declared query in parallel and
 * returns results keyed by query name. Every query result is
 * normalised (columns / rows never null); a failed query surfaces via
 * its `error` field while sibling queries still return data.
 */
export async function runReportV2(
  reportId: number,
  req: RunReportV2Request = {},
): Promise<RunReportV2Response> {
  const raw = await apiPost<RunReportV2Response>(`/reports/${reportId}/run`, req)
  const queries: Record<string, QueryRunResult> = {}
  for (const [name, q] of Object.entries(raw.queries ?? {})) {
    queries[name] = normalizeQueryResult(q)
  }
  return {
    runId: raw.runId ?? 0,
    msElapsed: raw.msElapsed ?? 0,
    spec: raw.spec ?? ({} as ReportSpec),
    queries,
  }
}

function normalizeQueryResult(raw: QueryRunResult): QueryRunResult {
  return {
    columns: raw.columns ?? [],
    rows: raw.rows ?? [],
    rowCount: raw.rowCount ?? 0,
    msElapsed: raw.msElapsed ?? 0,
    error: raw.error,
  }
}

/**
 * Legacy single-query wrapper — extracts the "main" query's result
 * from a v2 response and returns the v1 shape.  Provided so existing
 * viewer code keeps working until FE-3 lands the full v2 UI.
 */
export async function runReport(
  reportId: number,
  opts: { filters?: FilterNode; limit?: number; offset?: number } = {},
): Promise<RunReportResult> {
  const v2 = await runReportV2(reportId, {})
  // Pick the first query (usually "main" for migrated v1 reports).
  const firstName = Object.keys(v2.queries)[0]
  const first: QueryRunResult | undefined = firstName ? v2.queries[firstName] : undefined
  void opts // legacy filters/limit/offset were spec-level; v2 handles via params
  return {
    runId: v2.runId,
    columns: first?.columns ?? [],
    rows: first?.rows ?? [],
    rowCount: first?.rowCount ?? 0,
    msElapsed: v2.msElapsed,
    spec: v2.spec,
  }
}

// ================================================================ history

/** One bar in the History widget's change-over-time chart. */
export interface HistoryBucket {
  /** Bucket start (ISO string, already truncated on the server). */
  ts: string
  insert: number
  update: number
  delete: number
}

/** One row in the "recent changes" tail list. */
export interface HistoryEventRow {
  id: number
  entityKey: string
  operation: 'insert' | 'update' | 'delete'
  ts: string
  payload: Record<string, unknown>
}

/**
 * Wire response for GET /reports/_/history. Field names + shape must
 * stay in lockstep with `HistoryResponse` in backend/handlers/reports.go.
 */
export interface HistoryResult {
  buckets: HistoryBucket[]
  recent: HistoryEventRow[]
  sourceId: number
  windowDays: number
  bucketUnit: 'hour' | 'day' | 'week' | 'month'
  totalEvents: number
}

/** Fetch event history for a source. Used by the History widget. */
export async function fetchReportHistory(opts: {
  sourceId: number
  windowDays?: number
  bucket?: 'hour' | 'day' | 'week' | 'month'
  recent?: number
}): Promise<HistoryResult> {
  const params = new URLSearchParams()
  params.set('sourceId', String(opts.sourceId))
  if (opts.windowDays !== undefined) params.set('windowDays', String(opts.windowDays))
  if (opts.bucket) params.set('bucket', opts.bucket)
  if (opts.recent !== undefined) params.set('recent', String(opts.recent))
  const raw = await apiGet<HistoryResult>(`/reports/_/history?${params.toString()}`)
  // Normalize nil-slice-serializes-as-null the same way runReport does.
  return {
    ...raw,
    buckets: raw.buckets ?? [],
    recent: raw.recent ?? [],
    totalEvents: raw.totalEvents ?? 0,
  }
}

// ================================================================ schema hints

/** List every data source the current tenant can build a report over. */
export async function listReportSources(): Promise<ReportSourceHint[]> {
  const sources = await apiGet<ReportSourceHint[]>('/reports/_/sources')
  // Built-in facility sources carry English names from the server.
  return sources.map((s) =>
    s.facilityEntity ? { ...s, name: facilityEntityName(s.facilityEntity, s.name) } : s,
  )
}

/** Fetch the field schema for one source (typed for tables, sampled for the rest). */
export async function getReportSourceSchema(sourceId: number): Promise<ReportSourceSchema> {
  const schema = await apiGet<ReportSourceSchema>(`/reports/_/sources/${sourceId}/fields`)
  if (!schema.facilityEntity) return schema
  return {
    ...schema,
    name: facilityEntityName(schema.facilityEntity, schema.name),
    fields: schema.fields.map((f) => ({ ...f, label: facilityFieldLabel(f.key, f.label) })),
  }
}

/** Response shape from POST /api/v1/demo/seed. Counts are the number
 *  of pieces THIS call created; zeros mean the piece already existed. */
export interface DemoSeedResponse {
  tableId: number
  tableName: string
  sourcesCreated: number
  rowsCreated: number
  reportsCreated: number
  alreadySeeded: boolean
}

/** Trigger the one-shot demo seed — creates a warehouse-events table
 *  with ~120 rows plus three v2 reports if they don't exist yet. Safe
 *  to call multiple times; pieces that already exist are skipped. */
export async function seedDemoReports(): Promise<DemoSeedResponse> {
  return apiPost<DemoSeedResponse>('/demo/seed', {})
}

// ================================================================ formatters

/**
 * Human-friendly value formatter shared by KPI + table widgets. Picks
 * a sensible default per column type when `format` is unset.
 */
export function formatReportValue(
  value: unknown,
  type: ReportFieldType,
  format?: string,
  locale = 'en',
): string {
  if (value === null || value === undefined) return '—'
  const fmt = format ?? autoFormat(type)
  switch (fmt) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n.toLocaleString(locale) : String(value)
    }
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n)
        ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(n)
        : String(value)
    }
    case 'currency': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n)
        ? new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n)
        : String(value)
    }
    case 'date': {
      const d = new Date(String(value))
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString(locale)
    }
    case 'datetime': {
      const d = new Date(String(value))
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString(locale)
    }
    default:
      return String(value)
  }
}

function autoFormat(type: ReportFieldType): string {
  switch (type) {
    case 'number':
      return 'number'
    case 'date':
      return 'date'
    case 'datetime':
      return 'datetime'
    default:
      return 'text'
  }
}

/**
 * Compute a footer aggregation for one column's numeric values.
 * Returns null when no rows carry finite numeric data — the widget
 * uses this to decide whether to render a footer cell at all.
 */
export function computeFooter(
  values: unknown[],
  fn: NonNullable<TableColumnConfig['footer']>,
): number | null {
  if (fn === 'count') return values.length
  const nums = values
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((n) => Number.isFinite(n))
  if (nums.length === 0) return null
  switch (fn) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0)
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length
    case 'min':
      return Math.min(...nums)
    case 'max':
      return Math.max(...nums)
    default:
      return null
  }
}

/**
 * A leaf condition whose value is empty is treated as a runtime PROMPT
 * — the viewer surfaces it as a filter chip the user can fill in.
 * Ops that don't need a value (isnull / notnull) are never prompts.
 */
export function isPromptFilter(cond: FilterCond): boolean {
  if (cond.op === 'isnull' || cond.op === 'notnull') return false
  const v = cond.value
  if (v === undefined || v === null) return true
  if (typeof v === 'string' && v.trim() === '') return true
  if (Array.isArray(v) && v.length === 0) return true
  return false
}

/**
 * Walk a filter tree and return every leaf condition that is currently
 * a prompt (empty value). Used by the viewer to build the runtime
 * filter bar. Path is a `.`-joined breadcrumb useful for stable input
 * ids but isn't semantically meaningful.
 */
export function collectPromptFilters(
  node: FilterNode | undefined,
  path: string = 'root',
): Array<{ path: string; cond: FilterCond }> {
  if (!node) return []
  const out: Array<{ path: string; cond: FilterCond }> = []
  if (node.and) {
    node.and.forEach((child, i) => {
      out.push(...collectPromptFilters(child, `${path}.and.${i}`))
    })
  }
  if (node.or) {
    node.or.forEach((child, i) => {
      out.push(...collectPromptFilters(child, `${path}.or.${i}`))
    })
  }
  if (node.cond && isPromptFilter(node.cond)) {
    out.push({ path, cond: node.cond })
  }
  return out
}

/**
 * Merge runtime user-entered values back into the filter tree so the
 * executor sees a complete spec. Runtime values are keyed by the same
 * path `collectPromptFilters` returned. Non-prompt conditions and
 * unfilled prompts are returned unchanged.
 */
export function applyRuntimeValues(
  node: FilterNode | undefined,
  values: Record<string, unknown>,
): FilterNode | undefined {
  if (!node) return undefined
  return walkAndReplace(node, 'root', values)
}

function walkAndReplace(
  node: FilterNode,
  path: string,
  values: Record<string, unknown>,
): FilterNode {
  if (node.and) {
    return {
      and: node.and.map((child, i) => walkAndReplace(child, `${path}.and.${i}`, values)),
    }
  }
  if (node.or) {
    return {
      or: node.or.map((child, i) => walkAndReplace(child, `${path}.or.${i}`, values)),
    }
  }
  if (node.cond) {
    const rt = values[path]
    if (rt !== undefined && rt !== '' && !(Array.isArray(rt) && rt.length === 0)) {
      return { cond: { ...node.cond, value: rt } }
    }
    return node
  }
  return node
}

/**
 * Evaluate one conditional rule against a scalar. Used by the table
 * widget to decide per-cell class overrides.
 */
export function evalCondition(cond: WidgetCondition, value: unknown): boolean {
  if (value === null || value === undefined) return false
  switch (cond.op) {
    case 'eq':
      return String(value) === String(cond.value)
    case 'neq':
      return String(value) !== String(cond.value)
    case 'gt':
      return Number(value) > Number(cond.value)
    case 'gte':
      return Number(value) >= Number(cond.value)
    case 'lt':
      return Number(value) < Number(cond.value)
    case 'lte':
      return Number(value) <= Number(cond.value)
    case 'contains':
      return String(value).toLowerCase().includes(String(cond.value).toLowerCase())
    default:
      return false
  }
}

// ================================================================ helpers

/**
 * Classify a report for the directory filter chips. The chip is UI
 * sugar — a report doesn't have a stored "kind"; the classification is
 * derived from which widgets dominate its spec.
 */
export type ReportClass = 'summary' | 'detail' | 'map' | 'history' | 'mixed'

const TABLE_KINDS = new Set(['table', 'dataTable', 'editableTable', 'facilityExplorer'])
const SUMMARY_KINDS = new Set(['kpi', 'bigValue', 'line', 'bar', 'area', 'pie', 'donut', 'scatter', 'heatmap', 'sankey', 'dimensionGrid'])

export function classifyReport(spec: ReportSpec): ReportClass {
  // Text, notes and dividers frame a report; they don't make it a
  // different kind. Only the widgets that show data count — and both
  // v1 (`kpi`, `table`) and v2 (`bigValue`, `dataTable`) kinds, or nearly
  // every v2 report fell through to "mixed".
  const kinds = (spec.widgets ?? []).map((w) => w.kind as string).filter((k) => !isPresentationOnly(k as WidgetKindV2))
  const total = kinds.length
  if (total === 0) return 'mixed'
  const count = (pred: (k: string) => boolean) => kinds.filter(pred).length
  if (count((k) => k === 'map') === total) return 'map'
  if (count((k) => k === 'history') / total >= 0.5) return 'history'
  if (count((k) => TABLE_KINDS.has(k)) / total >= 0.5) return 'detail'
  if (count((k) => SUMMARY_KINDS.has(k)) / total >= 0.6) return 'summary'
  return 'mixed'
}
