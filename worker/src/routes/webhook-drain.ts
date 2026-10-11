/**
 * GET /webhooks/:sourceToken/drain?max=500
 *
 * Atomic dequeue. Returns `{ events: [{ id, receivedAt, payload }], remaining }`
 * and clears the returned rows from the DO's events table.
 *
 * Auth: X-Api-Key. The SPA calls this from the data-link scheduler.
 */

import { checkApiKey } from '../lib/auth-api-key'
import type { Env } from '../env'
import { errorResponse, json } from '../lib/json'

const DEFAULT_MAX = 500
const HARD_MAX = 500

export async function handleWebhookDrain(
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
  const url = new URL(request.url)
  const max = clamp(Number.parseInt(url.searchParams.get('max') ?? '', 10), DEFAULT_MAX, 1, HARD_MAX)
  const id = env.WEBHOOK_QUEUE.idFromName(sourceToken)
  const stub = env.WEBHOOK_QUEUE.get(id)
  const result = await stub.drain(max)
  const lastReceivedAt = await stub.lastReceivedAt()
  // DO returns payload as raw JSON text; parse here so the SPA gets
  // structured objects in the response.
  const events = result.events.map((e) => ({
    id: e.id,
    receivedAt: e.receivedAt,
    payload: safeParse(e.payload),
  }))
  return json(request, env, { events, remaining: result.remaining, lastReceivedAt })
}

function clamp(n: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token)
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
