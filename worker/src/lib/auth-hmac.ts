/**
 * HMAC-SHA256 signature verification for webhook delivery.
 *
 * Wire format on the header (Stripe/Slack-style):
 *   X-Webhook-Signature: t=<unix>,v1=<hex-hmac>
 *
 * `t` is the Unix timestamp at sign-time, hex-encoded HMAC is computed over
 * `${t}.${rawBody}`. We reject when `|now - t| > 300s` to mitigate replay,
 * and use `crypto.subtle.verify` so the comparison is timing-attack safe.
 *
 * Per-source CryptoKeys are cached in module scope so the import cost is
 * paid once per (isolate, sourceToken). Cache key is the secret string —
 * rotating the secret invalidates the cache entry naturally.
 */

const MAX_SKEW_SECONDS = 300

const keyCache = new Map<string, Promise<CryptoKey>>()

function getKey(secret: string): Promise<CryptoKey> {
  let existing = keyCache.get(secret)
  if (existing) return existing
  existing = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  keyCache.set(secret, existing)
  return existing
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

interface ParsedHeader {
  t: number
  v1: string
}

function parseHeader(value: string | null): ParsedHeader | null {
  if (!value) return null
  let t = NaN
  let v1: string | undefined
  for (const part of value.split(',')) {
    const [k, raw] = part.split('=')
    if (!k || raw === undefined) continue
    const key = k.trim()
    const val = raw.trim()
    if (key === 't') t = Number.parseInt(val, 10)
    else if (key === 'v1') v1 = val
  }
  if (!Number.isFinite(t) || !v1) return null
  return { t, v1 }
}

export type HmacVerifyResult =
  | { ok: true }
  | { ok: false; status: 400 | 401; reason: string }

/**
 * Verify a webhook request.
 *
 * IMPORTANT: pass in the raw request body bytes captured BEFORE any
 * `.json()/.text()` call — the request stream is single-use.
 */
export async function verifyWebhookSignature(
  request: Request,
  rawBody: ArrayBuffer,
  secret: string,
): Promise<HmacVerifyResult> {
  const parsed = parseHeader(request.headers.get('X-Webhook-Signature'))
  if (!parsed) {
    return { ok: false, status: 400, reason: 'missing or malformed X-Webhook-Signature' }
  }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parsed.t) > MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, reason: 'timestamp skew exceeds 300s' }
  }
  const sigBytes = hexToBytes(parsed.v1)
  if (!sigBytes) {
    return { ok: false, status: 400, reason: 'v1 is not valid hex' }
  }
  const bodyText = new TextDecoder().decode(rawBody)
  const signedInput = new TextEncoder().encode(`${parsed.t}.${bodyText}`)
  const key = await getKey(secret)
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, signedInput)
  if (!ok) return { ok: false, status: 401, reason: 'bad signature' }
  return { ok: true }
}
