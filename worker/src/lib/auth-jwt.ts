/**
 * Minimal HS256 JWT for the test backend.
 *
 * Issue + verify both live here so the two routes share parsing/encoding.
 * Claims are intentionally tiny: `{ iss, sub, iat, exp }`. No `aud`, no
 * key id, no JWKS rotation — out of scope for a testing surface.
 *
 * The CryptoKey is cached in module scope so we only pay the importKey
 * cost once per isolate (cold start).
 */

const ISSUER = 'spatial-grid-vis-test'
const MAX_TTL_SECONDS = 24 * 60 * 60

let keyCache: { secret: string; promise: Promise<CryptoKey> } | null = null

function getKey(secret: string): Promise<CryptoKey> {
  if (keyCache && keyCache.secret === secret) return keyCache.promise
  const promise = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  keyCache = { secret, promise }
  return promise
}

function base64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function base64urlDecode(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4
  const b64 = (s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface JwtClaims {
  iss: string
  sub: string
  iat: number
  exp: number
}

export interface IssueOptions {
  /** Token TTL in seconds. Defaults to 1 h; hard-capped at 24 h. */
  ttlSeconds?: number
  /** Free-form `sub` claim. Defaults to "test-user". */
  subject?: string
}

export async function issueJwt(secret: string, opts: IssueOptions = {}): Promise<{
  token: string
  expiresAt: number
}> {
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.max(1, Math.min(opts.ttlSeconds ?? 3600, MAX_TTL_SECONDS))
  const claims: JwtClaims = {
    iss: ISSUER,
    sub: opts.subject ?? 'test-user',
    iat: now,
    exp: now + ttl,
  }
  const header = { alg: 'HS256', typ: 'JWT' }
  const enc = new TextEncoder()
  const headerB64 = base64urlEncode(enc.encode(JSON.stringify(header)))
  const payloadB64 = base64urlEncode(enc.encode(JSON.stringify(claims)))
  const signingInput = `${headerB64}.${payloadB64}`
  const key = await getKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput))
  return {
    token: `${signingInput}.${base64urlEncode(sig)}`,
    expiresAt: claims.exp,
  }
}

export type VerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: string }

export async function verifyJwt(token: string, secret: string): Promise<VerifyResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' }
  const [headerB64, payloadB64, sigB64] = parts
  const enc = new TextEncoder()
  let claims: JwtClaims
  try {
    const headerJson = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64))) as {
      alg?: string
    }
    if (headerJson.alg !== 'HS256') return { ok: false, reason: 'unsupported alg' }
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64))) as JwtClaims
  } catch {
    return { ok: false, reason: 'malformed token' }
  }
  const key = await getKey(secret)
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64urlDecode(sigB64),
    enc.encode(`${headerB64}.${payloadB64}`),
  )
  if (!valid) return { ok: false, reason: 'bad signature' }
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    return { ok: false, reason: 'expired' }
  }
  if (claims.iss !== ISSUER) return { ok: false, reason: 'bad issuer' }
  return { ok: true, claims }
}

/**
 * Extract a bearer token from `Authorization: Bearer <jwt>` and verify it.
 * Returns null when the header is missing or the token fails verification.
 */
export async function verifyBearer(
  request: Request,
  secret: string,
): Promise<JwtClaims | null> {
  const header = request.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  if (!token) return null
  const result = await verifyJwt(token, secret)
  return result.ok ? result.claims : null
}
