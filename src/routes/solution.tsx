/**
 * A solution's home (`/solutions/:id`): its own dashboard — KPIs for just
 * its items, its facilities, reports, tables and integrations (with their
 * health), and the latest import runs. The other solution pages are the
 * regular screens filtered by `?solution=` (see `solutions-client.ts`).
 */

import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileBarChart,
  FolderSearch,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Plug,
  Table as TableIcon,
  Trash2,
  Warehouse,
} from 'lucide-react'
import { PageChapter, PageContainer, PageHero, rise } from '@/components/page-shell'
import { StatCard } from '@/components/stat-card'
import { EmptyState } from '@/components/empty-state'
import { QueryError } from '@/components/feedback/query-error'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { FacilityCard, FacilityCardSkeleton } from '@/components/facility-card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ReportIcon, CLASS_META } from '@/components/reports/report-identity'
import { SolutionIcon } from '@/components/solutions/solution-identity'
import { SolutionDialog } from '@/components/solutions/solution-dialog'
import { useSolutionCatalog } from '@/components/solutions/use-solution-catalog'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { classifyReport } from '@/lib/reports-client'
import { relativeTime } from '@/lib/relative-time'
import { deleteSolution, getSolutionOverview, solutionPath, useSolutions } from '@/lib/solutions-client'
import { useApiQuery } from '@/lib/useApiQuery'
import { listWarehouseSummaries } from '@/lib/warehouses-client'
import { cn } from '@/lib/utils'
import type { DataSource } from '@/lib/db'

export default function SolutionPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { id: raw } = useParams()
  const id = Number(raw)
  const tenantId = useCurrentTenantId()
  const canEdit = useWorkspaceRole().can('solutions.manage')
  const solutions = useSolutions()
  const solution = (solutions.data ?? []).find((s) => s.id === id) ?? null
  const catalog = useSolutionCatalog()
  const valid = Number.isFinite(id) && id > 0 && solution != null

  const overview = useApiQuery(() => getSolutionOverview(id), ['solution-overview', id, tenantId, solution?.updatedAt], {
    intervalMs: 30000,
    enabled: valid,
  })
  const facilities = useApiQuery(
    () => listWarehouseSummaries({ solution: id, sort: 'name', dir: 'asc', pageSize: 6 }),
    ['warehouse-summaries', tenantId, 'solution', id, solution?.updatedAt],
    { intervalMs: 30000, enabled: valid },
  )
  const [dialog, setDialog] = useState<null | 'edit' | 'items'>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const members = useMemo(() => {
    const reports = new Set(solution?.reportIds ?? [])
    const sources = new Set(solution?.dataSourceIds ?? [])
    return {
      reports: catalog.reports.filter((r) => reports.has(r.id)),
      tables: catalog.tables.filter((s) => sources.has(s.id!)),
      integrations: catalog.integrations.filter((s) => sources.has(s.id!)),
    }
  }, [solution, catalog])
  const attention = members.integrations.filter((s) => s.lastResult === 'error' || s.lastResult === 'partial').length
  const zoneNames = useMemo(() => new Map(catalog.zones.map((z) => [z.id!, z.name])), [catalog.zones])

  if (solutions.isLoading && !solutions.data) {
    return (
      <PageContainer>
        <div className="flex items-center gap-3">
          <Skeleton className="h-14 w-14 rounded-2xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </PageContainer>
    )
  }
  if (solutions.error && !solutions.data) {
    return (
      <PageContainer>
        <QueryError error={solutions.error} onRetry={solutions.mutate} what={t('solutions.what', { defaultValue: 'this solution' })} />
      </PageContainer>
    )
  }
  if (!solution) {
    return (
      <PageContainer>
        <EmptyState
          icon={FolderSearch}
          title={t('solutions.notFound', { defaultValue: 'Solution not found' })}
          description={t('solutions.notFoundBody', { defaultValue: 'It may have been deleted, or it belongs to another workspace. Its facilities, reports and data are untouched.' })}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/dashboard">{t('solutions.backToDashboard', { defaultValue: 'Go to dashboard' })}</Link>
            </Button>
          }
        />
      </PageContainer>
    )
  }

  const empty = solution.zoneIds.length + solution.reportIds.length + solution.dataSourceIds.length === 0
  const locale = i18n.language

  return (
    <PageContainer>
      <div {...rise(0)}>
        <PageHero
          title={
            <span className="flex min-w-0 items-center gap-3">
              <SolutionIcon icon={solution.icon} color={solution.color} size="xl" />
              <span dir="auto" className="min-w-0 truncate">{solution.name}</span>
            </span>
          }
          description={solution.description || undefined}
          actions={
            canEdit && (
              <>
                <Button size="sm" onClick={() => setDialog('items')}>
                  <ListChecks className="me-1.5 h-4 w-4" aria-hidden />
                  {t('solutions.manage', { defaultValue: 'Manage contents' })}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="h-9 w-9" aria-label={t('solutions.more', { defaultValue: 'More actions' })}>
                      <MoreHorizontal className="h-4 w-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setDialog('edit')}>
                      <Pencil className="me-2 h-4 w-4" aria-hidden />
                      {t('solutions.edit', { defaultValue: 'Edit name & look' })}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setConfirmDelete(true)} className="text-destructive focus:text-destructive">
                      <Trash2 className="me-2 h-4 w-4" aria-hidden />
                      {t('solutions.delete', { defaultValue: 'Delete solution' })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )
          }
        />
      </div>

      {empty ? (
        <div {...rise(1)}>
          <EmptyState
            icon={ListChecks}
            title={t('solutions.emptyTitle', { defaultValue: 'Nothing in this solution yet' })}
            description={t('solutions.emptyBody', { defaultValue: 'Add the facilities, reports, tables and integrations that belong to it. They stay where they are — this is just a view that groups them.' })}
            action={
              canEdit ? (
                <Button size="sm" onClick={() => setDialog('items')}>
                  {t('solutions.addContents', { defaultValue: 'Add contents' })}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <section {...rise(1, 'grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4')} aria-label={t('solutions.kpis', { defaultValue: 'Solution totals' })}>
            <StatCard
              icon={Warehouse}
              label={t('solutions.kind.facilities', { defaultValue: 'Facilities' })}
              value={solution.zoneIds.length}
              hint={
                facilities.data
                  ? t('solutions.assetsHint', { count: facilities.data.stats.totalAssets, defaultValue: '{{count}} tracked assets' })
                  : undefined
              }
              to={solutionPath(id, 'facilities')}
              loading={facilities.isLoading && !facilities.data}
            />
            <StatCard
              icon={FileBarChart}
              label={t('solutions.kind.reports', { defaultValue: 'Reports' })}
              value={solution.reportIds.length}
              to={solutionPath(id, 'reports')}
            />
            <StatCard
              icon={Plug}
              label={t('solutions.kind.integrations', { defaultValue: 'Integrations' })}
              value={members.integrations.length + members.tables.length}
              hint={
                attention > 0
                  ? t('solutions.attentionHint', { count: attention, defaultValue: '{{count}} need attention' })
                  : t('solutions.tablesHint', { count: members.tables.length, defaultValue: 'incl. {{count}} tables' })
              }
              to={solutionPath(id, 'integrations')}
              loading={catalog.isLoading}
            />
            <StatCard
              icon={Activity}
              label={t('solutions.liveRows', { defaultValue: 'Live records' })}
              value={overview.data?.totalRows ?? 0}
              hint={
                overview.data
                  ? overview.data.lastUpdate
                    ? t('solutions.updatedHint', { count: overview.data.updated24h, when: relativeTime(overview.data.lastUpdate, locale), defaultValue: '{{count}} updated in 24 h · last {{when}}' })
                    : t('solutions.noUpdates', { defaultValue: 'No data received yet' })
                  : undefined
              }
              to={solutionPath(id, 'data')}
              loading={overview.isLoading && !overview.data}
            />
          </section>

          {solution.zoneIds.length > 0 && (
            <div {...rise(2)}>
              <PageChapter
                title={t('solutions.kind.facilities', { defaultValue: 'Facilities' })}
                actions={<SeeAll to={solutionPath(id, 'facilities')} count={solution.zoneIds.length} />}
              >
                {facilities.error && !facilities.data ? (
                  <QueryError error={facilities.error} onRetry={facilities.mutate} compact />
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {facilities.data
                      ? facilities.data.rows.map((row) => <FacilityCard key={row.id} row={row} />)
                      : Array.from({ length: Math.min(3, solution.zoneIds.length) }, (_, i) => <FacilityCardSkeleton key={i} />)}
                  </div>
                )}
              </PageChapter>
            </div>
          )}

          <div {...rise(3, 'grid gap-8 lg:grid-cols-2')}>
            <PageChapter
              title={t('solutions.kind.reports', { defaultValue: 'Reports' })}
              actions={members.reports.length > 0 ? <SeeAll to={solutionPath(id, 'reports')} count={members.reports.length} /> : undefined}
            >
              {members.reports.length === 0 ? (
                <MiniEmpty text={t('solutions.noReports', { defaultValue: 'No reports in this solution.' })} />
              ) : (
                <ul className="divide-y rounded-xl border bg-card">
                  {members.reports.slice(0, 6).map((r) => (
                    <li key={r.id}>
                      <Link
                        to={`/reports/${r.id}?solution=${id}`}
                        className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/50 focus-visible:bg-accent focus-visible:outline-none"
                      >
                        <ReportIcon report={r} fallback={CLASS_META[classifyReport(r.spec)].icon} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span dir="auto" className="block truncate text-sm font-medium">{r.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {r.zoneId ? zoneNames.get(r.zoneId) : t('solutions.sharedReport', { defaultValue: 'All facilities' })} ·{' '}
                            {t('solutions.updated', { when: relativeTime(r.updatedAt, locale), defaultValue: 'updated {{when}}' })}
                          </span>
                        </span>
                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </PageChapter>

            <PageChapter
              title={t('solutions.dataTitle', { defaultValue: 'Data & integrations' })}
              actions={members.integrations.length + members.tables.length > 0 ? <SeeAll to={solutionPath(id, 'integrations')} count={members.integrations.length + members.tables.length} /> : undefined}
            >
              {members.integrations.length + members.tables.length === 0 ? (
                <MiniEmpty text={t('solutions.noData', { defaultValue: 'No tables or integrations in this solution.' })} />
              ) : (
                <ul className="divide-y rounded-xl border bg-card">
                  {[...members.integrations, ...members.tables].slice(0, 8).map((s) => (
                    <SourceRow key={s.id} source={s} solutionId={id} locale={locale} />
                  ))}
                </ul>
              )}
            </PageChapter>
          </div>

          {overview.data && overview.data.recentRuns.length > 0 && (
            <div {...rise(4)}>
              <PageChapter title={t('solutions.recentRuns', { defaultValue: 'Recent imports' })} actions={<SeeAll to={`/data?tab=runs&solution=${id}`} />}>
                <ul className="divide-y rounded-xl border bg-card">
                  {overview.data.recentRuns.map((run) => {
                    const failed = /fail|error/i.test(run.status)
                    return (
                      <li key={run.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                        {failed ? <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />}
                        <span dir="auto" className="min-w-0 flex-1 truncate font-medium">{run.sourceName}</span>
                        <span className="shrink-0 text-xs capitalize text-muted-foreground">{run.status}</span>
                        <span className="w-24 shrink-0 text-end text-xs text-muted-foreground">{relativeTime(run.finishedAt ?? run.createdAt, locale)}</span>
                      </li>
                    )
                  })}
                </ul>
              </PageChapter>
            </div>
          )}
        </>
      )}

      {dialog && <SolutionDialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)} mode={dialog} solution={solution} />}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(o) => {
          setConfirmDelete(o)
          if (!o) setDeleteError(null)
        }}
        title={t('solutions.deleteTitle', { name: solution.name, defaultValue: 'Delete “{{name}}”?' })}
        description={t('solutions.deleteBody', { defaultValue: 'Only the solution is removed. Its facilities, reports, tables and integrations stay in the workspace.' })}
        confirmLabel={t('solutions.deleteConfirm', { defaultValue: 'Delete solution' })}
        busy={deleting}
        error={deleteError}
        onConfirm={async () => {
          setDeleting(true)
          setDeleteError(null)
          try {
            await deleteSolution(solution.id)
            navigate('/dashboard')
          } catch (err) {
            setDeleteError(err instanceof Error ? err.message : String(err))
            setDeleting(false)
          }
        }}
      />
    </PageContainer>
  )
}

function SeeAll({ to, count }: { to: string; count?: number }) {
  const { t } = useTranslation()
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
      {count != null ? t('solutions.seeAllCount', { count, defaultValue: 'See all {{count}}' }) : t('solutions.seeAll', { defaultValue: 'See all' })}
      <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
    </Link>
  )
}

function MiniEmpty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{text}</p>
}

function SourceRow({ source, solutionId, locale }: { source: DataSource; solutionId: number; locale: string }) {
  const { t } = useTranslation()
  const isTable = source.kind === 'table'
  const tone =
    source.lastResult === 'error' ? 'bg-danger' : source.lastResult === 'partial' ? 'bg-warning' : source.lastResult === 'ok' ? 'bg-success' : 'bg-muted-foreground/40'
  const status =
    source.lastResult === 'error'
      ? t('solutions.status.error', { defaultValue: 'Failing' })
      : source.lastResult === 'partial'
        ? t('solutions.status.partial', { defaultValue: 'Partial' })
        : source.lastResult === 'ok'
          ? t('solutions.status.ok', { defaultValue: 'Healthy' })
          : t('solutions.status.idle', { defaultValue: 'No runs yet' })
  const to = isTable ? `/tables/${source.id}?solution=${solutionId}` : `/integrations?source=${source.id}&solution=${solutionId}`
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/50 focus-visible:bg-accent focus-visible:outline-none">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground">
          {isTable ? <TableIcon className="h-3.5 w-3.5" aria-hidden /> : <Plug className="h-3.5 w-3.5" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span dir="auto" className="block truncate text-sm font-medium">{source.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {isTable ? t('solutions.kind.table', { defaultValue: 'Table' }) : source.kind.toUpperCase()}
            {source.lastRunAt ? ` · ${relativeTime(new Date(source.lastRunAt).toISOString(), locale)}` : ''}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('h-2 w-2 rounded-full', tone)} aria-hidden />
          {status}
        </span>
      </Link>
    </li>
  )
}
