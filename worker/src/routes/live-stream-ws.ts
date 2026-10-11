/**
 * GET /streams/:streamToken/ws
 *
 * Upgrades the HTTP request to a WebSocket inside the matching
 * `LiveStream` Durable Object. The DO replays the current snapshot to
 * the new subscriber immediately so the SPA's map is populated within
 * one round-trip of connect.
 *
 * Auth: `apiKey` query parameter (browser-issued WebSocket handshakes
 * can't carry custom headers). Verified against the same global
 * `API_KEY` that gates webhook drains.
 *
 * The actual `WebSocketPair` is constructed inside the DO's `fetch`
 * (see `LiveStream.fetch`), because `acceptWebSocket` requires the
 * server-half to be owned by the same instance that's adopting it.
 * We forward the upgrade request via `stub.fetch(request)` and let
 * Cloudflare wire the client-half back to the browser.
 */

import type { Env } from '../env'
import { errorResponse } from '../lib/json'

export async function handleLiveStreamWs(
  request: Request,
  env: Env,
  streamToken: string,
): Promise<Response> {
  if (!isValidToken(streamToken)) {
    return errorResponse(request, env, 400, 'invalid streamToken')
  }
  const upgrade = request.headers.get('Upgrade')
  if (upgrade?.toLowerCase() !== 'websocket') {
    return errorResponse(request, env, 426, 'expected Upgrade: websocket')
  }
  const url = new URL(request.url)
  const apiKey = url.searchParams.get('apiKey')
  if (!apiKey || apiKey !== env.API_KEY) {
    return errorResponse(request, env, 401, 'unauthorized — ?apiKey= required')
  }
  const id = env.LIVE_STREAM.idFromName(streamToken)
  const stub = env.LIVE_STREAM.get(id)
  // Forward the upgrade to the DO so it can construct the WebSocketPair
  // and call `acceptWebSocket` on the server half.
  return stub.fetch(request)
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token)
}
