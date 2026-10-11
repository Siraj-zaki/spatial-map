/**
 * Two-way bridge between the wizard draft and the persisted v2 spec.
 *
 *   loadDraft(report)     — pull a saved report into wizard fields.
 *   toV2Spec(draft)       — flatten wizard fields to a saveable spec.
 *
 * The wizard is intentionally lossy compared to the spec (a spec can
 * carry many queries + widgets that don't fit the wizard's linear
 * model); when a saved spec is loaded we take its **primary query**
 * (the one referenced by the auto-generated primary widget) and fold
 * that into the wizard fields, while carrying any extra widgets +
 * queries verbatim in `draft.extraWidgets` + a hidden "extraQueries"
 * bag on save.
 */
import { applyViewerFilters, isViewerFilterQuery, stripViewerFilters } from '@/lib/reports/viewer-filters'
import { compileExplorer, readExplorerBindings } from '@/lib/reports/explorer-spec'
import type { Report, ReportSourceRef } from '@/lib/reports-client'
import type {
  ReportQueryV2,
  ReportSpecV2,
  ReportWidgetV2,
} from '@/lib/reports/v2-types'
import { migrateToV2 } from '@/lib/reports/spec-migrate'
import type { ComputedColumn } from '@/lib/reports/computed-columns'
import { emptyDraft, type SummaryChartKind, type WizardDraft } from './wizard-state'

const SUMMARY_CHART_KINDS: readonly SummaryChartKind[] = ['bar', 'line', 'area', 'pie', 'donut']
function isSummaryChartKind(k: unknown): k is SummaryChartKind {
  return typeof k === 'string' && (SUMMARY_CHART_KINDS as readonly string[]).includes(k)
}

/** Palette used to tone the auto-generated Summary KPI cards so a
 *  4-metric strip reads without being visually monotonous. */
const KPI_TONES = ['blue', 'purple', 'emerald', 'amber'] as const

/** Name of the query the wizard synthesises as the primary data
 *  source. Stable so re-saves round-trip cleanly. */
export const PRIMARY_QUERY_NAME = 'primary'
/** Summary path pairs the grouped `primary` query with an ungrouped
 *  `totals` query — same source + filters, no groupBy — used by the
 *  auto-generated KPI strip so it always shows the grand totals. */
export const TOTALS_QUERY_NAME = 'totals'

/** Load an existing report into wizard state. Missing fields default
 *  to their empty draft values so partially-configured specs still
 *  open cleanly. */
export function loadDraft(report: Report | null): WizardDraft {
  const base = emptyDraft()
  if (!report) return base
  const spec = migrateToV2(report.spec)
  const primary = spec.queries?.find((q) => q.name === PRIMARY_QUERY_NAME) ?? spec.queries?.[0]

  base.reportId = report.id
  base.name = report.name
  base.description = report.description ?? ''
  base.icon = report.icon ?? ''
  base.color = report.color ?? ''
  base.reportType = spec.reportType ?? inferReportType(spec)
  base.zoneId = report.zoneId ?? null
  base.sourceRef = primary?.sourceRef ?? spec.sources?.[0] ?? null
  base.filters = primary?.filters
  base.sort = primary?.sort ?? []
  base.limit = primary?.limit ?? 500
  base.groupBy = primary?.groupBy ?? []
  base.metrics = primary?.metrics ?? []
  // Computed columns live on the primary query; recover them into
  // draft state so the wizard's Custom-Columns step edits the same
  // list on next save.
  base.computedColumns = ((primary?.computedColumns ?? []) as ComputedColumn[]).filter(Boolean)
  base.params = spec.params ?? []
  base.layout = spec.layout ?? { kind: 'document' }
  base.origin = spec.origin
  // Viewer filters live in their own list; their params, option queries
  // and injected conditions are regenerated on save (see toV2Spec).
  base.viewerFilters = spec.viewerFilters ?? []
  const vfIds = new Set(base.viewerFilters.map((f) => f.id))
  base.params = base.params.filter((p) => !vfIds.has(p.id))
  base.filters = stripViewerFilters(base.filters)
  base.permissions = (report.permissions ?? []).map((p) => ({ userId: p.userId, canEdit: p.canEdit }))

  // Try to recover column selection + config from the primary widget
  // (if it's a dataTable). Otherwise leave empty and the columns step
  // will start from "all fields".
  const primaryWidget = spec.widgets?.find(
    (w) => w.queryRef === (primary?.name ?? PRIMARY_QUERY_NAME) && (w.kind === 'dataTable' || w.kind === 'table' || w.kind === 'editableTable'),
  )
  const b = (primaryWidget?.bindings ?? {}) as {
    columns?: string[]
    columnConfig?: WizardDraft['columnConfig']
    editableColumns?: string[]
    bulkEditable?: boolean
  }
  base.columns = b.columns ?? []
  base.columnConfig = b.columnConfig ?? {}
  base.editableColumns = b.editableColumns ?? []
  base.bulkEditable = Boolean(b.bulkEditable)
  // Conditional formatting rules already live inside columnConfig[col].conditions.
  const conditions: WizardDraft['conditions'] = {}
  for (const [col, cfg] of Object.entries(base.columnConfig)) {
    if (cfg.conditions?.length) conditions[col] = cfg.conditions
  }
  base.conditions = conditions

  // For Summary, the auto-generated bundle emits KPI cards + a
  // primary chart together. Recover the chart kind (defaults to bar)
  // and treat both the KPI strip and the chart as "primary" so they
  // don't pollute extraWidgets on re-edit.
  const summaryChartWidget = spec.widgets?.find(
    (w) => w.queryRef === PRIMARY_QUERY_NAME && isSummaryChartKind(w.kind),
  )
  if (base.reportType === 'summary' && isSummaryChartKind(summaryChartWidget?.kind)) {
    base.primaryChartKind = summaryChartWidget.kind
  }
  const summaryKpiIds = new Set(
    (spec.widgets ?? [])
      .filter((w) => w.queryRef === TOTALS_QUERY_NAME && (w.kind === 'bigValue' || w.kind === 'kpi'))
      .map((w) => w.id),
  )
  const primaryIds = new Set<string>()
  if (primaryWidget) primaryIds.add(primaryWidget.id)
  if (summaryChartWidget) primaryIds.add(summaryChartWidget.id)
  for (const id of summaryKpiIds) primaryIds.add(id)
  // History bundle widgets use stable ids from buildHistoryPrimary;
  // treat both as primary so a re-save doesn't duplicate them into
  // extraWidgets.
  if (base.reportType === 'history') {
    for (const w of spec.widgets ?? []) {
      if (w.id === 'primary_history_chart' || w.id === 'primary_history_table') {
        primaryIds.add(w.id)
      }
    }
  }

  // The wizard names everything it generates `primary_…`. A spec with
  // widgets but none of those was authored elsewhere — even when its
  // queries happen to be called `primary` / `totals`, as the seeded ones
  // are — so keep it as it is instead of adding a bundle on save.
  base.generatePrimary = (spec.widgets ?? []).length === 0 || (spec.widgets ?? []).some((w) => w.id.startsWith('primary_'))
  if (!base.generatePrimary) primaryIds.clear()
  base.extraWidgets = (spec.widgets ?? []).filter((w) => !primaryIds.has(w.id))
  // Freshly loaded specs render every widget — hidden widgets don't
  // survive a save, they're only draft-level metadata the Layout
  // step manages while the wizard is open.
  base.hiddenWidgetIds = []

  // User-defined queries — anything not primary / totals AND not a
  // widget-owned synthesized query (`w_<widget-id>`). The synthesized
  // ones are recovered via `widget.data`, not the extraQueries list.
  base.extraQueries = (spec.queries ?? [])
    .filter(
      (q) =>
        (!base.generatePrimary || (q.name !== PRIMARY_QUERY_NAME && q.name !== TOTALS_QUERY_NAME)) &&
        !q.name.startsWith('w_') &&
        !isViewerFilterQuery(q.name),
    )
    .map((q) => ({ ...q, filters: stripViewerFilters(q.filters) }))

  return base
}

/** Flatten the wizard draft to a v2 spec ready for the CRUD endpoint. */
export function toV2Spec(draft: WizardDraft): ReportSpecV2 {
  const sourceRef = draft.sourceRef ?? { kind: 'dataSource' as const, id: 0 }

  const primary: ReportQueryV2 = {
    name: PRIMARY_QUERY_NAME,
    sourceRef,
    filters: draft.filters,
    sort: draft.sort,
    limit: draft.limit,
    groupBy: draft.reportType === 'summary' ? draft.groupBy : undefined,
    metrics: draft.reportType === 'summary' ? draft.metrics : undefined,
    computedColumns: draft.computedColumns.length > 0 ? draft.computedColumns : undefined,
  }

  const queries: ReportQueryV2[] = draft.generatePrimary ? [primary] : []
  const columnConfig = mergeConditionsIntoConfig(draft.columnConfig, draft.conditions)
  const primaryWidgets: ReportWidgetV2[] = []

  if (!draft.generatePrimary) {
    // Authored outside the wizard: no bundle to emit.
  } else if (draft.reportType === 'summary') {
    // Summary emits an ungrouped totals query so the KPI strip shows
    // grand totals independent of how the chart slices the data.
    const totals: ReportQueryV2 = {
      name: TOTALS_QUERY_NAME,
      sourceRef,
      filters: draft.filters,
      metrics: draft.metrics,
      limit: 1,
    }
    queries.push(totals)
    primaryWidgets.push(...buildSummaryPrimary(draft))
  } else if (draft.reportType === 'history') {
    primaryWidgets.push(...buildHistoryPrimary(draft, columnConfig))
  } else {
    primaryWidgets.push(buildPrimaryWidget(draft, columnConfig))
  }

  // User-defined extra queries — always share the report's source,
  // so we normalise the sourceRef here rather than trusting whatever
  // the draft happens to hold. Auto-generated names (primary / totals)
  // are filtered out to prevent collisions with the emitted bundle.
  const allSources: ReportSourceRef[] = [sourceRef]
  const addSource = (s: ReportSourceRef) => {
    if (!allSources.some((x) => x.id === s.id && x.kind === s.kind)) allSources.push(s)
  }
  for (const q of draft.extraQueries) {
    if (!q.name.trim()) continue
    if (!draft.generatePrimary) {
      // Keep each query's own source: a hand-authored report can read
      // several (Store Overview reads four), and re-pointing them all at
      // one broke every widget on save.
      queries.push(q)
      if (q.sourceRef) addSource(q.sourceRef)
      continue
    }
    if (q.name === PRIMARY_QUERY_NAME || q.name === TOTALS_QUERY_NAME) continue
    queries.push({ ...q, sourceRef })
  }

  // Emit a private per-widget query for every extraWidget that
  // declares its own `data`. The widget's `queryRef` is normalised
  // to `w_<id>` so the runtime dispatches to the synthesized query.
  // Widgets without `data` are left as-is (they bind to primary /
  // totals / a named extra like the old model). Widgets whose id is
  // in `hiddenWidgetIds` are dropped entirely — user removed them
  // from the layout via the palette without deleting the config.
  const hidden = new Set(draft.hiddenWidgetIds)
  const finalisedExtraWidgets: ReportWidgetV2[] = []
  for (const w of draft.extraWidgets) {
    if (hidden.has(w.id)) continue
    if (w.kind === 'facilityExplorer') {
      // Each tab reads its own query, written here (see explorer-spec.ts).
      const compiled = compileExplorer(w, new Set(queries.map((q) => q.name)))
      queries.push(...compiled.queries)
      for (const tab of readExplorerBindings(compiled.widget).tabs) {
        if (tab.sourceId) addSource({ kind: 'dataSource', id: tab.sourceId })
      }
      finalisedExtraWidgets.push(compiled.widget)
      continue
    }
    if (!w.data) {
      finalisedExtraWidgets.push(w)
      continue
    }
    const queryName = `w_${w.id}`
    const widgetSource = w.data.sourceRef ?? sourceRef
    const synthesised: ReportQueryV2 = {
      name: queryName,
      sourceRef: widgetSource,
      filters: w.data.filters,
      sort: w.data.sort,
      limit: w.data.limit,
      groupBy: w.data.agg === 'aggregate' ? w.data.groupBy : undefined,
      metrics: w.data.agg === 'aggregate' ? w.data.metrics : undefined,
    }
    queries.push(synthesised)
    addSource(widgetSource)
    // Store the widget with queryRef normalised — data stays on the
    // widget so loadDraft can round-trip the UI state without diffing
    // back out of the query.
    finalisedExtraWidgets.push({ ...w, queryRef: queryName })
  }

  // Apply user's position overrides (set by the Layout step's canvas
  // editor). Auto-generated primary widgets get their positions
  // stomped on every save; overrides let user placement survive.
  const overrides = draft.layout?.widgetPositions ?? {}
  const applyOverride = (w: ReportWidgetV2): ReportWidgetV2 => {
    const pos = overrides[w.id]
    return pos ? { ...w, position: pos } : w
  }
  const finalWidgets = [...primaryWidgets, ...finalisedExtraWidgets].map(applyOverride)

  // Viewer filters: inject their conditions into every query on their
  // sources and add their params + option queries.
  const compiled = applyViewerFilters(queries, draft.params, draft.viewerFilters)

  return {
    v: 2,
    reportType: draft.reportType,
    sources: allSources,
    params: compiled.params,
    ...(draft.viewerFilters.length ? { viewerFilters: draft.viewerFilters } : {}),
    queries: compiled.queries,
    layout: draft.layout,
    widgets: finalWidgets,
    ...(draft.origin ? { origin: draft.origin } : {}),
  }
}

/** Fold the wizard's separately-tracked per-column conditions back
 *  into the widget's TableColumnConfig so downstream renderers see
 *  the merged view. */
function mergeConditionsIntoConfig(
  base: WizardDraft['columnConfig'],
  conditions: WizardDraft['conditions'],
): WizardDraft['columnConfig'] {
  const out: WizardDraft['columnConfig'] = { ...base }
  for (const [col, rules] of Object.entries(conditions)) {
    out[col] = { ...(out[col] ?? {}), conditions: rules }
  }
  return out
}

/** Auto-generate the primary widget for report types that use a
 *  single widget (Detail, Editable, History). Summary uses
 *  [buildSummaryPrimary] instead because it emits multiple widgets. */
function buildPrimaryWidget(
  draft: WizardDraft,
  columnConfig: WizardDraft['columnConfig'],
): ReportWidgetV2 {
  const idBase = `primary_${draft.reportType}`
  // Include computed columns that the user hasn't already added to
  // `draft.columns` — otherwise a report with a computed column would
  // show it only in `columnConfig` metadata, never as a real column.
  const columnsWithComputed = withComputed(draft)
  switch (draft.reportType) {
    case 'editable':
      return {
        id: idBase,
        kind: 'editableTable',
        title: draft.name || 'Records',
        queryRef: PRIMARY_QUERY_NAME,
        position: { x: 0, y: 0, w: 12, h: 8 },
        order: 10,
        bindings: {
          sourceId: draft.sourceRef?.id ?? 0,
          columns: columnsWithComputed,
          columnConfig,
          editableColumns: draft.editableColumns,
          bulkEditable: draft.bulkEditable,
        },
      }
    case 'detail':
    default:
      return {
        id: idBase,
        kind: 'dataTable',
        title: draft.name || 'Records',
        queryRef: PRIMARY_QUERY_NAME,
        position: { x: 0, y: 0, w: 12, h: 8 },
        order: 10,
        bindings: {
          columns: columnsWithComputed,
          columnConfig,
          pageSize: Math.min(50, Math.max(10, draft.limit)),
          searchable: true,
          columnToggle: true,
        },
      }
  }
}

/** Combine the user-picked source columns with any declared computed
 *  columns that aren't already in the list. Preserves the user's
 *  ordering for source columns; computed columns append at the end. */
function withComputed(draft: WizardDraft): string[] {
  const seen = new Set(draft.columns)
  const out = [...draft.columns]
  for (const c of draft.computedColumns) {
    if (c.name && !seen.has(c.name)) {
      out.push(c.name)
      seen.add(c.name)
    }
  }
  return out
}

/** Build the Summary path's primary bundle: one KPI card per metric
 *  reading from the `totals` query, plus the chosen chart type
 *  reading from `primary`. Ordering places KPIs first (order 5) and
 *  the chart directly below (order 10) so extras land after both. */
function buildSummaryPrimary(draft: WizardDraft): ReportWidgetV2[] {
  const widgets: ReportWidgetV2[] = []
  // KPI strip — cap at 4 cards; extras (if the user configured more
  // than 4 metrics) still available from the totals query for a
  // hand-added widget in the Widgets step.
  const kpiMetrics = draft.metrics.slice(0, 4)
  kpiMetrics.forEach((m, idx) => {
    widgets.push({
      id: `primary_summary_kpi_${idx}`,
      kind: 'bigValue',
      title: metricLabel(m),
      queryRef: TOTALS_QUERY_NAME,
      position: { x: idx * 3, y: 0, w: 3, h: 2 },
      order: 5 + idx * 0.01, // keep KPIs before the chart, deterministic across saves
      columnSpan: 2,
      bindings: {
        value: m.as,
        label: metricLabel(m),
        tone: KPI_TONES[idx % KPI_TONES.length],
        format: m.fn === 'avg' ? 'number' : 'number',
      },
    })
  })
  // Primary chart — bar / line / area take multiple series; pie /
  // donut render the first metric only.
  const chartKind = draft.primaryChartKind
  const seriesForChart = chartKind === 'pie' || chartKind === 'donut'
    ? draft.metrics.slice(0, 1).map((m) => m.as)
    : draft.metrics.map((m) => m.as)
  widgets.push({
    id: 'primary_summary_chart',
    kind: chartKind,
    title: chartTitle(draft, chartKind),
    queryRef: PRIMARY_QUERY_NAME,
    position: { x: 0, y: 2, w: 12, h: 6 },
    order: 10,
    bindings: {
      xAxis: draft.groupBy[0],
      series: seriesForChart,
    },
  })
  return widgets
}

/** Build the History path's primary bundle: a line chart plotted
 *  over the configured time field on top, and a dataTable of the raw
 *  events underneath. Mirrors the Summary bundle's ordering
 *  convention — chart at order 5, table at order 10 — so extras land
 *  after both without a re-order dance.
 *
 *  Numeric-looking columns become chart series; if none look
 *  numeric the chart falls back to the first non-time column so the
 *  spec still validates and the user can retune series in the
 *  Widgets step. */
function buildHistoryPrimary(
  draft: WizardDraft,
  columnConfig: WizardDraft['columnConfig'],
): ReportWidgetV2[] {
  const timeField = draft.timeField ?? draft.columns[0]
  const seriesCandidates = draft.columns.filter((c) => c !== timeField)
  const series = seriesCandidates.length > 0 ? seriesCandidates.slice(0, 4) : []
  return [
    {
      id: 'primary_history_chart',
      kind: 'line',
      title: draft.name ? `${draft.name} — trend` : 'Trend',
      queryRef: PRIMARY_QUERY_NAME,
      position: { x: 0, y: 0, w: 12, h: 6 },
      order: 5,
      bindings: {
        xAxis: timeField,
        series,
      },
    },
    {
      id: 'primary_history_table',
      kind: 'dataTable',
      title: draft.name ? `${draft.name} — records` : 'Records',
      queryRef: PRIMARY_QUERY_NAME,
      position: { x: 0, y: 6, w: 12, h: 6 },
      order: 10,
      bindings: {
        columns: withComputed(draft),
        columnConfig,
        pageSize: Math.min(50, Math.max(10, draft.limit)),
        searchable: true,
        columnToggle: true,
      },
    },
  ]
}

/** Human-friendly title for a metric. Falls back to the alias when
 *  no field is set (count-* fns). */
function metricLabel(m: { fn: string; field?: string; as: string }): string {
  if (m.field) return `${m.fn}(${m.field})`
  return `${m.fn} · ${m.as}`
}

/** Title suggestion for the primary chart — draft name if set,
 *  else something descriptive. */
function chartTitle(draft: WizardDraft, kind: SummaryChartKind): string {
  if (draft.name) return draft.name
  const dim = draft.groupBy[0] ?? 'group'
  return `${kind === 'pie' || kind === 'donut' ? 'Share' : 'By'} ${dim}`
}

/** Recover a report type from a spec that has no explicit
 *  `reportType` — legacy specs migrated from v1 fall here. */
function inferReportType(spec: ReportSpecV2): WizardDraft['reportType'] {
  const q = spec.queries?.[0]
  if (q?.metrics?.length && q.groupBy?.length) return 'summary'
  const anyHistory = spec.widgets?.some((w) => w.kind === 'history' || w.kind === 'line')
  if (anyHistory) return 'history'
  const anyEditable = spec.widgets?.some((w) => w.kind === 'editableTable')
  if (anyEditable) return 'editable'
  return 'detail'
}
