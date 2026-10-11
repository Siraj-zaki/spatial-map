/**
 * POST /streams/:streamToken/proxy-outbound
 *
 * Phase 7c-lite — outbound proxy. The SPA can't always fetch a
 * customer destination directly because of CORS; routing through the
 * Worker is the simplest fix that still keeps the existing
 * `pushOutboundPatch` audit-log loop intact.
 *
 * Request body (JSON):
 *   {
 *     "url"     : "https://wms.example.com/api/bins/BIN-007",
 *     "method"  : "PATCH",                                // default 'POST'
 *     "headers" : { "Authorization": "Bearer …" },         // optional
 *     "body"    : "<json or text>"                         // optional
 *   }
 *
 * Response: the destination's response body verbatim, plus an
 * `X-Forwarded-Status` header carrying the upstream HTTP status so
 * the SPA can record it on the audit row even when the destination
 * returned a non-JSON body.
 *
 * Auth: X-Api-Key (the same Worker API_KEY). The stream token
 * scopes the proxy — Phase 7d (multi-tenant) will key access to the
 * destination by the token's tenant; today the token is just a route
 * discriminator.
 */

import { checkApiKey } from '../lib/auth-api-key'
import type { Env } from '../env'
import { errorResponse, json, text as textResponse } from '../lib/json'

const FORWARD_TIMEOUT_MS = 20_000
const MAX_REQUEST_BYTES = 256 * 1024

interface Body {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export async function handleLiveStreamOutboundProxy(
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
  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return errorResponse(request, env, 413, `request exceeds ${MAX_REQUEST_BYTES} bytes`)
  }
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return errorResponse(request, env, 400, 'malformed JSON body')
  }
  if (!body.url || typeof body.url !== 'string') {
    return errorResponse(request, env, 400, '`url` is required')
  }
  let targetUrl: URL
  try {
    targetUrl = new URL(body.url)
  } catch {
    return errorResponse(request, env, 400, `invalid url: ${body.url}`)
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return errorResponse(request, env, 400, 'only http(s) urls supported')
  }
  const method = (body.method ?? 'POST').toUpperCase()
  if (!['POST', 'PATCH', 'PUT', 'DELETE', 'GET'].includes(method)) {
    return errorResponse(request, env, 400, `method ${method} not allowed`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS)

  let upstream: Response
  try {
    upstream = await fetch(targetUrl.toString(), {
      method,
      headers: body.headers ?? {},
      body: method === 'GET' ? undefined : body.body,
      signal: controller.signal,
    })
  } catch (err) {
    const e = err as { name?: string; message?: string }
    if (e.name === 'AbortError') {
      return errorResponse(
        request,
        env,
        504,
        `forward timed out after ${FORWARD_TIMEOUT_MS / 1000}s`,
      )
    }
    return errorResponse(
      request,
      env,
      502,
      `forward failed: ${e.message ?? 'network error'}`,
    )
  } finally {
    clearTimeout(timer)
  }

  // Forward the body verbatim. We don't peek at the bytes — keeping
  // the proxy content-type-agnostic so a customer system returning
  // XML or text/plain passes through cleanly.
  const upstreamText = await upstream.text().catch(() => '')
  // The SPA reads `X-Forwarded-Status` to populate `httpStatus` on
  // the audit row regardless of whether the body parses.
  return textResponse(request, env, upstreamText, {
    status: upstream.ok ? 200 : 502,
    headers: {
      'X-Forwarded-Status': String(upstream.status),
      'X-Forwarded-Url': targetUrl.toString(),
    },
  })
  // The `json` import is kept to satisfy the bundler tree-shake check
  // for parity with other route handlers — not used here.
  void json
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token)
}
