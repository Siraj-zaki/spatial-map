/**
 * Dashboard — the workspace at a glance (2026-09 redesign).
 *
 * Top to bottom:
 *   1. Header — the workspace's name + the two most common next steps.
 *   2. KPIs — facilities, bin occupancy, tracked assets, integrations.
 *   3. Your facilities (floor-plan thumbnail cards) beside a side column
 *      with the plan (owners) and workspace usage (members, files, storage,
 *      live streams).
 *   4. 30-day activity chart beside quick actions.
 *
 * The platform-admin block moved to /admin — this page is about the
 * workspace you're in, not the deployment.
 *
 * Data: /dashboard-overview (counts, timeline) + /warehouse-summaries
 * (six most recently updated facilities with thumbnails, and bin/asset
 * totals across the workspace).
 */

import { useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Boxes,
  Check,
  Clock,
  FileBarChart,
  ImageIcon,
  LayoutGrid,
  FolderOpen,
  HardDrive,
  PackageCheck,
  Plug,
  Plus,
  Radio,
  Sparkles,
  Table as TableIcon,
  Users,
  Warehouse,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useApiQuery } from '@/lib/useApiQuery'
import { getDashboardOverview, type DashboardOverview, type DashboardTimelinePoint } from '@/lib/dashboard-client'
import { listWarehouseSummaries, type WarehouseSummariesResponse } from '@/lib/warehouses-client'
import { listReports, type Report } from '@/lib/reports-client'
import { listTables, type TableResponse } from '@/lib/tables-client'
import { QueryError } from '@/components/feedback/query-error'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { FacilityCard, FacilityCardSkeleton } from '@/components/facility-card'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { StatCard } from '@/components/stat-card'
import { WelcomeDialog } from '@/components/onboarding/welcome-dialog'
import { useAuthStore, type AuthTenant } from '@/lib/auth-store'
import { getCurrentTenantIdSync, subscribeTenantChanges } from '@/lib/tenant-store'
import { cn } from '@/lib/utils'

const EMPTY_OVERVIEW: DashboardOverview = {
  counts: {
    totalWarehouses: 0,
    warehousesLast30d: 0,
    totalMembers: 0,
    membersLast30d: 0,
    totalIntegrations: 0,
    integrationsLast30d: 0,
    activeStreams: 0,
    totalFiles: 0,
    totalStorageBytes: 0,
  },
  timeline: [],
  recentWarehouses: [],
}

/** How many facility cards the dashboard shows before "View all". */
const FACILITY_PREVIEW_COUNT = 6

function useActiveTenant(): AuthTenant | null {
  const tenantId = useSyncExternalStore(subscribeTenantChanges, () => getCurrentTenantIdSync(), () => null)
  const tenants = useAuthStore((s) => s.tenants)
  return useMemo(() => tenants.find((t) => t.id === tenantId) ?? tenants[0] ?? null, [tenants, tenantId])
}

export default function Dashboard() {
  const { t } = useTranslation()
  const activeTenant = useActiveTenant()
  const user = useAuthStore((s) => s.user)
  const tenantId = activeTenant?.id ?? null
  const enabled = tenantId !== null

  const overviewQuery = useApiQuery<DashboardOverview>(() => getDashboardOverview(), ['dashboard-overview', tenantId], {
    intervalMs: 20000,
    enabled,
  })
  const facilitiesQuery = useApiQuery<WarehouseSummariesResponse>(
    () => listWarehouseSummaries({ sort: 'updatedAt', dir: 'desc', pageSize: FACILITY_PREVIEW_COUNT }),
    ['dashboard-facilities', tenantId],
    { intervalMs: 30000, enabled },
  )
  const reportsQuery = useApiQuery<Report[]>(() => listReports(), ['dashboard-reports', tenantId], { intervalMs: 60000, enabled })
  const tablesQuery = useApiQuery<TableResponse[]>(() => listTables(), ['dashboard-tables', tenantId], { intervalMs: 60000, enabled })

  const loading = enabled && overviewQuery.isLoading && !overviewQuery.data
  const facilitiesLoading = enabled && facilitiesQuery.isLoading && !facilitiesQuery.data
  const data = overviewQuery.data ?? EMPTY_OVERVIEW
  const facilities = facilitiesQuery.data?.rows ?? []
  const stats = facilitiesQuery.data?.stats

  const canManage = activeTenant?.role === 'owner' || activeTenant?.role === 'admin'
  const occupancy = stats && stats.totalBins > 0 ? stats.occupiedBins / stats.totalBins : undefined
  const in30 = t('dashboard.deltaIn30Days', { defaultValue: 'in 30 days' })
  const firstName = (user?.displayName || '').trim().split(/\s+/)[0]

  return (
    <PageContainer>
      <WelcomeDialog />
      <div {...rise(0)}>
        <PageHero
          title={
            firstName
              ? t(`dashboard.greeting.${greetingPart()}`, { defaultValue: greetingFallback(), name: firstName })
              : (activeTenant?.name ?? t('dashboard.heroTitleFallback', { defaultValue: 'Welcome back' }))
          }
          description={
            activeTenant
              ? t('dashboard.heroSubtitleNamed', {
                  defaultValue: 'Here’s what’s happening in {{workspace}}.',
                  workspace: activeTenant.name,
                })
              : undefined
          }
          actions={
            <>
              {canManage && (
                <Button asChild variant="outline">
                  <Link to="/members">
                    <Users className="h-4 w-4" />
                    {t('dashboard.inviteMembers', { defaultValue: 'Invite members' })}
                  </Link>
                </Button>
              )}
              <Button asChild>
                <Link to="/warehouses">
                  {t('dashboard.openWarehouses', { defaultValue: 'Open facilities' })}
                  <ArrowRight className="h-4 w-4 rtl:rotate-180" />
                </Link>
              </Button>
            </>
          }
        />
      </div>

      {tenantId !== null && !loading && !facilitiesLoading && overviewQuery.data && (
        <div {...rise(1)}>
          <GettingStarted
            tenantId={tenantId}
            canManage={canManage}
            hasFacility={data.counts.totalWarehouses > 0}
            hasFloorPlan={facilities.some((f) => Boolean(f.thumbnailUrl))}
            hasRacks={facilities.some((f) => f.rackCount > 0)}
            hasData={data.counts.totalIntegrations > 0}
            hasReport={(reportsQuery.data?.length ?? 0) > 0}
            hasTeammate={data.counts.totalMembers > 1}
            firstFacilityId={facilities[0]?.id}
          />
        </div>
      )}

      {/* KPIs */}
      {overviewQuery.error && !overviewQuery.data ? (
        <QueryError
          error={overviewQuery.error}
          onRetry={overviewQuery.mutate}
          what={t('dashboard.whatOverview', { defaultValue: 'your workspace overview' })}
        />
      ) : (
        <section
          {...rise(2, 'grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4')}
          aria-label={t('dashboard.countsAria', { defaultValue: 'Workspace counts' })}
        >
          <StatCard
            icon={Warehouse}
            label={t('dashboard.tileWarehouses', { defaultValue: 'Facilities' })}
            value={data.counts.totalWarehouses}
            delta={{ value: data.counts.warehousesLast30d, label: in30 }}
            to="/warehouses"
            loading={loading}
          />
          <StatCard
            icon={Boxes}
            label={t('dashboard.tileOccupancy', { defaultValue: 'Bin occupancy' })}
            value={occupancy === undefined ? '—' : `${Math.round(occupancy * 100)}%`}
            progress={occupancy}
            progressTone="capacity"
            hint={
              stats && stats.totalBins > 0
                ? t('dashboard.occupancyHint', {
                    defaultValue: '{{occupied}} of {{total}} bins filled',
                    occupied: stats.occupiedBins.toLocaleString(),
                    total: stats.totalBins.toLocaleString(),
                  })
                : t('dashboard.occupancyEmpty', { defaultValue: 'No bins yet' })
            }
            loading={facilitiesLoading}
          />
          <StatCard
            icon={PackageCheck}
            label={t('dashboard.tileAssets', { defaultValue: 'Tracked assets' })}
            value={stats?.totalAssets ?? 0}
            hint={t('dashboard.assetsHint', { defaultValue: 'Markers across all facilities' })}
            loading={facilitiesLoading}
          />
          <StatCard
            icon={Plug}
            label={t('dashboard.tileIntegrations', { defaultValue: 'Integrations' })}
            value={data.counts.totalIntegrations}
            delta={{ value: data.counts.integrationsLast30d, label: in30 }}
            to="/integrations"
            loading={loading}
          />
        </section>
      )}

      {/* Facilities */}
      <section {...rise(3, 'space-y-3')} aria-labelledby="dash-facilities">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 id="dash-facilities" className="text-base font-semibold tracking-tight">
              {t('dashboard.facilitiesTitle', { defaultValue: 'Your facilities' })}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t('dashboard.facilitiesSubtitle', { defaultValue: 'Recently updated. Open one to edit its layout.' })}
            </p>
          </div>
          {facilities.length > 0 && (
            <Button asChild variant="ghost" size="sm" className="shrink-0">
              <Link to="/warehouses">
                {t('dashboard.viewAll', { defaultValue: 'View all' })}
                <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
              </Link>
            </Button>
          )}
        </div>
        {facilitiesQuery.error && !facilitiesQuery.data ? (
          <QueryError
            error={facilitiesQuery.error}
            onRetry={facilitiesQuery.mutate}
            what={t('dashboard.whatFacilities', { defaultValue: 'your facilities' })}
          />
        ) : facilitiesLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <FacilityCardSkeleton key={i} />
            ))}
          </div>
        ) : facilities.length === 0 ? (
          <EmptyState
            icon={Warehouse}
            title={t('dashboard.warehousesEmptyTitle', { defaultValue: 'No facilities yet' })}
            description={t('dashboard.warehousesEmptyBody', {
              defaultValue: 'Create a facility, drop in a floor plan, and start mapping racks, zones and assets.',
            })}
            action={
              <Button asChild>
                <Link to="/warehouses">
                  <Plus className="h-4 w-4" />
                  {t('dashboard.createFacility', { defaultValue: 'Create facility' })}
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {facilities.map((row) => (
              <FacilityCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </section>

      {/* Activity + plan / workspace */}
      <div {...rise(4, 'grid gap-6 lg:grid-cols-3')}>
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>{t('dashboard.activityTitle', { defaultValue: '30-day activity' })}</CardTitle>
              <CardDescription>
                {t('dashboard.activitySubtitleWorkspace', {
                  defaultValue: 'New facilities, members, and integrations per day.',
                })}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {overviewQuery.error && !overviewQuery.data ? (
              <QueryError compact error={overviewQuery.error} onRetry={overviewQuery.mutate} />
            ) : (
              <ActivityChart points={data.timeline} loading={loading} />
            )}
          </CardContent>
        </Card>
        <aside className="space-y-4">
          <WorkspaceCard data={data} loading={loading} canManage={canManage} />
        </aside>
      </div>

      {/* Jump back in + quick actions */}
      <div {...rise(5, 'grid gap-6 lg:grid-cols-3')}>
        <RecentCard
          className="lg:col-span-2"
          facilities={facilities}
          reports={reportsQuery.data ?? []}
          tables={tablesQuery.data ?? []}
          loading={(reportsQuery.isLoading && !reportsQuery.data) || (tablesQuery.isLoading && !tablesQuery.data)}
        />
        <QuickActions canManage={canManage} />
      </div>
    </PageContainer>
  )
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function greetingPart(): 'morning' | 'afternoon' | 'evening' {
  const h = new Date().getHours()
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
}
function greetingFallback(): string {
  return { morning: 'Good morning, {{name}}', afternoon: 'Good afternoon, {{name}}', evening: 'Good evening, {{name}}' }[greetingPart()]
}

// ---------------------------------------------------------------------------
// Getting started
// ---------------------------------------------------------------------------

function useDismissed(key: string): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  return [
    dismissed,
    () => {
      setDismissed(true)
      try {
        localStorage.setItem(key, '1')
      } catch {
        // storage unavailable — hidden for this session only
      }
    },
  ]
}

/**
 * Setup checklist, derived from real workspace data (nothing to tick by
 * hand). Hidden once every step is done or the user dismisses it; the
 * dismissal is remembered per workspace in this browser.
 */
function GettingStarted({
  tenantId,
  canManage,
  hasFacility,
  hasFloorPlan,
  hasRacks,
  hasData,
  hasReport,
  hasTeammate,
  firstFacilityId,
}: {
  tenantId: number
  canManage: boolean
  hasFacility: boolean
  hasFloorPlan: boolean
  hasRacks: boolean
  hasData: boolean
  hasReport: boolean
  hasTeammate: boolean
  firstFacilityId?: number
}) {
  const { t } = useTranslation()
  const [dismissed, dismiss] = useDismissed(`sgv-onboarding-dismissed:${tenantId}`)
  const editor = firstFacilityId ? `/create-grids?warehouseId=${firstFacilityId}` : '/warehouses'
  const steps: Array<{ done: boolean; icon: LucideIcon; title: string; body: string; to: string; show: boolean }> = [
    { done: hasFacility, icon: Warehouse, title: t('dashboard.onb.facility', { defaultValue: 'Create a facility' }), body: t('dashboard.onb.facilityBody', { defaultValue: 'A warehouse, store, hospital — any site you run.' }), to: '/warehouses', show: true },
    { done: hasFloorPlan, icon: ImageIcon, title: t('dashboard.onb.floorPlan', { defaultValue: 'Add a floor plan' }), body: t('dashboard.onb.floorPlanBody', { defaultValue: 'Drop in a PDF, DWG or image and place it to scale.' }), to: editor, show: true },
    { done: hasRacks, icon: LayoutGrid, title: t('dashboard.onb.racks', { defaultValue: 'Map racks and zones' }), body: t('dashboard.onb.racksBody', { defaultValue: 'Draw racks, areas and walls on top of the plan.' }), to: editor, show: true },
    { done: hasData, icon: Plug, title: t('dashboard.onb.data', { defaultValue: 'Connect live data' }), body: t('dashboard.onb.dataBody', { defaultValue: 'Pull inventory, sensors or people from your systems.' }), to: '/integrations', show: canManage },
    { done: hasReport, icon: FileBarChart, title: t('dashboard.onb.report', { defaultValue: 'Build a report' }), body: t('dashboard.onb.reportBody', { defaultValue: 'Turn that data into charts your team checks daily.' }), to: '/reports/new', show: true },
    { done: hasTeammate, icon: Users, title: t('dashboard.onb.invite', { defaultValue: 'Invite your team' }), body: t('dashboard.onb.inviteBody', { defaultValue: 'Share the workspace with the people who run the floor.' }), to: '/members', show: canManage },
  ]
  const visible = steps.filter((s) => s.show)
  const doneCount = visible.filter((s) => s.done).length
  if (dismissed || doneCount === visible.length) return null
  const next = visible.find((s) => !s.done)

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="min-w-0">
          <CardTitle className="text-base">{t('dashboard.onb.title', { defaultValue: 'Finish setting up your workspace' })}</CardTitle>
          <CardDescription>
            {t('dashboard.onb.progress', { defaultValue: '{{done}} of {{total}} done', done: doneCount, total: visible.length })}
          </CardDescription>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('dashboard.onb.dismiss', { defaultValue: 'Hide setup checklist' })}
          title={t('dashboard.onb.dismiss', { defaultValue: 'Hide setup checklist' })}
        >
          <X className="h-4 w-4" />
        </button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={visible.length} aria-valuenow={doneCount}>
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${(doneCount / visible.length) * 100}%` }} />
        </div>
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((step) => {
            const isNext = step === next
            return (
              <li key={step.title}>
                <Link
                  to={step.to}
                  className={cn(
                    'flex h-full items-start gap-3 rounded-lg border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    step.done ? 'bg-muted/30' : 'hover:border-foreground/20 hover:bg-accent/40',
                    isNext && 'border-primary/40 bg-primary/5',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
                      step.done ? 'border-success bg-success text-white' : 'bg-background text-muted-foreground',
                    )}
                  >
                    {step.done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <step.icon className="h-3.5 w-3.5" aria-hidden />}
                  </span>
                  <span className="min-w-0">
                    <span className={cn('block text-sm font-medium', step.done && 'text-muted-foreground')}>
                      {step.title}
                    </span>
                    {!step.done && <span className="mt-0.5 block text-xs text-muted-foreground">{step.body}</span>}
                  </span>
                  <span className="sr-only">
                    {step.done ? t('dashboard.onb.stepDone', { defaultValue: 'Done' }) : t('dashboard.onb.stepTodo', { defaultValue: 'Not done yet' })}
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Jump back in
// ---------------------------------------------------------------------------

function relTime(iso: string, locale: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((then - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of [['day', 86_400], ['hour', 3_600], ['minute', 60]] as const) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
  }
  return rtf.format(0, 'minute')
}

/** "Continue where you left off": the most recently updated facilities, reports and tables. */
function RecentCard({
  facilities,
  reports,
  tables,
  loading,
  className,
}: {
  facilities: WarehouseSummariesResponse['rows']
  reports: Report[]
  tables: TableResponse[]
  loading: boolean
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const items = [
    ...facilities.map((f) => ({ key: `f${f.id}`, icon: Warehouse, name: f.name, kind: t('dashboard.recentKindFacility', { defaultValue: 'Facility' }), at: f.updatedAt, to: `/create-grids?warehouseId=${f.id}`, color: f.color })),
    ...reports.map((r) => ({ key: `r${r.id}`, icon: FileBarChart, name: r.name, kind: t('dashboard.recentKindReport', { defaultValue: 'Report' }), at: r.updatedAt, to: `/reports/${r.id}`, color: r.color || undefined })),
    ...tables.map((tb) => ({ key: `t${tb.dataSource.id}`, icon: TableIcon, name: tb.dataSource.name, kind: t('dashboard.recentKindTable', { defaultValue: 'Table' }), at: String(tb.dataSource.updatedAt), to: `/tables/${tb.dataSource.id}`, color: undefined as string | undefined })),
  ]
    .filter((x) => !Number.isNaN(Date.parse(x.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 6)

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <div>
          <CardTitle>{t('dashboard.recentTitle2', { defaultValue: 'Jump back in' })}</CardTitle>
          <CardDescription>{t('dashboard.recentSubtitle2', { defaultValue: 'Recently updated facilities, reports and tables.' })}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-2 pt-0">
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={Clock} title={t('dashboard.recentEmpty', { defaultValue: 'Nothing here yet — things you create will show up here.' })} />
        ) : (
          <ul className="grid sm:grid-cols-2">
            {items.map((item) => (
              <li key={item.key}>
                <Link
                  to={item.to}
                  className="group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"
                    style={item.color ? { color: item.color, borderColor: `${item.color}40`, background: `${item.color}12` } : undefined}
                  >
                    <item.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.kind} · {relTime(item.at, i18n.language)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Workspace usage
// ---------------------------------------------------------------------------

function WorkspaceCard({ data, loading, canManage }: { data: DashboardOverview; loading: boolean; canManage: boolean }) {
  const { t } = useTranslation()
  const rows: Array<{ icon: LucideIcon; label: string; value: string; to?: string }> = [
    {
      icon: Users,
      label: t('dashboard.tileMembers', { defaultValue: 'Members' }),
      value: data.counts.totalMembers.toLocaleString(),
      to: canManage ? '/members' : undefined,
    },
    {
      icon: Radio,
      label: t('dashboard.tileStreams', { defaultValue: 'Live streams' }),
      value: data.counts.activeStreams.toLocaleString(),
      to: '/data',
    },
    {
      icon: FolderOpen,
      label: t('dashboard.tileFiles', { defaultValue: 'Files' }),
      value: data.counts.totalFiles.toLocaleString(),
      to: canManage ? '/files' : undefined,
    },
    {
      icon: HardDrive,
      label: t('dashboard.tileStorage', { defaultValue: 'Storage' }),
      value: formatBytes(data.counts.totalStorageBytes),
    },
  ]
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{t('dashboard.workspaceCardTitle', { defaultValue: 'Workspace' })}</CardTitle>
      </CardHeader>
      <CardContent className="p-2 pt-0">
        <ul>
          {rows.map((row) => {
            const inner = (
              <>
                <row.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex-1 text-sm">{row.label}</span>
                {loading ? (
                  <Skeleton className="h-4 w-10" />
                ) : (
                  <span className="text-sm font-medium tabular-nums" dir="ltr">{row.value}</span>
                )}
              </>
            )
            return (
              <li key={row.label}>
                {row.to ? (
                  <Link
                    to={row.to}
                    className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className="flex items-center gap-3 px-3 py-2">{inner}</div>
                )}
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

function QuickActions({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation()
  const actions: Array<{ icon: LucideIcon; title: string; body: string; to: string; show: boolean }> = [
    {
      icon: Warehouse,
      title: t('dashboard.qaFacility', { defaultValue: 'Add a facility' }),
      body: t('dashboard.qaFacilityBody', { defaultValue: 'Upload a floor plan and map it' }),
      to: '/warehouses',
      show: true,
    },
    {
      icon: Plug,
      title: t('dashboard.qaConnect', { defaultValue: 'Connect data' }),
      body: t('dashboard.qaConnectBody', { defaultValue: 'REST APIs, webhooks and file uploads' }),
      to: '/integrations',
      show: canManage,
    },
    {
      icon: TableIcon,
      title: t('dashboard.qaTable', { defaultValue: 'Create a table' }),
      body: t('dashboard.qaTableBody', { defaultValue: 'Your own schema with a write API' }),
      to: '/tables/new',
      show: canManage,
    },
    {
      icon: FileBarChart,
      title: t('dashboard.qaReport', { defaultValue: 'Build a report' }),
      body: t('dashboard.qaReportBody', { defaultValue: 'Charts and tables from live data' }),
      to: '/reports/new',
      show: true,
    },
  ]
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{t('dashboard.quickActions', { defaultValue: 'Quick actions' })}</CardTitle>
      </CardHeader>
      <CardContent className="p-2 pt-0">
        <ul>
          {actions
            .filter((a) => a.show)
            .map((a) => (
              <li key={a.to}>
                <Link
                  to={a.to}
                  className="group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground group-hover:text-foreground">
                    <a.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{a.title}</span>
                    <span className="block text-xs text-muted-foreground">{a.body}</span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 rtl:rotate-180" />
                </Link>
              </li>
            ))}
        </ul>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Activity chart
// ---------------------------------------------------------------------------

// Theme tokens, so the chart follows palette × mode.
const SERIES = [
  { key: 'warehouses', color: 'hsl(var(--primary))', labelKey: 'dashboard.legendFacilities', fallback: 'Facilities' },
  { key: 'members', color: 'hsl(var(--success))', labelKey: 'dashboard.legendMembers', fallback: 'Members' },
  { key: 'integrations', color: 'hsl(var(--info))', labelKey: 'dashboard.legendIntegrations', fallback: 'Integrations' },
] as const

function ActivityChart({ points, loading }: { points: DashboardTimelinePoint[]; loading?: boolean }) {
  const { t, i18n } = useTranslation()
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    [i18n.language],
  )
  if (loading) return <Skeleton className="h-64 w-full" />
  const total = points.reduce((sum, p) => sum + p.warehouses + p.members + p.integrations, 0)
  if (points.length === 0 || total === 0) {
    return (
      <EmptyState
        compact
        icon={Sparkles}
        title={t('dashboard.timelineEmpty', { defaultValue: 'No workspace activity in the last 30 days.' })}
      />
    )
  }
  const label = (iso: string) => fmt.format(new Date(iso + 'T00:00:00Z'))
  return (
    <div>
      <div
        className="h-64"
        role="img"
        aria-label={t('dashboard.timelineAriaLabel', { defaultValue: 'Daily workspace activity' })}
        dir="ltr"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: -20 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
            <XAxis
              dataKey="date"
              tickFormatter={label}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            />
            <Tooltip
              cursor={{ fill: 'hsl(var(--muted))' }}
              labelFormatter={(v) => label(String(v))}
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 8,
                fontSize: 12,
                color: 'hsl(var(--popover-foreground))',
              }}
            />
            {SERIES.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={t(s.labelKey, { defaultValue: s.fallback })}
                stackId="a"
                fill={s.color}
                radius={i === SERIES.length - 1 ? [3, 3, 0, 0] : 0}
                maxBarSize={18}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {t(s.labelKey, { defaultValue: s.fallback })}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let value = bytes
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[i]}`
}
