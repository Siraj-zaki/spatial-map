/**
 * ReportsDashboard — the `/reports` gallery. Every report in the current
 * workspace the caller may see (the backend enforces the ACL; each row
 * carries `canEdit`).
 *
 *   - Hero: Import JSON + New report, for owners/admins only — the same
 *     rule the API applies to `POST /reports` (it used to be guessed from
 *     "can edit any report", so an editor saw a button that 403'd).
 *   - KPIs: reports (and how many facilities they cover) · starred ·
 *     updated this week · need setup.
 *   - Facility tabs, then type tabs + Starred, then search / sort / view.
 *     Search, type, sort and starred live in the URL; the facility too.
 *   - Cards show each report's real layout in its own colour
 *     (`ReportLayoutPreview`) and rise in, staggered; List is one line per
 *     report. Archive is immediate with an Undo toast
 *     (`POST /reports/{id}/restore`); Duplicate and Import open the new
 *     report from their toast.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Archive,
  ArrowUpDown,
  Building2,
  CalendarClock,
  Check,
  Copy,
  FileBarChart,
  Globe2,
  LayoutGrid,
  List,
  Map as MapIcon,
  Loader2,
  MoreHorizontal,
  PencilLine,
  Plus,
  Search,
  Sparkles,
  Star,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageContainer, PageHero } from '@/components/page-shell'
import { useActiveSolution } from '@/lib/solutions-client'
import { QueryError } from '@/components/feedback/query-error'
import { EmptyState } from '@/components/empty-state'
import { FilterTabs } from '@/components/filter-tabs'
import { StatCard } from '@/components/stat-card'
import { ReportLayoutPreview } from '@/components/reports/report-layout-preview'
import { CLASS_META, ReportIcon, StarButton, useStarred } from '@/components/reports/report-identity'
import { useUrlState } from '@/hooks/useUrlState'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { toast } from '@/lib/toast-store'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import {
  archiveReport,
  classifyReport,
  createReport,
  listReports,
  restoreReport,
  seedDemoReports,
  type Report,
  type ReportClass,
  type ReportSpec,
} from '@/lib/reports-client'
import { apiDb } from '@/lib/api-db'
import type { MasterReportText } from '@/lib/reports/master-report'
import { MasterReportDialog } from '@/components/reports/master-report-dialog'
import { useSpatialStore } from '@/lib/spatial-store'
import type { Zone } from '@/lib/db'

type SortKey = 'name' | 'updated' | 'widgets'

const SORT_OPTIONS: { key: SortKey; label: string; fallback: string }[] = [
  { key: 'updated', label: 'reports.sortUpdated', fallback: 'Recently updated' },
  { key: 'name', label: 'reports.sortName', fallback: 'Name (A–Z)' },
  { key: 'widgets', label: 'reports.sortWidgets', fallback: 'Most widgets' },
]

const WEEK_MS = 7 * 86_400_000

function widgetCount(r: Report): number {
  return r.spec.widgets?.length ?? 0
}

function needsSetup(r: Report): boolean {
  return (r.spec.sources?.length ?? 0) === 0 || widgetCount(r) === 0
}

/** "<name> (Copy)", then "(Copy 2)", … — never collides with an existing name. */
function uniqueCopyName(source: string, existing: string[]): string {
  const base = `${source} (Copy)`
  if (!existing.includes(base)) return base
  let i = 2
  while (existing.includes(`${source} (Copy ${i})`)) i += 1
  return `${source} (Copy ${i})`
}

function facilityName(report: Report, zones: Zone[], t: (k: string, o?: Record<string, unknown>) => string): string {
  if (report.zoneId == null) return t('reports.facilityShared', { defaultValue: 'Shared' })
  return zones.find((z) => z.id === report.zoneId)?.name ?? t('reports.facilityUnknown', { defaultValue: 'Unknown facility' })
}

export function ReportsDashboard() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const canManage = useWorkspaceRole().can('reports.create')

  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [reloadToken, setReloadToken] = useState(0)
  // "This week" is measured from when the page opened, not re-read every render.
  const [openedAt] = useState(() => Date.now())

  const [search, setSearch] = useUrlState<string>('q', '')
  const [classParam, setClassParam] = useUrlState<string>('type', '')
  const classFilter = (classParam || null) as ReportClass | null
  const [sortParam, setSortParam] = useUrlState<string>('sort', 'updated')
  const sortKey: SortKey = SORT_OPTIONS.some((o) => o.key === sortParam) ? (sortParam as SortKey) : 'updated'
  const [starredParam, setStarredParam] = useUrlState<string>('starred', '')
  const onlyStarred = starredParam === '1'
  const [starred, toggleStar] = useStarred(useCurrentTenantId())

  // View density — remembered in this browser (a convenience, not state).
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try {
      return (window.localStorage.getItem('reports.viewMode') as 'grid' | 'list') || 'grid'
    } catch {
      return 'grid'
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem('reports.viewMode', viewMode)
    } catch {
      // storage unavailable — the toggle still works for this visit
    }
  }, [viewMode])

  // Facility scope: `?facility=<id>|all`; by default the facility the user
  // last had open on the map, so they land on its reports.
  const activeZoneId = useSpatialStore((s) => s.activeZoneId)
  const [allZones, setZones] = useState<Zone[]>([])
  // Inside a solution: only its reports, and its facilities as the tabs —
  // starting on "All facilities" rather than the last map facility.
  const { solution } = useActiveSolution()
  const solutionReportKey = solution ? solution.reportIds.join(',') : null
  const zones = useMemo(
    () => (solution ? allZones.filter((z) => solution.zoneIds.includes(z.id!)) : allZones),
    [allZones, solution],
  )
  const facilityParam = searchParams.get('facility')
  const selectedFacility: number | null =
    facilityParam === 'all' ? null : facilityParam ? Number(facilityParam) : solution ? null : (activeZoneId ?? null)

  const reload = () => {
    setLoading(true)
    setLoadError(null)
    setReloadToken((n) => n + 1)
  }

  const changeFacility = (next: number | null) => {
    setLoading(true)
    setLoadError(null)
    const params = new URLSearchParams(window.location.search)
    params.set('facility', next === null ? 'all' : String(next))
    setSearchParams(params, { replace: true })
  }

  useEffect(() => {
    let cancelled = false
    apiDb.zones
      .toArray()
      .then((list: Zone[]) => {
        if (!cancelled) setZones(list.filter((z) => z.id !== undefined))
      })
      .catch(() => {
        // facility names are context; cards fall back to "Unknown facility"
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    listReports(selectedFacility === null ? undefined : { zoneId: selectedFacility })
      .then((res) => {
        if (cancelled) return
        if (solutionReportKey === null) setReports(res)
        else {
          const ids = new Set(solutionReportKey.split(',').filter(Boolean).map(Number))
          setReports(res.filter((r) => ids.has(r.id)))
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken, selectedFacility, solutionReportKey])

  const stats = useMemo(() => {
    const facilities = new Set(reports.filter((r) => r.zoneId != null).map((r) => r.zoneId))
    const recent = reports.filter((r) => openedAt - Date.parse(r.updatedAt) < WEEK_MS)
    const newest = [...reports].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
    return {
      reports: reports.length,
      facilities: facilities.size,
      starred: reports.filter((r) => starred.has(r.id)).length,
      recent: recent.length,
      newest,
      needsSetup: reports.filter(needsSetup).length,
    }
  }, [reports, starred, openedAt])

  const classCounts = useMemo(() => {
    const counts = new Map<ReportClass, number>()
    for (const r of reports) {
      const cls = classifyReport(r.spec)
      counts.set(cls, (counts.get(cls) ?? 0) + 1)
    }
    return counts
  }, [reports])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matched = reports.filter((r) => {
      if (classFilter && classifyReport(r.spec) !== classFilter) return false
      if (onlyStarred && !starred.has(r.id)) return false
      if (!q) return true
      return (
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        // "map" finds map reports before anyone has named one that way.
        (r.spec.widgets ?? []).some((w) => w.kind.toLowerCase().includes(q))
      )
    })
    return matched.sort((a, b) => {
      // Starred float to the top within any sort.
      const star = Number(starred.has(b.id)) - Number(starred.has(a.id))
      if (star !== 0) return star
      if (sortKey === 'name') return a.name.localeCompare(b.name, i18n.language)
      if (sortKey === 'widgets') return widgetCount(b) - widgetCount(a)
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    })
  }, [reports, search, classFilter, sortKey, onlyStarred, starred, i18n.language])

  const filtered = !!search || !!classFilter || onlyStarred
  const clearFilters = () => {
    setSearch('')
    setClassParam('')
    setStarredParam('')
  }

  // ---------------------------------------------------------------- actions

  const [seeding, setSeeding] = useState(false)
  const runSeed = async () => {
    if (seeding) return
    setSeeding(true)
    try {
      await seedDemoReports()
      reload()
    } catch (err) {
      toast.error(t('reports.seedFailed', { defaultValue: 'Couldn’t add the sample reports' }), { description: (err as Error).message })
    } finally {
      setSeeding(false)
    }
  }

  const restore = async (report: Report) => {
    try {
      await restoreReport(report.id)
      toast.success(t('reports.restored', { defaultValue: '{{name}} restored', name: report.name }))
      reload()
    } catch (err) {
      toast.error(t('reports.restoreFailed', { defaultValue: 'Couldn’t restore {{name}}', name: report.name }), {
        description: (err as Error).message,
      })
    }
  }

  // Archive is immediate (it's reversible) — the card leaves at once and
  // the toast offers Undo for eight seconds.
  const archive = async (report: Report) => {
    setReports((prev) => prev.filter((r) => r.id !== report.id))
    try {
      await archiveReport(report.id)
      toast.success(t('reports.archivedV2', { defaultValue: '{{name}} archived', name: report.name }), {
        description: t('reports.archivedBody', { defaultValue: 'Its run history is kept.' }),
        action: { label: t('common.undo', { defaultValue: 'Undo' }), onClick: () => void restore(report) },
      })
    } catch (err) {
      toast.error(t('reports.archiveFailed', { defaultValue: 'Couldn’t archive {{name}}', name: report.name }), {
        description: (err as Error).message,
      })
      reload()
    }
  }

  const [duplicatingId, setDuplicatingId] = useState<number | null>(null)
  const duplicate = async (report: Report) => {
    if (duplicatingId !== null) return
    setDuplicatingId(report.id)
    try {
      const copy = await createReport({
        name: uniqueCopyName(report.name, reports.map((r) => r.name)),
        description: report.description,
        icon: report.icon ?? undefined,
        color: report.color ?? undefined,
        spec: report.spec,
        specVersion: 2,
        zoneId: report.zoneId ?? null,
        permissions: [],
      })
      toast.success(t('reports.duplicatedV2', { defaultValue: '{{name}} created', name: copy.name }), {
        action: { label: t('reports.openCopy', { defaultValue: 'Open' }), onClick: () => navigate(`/reports/${copy.id}`) },
      })
      reload()
    } catch (err) {
      toast.error(t('reports.duplicateFailed', { defaultValue: 'Couldn’t duplicate {{name}}', name: report.name }), {
        description: (err as Error).message,
      })
    } finally {
      setDuplicatingId(null)
    }
  }

  const [importOpen, setImportOpen] = useState(false)

  // Master report: the picked facility's live full-map report, set up (or
  // updated) in a dialog. `?master=1` opens it (the report's own menu links here).
  const [masterOpen, setMasterOpen] = useState(() => new URLSearchParams(window.location.search).get('master') === '1')
  const masterFacility = selectedFacility !== null ? allZones.find((z) => z.id === selectedFacility) : undefined
  const masterText: MasterReportText = {
    name: t('reports.master.name', { facility: masterFacility?.name ?? '', defaultValue: '{{facility}} · Master report' }),
    description: t('reports.master.description', { defaultValue: 'Everything in one live view: the facility\'s data layers on the map with their history player, counts, status breakdowns and filters. Pick an item to follow it.' }),
    mapTitle: t('reports.master.mapTitle', { defaultValue: 'Live map' }),
    rowsLabel: t('reports.master.rows', { defaultValue: 'Rows' }),
    byStatus: (layer, field) => t('reports.master.byStatus', { layer, field, defaultValue: '{{layer}} by {{field}}' }),
  }
  const closeMaster = () => {
    setMasterOpen(false)
    const url = new URL(window.location.href)
    if (url.searchParams.has('master')) {
      url.searchParams.delete('master')
      window.history.replaceState(window.history.state, '', url)
    }
  }

  const createButton = canManage ? (
    <>
      <Button variant="outline" onClick={() => setImportOpen(true)}>
        <Upload className="h-4 w-4" />
        {t('reports.importJson', { defaultValue: 'Import JSON' })}
      </Button>
      <Button
        variant="outline"
        onClick={() => setMasterOpen(true)}
        disabled={!masterFacility}
        title={
          masterFacility
            ? t('reports.master.hint', { facility: masterFacility.name, defaultValue: 'Set up the live master report for {{facility}}' })
            : t('reports.master.pickFacility', { defaultValue: 'Pick a facility first' })
        }
      >
        <MapIcon className="h-4 w-4" />
        {t('reports.master.button', { defaultValue: 'Master report' })}
      </Button>
      <Button onClick={() => navigate(solution ? `/reports/new?solution=${solution.id}` : '/reports/new')}>
        <Plus className="h-4 w-4" />
        {t('reports.createNew', { defaultValue: 'New report' })}
      </Button>
    </>
  ) : undefined

  const cardProps = (report: Report) => ({
    report,
    // Every facility, so a report pinned outside the solution still shows its name.
    zones: allZones,
    locale: i18n.language,
    starred: starred.has(report.id),
    onToggleStar: () => toggleStar(report.id),
    onOpen: () => navigate(`/reports/${report.id}`),
    actions: report.canEdit ? (
      <ReportActions
        report={report}
        canArchive={canManage}
        duplicating={duplicatingId === report.id}
        onEdit={() => navigate(`/reports/${report.id}/edit`)}
        onDuplicate={() => void duplicate(report)}
        onArchive={() => void archive(report)}
      />
    ) : null,
  })

  const sortLabel = t(SORT_OPTIONS.find((o) => o.key === sortKey)!.label, {
    defaultValue: SORT_OPTIONS.find((o) => o.key === sortKey)!.fallback,
  })

  return (
    <PageContainer>
      <PageHero
        title={t('reports.heroTitle', { defaultValue: 'Reports' })}
        description={
          solution
            ? t('solutions.reportsDescription', { name: solution.name, defaultValue: 'The reports in {{name}}. Open one to view it, or build a new one here — it joins the solution.' })
            : t('reports.heroDescription', {
                defaultValue: 'Live dashboards built from your tables and integrations. Open one to view it, or build your own.',
              })
        }
        actions={createButton}
      />

      {(loading || reports.length > 0) && !loadError && (
        <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" aria-label={t('reports.kpiLabel', { defaultValue: 'Report totals' })}>
          <StatCard
            icon={FileBarChart}
            label={t('reports.kpiReportsTitle', { defaultValue: 'Reports' })}
            value={stats.reports}
            hint={
              stats.facilities > 0
                ? t('reports.kpiFacilities', { defaultValue: 'Across {{count}} facilities', count: stats.facilities })
                : t('reports.kpiAllShared', { defaultValue: 'All shared across facilities' })
            }
            loading={loading}
          />
          <StatCard
            icon={Star}
            label={t('reports.kpiStarred', { defaultValue: 'Starred' })}
            value={stats.starred}
            hint={
              stats.starred > 0
                ? t('reports.kpiStarredHint', { defaultValue: 'Pinned to the top' })
                : t('reports.kpiStarredNone', { defaultValue: 'Star a report to pin it' })
            }
            loading={loading}
          />
          <StatCard
            icon={CalendarClock}
            label={t('reports.kpiRecent', { defaultValue: 'Updated this week' })}
            value={stats.recent}
            hint={
              stats.newest
                ? t('reports.kpiRecentHintV2', {
                    defaultValue: 'Latest: {{name}}, {{when}}',
                    name: stats.newest.name,
                    when: relativeTime(stats.newest.updatedAt, i18n.language),
                  })
                : undefined
            }
            loading={loading}
          />
          <StatCard
            icon={TriangleAlert}
            label={t('reports.kpiNeedsSetupTitle', { defaultValue: 'Need setup' })}
            value={stats.needsSetup}
            hint={
              stats.needsSetup === 0
                ? t('reports.kpiAllReady', { defaultValue: 'Every report has data' })
                : t('reports.kpiNeedsSetupHint', { defaultValue: 'Missing a source or widgets' })
            }
            loading={loading}
          />
        </section>
      )}

      {!loadError && (
        <div className="flex flex-col gap-3">
          {zones.length > 0 && (
            <FilterTabs
              ariaLabel={t('reports.facilityFilterLabel', { defaultValue: 'Filter by facility' })}
              value={selectedFacility === null ? '__all' : String(selectedFacility)}
              onChange={(v) => changeFacility(v === '__all' ? null : Number(v))}
              className="self-start"
              items={[
                { value: '__all', label: t('reports.facilityAll', { defaultValue: 'All facilities' }), icon: Globe2 },
                ...zones.map((z) => ({ value: String(z.id), label: z.name, icon: Building2 })),
              ]}
            />
          )}
          {/* Two rows below xl (type + Starred, then search + sort + view),
              one row from xl up. */}
          <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
            <div className="flex min-w-0 items-center gap-2">
              {classCounts.size > 1 && (
                <FilterTabs
                  ariaLabel={t('reports.classFilterLabel', { defaultValue: 'Filter by type' })}
                  value={classFilter ?? '__all'}
                  onChange={(v) => setClassParam(v === '__all' ? '' : v)}
                  className="min-w-0"
                  items={[
                    { value: '__all', label: t('reports.filterAllKinds', { defaultValue: 'All' }), count: reports.length },
                    ...(Object.keys(CLASS_META) as ReportClass[])
                      .filter((cls) => classCounts.has(cls))
                      .map((cls) => ({
                        value: cls,
                        label: t(CLASS_META[cls].labelKey, { defaultValue: CLASS_META[cls].fallback }),
                        icon: CLASS_META[cls].icon,
                        count: classCounts.get(cls),
                      })),
                  ]}
                />
              )}
              <Button
                variant={onlyStarred ? 'secondary' : 'outline'}
                size="sm"
                className="h-9 shrink-0"
                aria-pressed={onlyStarred}
                onClick={() => setStarredParam(onlyStarred ? '' : '1')}
              >
                <Star className={cn('h-3.5 w-3.5', onlyStarred && 'fill-current text-warning')} />
                {t('reports.starredFilter', { defaultValue: 'Starred' })}
                {stats.starred > 0 && <span className="text-xs tabular-nums text-muted-foreground">{stats.starred}</span>}
              </Button>
            </div>
            <div className="flex items-center gap-2 xl:ms-auto">
              <span className="hidden shrink-0 text-sm tabular-nums text-muted-foreground sm:inline" aria-live="polite">
                {t('reports.matchCount', { count: visible.length })}
              </span>
              <div className="relative min-w-0 flex-1 xl:w-64 xl:flex-none">
                <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('reports.searchPlaceholder', { defaultValue: 'Search reports' })}
                  aria-label={t('reports.searchPlaceholder', { defaultValue: 'Search reports' })}
                  className="h-9 pe-8 ps-8 [&::-webkit-search-cancel-button]:hidden"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t('reports.clearSearch', { defaultValue: 'Clear search' })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 shrink-0" aria-label={t('reports.sortBy', { defaultValue: 'Sort: {{label}}', label: sortLabel })}>
                    <ArrowUpDown className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{sortLabel}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {SORT_OPTIONS.map((opt) => (
                    <DropdownMenuItem key={opt.key} onSelect={() => setSortParam(opt.key)} className="gap-2">
                      <Check className={cn('h-3.5 w-3.5', sortKey === opt.key ? 'opacity-100' : 'opacity-0')} aria-hidden />
                      {t(opt.label, { defaultValue: opt.fallback })}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="flex h-9 shrink-0 items-center gap-0.5 rounded-md border p-0.5" role="group" aria-label={t('reports.viewLabel', { defaultValue: 'View' })}>
                <ViewModeToggle active={viewMode === 'grid'} icon={LayoutGrid} label={t('reports.viewGrid', { defaultValue: 'Grid' })} onClick={() => setViewMode('grid')} />
                <ViewModeToggle active={viewMode === 'list'} icon={List} label={t('reports.viewList', { defaultValue: 'List' })} onClick={() => setViewMode('list')} />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 pb-6">
        {!!loadError && <QueryError error={loadError} onRetry={reload} what={t('reports.whatReports', { defaultValue: 'your reports' })} />}

        {loading && !loadError && (viewMode === 'grid' ? <GridSkeleton /> : <ListSkeleton />)}

        {!loading && !loadError && reports.length === 0 && solution && (
          <EmptyState
            icon={FileBarChart}
            title={t('solutions.noReportsTitle', { name: solution.name, defaultValue: 'No reports in {{name}} yet' })}
            description={t('solutions.noReportsBody', { defaultValue: 'Add reports from this workspace, or build a new one here — it joins the solution.' })}
            action={
              canManage ? (
                <Button onClick={() => navigate(`/reports/new?solution=${solution.id}`)}>
                  <Plus className="h-4 w-4" />
                  {t('reports.createNew', { defaultValue: 'New report' })}
                </Button>
              ) : undefined
            }
          />
        )}

        {!loading && !loadError && reports.length === 0 && !solution && (
          <EmptyState
            icon={FileBarChart}
            title={t('reports.emptyTitle', { defaultValue: 'No reports yet' })}
            description={
              canManage
                ? t('reports.emptyBody', {
                    defaultValue: 'Compose a live view over your tables, integrations, or file imports — add widgets to render KPIs, tables, charts, or maps.',
                  })
                : t('reports.emptyBodyViewer', { defaultValue: 'When an admin shares a report with you, it shows up here.' })
            }
            action={
              canManage ? (
                <>
                  <Button onClick={() => navigate('/reports/new')}>
                    <Plus className="h-4 w-4" />
                    {t('reports.createNew', { defaultValue: 'New report' })}
                  </Button>
                  <Button variant="outline" onClick={() => void runSeed()} disabled={seeding}>
                    {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    {t('reports.seedDemo', { defaultValue: 'Seed demo data' })}
                  </Button>
                </>
              ) : undefined
            }
          />
        )}

        {!loading && !loadError && reports.length > 0 && visible.length === 0 && (
          <EmptyState
            icon={onlyStarred && !search && !classFilter ? Star : Search}
            title={
              onlyStarred && !search && !classFilter
                ? t('reports.noStarredTitle', { defaultValue: 'No starred reports here' })
                : t('reports.noMatchTitle', { defaultValue: 'No reports match' })
            }
            description={
              onlyStarred && !search && !classFilter
                ? t('reports.noStarredBody', { defaultValue: 'Star a report from its card or its page to keep it at the top.' })
                : t('reports.noMatchBody', { defaultValue: 'Try a different search term or clear the filters.' })
            }
            action={
              filtered ? (
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  {t('reports.clearFilters', { defaultValue: 'Clear filters' })}
                </Button>
              ) : undefined
            }
          />
        )}

        {!loading && !loadError && visible.length > 0 &&
          (viewMode === 'grid' ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visible.map((report, i) => (
                <ReportCard key={report.id} index={i} {...cardProps(report)} />
              ))}
            </div>
          ) : (
            <div className="sgv-fade divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
              {visible.map((report) => (
                <ReportRow key={report.id} {...cardProps(report)} />
              ))}
            </div>
          ))}
      </div>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        zoneId={selectedFacility}
        onImported={(r) => {
          toast.success(t('reports.importedV2', { defaultValue: '{{name}} imported', name: r.name }))
          navigate(`/reports/${r.id}`)
        }}
      />
      {masterOpen && canManage && masterFacility?.id !== undefined && (
        <MasterReportDialog
          open
          onOpenChange={(o) => !o && closeMaster()}
          zoneId={masterFacility.id}
          facilityName={masterFacility.name}
          text={masterText}
          onSaved={(r) => {
            toast.success(t('reports.master.saved', { name: r.name, defaultValue: '{{name}} saved' }))
            navigate(`/reports/${r.id}`)
          }}
        />
      )}
    </PageContainer>
  )
}

// ================================================================ pieces

function ViewModeToggle({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: typeof List
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-7 items-center gap-1 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

function ReportActions({
  report,
  canArchive,
  duplicating,
  onEdit,
  onDuplicate,
  onArchive,
}: {
  report: Report
  canArchive: boolean
  duplicating: boolean
  onEdit: () => void
  onDuplicate: () => void
  onArchive: () => void
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label={t('reports.rowActions', { defaultValue: 'Row actions for {{name}}', name: report.name })}
        >
          {duplicating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MoreHorizontal className="h-4 w-4" aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onEdit}>
          <PencilLine className="me-2 h-3.5 w-3.5" aria-hidden />
          {t('reports.editReport', { defaultValue: 'Edit' })}
        </DropdownMenuItem>
        {canArchive && (
          <DropdownMenuItem onSelect={onDuplicate} disabled={duplicating}>
            <Copy className="me-2 h-3.5 w-3.5" aria-hidden />
            {duplicating ? t('reports.duplicating', { defaultValue: 'Duplicating…' }) : t('reports.duplicateReport', { defaultValue: 'Duplicate' })}
          </DropdownMenuItem>
        )}
        {canArchive && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onArchive} className="text-destructive focus:text-destructive">
              <Archive className="me-2 h-3.5 w-3.5" aria-hidden />
              {t('reports.archiveReport', { defaultValue: 'Archive' })}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface CardProps {
  report: Report
  zones: Zone[]
  locale: string
  starred: boolean
  onToggleStar: () => void
  onOpen: () => void
  actions: React.ReactNode
}

function ReportCard({ report, zones, locale, starred, onToggleStar, onOpen, actions, index }: CardProps & { index: number }) {
  const { t } = useTranslation()
  const widgets = widgetCount(report)
  const sources = report.spec.sources?.length ?? 0
  const incomplete = needsSetup(report)
  const cls = classifyReport(report.spec)
  const meta = CLASS_META[cls]
  const facility = facilityName(report, zones, t)

  return (
    <article
      className="sgv-rise sgv-lift group relative flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm hover:border-foreground/20"
      style={{ '--sgv-i': index } as React.CSSProperties}
    >
      <div className="overflow-hidden border-b">
        <ReportLayoutPreview
          widgets={report.spec.widgets ?? []}
          color={report.color || undefined}
          className="aspect-[16/9] transition-transform duration-500 ease-out motion-safe:group-hover:scale-[1.03]"
          style={{ background: `linear-gradient(135deg, ${report.color || 'hsl(var(--primary))'}14, transparent 70%), hsl(var(--muted) / 0.4)` }}
        />
      </div>
      <StarButton starred={starred} onToggle={onToggleStar} name={report.name} className="absolute end-2 top-2 z-20" />

      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('reports.openReport', { defaultValue: 'Open {{name}}', name: report.name })}
      />

      <div className="pointer-events-none relative z-10 flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <ReportIcon report={report} fallback={meta.icon} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold" title={report.name}>{report.name}</h3>
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {report.zoneId == null ? <Globe2 className="h-3 w-3 shrink-0" aria-hidden /> : <Building2 className="h-3 w-3 shrink-0" aria-hidden />}
              <span className="truncate" title={facility}>{facility}</span>
            </p>
          </div>
          {actions && <div className="pointer-events-auto -me-1 shrink-0">{actions}</div>}
        </div>

        {report.description ? (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{report.description}</p>
        ) : (
          <p className="text-xs italic text-muted-foreground/70">{t('reports.noDescription', { defaultValue: 'No description' })}</p>
        )}

        <div className="mt-auto flex items-center gap-2 border-t pt-3 text-[11px] text-muted-foreground">
          <Badge variant="muted" className="shrink-0 gap-1">
            <meta.icon className="h-3 w-3" aria-hidden />
            {t(meta.labelKey, { defaultValue: meta.fallback })}
          </Badge>
          <span className="shrink-0 whitespace-nowrap tabular-nums" title={t('reports.sourceCount', { count: sources })}>
            {t('reports.widgetCount', { count: widgets })}
          </span>
          <span className="ms-auto min-w-0 truncate whitespace-nowrap" title={fullTime(report.updatedAt, locale)}>
            {incomplete ? (
              <Badge variant="warning">
                <TriangleAlert aria-hidden />
                {sources === 0 ? t('reports.badgeNoSource', { defaultValue: 'No source' }) : t('reports.badgeNoWidgets', { defaultValue: 'No widgets' })}
              </Badge>
            ) : (
              relativeTime(report.updatedAt, locale)
            )}
          </span>
        </div>
      </div>
    </article>
  )
}

/** One line per report — fits ~3× more than the grid. */
function ReportRow({ report, zones, locale, starred, onToggleStar, onOpen, actions }: CardProps) {
  const { t } = useTranslation()
  const widgets = widgetCount(report)
  const incomplete = needsSetup(report)
  const cls = classifyReport(report.spec)
  const meta = CLASS_META[cls]
  const facility = facilityName(report, zones, t)

  return (
    <div className="group relative flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40">
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={t('reports.openReport', { defaultValue: 'Open {{name}}', name: report.name })}
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-3">
        <StarButton plain starred={starred} onToggle={onToggleStar} name={report.name} className="pointer-events-auto -ms-1" />
        <ReportIcon report={report} fallback={meta.icon} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{report.name}</div>
          {report.description && <div className="hidden truncate text-xs text-muted-foreground md:block">{report.description}</div>}
        </div>
        <Badge variant="muted" className="hidden shrink-0 gap-1 sm:inline-flex">
          <meta.icon className="h-3 w-3" aria-hidden />
          {t(meta.labelKey, { defaultValue: meta.fallback })}
        </Badge>
        <span className="hidden w-36 shrink-0 items-center gap-1 truncate text-xs text-muted-foreground lg:flex" title={facility}>
          {report.zoneId == null ? <Globe2 className="h-3 w-3 shrink-0" aria-hidden /> : <Building2 className="h-3 w-3 shrink-0" aria-hidden />}
          <span className="truncate">{facility}</span>
        </span>
        <span className="hidden w-20 shrink-0 text-xs tabular-nums text-muted-foreground xl:inline">{t('reports.widgetCount', { count: widgets })}</span>
        <span className="hidden w-28 shrink-0 text-end text-xs text-muted-foreground md:inline" title={fullTime(report.updatedAt, locale)}>
          {incomplete ? (
            <Badge variant="warning">
              <TriangleAlert aria-hidden />
              {t('reports.needsSetupShort', { defaultValue: 'Needs setup' })}
            </Badge>
          ) : (
            relativeTime(report.updatedAt, locale)
          )}
        </span>
      </div>
      <div className="relative z-10 w-7 shrink-0">{actions}</div>
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border bg-card shadow-sm" aria-hidden>
          <Skeleton className="aspect-[16/9] rounded-none" />
          <div className="space-y-3 p-4">
            <div className="flex items-start gap-3">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <div className="flex gap-2 border-t pt-3">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-24" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="divide-y rounded-xl border bg-card" aria-busy>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 px-3" aria-hidden>
          <Skeleton className="h-7 w-7 rounded-md" />
          <Skeleton className="h-3.5 max-w-xs flex-1" />
          <Skeleton className="ms-auto h-3.5 w-24" />
        </div>
      ))}
    </div>
  )
}

/** Paste a spec (from the Review step's download, or another workspace). */
function ImportDialog({
  open,
  onOpenChange,
  zoneId,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  zoneId: number | null
  onImported: (report: Report) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [json, setJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = (next: boolean) => {
    if (busy) return
    onOpenChange(next)
    if (!next) setError(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    let spec: unknown
    try {
      spec = JSON.parse(json)
    } catch (err) {
      setError(t('reports.importBadJson', { defaultValue: 'That isn’t valid JSON: {{reason}}', reason: (err as Error).message }))
      return
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      setError(t('reports.importNotObject', { defaultValue: 'A report spec is a JSON object — it starts with “{”.' }))
      return
    }
    setBusy(true)
    try {
      const created = await createReport({
        name: name.trim(),
        description: '',
        spec: spec as ReportSpec,
        specVersion: 2,
        zoneId,
        permissions: [],
      })
      setName('')
      setJson('')
      onOpenChange(false)
      onImported(created)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="p-6 sm:max-w-lg">
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t('reports.importTitle', { defaultValue: 'Import report from JSON' })}</DialogTitle>
            <DialogDescription>
              {t('reports.importBody', { defaultValue: 'Paste a report spec downloaded from another workspace or the Review step.' })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="report-import-name" className="text-sm font-medium">
              {t('reports.importName', { defaultValue: 'Name' })}
            </label>
            <Input
              id="report-import-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('reports.importNamePlaceholder', { defaultValue: 'e.g. Warehouse overview' })}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="report-import-json" className="text-sm font-medium">
              {t('reports.importSpec', { defaultValue: 'Spec JSON' })}
            </label>
            <textarea
              id="report-import-json"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={10}
              dir="ltr"
              spellCheck={false}
              aria-invalid={!!error}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
              placeholder='{ "v": 2, "queries": [...], "widgets": [...] }'
            />
          </div>
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="flex-1 break-words">{error}</span>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !json.trim()}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('reports.importCreate', { defaultValue: 'Create report' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
