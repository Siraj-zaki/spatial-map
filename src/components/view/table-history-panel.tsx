/**
 * TableHistoryPanel — per-row change log for a table-backed data-link
 * entity. Reads `GET /tables/{sourceId}/events/{entityKey}` and
 * renders the trail as a compact timeline: timestamp + operation
 * badge + expandable field diff against the previous snapshot.
 *
 * Only renders when the entity is backed by a table source AND has an
 * `entityKey`. Silent no-op otherwise — a streamed entity has its own
 * event pipeline (see `entity_events` / `replay-service.ts`) and
 * doesn't fit this panel's diff-per-snapshot model.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Loader2, Plus, Pencil, Trash2 } from 'lucide-react'

import { useApiQuery } from '@/lib/useApiQuery'
import {
  listRowEvents,
  type TableRowEvent,
} from '@/lib/data-link/table-events-client'

export interface TableHistoryPanelProps {
  sourceId: number
  entityKey: string
  /** Max rows to fetch. Backend clamps to 5000; default 500 is plenty for the drawer. */
  limit?: number
}

export function TableHistoryPanel({
  sourceId,
  entityKey,
  limit = 500,
}: TableHistoryPanelProps) {
  const { t } = useTranslation()
  const query = useApiQuery<TableRowEvent[]>(
    () => listRowEvents(sourceId, entityKey, { limit }),
    ['table-row-events', sourceId, entityKey, limit],
    // No polling — history is append-only and the drawer already
    // refetches on open. Poll would waste bytes on every re-render.
    { intervalMs: 0 },
  )
  const events = query.data ?? []

  if (query.isLoading && events.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('history.loading', { defaultValue: 'Loading history…' })}
      </div>
    )
  }
  if (query.error) {
    return (
      <div className="px-3 py-2 text-xs text-destructive">
        {query.error.message}
      </div>
    )
  }
  if (events.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground text-center">
        {t('history.empty', {
          defaultValue: 'No changes recorded yet.',
        })}
      </div>
    )
  }

  // Newest-first for display; the backend returns ascending so we
  // reverse a copy. Diffs are computed against the *previous* event
  // in ts order (event[i]'s prior state is event[i-1] ascending).
  const ascending = events
  const descending = [...events].reverse()

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 backdrop-blur-sm shadow-sm divide-y divide-border/40">
      {descending.map((ev, iDesc) => {
        const iAsc = ascending.length - 1 - iDesc
        const prior = iAsc > 0 ? ascending[iAsc - 1] : null
        return (
          <EventRow
            key={ev.id}
            event={ev}
            prior={prior}
            isMostRecent={iDesc === 0}
          />
        )
      })}
    </div>
  )
}

function EventRow({
  event,
  prior,
  isMostRecent,
}: {
  event: TableRowEvent
  prior: TableRowEvent | null
  isMostRecent: boolean
}) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(isMostRecent)

  const diff = useMemo(
    () => computeDiff(prior?.payload ?? null, event.payload, event.operation),
    [prior, event],
  )

  const OpIcon =
    event.operation === 'insert'
      ? Plus
      : event.operation === 'delete'
      ? Trash2
      : Pencil
  const opTone =
    event.operation === 'insert'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : event.operation === 'delete'
      ? 'bg-destructive/10 text-destructive'
      : 'bg-primary/10 text-primary'

  const ts = new Date(event.ts)
  const relative = formatRelative(ts, i18n.language)
  const absolute = ts.toLocaleString(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  return (
    <div className="p-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-start"
      >
        <span
          className={`inline-flex items-center justify-center h-5 w-5 rounded-full ${opTone} shrink-0`}
          aria-hidden
        >
          <OpIcon className="h-3 w-3" />
        </span>
        <span className="text-[11px] font-medium capitalize shrink-0">
          {t(`history.op.${event.operation}`, { defaultValue: event.operation })}
        </span>
        <span
          className="text-[10.5px] text-muted-foreground truncate flex-1"
          title={absolute}
        >
          {relative} · {absolute}
        </span>
        {diff.length > 0 && (
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
            {t('history.fieldsChanged', {
              defaultValue: '{{n}} fields',
              n: diff.length,
            })}
          </span>
        )}
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="mt-2 ms-7 grid gap-1">
          {diff.length === 0 && (
            <p className="text-[10.5px] text-muted-foreground italic">
              {t('history.noVisibleChanges', {
                defaultValue: 'No field-level changes recorded.',
              })}
            </p>
          )}
          {diff.map((d) => (
            <div
              key={d.field}
              className="text-[10.5px] font-mono grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2"
            >
              <span className="text-foreground truncate" title={d.field}>
                {d.field}
              </span>
              <span className="text-muted-foreground truncate max-w-[10rem]" title={d.before}>
                {d.before || '—'}
              </span>
              <span className="text-primary truncate" title={d.after}>
                → {d.after || '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Field-level diff between two payload snapshots. Returns one entry per
 * changed / added / removed key at the top level. Deep objects show
 * their `JSON.stringify` form because nested-diff UI would eat the
 * drawer's width without adding much value at this scale.
 */
function computeDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  operation: TableRowEvent['operation'],
): Array<{ field: string; before: string; after: string }> {
  if (operation === 'insert') {
    return Object.entries(after)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([field, v]) => ({ field, before: '', after: format(v) }))
  }
  if (operation === 'delete') {
    return Object.entries(after)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([field, v]) => ({ field, before: format(v), after: '' }))
  }
  // update — compare each key present in either snapshot.
  if (!before) {
    return Object.entries(after).map(([field, v]) => ({
      field,
      before: '',
      after: format(v),
    }))
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: Array<{ field: string; before: string; after: string }> = []
  for (const k of keys) {
    const b = format(before[k])
    const a = format(after[k])
    if (b !== a) out.push({ field: k, before: b, after: a })
  }
  return out
}

function format(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * "2m ago" / "3h ago" / "yesterday" style. Intentionally coarse — the
 * absolute timestamp is right next to it, so we don't need "seconds
 * ago" precision.
 */
function formatRelative(d: Date, locale: string): string {
  const diffMs = Date.now() - d.getTime()
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const abs = Math.abs(diffMs)
  const sign = diffMs >= 0 ? -1 : 1
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (abs < hour) return rtf.format(sign * Math.round(abs / min), 'minute')
  if (abs < day) return rtf.format(sign * Math.round(abs / hour), 'hour')
  if (abs < 30 * day) return rtf.format(sign * Math.round(abs / day), 'day')
  return rtf.format(sign * Math.round(abs / (30 * day)), 'month')
}
