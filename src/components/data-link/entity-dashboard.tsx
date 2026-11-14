/**
 * EntityDashboard — the `/tables` screen: every user-defined "thing type"
 * table in the workspace, and whether data is actually getting into it.
 *
 * Status comes from what the table holds (lib/table-status.ts): Needs
 * fields / No records yet / Receiving data / No recent writes. It used to
 * be derived from API keys — but GET /tables never returned keys, so every
 * table read "No write token", and the app and REST pulls write without a
 * key anyway.
 *
 * Header KPIs: tables, records, updated today, not ready. One page-level
 * notice for tables that aren't ready, with "Show only these". Filters in
 * the URL: ?status=all|receiving|empty|needsFields  ?kind=  ?q=
 * ?sort=name|written|records|updated  ?view=grid|list.
 *
 * Owners/admins create and delete; everyone browses.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownWideNarrow,
  ChevronDown,
  Clock,
  Columns3,
  Copy,
  Database,
  KeyRound,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Shapes,
  Table2,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { useActiveSolution } from '@/lib/solutions-client'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { QueryError } from '@/components/feedback/query-error'
import { RoleGate } from '@/components/feedback/role-gate'
import { EmptyState } from '@/components/empty-state'
import { FilterTabs, type FilterTabItem } from '@/components/filter-tabs'
import { StatCard } from '@/components/stat-card'
import { useUrlState } from '@/hooks/useUrlState'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { useApiQuery, queryCache } from '@/lib/useApiQuery'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'
import {
  activeKeyCount,
  entityKindLabel,
  tableStatus,
  tableStatusLabel,
  tableStatusVariant,
  type TableStatus,
} from '@/lib/table-status'
import { deleteTable, formatIntegrationLinkedMessage, isIntegrationLinkedError, listTables, type TableResponse } from '@/lib/tables-client'

type StatusFilter = 'all' | 'receiving' | 'empty' | 'needsFields'
type SortKey = 'name' | 'written' | 'records' | 'updated'
type View = 'grid' | 'list'
const STATUS_FILTERS: StatusFilter[] = ['all', 'receiving', 'empty', 'needsFields']
const SORTS: SortKey[] = ['name', 'written', 'records', 'updated']

const rowsOf = (tb: TableResponse) => tb.stats?.rows ?? 0
const writtenAt = (tb: TableResponse) => (tb.stats?.lastWriteAt ? Date.parse(tb.stats.lastWriteAt) : 0)

function matchesStatus(status: TableStatus, filter: StatusFilter): boolean {
  return filter === 'all' || status === filter
}

function CardSkeleton() {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm" aria-hidden>
      <div className="flex items-start gap-3">
        <Skeleton className="h-9 w-9 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-7 w-24" />
      <Skeleton className="h-5 w-full" />
    </div>
  )
}

export function EntityDashboard() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const tenantId = useCurrentTenantId()
  const canManage = useWorkspaceRole().can('data.manage')
  const adminOnly = t('common.needsAdmin', { defaultValue: 'Only workspace owners and admins can do this.' })

  const query = useApiQuery(() => listTables(), ['tables', tenantId], { intervalMs: 30000 })
  // Inside a solution (`?solution=`): only its tables.
  const { solution } = useActiveSolution()
  const tables = useMemo(() => {
    const all = query.data ?? []
    if (!solution) return all
    const ids = new Set(solution.dataSourceIds)
    return all.filter((tb) => ids.has(tb.dataSource.id))
  }, [query.data, solution])
  const loading = query.isLoading && !query.data
  const refreshing = query.isLoading && !!query.data

  // ---- URL state --------------------------------------------------------
  const [q, setQ] = useUrlState<string>('q', '')
  const [kind, setKind] = useUrlState<string>('kind', '')
  const [statusParam, setStatus] = useUrlState<StatusFilter>('status', 'all')
  const [sortParam, setSort] = useUrlState<SortKey>('sort', 'name')
  const [viewParam, setView] = useUrlState<View>('view', 'grid')
  const statusFilter: StatusFilter = STATUS_FILTERS.includes(statusParam) ? statusParam : 'all'
  const sort: SortKey = SORTS.includes(sortParam) ? sortParam : 'name'
  const view: View = viewParam === 'list' ? 'list' : 'grid'

  // ---- derived ----------------------------------------------------------
  // Computed once per data change, so statuses are stable across renders.
  const statusById = useMemo(() => new Map(tables.map((tb) => [tb.dataSource.id, tableStatus(tb)])), [tables])
  const statusOf = (tb: TableResponse) => statusById.get(tb.dataSource.id) ?? 'empty'

  const stats = useMemo(() => {
    let records = 0
    let receiving = 0
    let needsFields = 0
    let empty = 0
    for (const tb of tables) {
      records += rowsOf(tb)
      const st = statusById.get(tb.dataSource.id)
      if (st === 'receiving') receiving++
      if (st === 'needsFields') needsFields++
      if (st === 'empty') empty++
    }
    return { records, receiving, needsFields, empty, notReady: needsFields + empty }
  }, [tables, statusById])

  const kinds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tb of tables) {
      const k = tb.dataSource.entityKind
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return [...counts].map(([k, count]) => ({ kind: k, count })).sort((a, b) => a.kind.localeCompare(b.kind))
  }, [tables])

  const needle = q.trim().toLowerCase()
  const byQueryAndKind = useMemo(
    () =>
      tables.filter((tb) => {
        if (kind && tb.dataSource.entityKind !== kind) return false
        if (!needle) return true
        // Field keys + labels are how people remember a table ("the one
        // with the serial number column").
        return (
          tb.dataSource.name.toLowerCase().includes(needle) ||
          (tb.dataSource.entityKind ?? '').toLowerCase().includes(needle) ||
          tb.fields.some((f) => f.fieldKey.toLowerCase().includes(needle) || f.fieldLabel.toLowerCase().includes(needle))
        )
      }),
    [tables, kind, needle],
  )
  const visible = useMemo(() => {
    const out = byQueryAndKind.filter((tb) => matchesStatus(statusById.get(tb.dataSource.id) ?? 'empty', statusFilter))
    return out.sort((a, b) => {
      switch (sort) {
        case 'written':
          return writtenAt(b) - writtenAt(a) || a.dataSource.name.localeCompare(b.dataSource.name)
        case 'records':
          return rowsOf(b) - rowsOf(a) || a.dataSource.name.localeCompare(b.dataSource.name)
        case 'updated':
          return Date.parse(b.dataSource.updatedAt) - Date.parse(a.dataSource.updatedAt)
        default:
          return a.dataSource.name.localeCompare(b.dataSource.name)
      }
    })
  }, [byQueryAndKind, statusById, statusFilter, sort])

  /** Names shared by more than one table — those show their id too. */
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tb of tables) counts.set(tb.dataSource.name, (counts.get(tb.dataSource.name) ?? 0) + 1)
    return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name))
  }, [tables])

  const filtersActive = !!needle || !!kind || statusFilter !== 'all'
  const clearFilters = () => {
    setQ('')
    setKind('')
    setStatus('all')
  }

  // ---- delete ------------------------------------------------------------
  const [pendingDelete, setPendingDelete] = useState<TableResponse | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteTable(pendingDelete.dataSource.id)
      toast.success(t('tables.deleted', { defaultValue: '{{name}} deleted', name: pendingDelete.dataSource.name }))
      setPendingDelete(null)
      queryCache.invalidate('tables')
    } catch (err) {
      // 409 → still referenced by a data-link layer on a facility; the
      // message names each one, so show it verbatim.
      setDeleteError(isIntegrationLinkedError(err) ? formatIntegrationLinkedMessage(err, t) : (err as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const createButton = (
    <RoleGate allowed={canManage} message={adminOnly}>
      <Button onClick={() => navigate(solution ? `/tables/new?solution=${solution.id}` : '/tables/new')} disabled={!canManage}>
        <Plus className="h-4 w-4" />
        {t('tables.createNew', { defaultValue: 'Create new table' })}
      </Button>
    </RoleGate>
  )

  const statusItems: FilterTabItem<StatusFilter>[] = STATUS_FILTERS.map((s) => ({
    value: s,
    label: s === 'all' ? t('tables.filterAll', { defaultValue: 'All' }) : tableStatusLabel(s, t),
    count: loading ? undefined : byQueryAndKind.filter((tb) => matchesStatus(statusOf(tb), s)).length,
  }))
  const sortLabel = (s: SortKey) =>
    ({
      name: t('tables.sortName', { defaultValue: 'Name (A–Z)' }),
      written: t('tables.sortWritten', { defaultValue: 'Last write' }),
      records: t('tables.sortRecords', { defaultValue: 'Most records' }),
      updated: t('tables.sortUpdated', { defaultValue: 'Schema changed' }),
    })[s]
  const nf = new Intl.NumberFormat(i18n.language)

  const cardProps = (tb: TableResponse) => ({
    table: tb,
    status: statusOf(tb),
    showId: duplicateNames.has(tb.dataSource.name),
    onOpen: (tab?: string) => navigate(`/tables/${tb.dataSource.id}${tab ? `?tab=${tab}` : ''}`),
    onDelete: canManage
      ? () => {
          setDeleteError(null)
          setPendingDelete(tb)
        }
      : undefined,
  })

  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>
        <PageHero
          title={t('tables.heroTitle', { defaultValue: 'Tables' })}
          description={
            solution
              ? t('solutions.tablesDescription', { name: solution.name, defaultValue: 'The tables in {{name}}.' })
              : t('tables.pageSubtitleV2', {
                  defaultValue: 'Your own data tables. Each one gets an editable grid, a REST API and keys for the systems that feed it.',
                })
          }
          actions={
            <>
              <Button
                variant="outline"
                size="icon"
                onClick={() => queryCache.invalidate('tables')}
                disabled={query.isLoading}
                aria-label={t('tables.refresh', { defaultValue: 'Refresh' })}
                title={t('tables.refresh', { defaultValue: 'Refresh' })}
              >
                <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin motion-reduce:animate-none')} />
              </Button>
              {createButton}
            </>
          }
        />
      </div>

      {!(query.error && !query.data) && (loading || tables.length > 0) && (
        <section {...rise(1, 'grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4')} aria-label={t('tables.kpiLabel', { defaultValue: 'Table totals' })}>
          <StatCard
            icon={Database}
            label={t('tables.kpiTables', { defaultValue: 'Tables' })}
            value={tables.length}
            hint={t('tables.kpiKinds', { defaultValue: '{{count}} kinds of data', count: kinds.length })}
            loading={loading}
          />
          <StatCard
            icon={Rows3}
            label={t('tables.kpiRecords', { defaultValue: 'Records' })}
            value={stats.records}
            hint={t('tables.kpiRecordsHint', { defaultValue: 'Across every table' })}
            loading={loading}
          />
          <StatCard
            icon={Clock}
            label={t('tables.kpiReceiving', { defaultValue: 'Updated today' })}
            value={stats.receiving}
            hint={t('tables.kpiReceivingHint', { defaultValue: 'Written in the last 24 hours' })}
            loading={loading}
          />
          <StatCard
            icon={TriangleAlert}
            label={t('tables.kpiNotReady', { defaultValue: 'Not ready' })}
            value={stats.notReady}
            hint={
              stats.notReady > 0
                ? t('tables.kpiNotReadyHint', { defaultValue: 'No fields or no records yet' })
                : t('tables.kpiAllReady', { defaultValue: 'Every table can receive data' })
            }
            loading={loading}
          />
        </section>
      )}

      {/* One notice for the whole page instead of a banner on every card. */}
      {!loading && stats.notReady > 0 && statusFilter === 'all' && (
        <div {...rise(2, 'flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 sm:flex-row sm:items-center')}>
          <TriangleAlert className="hidden h-5 w-5 shrink-0 text-warning sm:block" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t('tables.notReadyTitle', { defaultValue: '{{count}} tables have no data yet', count: stats.notReady })}</p>
            <p className="text-sm text-muted-foreground">
              {stats.needsFields > 0 && stats.empty > 0
                ? t('tables.notReadyBoth', {
                    defaultValue: '{{fields}} need fields before they can store anything; {{empty}} are waiting for their first record.',
                    fields: stats.needsFields,
                    empty: stats.empty,
                  })
                : stats.needsFields > 0
                  ? t('tables.notReadyFields', { defaultValue: 'Add fields so they can store records.' })
                  : t('tables.notReadyEmpty', { defaultValue: 'Add a record by hand, or connect a system with an API key or a REST pull.' })}
            </p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setStatus(stats.needsFields > 0 ? 'needsFields' : 'empty')}>
            {t('tables.showNeedsSetup', { defaultValue: 'Show only these' })}
          </Button>
        </div>
      )}

      <section {...rise(3, 'space-y-4')} aria-label={t('tables.chapterListTitle', { defaultValue: 'All tables' })}>
        {!loading && !query.error && tables.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <FilterTabs ariaLabel={t('tables.statusFilterLabel', { defaultValue: 'Filter by status' })} items={statusItems} value={statusFilter} onChange={setStatus} />
              <ViewToggle view={view} onChange={setView} className="hidden sm:inline-flex" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-full sm:basis-0">
                <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  role="searchbox"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && q && setQ('')}
                  placeholder={t('tables.searchPlaceholder', { defaultValue: 'Search by name, kind, or field' })}
                  aria-label={t('tables.searchPlaceholder', { defaultValue: 'Search by name, kind, or field' })}
                  className="ps-9 pe-9"
                />
                {q && (
                  <button
                    type="button"
                    onClick={() => setQ('')}
                    className="absolute end-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('tables.clearSearch', { defaultValue: 'Clear search' })}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {kinds.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className={cn('max-w-[14rem]', kind && 'border-primary/40 bg-primary/5')}>
                      <Shapes className="h-4 w-4 shrink-0" />
                      <span className="truncate">{kind ? entityKindLabel(kind, t) : t('tables.filterAllKinds', { defaultValue: 'All kinds' })}</span>
                      <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuRadioGroup value={kind} onValueChange={setKind}>
                      <DropdownMenuRadioItem value="">{t('tables.filterAllKinds', { defaultValue: 'All kinds' })}</DropdownMenuRadioItem>
                      <DropdownMenuSeparator />
                      {kinds.map((k) => (
                        <DropdownMenuRadioItem key={k.kind} value={k.kind}>
                          <span className="flex-1 truncate">{entityKindLabel(k.kind, t)}</span>
                          <span className="ms-3 text-xs tabular-nums text-muted-foreground">{k.count}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" aria-label={t('tables.sortBy', { defaultValue: 'Sort: {{order}}', order: sortLabel(sort) })}>
                    <ArrowDownWideNarrow className="h-4 w-4" />
                    <span className="hidden sm:inline">{sortLabel(sort)}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel>{t('tables.sortLabel', { defaultValue: 'Sort by' })}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                    {SORTS.map((s) => (
                      <DropdownMenuRadioItem key={s} value={s}>
                        {sortLabel(s)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <ViewToggle view={view} onChange={setView} className="ms-auto inline-flex sm:hidden" />
            </div>
            {filtersActive && (
              <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground" aria-live="polite">
                {t('tables.showingCount', { defaultValue: 'Showing {{shown}} of {{total}}', shown: visible.length, total: tables.length })}
                <Button variant="link" size="sm" className="h-auto p-0" onClick={clearFilters}>
                  {t('tables.clearFilters', { defaultValue: 'Clear filters' })}
                </Button>
              </p>
            )}
          </div>
        )}

        {query.error && !query.data ? (
          <QueryError error={query.error} onRetry={() => queryCache.invalidate('tables')} what={t('tables.whatTables', { defaultValue: 'your tables' })} />
        ) : loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy aria-label={t('tables.loading', { defaultValue: 'Loading tables' })}>
            {Array.from({ length: 6 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : tables.length === 0 ? (
          <EmptyState
            icon={Database}
            title={
              solution
                ? t('solutions.noTablesTitle', { name: solution.name, defaultValue: 'No tables in {{name}} yet' })
                : t('tables.emptyTitle', { defaultValue: 'No tables yet' })
            }
            description={
              solution
                ? t('solutions.noTablesBodyCreate', { defaultValue: 'Add tables with “Manage contents” above, or create one here — it joins the solution.' })
                : t('tables.emptyBodyV2', {
                    defaultValue: 'A table holds your own records — assets, sensors, shipments — with a spreadsheet view, a REST API and keys for the systems that send data.',
                  })
            }
            action={createButton}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t('tables.noMatchTitle', { defaultValue: 'No tables match' })}
            description={t('tables.noMatchBody', { defaultValue: 'Try a different search term or clear the filters.' })}
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {t('tables.clearFilters', { defaultValue: 'Clear filters' })}
              </Button>
            }
          />
        ) : view === 'list' ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="hidden items-center gap-4 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground md:flex">
              <span className="flex-1">{t('tables.col.name', { defaultValue: 'Table' })}</span>
              <span className="w-24 text-end">{t('tables.col.records', { defaultValue: 'Records' })}</span>
              <span className="w-32">{t('tables.col.lastWrite', { defaultValue: 'Last write' })}</span>
              <span className="w-20 text-end">{t('tables.col.fields', { defaultValue: 'Fields' })}</span>
              <span className="w-36">{t('tables.col.status', { defaultValue: 'Status' })}</span>
              <span className="w-8" aria-hidden />
            </div>
            <ul className="divide-y">
              {visible.map((tb) => (
                <TableListRow key={tb.dataSource.id} {...cardProps(tb)} nf={nf} />
              ))}
            </ul>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((tb, i) => (
              <li key={tb.dataSource.id} {...rise(Math.min(i, 9))}>
                <TableCard {...cardProps(tb)} nf={nf} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setPendingDelete(null)
            setDeleteError(null)
          }
        }}
        title={t('tables.deleteTitle', { defaultValue: 'Delete this table?' })}
        description={
          pendingDelete && rowsOf(pendingDelete) > 0
            ? t('tables.deleteBodyRows', {
                defaultValue: 'Deletes “{{name}}” and its {{count}} records, their history and its API keys. This can’t be undone.',
                name: pendingDelete.dataSource.name,
                count: rowsOf(pendingDelete),
              })
            : t('tables.deleteBodyEmpty', {
                defaultValue: 'Deletes “{{name}}” and its API keys. It has no records. This can’t be undone.',
                name: pendingDelete?.dataSource.name ?? '',
              })
        }
        confirmLabel={t('tables.deleteConfirm', { defaultValue: 'Delete table' })}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
        error={deleteError}
      />
    </PageContainer>
  )
}

function ViewToggle({ view, onChange, className }: { view: View; onChange: (v: View) => void; className?: string }) {
  const { t } = useTranslation()
  return (
    <div role="radiogroup" aria-label={t('tables.layout', { defaultValue: 'Layout' })} className={cn('h-9 shrink-0 items-center rounded-lg bg-muted p-1', className)}>
      {(
        [
          ['grid', LayoutGrid, t('tables.layoutGrid', { defaultValue: 'Grid' })],
          ['list', List, t('tables.layoutList', { defaultValue: 'List' })],
        ] as const
      ).map(([v, Icon, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={view === v}
          aria-label={label}
          title={label}
          onClick={() => onChange(v)}
          className={cn(
            'inline-flex h-7 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            view === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  )
}

interface ItemProps {
  table: TableResponse
  status: TableStatus
  showId: boolean
  nf: Intl.NumberFormat
  onOpen: (tab?: string) => void
  onDelete?: () => void
}

function TableMenu({ table, onOpen, onDelete }: Pick<ItemProps, 'table' | 'onOpen' | 'onDelete'>) {
  const { t } = useTranslation()
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative z-10 h-8 w-8 shrink-0 text-muted-foreground"
          aria-label={t('tables.actionsFor', { defaultValue: 'Actions for {{name}}', name: table.dataSource.name })}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => onOpen()}>
          <Rows3 className="h-4 w-4" />
          {t('tables.openRecords', { defaultValue: 'Open records' })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onOpen('schema')}>
          <Pencil className="h-4 w-4" />
          {t('tables.detail.editSchema', { defaultValue: 'Edit schema' })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onOpen('api')}>
          <KeyRound className="h-4 w-4" />
          {t('tables.detail.manageKeys', { defaultValue: 'Manage API keys' })}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            try {
              await navigator.clipboard.writeText(String(table.dataSource.id))
              toast.success(t('tables.detail.idCopied', { defaultValue: 'Table ID {{id}} copied', id: table.dataSource.id }))
            } catch {
              /* clipboard blocked */
            }
          }}
        >
          <Copy className="h-4 w-4" />
          {t('tables.detail.copyId', { defaultValue: 'Copy table ID' })}
        </DropdownMenuItem>
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDelete} className="text-danger focus:bg-danger/10 focus:text-danger">
              <Trash2 className="h-4 w-4" />
              {t('tables.deleteConfirm', { defaultValue: 'Delete table' })}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** How data gets in: API keys and/or a REST pull. Nothing = by hand only. */
function DataInChips({ table }: { table: TableResponse }) {
  const { t } = useTranslation()
  const keys = activeKeyCount(table)
  const polling = !!table.stats?.polling
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {keys > 0 && (
        <Badge variant="muted" className="gap-1">
          <KeyRound className="h-3 w-3" aria-hidden />
          {t('tables.keyCount', { defaultValue: '{{count}} API keys', count: keys })}
        </Badge>
      )}
      {polling && (
        <Badge variant="muted" className="gap-1">
          <RefreshCw className="h-3 w-3" aria-hidden />
          {t('tables.pulling', { defaultValue: 'REST pull' })}
        </Badge>
      )}
      {keys === 0 && !polling && <span className="text-xs text-muted-foreground">{t('tables.manualOnly', { defaultValue: 'Edited in the app' })}</span>}
    </span>
  )
}

function LastWrite({ table }: { table: TableResponse }) {
  const { t, i18n } = useTranslation()
  const at = table.stats?.lastWriteAt
  if (!at) return <span className="text-muted-foreground">{t('tables.neverWritten', { defaultValue: 'Never written' })}</span>
  return (
    <time dateTime={at} title={fullTime(at, i18n.language)}>
      {relativeTime(at, i18n.language)}
    </time>
  )
}

function TableCard({ table, status, showId, nf, onOpen, onDelete }: ItemProps) {
  const { t } = useTranslation()
  const ds = table.dataSource
  const rows = rowsOf(table)
  return (
    <article className="sgv-lift group relative flex h-full flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-sm hover:border-foreground/20">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
          <Table2 className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          {/* The name button stretches over the card; the menu sits above it. */}
          <button
            type="button"
            onClick={() => onOpen()}
            className="flex w-full min-w-0 items-baseline gap-1.5 text-start text-sm font-semibold after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            <span className="truncate">{ds.name}</span>
            {showId && <span className="shrink-0 text-xs font-normal text-muted-foreground">#{ds.id}</span>}
          </button>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{entityKindLabel(ds.entityKind, t)}</p>
        </div>
        <TableMenu table={table} onOpen={onOpen} onDelete={onDelete} />
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold leading-none tracking-tight tabular-nums">{nf.format(rows)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('tables.recordsLabel', { defaultValue: 'records', count: rows })}</p>
        </div>
        <p className="text-end text-xs">
          <span className="block text-muted-foreground">{t('tables.col.lastWrite', { defaultValue: 'Last write' })}</span>
          <LastWrite table={table} />
        </p>
      </div>

      {table.fields.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {table.fields.slice(0, 4).map((f) => (
            <span key={f.id} dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground" title={`${f.fieldLabel} · ${f.dataType}`}>
              {f.fieldKey}
            </span>
          ))}
          {table.fields.length > 4 && (
            <span className="self-center text-[11px] tabular-nums text-muted-foreground">{t('tables.moreFields', { defaultValue: '+{{count}} more', count: table.fields.length - 4 })}</span>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Columns3 className="h-3.5 w-3.5" aria-hidden />
          {t('tables.noFieldsYet', { defaultValue: 'No fields defined yet' })}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3">
        <DataInChips table={table} />
        {status !== 'idle' && <Badge variant={tableStatusVariant(status)}>{tableStatusLabel(status, t)}</Badge>}
      </div>
    </article>
  )
}

function TableListRow({ table, status, showId, nf, onOpen, onDelete }: ItemProps) {
  const { t } = useTranslation()
  const ds = table.dataSource
  return (
    <li className="relative flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40">
      <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground sm:flex">
        <Table2 className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpen()}
          className="flex w-full min-w-0 items-baseline gap-1.5 text-start text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          <span className="truncate">{ds.name}</span>
          {showId && <span className="shrink-0 text-xs font-normal text-muted-foreground">#{ds.id}</span>}
        </button>
        <p className="truncate text-xs text-muted-foreground">
          {entityKindLabel(ds.entityKind, t)}
          <span className="md:hidden">
            {' · '}
            {t('tables.recordsCount', { defaultValue: '{{count}} records', count: rowsOf(table) })}
          </span>
        </p>
      </div>
      <span className="hidden w-24 text-end text-sm tabular-nums md:block">{nf.format(rowsOf(table))}</span>
      <span className="hidden w-32 text-sm md:block">
        <LastWrite table={table} />
      </span>
      <span className="hidden w-20 text-end text-sm tabular-nums text-muted-foreground md:block">{nf.format(table.fields.length)}</span>
      <span className="w-auto shrink-0 md:w-36">
        {status !== 'idle' ? (
          <Badge variant={tableStatusVariant(status)}>{tableStatusLabel(status, t)}</Badge>
        ) : (
          <span className="hidden text-xs text-muted-foreground md:inline">{tableStatusLabel(status, t)}</span>
        )}
      </span>
      <TableMenu table={table} onOpen={onOpen} onDelete={onDelete} />
    </li>
  )
}
