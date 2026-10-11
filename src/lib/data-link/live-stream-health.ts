/**
 * Phase 7 — SPA-side observability for live streams.
 *
 * Polls each live stream's `/stats` endpoint on a 10s heartbeat,
 * derives a rolling rate from the lifetime counters, and exposes a
 * keyed map the Health tab reads from.
 *
 * Rates: counters from the DO are cumulative ("events received since
 * boot"). To get "events per minute" we keep the previous sample's
 * counter + timestamp in a ref and divide the delta — same trick a
 * pidstat-style tool uses.
 */

import { useEffect, useRef, useState } from 'react'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { type Stream } from '@/lib/db'
import { useApiQuery } from '@/lib/useApiQuery'

const POLL_INTERVAL_MS = 10_000
/** How many samples to keep per stream for the sparkline. 60 × 10s = 10 min. */
const HISTORY_DEPTH = 60

export interface StreamHealthSample {
  /** Unix ms at the moment the sample was taken. */
  ts: number
  /** Events / minute observed since the previous sample. */
  eventsPerMin: number
  /** Fanouts / minute (events × subscribers). */
  fanoutsPerMin: number
  /** Errors / minute. */
  errorsPerMin: number
}

export interface StreamHealth {
  /** Last raw stats payload from the Worker. */
  lastStats: WorkerStats | null
  /** True when the most recent fetch succeeded. */
  ok: boolean
  /** Latest derived rates (the tip of `history`). */
  current: StreamHealthSample | null
  /** Sample history (oldest → newest), capped at HISTORY_DEPTH. */
  history: StreamHealthSample[]
  /** Error message from the last failed poll, if any. */
  error?: string
  /** Health status — purely a function of `current` + `lastStats`. */
  status: 'live' | 'idle' | 'down' | 'unknown'
}

interface WorkerStats {
  eventsReceived: number
  fanoutTotal: number
  errors: number
  lastPublishedAt: number | null
  lastSubscriberAt: number | null
  currentSubscribers: number
  snapshotSize: number
  /** Phase 7b — number of rows the Worker still has in its replay buffer. */
  eventLogSize?: number
}

interface PrevSample {
  ts: number
  events: number
  fanouts: number
  errors: number
}

/**
 * Hook that maintains a live map of per-stream health. Reads streams
 * + connections from Dexie, builds a stats URL for each, and polls.
 *
 * Returns a Map keyed by `streamId`. Missing entries mean the stream
 * either isn't a live stream or hasn't been polled yet.
 */
export function useLiveStreamHealth(): Map<number, StreamHealth> {
  const tenantId = useCurrentTenantId()
  const streamsQuery = useApiQuery(
    () => apiDb.streams.toArray(),
    ['streams', tenantId],
    { intervalMs: 10000 },
  )
  const connectionsQuery = useApiQuery(
    () => apiDb.connections.toArray(),
    ['connections', tenantId],
    { intervalMs: 10000 },
  )
  const streams = streamsQuery.data ?? []
  const connections = connectionsQuery.data ?? []
  const connectionsById = new Map<number, ReturnType<typeof toConn>>()
  for (const c of connections) {
    if (c.id !== undefined) connectionsById.set(c.id, toConn(c))
  }

  const [health, setHealth] = useState<Map<number, StreamHealth>>(new Map())
  const prevRef = useRef<Map<number, PrevSample>>(new Map())

  useEffect(() => {
    let cancelled = false
    const liveStreams = streams.filter((s) => isLiveStream(s) && s.id !== undefined)

    const pollOnce = async () => {
      if (cancelled) return
      const next = new Map<number, StreamHealth>(health)
      for (const stream of liveStreams) {
        const streamId = stream.id!
        const url = statsUrl(stream)
        const apiKey = connectionsById.get(stream.connectionId ?? -1)?.apiKey
        if (!url || !apiKey) {
          next.set(streamId, downHealth(`missing url/apiKey on stream ${stream.name}`))
          continue
        }
        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: { 'X-Api-Key': apiKey },
          })
          if (!res.ok) {
            next.set(streamId, downHealth(`HTTP ${res.status} ${res.statusText}`))
            continue
          }
          const stats = (await res.json()) as WorkerStats
          const sample = sampleFromStats(streamId, stats, prevRef.current)
          const existing = next.get(streamId)
          const historyBase = existing?.history ?? []
          const history = sample ? trimHistory([...historyBase, sample]) : historyBase
          next.set(streamId, {
            lastStats: stats,
            ok: true,
            current: sample,
            history,
            status: deriveStatus(stats, sample),
          })
        } catch (err) {
          next.set(streamId, downHealth((err as Error).message))
        }
      }
      // Drop entries whose stream went away.
      const wantedIds = new Set(liveStreams.map((s) => s.id!))
      for (const id of next.keys()) {
        if (!wantedIds.has(id)) next.delete(id)
      }
      if (!cancelled) setHealth(next)
    }

    void pollOnce()
    const timer = window.setInterval(() => {
      void pollOnce()
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams.length, connectionsById.size])

  return health
}

// ============================================================ helpers

interface ConnView {
  apiKey?: string
  url?: string
}

function toConn(conn: { auth: { mode: string; value?: string; token?: string }; config?: unknown }): ConnView {
  let apiKey: string | undefined
  if (conn.auth.mode === 'apiKey') apiKey = conn.auth.value
  else if (conn.auth.mode === 'bearer') apiKey = conn.auth.token
  const cfg = (conn.config ?? {}) as { url?: unknown; baseUrl?: unknown }
  const url =
    (typeof cfg.url === 'string' && cfg.url) ||
    (typeof cfg.baseUrl === 'string' && cfg.baseUrl) ||
    undefined
  return { apiKey, url }
}

function isLiveStream(s: Stream): boolean {
  const ep = (s.endpoint ?? {}) as { transport?: unknown }
  return ep.transport === 'ws'
}

/**
 * Derive the stats URL from the stream's endpoint config. Mirrors the
 * pattern in `live-stream-client.ts` — the WS URL ends in `/ws`; the
 * stats URL replaces that with `/stats`.
 */
function statsUrl(stream: Stream): string | null {
  const ep = stream.endpoint as { url?: unknown; sourceToken?: unknown }
  if (typeof ep.url === 'string' && ep.url.length > 0) {
    return ep.url.replace(/\/ws(\?.*)?$/, '/stats')
  }
  return null
}

function sampleFromStats(
  streamId: number,
  stats: WorkerStats,
  prevMap: Map<number, PrevSample>,
): StreamHealthSample | null {
  const now = Date.now()
  const prev = prevMap.get(streamId)
  prevMap.set(streamId, {
    ts: now,
    events: stats.eventsReceived,
    fanouts: stats.fanoutTotal,
    errors: stats.errors,
  })
  if (!prev) return null
  const dtSec = Math.max(0.001, (now - prev.ts) / 1000)
  const perMin = (delta: number) => Math.max(0, (delta / dtSec) * 60)
  return {
    ts: now,
    eventsPerMin: perMin(stats.eventsReceived - prev.events),
    fanoutsPerMin: perMin(stats.fanoutTotal - prev.fanouts),
    errorsPerMin: perMin(stats.errors - prev.errors),
  }
}

function trimHistory(samples: StreamHealthSample[]): StreamHealthSample[] {
  return samples.length > HISTORY_DEPTH
    ? samples.slice(samples.length - HISTORY_DEPTH)
    : samples
}

function downHealth(message: string): StreamHealth {
  return {
    lastStats: null,
    ok: false,
    current: null,
    history: [],
    error: message,
    status: 'down',
  }
}

function deriveStatus(
  stats: WorkerStats | null,
  current: StreamHealthSample | null,
): StreamHealth['status'] {
  if (!stats) return 'unknown'
  // Live if anything has happened in the last 30s.
  const now = Date.now()
  const recentPublish =
    stats.lastPublishedAt !== null && now - stats.lastPublishedAt < 30_000
  const recentEvents = current !== null && current.eventsPerMin > 0
  if (recentPublish || recentEvents) return 'live'
  // Anything ever published?
  if (stats.eventsReceived > 0) return 'idle'
  return 'unknown'
}
