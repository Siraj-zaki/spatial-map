/**
 * SourceDetailSheet — everything about one REST / file integration in a
 * non-modal side panel (the list stays usable, so the next source can be
 * opened without closing this one).
 *
 *   - Header: kind icon, name, kind + entity kind, current status.
 *   - Actions: Run now / Re-import, Edit (REST), View all data
 *     (`/data?source=<id>`), ⋯ (Test outbound for REST, Delete).
 *   - Overview: sync schedule, last run, created.
 *   - Connection: endpoint (copyable), method, auth mode (never the
 *     secret), JSON path, format — or file name / size for imports.
 *   - Recent runs: `import_jobs` via `/data/runs?sourceId=` — status,
 *     rows imported / errored, when, error report.
 *   - Latest rows: `/data/rows?sourceId=` newest first, plus the total.
 *
 * Mutations are passed in by the page so the card and the panel share
 * one implementation (busy state, toasts, delete confirmation).
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Cloud, Copy, Database, ExternalLink, FileText, Loader2, MoreHorizontal, Pencil, RefreshCw, Send, Trash2, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { QueryError } from '@/components/feedback/query-error'
import { listDataRows, listDataRuns, type DataRow, type DataRun } from '@/lib/data-screen-client'
import type { RestSourceConfig } from '@/lib/data-link'
import type { DataSource } from '@/lib/db'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'

export function isFileSource(s: DataSource): boolean {
  return s.kind === 'csv' || s.kind === 'xlsx' || s.kind === 'json' || s.kind === 'geojson'
}

export function SourceKindIcon({ source, className }: { source: DataSource; className?: string }) {
  const Icon = source.kind === 'rest' ? Cloud : FileText
  return (
    <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground', className)}>
      <Icon className="h-5 w-5" aria-hidden />
    </span>
  )
}

/** A REST source with no `match.*` column skips every row it fetches. */
export function missingRowKey(s: DataSource): boolean {
  if (s.kind !== 'rest') return false
  return !Object.values(s.mapping?.fields ?? {}).some((target) => String(target).startsWith('match.'))
}

/** Status badge from the last run: ok / partial / empty / error / never run. */
export function SourceStatus({ source }: { source: DataSource }) {
  const { t } = useTranslation()
  const r = source.lastResult
  if (!r) return <Badge variant="muted">{t('integrations.status.never', { defaultValue: 'Not run yet' })}</Badge>
  const variant = r === 'ok' ? 'success' : r === 'error' ? 'danger' : r === 'empty' ? 'muted' : 'warning'
  const label =
    r === 'ok'
      ? t('integrations.status.healthy', { defaultValue: 'Healthy' })
      : r === 'error'
        ? t('integrations.status.failing', { defaultValue: 'Failing' })
        : r === 'empty'
          ? t('integrations.status.emptyResult', { defaultValue: 'No rows' })
          : t('integrations.status.partialResult', { defaultValue: 'Some rows failed' })
  return <Badge variant={variant}>{label}</Badge>
}

/** "Every 5 min" / "When a map opens" / "Manually". */
export function useScheduleLabel() {
  const { t } = useTranslation()
  return (s: DataSource) => {
    if (s.schedule === 'interval' && s.intervalSeconds) {
      const n = s.intervalSeconds
      return n >= 3600
        ? t('integrations.rest.everyHours', { defaultValue: 'Every {{count}} h', count: Math.round(n / 3600) })
        : n >= 60
          ? t('integrations.rest.everyMinutes', { defaultValue: 'Every {{count}} min', count: Math.round(n / 60) })
          : t('integrations.rest.everySeconds', { defaultValue: 'Every {{count}} s', count: n })
    }
    if (s.schedule === 'on-load') return t('integrations.rest.scheduleOnLoad', { defaultValue: 'When a map opens' })
    return isFileSource(s)
      ? t('integrations.scheduleImport', { defaultValue: 'One-off import' })
      : t('integrations.rest.scheduleManual', { defaultValue: 'Manually' })
  }
}

export function SourceDetailSheet({
  source,
  open,
  onOpenChange,
  canManage,
  running,
  onRun,
  onEdit,
  onTestOutbound,
  onDelete,
}: {
  source: DataSource
  open: boolean
  onOpenChange: (o: boolean) => void
  canManage: boolean
  running: boolean
  onRun: () => void
  onEdit: () => void
  onTestOutbound: () => void
  onDelete: () => void
}) {
  const { t, i18n } = useTranslation()
  const scheduleLabel = useScheduleLabel()
  const file = isFileSource(source)
  const sid = source.id

  const [reload, setReload] = useState(0)
  const [runs, setRuns] = useState<{ key: string; rows: DataRun[]; error: unknown } | null>(null)
  const [rows, setRows] = useState<{ key: string; rows: DataRow[]; total: number; error: unknown } | null>(null)
  const key = `${sid}:${reload}:${source.lastRunAt ? String(source.lastRunAt) : ''}`

  useEffect(() => {
    if (sid === undefined || !open) return
    let cancelled = false
    listDataRuns({ sourceId: sid, pageSize: 8, sort: 'createdAt', dir: 'desc' })
      .then((r) => !cancelled && setRuns({ key, rows: r.rows, error: null }))
      .catch((error: unknown) => !cancelled && setRuns({ key, rows: [], error }))
    listDataRows({ sourceId: sid, pageSize: 5, sort: 'updatedAt', dir: 'desc' })
      .then((r) => !cancelled && setRows({ key, rows: r.rows, total: r.total, error: null }))
      .catch((error: unknown) => !cancelled && setRows({ key, rows: [], total: 0, error }))
    return () => {
      cancelled = true
    }
  }, [sid, open, key])

  const cfg = source.config as Partial<RestSourceConfig> & { fileName?: string; fileSize?: number; featureCount?: number }
  const authLabel =
    cfg.authMode === 'apiKey'
      ? t('integrations.rest.authApiKey', { defaultValue: 'API key' })
      : cfg.authMode === 'bearer'
        ? t('integrations.rest.authBearer', { defaultValue: 'Bearer token' })
        : cfg.authMode === 'custom'
          ? t('integrations.rest.authCustom', { defaultValue: 'Custom headers' })
          : t('integrations.rest.authNone', { defaultValue: 'None' })
  const lastRun = source.lastRunAt ? new Date(source.lastRunAt).toISOString() : undefined
  const created = source.createdAt ? new Date(source.createdAt).toISOString() : undefined

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="end"
        className="w-[min(520px,100vw)] rounded-none sm:rounded-s-xl"
        aria-describedby={undefined}
        onFocusOutside={(e) => e.preventDefault()}
      >
        {/* Header */}
        <div className="space-y-4 border-b px-5 py-4 pe-12">
          <div className="flex items-start gap-3">
            <SourceKindIcon source={source} />
            <div className="min-w-0">
              <SheetTitle className="truncate text-base">{source.name}</SheetTitle>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <SourceStatus source={source} />
                <Badge variant="muted" className="uppercase">{source.kind}</Badge>
                {source.entityKind && <Badge variant="outline" className="capitalize">{source.entityKind}</Badge>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManage && (
              <Button size="sm" onClick={onRun} disabled={running}>
                {running ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}
                {file ? t('integrations.reimport', { defaultValue: 'Re-import' }) : t('integrations.runNow', { defaultValue: 'Run now' })}
              </Button>
            )}
            {canManage && source.kind === 'rest' && (
              <Button size="sm" variant="outline" onClick={onEdit}>
                <Pencil className="h-4 w-4" />
                {t('common.edit', { defaultValue: 'Edit' })}
              </Button>
            )}
            {sid !== undefined && (
              <Button size="sm" variant="outline" asChild>
                <Link to={`/data?source=${sid}`}>
                  <Database className="h-4 w-4" />
                  {t('integrations.viewData', { defaultValue: 'View all data' })}
                </Link>
              </Button>
            )}
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="outline" className="h-8 w-8" aria-label={t('integrations.moreActions', { defaultValue: 'More actions' })}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {source.kind === 'rest' && (
                    <>
                      <DropdownMenuItem onSelect={onTestOutbound}>
                        <Send className="me-2 h-4 w-4" />
                        {t('integrations.testOutbound', { defaultValue: 'Test outbound' })}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem onSelect={onDelete} className="text-danger focus:bg-danger/10 focus:text-danger">
                    <Trash2 className="me-2 h-4 w-4" />
                    {t('integrations.deleteConfirm', { defaultValue: 'Delete integration' })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 py-5">
          {missingRowKey(source) && (
            <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t('integrations.noRowKeyTitle', { defaultValue: 'No row key set' })}</p>
                <p className="mt-0.5 text-muted-foreground">
                  {t('integrations.noRowKeyBody', { defaultValue: 'Every row this API returns is skipped until you pick the column that identifies each row.' })}
                </p>
              </div>
              {canManage && (
                <Button size="sm" variant="outline" className="shrink-0" onClick={onEdit}>
                  {t('integrations.setRowKey', { defaultValue: 'Set row key' })}
                </Button>
              )}
            </div>
          )}

          {/* Overview */}
          <Section title={t('integrations.detail.overview', { defaultValue: 'Overview' })}>
            <dl className="divide-y rounded-lg border text-sm">
              <Row label={t('integrations.detail.sync', { defaultValue: 'Sync' })} value={scheduleLabel(source)} />
              <Row
                label={t('integrations.detail.lastRun', { defaultValue: 'Last run' })}
                value={lastRun ? relativeTime(lastRun, i18n.language) : t('integrations.status.never', { defaultValue: 'Not run yet' })}
                title={lastRun ? fullTime(lastRun, i18n.language) : undefined}
              />
              {created && <Row label={t('integrations.detail.created', { defaultValue: 'Created' })} value={relativeTime(created, i18n.language)} title={fullTime(created, i18n.language)} />}
            </dl>
          </Section>

          {/* Connection */}
          <Section title={file ? t('integrations.detail.file', { defaultValue: 'File' }) : t('integrations.detail.connection', { defaultValue: 'Connection' })}>
            <dl className="divide-y rounded-lg border text-sm">
              {source.kind === 'rest' ? (
                <>
                  <Row label={t('integrations.rest.url', { defaultValue: 'Endpoint' })} value={cfg.url ?? '—'} mono copy />
                  <Row label={t('integrations.rest.method', { defaultValue: 'Method' })} value={cfg.method ?? 'GET'} mono />
                  <Row label={t('integrations.rest.auth', { defaultValue: 'Authentication' })} value={authLabel} />
                  {cfg.rootPath && <Row label={t('integrations.rest.rootPath', { defaultValue: 'Where the items are (JSON path)' })} value={cfg.rootPath} mono />}
                </>
              ) : (
                <>
                  <Row label={t('integrations.detail.fileName', { defaultValue: 'File name' })} value={cfg.fileName ?? '—'} mono />
                  {typeof cfg.fileSize === 'number' && (
                    <Row label={t('integrations.detail.size', { defaultValue: 'Size' })} value={`${(cfg.fileSize / 1024).toLocaleString(i18n.language, { maximumFractionDigits: 1 })} KB`} />
                  )}
                  {typeof cfg.featureCount === 'number' && (
                    <Row label={t('integrations.detail.features', { defaultValue: 'Features' })} value={cfg.featureCount.toLocaleString(i18n.language)} />
                  )}
                </>
              )}
            </dl>
          </Section>

          {/* Recent runs */}
          <Section title={t('integrations.detail.runs', { defaultValue: 'Recent runs' })} action={<Button variant="ghost" size="sm" className="h-7" onClick={() => setReload((n) => n + 1)}>{t('common.refresh', { defaultValue: 'Refresh' })}</Button>}>
            {!runs || runs.key !== key ? (
              <ListSkeleton />
            ) : runs.error ? (
              <QueryError compact error={runs.error} onRetry={() => setReload((n) => n + 1)} what={t('integrations.detail.runsWhat', { defaultValue: 'the run history' })} />
            ) : runs.rows.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
                {t('integrations.detail.noRuns', { defaultValue: 'No runs yet. Run it to pull the first rows.' })}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {runs.rows.map((r) => {
                  const st = (r.stats ?? {}) as { rowsImported?: number; rowsErrored?: number; rowsRead?: number }
                  const ok = r.status === 'ok' || r.status === 'done' || r.status === 'success'
                  const when = r.finishedAt ?? r.startedAt ?? r.createdAt
                  return (
                    <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
                      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', ok ? (st.rowsErrored ? 'bg-warning' : 'bg-success') : 'bg-danger')} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm first-letter:uppercase" title={fullTime(when, i18n.language)}>{relativeTime(when, i18n.language)}</span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {typeof st.rowsImported === 'number'
                              ? t('integrations.detail.imported', { defaultValue: '{{count}} rows', count: st.rowsImported })
                              : r.status}
                            {st.rowsErrored ? ` · ${t('integrations.detail.errored', { defaultValue: '{{count}} failed', count: st.rowsErrored })}` : ''}
                          </span>
                        </div>
                        {r.errorReport && <p className="mt-1 line-clamp-2 break-words text-xs text-danger" title={r.errorReport}>{r.errorReport}</p>}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>

          {/* Latest rows */}
          <Section
            title={t('integrations.detail.latestRows', { defaultValue: 'Latest rows' })}
            action={rows && rows.key === key && !rows.error ? <span className="text-xs tabular-nums text-muted-foreground">{t('integrations.detail.totalRows', { defaultValue: '{{count}} rows in total', count: rows.total })}</span> : undefined}
          >
            {!rows || rows.key !== key ? (
              <ListSkeleton />
            ) : rows.error ? (
              <QueryError compact error={rows.error} onRetry={() => setReload((n) => n + 1)} what={t('integrations.detail.rowsWhat', { defaultValue: 'the latest rows' })} />
            ) : rows.rows.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
                {t('integrations.detail.noRows', { defaultValue: 'Nothing stored from this source yet.' })}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {rows.rows.map((r) => (
                  <li key={r.id} className="px-3 py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-mono text-xs font-medium" dir="ltr">{r.entityKey}</span>
                      <span className="shrink-0 text-xs text-muted-foreground" title={fullTime(r.updatedAt, i18n.language)}>{relativeTime(r.updatedAt, i18n.language)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground" dir="ltr">{summarise(r.payload, r.entityKey)}</p>
                  </li>
                ))}
              </ul>
            )}
            {sid !== undefined && rows && rows.total > rows.rows.length && (
              <Link to={`/data?source=${sid}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                {t('integrations.viewData', { defaultValue: 'View all data' })}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </Link>
            )}
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** One readable line from a row payload: `key value · key value` (the row key itself is already shown). */
function summarise(payload: unknown, rowKey: string): string {
  if (!payload || typeof payload !== 'object') return String(payload ?? '')
  return Object.entries(payload as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== '' && typeof v !== 'object' && String(v) !== rowKey)
    .slice(0, 5)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(' · ')
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({ label, value, title, mono, copy }: { label: string; value: string; title?: string; mono?: boolean; copy?: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono text-xs')} dir={mono ? 'ltr' : undefined} title={title ?? value}>
          {value}
        </span>
        {copy && value !== '—' && (
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              } catch {
                /* clipboard blocked */
              }
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t('common.copy', { defaultValue: 'Copy' })}
            title={t('common.copy', { defaultValue: 'Copy' })}
          >
            {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        )}
      </dd>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2 rounded-lg border p-3" aria-busy>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-4" style={{ width: `${85 - i * 15}%` }} />
      ))}
    </div>
  )
}
