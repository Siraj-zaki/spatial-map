/**
 * CORS for the test backend.
 *
 * Allow-list is sourced from the ALLOWED_ORIGINS var (comma-separated). On
 * preflight we echo the Origin header back when it's allow-listed and 204
 * with a 24h Max-Age. On every successful response we re-stamp Allow-Origin
 * so the browser accepts the body.
 *
 * No Allow-Credentials — we authenticate via X-Api-Key / Authorization /
 * X-Webhook-Signature headers, not cookies.
 */

const ALLOWED_HEADERS = 'Content-Type, X-Api-Key, Authorization, X-Webhook-Signature'
const ALLOWED_METHODS = 'GET, POST, OPTIONS'

function parseAllowList(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

export function isOriginAllowed(origin: string | null, env: { ALLOWED_ORIGINS?: string }): boolean {
  if (!origin) return false
  return parseAllowList(env.ALLOWED_ORIGINS).has(origin)
}

/** Build a CORS header bag for a response. Echoes the request Origin if allow-listed. */
export function corsHeaders(request: Request, env: { ALLOWED_ORIGINS?: string }): Headers {
  const headers = new Headers()
  const origin = request.headers.get('Origin')
  if (origin && isOriginAllowed(origin, env)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }
  return headers
}

/** Handle an OPTIONS preflight. Returns null when the request isn't a preflight. */
export function handlePreflight(
  request: Request,
  env: { ALLOWED_ORIGINS?: string },
): Response | null {
  if (request.method !== 'OPTIONS') return null
  const headers = corsHeaders(request, env)
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS)
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS)
  headers.set('Access-Control-Max-Age', '86400')
  return new Response(null, { status: 204, headers })
}
