/**
 * JSON response helpers that always stamp CORS headers. Every route returns
 * through here so we don't forget Allow-Origin on a code path.
 */

import { corsHeaders } from './cors'

export function json(
  request: Request,
  env: { ALLOWED_ORIGINS?: string },
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = corsHeaders(request, env)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  for (const [k, v] of Object.entries(init.headers ?? {})) headers.set(k, v as string)
  return new Response(JSON.stringify(body), { ...init, headers })
}

export function text(
  request: Request,
  env: { ALLOWED_ORIGINS?: string },
  body: string,
  init: ResponseInit = {},
  contentType = 'text/plain; charset=utf-8',
): Response {
  const headers = corsHeaders(request, env)
  headers.set('Content-Type', contentType)
  for (const [k, v] of Object.entries(init.headers ?? {})) headers.set(k, v as string)
  return new Response(body, { ...init, headers })
}

export function errorResponse(
  request: Request,
  env: { ALLOWED_ORIGINS?: string },
  status: number,
  message: string,
): Response {
  return json(request, env, { error: message }, { status })
}
