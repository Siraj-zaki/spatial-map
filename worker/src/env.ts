/**
 * Shared `Env` type. Generated bindings from wrangler.jsonc — the DO
 * namespace name + class names must stay in sync with the migrations
 * block.
 */

import type { WebhookQueue } from './do/webhook-queue'
import type { LiveStream } from './do/live-stream'

export interface Env {
  // vars
  ALLOWED_ORIGINS: string
  // secrets (set via `wrangler secret put`)
  API_KEY: string
  JWT_SECRET: string
  // DO namespaces
  WEBHOOK_QUEUE: DurableObjectNamespace<WebhookQueue>
  LIVE_STREAM: DurableObjectNamespace<LiveStream>
}
