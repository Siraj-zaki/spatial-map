/**
 * POST /webhooks/:sourceToken/register
 *
 * Body: { secret: string }
 * Response: { ok: true, sourceToken }
 *
 * Stores the per-source HMAC secret on the DO so subsequent /webhooks/:t
 * POSTs can be verified. Idempotent — re-registering rotates the secret
 * (and invalidates the Worker's CryptoKey cache for that source).
 *
 * Auth: X-Api-Key (the same global API_KEY the SPA uses for drain).
 */

import { checkApiKey } from '../lib/auth-api-key'
import type { Env } from '../env'
import { errorResponse, json } from '../lib/json'
import { invalidateSecretCache } from './webhook-receive'

interface Body {
  secret?: string
}

export async function handleWebhookRegister(
  request: Request,
  env: Env,
  sourceToken: string,
): Promise<Response> {
  if (!checkApiKey(request, env)) {
    return errorResponse(request, env, 401, 'unauthorized — X-Api-Key required')
  }
  if (!isValidToken(sourceToken)) {
    return errorResponse(request, env, 400, 'invalid sourceToken')
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
  const id = env.WEBHOOK_QUEUE.idFromName(sourceToken)
  const stub = env.WEBHOOK_QUEUE.get(id)
  await stub.register(secret)
  invalidateSecretCache(sourceToken)
  return json(request, env, { ok: true, sourceToken })
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token)
}
