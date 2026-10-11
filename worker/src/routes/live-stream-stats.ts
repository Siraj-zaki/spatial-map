/**
 * GET /streams/:streamToken/stats
 *
 * Returns the lifetime health rollup for one stream: events received,
 * fanouts, errors, last-publish/last-subscriber timestamps, current
 * subscriber count, snapshot size.
 *
 * Auth: X-Api-Key (the same Worker `API_KEY` that gates `/drain`).
 *
 * Phase 7 — observability surface. Cheap to call: the DO reads
 * counters straight out of its meta table, no scan.
 */

import { checkApiKey } from '../lib/auth-api-key'
import type { Env } from '../env'
import { errorResponse, json } from '../lib/json'

export async function handleLiveStreamStats(
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
  const id = env.LIVE_STREAM.idFromName(streamToken)
  const stub = env.LIVE_STREAM.get(id)
  const stats = await stub.getStats()
  return json(request, env, stats)
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token)
}
