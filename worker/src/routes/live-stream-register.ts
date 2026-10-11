/**
 * POST /streams/:streamToken/register
 *
 * Body: { secret: string }
 * Response: { ok: true, streamToken }
 *
 * Stores the per-stream HMAC secret on the `LiveStream` DO so subsequent
 * /streams/:t/publish POSTs can be verified. Idempotent — re-registering
 * rotates the secret (and invalidates the secret cache for that stream).
 *
 * Auth: X-Api-Key (the same global API_KEY the SPA uses for /drain).
 */

import { checkApiKey } from '../lib/auth-api-key'
import type { Env } from '../env'
import { errorResponse, json } from '../lib/json'
import { invalidateLiveStreamSecretCache } from './live-stream-publish'

interface Body {
  secret?: string
}

export async function handleLiveStreamRegister(
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
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return errorResponse(request, env, 400, 'malformed JSON body')
  }
  const secret = (body.secret ?? '').trim()
  if (secret.length < 16) {
    return errorResponse(request, env, 400, 'secret must be ≥16 characters')
  }
  const id = env.LIVE_STREAM.idFromName(streamToken)
  const stub = env.LIVE_STREAM.get(id)
  await stub.register(secret)
  invalidateLiveStreamSecretCache(streamToken)
  return json(request, env, { ok: true, streamToken })
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token)
}
