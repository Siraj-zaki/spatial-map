/**
 * WebhookQueue — one instance per `sourceToken`. Holds the per-source HMAC
 * secret and a FIFO buffer of incoming events that the SPA later drains.
 *
 * Extends `DurableObject` so the Worker can call `stub.register(...)` etc.
 * as plain promise-returning methods (Cloudflare DO RPC).
 *
 * Storage is SQLite via `state.storage.sql` (enabled by `new_sqlite_classes`
 * in wrangler.jsonc). Two tables:
 *
 *   meta(k, v)   — sticky strings: 'secret', 'created_at', 'last_received_at'
 *   events(id, received_at, payload, attempts)
 *
 * Caps:
 *   MAX_QUEUE     = 1000 rows  → drop-oldest on overflow (LRU)
 *   MAX_PAYLOAD   = 64 KiB     → rejected upstream (413) before enqueue
 *   MAX_AGE_MS    = 7 days     → daily alarm prunes anything older
 *
 * Drain is a two-step `SELECT … LIMIT ?; DELETE WHERE id <= last` issued
 * back-to-back. SQLite under DOs is single-threaded per instance, so the
 * pair behaves atomically — no concurrent enqueue can land between them.
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'

const MAX_QUEUE = 1000
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

type MetaRow = Record<string, SqlStorageValue> & {
  k: string
  v: string
}

type EventRow = Record<string, SqlStorageValue> & {
  id: number
  received_at: number
  payload: string
  attempts: number
}

type CountRow = Record<string, SqlStorageValue> & { c: number }

export interface EnqueueResult {
  queueDepth: number
  droppedOldest: boolean
}

/**
 * Raw shape returned from the DO. `payload` is the JSON-text the
 * sender POSTed; the route does the `JSON.parse` so the DO return type
 * stays Rpc-serializable (the RPC type system rejects `unknown` because
 * it admits non-serializable values like functions).
 */
export interface DrainEvent {
  id: number
  receivedAt: number
  payload: string
}

export interface DrainResult {
  events: DrainEvent[]
  remaining: number
}

export class WebhookQueue extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.sql = state.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at INTEGER NOT NULL,
        payload     TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
    `)
    void this.ensureAlarm()
  }

  async register(secret: string): Promise<void> {
    const now = String(Date.now())
    this.sql.exec(
      `INSERT INTO meta(k, v) VALUES('secret', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      secret,
    )
    this.sql.exec(
      `INSERT INTO meta(k, v) VALUES('created_at', ?)
       ON CONFLICT(k) DO NOTHING`,
      now,
    )
  }

  async getSecret(): Promise<string | null> {
    const rows = this.sql.exec<MetaRow>(`SELECT k, v FROM meta WHERE k = 'secret'`).toArray()
    return rows.length === 0 ? null : rows[0].v
  }

  async enqueue(payload: string): Promise<EnqueueResult> {
    const receivedAt = Date.now()
    this.sql.exec(
      `INSERT INTO events(received_at, payload) VALUES(?, ?)`,
      receivedAt,
      payload,
    )
    this.sql.exec(
      `INSERT INTO meta(k, v) VALUES('last_received_at', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      String(receivedAt),
    )
    const countRow = this.sql.exec<CountRow>(`SELECT COUNT(*) AS c FROM events`).toArray()
    let queueDepth = countRow[0]?.c ?? 0
    let droppedOldest = false
    if (queueDepth > MAX_QUEUE) {
      const excess = queueDepth - MAX_QUEUE
      this.sql.exec(
        `DELETE FROM events WHERE id IN (
           SELECT id FROM events ORDER BY id ASC LIMIT ?
         )`,
        excess,
      )
      droppedOldest = true
      queueDepth = MAX_QUEUE
    }
    return { queueDepth, droppedOldest }
  }

  async drain(max: number): Promise<DrainResult> {
    const limit = Math.max(1, Math.min(max, 500))
    const events: DrainEvent[] = []
    let lastId = 0
    const rows = this.sql
      .exec<EventRow>(
        `SELECT id, received_at, payload, attempts
         FROM events
         ORDER BY id ASC
         LIMIT ?`,
        limit,
      )
      .toArray()
    for (const r of rows) {
      events.push({ id: r.id, receivedAt: r.received_at, payload: r.payload })
      if (r.id > lastId) lastId = r.id
    }
    if (events.length > 0) {
      this.sql.exec(`DELETE FROM events WHERE id <= ?`, lastId)
    }
    const remainingRow = this.sql.exec<CountRow>(`SELECT COUNT(*) AS c FROM events`).toArray()
    return { events, remaining: remainingRow[0]?.c ?? 0 }
  }

  async lastReceivedAt(): Promise<number | null> {
    const rows = this.sql
      .exec<MetaRow>(`SELECT k, v FROM meta WHERE k = 'last_received_at'`)
      .toArray()
    if (rows.length === 0) return null
    const n = Number.parseInt(rows[0].v, 10)
    return Number.isFinite(n) ? n : null
  }

  async alarm(): Promise<void> {
    const cutoff = Date.now() - MAX_AGE_MS
    this.sql.exec(`DELETE FROM events WHERE received_at < ?`, cutoff)
    await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS)
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS)
    }
  }
}
