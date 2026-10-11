/**
 * GET /streams/:streamToken/events
 *
 * Query params (all optional):
 *   from   — start of the half-open window, epoch ms (default: now - 15 min)
 *   to     — end, exclusive, epoch ms (default: now)
 *   limit  — hard cap, ≤5000 (default: 2000)
 *
 * Returns:
 *   {
 *     events: [{ ts, payload }, ...],   // payload is the raw JSON text the publisher posted
 *     oldestTs: number | null,          // earliest event the DO still has
 *     newestTs: number | null           // newest event the DO has seen
 *   }
 *
 * Phase 7b — replay support. Auth: X-Api-Key (same model as /drain
 * and /stats).
 */

import { checkApiKey } from '../lib/auth-api-key'
import type { Env } from '../env'
import { errorResponse, json } from '../lib/json'

const DEFAULT_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_LIMIT = 2000

export async function handleLiveStreamEvents(
  request: Request,
  env: Env,
  streamToken: string,
): Promise<Response> {
  if (!checkApiKey(request, env)) {
    return errorResponse(request, env, 401, 'unauthorized — X-Api-Key required')
  }
  if (!isValidToken(streamToken)) {
    return errorResponse(request, env, 400, 'invalid streamToken')
  }

  const url = new URL(request.url)
  const now = Date.now()
  const from = parseTs(url.searchParams.get('from'), now - DEFAULT_WINDOW_MS)
  const to = parseTs(url.searchParams.get('to'), now)
  if (to <= from) {
    return errorResponse(request, env, 400, 'to must be > from')
  }
  const limit = parseLimit(url.searchParams.get('limit'), DEFAULT_LIMIT)

  const id = env.LIVE_STREAM.idFromName(streamToken)
  const stub = env.LIVE_STREAM.get(id)
  const result = await stub.getEvents(from, to, limit)
  return json(request, env, result)
}

function parseTs(raw: string | null, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

function parseLimit(raw: string | null, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(n, 5000))
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token)
}
