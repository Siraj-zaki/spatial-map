/**
 * Widget renderers for the Report Viewer. Phase 2 ships three:
 *   - KPI    — a single value plucked from the shaped result
 *   - Table  — a paginated + sortable projection of the shaped result
 *   - Markdown — free-form section headers / notes
 *
 * All three share the same input contract: `{ widget, result }` where
 * `result` is the response from `POST /reports/{id}/run`. Widgets that
 * can't resolve their bindings render a compact empty state instead of
 * crashing — a report where the source schema drifted still opens.
 *
 * Charts land in Phase 3 (shadcn/ui charts). Map + history land in
 * Phase 4. The `Widget` dispatch below returns a "coming soon" tile
 * for those kinds so a saved spec with a chart widget still renders
 * cleanly during the phased rollout.
 */

import { useEffect, useMemo, useState } from 'react'
import { forgetWidgetView, publishWidgetView } from './export/view-state'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FileBarChart,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ChartWidget } from '@/components/reports/chart-widgets'
import { HistoryWidget } from '@/components/reports/history-widget'
import { AlertWidget } from '@/components/reports/widgets/alert-widget'
import { BigValueWidget } from '@/components/reports/widgets/big-value-widget'
import { DataTableWidget } from '@/components/reports/widgets/data-table-widget'
import { EditableTableWidget } from '@/components/reports/widgets/editable-table-widget'
import { HeatmapWidget } from '@/components/reports/widgets/heatmap-widget'
import { FacilityExplorerWidget } from '@/components/reports/widgets/facility-explorer/facility-explorer-widget'
import { MapWidget } from '@/components/reports/widgets/map-widget'
import { NoteWidget } from '@/components/reports/widgets/note-widget'
import { ScatterWidget } from '@/components/reports/widgets/scatter-widget'
import {
  computeFooter,
  evalCondition,
  formatReportValue,
  type KpiBindings,
  type MarkdownBindings,
  type ReportFieldType,
  type ReportSpec,
  type ReportWidget,
  type RunColumn,
  type RunReportResult,
  type TableBindings,
  type TableColumnConfig,
  type WidgetCondition,
} from '@/lib/reports-client'
import { themeClass } from '@/lib/reports/condition-styles'

// ================================================================ shared

// Same tone → chart-token mapping as BigValueWidget, shown as a dot.
const TONES = {
  blue: 'bg-[hsl(var(--chart-1))]',
  emerald: 'bg-[hsl(var(--chart-2))]',
  purple: 'bg-[hsl(var(--chart-3))]',
  amber: 'bg-[hsl(var(--chart-4))]',
} as const

type Tone = keyof typeof TONES

/**
 * Resolve one column index by name. Returns -1 for a column the
 * result doesn't carry — callers use that to render an "unbound" state.
 */
function columnIndex(cols: RunColumn[], name?: string): number {
  if (!name) return -1
  return cols.findIndex((c) => c.name === name)
}

/**
 * Turn a widget's declared conditions into the first Tailwind class
 * that fires, or undefined. Only the first matching rule applies so
 * the class order in `conditions` is meaningful.
 */
function firstMatchingClass(
  conditions: WidgetCondition[] | undefined,
  columnValue: unknown,
): string | undefined {
  if (!conditions?.length) return undefined
  for (const c of conditions) {
    if (evalCondition(c, columnValue)) return sanitizeClass(themeClass(c.className))
  }
  return undefined
}

/**
 * Guard against arbitrary class strings landing in the DOM — only allow
 * tokens matching the shape of Tailwind classes we already ship. This
 * keeps user-authored condition rules from injecting arbitrary CSS.
 */
function sanitizeClass(cls: string): string {
  return cls
    .split(/\s+/)
    .filter((tok) => /^[a-z0-9:/\-[\]#.]+$/i.test(tok))
    .join(' ')
}

// ================================================================ KPI

function KpiWidget({
  widget,
  result,
  locale,
}: {
  widget: ReportWidget
  result: RunReportResult
  locale: string
}) {
  const { t } = useTranslation()
  const bindings = (widget.bindings ?? {}) as KpiBindings
  const valueIdx = columnIndex(result.columns, bindings.value)
  const labelIdx = columnIndex(result.columns, bindings.label)
  const rowIndex = bindings.rowIndex ?? 0
  const row = result.rows[rowIndex]
  const tone: Tone = bindings.tone && TONES[bindings.tone] ? bindings.tone : 'blue'
  const palette = TONES[tone]

  const isUnbound = valueIdx === -1
  const rawValue = row ? row[valueIdx] : undefined
  const valueCol = valueIdx >= 0 ? result.columns[valueIdx] : undefined
  const formatted = valueCol
    ? formatReportValue(rawValue, valueCol.type, bindings.format, locale)
    : ''
  const label = labelIdx >= 0 && row ? String(row[labelIdx] ?? '') : undefined

  return (
    <div className="flex h-full min-h-[6.5rem] flex-col justify-center rounded-xl border bg-card px-5 py-4 text-card-foreground shadow-sm">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', palette)} aria-hidden />
        <span className="truncate">
          {widget.title ??
            (bindings.value ? bindings.value : t('reports.widgetKpiUntitled', { defaultValue: 'KPI' }))}
        </span>
      </div>
      {isUnbound ? (
        <p className="text-sm text-muted-foreground">
          {t('reports.widgetUnbound', {
            defaultValue: 'Column "{{col}}" not in result',
            col: bindings.value ?? '—',
          })}
        </p>
      ) : (
        <p className="truncate text-[28px] font-semibold leading-none tracking-tight tabular-nums">
          {bindings.prefix ?? ''}
          {formatted}
          {bindings.suffix ?? ''}
        </p>
      )}
      {label && !isUnbound && <p className="mt-1.5 truncate text-xs text-muted-foreground">{label}</p>}
    </div>
  )
}

// ================================================================ Table

function TableWidget({
  widget,
  result,
  locale,
}: {
  widget: ReportWidget
  result: RunReportResult
  locale: string
}) {
  const { t } = useTranslation()
  const bindings = (widget.bindings ?? {}) as TableBindings
  const pageSize = Math.max(5, Math.min(bindings.pageSize ?? 25, 200))
  const [page, setPage] = useState(0)
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  // Which columns to render, in order. `bindings.columns` picks + orders;
  // absent means "every column in the shaped result".
  const visibleColumns = useMemo(() => {
    const requested = bindings.columns?.length
      ? bindings.columns
      : result.columns.map((c) => c.name)
    return requested
      .map((name) => {
        const idx = columnIndex(result.columns, name)
        const cfg = (bindings.columnConfig?.[name] ?? {}) as TableColumnConfig
        return { name, idx, cfg, col: result.columns[idx] }
      })
      .filter((c) => c.idx !== -1 && !c.cfg.hidden)
  }, [bindings.columns, bindings.columnConfig, result.columns])

  const sortedRows = useMemo(() => {
    if (!sortColumn) return result.rows
    const idx = columnIndex(result.columns, sortColumn)
    if (idx === -1) return result.rows
    const dir = sortDir === 'asc' ? 1 : -1
    const sorted = [...result.rows]
    sorted.sort((a, b) => {
      const av = a[idx]
      const bv = b[idx]
      if (av === bv) return 0
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
    return sorted
  }, [result.rows, result.columns, sortColumn, sortDir])

  // Let "Export what's on screen" follow the sort the user picked.
  useEffect(() => {
    if (!widget.id) return
    publishWidgetView(widget.id, { sortColumn, sortDir, search: '', hiddenColumns: [] })
    return () => forgetWidgetView(widget.id!)
  }, [widget.id, sortColumn, sortDir])

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const pageRows = sortedRows.slice(page * pageSize, page * pageSize + pageSize)

  const toggleSort = (name: string) => {
    if (sortColumn === name) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(name)
      setSortDir('asc')
    }
  }

  if (result.rows.length === 0) {
    return (
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        {widget.title && (
          <div className="px-4 py-3 border-b font-semibold text-sm">{widget.title}</div>
        )}
        <div className="text-center py-10 px-4 text-sm text-muted-foreground">
          {t('reports.widgetTableEmpty', {
            defaultValue: 'No rows match — try loosening the filters.',
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {widget.title && (
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <span className="font-semibold text-sm">{widget.title}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('reports.widgetTableRowCount', {
              defaultValue: '{{count}} rows',
              count: result.rows.length,
            })}
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b">
              {visibleColumns.map((c) => (
                <th
                  key={c.name}
                  className={cn(
                    'px-3 py-2 text-xs font-medium text-muted-foreground select-none',
                    c.cfg.align === 'right'
                      ? 'text-end'
                      : c.cfg.align === 'center'
                        ? 'text-center'
                        : 'text-start',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c.name)}
                    className={cn(
                      'group inline-flex items-center gap-1 transition-colors',
                      sortColumn === c.name ? 'text-foreground' : 'hover:text-foreground',
                    )}
                    title={t('reports.widgetTableSortHint', { defaultValue: 'Click to sort' })}
                  >
                    {c.cfg.label ?? c.name}
                    {sortColumn === c.name ? (
                      sortDir === 'asc' ? (
                        <ArrowUp className="w-3 h-3" aria-hidden />
                      ) : (
                        <ArrowDown className="w-3 h-3" aria-hidden />
                      )
                    ) : (
                      // Idle chevron — muted, appears on hover so the
                      // sortability of every column is discoverable
                      // without cluttering the resting-state header.
                      <ChevronsUpDown
                        className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity"
                        aria-hidden
                      />
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => (
              <tr key={ri} className="border-b last:border-b-0 hover:bg-muted/30">
                {visibleColumns.map((c) => {
                  const value = row[c.idx]
                  const conditionClass = firstMatchingClass(c.cfg.conditions, value)
                  const type: ReportFieldType = c.col?.type ?? 'text'
                  return (
                    <td
                      key={c.name}
                      className={cn(
                        'px-3 py-2',
                        c.cfg.align === 'right'
                          ? 'text-end'
                          : c.cfg.align === 'center'
                            ? 'text-center'
                            : 'text-start',
                        type === 'number' && !c.cfg.chip && 'tabular-nums',
                        !c.cfg.chip && conditionClass,
                      )}
                    >
                      {c.cfg.chip ? (
                        <ChipCell
                          value={value}
                          type={type}
                          format={c.cfg.format}
                          locale={locale}
                          extraClass={conditionClass}
                        />
                      ) : (
                        formatReportValue(value, type, c.cfg.format, locale)
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
          {/* Footer row: only rendered when at least one column asked
              for a footer aggregation. Aggregates run over the FULL
              sorted set (not just the current page) so the footer
              stays consistent as the user pages through. */}
          {visibleColumns.some((c) => c.cfg.footer) && (
            <tfoot>
              <tr className="border-t bg-muted/40 font-semibold">
                {visibleColumns.map((c) => {
                  if (!c.cfg.footer) {
                    return <td key={c.name} className="px-3 py-2" />
                  }
                  const values = sortedRows.map((r) => r[c.idx])
                  const agg = computeFooter(values, c.cfg.footer)
                  return (
                    <td
                      key={c.name}
                      className={cn(
                        'px-3 py-2 text-xs',
                        c.cfg.align === 'right'
                          ? 'text-end'
                          : c.cfg.align === 'center'
                            ? 'text-center'
                            : 'text-start',
                        'tabular-nums',
                      )}
                    >
                      <span className="text-[10px] uppercase text-muted-foreground me-1">
                        {c.cfg.footer}
                      </span>
                      {agg === null
                        ? '—'
                        : formatReportValue(agg, 'number', c.cfg.format, locale)}
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {/* Always render the pager so total-row count is always visible
          — a single page shows "Showing 1–N of N" with disabled prev/next.
          Without this, users read "no pagination" when a report simply
          fits on one page. */}
      <div className="flex items-center justify-between px-3 py-2 border-t bg-muted/20">
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('reports.widgetTablePageWindow', {
            defaultValue: 'Showing {{from}}–{{to}} of {{total}}',
            from: sortedRows.length === 0 ? 0 : page * pageSize + 1,
            to: Math.min(sortedRows.length, page * pageSize + pageSize),
            total: sortedRows.length,
          })}
        </span>
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('reports.widgetTablePage', {
              defaultValue: 'Page {{page}} of {{total}}',
              page: page + 1,
              total: pageCount,
            })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label={t('reports.widgetTablePrev', { defaultValue: 'Previous page' })}
          >
            <ChevronLeft className="w-4 h-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={page >= pageCount - 1}
            aria-label={t('reports.widgetTableNext', { defaultValue: 'Next page' })}
          >
            <ChevronRight className="w-4 h-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * ChipCell — renders one cell as a colored chip whose color is derived
 * deterministically from the value's string form. Same value → same
 * color across every row, which is the "status column" pattern from
 * Linear / Notion. Falls back to an empty dash for null/undefined so
 * missing values are visually quiet, not loud.
 *
 * The palette is anchored on Tailwind's HSL token pattern so chips
 * read cleanly in light + dark mode + every user-selected palette,
 * without hardcoding hex values.
 */
function ChipCell({
  value,
  type,
  format,
  locale,
  extraClass,
}: {
  value: unknown
  type: ReportFieldType
  format?: string
  locale: string
  extraClass?: string
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground">—</span>
  }
  const text = formatReportValue(value, type, format, locale)
  const tone = chipTone(String(value))
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ring-1 whitespace-nowrap',
        tone,
        extraClass,
      )}
    >
      {text}
    </span>
  )
}

// Categorical chips on the chart tokens, so they follow the theme.
const CHIP_TONES = [
  'bg-chart-1/10 text-chart-1 ring-chart-1/25',
  'bg-chart-2/10 text-chart-2 ring-chart-2/25',
  'bg-chart-4/10 text-chart-4 ring-chart-4/25',
  'bg-chart-3/10 text-chart-3 ring-chart-3/25',
  'bg-chart-5/10 text-chart-5 ring-chart-5/25',
  'bg-chart-6/10 text-chart-6 ring-chart-6/25',
  'bg-chart-7/10 text-chart-7 ring-chart-7/25',
  'bg-chart-8/10 text-chart-8 ring-chart-8/25',
]

/**
 * chipTone — small deterministic hash of the value string to a palette
 * index. Not cryptographic; just needs stability + a decent spread so
 * distinct values don't collide too often on tiny vocabularies.
 */
function chipTone(v: string): string {
  let h = 0
  for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) | 0
  return CHIP_TONES[Math.abs(h) % CHIP_TONES.length]
}

// ================================================================ Markdown

/**
 * Extremely conservative markdown renderer — headings (`# / ## / ###`),
 * bullet lists (`- `), horizontal rules (`---`), and plain paragraphs.
 * Inline `**bold**` and `*italic*`. Everything else renders as-is.
 * The renderer never accepts HTML or URLs so there's nothing to escape.
 */
function MarkdownWidget({ widget }: { widget: ReportWidget }) {
  const bindings = (widget.bindings ?? { content: '' }) as MarkdownBindings
  const content = bindings.content ?? ''
  const blocks = useMemo(() => parseMarkdown(content), [content])
  return (
    <div className="rounded-xl border bg-card p-5 text-sm leading-6 shadow-sm">
      {widget.title && <h2 className="font-semibold text-base mb-3">{widget.title}</h2>}
      <div className="prose-sm max-w-none space-y-3">
        {blocks.map((block, i) => {
          switch (block.kind) {
            case 'h1':
              return (
                <h1 key={i} className="text-2xl font-bold tracking-tight">
                  {inlineMd(block.text)}
                </h1>
              )
            case 'h2':
              return (
                <h2 key={i} className="text-xl font-semibold">
                  {inlineMd(block.text)}
                </h2>
              )
            case 'h3':
              return (
                <h3 key={i} className="text-base font-semibold">
                  {inlineMd(block.text)}
                </h3>
              )
            case 'hr':
              return <hr key={i} className="border-border" />
            case 'ul':
              return (
                <ul key={i} className="list-disc ps-6 space-y-1">
                  {block.items.map((li, li_i) => (
                    <li key={li_i}>{inlineMd(li)}</li>
                  ))}
                </ul>
              )
            default:
              return (
                <p key={i} className="text-muted-foreground">
                  {inlineMd(block.text)}
                </p>
              )
          }
        })}
      </div>
    </div>
  )
}

type MdBlock =
  | { kind: 'p' | 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'hr' }

function parseMarkdown(src: string): MdBlock[] {
  const lines = src.split(/\r?\n/)
  const out: MdBlock[] = []
  let paragraph: string[] = []
  let bullets: string[] = []
  const flushPara = () => {
    if (paragraph.length) {
      out.push({ kind: 'p', text: paragraph.join(' ') })
      paragraph = []
    }
  }
  const flushBullets = () => {
    if (bullets.length) {
      out.push({ kind: 'ul', items: bullets })
      bullets = []
    }
  }
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      flushPara()
      flushBullets()
      continue
    }
    if (line === '---' || line === '***') {
      flushPara()
      flushBullets()
      out.push({ kind: 'hr' })
      continue
    }
    if (line.startsWith('### ')) {
      flushPara()
      flushBullets()
      out.push({ kind: 'h3', text: line.slice(4) })
      continue
    }
    if (line.startsWith('## ')) {
      flushPara()
      flushBullets()
      out.push({ kind: 'h2', text: line.slice(3) })
      continue
    }
    if (line.startsWith('# ')) {
      flushPara()
      flushBullets()
      out.push({ kind: 'h1', text: line.slice(2) })
      continue
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      flushPara()
      bullets.push(line.slice(2))
      continue
    }
    flushBullets()
    paragraph.push(line)
  }
  flushPara()
  flushBullets()
  return out
}

/**
 * Minimal inline markdown: **bold** and *italic*. Nothing else.
 * Returns a fragment of React children so callers can drop it into a
 * paragraph or list item without wrapping.
 */
function inlineMd(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>)
    }
    last = match.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

// ================================================================ Divider

function DividerWidget({ widget }: { widget: ReportWidget }) {
  if (widget.title) {
    return (
      <div className="flex items-center gap-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {widget.title}
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>
    )
  }
  return <hr className="border-border" />
}

// ================================================================ ComingSoon

function ComingSoonWidget({ widget }: { widget: ReportWidget }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-xl border-2 border-dashed bg-card/40 p-5 text-center">
      <FileBarChart className="w-6 h-6 text-muted-foreground/60 mx-auto" aria-hidden />
      <p className="text-sm font-medium mt-2">{widget.title ?? widget.kind}</p>
      <p className="text-xs text-muted-foreground mt-1">
        {t('reports.widgetComingSoon', {
          defaultValue: '"{{kind}}" widgets ship in a later phase.',
          kind: widget.kind,
        })}
      </p>
    </div>
  )
}

// ================================================================ dispatch

/** Top-level dispatcher. Returns the right widget for the kind. */
export function Widget({
  widget,
  result,
  locale,
  // `spec` accepted for callers that still pass it (viewer / builder
  // preview) — no widget currently needs the full spec, but the prop
  // stays wired so a future widget can pull the source id or other
  // top-level metadata without a props cascade rewrite.
  spec: _spec,
}: {
  widget: ReportWidget
  result: RunReportResult
  locale: string
  spec?: ReportSpec
}) {
  switch (widget.kind) {
    case 'kpi':
      return <KpiWidget widget={widget} result={result} locale={locale} />
    case 'table':
      return <TableWidget widget={widget} result={result} locale={locale} />
    case 'markdown':
      return <MarkdownWidget widget={widget} />
    case 'divider':
      return <DividerWidget widget={widget} />
    case 'line':
    case 'bar':
    case 'area':
    case 'pie':
    case 'donut':
      return <ChartWidget widget={widget} result={result} />
    case 'history':
      // History renders regardless of the shared result — it fetches
      // its own data from /reports/_/history using bindings.sourceId.
      return <HistoryWidget widget={widget} locale={locale} />
    // v2 additions — Evidence-inspired widget catalog.
    case 'bigValue':
      return <BigValueWidget widget={widget} result={result} locale={locale} />
    case 'dataTable':
      return <DataTableWidget widget={widget} result={result} locale={locale} />
    case 'editableTable':
      return <EditableTableWidget widget={widget} result={result} locale={locale} />
    case 'scatter':
      return <ScatterWidget widget={widget} result={result} />
    case 'heatmap':
      return <HeatmapWidget widget={widget} result={result} />
    case 'note':
      return <NoteWidget widget={widget} />
    case 'alert':
      return <AlertWidget widget={widget} />
    case 'map':
      return <MapWidget widget={widget} />
    case 'facilityExplorer':
      return <FacilityExplorerWidget widget={widget} result={result} locale={locale} />
    default:
      return <ComingSoonWidget widget={widget} />
  }
}
