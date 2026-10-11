/**
 * POST /streams/:streamToken/publish
 *
 * Body: a position event or a `{ type:'batch', events:[…] }` envelope.
 * Headers: `X-Webhook-Signature: t=<unix>,v1=<hex-hmac>` (same wire
 *          format as the webhook receive route — let publishers reuse
 *          their existing signer).
 * Response: { ok: true, fanoutCount, snapshotCount }
 *
 * Verifies the HMAC against the per-stream secret stored on the
 * `LiveStream` DO, then asks the DO to fan the payload out to every
 * connected WebSocket subscriber.
 *
 * Per-stream secrets are cached at module scope (60s TTL) so the hot
 * path skips a DO round-trip on bursty publish.
 */

import { verifyWebhookSignature } from '../lib/auth-hmac'
import type { Env } from '../env'
import { errorResponse, json } from '../lib/json'

const MAX_PAYLOAD_BYTES = 256 * 1024
const SECRET_CACHE_TTL_MS = 60_000

interface SecretCacheEntry {
  secret: string | null
  fetchedAt: number
}

const secretCache = new Map<string, SecretCacheEntry>()

export function invalidateLiveStreamSecretCache(streamToken: string): void {
  secretCache.delete(streamToken)
}

async function loadSecret(env: Env, streamToken: string): Promise<string | null> {
  const cached = secretCache.get(streamToken)
  if (cached && Date.now() - cached.fetchedAt < SECRET_CACHE_TTL_MS) {
    return cached.secret
  }
  const id = env.LIVE_STREAM.idFromName(streamToken)
  const stub = env.LIVE_STREAM.get(id)
  const secret = await stub.getSecret()
  secretCache.set(streamToken, { secret, fetchedAt: Date.now() })
  return secret
}

export async function handleLiveStreamPublish(
  request: Request,
  env: Env,
  streamToken: string,
): Promise<Response> {
  if (!isValidToken(streamToken)) {
    return errorResponse(request, env, 400, 'invalid streamToken')
  }
  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
    return errorResponse(request, env, 413, `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`)
  }
  const secret = await loadSecret(env, streamToken)
  if (!secret) {
    return errorResponse(request, env, 404, 'stream not registered — POST /register first')
  }
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
  const id = env.LIVE_STREAM.idFromName(streamToken)
  const stub = env.LIVE_STREAM.get(id)
  const text = new TextDecoder().decode(rawBody)
  try {
    const result = await stub.publish(text)
    return json(request, env, {
      ok: true,
      fanoutCount: result.fanoutCount,
      snapshotCount: result.snapshotCount,
    })
  } catch (err) {
    return errorResponse(
      request,
      env,
      400,
      (err as Error).message || 'publish failed',
    )
  }
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token)
}
