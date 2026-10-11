/**
 * SPA-side WebSocket client for live streams.
 *
 * One `LiveStreamClient` instance owns one persistent WebSocket
 * connection to a `/streams/:token/ws` endpoint. Incoming JSON
 * messages are forwarded via `onMessage` to a handler; the client
 * itself stays domain-neutral. It auto-reconnects on close with
 * exponential backoff (1s → 2s → 4s → … → 30s).
 *
 * `useLiveStreamScheduler` mounts one client per active stream and
 * forwards every message to the generic entity_states ingest endpoint
 * (`POST /api/v1/streams/{id}/ingest`) — Slice 6c2 collapsed the four
 * per-entity dispatch paths (asset/sensor/rfid/shipment/camera) into
 * a single generic ingest. Publishers push raw JSON; the client
 * pulls a stable `entityKey` off common ID fields, extracts
 * `[lng, lat]` when both are numbers, and posts everything else as
 * opaque payload. The backend upserts into `entity_states` +
 * appends to `entity_events`; the viewer reads via
 * `/api/v1/entity-states`.
 */

import { useEffect, useRef, useState } from 'react'
import { apiDb } from '@/lib/api-db'
import { apiPost } from '@/lib/api-client'
import { API_BASE_URL, API_KEY } from '@/config/api'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { type Stream } from '@/lib/db'
import { queryCache, useApiQuery } from '@/lib/useApiQuery'
import { replayController } from './replay-controller'

// =================================================== registration helper

const REGISTER_TIMEOUT_MS = 15_000

/** Surfaced by `registerLiveStream` for friendly UI handling. */
export class LiveStreamRegisterError extends Error {}

/**
 * One-shot register helper — pings the backend so the UI can surface a
 * connectivity + credentials check before the stream is enabled.
 * Symmetric with `registerWebhookSource` for the queued case.
 */
export async function registerLiveStream(input: {
  workerBaseUrl: string
  streamToken: string
  hmacSecret: string
  drainApiKey: string
}): Promise<void> {
  // The Go backend doesn't need HMAC registration; the stream token is
  // resolved from the WS path and the API key is carried as a query
  // parameter. We still validate connectivity + credentials here so the
  // "Register only" button remains meaningful.
  const base = input.workerBaseUrl.replace(/\/+$/, '') || API_BASE_URL
  if (!base) throw new LiveStreamRegisterError('API base URL is required')

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${base}/healthz`, {
      method: 'GET',
      headers: {
        'X-Api-Key': input.drainApiKey || API_KEY,
      },
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new LiveStreamRegisterError(
        `Register timed out after ${REGISTER_TIMEOUT_MS / 1000}s`,
      )
    }
    throw new LiveStreamRegisterError(`Could not reach ${base}.`)
  } finally {
    window.clearTimeout(timer)
  }
  if (!res.ok) {
    throw new LiveStreamRegisterError(
      `Backend returned ${res.status} ${res.statusText}`,
    )
  }
}

// =============================================================== client

const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

export interface LiveStreamClientOptions {
  url: string
  /** Optional API key — sent as the `apiKey` query param (browsers can't set custom WS headers). */
  apiKey?: string
  /**
   * Per-message handler — invoked once per JSON text frame the socket
   * receives. The argument is the parsed JSON value (or `null` if it
   * failed to parse). Slice 6c2: the scheduler routes every stream
   * through the same generic ingest handler; per-kind dispatch is gone.
   */
  onMessage: (parsed: unknown) => Promise<void> | void
  /** Called once after every successful open. */
  onOpen?: () => void
  /** Called on every close (manual or unexpected). */
  onClose?: (event: CloseEvent) => void
  /** Logged when the socket fires `error`. The reconnect loop still runs. */
  onError?: (event: Event) => void
}

export class LiveStreamClient {
  private ws: WebSocket | null = null
  private opts: LiveStreamClientOptions
  private closedByUser = false
  private backoffMs = MIN_BACKOFF_MS
  private reconnectTimer: number | null = null

  constructor(opts: LiveStreamClientOptions) {
    this.opts = opts
  }

  start(): void {
    this.closedByUser = false
    this.connect()
  }

  /** Tear the socket down for good. After this returns the instance is dead. */
  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws !== null) {
      try {
        this.ws.close(1000, 'client shutdown')
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  private buildUrl(): string {
    const base = this.opts.url
    if (!this.opts.apiKey) return base
    // Custom HTTP headers can't ride a browser-issued WS handshake, so
    // the backend accepts the API key on a query param.
    const sep = base.includes('?') ? '&' : '?'
    return `${base}${sep}apiKey=${encodeURIComponent(this.opts.apiKey)}`
  }

  private connect(): void {
    if (this.closedByUser) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.buildUrl())
    } catch (err) {
      console.warn('[live-stream] failed to construct WebSocket', err)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.backoffMs = MIN_BACKOFF_MS
      this.opts.onOpen?.()
    }

    ws.onmessage = async (ev) => {
      if (typeof ev.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(ev.data) as unknown
      } catch {
        return
      }
      try {
        await this.opts.onMessage(parsed)
      } catch (err) {
        console.warn('[live-stream] handler failed', err)
      }
    }

    ws.onerror = (ev) => {
      this.opts.onError?.(ev)
    }

    ws.onclose = (ev) => {
      this.ws = null
      this.opts.onClose?.(ev)
      if (this.closedByUser) return
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return
    const wait = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, wait)
  }
}

// =============================================================== scheduler

/**
 * React hook the editor route mounts once. Watches the live `streams`
 * table and keeps one `LiveStreamClient` alive per WS-transport stream
 * whose schedule is `on-load` or `interval`. Schedules with `manual`
 * are skipped (the user triggers them from the integrations page).
 *
 * Slice 6c2: dispatch is now generic. Every received message is coerced
 * into `{ entityKey, payload, position?, ts? }` and POSTed to
 * `/api/v1/streams/{id}/ingest`. `entityType` on the parent Stream
 * still exists (for sidebar grouping) but is no longer read here.
 */
export function useLiveStreamScheduler(enabled = true): void {
  const tenantId = useCurrentTenantId()
  const streamsQuery = useApiQuery(
    () => apiDb.streams.toArray(),
    ['streams', tenantId],
    { intervalMs: 0, enabled },
  )
  const streams = streamsQuery.data ?? []
  const clientsRef = useRef<Map<number, LiveStreamClient>>(new Map())
  const [replayTick, setReplayTick] = useState(0)
  useEffect(() => {
    if (!enabled) return undefined
    return replayController.subscribe(() => {
      setReplayTick((t) => t + 1)
    })
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const clients = clientsRef.current
    const wantedIds = new Set<number>()
    for (const stream of streams) {
      const id = stream.id
      if (id === undefined) continue
      if (!isWsStream(stream)) continue
      if (stream.schedule === 'manual') continue
      if (replayController.isStreamPaused(id)) {
        const existing = clients.get(id)
        if (existing) {
          existing.close()
          clients.delete(id)
        }
        continue
      }
      wantedIds.add(id)
      if (clients.has(id)) continue
      const url = liveStreamUrl(stream)
      if (!url) continue
      const apiKey = liveStreamApiKey(stream)
      // Our own backend's socket already stores every message it
      // receives; re-POSTing it to /ingest wrote each event twice.
      const onMessage = isServerIngestedUrl(url) ? refreshEntityStates : makeGenericIngestHandler(id)
      const client = new LiveStreamClient({
        url,
        apiKey,
        onMessage,
      })
      client.start()
      clients.set(id, client)
    }
    for (const [id, client] of clients) {
      if (!wantedIds.has(id)) {
        client.close()
        clients.delete(id)
      }
    }
  }, [streams, replayTick, enabled])

  useEffect(() => {
    const clients = clientsRef.current
    return () => {
      for (const client of clients.values()) client.close()
      clients.clear()
    }
  }, [])
}

// ============================================================ dispatch

/**
 * Slice 6c2 — public dispatch helper. Returns the generic ingest
 * handler for the given stream. Kept exported so the replay service can
 * re-feed historical events through the same code path as live.
 */
export function getStreamMessageHandler(
  stream: Stream,
): ((parsed: unknown) => Promise<void>) | null {
  if (stream.id === undefined) return null
  if (!isWsStream(stream)) return null
  return makeGenericIngestHandler(stream.id)
}

/** `…/api/v1/streams/<token>/ws` — an Spatial Map socket that ingests server-side. */
function isServerIngestedUrl(url: string): boolean {
  try {
    return /\/api\/v1\/streams\/[^/]+\/ws$/.test(new URL(url, window.location.origin).pathname)
  } catch {
    return false
  }
}

async function refreshEntityStates(): Promise<void> {
  queryCache.invalidate('entity-states')
}

/**
 * Only WS-transport streams get a live client. File/REST/webhook
 * sources are polled by `useDataSourceScheduler` instead.
 */
function isWsStream(stream: Stream): boolean {
  const ep = stream.endpoint as { transport?: string }
  return ep.transport === 'ws'
}

/**
 * Slice 6c2 generic ingest handler.
 *
 * Coerces a raw parsed message into the shape the backend's
 * `/streams/:id/ingest` endpoint accepts and POSTs it. The publisher's
 * payload is passed through untouched — the frontend DataLinkConfig's
 * `fieldMapping` interprets it at render time. Common ID fields
 * (`entityKey`, `id`, and the legacy `assetId`/`sensorId`/`tagId`/
 * `shipmentId`/`cameraId`) are checked in that order so the older WS
 * publishers keep working after the deletion of the per-entity
 * dispatch paths. Messages without a usable ID are skipped with a warn.
 *
 * `lng`/`lat` extraction pulls a `[lng, lat]` position when both are
 * numbers; the backend's PostGIS column tolerates absence.
 *
 * After every successful POST we invalidate the tenant-wide
 * `entity-states` cache so the viewer refetches immediately instead of
 * waiting for its 5s poll interval.
 */
function makeGenericIngestHandler(streamId: number): (parsed: unknown) => Promise<void> {
  return async (parsed) => {
    if (!parsed || typeof parsed !== 'object') return
    // Some publishers wrap events in an array or an `events` field.
    const events = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { events?: unknown }).events)
        ? (parsed as { events: unknown[] }).events
        : [parsed]
    const outEvents: Array<{
      entityKey: string
      payload: Record<string, unknown>
      position?: [number, number]
      ts?: string
    }> = []
    for (const raw of events) {
      if (!raw || typeof raw !== 'object') continue
      const rec = raw as Record<string, unknown>
      const entityKey =
        pickString(rec.entityKey) ??
        pickString(rec.assetId) ??
        pickString(rec.sensorId) ??
        pickString(rec.tagId) ??
        pickString(rec.shipmentId) ??
        pickString(rec.cameraId) ??
        pickString(rec.id)
      if (!entityKey) {
        console.warn('[live-stream] skipping message with no entityKey', rec)
        continue
      }
      const outEvent: {
        entityKey: string
        payload: Record<string, unknown>
        position?: [number, number]
        ts?: string
      } = {
        entityKey,
        payload: rec,
      }
      const lng = typeof rec.lng === 'number' ? rec.lng : undefined
      const lat = typeof rec.lat === 'number' ? rec.lat : undefined
      if (lng !== undefined && lat !== undefined) {
        outEvent.position = [lng, lat]
      }
      // The backend reads RFC 3339 or epoch seconds/ms and rejects
      // anything else, so normalise looser date strings here.
      const ts = pickString(rec.ts)
      if (ts && !Number.isNaN(Date.parse(ts))) {
        outEvent.ts = new Date(ts).toISOString()
      } else if (typeof rec.ts === 'number' && Number.isFinite(rec.ts)) {
        outEvent.ts = new Date(rec.ts < 1e11 ? rec.ts * 1000 : rec.ts).toISOString()
      }
      outEvents.push(outEvent)
    }
    if (outEvents.length === 0) return
    try {
      await apiPost(`/streams/${streamId}/ingest`, { events: outEvents })
      // Nudge the viewer's tenant-wide entity_states query so a new
      // event surfaces instantly instead of waiting for the 5s poll.
      queryCache.invalidate('entity-states')
    } catch (err) {
      console.warn('[live-stream] ingest POST failed', streamId, err)
    }
  }
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function liveStreamUrl(stream: Stream): string | null {
  const endpoint = stream.endpoint as { url?: string; transport?: string }
  if (typeof endpoint.url === 'string' && endpoint.url.length > 0) return endpoint.url
  return null
}

function liveStreamApiKey(stream: Stream): string | undefined {
  const ep = stream.endpoint as { apiKey?: unknown }
  if (typeof ep.apiKey === 'string') return ep.apiKey
  return undefined
}

/**
 * Async sibling of `liveStreamApiKey` for callers that want the
 * Connection-level auth resolved (the sync version only reads what's
 * stamped on the Stream's endpoint).
 */
export async function resolveStreamApiKey(stream: Stream): Promise<string | undefined> {
  const fromEndpoint = liveStreamApiKey(stream)
  if (fromEndpoint) return fromEndpoint
  if (stream.connectionId === undefined) return undefined
  const conn = await apiDb.connections.get(stream.connectionId)
  if (!conn) return undefined
  if (conn.auth.mode === 'apiKey') return conn.auth.value
  if (conn.auth.mode === 'bearer') return conn.auth.token
  return undefined
}
