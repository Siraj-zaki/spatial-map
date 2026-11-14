/**
 * /data — every record ingested through any table, API or import,
 * including records kept after their source was removed.
 *
 * Same page grammar as /files, /integrations and /tables: hero, live KPI
 * strip, one notice when ingest runs failed, then tabs (Records, Rooms &
 * bins, Files, Runs) over a toolbar and the table.
 *
 *   Toolbar  searchable source picker (scales past a handful of sources —
 *            the old sidebar list didn't), time-range presets with a custom
 *            range, a status filter (records: active / removed source;
 *            runs: result), debounced search, CSV export, a ⋯ menu with
 *            the per-source purges.
 *   Table    components/data/data-tables.tsx — bounded height with a sticky
 *            header, card lists on phones, rows that rise in on a new page
 *            and a highlight for records that arrive live.
 *   Detail   components/data/record-sheet.tsx — non-modal panel, ↑/↓ to
 *            step through the page.
 *
 * URL state: ?tab= ?source= ?q= ?range=any|1h|24h|7d|30d|custom ?from= ?to=
 * ?status= ?page= ?size=. Deleting needs editor or above (the API refuses
 * viewers); the controls are hidden for them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Boxes, ChevronDown, Clock, Database, Download, FileText, Layers, Loader2, MoreHorizontal, Plug, RefreshCw, Search, Server, Trash2, TriangleAlert, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { StatCard } from '@/components/stat-card'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { QueryError } from '@/components/feedback/query-error'
import { FilterTabs } from '@/components/filter-tabs'
import { SourcePicker } from '@/components/data/source-picker'
import { DateRangePicker, type DateRangeValue } from '@/components/data/date-range-picker'
import { RecordSheet, type RecordDetail } from '@/components/data/record-sheet'
import { BinsTable, FilesTable, Pager, PAGE_SIZES, RecordsTable, RunsTable, type BinsSortKey, type FilesSortKey, type RowsSortKey, type RunsSortKey, type SortState } from '@/components/data/data-tables'
import { DATA_TABS, formatDuration, formatStamp, localToISO, presetFrom, runCounts, runResult, runResultLabel, runResultVariant, type DataTab, type RangePreset } from '@/components/data/data-helpers'
import { useUrlState } from '@/hooks/useUrlState'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { bulkDeleteDataRecords, deleteDataRecord, listDataBins, listDataFiles, listDataRows, listDataRuns, listDataSources, purgeDataRecords, type DataBin, type DataRow, type DataRun, type DataScreenSourceRef, type DataSurface } from '@/lib/data-screen-client'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { queryCache, useApiQuery } from '@/lib/useApiQuery'
import { useActiveSolution } from '@/lib/solutions-client'
import { subscribeExternalSSE } from '@/lib/useSSE'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

const CACHE: Record<DataTab | 'sources' | 'summary', string> = {
  rows: 'data-rows',
  bins: 'data-bins',
  files: 'data-files',
  runs: 'data-runs',
  sources: 'data-sources',
  summary: 'data-summary',
}
const SEARCH_DEBOUNCE_MS = 300
const RANGES: RangePreset[] = ['any', '1h', '24h', '7d', '30d', 'custom']
type RowsStatus = 'all' | 'active' | 'archived'
type RunsStatus = 'all' | 'error' | 'partial' | 'ok'

interface Pending {
  surface: DataSurface
  ids?: number[]
  purge?: { sourceId: number; before?: string }
  label: string
}

function sourceLink(id: number, kind: string | undefined): string {
  return kind === 'table' ? `/tables/${id}` : `/integrations?source=${id}`
}

export default function DataPage() {
  const { t, i18n } = useTranslation()
  const tenantId = useCurrentTenantId()
  const enabled = tenantId !== null
  const canEdit = useWorkspaceRole().can('data.manage')

  // ---- URL state --------------------------------------------------------
  const [tabParam, setTabParam] = useUrlState<DataTab>('tab', 'rows')
  const tab: DataTab = DATA_TABS.includes(tabParam) ? tabParam : 'rows'
  const [sourceParam, setSourceParam] = useUrlState<string>('source', '')
  const sourceId = /^\d+$/.test(sourceParam) ? Number(sourceParam) : undefined
  const [q, setQ] = useUrlState<string>('q', '')
  const [rangeParam, setRangeParam] = useUrlState<RangePreset>('range', 'any')
  const range: RangePreset = RANGES.includes(rangeParam) ? rangeParam : 'any'
  const [fromParam, setFromParam] = useUrlState<string>('from', '')
  const [toParam, setToParam] = useUrlState<string>('to', '')
  const [statusParam, setStatusParam] = useUrlState<string>('status', 'all')
  const [pageParam, setPageParam] = useUrlState<string>('page', '1')
  const [sizeParam, setSizeParam] = useUrlState<string>('size', '50')
  const page = Math.max(1, Number.parseInt(pageParam, 10) || 1)
  const pageSize = (PAGE_SIZES as readonly number[]).includes(Number(sizeParam)) ? Number(sizeParam) : 50
  const rowsStatus: RowsStatus = (['all', 'active', 'archived'] as const).includes(statusParam as RowsStatus) ? (statusParam as RowsStatus) : 'all'
  const runsStatus: RunsStatus = (['all', 'error', 'partial', 'ok'] as const).includes(statusParam as RunsStatus) ? (statusParam as RunsStatus) : 'all'

  const resetPage = () => setPageParam('1')
  const changeTab = (next: DataTab) => {
    setTabParam(next)
    setStatusParam('all')
    resetPage()
    setSelected(new Set())
    setOpenIndex(null)
  }
  const changeSource = (id: number | undefined) => {
    setSourceParam(id ? String(id) : '')
    resetPage()
  }
  const changeRange = (v: DateRangeValue) => {
    setRangeParam(v.preset)
    setFromParam(v.preset === 'custom' ? (v.from ?? '') : '')
    setToParam(v.preset === 'custom' ? (v.to ?? '') : '')
    resetPage()
  }
  const changeStatus = (s: string) => {
    setStatusParam(s)
    resetPage()
  }

  // Search: instant box, URL + request once typing pauses; outside
  // changes (Clear filters, back) flow back into the box.
  const [searchDraft, setSearchDraft] = useState(q)
  const [syncedQ, setSyncedQ] = useState(q)
  if (q !== syncedQ) {
    setSyncedQ(q)
    setSearchDraft(q)
  }
  useEffect(() => {
    if (searchDraft.trim() === q) return
    const id = window.setTimeout(() => {
      setQ(searchDraft.trim())
      setPageParam('1')
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [searchDraft, q, setQ, setPageParam])

  // The preset's start, re-resolved each minute so "last hour" keeps moving.
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    if (range === 'any' || range === 'custom') return
    const id = window.setInterval(() => setClock(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [range])
  const from = range === 'custom' ? localToISO(fromParam) : presetFrom(range, clock)
  const to = range === 'custom' ? localToISO(toParam) : undefined

  // ---- data -------------------------------------------------------------
  // Inside a solution (`?solution=`) every list and KPI covers its sources only.
  const { id: solutionId, solution } = useActiveSolution()
  const sourcesQuery = useApiQuery<DataScreenSourceRef[]>(() => listDataSources(solutionId), [CACHE.sources, tenantId, solutionId], { intervalMs: 60000, enabled })
  const sources = useMemo(() => sourcesQuery.data ?? [], [sourcesQuery.data])
  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources])
  const activeSource = sourceId ? sourceById.get(sourceId) : undefined

  // Workspace-wide summary for the KPIs: one newest record + one run page
  // (their `stats` / `filteredStats` carry the totals).
  const summaryRows = useApiQuery(() => listDataRows({ solution: solutionId, pageSize: 1, sort: 'updatedAt', dir: 'desc' }), [CACHE.summary, 'rows', tenantId, solutionId], { intervalMs: 30000, enabled })
  const summaryRuns = useApiQuery(() => listDataRuns({ solution: solutionId, pageSize: 1, sort: 'createdAt', dir: 'desc' }), [CACHE.summary, 'runs', tenantId, solutionId], { intervalMs: 30000, enabled })
  const stats = summaryRows.data?.stats ?? summaryRuns.data?.stats
  const latestRow = summaryRows.data?.rows[0]
  const failedRuns = summaryRuns.data?.filteredStats.failures ?? 0

  const [sortRows, setSortRows] = useState<SortState<RowsSortKey>>({ key: 'updatedAt', dir: 'desc' })
  const [sortBins, setSortBins] = useState<SortState<BinsSortKey>>({ key: 'lastSyncedAt', dir: 'desc' })
  const [sortFiles, setSortFiles] = useState<SortState<FilesSortKey>>({ key: 'createdAt', dir: 'desc' })
  const [sortRuns, setSortRuns] = useState<SortState<RunsSortKey>>({ key: 'createdAt', dir: 'desc' })
  const search = q || undefined

  const rowsQuery = useApiQuery(
    () => listDataRows({ solution: solutionId, sourceId, search, archived: rowsStatus, from, to, sort: sortRows.key, dir: sortRows.dir, page, pageSize }),
    [CACHE.rows, tenantId, solutionId, sourceId, search, rowsStatus, from, to, sortRows.key, sortRows.dir, page, pageSize],
    { intervalMs: 20000, enabled: enabled && tab === 'rows' },
  )
  const binsQuery = useApiQuery(
    () => listDataBins({ solution: solutionId, sourceId, search, from, to, sort: sortBins.key, dir: sortBins.dir, page, pageSize }),
    [CACHE.bins, tenantId, solutionId, sourceId, search, from, to, sortBins.key, sortBins.dir, page, pageSize],
    { intervalMs: 20000, enabled: enabled && tab === 'bins' },
  )
  const filesQuery = useApiQuery(
    () => listDataFiles({ solution: solutionId, sourceId, search, from, to, sort: sortFiles.key, dir: sortFiles.dir, page, pageSize }),
    [CACHE.files, tenantId, solutionId, sourceId, search, from, to, sortFiles.key, sortFiles.dir, page, pageSize],
    { intervalMs: 30000, enabled: enabled && tab === 'files' },
  )
  const runsQuery = useApiQuery(
    () => listDataRuns({ solution: solutionId, sourceId, status: runsStatus === 'all' ? undefined : runsStatus, from, to, sort: sortRuns.key, dir: sortRuns.dir, page, pageSize }),
    [CACHE.runs, tenantId, solutionId, sourceId, runsStatus, from, to, sortRuns.key, sortRuns.dir, page, pageSize],
    { intervalMs: 30000, enabled: enabled && tab === 'runs' },
  )
  const active = tab === 'rows' ? rowsQuery : tab === 'bins' ? binsQuery : tab === 'files' ? filesQuery : runsQuery
  const total = active.data?.total ?? 0
  const firstLoad = active.isLoading && !active.data
  // A query key per view: rows only rise in when this changes, and the
  // "arrived live" highlight compares against the same key.
  const viewKey = JSON.stringify([tab, sourceId, q, rowsStatus, runsStatus, range, fromParam, toParam, page, pageSize, sortRows, sortBins, sortFiles, sortRuns])

  // Live: the backend announces ingests over SSE; refetch and ping the dot.
  const [lastEvent, setLastEvent] = useState(0)
  const invalidateAll = useCallback(() => Object.values(CACHE).forEach((p) => queryCache.invalidate(p)), [])
  useEffect(
    () =>
      subscribeExternalSSE((kind) => {
        if (kind !== 'data-events') return
        invalidateAll()
        setLastEvent(Date.now())
      }),
    [invalidateAll],
  )

  // ---- selection + detail ------------------------------------------------
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const currentIds = useMemo(() => (active.data?.rows ?? []).map((r) => (r as { id: number }).id), [active.data])
  const selection = currentIds.filter((id) => selected.has(id))
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAll = (ids: number[]) => setSelected((prev) => (ids.every((id) => prev.has(id)) ? new Set([...prev].filter((id) => !ids.includes(id))) : new Set([...prev, ...ids])))
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  // ---- delete ------------------------------------------------------------
  const [pending, setPending] = useState<Pending | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const surface = tab as DataSurface
  const confirmDelete = async () => {
    if (!pending) return
    setDeleting(true)
    setDeleteError(null)
    try {
      if (pending.purge) await purgeDataRecords(pending.surface, pending.purge)
      else if (pending.ids?.length === 1) await deleteDataRecord(pending.surface, pending.ids[0])
      else if (pending.ids?.length) await bulkDeleteDataRecords(pending.surface, pending.ids)
      invalidateAll()
      setSelected(new Set())
      setOpenIndex(null)
      toast.success(
        pending.purge
          ? t('data.purgedToast', { defaultValue: 'Deleted records from {{source}}', source: pending.label })
          : t('data.deletedCount', { defaultValue: '{{count}} records deleted', count: pending.ids?.length ?? 0 }),
      )
      setPending(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  // ---- record detail ----------------------------------------------------
  const detail: RecordDetail | null = useMemo(() => {
    if (openIndex === null) return null
    const lang = i18n.language
    const fact = (label: string, iso: string | undefined) => ({ label, value: iso ? relativeTime(iso, lang) : '—', title: iso ? fullTime(iso, lang) : undefined })
    if (tab === 'rows') {
      const r = rowsQuery.data?.rows[openIndex] as DataRow | undefined
      if (!r) return null
      return {
        id: `row-${r.id}`,
        title: r.entityKey,
        source: r.sourceName ? { label: r.sourceName, to: r.sourceArchived ? undefined : sourceLink(r.sourceId, r.sourceKind) } : undefined,
        badges: r.sourceArchived ? <Badge variant="warning">{t('data.archivedBadge', { defaultValue: 'Archived' })}</Badge> : undefined,
        facts: [
          fact(t('data.detail.received', { defaultValue: 'First received' }), r.ts),
          fact(t('data.detail.updated', { defaultValue: 'Last updated' }), r.updatedAt),
          ...(r.linkedShape ? [{ label: t('data.detail.linkedShape', { defaultValue: 'Linked shape' }), value: r.linkedShape }] : []),
          ...(r.positionWkt ? [{ label: t('data.detail.position', { defaultValue: 'Position' }), value: <span className="font-mono text-xs" dir="ltr">{r.positionWkt}</span> }] : []),
        ],
        payload: r.payload,
      }
    }
    if (tab === 'bins') {
      const b = binsQuery.data?.rows[openIndex] as DataBin | undefined
      if (!b) return null
      return {
        id: `bin-${b.id}`,
        title: b.externalCode || b.sku || `#${b.id}`,
        source: b.sourceName ? { label: b.sourceName, to: b.sourceArchived ? undefined : sourceLink(b.sourceId, undefined) } : undefined,
        facts: [
          { label: t('data.col.status', { defaultValue: 'Status' }), value: b.status || '—' },
          { label: t('data.detail.capacity', { defaultValue: 'Capacity' }), value: new Intl.NumberFormat(lang).format(b.capacity) },
          ...(b.notes ? [{ label: t('data.col.notes', { defaultValue: 'Notes' }), value: b.notes }] : []),
          fact(t('data.col.lastSyncedAt', { defaultValue: 'Last synced' }), b.lastSyncedAt),
        ],
        payload: b.custom ?? b,
      }
    }
    if (tab === 'runs') {
      const r = runsQuery.data?.rows[openIndex] as DataRun | undefined
      if (!r) return null
      const res = runResult(r.status)
      const c = runCounts(r.stats)
      const nf = new Intl.NumberFormat(lang)
      return {
        id: `run-${r.id}`,
        title: t('data.detail.runTitle', { defaultValue: 'Run #{{id}}', id: r.id }),
        source: { label: r.sourceName || t('data.source.deleted', { defaultValue: 'Deleted source' }), to: r.sourceName && !r.sourceArchived ? sourceLink(r.sourceId, undefined) : undefined },
        badges: <Badge variant={runResultVariant(res)}>{runResultLabel(res, r.status, t)}</Badge>,
        facts: [
          fact(t('data.col.startedAt', { defaultValue: 'Started' }), r.startedAt ?? r.createdAt),
          { label: t('data.col.duration', { defaultValue: 'Duration' }), value: formatDuration(r.startedAt, r.finishedAt, lang) },
          ...(c.read !== undefined ? [{ label: t('data.detail.read', { defaultValue: 'Rows read' }), value: nf.format(c.read) }] : []),
          ...(c.imported !== undefined ? [{ label: t('data.detail.imported', { defaultValue: 'Imported' }), value: nf.format(c.imported) }] : []),
          ...(c.skipped !== undefined ? [{ label: t('data.detail.skipped', { defaultValue: 'Skipped' }), value: nf.format(c.skipped) }] : []),
          ...(c.errored !== undefined ? [{ label: t('data.detail.errored', { defaultValue: 'Errors' }), value: nf.format(c.errored) }] : []),
        ],
        alert: r.errorReport || undefined,
        payload: r.stats ?? {},
      }
    }
    return null
  }, [openIndex, tab, rowsQuery.data, binsQuery.data, runsQuery.data, t, i18n.language])
  const pageRows = active.data?.rows.length ?? 0
  const deleteOpen = () => {
    if (openIndex === null) return
    const row = active.data?.rows[openIndex] as { id: number } | undefined
    if (row) setPending({ surface, ids: [row.id], label: '1' })
  }

  // ---- toolbar pieces ---------------------------------------------------
  const filtersActive = !!sourceId || !!q || range !== 'any' || statusParam !== 'all'
  const clearFilters = () => {
    setSourceParam('')
    setSearchDraft('')
    setQ('')
    setRangeParam('any')
    setFromParam('')
    setToParam('')
    setStatusParam('all')
    resetPage()
  }

  const exportCsv = () => {
    const rows = rowsQuery.data?.rows ?? []
    const keys = [...new Set(rows.flatMap((r) => (r.payload && typeof r.payload === 'object' ? Object.keys(r.payload as object) : [])))]
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [['source', 'entity_key', 'updated_at', ...keys].join(',')].concat(
      rows.map((r) => {
        const pl = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>
        return [r.sourceName, r.entityKey, r.updatedAt, ...keys.map((k) => pl[k])].map(cell).join(',')
      }),
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
    a.download = `records-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success(t('data.exportedV2', { defaultValue: 'Exported {{count}} records on this page', count: rows.length }))
  }

  const tabs: { id: DataTab; label: string; icon: typeof Database; count?: number }[] = [
    { id: 'rows', label: t('data.tabs.records', { defaultValue: 'Records' }), icon: Database, count: stats?.totalRows },
    { id: 'bins', label: t('data.tabs.binsV2', { defaultValue: 'Rooms & bins' }), icon: Boxes, count: stats?.totalBins },
    { id: 'files', label: t('data.tabs.files', { defaultValue: 'Files' }), icon: FileText, count: stats?.totalFiles },
    { id: 'runs', label: t('data.tabs.runs', { defaultValue: 'Runs' }), icon: Server, count: stats?.totalRuns },
  ]
  const nf = new Intl.NumberFormat(i18n.language)

  const emptyFor = (): React.ReactNode => {
    if (filtersActive)
      return (
        <EmptyState
          compact
          icon={Search}
          className="border-0 py-14"
          title={t('data.empty.noMatchTitle', { defaultValue: 'Nothing matches these filters' })}
          description={t('data.empty.noMatchBody', { defaultValue: 'Try another source, a wider time range or a different search.' })}
          action={
            <Button variant="outline" size="sm" onClick={clearFilters}>
              {t('data.filter.reset', { defaultValue: 'Clear filters' })}
            </Button>
          }
        />
      )
    const copy: Record<DataTab, [string, string, typeof Database]> = {
      rows: [t('data.empty.rowsTitle', { defaultValue: 'No records yet' }), t('data.empty.rowsBody', { defaultValue: 'Records arrive from your tables, REST APIs and file imports. Each one shows up here with everything it carried.' }), Database],
      bins: [t('data.empty.binsTitle', { defaultValue: 'No rooms or bins imported' }), t('data.empty.binsBody', { defaultValue: 'Rooms and bins come from rack layout imports — a file of bin codes matched to the racks on a facility.' }), Boxes],
      files: [t('data.empty.filesTitle', { defaultValue: 'No imported files' }), t('data.empty.filesBody', { defaultValue: 'Spreadsheets and GeoJSON files you import as integrations are kept here, so you can see what was loaded and when.' }), FileText],
      runs: [t('data.empty.runsTitle', { defaultValue: 'No runs yet' }), t('data.empty.runsBody', { defaultValue: 'Every time an integration fetches or imports data, a run is recorded with what was imported, skipped or failed.' }), Server],
    }
    const [title, body, icon] = copy[tab]
    return (
      <EmptyState
        compact
        icon={icon}
        className="border-0 py-14"
        title={title}
        description={body}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild size="sm">
              <Link to="/integrations">
                <Plug className="h-4 w-4" />
                {t('data.empty.toIntegrations', { defaultValue: 'Connect a source' })}
              </Link>
            </Button>
            {tab === 'rows' && (
              <Button asChild size="sm" variant="outline">
                <Link to="/tables">{t('data.empty.toTables', { defaultValue: 'Open tables' })}</Link>
              </Button>
            )}
          </div>
        }
      />
    )
  }

  const common = {
    loading: firstLoad,
    queryKey: viewKey,
    selected,
    onToggle: toggle,
    onToggleAll: toggleAll,
    canDelete: canEdit,
    empty: emptyFor(),
    activeId: openIndex !== null ? (active.data?.rows[openIndex] as { id: number } | undefined)?.id : undefined,
  }
  const del = (row: { id: number }) => setPending({ surface, ids: [row.id], label: '1' })
  const purgeBefore = range !== 'any' ? from : undefined

  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>
        <PageHero
          title={t('data.title', { defaultValue: 'Data' })}
          description={
            solution
              ? t('solutions.dataDescription', { name: solution.name, defaultValue: 'Every record the tables and integrations in {{name}} have brought in.' })
              : t('data.subtitleV2', { defaultValue: 'Every record your tables, APIs and imports have brought in — including records kept after a source was removed.' })
          }
          actions={
            <>
              <span className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground" title={t('data.liveHint', { defaultValue: 'Updates automatically as data arrives' })}>
                <span key={lastEvent} className="sgv-live-dot relative inline-flex h-2 w-2 rounded-full bg-success text-success" aria-hidden />
                {t('data.live', { defaultValue: 'Live' })}
              </span>
              <Button variant="outline" size="icon" onClick={invalidateAll} disabled={!enabled} aria-label={t('data.action.refresh', { defaultValue: 'Refresh' })} title={t('data.action.refresh', { defaultValue: 'Refresh' })}>
                <RefreshCw className={cn('h-4 w-4', active.isLoading && !firstLoad && 'animate-spin motion-reduce:animate-none')} />
              </Button>
            </>
          }
        />
      </div>

      <section {...rise(1, 'grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4')} aria-label={t('data.kpiLabel', { defaultValue: 'Data totals' })}>
        <StatCard icon={Database} label={t('data.kpi.records', { defaultValue: 'Records' })} value={stats?.totalRows ?? 0} hint={t('data.kpi.recordsHint', { defaultValue: 'From {{count}} sources', count: stats?.activeSources ?? 0 })} loading={!stats} />
        <StatCard
          icon={Clock}
          label={t('data.kpi.latest', { defaultValue: 'Latest record' })}
          value={latestRow ? relativeTime(latestRow.updatedAt || latestRow.ts, i18n.language) : '—'}
          hint={
            latestRow
              ? latestRow.sourceName
              : summaryRows.error
                ? t('data.kpi.unavailable', { defaultValue: 'Couldn’t load' })
                : t('data.kpi.latestNone', { defaultValue: 'Nothing received yet' })
          }
          loading={summaryRows.isLoading && !summaryRows.data}
        />
        <StatCard
          icon={Server}
          label={t('data.kpi.runs', { defaultValue: 'Ingest runs' })}
          value={stats?.totalRuns ?? 0}
          hint={failedRuns > 0 ? t('data.kpi.runsFailed', { defaultValue: '{{count}} failed', count: failedRuns }) : t('data.kpi.runsOk', { defaultValue: 'None failed' })}
          loading={!stats}
        />
        <StatCard
          icon={Layers}
          label={t('data.kpi.sources', { defaultValue: 'Sources' })}
          value={stats?.activeSources ?? 0}
          hint={stats?.archivedSources ? t('data.kpi.archived', { defaultValue: '{{count}} removed, records kept', count: stats.archivedSources }) : t('data.kpi.noneArchived', { defaultValue: 'All still connected' })}
          to="/integrations"
          loading={!stats}
        />
      </section>

      {failedRuns > 0 && !(tab === 'runs' && runsStatus === 'error') && (
        <div {...rise(2, 'flex flex-col gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 sm:flex-row sm:items-center')}>
          <TriangleAlert className="hidden h-5 w-5 shrink-0 text-danger sm:block" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t('data.failedTitle', { defaultValue: '{{count}} ingest runs failed', count: failedRuns })}</p>
            <p className="text-sm text-muted-foreground">{t('data.failedBody', { defaultValue: 'Some data may be missing. Each run says what went wrong.' })}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => {
              changeTab('runs')
              setStatusParam('error')
            }}
          >
            {t('data.reviewRuns', { defaultValue: 'Review failed runs' })}
          </Button>
        </div>
      )}

      <section {...rise(3, cn('space-y-4', selection.length > 0 && 'pb-20'))} aria-label={t('data.title', { defaultValue: 'Data' })}>
        <Tabs value={tab} onValueChange={(v) => changeTab(v as DataTab)}>
          <TabsList className="max-w-full overflow-x-auto">
            {tabs.map((tb) => (
              <TabsTrigger key={tb.id} value={tb.id}>
                <tb.icon className="hidden sm:block" />
                {tb.label}
                {tb.count !== undefined && <span className="tabular-nums text-muted-foreground">{tb.count >= 10000 ? new Intl.NumberFormat(i18n.language, { notation: 'compact' }).format(tb.count) : nf.format(tb.count)}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <SourcePicker sources={sources} value={sourceId} onChange={changeSource} disabled={!enabled} />
          <DateRangePicker value={{ preset: range, from: fromParam || undefined, to: toParam || undefined }} onChange={changeRange} disabled={!enabled} />
          {tab === 'rows' && (stats?.archivedSources ?? 0) > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className={cn(rowsStatus !== 'all' && 'border-primary/40 bg-primary/5')}>
                  {rowsStatus === 'active' ? t('data.status.active', { defaultValue: 'Connected sources' }) : rowsStatus === 'archived' ? t('data.status.archived', { defaultValue: 'Removed sources' }) : t('data.status.all', { defaultValue: 'All sources' })}
                  <ChevronDown className="h-4 w-4 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuRadioGroup value={rowsStatus} onValueChange={changeStatus}>
                  <DropdownMenuRadioItem value="all">{t('data.status.all', { defaultValue: 'All sources' })}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="active">{t('data.status.active', { defaultValue: 'Connected sources' })}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="archived">{t('data.status.archived', { defaultValue: 'Removed sources' })}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {tab === 'runs' && (
            <FilterTabs
              ariaLabel={t('data.run.filterLabel', { defaultValue: 'Filter runs by result' })}
              value={runsStatus}
              onChange={changeStatus}
              items={[
                { value: 'all', label: t('data.run.all', { defaultValue: 'All' }) },
                { value: 'error', label: t('data.run.failed', { defaultValue: 'Failed' }) },
                { value: 'partial', label: t('data.run.partial', { defaultValue: 'Partly failed' }) },
                { value: 'ok', label: t('data.run.succeeded', { defaultValue: 'Succeeded' }) },
              ]}
            />
          )}
          {tab !== 'runs' && (
            <div className="relative min-w-0 flex-1 basis-full sm:basis-48">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                role="searchbox"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && searchDraft && setSearchDraft('')}
                placeholder={tab === 'rows' ? t('data.searchRecords', { defaultValue: 'Search keys and values' }) : t('data.searchOther', { defaultValue: 'Search' })}
                aria-label={tab === 'rows' ? t('data.searchRecords', { defaultValue: 'Search keys and values' }) : t('data.searchOther', { defaultValue: 'Search' })}
                className="ps-9 pe-9"
                disabled={!enabled}
              />
              {searchDraft.trim() !== q || (active.isLoading && !!q) ? (
                <Loader2 className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
              ) : (
                searchDraft && (
                  <button type="button" onClick={() => setSearchDraft('')} className="absolute end-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('tables.clearSearch', { defaultValue: 'Clear search' })}>
                    <X className="h-4 w-4" />
                  </button>
                )
              )}
            </div>
          )}
          <div className={cn('flex items-center gap-2', tab === 'runs' && 'ms-auto')}>
            {tab === 'rows' && (rowsQuery.data?.rows.length ?? 0) > 0 && (
              <Button variant="outline" onClick={exportCsv}>
                <Download className="h-4 w-4" />
                <span className="hidden lg:inline">{t('data.action.exportCsv', { defaultValue: 'Export CSV' })}</span>
              </Button>
            )}
            {canEdit && activeSource && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label={t('data.moreActions', { defaultValue: 'More actions' })}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel className="truncate">{activeSource.name}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-danger focus:bg-danger/10 focus:text-danger" onSelect={() => setPending({ surface, purge: { sourceId: activeSource.id }, label: activeSource.name })}>
                    <Trash2 className="h-4 w-4" />
                    {t('data.purge.all', { defaultValue: 'Delete everything from this source' })}
                  </DropdownMenuItem>
                  {purgeBefore && (
                    <DropdownMenuItem className="text-danger focus:bg-danger/10 focus:text-danger" onSelect={() => setPending({ surface, purge: { sourceId: activeSource.id, before: purgeBefore }, label: activeSource.name })}>
                      <Clock className="h-4 w-4" />
                      {t('data.purge.before', { defaultValue: 'Delete everything older than {{when}}', when: formatStamp(purgeBefore, i18n.language) })}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {filtersActive && active.data && (
          <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground" aria-live="polite">
            {t('data.matching', { defaultValue: '{{count}} matching', count: total })}
            <Button variant="link" size="sm" className="h-auto p-0" onClick={clearFilters}>
              {t('data.filter.reset', { defaultValue: 'Clear filters' })}
            </Button>
          </p>
        )}

        {/* Table */}
        {/* overflow-clip (not -hidden): rounds the corners without creating a
            scroll container, so the table header can stick to the page. */}
        <div key={tab} className="sgv-fade overflow-clip rounded-xl border bg-card shadow-sm">
          {active.error && !active.data ? (
            <QueryError compact error={active.error} onRetry={active.mutate} what={t('data.whatRecords', { defaultValue: 'these records' })} />
          ) : (
            <>
              {tab === 'rows' && <RecordsTable {...common} rows={rowsQuery.data?.rows ?? []} sort={sortRows} onSort={(s) => { setSortRows(s); resetPage() }} onOpen={setOpenIndex} onDelete={del} showSource={!sourceId} />}
              {tab === 'bins' && <BinsTable {...common} rows={binsQuery.data?.rows ?? []} sort={sortBins} onSort={(s) => { setSortBins(s); resetPage() }} onOpen={setOpenIndex} onDelete={del} showSource={!sourceId} />}
              {tab === 'files' && <FilesTable {...common} rows={filesQuery.data?.rows ?? []} sort={sortFiles} onSort={(s) => { setSortFiles(s); resetPage() }} onDelete={del} showSource={!sourceId} />}
              {tab === 'runs' && <RunsTable {...common} rows={runsQuery.data?.rows ?? []} sort={sortRuns} onSort={(s) => { setSortRuns(s); resetPage() }} onOpen={setOpenIndex} onDelete={del} showSource={!sourceId} />}
              {total > 0 && (
                <Pager
                  page={page}
                  pageSize={pageSize}
                  total={total}
                  busy={active.isLoading}
                  onPage={(n) => {
                    setPageParam(String(n))
                    setOpenIndex(null)
                  }}
                  onPageSize={(n) => {
                    setSizeParam(String(n))
                    resetPage()
                  }}
                />
              )}
            </>
          )}
        </div>
      </section>

      {/* Floating selection bar */}
      {selection.length > 0 && canEdit && (
        <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center">
          <div role="region" aria-label={t('data.bulk.region', { defaultValue: 'Selected records' })} className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border bg-popover px-3 py-2 shadow-lg animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none">
            <span className="px-1 text-sm font-medium">{t('data.bulk.selected', { defaultValue: '{{count}} selected', count: selection.length })}</span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              <X className="h-4 w-4" />
              {t('data.bulk.clear', { defaultValue: 'Clear' })}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setPending({ surface, ids: selection, label: String(selection.length) })}>
              <Trash2 className="h-4 w-4" />
              {t('data.bulk.deleteN', { defaultValue: 'Delete {{count}}', count: selection.length })}
            </Button>
          </div>
        </div>
      )}

      <RecordSheet
        record={detail}
        onClose={() => setOpenIndex(null)}
        onPrev={openIndex !== null && openIndex > 0 ? () => setOpenIndex(openIndex - 1) : undefined}
        onNext={openIndex !== null && openIndex < pageRows - 1 ? () => setOpenIndex(openIndex + 1) : undefined}
        position={openIndex !== null ? t('data.detail.counter', { defaultValue: '{{n}} of {{total}}', n: openIndex + 1, total: pageRows }) : undefined}
        onDelete={canEdit ? deleteOpen : undefined}
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o && !deleting) {
            setPending(null)
            setDeleteError(null)
          }
        }}
        title={
          pending?.purge
            ? t('data.confirm.purgeTitleV2', { defaultValue: 'Delete records from {{source}}?', source: pending.label })
            : t('data.confirm.deleteTitle', { defaultValue: 'Delete {{count}} records?', count: pending?.ids?.length ?? 0 })
        }
        description={
          pending?.purge?.before
            ? t('data.confirm.purgeBeforeV2', { defaultValue: 'Every record received before {{when}} is deleted for good. The source itself stays connected.', when: formatStamp(pending.purge.before, i18n.language) })
            : pending?.purge
              ? t('data.confirm.purgeAllV2', { defaultValue: 'Every record this source has brought in is deleted for good. The source itself stays connected and keeps sending new data.' })
              : t('data.confirm.deleteDesc', { defaultValue: 'Permanently deletes {{count}} records. This cannot be undone.', count: pending?.ids?.length ?? 0 })
        }
        confirmLabel={t('data.confirm.confirm', { defaultValue: 'Delete permanently' })}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
        error={deleteError}
      />
    </PageContainer>
  )
}

