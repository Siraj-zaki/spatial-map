/**
 * Webhook drain — SPA-side counterpart to the Go backend's
 * `GET /api/v1/webhooks/:token/drain` endpoint.
 *
 * The backend stores signed/unsigned events in a Postgres queue. The
 * scheduler polls this on a fixed interval; each call atomically dequeues
 * up to 500 events. We materialise the returned `payload` array into a
 * synthetic JSON `File` and hand it back to the existing `parseFile()`
 * dispatcher — `parseJsonFile()` auto-detects a top-level array, so the
 * downstream preview/commit pipeline runs without modification.
 *
 * Returns `null` when the queue was empty. The caller uses that to
 * distinguish a "quiet tick" from a real import (so the source's
 * `lastResult` doesn't churn between 'ok' and 'empty' on every poll).
 */

import { apiGet } from '@/lib/api-client'
import type { WebhookSourceConfig } from '@/lib/db'

const DRAIN_TIMEOUT_MS = 15_000
const DRAIN_MAX = 500

export class WebhookFetchError extends Error {}

interface DrainEvent {
  id: number
  receivedAt: number
  payload: unknown
}

interface DrainResponse {
  events?: DrainEvent[]
  remaining?: number
  lastReceivedAt?: number | null
  error?: string
}

export interface DrainSummary {
  /** Synthetic JSON file ready for `parseFile()`. */
  file: File
  /** Number of events flattened into the file. */
  eventCount: number
  /** Server-reported queue depth still waiting after the drain. */
  remaining: number
  /** Unix-ms timestamp of the most recent event the backend has seen, if any. */
  lastReceivedAt: number | null
}

/**
 * Drain the per-source webhook queue exactly once. Returns `null` when
 * the backend had no events to hand over.
 */
export async function drainWebhookSource(
  cfg: WebhookSourceConfig,
): Promise<DrainSummary | null> {
  if (!cfg.workerBaseUrl) throw new WebhookFetchError('webhook source missing workerBaseUrl')
  if (!cfg.sourceToken) throw new WebhookFetchError('webhook source missing sourceToken')

  const base = cfg.workerBaseUrl.replace(/\/+$/, '')
  const url = `${base}/api/v1/webhooks/${encodeURIComponent(cfg.sourceToken)}/drain?max=${DRAIN_MAX}`

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), DRAIN_TIMEOUT_MS)

  let body: DrainResponse
  try {
    body = await apiGet<DrainResponse>(url, { signal: controller.signal })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new WebhookFetchError(`Drain timed out after ${DRAIN_TIMEOUT_MS / 1000}s`)
    }
    throw new WebhookFetchError(
      `Could not reach ${base}. Check the backend is running and CORS allows your origin.`,
    )
  } finally {
    window.clearTimeout(timer)
  }

  const events = Array.isArray(body.events) ? body.events : []
  if (events.length === 0) return null

  // Each event's `payload` is whatever the sender POSTed. Flatten into a
  // top-level array so the JSON parser's auto-root detection picks it as
  // the row array.
  const flattened = events.map((e) => e.payload)
  const tokenSlice = cfg.sourceToken.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_')
  const file = new File(
    [JSON.stringify(flattened)],
    `webhook-${tokenSlice}-${Date.now()}.json`,
    { type: 'application/json' },
  )

  return {
    file,
    eventCount: events.length,
    remaining: typeof body.remaining === 'number' ? body.remaining : 0,
    lastReceivedAt: typeof body.lastReceivedAt === 'number' ? body.lastReceivedAt : null,
  }
}

/**
 * One-shot register helper used by the import wizard. Pings the backend's
 * `GET /api/v1/webhooks/:token` endpoint to verify the token exists. The
 * backend does not require HMAC pre-registration; the secret is only used
 * for optional sender-side signing.
 */
export async function registerWebhookSource(
  cfg: Pick<WebhookSourceConfig, 'workerBaseUrl' | 'sourceToken' | 'hmacSecret' | 'drainApiKey'>,
): Promise<void> {
  if (!cfg.workerBaseUrl) throw new WebhookFetchError('workerBaseUrl is required')
  if (!cfg.sourceToken) throw new WebhookFetchError('sourceToken is required')
  if (!cfg.hmacSecret) throw new WebhookFetchError('hmacSecret is required')
  // drainApiKey is only consulted when the backend enforces SGV_AUTH.API_KEY.
  // Dev backends leave it empty, so we don't block save here — the GET below
  // either succeeds (no enforcement) or returns 401 (enforcement on, key
  // missing/wrong), and the caller surfaces the failure.

  const base = cfg.workerBaseUrl.replace(/\/+$/, '')
  const url = `${base}/api/v1/webhooks/${encodeURIComponent(cfg.sourceToken)}`

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), DRAIN_TIMEOUT_MS)
  try {
    await apiGet<unknown>(url, { signal: controller.signal })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new WebhookFetchError(`Register timed out after ${DRAIN_TIMEOUT_MS / 1000}s`)
    }
    throw new WebhookFetchError(`Could not reach ${base}.`)
  } finally {
    window.clearTimeout(timer)
  }
}
