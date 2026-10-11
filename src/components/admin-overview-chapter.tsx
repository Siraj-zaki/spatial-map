/**
 * Platform-admin section shown on /dashboard for the bootstrap owner.
 *
 * Renders nothing (returns null) unless the current user has
 * `isPlatformAdmin: true` — non-admin visitors never see this block
 * OR hit the `/api/v1/admin/metrics` endpoint. Data lives behind a
 * `useApiQuery` with the same polling cadence as the tenant overview
 * so the KPIs stay fresh without manual refresh.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  BadgeCheck,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  Search,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { PageChapter } from '@/components/page-shell'
import { StatCard } from '@/components/stat-card'
import { useApiQuery } from '@/lib/useApiQuery'
import {
  fetchAdminMetrics,
  fetchAdminUsers,
  type AdminMembership,
  type AdminMetrics,
  type AdminUserRow,
  type AdminUsersResponse,
} from '@/lib/admin-client'
import { useAuthStore } from '@/lib/auth-store'

/** Container — checks admin flag, fetches, delegates to the panel. */
export function AdminOverviewChapter() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore((s) => Boolean(s.user?.isPlatformAdmin))
  const query = useApiQuery<AdminMetrics>(
    () => fetchAdminMetrics(),
    ['admin-metrics'],
    { intervalMs: 30000, enabled: isAdmin },
  )

  if (!isAdmin) return null

  const data = query.data
  const loading = query.isLoading && !data

  return (
    <PageChapter
      eyebrow={t('admin.eyebrow', { defaultValue: 'Platform admin' })}
      title={t('admin.title', { defaultValue: 'Signups & workspaces' })}
    >
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('admin.loading', { defaultValue: 'Loading admin metrics…' })}
        </div>
      )}
      {query.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{(query.error as Error).message}</span>
        </div>
      )}
      {data && <AdminMetricsPanel data={data} />}
      {data && <AdminUsersPanel />}
    </PageChapter>
  )
}

// ─────────────────────────────────────────────── content

function AdminMetricsPanel({ data }: { data: AdminMetrics }) {
  const { t } = useTranslation()
  const growth = useGrowthDelta(data.dailySignups)

  return (
    <div className="space-y-5">
      {/* Top KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <KpiCard
          icon={Users}
          label={t('admin.kpi.totalUsers', { defaultValue: 'Total signups' })}
          value={data.totalUsers.toLocaleString()}
          sub={t('admin.kpi.verifiedRatio', {
            verified: data.verifiedUsers,
            total: data.totalUsers,
            defaultValue: '{{verified}} of {{total}} verified',
          })}
        />
        <KpiCard
          icon={UserPlus}
          label={t('admin.kpi.last7', { defaultValue: 'Signups · 7 days' })}
          value={data.signupsLast7Days.toLocaleString()}
          sub={t('admin.kpi.last30', {
            count: data.signupsLast30Days,
            defaultValue: '{{count}} in 30 days',
          })}
        />
        <KpiCard
          icon={Boxes}
          label={t('admin.kpi.workspaces', { defaultValue: 'Workspaces' })}
          value={data.totalTenants.toLocaleString()}
        />
      </div>

      {/* Signup trend */}
      <div className="rounded-lg border border-border bg-card p-4">
        <header className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <TrendingUp className="w-4 h-4 text-primary" aria-hidden />
            <h3 className="text-sm font-medium">
              {t('admin.signupTrend', { defaultValue: 'Signups · last 30 days' })}
            </h3>
          </div>
          {growth !== null && (
            <span
              className={cn(
                'text-xs font-medium tabular-nums',
                growth > 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : growth < 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-muted-foreground',
              )}
            >
              {growth > 0 ? '+' : ''}
              {growth}%
              <span className="text-muted-foreground ms-1 font-normal">
                {t('admin.vsPrior', { defaultValue: 'vs prior 15d' })}
              </span>
            </span>
          )}
        </header>
        <SignupSparkline data={data.dailySignups} />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────── sub-components

/** Admin KPIs use the app-wide StatCard (monochrome icons — colour is
 *  reserved for meaning, see stat-card.tsx). */
function KpiCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: typeof Users
  label: string
  value: string
  sub?: string
}) {
  return <StatCard icon={icon} label={label} value={value} hint={sub} />
}

/** SVG sparkline over the 30-day signup series. Uses viewBox so it
 *  scales to whatever the card is wide without JS. */
function SignupSparkline({ data }: { data: AdminMetrics['dailySignups'] }) {
  const { t } = useTranslation()
  const w = 600
  const h = 120
  const pad = 4

  const max = Math.max(1, ...data.map((d) => d.count))
  const stepX = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0
  const points = data.map((d, i) => {
    const x = pad + i * stepX
    const y = pad + (h - pad * 2) * (1 - d.count / max)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const areaPath =
    data.length > 0
      ? `M ${pad},${h - pad} L ${points.join(' L ')} L ${(pad + (data.length - 1) * stepX).toFixed(2)},${h - pad} Z`
      : ''
  const linePath = `M ${points.join(' L ')}`

  if (data.every((d) => d.count === 0)) {
    return (
      <div className="h-[120px] flex items-center justify-center text-[11px] text-muted-foreground italic">
        {t('admin.noSignups', { defaultValue: 'No signups in the last 30 days' })}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full h-[120px]"
        role="img"
        aria-label={t('admin.signupTrend', { defaultValue: 'Signups · last 30 days' })}
      >
        <defs>
          <linearGradient id="signupFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="text-primary">
          <path d={areaPath} fill="url(#signupFill)" />
          <path
            d={linePath}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          {data.map((d, i) => {
            const x = pad + i * stepX
            const y = pad + (h - pad * 2) * (1 - d.count / max)
            return d.count > 0 ? (
              <circle key={i} cx={x} cy={y} r={2} fill="currentColor">
                <title>{`${d.date}: ${d.count}`}</title>
              </circle>
            ) : null
          })}
        </g>
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  )
}

/** Compare the last 15 days to the prior 15 days to derive a growth
 *  delta % — bounded to a signed integer so tiny weeks don't show
 *  noisy decimals. `null` when there isn't enough data. */
function useGrowthDelta(daily: AdminMetrics['dailySignups']): number | null {
  return useMemo(() => {
    if (daily.length < 30) return null
    const half = Math.floor(daily.length / 2)
    const prior = daily.slice(0, half).reduce((s, d) => s + d.count, 0)
    const recent = daily.slice(half).reduce((s, d) => s + d.count, 0)
    if (prior === 0 && recent === 0) return 0
    if (prior === 0) return 100
    return Math.round(((recent - prior) / prior) * 100)
  }, [daily])
}

// ─────────────────────────────────────────────── users panel

/** Paginated user table with per-row workspace
 *  breakdown. Search is client-driven via a debounced query param. */
function AdminUsersPanel() {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [pageSize] = useState(25)
  const [rawSearch, setRawSearch] = useState('')
  const debouncedSearch = useDebounced(rawSearch, 250)

  const query = useApiQuery<AdminUsersResponse>(
    () => fetchAdminUsers({ page, pageSize, search: debouncedSearch }),
    ['admin-users', page, pageSize, debouncedSearch],
    { intervalMs: 30000, enabled: true },
  )

  const data = query.data
  const totalPages = data ? Math.max(1, Math.ceil(data.totalCount / pageSize)) : 1
  const showingFrom = data && data.totalCount > 0 ? (page - 1) * pageSize + 1 : 0
  const showingTo = data ? Math.min(page * pageSize, data.totalCount) : 0

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <Users className="w-4 h-4 text-primary shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium truncate">
            {t('admin.users.title', { defaultValue: 'All users' })}
          </h3>
          <p className="text-[11px] text-muted-foreground truncate">
            {data
              ? t('admin.users.summary', {
                  from: showingFrom,
                  to: showingTo,
                  total: data.totalCount,
                  defaultValue: 'Showing {{from}}–{{to}} of {{total}}',
                })
              : t('admin.users.loading', { defaultValue: 'Loading…' })}
          </p>
        </div>
        <div className="relative shrink-0">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={rawSearch}
            onChange={(e) => {
              setRawSearch(e.target.value)
              setPage(1)
            }}
            placeholder={t('admin.users.searchPlaceholder', {
              defaultValue: 'Search email or name…',
            })}
            className="h-8 ps-7 text-xs w-64"
          />
        </div>
      </header>

      {query.error && (
        <div className="p-3 text-xs text-destructive flex items-start gap-2 border-b border-border/60">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5" />
          <span>{(query.error as Error).message}</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 sticky top-0">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground text-left">
              <th className="px-3 py-2 font-medium">
                {t('admin.users.col.user', { defaultValue: 'User' })}
              </th>
              <th className="px-3 py-2 font-medium">
                {t('admin.users.col.signup', { defaultValue: 'Signed up' })}
              </th>
              <th className="px-3 py-2 font-medium">
                {t('admin.users.col.status', { defaultValue: 'Status' })}
              </th>
              <th className="px-3 py-2 font-medium">
                {t('admin.users.col.lastLogin', { defaultValue: 'Last login' })}
              </th>
              <th className="px-3 py-2 font-medium">
                {t('admin.users.col.workspaces', { defaultValue: 'Workspaces' })}
              </th>
            </tr>
          </thead>
          <tbody>
            {!data && query.isLoading && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin inline me-1" />
                  {t('admin.users.loading', { defaultValue: 'Loading…' })}
                </td>
              </tr>
            )}
            {data && data.users.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-muted-foreground italic">
                  {t('admin.users.empty', { defaultValue: 'No users match' })}
                </td>
              </tr>
            )}
            {data?.users.map((u) => (
              <UserRow key={u.id} user={u} />
            ))}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center gap-2 px-3 py-2 border-t border-border text-xs text-muted-foreground">
        <span>
          {data
            ? t('admin.users.pageOf', {
                page,
                total: totalPages,
                defaultValue: 'Page {{page}} of {{total}}',
              })
            : ''}
        </span>
        <div className="ms-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </footer>
    </div>
  )
}

function UserRow({ user }: { user: AdminUserRow }) {
  const { t } = useTranslation()
  return (
    <tr className="border-t border-border/60 hover:bg-accent/20 align-top">
      <td className="px-3 py-2">
        <div className="font-medium text-foreground truncate max-w-[280px]">
          {user.email}
        </div>
        <div className="text-[10px] text-muted-foreground truncate max-w-[280px]">
          {user.displayName || t('admin.users.noName', { defaultValue: '(no name)' })}
          {user.jobTitle ? ` · ${user.jobTitle}` : ''}
        </div>
      </td>
      <td className="px-3 py-2 tabular-nums whitespace-nowrap">
        <RelativeDate iso={user.createdAt} />
      </td>
      <td className="px-3 py-2">
        {user.verifiedAt ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[10px] px-1.5 py-0.5 font-medium"
            title={user.verifiedAt}
          >
            <BadgeCheck className="w-3 h-3" />
            {t('admin.users.verified', { defaultValue: 'Verified' })}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[10px] px-1.5 py-0.5 font-medium">
            <Clock3 className="w-3 h-3" />
            {t('admin.users.pending', { defaultValue: 'Pending' })}
          </span>
        )}
      </td>
      <td className="px-3 py-2 tabular-nums whitespace-nowrap text-muted-foreground">
        {user.lastLoginAt ? (
          <RelativeDate iso={user.lastLoginAt} />
        ) : (
          <span className="italic">
            {t('admin.users.never', { defaultValue: 'Never' })}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        {user.memberships.length === 0 && (
          <span className="text-[11px] text-muted-foreground italic">
            {t('admin.users.noWorkspaces', { defaultValue: 'No workspaces' })}
          </span>
        )}
        <ul className="space-y-1">
          {user.memberships.map((m) => (
            <li key={m.tenantId}>
              <MembershipChip membership={m} />
            </li>
          ))}
        </ul>
      </td>
    </tr>
  )
}

function MembershipChip({ membership: m }: { membership: AdminMembership }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0 text-[11px]">
      <span className="font-medium truncate max-w-[160px]" title={m.tenantName}>
        {m.tenantName}
      </span>
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground shrink-0">
        {m.role}
      </span>
    </div>
  )
}

/** Relative-date renderer — "2 hours ago", "3 days ago" — with the
 *  full ISO string in the tooltip. Uses Intl.RelativeTimeFormat so
 *  the phrasing localises via the browser. */
function RelativeDate({ iso }: { iso: string }) {
  const { i18n } = useTranslation()
  const label = useMemo(() => relativeFrom(iso, i18n.language), [iso, i18n.language])
  return <span title={iso}>{label}</span>
}

function relativeFrom(iso: string, locale = 'en'): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const diffSec = Math.round((t - Date.now()) / 1000)
  const abs = Math.abs(diffSec)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (abs < 60) return rtf.format(diffSec, 'second')
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 30 * 86_400) return rtf.format(Math.round(diffSec / 86_400), 'day')
  if (abs < 365 * 86_400) return rtf.format(Math.round(diffSec / (30 * 86_400)), 'month')
  return rtf.format(Math.round(diffSec / (365 * 86_400)), 'year')
}

/** Debounce a fast-changing string (search input) so the query
 *  doesn't fire on every keystroke. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
