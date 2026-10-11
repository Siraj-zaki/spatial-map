/**
 * Phase 6 — outbound writes.
 *
 * The data plane is read-only until this. With outbound, an SPA-side
 * mutation (status flip, asset reassignment, bin override) flows back
 * through a Connection to the source system.
 *
 * Three pieces:
 *
 *   1. `pushOutboundPatch(input)` — POSTs a patch to the configured
 *      outbound URL (REST). Writes one `auditLog` row per attempt with
 *      `{ before, after, status, httpStatus, message }`.
 *
 *   2. A `bin-write-back` binding kind that opts a REST stream into
 *      outbound. Phase 6a uses the same URL as the inbound REST source
 *      — the publisher's "source" and "sink" are usually the same
 *      endpoint family. Phase 6b adds a separate `outbound` config
 *      block for asymmetric cases.
 *
 *   3. A small last-write-wins conflict policy. Phase 6a accepts the
 *      local mutation unconditionally; Phase 6b will compare server
 *      timestamps and surface conflicts in the UI.
 *
 * The Worker is *not* in the loop for Phase 6a — the SPA fetches the
 * target URL directly. If the destination CORS-blocks the SPA, we'll
 * add a proxy hop through the Worker in Phase 6b.
 */

import { apiDb } from '@/lib/api-db'
import type { AuditLogEntry, Bin, Stream } from '@/lib/db'
import type { ConnectionAuth } from './contracts'

export class OutboundError extends Error {}

const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000

export interface OutboundPatchInput {
  /** Stream that owns the outbound contract. */
  streamId: number
  /** Entity type the patch targets (`bin` / `asset` / `shipment` / …). */
  entityType: string
  /** Stable id for the entity (e.g. the bin externalCode). */
  entityKey: string
  /** Snapshot of the entity before the local change — written to the audit row. */
  before: Record<string, unknown>
  /** Snapshot after the change. POSTed as the request body. */
  after: Record<string, unknown>
  /** Optional override for the destination URL. Falls back to stream/connection config. */
  urlOverride?: string
  /** Optional HTTP method override. Defaults to POST. */
  method?: 'POST' | 'PATCH' | 'PUT'
  /**
   * Phase 7c-lite — when set, the SPA POSTs to the Worker's
   * `/proxy-outbound` route instead of fetching the destination
   * directly. Solves CORS without changing the credential storage
   * model. The destination URL + headers still travel from the SPA
   * but never need to be CORS-allowed by the customer system.
   */
  proxy?: {
    workerBaseUrl: string
    streamToken: string
    apiKey: string
  }
}

export interface OutboundResult {
  ok: boolean
  httpStatus?: number
  message?: string
  auditId: number
}

/**
 * Read the URL the SPA should POST to for `stream`. Two ways:
 *   1. Explicit `endpoint.outboundUrl` (Phase 6b config) — wins.
 *   2. Otherwise reuse `endpoint.url` (the inbound REST URL) — the
 *      typical case when the source and sink are the same endpoint.
 */
async function resolveOutboundUrl(stream: Stream): Promise<string | null> {
  const ep = stream.endpoint as { outboundUrl?: unknown; url?: unknown }
  if (typeof ep.outboundUrl === 'string' && ep.outboundUrl.length > 0) {
    return ep.outboundUrl
  }
  if (typeof ep.url === 'string' && ep.url.length > 0) return ep.url
  if (stream.connectionId === undefined) return null
  const conn = await apiDb.connections.get(stream.connectionId)
  const cfg = conn?.config as { url?: unknown; baseUrl?: unknown } | undefined
  if (cfg && typeof cfg.url === 'string') return cfg.url
  if (cfg && typeof cfg.baseUrl === 'string') return cfg.baseUrl
  return null
}

/**
 * Build the request headers from the parent Connection's auth. Mirrors
 * the rest-fetcher's logic — same auth modes (`none | apiKey | bearer
 * | custom | hmac`).
 */
function authHeaders(auth: ConnectionAuth | undefined): Record<string, string> {
  if (!auth) return {}
  if (auth.mode === 'apiKey') {
    return { [auth.headerName ?? 'X-Api-Key']: auth.value }
  }
  if (auth.mode === 'bearer') return { Authorization: `Bearer ${auth.token}` }
  if (auth.mode === 'custom') return { ...auth.headers }
  return {}
}

/**
 * Core outbound primitive. Always returns — failures land on the audit
 * row, never thrown — so the caller (a click handler, a save flow) can
 * surface a toast without try/catch ceremony.
 */
export async function pushOutboundPatch(
  input: OutboundPatchInput,
): Promise<OutboundResult> {
  const now = new Date()
  const stream = await apiDb.streams.get(input.streamId)
  if (!stream) {
    return failAndAudit(input, 'stream not found', null, now)
  }
  const url = input.urlOverride ?? (await resolveOutboundUrl(stream))
  if (!url) {
    return failAndAudit(input, 'no outbound URL configured on stream', null, now, undefined)
  }

  // Look up auth from the parent Connection.
  let auth: ConnectionAuth | undefined
  if (stream.connectionId !== undefined) {
    const conn = await apiDb.connections.get(stream.connectionId)
    auth = conn?.auth
  }

  const method = input.method ?? 'POST'
  const destinationHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders(auth),
  }

  const controller = new AbortController()
  const timer = window.setTimeout(
    () => controller.abort(),
    DEFAULT_OUTBOUND_TIMEOUT_MS,
  )

  let httpStatus: number | undefined
  let message: string | undefined
  let ok = false
  try {
    let res: Response
    if (input.proxy) {
      // Phase 7c-lite — route through the Worker's outbound proxy.
      // The Worker forwards the body+headers verbatim and returns
      // the destination's body. The upstream HTTP status comes back
      // on the `X-Forwarded-Status` header so we record it
      // correctly on the audit row even when the proxy itself
      // returned 502 because the destination did.
      const proxyUrl = `${input.proxy.workerBaseUrl.replace(/\/+$/, '')}/streams/${encodeURIComponent(input.proxy.streamToken)}/proxy-outbound`
      res = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': input.proxy.apiKey,
        },
        body: JSON.stringify({
          url,
          method,
          headers: destinationHeaders,
          body: JSON.stringify(input.after),
        }),
        signal: controller.signal,
      })
      const forwarded = res.headers.get('X-Forwarded-Status')
      const forwardedNum = forwarded ? Number.parseInt(forwarded, 10) : NaN
      httpStatus = Number.isFinite(forwardedNum) ? forwardedNum : res.status
      ok = res.ok && httpStatus >= 200 && httpStatus < 300
    } else {
      res = await fetch(url, {
        method,
        headers: destinationHeaders,
        body: JSON.stringify(input.after),
        signal: controller.signal,
      })
      httpStatus = res.status
      ok = res.ok
    }
    if (!ok) {
      // Try to surface the destination's error body for the audit row.
      try {
        const text = await res.text()
        message = text.slice(0, 400)
      } catch {
        message = `${res.status} ${res.statusText}`
      }
    }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    message =
      e.name === 'AbortError'
        ? `outbound timed out after ${DEFAULT_OUTBOUND_TIMEOUT_MS / 1000}s`
        : e.message ?? 'network failure'
  } finally {
    window.clearTimeout(timer)
  }

  const auditId = await writeAudit({
    streamId: input.streamId,
    entityType: input.entityType,
    entityKey: input.entityKey,
    url,
    method,
    before: input.before,
    after: input.after,
    status: ok ? 'ok' : 'error',
    httpStatus,
    message,
    ts: now,
  })
  return { ok, httpStatus, message, auditId }
}

async function failAndAudit(
  input: OutboundPatchInput,
  reason: string,
  status: number | null,
  ts: Date,
  url?: string,
): Promise<OutboundResult> {
  const auditId = await writeAudit({
    streamId: input.streamId,
    entityType: input.entityType,
    entityKey: input.entityKey,
    url: url ?? '',
    method: input.method ?? 'POST',
    before: input.before,
    after: input.after,
    status: 'error',
    httpStatus: status ?? undefined,
    message: reason,
    ts,
  })
  return { ok: false, message: reason, auditId }
}

async function writeAudit(entry: Omit<AuditLogEntry, 'id'>): Promise<number> {
  return await apiDb.auditLog.add(entry)
}

// =========================================================== queries

/** Last `n` audit rows, newest first. Used by the Audit log tab. */
export async function recentAudit(n = 200): Promise<AuditLogEntry[]> {
  const rows = await apiDb.auditLog.toArray()
  rows.sort((a, b) => b.ts.getTime() - a.ts.getTime())
  return rows.slice(0, n)
}

export async function deleteAuditForStream(streamId: number): Promise<void> {
  const rows = await apiDb.auditLog.where('streamId').equals(streamId).toArray()
  await Promise.all(rows.map((row) => (row.id !== undefined ? apiDb.auditLog.delete(row.id) : Promise.resolve())))
}

// ==================================================== auto-outbound bin

/**
 * Phase 6b — high-level wrapper that applies a bin patch *and* fires
 * an outbound write if a matching stream opts in.
 *
 * Flow:
 *   1. Read the current row (the `before` snapshot).
 *   2. Apply `patch` to `db.bins`.
 *   3. Look up the Stream that mirrors `before.syncSource` (the legacy
 *      DataSource id stamped on import).
 *   4. If that Stream's binding is `bin-write-back`, push the patched
 *      row via `pushOutboundPatch`. Otherwise it's a local-only edit
 *      and only the audit row is written.
 *
 * Returns `{ ok: true, outboundFired }` on success. Failures from
 * outbound land on the audit log but don't roll the local update back
 * — the SPA stays authoritative for what the operator sees.
 */
export async function editBinWithOutbound(
  binId: number,
  patch: Partial<Bin>,
): Promise<{ ok: true; outboundFired: boolean; outbound?: OutboundResult }> {
  const before = await apiDb.bins.get(binId)
  if (!before) {
    return { ok: true, outboundFired: false }
  }
  await apiDb.bins.update(binId, patch)
  const after = await apiDb.bins.get(binId)
  if (!after) {
    return { ok: true, outboundFired: false }
  }
  const stream = await findWriteBackStream(before.syncSource)
  if (!stream || stream.id === undefined) {
    return { ok: true, outboundFired: false }
  }
  const binding = stream.binding
  if (binding.kind !== 'bin-write-back') {
    return { ok: true, outboundFired: false }
  }
  const outbound = await pushOutboundPatch({
    streamId: stream.id,
    entityType: 'bin',
    entityKey: before.externalCode ?? String(binId),
    before: toRecord(before),
    after: toRecord(after),
    method: binding.method ?? 'POST',
  })
  return { ok: true, outboundFired: true, outbound }
}

/**
 * Find the Stream that owns outbound for a given legacy DataSource id.
 * Looks up the corresponding Phase 0 stream row by `dataSourceId`.
 */
async function findWriteBackStream(
  syncSource: number | undefined,
): Promise<Stream | null> {
  if (syncSource === undefined) return null
  const matches = await apiDb.streams.where('dataSourceId').equals(syncSource).toArray()
  return matches[0] ?? null
}

function toRecord(bin: Bin): Record<string, unknown> {
  // Strip Dexie internals + dates we'd rather have as ISO. The
  // destination almost always wants a flat JSON shape.
  const { customProperties, ...rest } = bin
  return {
    ...rest,
    customProperties: customProperties ?? {},
  } as Record<string, unknown>
}
