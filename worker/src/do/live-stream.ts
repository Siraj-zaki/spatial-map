/**
 * LiveStream — one instance per `streamToken`. Phase 1 of the data
 * plane reshape.
 *
 * Where `WebhookQueue` *buffers* events for a polled drain, `LiveStream`
 * *fans out* events to currently-connected WebSocket subscribers. Both
 * coexist; the SPA picks the model based on `Stream.binding.kind`.
 *
 * Responsibilities:
 *
 *   - Store the per-stream HMAC secret (in SQLite, sticky).
 *   - Hold the snapshot of "last position per assetId" so a freshly
 *     opened subscriber sees the current map instantly (no waiting
 *     for the next publish).
 *   - Accept WebSocket subscribers via the Cloudflare hibernation API
 *     (`ctx.acceptWebSocket`) so the DO can sleep between events
 *     without dropping the connection.
 *   - On `publish(payload)`, persist the new positions and broadcast
 *     the message to every connected subscriber.
 *
 * Uses the Hibernation API (`acceptWebSocket` / `webSocketMessage` /
 * `webSocketClose`) so the DO can hibernate between bursts and we
 * don't pay for idle CPU on a quiet warehouse. See:
 * https://developers.cloudflare.com/durable-objects/api/websockets/
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'

type MetaRow = Record<string, SqlStorageValue> & {
  k: string
  v: string
}

type SnapshotRow = Record<string, SqlStorageValue> & {
  asset_id: string
  payload: string
  updated_at: number
}

type CountRow = Record<string, SqlStorageValue> & { c: number }

type EventLogRow = Record<string, SqlStorageValue> & {
  ts: number
  payload: string
}

type TsRow = Record<string, SqlStorageValue> & { ts: number | null }

export interface LiveStreamPublishResult {
  /** Number of subscribers that received the broadcast. */
  fanoutCount: number
  /** Number of distinct positions snapshotted. */
  snapshotCount: number
}

/**
 * Phase 7 — operational health rollup. Lifetime counters + freshness
 * timestamps. Tiny and cheap to query — the SPA polls this every 10s
 * from the Integrations Health tab.
 */
export interface LiveStreamStats {
  /** Lifetime events received via `publish`. */
  eventsReceived: number
  /** Lifetime fanouts (events × subscribers at time of publish). */
  fanoutTotal: number
  /** Lifetime publish errors (malformed JSON, send failures). */
  errors: number
  /** Most-recent successful publish, epoch ms. Null when never published. */
  lastPublishedAt: number | null
  /** Most recent subscriber connection, epoch ms. */
  lastSubscriberAt: number | null
  /** Current subscriber count (from ctx.getWebSockets() length). */
  currentSubscribers: number
  /** Current snapshot row count (distinct assetIds tracked). */
  snapshotSize: number
  /** Current event-log row count (replay buffer). */
  eventLogSize: number
}

/**
 * Phase 7b — historical event row returned by `getEvents`. The
 * payload string is exactly what the publisher posted; the SPA's
 * replay service feeds it back through the same `coerce*` →
 * `apply*Batch` path the live channel uses.
 */
export interface LiveStreamHistoricalEvent {
  ts: number
  payload: string
}

export interface LiveStreamHistoricalRange {
  events: LiveStreamHistoricalEvent[]
  /** Earliest event in the log (helps the UI bound the time picker). */
  oldestTs: number | null
  /** Most recent event. */
  newestTs: number | null
}

/**
 * Snapshot cap. Even a busy site has < 10k distinct assets — once we
 * cross that we LRU the oldest. Plenty for a warehouse; the WMS
 * ingest layer should aggregate before forwarding fleet-scale (>100k)
 * data.
 */
const MAX_SNAPSHOT_ASSETS = 10_000
// Phase 7b — replay log. Hard cap on rows + age. A busy stream
// publishing 5 events/sec hits ~432k rows/day; 50k keeps the SQLite
// page footprint modest while still covering the typical "what
// happened over the last few hours" case.
const MAX_EVENT_LOG_ROWS = 50_000
const MAX_EVENT_LOG_AGE_MS = 24 * 60 * 60 * 1000

export class LiveStream extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.sql = state.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot (
        asset_id   TEXT PRIMARY KEY,
        payload    TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshot_updated ON snapshot(updated_at);
      CREATE TABLE IF NOT EXISTS event_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        payload     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log(ts);
    `)
    // Phase 7b — daily retention sweep keeps the event_log bounded.
    void this.ensureRetentionAlarm()
  }

  // ========================================================== alarm

  /**
   * Daily prune of the event log. Age-based delete first (cheap range
   * scan via `idx_event_log_ts`), then a hard row cap as a belt-and-
   * braces measure against bursty publishers.
   */
  async alarm(): Promise<void> {
    const ageCutoff = Date.now() - MAX_EVENT_LOG_AGE_MS
    this.sql.exec(`DELETE FROM event_log WHERE ts < ?`, ageCutoff)
    const count = this.sql
      .exec<CountRow>(`SELECT COUNT(*) AS c FROM event_log`)
      .toArray()
    const total = count[0]?.c ?? 0
    if (total > MAX_EVENT_LOG_ROWS) {
      const excess = total - MAX_EVENT_LOG_ROWS
      this.sql.exec(
        `DELETE FROM event_log WHERE id IN (
           SELECT id FROM event_log ORDER BY id ASC LIMIT ?
         )`,
        excess,
      )
    }
    await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000)
  }

  private async ensureRetentionAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000)
    }
  }

  // ====================================================== registration

  /** Same shape as `WebhookQueue.register` — idempotent secret rotation. */
  async register(secret: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO meta(k, v) VALUES('secret', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      secret,
    )
    this.sql.exec(
      `INSERT INTO meta(k, v) VALUES('created_at', ?)
       ON CONFLICT(k) DO NOTHING`,
      String(Date.now()),
    )
  }

  async getSecret(): Promise<string | null> {
    const rows = this.sql.exec<MetaRow>(`SELECT k, v FROM meta WHERE k = 'secret'`).toArray()
    return rows.length === 0 ? null : rows[0].v
  }

  // ========================================================= subscribe

  /**
   * WebSocket upgrade handler. The `/streams/:t/ws` route forwards the
   * upgrade request here via `stub.fetch(request)` so we own the
   * `WebSocketPair` and can call `acceptWebSocket` on the server half
   * before it's attached to the runtime. This is the supported pattern
   * for the hibernation API.
   *
   * Auth was already enforced upstream — if the request reaches this
   * fetch handler the apiKey check has passed.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    // Phase 7: stamp subscribe-time for the health dashboard.
    this.sql.exec(
      `INSERT INTO meta(k, v) VALUES('last_subscriber_at', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      String(Date.now()),
    )
    // Replay the snapshot so the subscriber sees current state instantly.
    const rows = this.sql
      .exec<SnapshotRow>(`SELECT asset_id, payload, updated_at FROM snapshot`)
      .toArray()
    if (rows.length > 0) {
      const events: unknown[] = []
      for (const r of rows) {
        try {
          events.push(JSON.parse(r.payload))
        } catch {
          /* drop malformed snapshot rows silently */
        }
      }
      try {
        server.send(JSON.stringify({ type: 'batch', events }))
      } catch {
        /* socket already closed — fanout loop handles cleanup */
      }
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  // =========================================================== publish

  /**
   * Receive a fully-verified JSON payload from a publisher and fan it
   * out to every connected subscriber. The payload may be a single
   * position event or a `{ type:'batch', events:[…] }` envelope —
   * mirrors the SPA's `coerceMessage`.
   *
   * Returns the per-call fanout count so the publish route can log
   * "fan out to N subscribers" in the response.
   */
  async publish(payloadText: string): Promise<LiveStreamPublishResult> {
    let parsed: unknown
    try {
      parsed = JSON.parse(payloadText)
    } catch {
      // Malformed JSON — refuse to broadcast garbage. The publish
      // route's caller already ran HMAC verification so this is a
      // bug in the publisher, surfaced as a 400 upstream. Bump the
      // error counter so the health tab can flag a noisy publisher.
      this.bumpMeta('errors_total', 1)
      throw new Error('payload is not valid JSON')
    }
    const events = flattenEvents(parsed)
    let snapshotCount = 0
    for (const ev of events) {
      const assetId = pickAssetId(ev)
      if (!assetId) continue
      this.sql.exec(
        `INSERT INTO snapshot(asset_id, payload, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        assetId,
        JSON.stringify(ev),
        Date.now(),
      )
      snapshotCount++
    }
    // LRU-cap the snapshot table.
    if (snapshotCount > 0) {
      const count = this.sql.exec<CountRow>(`SELECT COUNT(*) AS c FROM snapshot`).toArray()
      const total = count[0]?.c ?? 0
      if (total > MAX_SNAPSHOT_ASSETS) {
        const excess = total - MAX_SNAPSHOT_ASSETS
        this.sql.exec(
          `DELETE FROM snapshot WHERE asset_id IN (
             SELECT asset_id FROM snapshot ORDER BY updated_at ASC LIMIT ?
           )`,
          excess,
        )
      }
    }
    const subscribers = this.ctx.getWebSockets()
    for (const ws of subscribers) {
      try {
        ws.send(payloadText)
      } catch {
        // Socket died between selection and send. The hibernation API
        // surfaces this via `webSocketClose`; nothing to do here.
      }
    }
    // Phase 7 — bump the running counters. Each publish counts as one
    // event (the wrapper) regardless of batch size, plus we add the
    // fanout total so we can compute "fanouts per minute" downstream.
    this.bumpMeta('events_received', 1)
    if (subscribers.length > 0) this.bumpMeta('fanout_total', subscribers.length)
    const now = Date.now()
    this.sql.exec(
      `INSERT INTO meta(k, v) VALUES('last_published_at', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      String(now),
    )
    // Phase 7b — append to the replay buffer. The full payload text
    // is stored verbatim so the SPA can re-feed it through the same
    // coercer the live channel uses. Pruning is alarm-driven; the
    // hot path stays one INSERT.
    this.sql.exec(`INSERT INTO event_log(ts, payload) VALUES(?, ?)`, now, payloadText)
    return { fanoutCount: subscribers.length, snapshotCount }
  }

  /**
   * Phase 7b — return historical events in the half-open range
   * `[fromMs, toMs)`. The SPA's replay service slices this at
   * different speeds via `setTimeout`.
   *
   * `limit` clamps the return size so a curious operator can't pull
   * 50k events into the browser in one shot.
   */
  async getEvents(
    fromMs: number,
    toMs: number,
    limit: number,
  ): Promise<LiveStreamHistoricalRange> {
    const cappedLimit = Math.max(1, Math.min(limit, 5000))
    const rows = this.sql
      .exec<EventLogRow>(
        `SELECT ts, payload FROM event_log
         WHERE ts >= ? AND ts < ?
         ORDER BY ts ASC
         LIMIT ?`,
        fromMs,
        toMs,
        cappedLimit,
      )
      .toArray()
    const events: LiveStreamHistoricalEvent[] = rows.map((r) => ({
      ts: r.ts,
      payload: r.payload,
    }))
    const oldestRows = this.sql
      .exec<TsRow>(`SELECT MIN(ts) AS ts FROM event_log`)
      .toArray()
    const newestRows = this.sql
      .exec<TsRow>(`SELECT MAX(ts) AS ts FROM event_log`)
      .toArray()
    const oldestTs = oldestRows[0]?.ts ?? null
    const newestTs = newestRows[0]?.ts ?? null
    return { events, oldestTs, newestTs }
  }

  /**
   * Lifetime health rollup for the Integrations Health tab. Reads
   * counters straight out of the meta table — no expensive scan
   * required.
   */
  async getStats(): Promise<LiveStreamStats> {
    const events = this.readNumMeta('events_received')
    const fanouts = this.readNumMeta('fanout_total')
    const errors = this.readNumMeta('errors_total')
    const lastPub = this.readNumMeta('last_published_at')
    const lastSub = this.readNumMeta('last_subscriber_at')
    const snapshotRows = this.sql
      .exec<CountRow>(`SELECT COUNT(*) AS c FROM snapshot`)
      .toArray()
    const snapshotSize = snapshotRows[0]?.c ?? 0
    const eventLogRows = this.sql
      .exec<CountRow>(`SELECT COUNT(*) AS c FROM event_log`)
      .toArray()
    const eventLogSize = eventLogRows[0]?.c ?? 0
    return {
      eventsReceived: events ?? 0,
      fanoutTotal: fanouts ?? 0,
      errors: errors ?? 0,
      lastPublishedAt: lastPub === undefined ? null : lastPub,
      lastSubscriberAt: lastSub === undefined ? null : lastSub,
      currentSubscribers: this.ctx.getWebSockets().length,
      snapshotSize,
      eventLogSize,
    }
  }

  /** Atomic-ish counter bump via INSERT … ON CONFLICT. */
  private bumpMeta(key: string, delta: number): void {
    const rows = this.sql
      .exec<MetaRow>(`SELECT k, v FROM meta WHERE k = ?`, key)
      .toArray()
    const next = (rows.length === 0 ? 0 : Number.parseInt(rows[0].v, 10) || 0) + delta
    this.sql.exec(
      `INSERT INTO meta(k, v) VALUES(?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      key,
      String(next),
    )
  }

  private readNumMeta(key: string): number | undefined {
    const rows = this.sql
      .exec<MetaRow>(`SELECT k, v FROM meta WHERE k = ?`, key)
      .toArray()
    if (rows.length === 0) return undefined
    const n = Number.parseInt(rows[0].v, 10)
    return Number.isFinite(n) ? n : undefined
  }

  // ============================================== hibernation lifecycle

  // Subscribers are listen-only — incoming messages from the browser
  // are ignored (apart from the standard ping/pong the runtime handles
  // for us). Defining the handler is required by the hibernation API.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    /* no-op */
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Cloudflare hibernation already removes the socket from
    // `getWebSockets()` once it closes. Closing on our side just
    // ensures we release the underlying TCP socket promptly.
    try {
      ws.close(code, 'subscriber closed')
    } catch {
      /* already closed */
    }
  }

  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {
    /* logged at runtime; nothing actionable */
  }
}

// =================================================================== helpers

function flattenEvents(raw: unknown): unknown[] {
  if (raw === null || typeof raw !== 'object') return []
  const m = raw as Record<string, unknown>
  if (m.type === 'batch' && Array.isArray(m.events)) return m.events
  return [m]
}

function pickAssetId(ev: unknown): string | null {
  if (ev === null || typeof ev !== 'object') return null
  const m = ev as Record<string, unknown>
  if (typeof m.assetId === 'string' && m.assetId.length > 0) return m.assetId
  return null
}
