/**
 * Health view for the Integrations page — "is everything delivering?"
 *
 *   - Summary: healthy / need attention / not run yet.
 *   - Pull sources (REST + file imports): status from the last run,
 *     schedule, last run, Run now. REST syncs run in the browser while a
 *     map is open, so an old "last run" isn't an error — it's shown, not
 *     flagged.
 *   - Tables (push): row total + last write, from each table's newest
 *     row (`/data/rows?sourceId=&pageSize=1`) — table writes don't stamp
 *     the source row. A polled table's own last result counts too.
 *   - Live streams (only when the workspace has any): the backend's
 *     throughput counters, sparkline and replay (`LiveStreamHealth`).
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CircleCheck, CircleDashed, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { type DataSource } from '@/lib/db'
import { listDataRows } from '@/lib/data-screen-client'
import { type TableResponse } from '@/lib/tables-client'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { SourceKindIcon, SourceStatus, isFileSource, useScheduleLabel } from '@/components/data-link/source-detail-sheet'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  History,
  Pause,
} from 'lucide-react'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import {
  type Connection,
  type Stream,
} from '@/lib/db'
import {
  runReplay,
  useLiveStreamHealth,
  useReplayState,
  type StreamHealth,
  type StreamHealthSample,
} from '@/lib/data-link'
import { useApiQuery } from '@/lib/useApiQuery'
import { cn } from '@/lib/utils'

interface TableFreshness {
  total: number
  lastWrite?: string
}

export function HealthSection({
  sources,
  tables,
  loading,
  onOpenSource,
  onRun,
  runningId,
  canManage,
}: {
  sources: DataSource[]
  tables: TableResponse[]
  loading: boolean
  onOpenSource: (s: DataSource) => void
  onRun: (s: DataSource) => void
  runningId: number | null
  canManage: boolean
}) {
  const { t, i18n } = useTranslation()
  const scheduleLabel = useScheduleLabel()

  // Row totals + last write come with GET /tables (`stats`). Only an older
  // backend without them falls back to one light request per table.
  const tableKey = tables.map((tb) => tb.dataSource.id).join(',')
  const statsMap = useMemo(
    () =>
      tables.length > 0 && tables.every((tb) => tb.stats)
        ? new Map(tables.map((tb): [number, TableFreshness] => [tb.dataSource.id, { total: tb.stats!.rows, lastWrite: tb.stats!.lastWriteAt }]))
        : null,
    [tables],
  )
  const [fresh, setFresh] = useState<{ key: string; byId: Map<number, TableFreshness> } | null>(null)
  useEffect(() => {
    if (!tableKey || statsMap) return
    let cancelled = false
    const ids = tableKey.split(',').map(Number)
    Promise.all(
      ids.map((id) =>
        listDataRows({ sourceId: id, pageSize: 1, sort: 'updatedAt', dir: 'desc' })
          .then((r): [number, TableFreshness] => [id, { total: r.total, lastWrite: r.rows[0]?.updatedAt }])
          .catch((): [number, TableFreshness] => [id, { total: -1 }]),
      ),
    ).then((pairs) => {
      if (!cancelled) setFresh({ key: tableKey, byId: new Map(pairs) })
    })
    return () => {
      cancelled = true
    }
  }, [tableKey, statsMap])

  const failing = sources.filter((s) => s.lastResult === 'error' || s.lastResult === 'partial')
  const neverRun = sources.filter((s) => !s.lastRunAt)
  const healthy = sources.filter((s) => s.lastResult === 'ok' || s.lastResult === 'empty')
  const tableIssues = tables.filter((tb) => tb.dataSource.lastResult === 'error')

  if (loading) {
    return (
      <div className="space-y-4" aria-busy>
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-xl" />
      </div>
    )
  }

  if (sources.length === 0 && tables.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card/50 px-6 py-12 text-center">
        <p className="text-sm font-medium">{t('integrations.health.emptyTitle', { defaultValue: 'Nothing to monitor yet' })}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('integrations.health.emptyBody', { defaultValue: 'Connect an API, import a file or create a table — its health shows up here.' })}
        </p>
      </div>
    )
  }

  // A table with no rows yet is waiting for data, not healthy.
  const freshMap = statsMap ?? (fresh?.key === tableKey ? fresh.byId : null)
  const emptyTables = freshMap ? tables.filter((tb) => (freshMap.get(tb.dataSource.id)?.total ?? 0) === 0 && tb.dataSource.lastResult !== 'error').length : 0
  const summary = [
    { icon: CircleCheck, tone: 'text-success', label: t('integrations.health.healthy', { defaultValue: 'Healthy' }), value: healthy.length + tables.length - tableIssues.length - emptyTables },
    { icon: TriangleAlert, tone: failing.length + tableIssues.length > 0 ? 'text-danger' : 'text-muted-foreground', label: t('integrations.health.attention', { defaultValue: 'Need attention' }), value: failing.length + tableIssues.length },
    { icon: CircleDashed, tone: 'text-muted-foreground', label: t('integrations.health.waiting', { defaultValue: 'Waiting for data' }), value: neverRun.length + emptyTables },
  ]
  const dupNames = new Set(
    tables.map((tb) => tb.dataSource.name).filter((n, i, all) => all.indexOf(n) !== i),
  )

  // Problems first, then never-run, then healthy — newest run first within.
  const rank = (s: DataSource) => (s.lastResult === 'error' ? 0 : s.lastResult === 'partial' ? 1 : !s.lastRunAt ? 2 : 3)
  const orderedSources = [...sources].sort(
    (a, b) => rank(a) - rank(b) || new Date(b.lastRunAt ?? 0).getTime() - new Date(a.lastRunAt ?? 0).getTime(),
  )

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        {summary.map((s) => (
          <div key={s.label} className="rounded-xl border bg-card px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <s.icon className={cn('h-4 w-4', s.tone)} aria-hidden />
              {s.label}
            </div>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</p>
          </div>
        ))}
      </div>

      {sources.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold">{t('integrations.health.pullTitle', { defaultValue: 'APIs and file imports' })}</h3>
            <p className="hidden text-xs text-muted-foreground sm:block">
              {t('integrations.health.pullHint', { defaultValue: 'API syncs run in the browser while a map is open.' })}
            </p>
          </div>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {orderedSources.map((s) => {
              const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toISOString() : undefined
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
                  <SourceKindIcon source={s} className="h-9 w-9" />
                  <div className="min-w-0 flex-1">
                    <button type="button" onClick={() => onOpenSource(s)} className="block max-w-full truncate text-start text-sm font-medium hover:underline">
                      {s.name}
                    </button>
                    <p className="truncate text-xs text-muted-foreground">
                      {scheduleLabel(s)}
                      {' · '}
                      <span title={lastRun ? fullTime(lastRun, i18n.language) : undefined}>
                        {lastRun
                          ? t('integrations.lastRunAgo', { defaultValue: 'ran {{when}}', when: relativeTime(lastRun, i18n.language) })
                          : t('integrations.status.never', { defaultValue: 'Not run yet' })}
                      </span>
                    </p>
                  </div>
                  <SourceStatus source={s} />
                  {canManage && (
                    <Button variant="outline" size="sm" className="h-8" onClick={() => onRun(s)} disabled={runningId === s.id}>
                      {runningId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {isFileSource(s) ? t('integrations.reimport', { defaultValue: 'Re-import' }) : t('integrations.runNow', { defaultValue: 'Run now' })}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {tables.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold">{t('integrations.health.pushTitle', { defaultValue: 'Tables' })}</h3>
            <p className="hidden text-xs text-muted-foreground sm:block">
              {t('integrations.health.pushHint', { defaultValue: 'Your systems write to these; we show when they last did.' })}
            </p>
          </div>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {tables.map((tb) => {
              const f = fresh?.key === tableKey ? fresh.byId.get(tb.dataSource.id) : undefined
              const polledError = tb.dataSource.lastResult === 'error'
              return (
                <li key={tb.dataSource.id} className="flex items-center gap-3 px-4 py-3">
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      polledError ? 'bg-danger' : !f ? 'bg-muted-foreground/30' : f.total > 0 ? 'bg-success' : 'bg-muted-foreground/40',
                    )}
                    aria-hidden
                  />
                  <Link to={`/tables/${tb.dataSource.id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:underline">
                    {tb.dataSource.name}
                    {dupNames.has(tb.dataSource.name) && <span className="ms-1.5 font-mono text-xs font-normal text-muted-foreground">#{tb.dataSource.id}</span>}
                  </Link>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {!f ? (
                      <Skeleton className="h-3 w-28" />
                    ) : polledError ? (
                      <span className="text-danger">{t('integrations.health.pollFailed', { defaultValue: 'Polling failed' })}</span>
                    ) : f.total < 0 ? (
                      '—'
                    ) : f.total === 0 ? (
                      t('integrations.health.noWrites', { defaultValue: 'No rows yet' })
                    ) : (
                      <>
                        {t('integrations.detail.imported', { defaultValue: '{{count}} rows', count: f.total })}
                        {f.lastWrite && (
                          <>
                            {' · '}
                            <span title={fullTime(f.lastWrite, i18n.language)}>
                              {t('integrations.health.lastWrite', { defaultValue: 'last write {{when}}', when: relativeTime(f.lastWrite, i18n.language) })}
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <LiveStreamHealth />
    </div>
  )
}

function LiveStreamHealth() {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const streamsQuery = useApiQuery(
    () =>
      apiDb.streams
        .where('entityType')
        .anyOf(['asset', 'sensor', 'rfid-tag', 'shipment', 'camera'])
        .toArray(),
    ['streams', tenantId],
    { intervalMs: 10000 },
  )
  const streams = streamsQuery.data ?? []
  const connectionsQuery = useApiQuery(
    () => apiDb.connections.toArray(),
    ['connections', tenantId],
    { intervalMs: 10000 },
  )
  const connectionsById = useMemo(() => {
    const m = new Map<number, Connection>()
    for (const c of connectionsQuery.data ?? []) if (c.id !== undefined) m.set(c.id, c)
    return m
  }, [connectionsQuery.data])
  const health = useLiveStreamHealth()

  if (streams.length === 0) return null

  return (
    <section className="space-y-2">
    <h3 className="text-sm font-semibold">{t('integrations.health.streamsTitle', { defaultValue: 'Live streams' })}</h3>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {streams.map((s) => {
        if (s.id === undefined) return null
        const h = health.get(s.id)
        const conn =
          s.connectionId !== undefined ? connectionsById.get(s.connectionId) ?? null : null
        return <HealthCard key={s.id} stream={s} health={h ?? null} connection={conn} />
      })}
    </div>
    </section>
  )
}

function HealthCard({
  stream,
  health,
  connection,
}: {
  stream: Stream
  health: StreamHealth | null
  connection: Connection | null
}) {
  const status = health?.status ?? 'unknown'
  const endpoint = stream.endpoint as { url?: string; sourceToken?: string }
  const workerHost = (() => {
    if (!endpoint.url) return null
    try {
      return new URL(endpoint.url).host
    } catch {
      return null
    }
  })()
  const stats = health?.lastStats ?? null

  return (
    <div className="border rounded-xl p-4 bg-card shadow-sm flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex items-center justify-center w-10 h-10 rounded-lg flex-shrink-0',
            status === 'live'
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : status === 'down'
                ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                : 'bg-muted text-muted-foreground',
          )}
        >
          {status === 'live' ? (
            <Activity className="w-5 h-5 animate-pulse" />
          ) : status === 'down' ? (
            <AlertCircle className="w-5 h-5" />
          ) : (
            <Pause className="w-5 h-5" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{stream.name}</div>
          <div className="text-[11px] text-muted-foreground font-mono flex items-center gap-2 flex-wrap mt-0.5">
            <span className="uppercase">{stream.entityType} · ws</span>
            <StatusChip status={status} />
            {stats && (
              <span className="text-muted-foreground/70">
                · {stats.currentSubscribers} subscriber
                {stats.currentSubscribers === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
      </div>

      {health?.error && (
        <div className="text-[11px] text-rose-700 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md px-2 py-1.5 flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span className="break-all">{health.error}</span>
        </div>
      )}

      {/* Sparkline — events/min over the polled window. */}
      {health && health.history.length >= 2 && (
        <ThroughputSparkline samples={health.history} />
      )}

      {/* Per-min rates */}
      {health?.current && (
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Stat
            label="events / min"
            value={fmtRate(health.current.eventsPerMin)}
            tone="default"
          />
          <Stat
            label="fanouts / min"
            value={fmtRate(health.current.fanoutsPerMin)}
            tone="default"
          />
          <Stat
            label="errors / min"
            value={fmtRate(health.current.errorsPerMin)}
            tone={health.current.errorsPerMin > 0 ? 'error' : 'default'}
          />
        </div>
      )}

      {/* Cumulative counters */}
      {stats && (
        <div className="space-y-1 text-[11px]">
          <DetailRow
            label="Lifetime"
            value={`${stats.eventsReceived.toLocaleString()} events · ${stats.fanoutTotal.toLocaleString()} fanouts · ${stats.errors.toLocaleString()} errors`}
          />
          <DetailRow
            label="Last pub"
            value={stats.lastPublishedAt ? timeAgo(stats.lastPublishedAt) : '—'}
          />
          <DetailRow
            label="Snapshot"
            value={`${stats.snapshotSize.toLocaleString()} rows`}
          />
          <DetailRow
            label="Replay log"
            value={`${(stats.eventLogSize ?? 0).toLocaleString()} rows`}
          />
          <DetailRow label="backend" value={workerHost ?? '—'} mono />
          <DetailRow label="Token" value={endpoint.sourceToken ?? '—'} mono />
          <DetailRow
            label="Auth"
            value={
              connection?.auth.mode === 'apiKey'
                ? 'API key (set)'
                : connection?.auth.mode ?? 'unknown'
            }
          />
        </div>
      )}

      {/* Phase 7b — replay control. Active when there's at least one
          row in the DO's event log. */}
      <ReplayControl
        stream={stream}
        eventLogSize={stats?.eventLogSize ?? 0}
      />
    </div>
  )
}

function ReplayControl({
  stream,
  eventLogSize,
}: {
  stream: Stream
  eventLogSize: number
}) {
  const [windowMin, setWindowMin] = useState(15)
  const [speed, setSpeed] = useState(4)
  const [error, setError] = useState<string | null>(null)
  const replay = useReplayState()
  const isThisReplaying = replay.activeStreamId === stream.id
  const anyReplaying = replay.activeStreamId !== null
  // Busy from the click (the replay fetches its window before it plays).
  const [starting, setStarting] = useState(false)
  const canReplay = eventLogSize > 0 && !anyReplaying && !starting

  const handleReplay = async () => {
    if (stream.id === undefined || starting) return
    setStarting(true)
    setError(null)
    const now = Date.now()
    const fromMs = now - windowMin * 60_000
    try {
      await runReplay({
        stream,
        fromMs,
        toMs: now,
        speed,
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="border-t pt-2 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
        <History className="w-3 h-3" />
        Replay
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={windowMin}
          onChange={(e) => setWindowMin(Number.parseInt(e.target.value, 10))}
          disabled={!canReplay}
          className="h-7 text-[11px] font-mono rounded border border-input bg-background px-1.5"
        >
          <option value={15}>Last 15m</option>
          <option value={60}>Last 1h</option>
          <option value={360}>Last 6h</option>
        </select>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number.parseInt(e.target.value, 10))}
          disabled={!canReplay}
          className="h-7 text-[11px] font-mono rounded border border-input bg-background px-1.5"
        >
          <option value={1}>1×</option>
          <option value={4}>4×</option>
          <option value={16}>16×</option>
          <option value={64}>64×</option>
        </select>
        <button
          type="button"
          disabled={!canReplay}
          onClick={() => void handleReplay()}
          className={cn(
            'h-7 px-2 text-[11px] rounded border transition-colors',
            canReplay
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
              : 'border-input bg-muted text-muted-foreground cursor-not-allowed',
          )}
          aria-busy={starting || isThisReplaying}
        >
          <span className="inline-flex items-center gap-1">
            {(starting || isThisReplaying) && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />}
            {isThisReplaying ? 'Playing…' : 'Replay'}
          </span>
        </button>
        {anyReplaying && !isThisReplaying && (
          <span className="text-[10px] text-amber-700 dark:text-amber-300">
            Another replay active
          </span>
        )}
        {eventLogSize === 0 && (
          <span className="text-[10px] text-muted-foreground">
            (no events in replay log yet)
          </span>
        )}
      </div>
      {error && (
        <div className="text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
    </div>
  )
}

function ThroughputSparkline({ samples }: { samples: StreamHealthSample[] }) {
  const W = 280
  const H = 36
  const pad = 4
  const max = Math.max(1, ...samples.map((s) => s.eventsPerMin))
  const innerW = W - pad * 2
  const innerH = H - pad * 2
  const stepX = innerW / Math.max(1, samples.length - 1)
  const path = samples
    .map((s, i) => {
      const x = pad + i * stepX
      const y = pad + innerH - (s.eventsPerMin / max) * innerH
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
  // Subtle area fill for visual weight.
  const lastX = pad + (samples.length - 1) * stepX
  const areaPath = `${path} L ${lastX} ${pad + innerH} L ${pad} ${pad + innerH} Z`
  return (
    <div>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full block"
        aria-label="Recent events / min"
      >
        <path d={areaPath} fill="rgba(34, 197, 94, 0.12)" />
        <path d={path} fill="none" stroke="#16a34a" strokeWidth={1.5} />
      </svg>
      <div className="text-[10px] text-muted-foreground font-mono flex items-baseline justify-between">
        <span>0</span>
        <span>peak {fmtRate(max)} ev/min</span>
      </div>
    </div>
  )
}

function StatusChip({ status }: { status: StreamHealth['status'] }) {
  const tone =
    status === 'live'
      ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
      : status === 'down'
        ? 'text-rose-600 dark:text-rose-400 bg-rose-500/10'
        : status === 'idle'
          ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10'
          : 'text-muted-foreground bg-muted'
  return (
    <span
      className={cn(
        'px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase flex items-center gap-1',
        tone,
      )}
    >
      {status === 'live' ? (
        <CheckCircle2 className="w-2.5 h-2.5" />
      ) : status === 'down' ? (
        <AlertCircle className="w-2.5 h-2.5" />
      ) : (
        <Pause className="w-2.5 h-2.5" />
      )}
      {status}
    </span>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'default' | 'error'
}) {
  return (
    <div
      className={cn(
        'rounded-md px-2 py-1.5 text-center',
        tone === 'error'
          ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
          : 'bg-muted/40',
      )}
    >
      <div className="font-semibold text-sm">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
    </div>
  )
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted-foreground text-[10px] uppercase tracking-wider w-20 flex-shrink-0">
        {label}
      </span>
      <span
        className={cn(
          'flex-1 min-w-0 truncate',
          mono && 'font-mono text-[10.5px]',
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function fmtRate(n: number): string {
  if (n === 0) return '0'
  if (n < 10) return n.toFixed(1)
  return Math.round(n).toLocaleString()
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}
