import { useEffect, useMemo, useState } from 'react'
import { forgetWidgetView, publishWidgetView } from '../export/view-state'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronLeft, ChevronRight, Columns3, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { humanizeColumn } from '@/lib/reports/humanize-column'
import type {
  ReportWidget,
  RunReportResult,
} from '@/lib/reports-client'
import { CellRenderer, type CellColumnConfig } from './cell-renderer'

interface DataTableBindings {
  columns?: string[]
  columnConfig?: Record<string, CellColumnConfig>
  pageSize?: number
  /** Global full-text search across all visible columns. */
  searchable?: boolean
  /** Allow users to toggle column visibility. Persists client-side only. */
  columnToggle?: boolean
}

/**
 * Rich table widget — extends the base Table with global search and
 * column-visibility popover. Sort per column is inline via header
 * click. Pagination is client-side over the already-fetched rows.
 */
export function DataTableWidget({
  widget,
  result,
  locale,
}: {
  widget: ReportWidget
  result: RunReportResult
  locale: string
}) {
  const { t } = useTranslation()
  const b = (widget.bindings ?? {}) as DataTableBindings
  const declared = b.columns && b.columns.length > 0 ? b.columns : result.columns.map((c) => c.name)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(0)
  const pageSize = Math.max(5, Math.min(200, b.pageSize ?? 20))

  const visibleColumns = declared.filter((c) => !hidden.has(c))
  const columnIdx = useMemo(
    () => new Map(result.columns.map((c, i) => [c.name, i])),
    [result.columns],
  )

  const filtered = useMemo(() => {
    if (!search.trim()) return result.rows
    const needle = search.toLowerCase()
    return result.rows.filter((row) =>
      visibleColumns.some((cn) => {
        const idx = columnIdx.get(cn)
        return idx !== undefined && String(row[idx] ?? '').toLowerCase().includes(needle)
      }),
    )
  }, [result.rows, visibleColumns, columnIdx, search])

  const sorted = useMemo(() => {
    if (!sortCol) return filtered
    const idx = columnIdx.get(sortCol)
    if (idx === undefined) return filtered
    const copy = [...filtered]
    copy.sort((a, b) => {
      const av = a[idx]
      const bv = b[idx]
      if (av === bv) return 0
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      const dir = sortDir === 'asc' ? 1 : -1
      return av < bv ? -dir : dir
    })
    return copy
  }, [filtered, sortCol, sortDir, columnIdx])

  // Let "Export what's on screen" follow search, sort and hidden columns.
  const hiddenKey = [...hidden].join('\u0000')
  useEffect(() => {
    if (!widget.id) return
    publishWidgetView(widget.id, { sortColumn: sortCol, sortDir, search, hiddenColumns: hiddenKey ? hiddenKey.split('\u0000') : [] })
    return () => forgetWidgetView(widget.id!)
  }, [widget.id, sortCol, sortDir, search, hiddenKey])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const pageRows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize)

  const toggleSort = (name: string) => {
    if (sortCol === name) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(name)
      setSortDir('asc')
    }
  }

  const toggleHidden = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const nf = new Intl.NumberFormat(locale)
  const alignOf = (name: string, type: string) => {
    const a = b.columnConfig?.[name]?.align
    if (a === 'right') return 'text-end'
    if (a === 'center') return 'text-center'
    if (a === 'left') return 'text-start'
    return type === 'number' ? 'text-end' : 'text-start'
  }

  // No inner vertical scroll: the table is as tall as its page of rows
  // (the reading canvas grows the row to fit), so the report scrolls
  // once. Wide tables still scroll sideways inside the card.
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {widget.title && <h3 className="min-w-0 truncate text-sm font-medium">{widget.title}</h3>}
        <span className="text-xs tabular-nums text-muted-foreground">
          {t('reports.widgets.dataTable.rowsTotal', { defaultValue: '{{formatted}} rows', count: sorted.length, formatted: nf.format(sorted.length) })}
        </span>
        <div className="ms-auto flex items-center gap-1.5">
          {b.searchable !== false && (
            <div className="relative">
              <Search className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(0)
                }}
                placeholder={t('reports.widgets.dataTable.searchPlaceholder', { defaultValue: 'Search…' })}
                aria-label={t('reports.widgets.dataTable.searchLabel', { defaultValue: 'Search {{name}}', name: widget.title ?? '' })}
                className="h-8 w-44 ps-7 text-xs [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
          )}
          {b.columnToggle !== false && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                  <Columns3 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t('reports.widgets.dataTable.columns', { defaultValue: 'Columns' })}</span>
                  {hidden.size > 0 && <span className="tabular-nums">{declared.length - hidden.size}/{declared.length}</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-1" align="end">
                {declared.map((c) => (
                  <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent">
                    <input type="checkbox" checked={!hidden.has(c)} onChange={() => toggleHidden(c)} className="h-3.5 w-3.5 accent-primary" />
                    <span className="truncate">{b.columnConfig?.[c]?.label ?? humanizeColumn(c)}</span>
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-x-auto border-t">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b bg-muted/40">
              {visibleColumns.map((name) => {
                const cfg = b.columnConfig?.[name]
                const idx = columnIdx.get(name)
                const type = idx !== undefined ? result.columns[idx].type : 'text'
                const active = sortCol === name
                return (
                  <th
                    key={name}
                    scope="col"
                    aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={cn('h-9 whitespace-nowrap px-3 text-xs font-medium text-muted-foreground', alignOf(name, type))}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(name)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active && 'text-foreground',
                      )}
                    >
                      {cfg?.label ?? humanizeColumn(name)}
                      <ChevronDown
                        className={cn('h-3 w-3 transition-transform', active ? 'opacity-100' : 'opacity-0', active && sortDir === 'asc' && 'rotate-180')}
                        aria-hidden
                      />
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={visibleColumns.length} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {search
                    ? t('reports.widgets.dataTable.noMatch', { defaultValue: 'No rows match “{{q}}”', q: search })
                    : t('reports.widgets.dataTable.emptyState', { defaultValue: 'No matching rows' })}
                </td>
              </tr>
            )}
            {pageRows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-muted/40">
                {visibleColumns.map((name) => {
                  const idx = columnIdx.get(name)
                  const cfg = b.columnConfig?.[name]
                  const val = idx !== undefined ? row[idx] : undefined
                  const displayType = idx !== undefined ? result.columns[idx].type : 'text'
                  return (
                    <td
                      key={name}
                      style={{ maxWidth: cfg?.maxWidthPx ?? 260 }}
                      className={cn('h-10 overflow-hidden whitespace-nowrap px-3 tabular-nums', alignOf(name, displayType))}
                    >
                      <CellRenderer value={val} fieldType={displayType} config={cfg} locale={locale} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {t('reports.widgets.dataTable.rowSummary', {
              from: nf.format(sorted.length === 0 ? 0 : safePage * pageSize + 1),
              to: nf.format(Math.min(sorted.length, (safePage + 1) * pageSize)),
              total: nf.format(sorted.length),
              defaultValue: '{{from}}–{{to}} of {{total}}',
            })}
          </span>
          <div className="ms-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              aria-label={t('reports.widgets.dataTable.previousPage', { defaultValue: 'Previous page' })}
            >
              <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
            </Button>
            <span className="min-w-[3rem] text-center tabular-nums">
              {nf.format(safePage + 1)} / {nf.format(totalPages)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              aria-label={t('reports.widgets.dataTable.nextPage', { defaultValue: 'Next page' })}
            >
              <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
