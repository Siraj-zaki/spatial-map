/**
 * Audit log — every write the app pushed back to a source system
 * (outbound patches through a stream's destination URL; "Test outbound"
 * lands here too).
 *
 * Newest first (last 200). Filter All / Failed. Each row: status + HTTP
 * code, method, what it targeted, where it went, when; expand for the
 * error and the before → after payloads.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ScrollText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { FilterTabs } from '@/components/filter-tabs'
import { apiDb } from '@/lib/api-db'
import { useApiQuery } from '@/lib/useApiQuery'
import type { AuditLogEntry } from '@/lib/db'
import { useCurrentTenantId } from '@/lib/data-link'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'

const LIMIT = 200

export function AuditLogSection() {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const query = useApiQuery(
    async () => {
      const rows = await apiDb.auditLog.toArray()
      rows.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      return rows.slice(0, LIMIT)
    },
    ['auditLog', tenantId],
  )
  const entries = useMemo(() => query.data ?? [], [query.data])
  const [filter, setFilter] = useState<'all' | 'failed'>('all')
  const failed = entries.filter((e) => e.status !== 'ok')
  const visible = filter === 'failed' ? failed : entries

  if (query.isLoading && !query.data) return <Skeleton className="h-48 rounded-xl" />

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        title={t('integrations.audit.emptyTitle', { defaultValue: 'No outbound writes yet' })}
        description={t('integrations.audit.emptyBody', {
          defaultValue: 'When the app sends a change back to one of your systems — or you use Test outbound on a REST API — it’s recorded here.',
        })}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {t('integrations.audit.intro', { defaultValue: 'Changes the app sent back to your systems, newest first.' })}
          {entries.length === LIMIT && ` ${t('integrations.audit.limited', { defaultValue: 'Showing the latest {{count}}.', count: LIMIT })}`}
        </p>
        <FilterTabs
          ariaLabel={t('integrations.audit.filter', { defaultValue: 'Filter writes' })}
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: t('integrations.tabAll', { defaultValue: 'All' }), count: entries.length },
            { value: 'failed', label: t('integrations.audit.failed', { defaultValue: 'Failed' }), count: failed.length },
          ]}
        />
      </div>
      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {t('integrations.audit.noFailed', { defaultValue: 'No failed writes.' })}
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {visible.map((e) => (
            <AuditRow key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </div>
  )
}

function AuditRow({ entry }: { entry: AuditLogEntry }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const ok = entry.status === 'ok'
  const ts = new Date(entry.ts).toISOString()
  let where = entry.url
  try {
    const u = new URL(entry.url)
    where = u.host + u.pathname
  } catch {
    /* raw */
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight className={cn('mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none rtl:rotate-180', open && 'rotate-90 rtl:rotate-90')} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={ok ? 'success' : entry.status === 'error' ? 'danger' : 'warning'}>
              {ok ? t('integrations.audit.sent', { defaultValue: 'Sent' }) : t('integrations.audit.failedOne', { defaultValue: 'Failed' })}
              {entry.httpStatus !== undefined && <span className="ms-1 tabular-nums">{entry.httpStatus}</span>}
            </Badge>
            <span className="font-mono text-xs">{entry.method}</span>
            <span className="text-sm">
              <span className="capitalize text-muted-foreground">{entry.entityType}</span>{' '}
              <span className="font-mono text-xs" dir="ltr">{entry.entityKey}</span>
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" dir="ltr" title={entry.url}>{where}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground" title={fullTime(ts, i18n.language)}>{relativeTime(ts, i18n.language)}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t bg-muted/20 px-4 py-3 ps-11">
          {entry.message && !ok && <p className="break-words text-sm text-danger">{entry.message}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            {(['before', 'after'] as const).map((k) => (
              <div key={k}>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {k === 'before' ? t('integrations.audit.before', { defaultValue: 'Before' }) : t('integrations.audit.after', { defaultValue: 'After' })}
                </p>
                <pre className="max-h-56 overflow-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed" dir="ltr">
                  {JSON.stringify(entry[k], null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </li>
  )
}
