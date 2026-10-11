/**
 * Worker entry point. Routes requests + handles CORS preflight.
 *
 * Route table:
 *   GET    /healthz                          → 200 ok
 *   GET    /api/v1/test/bins                 → canned bins (apiKey | bearer)
 *   POST   /api/v1/auth/issue-jwt            → mint test JWT (apiKey)
 *   POST   /webhooks/:sourceToken/register   → store HMAC secret (apiKey)
 *   POST   /webhooks/:sourceToken            → receive signed event (HMAC)
 *   GET    /webhooks/:sourceToken/drain      → drain queue (apiKey)
 *   POST   /streams/:streamToken/register    → store HMAC secret (apiKey)   [Phase 1]
 *   POST   /streams/:streamToken/publish     → signed event, fan out to WS  [Phase 1]
 *   GET    /streams/:streamToken/ws          → WS subscriber upgrade        [Phase 1]
 *   OPTIONS *                                → preflight
 *
 * Both Durable Object classes are re-exported so the runtime can find
 * them via the bindings declared in wrangler.jsonc.
 */

import type { Env } from './env'
import { handlePreflight } from './lib/cors'
import { errorResponse, text } from './lib/json'
import { handleIssueJwt } from './routes/issue-jwt'
import { handleTestBins } from './routes/test-bins'
import { handleWebhookDrain } from './routes/webhook-drain'
import { handleWebhookReceive } from './routes/webhook-receive'
import { handleWebhookRegister } from './routes/webhook-register'
import { handleLiveStreamRegister } from './routes/live-stream-register'
import { handleLiveStreamPublish } from './routes/live-stream-publish'
import { handleLiveStreamWs } from './routes/live-stream-ws'
import { handleLiveStreamStats } from './routes/live-stream-stats'
import { handleLiveStreamEvents } from './routes/live-stream-events'
import { handleLiveStreamOutboundProxy } from './routes/live-stream-outbound-proxy'

export { WebhookQueue } from './do/webhook-queue'
export { LiveStream } from './do/live-stream'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const preflight = handlePreflight(request, env)
    if (preflight) return preflight

    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    if (method === 'GET' && path === '/healthz') {
      return text(request, env, 'ok')
    }
    if (method === 'GET' && path === '/api/v1/test/bins') {
      return handleTestBins(request, env)
    }
    if (method === 'POST' && path === '/api/v1/auth/issue-jwt') {
      return handleIssueJwt(request, env)
    }

    // /webhooks/:sourceToken[/register|/drain]
    const webhookMatch = path.match(/^\/webhooks\/([^/]+)(\/register|\/drain)?$/)
    if (webhookMatch) {
      const sourceToken = decodeURIComponent(webhookMatch[1])
      const suffix = webhookMatch[2] ?? ''
      if (suffix === '/register' && method === 'POST') {
        return handleWebhookRegister(request, env, sourceToken)
      }
      if (suffix === '/drain' && method === 'GET') {
        return handleWebhookDrain(request, env, sourceToken)
      }
      if (suffix === '' && method === 'POST') {
        return handleWebhookReceive(request, env, sourceToken)
      }
      return errorResponse(request, env, 405, `method ${method} not allowed for ${path}`)
    }

    // /streams/:streamToken/(register|publish|ws|stats|events|proxy-outbound) — Phase 1 + 7 live data plane.
    const streamMatch = path.match(
      /^\/streams\/([^/]+)\/(register|publish|ws|stats|events|proxy-outbound)$/,
    )
    if (streamMatch) {
      const streamToken = decodeURIComponent(streamMatch[1])
      const suffix = streamMatch[2]
      if (suffix === 'register' && method === 'POST') {
        return handleLiveStreamRegister(request, env, streamToken)
      }
      if (suffix === 'publish' && method === 'POST') {
        return handleLiveStreamPublish(request, env, streamToken)
      }
      if (suffix === 'ws' && method === 'GET') {
        return handleLiveStreamWs(request, env, streamToken)
      }
      if (suffix === 'stats' && method === 'GET') {
        return handleLiveStreamStats(request, env, streamToken)
      }
      if (suffix === 'events' && method === 'GET') {
        return handleLiveStreamEvents(request, env, streamToken)
      }
      if (suffix === 'proxy-outbound' && method === 'POST') {
        return handleLiveStreamOutboundProxy(request, env, streamToken)
      }
      return errorResponse(request, env, 405, `method ${method} not allowed for ${path}`)
    }

    return errorResponse(request, env, 404, `route not found: ${method} ${path}`)
  },
} satisfies ExportedHandler<Env>
