/**
 * POST /webhooks/:sourceToken
 *
 * Validates the X-Webhook-Signature HMAC and enqueues the raw body for
 * later draining. No auth header from the SPA — the signature IS the
 * auth.
 *
 * Body size cap is enforced upstream via Content-Length: anything over
 * 64 KiB returns 413 before we touch the body.
 *
 * Per-source secrets are cached at module scope with a 60s TTL so the
 * hot path skips a DO round-trip on repeated deliveries from the same
 * source.
 */

import { verifyWebhookSignature } from '../lib/auth-hmac'
import type { Env } from '../env'
import { errorResponse, json } from '../lib/json'

const MAX_PAYLOAD_BYTES = 64 * 1024
const SECRET_CACHE_TTL_MS = 60_000

interface SecretCacheEntry {
  secret: string | null
  fetchedAt: number
}

const secretCache = new Map<string, SecretCacheEntry>()

export function invalidateSecretCache(sourceToken: string): void {
  secretCache.delete(sourceToken)
}

async function loadSecret(env: Env, sourceToken: string): Promise<string | null> {
  const cached = secretCache.get(sourceToken)
  if (cached && Date.now() - cached.fetchedAt < SECRET_CACHE_TTL_MS) {
    return cached.secret
  }
  const id = env.WEBHOOK_QUEUE.idFromName(sourceToken)
  const stub = env.WEBHOOK_QUEUE.get(id)
  const secret = await stub.getSecret()
  secretCache.set(sourceToken, { secret, fetchedAt: Date.now() })
  return secret
}

export async function handleWebhookReceive(
  request: Request,
  env: Env,
  sourceToken: string,
): Promise<Response> {
  if (!isValidToken(sourceToken)) {
    return errorResponse(request, env, 400, 'invalid sourceToken')
  }
  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
    return errorResponse(request, env, 413, `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`)
  }
  const secret = await loadSecret(env, sourceToken)
  if (!secret) {
    return errorResponse(request, env, 404, 'source not registered — POST /register first')
  }
  // Read raw bytes FIRST so we can verify and still re-parse if needed.
  let rawBody: ArrayBuffer
  try {
    rawBody = await request.arrayBuffer()
  } catch {
    return errorResponse(request, env, 400, 'could not read request body')
  }
  if (rawBody.byteLength > MAX_PAYLOAD_BYTES) {
    return errorResponse(request, env, 413, `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`)
  }
  const verified = await verifyWebhookSignature(request, rawBody, secret)
  if (!verified.ok) {
    return errorResponse(request, env, verified.status, verified.reason)
  }
  const id = env.WEBHOOK_QUEUE.idFromName(sourceToken)
  const stub = env.WEBHOOK_QUEUE.get(id)
  const text = new TextDecoder().decode(rawBody)
  const result = await stub.enqueue(text)
  return json(request, env, {
    received: true,
    queueDepth: result.queueDepth,
    droppedOldest: result.droppedOldest,
  })
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token)
}
