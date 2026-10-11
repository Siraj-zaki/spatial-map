/**
 * Turns a report on screen into an export document every writer shares
 * (CSV, Excel, JSON, PDF print view): per widget its columns (label, type,
 * format, alignment), rows as raw value + display text + conditional tone,
 * table footers, KPI values, text blocks, plus the report's filters.
 *
 * Built from what the report has loaded (each query's rows, up to its
 * limit). Scope "view" applies a table's on-screen search / sort / hidden
 * columns (`view-state.ts`); "all" exports every loaded row.
 */

import {
  computeFooter,
  evalCondition,
  formatReportValue,
  type ChartBindings,
  type KpiBindings,
  type ReportFieldType,
  type TableBindings,
  type TableColumnConfig,
} from '@/lib/reports-client'
import type { QueryRunResult } from '@/lib/reports-client'
import { conditionStyleFor } from '@/lib/reports/condition-styles'
import { humanizeColumn } from '@/lib/reports/humanize-column'
import type { ReportParam, ReportSpecV2, ReportWidgetV2 } from '@/lib/reports/v2-types'
import type { ParamState } from '@/lib/reports/report-runtime-store'
import { widgetView } from './view-state'

export type ExportScope = 'view' | 'all'

export interface ExportColumn {
  key: string
  label: string
  type: ReportFieldType
  format?: string
  align: 'start' | 'end' | 'center'
}

export interface ExportCell {
  raw: unknown
  /** What the report shows ('' for empty). */
  text: string
  /** Conditional-formatting look (`CONDITION_STYLES` id), if a rule fired. */
  tone?: string
}

export interface ExportTable {
  columns: ExportColumn[]
  rows: ExportCell[][]
  footer?: (ExportCell | null)[]
}

export type ExportBlockType = 'table' | 'chart' | 'kpi' | 'text' | 'other'

export interface ExportBlock {
  widgetId: string
  title: string
  kind: string
  type: ExportBlockType
  /** Tables, and the data behind charts. */
  table?: ExportTable
  kpi?: { label: string; value: ExportCell; delta?: string }
  text?: string
  /** True when the query returned exactly its row limit — there may be more. */
  truncated: boolean
  limit?: number
}

export interface ExportDocument {
  report: {
    name: string
    description: string
    facility?: string
    generatedAt: Date
    locale: string
    filters: { label: string; value: string }[]
  }
  blocks: ExportBlock[]
}

export const DATA_KINDS = new Set(['table', 'dataTable', 'editableTable', 'kpi', 'bigValue', 'line', 'bar', 'area', 'pie', 'donut', 'scatter', 'heatmap'])
export const CHART_KINDS = new Set(['line', 'bar', 'area', 'pie', 'donut', 'scatter'])
const TEXT_KINDS = new Set(['markdown', 'note', 'alert'])

function blockType(kind: string): ExportBlockType {
  if (kind === 'table' || kind === 'dataTable' || kind === 'editableTable') return 'table'
  if (kind === 'kpi' || kind === 'bigValue') return 'kpi'
  if (CHART_KINDS.has(kind) || kind === 'heatmap') return 'chart'
  if (TEXT_KINDS.has(kind)) return 'text'
  return 'other'
}

function text(v: unknown, type: ReportFieldType, format: string | undefined, locale: string): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return formatReportValue(v, type, format, locale)
}

function alignFor(cfgAlign: string | undefined, type: ReportFieldType): ExportColumn['align'] {
  if (cfgAlign === 'right') return 'end'
  if (cfgAlign === 'center') return 'center'
  if (cfgAlign === 'left') return 'start'
  return type === 'number' ? 'end' : 'start'
}

function compare(av: unknown, bv: unknown): number {
  if (av === bv) return 0
  if (av === null || av === undefined) return 1
  if (bv === null || bv === undefined) return -1
  if (typeof av === 'number' && typeof bv === 'number') return av - bv
  return String(av).localeCompare(String(bv))
}

/** Rows a table shows for the scope: on-screen search + sort, or all loaded. */
function scopedRows(rows: unknown[][], q: QueryRunResult, widgetId: string, scope: ExportScope, searchCols: string[]): unknown[][] {
  if (scope === 'all') return rows
  const view = widgetView(widgetId)
  if (!view) return rows
  let out = rows
  if (view.search.trim()) {
    const needle = view.search.toLowerCase()
    const idx = searchCols.map((c) => q.columns.findIndex((col) => col.name === c)).filter((i) => i >= 0)
    out = out.filter((r) => idx.some((i) => String(r[i] ?? '').toLowerCase().includes(needle)))
  }
  if (view.sortColumn) {
    const i = q.columns.findIndex((c) => c.name === view.sortColumn)
    if (i >= 0) {
      const dir = view.sortDir === 'asc' ? 1 : -1
      out = [...out].sort((a, b) => compare(a[i], b[i]) * dir)
    }
  }
  return out
}

function tableBlock(widget: ReportWidgetV2, q: QueryRunResult, locale: string, scope: ExportScope): ExportTable {
  const b = (widget.bindings ?? {}) as TableBindings & { columnConfig?: Record<string, TableColumnConfig & { align?: string }> }
  const isClassic = widget.kind === 'table'
  const view = scope === 'view' ? widgetView(widget.id) : undefined
  const hidden = new Set(view?.hiddenColumns ?? [])
  const declared = b.columns?.length ? b.columns : q.columns.map((c) => c.name)
  const cols = declared
    .map((name) => ({ name, idx: q.columns.findIndex((c) => c.name === name), cfg: (b.columnConfig?.[name] ?? {}) as TableColumnConfig & { align?: string } }))
    .filter((c) => c.idx !== -1 && !c.cfg.hidden && !hidden.has(c.name))
  const columns: ExportColumn[] = cols.map((c) => {
    const type = q.columns[c.idx].type
    return {
      key: c.name,
      label: c.cfg.label ?? (isClassic ? c.name : humanizeColumn(c.name)),
      type,
      format: c.cfg.format,
      align: alignFor(c.cfg.align, type),
    }
  })
  const rows = scopedRows(q.rows, q, widget.id, scope, cols.map((c) => c.name))
  const cellRows = rows.map((r) =>
    cols.map((c, i): ExportCell => {
      const raw = r[c.idx]
      const cell: ExportCell = { raw, text: text(raw, columns[i].type, c.cfg.format, locale) }
      // Conditional formatting is a classic-table feature (as on screen).
      if (isClassic && c.cfg.conditions?.length) {
        const rule = c.cfg.conditions.find((cond) => evalCondition(cond, raw))
        const style = rule ? conditionStyleFor(rule.className) : undefined
        if (style) cell.tone = style.id
      }
      return cell
    }),
  )
  let footer: (ExportCell | null)[] | undefined
  if (isClassic && cols.some((c) => c.cfg.footer)) {
    footer = cols.map((c, i) => {
      if (!c.cfg.footer) return null
      const v = computeFooter(rows.map((r) => r[c.idx]), c.cfg.footer)
      return { raw: v, text: v == null ? '' : text(v, c.cfg.footer === 'count' ? 'number' : columns[i].type, c.cfg.footer === 'count' ? 'number' : c.cfg.format, locale) }
    })
  }
  return { columns, rows: cellRows, footer }
}

/** The data behind a chart, as a table of the columns it plots. */
function chartTable(widget: ReportWidgetV2, q: QueryRunResult, locale: string): ExportTable {
  const b = (widget.bindings ?? {}) as ChartBindings & { yAxis?: string; size?: string; value?: string }
  let keys: string[]
  if (widget.kind === 'pie' || widget.kind === 'donut') keys = [b.xAxis, b.series?.[0]].filter(Boolean) as string[]
  else if (widget.kind === 'scatter') keys = [b.xAxis, b.yAxis, b.size].filter(Boolean) as string[]
  else if (widget.kind === 'heatmap') keys = [b.xAxis, b.yAxis, b.value].filter(Boolean) as string[]
  else keys = [b.xAxis, ...(b.series ?? [])].filter(Boolean) as string[]
  const cols = keys.map((k) => ({ k, idx: q.columns.findIndex((c) => c.name === k) })).filter((c) => c.idx >= 0)
  const columns: ExportColumn[] = cols.map((c) => {
    const type = q.columns[c.idx].type
    return { key: c.k, label: humanizeColumn(c.k), type, align: alignFor(undefined, type) }
  })
  return {
    columns,
    rows: q.rows.map((r) => cols.map((c, i) => ({ raw: r[c.idx], text: text(r[c.idx], columns[i].type, undefined, locale) }))),
  }
}

function kpiValue(widget: ReportWidgetV2, q: QueryRunResult | undefined, locale: string): ExportBlock['kpi'] {
  const b = (widget.bindings ?? {}) as unknown as KpiBindings & { delta?: string; deltaFormat?: "percent" | "number" }
  const idx = q ? q.columns.findIndex((c) => c.name === b.value) : -1
  const row = q?.rows[b.rowIndex ?? 0]
  const raw = idx >= 0 && row ? row[idx] : null
  const type = idx >= 0 && q ? q.columns[idx].type : 'number'
  const shown = raw == null ? '' : `${b.prefix ?? ''}${formatReportValue(raw, type, b.format, locale)}${b.suffix ?? ''}`
  let delta: string | undefined
  if (b.delta && q && row) {
    const di = q.columns.findIndex((c) => c.name === b.delta)
    const dv = di >= 0 ? row[di] : null
    if (typeof dv === 'number') {
      delta =
        b.deltaFormat === 'number'
          ? `${dv > 0 ? '+' : ''}${dv.toLocaleString(locale)}`
          : `${dv > 0 ? '+' : ''}${new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(dv)}`
    }
  }
  return { label: b.label ?? widget.title ?? '', value: { raw, text: shown }, delta }
}

function widgetText(widget: ReportWidgetV2): string {
  const b = (widget.bindings ?? {}) as { content?: string }
  return (b.content ?? '').trim()
}

function paramText(v: unknown, locale: string): string {
  if (v === null || v === undefined || v === '') return ''
  if (Array.isArray(v)) return v.map((x) => paramText(x, locale)).join(', ')
  if (typeof v === 'boolean') return v ? '✓' : '✗'
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('from' in o || 'to' in o) return [paramText(o.from, locale), paramText(o.to, locale)].filter(Boolean).join(' – ')
    return JSON.stringify(v)
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return v.length > 10 ? d.toLocaleString(locale) : d.toLocaleDateString(locale)
  }
  return String(v)
}

export function buildExportDocument({
  report,
  spec,
  queryResults,
  params,
  locale,
  scope,
  facility,
  widgetIds,
  untitled,
}: {
  report: { name: string; description?: string }
  spec: ReportSpecV2
  queryResults: Record<string, QueryRunResult | undefined>
  params: Record<string, ParamState>
  locale: string
  scope: ExportScope
  facility?: string | null
  /** Only these widgets (in report order); all when omitted. */
  widgetIds?: string[]
  /** Title for a widget without one, e.g. "Widget 3". */
  untitled: (n: number) => string
}): ExportDocument {
  const limitOf = new Map((spec.queries ?? []).map((q) => [q.name, q.limit]))
  const want = widgetIds ? new Set(widgetIds) : null
  const blocks: ExportBlock[] = []
  ;(spec.widgets ?? []).forEach((w, i) => {
    if (want && !want.has(w.id)) return
    const type = blockType(w.kind)
    const q = w.queryRef ? queryResults[w.queryRef] : undefined
    const limit = w.queryRef ? limitOf.get(w.queryRef) : undefined
    const block: ExportBlock = {
      widgetId: w.id,
      title: w.title?.trim() || untitled(i + 1),
      kind: w.kind,
      type,
      // Only raw-row tables can be "cut off": charts and KPIs are usually
      // aggregated, and returning exactly `limit` groups is normal for them.
      truncated: type === 'table' && !!(q && limit && q.rowCount >= limit),
      limit,
    }
    if (type === 'table' && q) block.table = tableBlock(w, q, locale, scope)
    else if (type === 'chart' && q) block.table = chartTable(w, q, locale)
    else if (type === 'kpi') block.kpi = kpiValue(w, q, locale)
    else if (type === 'text') block.text = widgetText(w)
    blocks.push(block)
  })
  const declared: ReportParam[] = spec.params ?? []
  const filters = declared
    .map((p) => ({ label: p.label?.trim() || humanizeColumn(p.id), value: paramText(params[p.id]?.value, locale) }))
    .filter((f) => f.value !== '')
  return {
    report: {
      name: report.name,
      description: report.description ?? '',
      facility: facility ?? undefined,
      generatedAt: new Date(),
      locale,
      filters,
    },
    blocks,
  }
}

/** File-system-safe name (keeps letters of every script). */
export function safeFileName(name: string): string {
  const cleaned = name
    // Characters no file system accepts in a name, plus control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
  return cleaned.slice(0, 120) || 'report'
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}
