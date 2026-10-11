/**
 * /integrations — every way data gets into the workspace, and whether
 * it's working.
 *
 * Views (URL `?view=`, default Sources):
 *   - Sources     REST APIs and file imports as cards, plus tables (the
 *                 push-based kind) as compact cards that open
 *                 `/tables/:id`. Kind chips (`?kind=all|rest|file|table`)
 *                 and search (`?q=`). A card opens the source's detail
 *                 panel (`?source=<id>`, deep-linkable): runs, latest rows,
 *                 connection, actions.
 *   - Health      is each thing actually delivering? (health-section.tsx)
 *   - Audit log   outbound writes back to source systems.
 *   - References  typed key → key links popups resolve.
 *   - Rules       "when X, then Y" automations.
 *
 * Header KPIs: sources, tables, needing attention, last sync. A failing
 * source raises ONE page-level notice with "Show only these"
 * (`?status=attention`), never a banner per card.
 *
 * Add integration: REST API (RestSourceEditor), Upload a file
 * (ImportDialog in integrations context — files only), Table → the full
 * schema builder at /tables/new.
 *
 * Owners/admins manage; everyone else browses (actions hidden or
 * disabled with the reason).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  ArrowRight,
  ChevronDown,
  Clock,
  Cloud,
  Database,
  FileText,
  KeyRound,
  Link2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  Table2,
  Trash2,
  TriangleAlert,
  Upload,
  Workflow,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { type DataSource } from '@/lib/db'
import {
  deleteBinSource,
  formatIntegrationLinkedMessage,
  isIntegrationLinkedError,
  pushOutboundPatch,
  RerunError,
  rerunDataSource,
  resultOf,
  useCurrentTenantId,
} from '@/lib/data-link'
import { apiDb } from '@/lib/api-db'
import { useApiQuery, queryCache } from '@/lib/useApiQuery'
import { subscribeExternalSSE } from '@/lib/useSSE'
import { ImportDialog } from '@/components/data-link/import-dialog'
import { ReferencesSection } from '@/components/data-link/references-section'
import { AuditLogSection } from '@/components/data-link/audit-log-section'
import { HealthSection } from '@/components/data-link/health-section'
import { RulesSection } from '@/components/data-link/rules-section'
import { RestSourceEditor } from '@/components/data-link/rest-source-editor'
import {
  SourceDetailSheet,
  SourceKindIcon,
  SourceStatus,
  isFileSource,
  missingRowKey,
  useScheduleLabel,
} from '@/components/data-link/source-detail-sheet'
import { type TableResponse, listTables } from '@/lib/tables-client'
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
import { toast } from '@/lib/toast-store'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'

type View = 'sources' | 'health' | 'audit' | 'references' | 'rules'
type KindFilter = 'all' | 'rest' | 'file' | 'table'
const VIEWS: View[] = ['sources', 'health', 'audit', 'references', 'rules']
const KINDS: KindFilter[] = ['all', 'rest', 'file', 'table']

function toTime(d: Date | string | undefined): number {
  if (!d) return 0
  const n = d instanceof Date ? d.getTime() : Date.parse(String(d))
  return Number.isNaN(n) ? 0 : n
}

/** The synthetic change "Test outbound" sends back to the source's API. */
function outboundTestPayload() {
  return { test: true, ts: Date.now(), via: 'Integrations' }
}

/** A source "needs attention" when its last run failed or partly failed. */
function needsAttention(s: DataSource): boolean {
  return s.lastResult === 'error' || s.lastResult === 'partial'
}

export default function IntegrationsPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const tenantId = useCurrentTenantId()
  const { canManage } = useWorkspaceRole()
  const adminOnly = t('common.needsAdmin', { defaultValue: 'Only workspace owners and admins can do this.' })

  // ---- data -------------------------------------------------------------
  const sourcesQuery = useApiQuery(() => apiDb.dataSources.toArray(), ['dataSources', tenantId], { intervalMs: 10000 })
  const tablesQuery = useApiQuery(() => listTables(), ['tables', tenantId], { intervalMs: 30000 })
  const referencesCount = useApiQuery(() => apiDb.references.count(), ['references-count', tenantId], { intervalMs: 15000 }).data ?? 0
  const auditCount = useApiQuery(() => apiDb.auditLog.count(), ['auditLog-count', tenantId], { intervalMs: 15000 }).data ?? 0
  const rulesCount = useApiQuery(() => apiDb.correlationRules.count(), ['correlationRules-count', tenantId], { intervalMs: 15000 }).data ?? 0

  // Tables live on /tables (they carry fields + tokens); drop their bare
  // data_sources rows so nothing shows twice. Newest first.
  // Inside a solution (`?solution=`): only its integrations and tables.
  const { solution } = useActiveSolution()
  const inSolution = useMemo(() => (solution ? new Set(solution.dataSourceIds) : null), [solution])
  const sources = useMemo(
    () =>
      (sourcesQuery.data ?? [])
        .filter((s) => s.kind === 'rest' || isFileSource(s))
        .filter((s) => !inSolution || inSolution.has(s.id!))
        .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt)),
    [sourcesQuery.data, inSolution],
  )
  const tables = useMemo(
    () =>
      [...(tablesQuery.data ?? [])]
        .filter((tb) => !inSolution || inSolution.has(tb.dataSource.id))
        .sort((a, b) => a.dataSource.name.localeCompare(b.dataSource.name)),
    [tablesQuery.data, inSolution],
  )

  // Table writes and source changes broadcast `data-sources`; land them now
  // rather than on the next poll.
  useEffect(
    () =>
      subscribeExternalSSE((kind) => {
        if (kind === 'data-sources') {
          queryCache.invalidate('dataSources')
          queryCache.invalidate('tables')
        }
      }),
    [],
  )

  // ---- URL state --------------------------------------------------------
  const [viewParam, setViewParam] = useUrlState<string>('view', 'sources')
  const view: View = VIEWS.includes(viewParam as View) ? (viewParam as View) : 'sources'
  const [kindParam, setKindParam] = useUrlState<string>('kind', 'all')
  const kind: KindFilter = KINDS.includes(kindParam as KindFilter) ? (kindParam as KindFilter) : 'all'
  const [q, setQ] = useUrlState<string>('q', '')
  const [statusParam, setStatusParam] = useUrlState<string>('status', '')
  const onlyAttention = statusParam === 'attention'
  const [sourceParam, setSourceParam] = useUrlState<string>('source', '')
  const openSource = sources.find((s) => String(s.id) === sourceParam) ?? null

  // ---- derived ------------------------------------------------------------
  const restCount = sources.filter((s) => s.kind === 'rest').length
  const fileCount = sources.filter(isFileSource).length
  const attention = sources.filter(needsAttention)
  const lastSync = sources.reduce((m, s) => Math.max(m, toTime(s.lastRunAt)), 0)
  const loading = sourcesQuery.isLoading && !sourcesQuery.data
  const loadError = sourcesQuery.error && !sourcesQuery.data ? sourcesQuery.error : null

  const needle = q.trim().toLowerCase()
  const visibleSources = sources.filter((s) => {
    if (kind === 'table') return false
    if (kind === 'rest' && s.kind !== 'rest') return false
    if (kind === 'file' && !isFileSource(s)) return false
    if (onlyAttention && !needsAttention(s)) return false
    if (!needle) return true
    const cfg = s.config as { url?: string; fileName?: string }
    return [s.name, s.entityKind, cfg.url, cfg.fileName].some((v) => v && String(v).toLowerCase().includes(needle))
  })
  const visibleTables =
    kind === 'all' || kind === 'table'
      ? onlyAttention
        ? []
        : tables.filter(
            (tb) =>
              !needle ||
              tb.dataSource.name.toLowerCase().includes(needle) ||
              (tb.dataSource.entityKind ?? '').toLowerCase().includes(needle),
          )
      : []
  const nothingAtAll = !loading && sources.length === 0 && tables.length === 0
  const noMatch = !loading && !nothingAtAll && visibleSources.length + visibleTables.length === 0

  // ---- dialogs & actions ---------------------------------------------------
  const [restEditor, setRestEditor] = useState<{ source: DataSource | null } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DataSource | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const run = useCallback(
    async (s: DataSource) => {
      if (s.id === undefined || runningId !== null) return
      setRunningId(s.id)
      try {
        const summary = await rerunDataSource(s)
        const result = resultOf(summary)
        const firstReason = summary.errors[0]
        if (result === 'error') {
          toast.error(t('integrations.runNothing', { defaultValue: 'Nothing was imported from {{name}}', name: s.name }), {
            description: firstReason
              ? t('integrations.runNothingReason', { defaultValue: '{{count}} rows skipped — {{reason}}', count: summary.rowsSkipped + summary.rowsErrored, reason: firstReason })
              : undefined,
          })
        } else if (result === 'partial') {
          toast.info(t('integrations.runPartial', { defaultValue: '{{name}}: {{imported}} of {{read}} rows imported', name: s.name, imported: summary.rowsImported || summary.rowsMatched, read: summary.rowsRead }), {
            description: firstReason,
          })
        } else {
          toast.success(
            isFileSource(s)
              ? t('integrations.reimported', { defaultValue: '{{name}} re-imported', name: s.name })
              : t('integrations.ranNow', { defaultValue: '{{name}} synced', name: s.name }),
            { description: t('integrations.runSummary', { defaultValue: '{{count}} rows imported', count: summary.rowsImported || summary.rowsMatched }) },
          )
        }
      } catch (err) {
        toast.error(t('integrations.runFailed', { defaultValue: '{{name}} didn’t sync', name: s.name }), {
          description: err instanceof RerunError ? err.message : (err as Error).message,
        })
      } finally {
        setRunningId(null)
        queryCache.invalidate('dataSources')
      }
    },
    [runningId, t],
  )

  const testOutbound = async (s: DataSource) => {
    if (s.id === undefined) return
    try {
      const stream = await apiDb.streams.where('dataSourceId').equals(s.id).first()
      if (!stream || stream.id === undefined) {
        toast.error(t('integrations.outboundNoStreamTitle', { defaultValue: 'Nothing to send through yet' }), {
          description: t('integrations.outboundNoStream', { defaultValue: 'This source has no stream to send through yet. Run it once, then try again.' }),
        })
        return
      }
      const result = await pushOutboundPatch({
        streamId: stream.id,
        entityType: 'bin',
        entityKey: 'outbound-test',
        before: {},
        after: outboundTestPayload(),
      })
      if (result.ok) {
        toast.success(t('integrations.outboundOk', { defaultValue: 'Test update sent' }), {
          description: t('integrations.outboundOkBody', { defaultValue: 'It’s recorded in the audit log.' }),
          action: { label: t('integrations.openAudit', { defaultValue: 'Open audit log' }), onClick: () => setViewParam('audit') },
        })
      } else {
        toast.error(t('integrations.outboundFailed', { defaultValue: 'Test update failed' }), { description: result.message ?? `HTTP ${result.httpStatus ?? '—'}` })
      }
    } catch (err) {
      toast.error(t('integrations.outboundFailed', { defaultValue: 'Test update failed' }), { description: (err as Error).message })
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget?.id || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteBinSource(deleteTarget.id)
      toast.success(t('integrations.deleted', { defaultValue: '{{name}} deleted', name: deleteTarget.name }))
      if (sourceParam === String(deleteTarget.id)) setSourceParam('')
      setDeleteTarget(null)
      queryCache.invalidate('dataSources')
    } catch (err) {
      // 409 → still referenced by a data-link config; name each one.
      setDeleteError(isIntegrationLinkedError(err) ? formatIntegrationLinkedMessage(err, t) : (err as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const askDelete = (s: DataSource) => {
    setDeleteError(null)
    setDeleteTarget(s)
  }

  // ---- header ----------------------------------------------------------------
  const addMenu = (
    <RoleGate allowed={canManage} message={adminOnly}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={!canManage}>
            <Plus className="h-4 w-4" />
            {t('integrations.addIntegration', { defaultValue: 'Add integration' })}
            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          {[
            {
              icon: Cloud,
              title: t('integrations.addRest', { defaultValue: 'REST API' }),
              body: t('integrations.addRestBody', { defaultValue: 'Pull JSON from an HTTP endpoint on a schedule' }),
              onSelect: () => setRestEditor({ source: null }),
            },
            {
              icon: Upload,
              title: t('integrations.uploadFile', { defaultValue: 'Upload file' }),
              body: t('integrations.uploadFileBody', { defaultValue: 'Import a CSV, XLSX, JSON or GeoJSON file' }),
              onSelect: () => setImportOpen(true),
            },
            {
              icon: Table2,
              title: t('integrations.addTable', { defaultValue: 'Table' }),
              body: t('integrations.addTableBody', { defaultValue: 'Your own schema that your systems write to' }),
              onSelect: () => navigate('/tables/new'),
            },
          ].map((item) => (
            <DropdownMenuItem key={item.title} onSelect={item.onSelect} className="cursor-pointer items-start gap-3 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/50">
                <item.icon className="h-4 w-4 text-muted-foreground" />
              </span>
              <span>
                <span className="block text-sm font-medium">{item.title}</span>
                <span className="block text-xs text-muted-foreground">{item.body}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </RoleGate>
  )

  const kindItems: FilterTabItem<KindFilter>[] = [
    { value: 'all', label: t('integrations.tabAll', { defaultValue: 'All' }), count: sources.length + tables.length },
    { value: 'rest', label: t('integrations.tabRest', { defaultValue: 'REST APIs' }), count: restCount, icon: Cloud },
    { value: 'file', label: t('integrations.tabFile', { defaultValue: 'Files' }), count: fileCount, icon: FileText },
    { value: 'table', label: t('integrations.tabTable', { defaultValue: 'Tables' }), count: tables.length, icon: Table2 },
  ]

  const viewTabs: Array<{ value: View; label: string; icon: typeof Activity; count?: number }> = [
    { value: 'sources', label: t('integrations.viewSources', { defaultValue: 'Sources' }), icon: Database, count: sources.length + tables.length },
    { value: 'health', label: t('integrations.tabHealth', { defaultValue: 'Health' }), icon: Activity, count: attention.length || undefined },
    { value: 'audit', label: t('integrations.tabAudit', { defaultValue: 'Audit log' }), icon: ScrollText, count: auditCount },
    { value: 'references', label: t('integrations.tabReferences', { defaultValue: 'References' }), icon: Link2, count: referencesCount },
    { value: 'rules', label: t('integrations.tabRules', { defaultValue: 'Rules' }), icon: Workflow, count: rulesCount },
  ]

  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>
        <PageHero
          title={t('integrations.heroTitle', { defaultValue: 'Integrations' })}
          description={
            solution
              ? t('solutions.integrationsDescription', { name: solution.name, defaultValue: 'The integrations and tables that feed {{name}}.' })
              : t('integrations.subtitle', {
                  defaultValue: 'Connect the systems that feed your facilities — REST APIs, file imports and your own tables.',
                })
          }
          actions={addMenu}
        />
      </div>

      {!loadError && (
        <section {...rise(1, 'grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4')} aria-label={t('integrations.kpiLabel', { defaultValue: 'Integration totals' })}>
          <StatCard
            icon={Cloud}
            label={t('integrations.kpiSourcesShort', { defaultValue: 'Sources' })}
            value={sources.length}
            hint={t('integrations.kpiSourcesHint', { defaultValue: '{{rest}} REST · {{files}} files', rest: restCount, files: fileCount })}
            loading={loading}
          />
          <StatCard icon={Table2} label={t('integrations.kpiTables', { defaultValue: 'Tables' })} value={tables.length} to="/tables" loading={tablesQuery.isLoading && !tablesQuery.data} />
          <StatCard
            icon={TriangleAlert}
            label={t('integrations.kpiAttention', { defaultValue: 'Need attention' })}
            value={attention.length}
            hint={
              attention.length > 0
                ? t('integrations.kpiFailingHint', { defaultValue: 'Last run returned an error' })
                : sources.length > 0
                  ? t('integrations.kpiAllHealthy', { defaultValue: 'All runs healthy' })
                  : t('integrations.kpiNothingToCheck', { defaultValue: 'Nothing to check yet' })
            }
            loading={loading}
          />
          <StatCard
            icon={Clock}
            label={t('integrations.kpiLastSync', { defaultValue: 'Last sync' })}
            value={lastSync ? relativeTime(new Date(lastSync).toISOString(), i18n.language) : '—'}
            hint={lastSync ? fullTime(new Date(lastSync).toISOString(), i18n.language) : t('integrations.kpiNoSync', { defaultValue: 'No source has run yet' })}
            loading={loading}
          />
        </section>
      )}

      {attention.length > 0 && !onlyAttention && (
        <div {...rise(2, 'flex flex-col gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 sm:flex-row sm:items-center')}>
          <TriangleAlert className="hidden h-5 w-5 shrink-0 text-danger sm:block" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {t('integrations.attentionTitle', { defaultValue: '{{count}} integrations need attention', count: attention.length })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('integrations.attentionBody', { defaultValue: 'Their last run failed, so the data they feed may be out of date.' })}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => {
              setViewParam('sources')
              setStatusParam('attention')
            }}
          >
            {t('tables.showNeedsSetup', { defaultValue: 'Show only these' })}
          </Button>
        </div>
      )}

      <Tabs value={view} onValueChange={(v) => setViewParam(v)} {...rise(3)}>
        <TabsList>
          {viewTabs.map((v) => (
            <TabsTrigger key={v.value} value={v.value}>
              <v.icon className="hidden sm:block" />
              {v.label}
              {v.count !== undefined && v.count > 0 && (
                <span className={cn('tabular-nums', v.value === 'health' ? 'text-danger' : 'text-muted-foreground')}>{v.count}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="sources" className="mt-5 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <FilterTabs ariaLabel={t('integrations.sourcesTabsLabel', { defaultValue: 'Sources' })} items={kindItems} value={kind} onChange={(v) => setKindParam(v)} />
            <div className="relative lg:ms-auto lg:w-72">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('integrations.searchPlaceholder', { defaultValue: 'Search by name, URL or file' })}
                aria-label={t('integrations.searchPlaceholder', { defaultValue: 'Search by name, URL or file' })}
                className="ps-9"
              />
            </div>
          </div>

          {onlyAttention && (
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="danger">{t('integrations.filterAttention', { defaultValue: 'Needs attention' })}</Badge>
              <button type="button" onClick={() => setStatusParam('')} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
                {t('integrations.showAll', { defaultValue: 'Show all' })}
              </button>
            </div>
          )}

          {loadError ? (
            <QueryError error={loadError} onRetry={sourcesQuery.mutate} what={t('integrations.whatSources', { defaultValue: 'your integrations' })} />
          ) : loading ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-44 rounded-xl" />
              ))}
            </div>
          ) : nothingAtAll && solution ? (
            <EmptyState
              icon={Search}
              title={t('solutions.noIntegrationsTitle', { name: solution.name, defaultValue: 'No integrations in {{name}} yet' })}
              description={t('solutions.noIntegrationsBody', { defaultValue: 'Add integrations and tables to this solution with “Manage contents” above.' })}
            />
          ) : nothingAtAll ? (
            <GettingStarted
              canManage={canManage}
              onRest={() => setRestEditor({ source: null })}
              onFile={() => setImportOpen(true)}
              onTable={() => navigate('/tables/new')}
            />
          ) : noMatch ? (
            <EmptyState
              icon={Search}
              title={t('integrations.noMatchTitle', { defaultValue: 'Nothing matches' })}
              description={
                kind === 'rest' && restCount === 0
                  ? t('integrations.emptyRest', { defaultValue: 'No REST APIs connected' })
                  : kind === 'file' && fileCount === 0
                    ? t('integrations.emptyFile', { defaultValue: 'No file imports yet' })
                    : t('integrations.noMatchBody', { defaultValue: 'Try another search or filter.' })
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQ('')
                    setKindParam('all')
                    setStatusParam('')
                  }}
                >
                  {t('tables.clearFilters', { defaultValue: 'Clear filters' })}
                </Button>
              }
            />
          ) : (
            <div key={`${kind}:${onlyAttention}`} className="sgv-fade space-y-6">
              {visibleSources.length > 0 && (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {visibleSources.map((s) => (
                    <SourceCard
                      key={s.id}
                      source={s}
                      canManage={canManage}
                      running={runningId === s.id}
                      onOpen={() => setSourceParam(String(s.id))}
                      onRun={() => void run(s)}
                      onEdit={() => setRestEditor({ source: s })}
                      onDelete={() => askDelete(s)}
                      onTestOutbound={() => void testOutbound(s)}
                    />
                  ))}
                </div>
              )}
              {visibleTables.length > 0 && (
                <div className="space-y-3">
                  {kind === 'all' && visibleSources.length > 0 && (
                    <div className="flex items-baseline justify-between">
                      <h2 className="text-sm font-semibold">{t('integrations.tablesHeading', { defaultValue: 'Tables' })}</h2>
                      <p className="text-xs text-muted-foreground">{t('integrations.tablesHint', { defaultValue: 'Your systems write to these through each table’s API.' })}</p>
                    </div>
                  )}
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {visibleTables.map((tb) => (
                      <TableSourceCard key={tb.dataSource.id} table={tb} showId={tables.filter((x) => x.dataSource.name === tb.dataSource.name).length > 1} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="health" className="mt-5">
          <HealthSection
            sources={sources}
            tables={tables}
            loading={loading}
            onOpenSource={(s) => {
              setViewParam('sources')
              setSourceParam(String(s.id))
            }}
            onRun={(s) => void run(s)}
            runningId={runningId}
            canManage={canManage}
          />
        </TabsContent>
        <TabsContent value="audit" className="mt-5">
          <AuditLogSection />
        </TabsContent>
        <TabsContent value="references" className="mt-5">
          <ReferencesSection canManage={canManage} />
        </TabsContent>
        <TabsContent value="rules" className="mt-5">
          <RulesSection canManage={canManage} />
        </TabsContent>
      </Tabs>

      {openSource && (
        <SourceDetailSheet
          source={openSource}
          open
          onOpenChange={(o) => !o && setSourceParam('')}
          canManage={canManage}
          running={runningId === openSource.id}
          onRun={() => void run(openSource)}
          onEdit={() => setRestEditor({ source: openSource })}
          onTestOutbound={() => void testOutbound(openSource)}
          onDelete={() => askDelete(openSource)}
        />
      )}

      {restEditor && (
        <RestSourceEditor
          key={restEditor.source?.id ?? 'new'}
          open
          existing={restEditor.source}
          onOpenChange={(o) => {
            if (!o) {
              setRestEditor(null)
              queryCache.invalidate('dataSources')
            }
          }}
        />
      )}

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        context="integrations"
        onCommitted={() => {
          sourcesQuery.mutate()
          toast.success(t('integrations.imported', { defaultValue: 'File imported' }))
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
        title={t('integrations.deleteTitle', { defaultValue: 'Delete {{name}}?', name: deleteTarget?.name ?? '' })}
        description={t('integrations.deleteBody', {
          defaultValue: 'The connection and the rows it imported are removed. Layers that use it on a map stop showing its data.',
        })}
        confirmLabel={t('integrations.deleteConfirm', { defaultValue: 'Delete integration' })}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
        error={deleteError}
      />
    </PageContainer>
  )
}

// ============================================================== cards

function SourceCard({
  source,
  canManage,
  running,
  onOpen,
  onRun,
  onEdit,
  onDelete,
  onTestOutbound,
}: {
  source: DataSource
  canManage: boolean
  running: boolean
  onOpen: () => void
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
  onTestOutbound: () => void
}) {
  const { t, i18n } = useTranslation()
  const scheduleLabel = useScheduleLabel()
  const file = isFileSource(source)
  const cfg = source.config as { url?: string; fileName?: string }
  const lastRun = source.lastRunAt ? new Date(source.lastRunAt).toISOString() : undefined
  let host = cfg.url ?? ''
  try {
    host = cfg.url ? new URL(cfg.url).host + new URL(cfg.url).pathname : ''
  } catch {
    /* show raw */
  }

  return (
    <article
      className={cn(
        'sgv-lift group relative flex flex-col rounded-xl border bg-card p-4 transition-colors',
        needsAttention(source) && 'border-danger/40',
      )}
    >
      <div className="flex items-start gap-3">
        <SourceKindIcon source={source} />
        <div className="min-w-0 flex-1">
          {/* The whole card opens the panel — the title is the real button
              so keyboard users get it too. */}
          <button
            type="button"
            onClick={onOpen}
            className="block max-w-full truncate text-start text-sm font-semibold after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
            title={source.name}
          >
            {source.name}
          </button>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" dir={file ? undefined : 'ltr'}>
            {file ? cfg.fileName ?? source.kind.toUpperCase() : host || '—'}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative z-[1] -me-1.5 -mt-1 h-8 w-8 shrink-0 text-muted-foreground" aria-label={t('integrations.actionsFor', { defaultValue: 'Actions for {{name}}', name: source.name })}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onOpen}>
              <ArrowRight className="me-2 h-4 w-4 rtl:rotate-180" />
              {t('integrations.openDetails', { defaultValue: 'Details' })}
            </DropdownMenuItem>
            {canManage && source.kind === 'rest' && (
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="me-2 h-4 w-4" />
                {t('common.edit', { defaultValue: 'Edit' })}
              </DropdownMenuItem>
            )}
            {canManage && source.kind === 'rest' && (
              <DropdownMenuItem onSelect={onTestOutbound}>
                <Send className="me-2 h-4 w-4" />
                {t('integrations.testOutbound', { defaultValue: 'Test outbound' })}
              </DropdownMenuItem>
            )}
            {canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onDelete} className="text-danger focus:bg-danger/10 focus:text-danger">
                  <Trash2 className="me-2 h-4 w-4" />
                  {t('common.delete', { defaultValue: 'Delete' })}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {missingRowKey(source) ? (
          <Badge variant="warning">{t('integrations.noRowKeyBadge', { defaultValue: 'No row key' })}</Badge>
        ) : (
          <SourceStatus source={source} />
        )}
        <Badge variant="muted" className="uppercase">{source.kind}</Badge>
        {source.entityKind && <Badge variant="outline" className="capitalize">{source.entityKind}</Badge>}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground" style={{ marginTop: '1rem' }}>
        <span className="min-w-0 truncate">
          {scheduleLabel(source)}
          {' · '}
          <span title={lastRun ? fullTime(lastRun, i18n.language) : undefined}>
            {lastRun
              ? t('integrations.lastRunAgo', { defaultValue: 'ran {{when}}', when: relativeTime(lastRun, i18n.language) })
              : t('integrations.status.never', { defaultValue: 'Not run yet' })}
          </span>
        </span>
        {canManage && (
          <Button variant="outline" size="sm" className="relative z-[1] h-7 shrink-0" onClick={onRun} disabled={running}>
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {file ? t('integrations.reimport', { defaultValue: 'Re-import' }) : t('integrations.runNow', { defaultValue: 'Run now' })}
          </Button>
        )}
      </div>
    </article>
  )
}

/** A table is a push-based source: its card leads to the table's own page. */
function TableSourceCard({ table, showId }: { table: TableResponse; showId?: boolean }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const ds = table.dataSource
  const fields = table.fields.length
  const updated = ds.updatedAt
  return (
    <article className="sgv-lift group relative flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
        <KeyRound className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => navigate(`/tables/${ds.id}`)}
          className="block max-w-full truncate text-start text-sm font-medium after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          title={ds.name}
        >
          {ds.name}
          {showId && <span className="ms-1.5 font-mono text-xs font-normal text-muted-foreground">#{ds.id}</span>}
        </button>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {[ds.entityKind, t('tables.fieldCount', { defaultValue: '{{count}} fields', count: fields })].filter(Boolean).join(' · ')}
          {' · '}
          <span title={fullTime(updated, i18n.language)}>{relativeTime(updated, i18n.language)}</span>
        </p>
      </div>
      {fields === 0 ? (
        <Badge variant="warning" className="shrink-0">{t('tables.badgeNoFields', { defaultValue: 'No fields' })}</Badge>
      ) : (
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" aria-hidden />
      )}
    </article>
  )
}

/** First-run: the three ways in, explained side by side. */
function GettingStarted({
  canManage,
  onRest,
  onFile,
  onTable,
}: {
  canManage: boolean
  onRest: () => void
  onFile: () => void
  onTable: () => void
}) {
  const { t } = useTranslation()
  const items = [
    {
      icon: Cloud,
      title: t('integrations.gsRestTitle', { defaultValue: 'Pull from an API' }),
      body: t('integrations.gsRestBody', { defaultValue: 'Your WMS, ERP or IoT platform already has an endpoint. We fetch it on a schedule.' }),
      cta: t('integrations.addRest', { defaultValue: 'REST API' }),
      onClick: onRest,
    },
    {
      icon: Upload,
      title: t('integrations.gsFileTitle', { defaultValue: 'Import a file' }),
      body: t('integrations.gsFileBody', { defaultValue: 'A spreadsheet or GeoJSON export. Good for a first look or one-off loads.' }),
      cta: t('integrations.uploadFile', { defaultValue: 'Upload file' }),
      onClick: onFile,
    },
    {
      icon: Table2,
      title: t('integrations.gsTableTitle', { defaultValue: 'Let your systems push' }),
      body: t('integrations.gsTableBody', { defaultValue: 'Define a table and your code writes rows to it with an API key.' }),
      cta: t('integrations.addTable', { defaultValue: 'Table' }),
      onClick: onTable,
    },
  ]
  return (
    <div className="rounded-xl border border-dashed bg-card/50 p-6">
      <h2 className="text-base font-semibold">{t('integrations.gsTitle', { defaultValue: 'Bring your data in' })}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('integrations.gsBody', { defaultValue: 'Pick how your data should arrive. You can mix all three.' })}
      </p>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {items.map((it) => (
          <div key={it.title} className="flex flex-col rounded-lg border bg-card p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <it.icon className="h-4 w-4" aria-hidden />
            </span>
            <p className="mt-3 text-sm font-medium">{it.title}</p>
            <p className="mt-1 flex-1 text-sm text-muted-foreground">{it.body}</p>
            <RoleGate allowed={canManage}>
              <Button variant="outline" size="sm" className="mt-4 w-fit" onClick={it.onClick} disabled={!canManage}>
                <Plus className="h-4 w-4" />
                {it.cta}
              </Button>
            </RoleGate>
          </div>
        ))}
      </div>
    </div>
  )
}
