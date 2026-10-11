/**
 * HistoryWidget — Phase 3 widget that renders "what changed in this
 * data over time" for one data source. Reads GET /reports/_/history
 * and draws:
 *   - a small stacked area chart (insert / update / delete counts per
 *     bucket over the configured window)
 *   - a compact "recent changes" list below the chart
 *
 * The endpoint is not tied to a specific report — a report can have
 * multiple History widgets over different sources, each fetching
 * independently.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, History, Loader2 } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import {
  fetchReportHistory,
  type HistoryBindings,
  type HistoryResult,
  type ReportWidget,
} from '@/lib/reports-client'

const OP_META: Record<'insert' | 'update' | 'delete', { color: string; labelKey: string; fallback: string }> = {
  insert: { color: 'hsl(var(--chart-2))', labelKey: 'reports.historyOpInsert', fallback: 'inserts' },
  update: { color: 'hsl(var(--chart-1))', labelKey: 'reports.historyOpUpdate', fallback: 'updates' },
  delete: { color: 'hsl(var(--danger))', labelKey: 'reports.historyOpDelete', fallback: 'deletes' },
}

export function HistoryWidget({
  widget,
  locale,
}: {
  widget: ReportWidget
  locale: string
}) {
  const { t } = useTranslation()
  const bindings = (widget.bindings ?? {}) as HistoryBindings
  const enabled = Number.isFinite(bindings.sourceId) && bindings.sourceId > 0
  // One fetch per binding set; `loading` is "the last answer is for other bindings".
  const key = `${bindings.sourceId}:${bindings.windowDays}:${bindings.bucket}:${bindings.recent}`
  const [fetched, setFetched] = useState<{ key: string; result: HistoryResult | null; error: string | null } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchReportHistory({
      sourceId: bindings.sourceId,
      windowDays: bindings.windowDays,
      bucket: bindings.bucket,
      recent: bindings.recent,
    })
      .then((r) => {
        if (!cancelled) setFetched({ key, result: r, error: null })
      })
      .catch((err) => {
        if (!cancelled) setFetched({ key, result: null, error: (err as Error).message })
      })
    return () => {
      cancelled = true
    }
  }, [enabled, key, bindings.sourceId, bindings.windowDays, bindings.bucket, bindings.recent])

  const current = fetched?.key === key ? fetched : null
  const result = current?.result ?? null
  const error = current?.error ?? null
  const loading = enabled && !current

  const ops = bindings.operations ?? ['insert', 'update', 'delete']
  const chartData = useMemo(() => {
    if (!result || !result.buckets) return []
    return result.buckets.map((b) => ({
      ...b,
      ts: formatBucketLabel(b.ts, result.bucketUnit, locale),
    }))
  }, [result, locale])

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-muted-foreground" aria-hidden />
          <span className="font-semibold text-sm">
            {widget.title ?? t('reports.historyDefaultTitle', { defaultValue: 'Change history' })}
          </span>
        </div>
        {result && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('reports.historyTotalEvents', {
              defaultValue: '{{count}} events · last {{days}} days',
              count: result.totalEvents,
              days: result.windowDays,
            })}
          </span>
        )}
      </div>

      {!enabled && (
        <div className="text-center py-10 px-4 text-sm text-muted-foreground italic">
          {t('reports.historyPickSource', {
            defaultValue: 'Pick a source id in the widget editor to render history.',
          })}
        </div>
      )}

      {enabled && loading && !result && (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin me-2" aria-hidden />
          {t('reports.historyLoading', { defaultValue: 'Loading history…' })}
        </div>
      )}

      {enabled && error && (
        <div
          role="alert"
          className="text-sm text-destructive bg-destructive/10 border border-destructive/20 mx-4 my-3 rounded-md px-3 py-2 flex items-start gap-2"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
          <span className="flex-1 break-words whitespace-pre-line">{error}</span>
        </div>
      )}

      {enabled && result && (
        <>
          <div className="p-4">
            {(result.buckets?.length ?? 0) === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground italic">
                {t('reports.historyNoEvents', {
                  defaultValue: 'No events in the selected window.',
                })}
              </div>
            ) : (
              <div className="h-48" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="ts"
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={10}
                    />
                    <YAxis
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={10}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {ops.map((op) => {
                      const meta = OP_META[op]
                      return (
                        <Area
                          key={op}
                          type="monotone"
                          dataKey={op}
                          name={t(meta.labelKey, { defaultValue: meta.fallback })}
                          stackId="ops"
                          stroke={meta.color}
                          fill={meta.color}
                          fillOpacity={0.25}
                          isAnimationActive={false}
                        />
                      )
                    })}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
          {(result.recent?.length ?? 0) > 0 && (
            <div className="border-t">
              <table className="w-full text-xs">
                <thead className="bg-card">
                  <tr className="border-b">
                    <th className="text-start px-3 py-2 text-[11px] font-medium text-muted-foreground">
                      {t('reports.historyRecentWhen', { defaultValue: 'When' })}
                    </th>
                    <th className="text-start px-3 py-2 text-[11px] font-medium text-muted-foreground">
                      {t('reports.historyRecentOp', { defaultValue: 'Op' })}
                    </th>
                    <th className="text-start px-3 py-2 text-[11px] font-medium text-muted-foreground">
                      {t('reports.historyRecentKey', { defaultValue: 'Key' })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(result.recent ?? []).map((ev) => (
                    <tr key={ev.id} className="border-b last:border-b-0 hover:bg-muted/30">
                      <td className="px-3 py-1.5 whitespace-nowrap text-[11px]">
                        {new Date(ev.ts).toLocaleString(locale)}
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className={cn(
                            'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium',
                            ev.operation === 'insert' &&
                              'bg-success/10 text-success',
                            ev.operation === 'update' &&
                              'bg-info/10 text-info',
                            ev.operation === 'delete' &&
                              'bg-danger/10 text-danger',
                          )}
                        >
                          {ev.operation}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[11px] truncate max-w-[240px]">
                        {ev.entityKey}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Locale-friendly bucket-timestamp formatter. */
function formatBucketLabel(iso: string, unit: 'hour' | 'day' | 'week' | 'month', locale: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  switch (unit) {
    case 'hour':
      return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    case 'month':
      return d.toLocaleDateString(locale, { month: 'short', year: '2-digit' })
    case 'week':
    case 'day':
    default:
      return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  }
}
