/**
 * POST /api/v1/auth/issue-jwt
 *
 * Body: { ttlSeconds?: number, subject?: string }
 * Response: { token, expiresAt }
 *
 * Gated by X-Api-Key — only the holder of the global API_KEY can mint
 * tokens. Intended for the SPA's "test bearer auth" flow.
 */

import { checkApiKey } from '../lib/auth-api-key'
import type { Env } from '../env'
import { issueJwt } from '../lib/auth-jwt'
import { errorResponse, json } from '../lib/json'

interface Body {
  ttlSeconds?: number
  subject?: string
}

export async function handleIssueJwt(request: Request, env: Env): Promise<Response> {
  if (!checkApiKey(request, env)) {
    return errorResponse(request, env, 401, 'unauthorized — X-Api-Key required')
  }
  let body: Body = {}
  if (request.headers.get('content-type')?.includes('application/json')) {
    try {
      body = (await request.json()) as Body
    } catch {
      return errorResponse(request, env, 400, 'malformed JSON body')
    }
  }
  const { token, expiresAt } = await issueJwt(env.JWT_SECRET, {
    ttlSeconds: body.ttlSeconds,
    subject: body.subject,
  })
  return json(request, env, { token, expiresAt })
}
