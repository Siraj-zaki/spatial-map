/**
 * table-events-client — thin wrappers over the backend's per-table
 * history endpoints. History is written by `recordRowEvent` on every
 * insert / update / delete on `table_rows_authed.go` and
 * `table_rows_public.go`, so any table source has an accumulating
 * trail on `data_source_row_events` that these calls read back.
 *
 * Endpoints (see `backend/internal/handlers/tables.go`):
 *   • `GET /tables/{id}/events?window=<sec>&limit=<n>` — windowed
 *     across the whole source; feeds the heatmap and the player.
 *   • `GET /tables/{id}/events/{key}?limit=<n>` — per-row trail;
 *     feeds the drawer's History section.
 *
 * All calls are tenant-scoped by the auth middleware — the client
 * doesn't attach a tenant id; the router uses the request's context.
 */

import { apiGet } from '@/lib/api-client'
import { sourceShareActive, sourceShareGet } from '@/lib/reports/report-share'

/**
 * Wire shape from `dataSourceRowEventResponse`. `ts` is an ISO
 * timestamp (backend emits `time.Format(time.RFC3339Nano)` via the
 * pgtype → JSON path). Kept as a string so callers can `new Date(...)`
 * only when they need to render it.
 */
export interface TableRowEvent {
  id: number
  entityKey: string
  payload: Record<string, unknown>
  operation: 'insert' | 'update' | 'delete'
  ts: string
  sourceIp?: string
  authTokenId?: number
}

export interface ListTableEventsOpts {
  /** Seconds back from now. Backend clamps to (0, 30d]. Default 24h. */
  windowSec?: number
  /** A custom range (epoch ms) instead of `windowSec` — both ends, at
   *  most 31 days apart. */
  from?: number
  to?: number
  /** Max rows. Backend clamps to (0, 5000]. Default 500. */
  limit?: number
}

/**
 * Cross-source window — every event on the table within `windowSec`.
 * Ordered ascending by ts so the caller can pipe straight into a
 * time-bucket aggregator without re-sorting.
 */
export async function listTableEvents(
  sourceId: number,
  opts: ListTableEventsOpts = {},
): Promise<TableRowEvent[]> {
  const qs = new URLSearchParams()
  if (opts.from !== undefined && opts.to !== undefined) {
    qs.set('from', new Date(opts.from).toISOString())
    qs.set('to', new Date(opts.to).toISOString())
  } else if (opts.windowSec !== undefined) qs.set('window', String(opts.windowSec))
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  if (sourceShareActive()) return sourceShareGet<TableRowEvent[]>(`/sources/${sourceId}/events${suffix}`)
  return apiGet<TableRowEvent[]>(`/tables/${sourceId}/events${suffix}`)
}

/**
 * Per-row trail — every event for one `entityKey`. No window (backend
 * defaults to epoch 0), because a viewer opening a row's History
 * asked for that row explicitly.
 */
export async function listRowEvents(
  sourceId: number,
  entityKey: string,
  opts: Pick<ListTableEventsOpts, 'limit'> = {},
): Promise<TableRowEvent[]> {
  const qs = new URLSearchParams()
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  if (sourceShareActive()) {
    return sourceShareGet<TableRowEvent[]>(`/sources/${sourceId}/events/${encodeURIComponent(entityKey)}${suffix}`)
  }
  return apiGet<TableRowEvent[]>(
    `/tables/${sourceId}/events/${encodeURIComponent(entityKey)}${suffix}`,
  )
}
