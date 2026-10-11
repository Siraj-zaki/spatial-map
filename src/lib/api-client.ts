import { trackRequest } from './loading-bar'
import { API_V1_URL, API_PUBLIC_URL, API_KEY } from '@/config/api'
import { getAuthToken, useAuthStore } from '@/lib/auth-store'
import { getCurrentTenantId, getCurrentTenantIdSync } from '@/lib/tenant-store'
import {
  enqueueRequest,
  incrementRetry,
  isOnline,
  listenOnline,
  peekQueue,
  removeFromQueue,
} from './offline-queue'

export type ApiErrorKind = 'auth' | 'server' | 'network' | 'client'

export class ApiError extends Error {
  kind: ApiErrorKind
  status?: number
  response?: Response
  /** Machine-readable reason from the envelope's `code` (set by /auth/* endpoints). */
  code?: string
  /** Seconds from a 429's Retry-After header, when the server sent one. */
  retryAfter?: number

  constructor(message: string, kind: ApiErrorKind, status?: number, response?: Response) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.response = response
    const retry = Number(response?.headers.get('Retry-After'))
    if (Number.isFinite(retry) && retry > 0) this.retryAfter = Math.ceil(retry)
  }
}

/**
 * sessionStorage key the login page reads to explain why the user landed
 * there (e.g. "your password was changed"). Value: JSON
 * `{ reason: 'session_revoked', email }` — the email prefills the form.
 * One-shot: the reader removes it.
 */
export const AUTH_NOTICE_KEY = 'sgv-auth-notice'

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  /** Any JSON-serializable body; FormData/Blob/ArrayBuffer/string are passed through. */
  body?: unknown
  /** Background work (live refreshes, polling): never shows the top loading bar. */
  silent?: boolean
  /**
   * When true, skip the automatic `{ data }` envelope unwrap and return the raw
   * JSON body. Useful for endpoints that do not follow the standard envelope.
   */
  rawResponse?: boolean
  /**
   * When true, a mutating request that fails with a network error will not be
   * added to the offline queue. Used by the queue flusher to avoid re-queueing
   * the same request indefinitely.
   */
  skipOfflineQueue?: boolean
  /** Override the tenant header for this request. Used when replaying queued requests. */
  tenantId?: number
}

type ErrorListener = (error: ApiError) => void

const errorListeners = new Set<ErrorListener>()

export function addApiErrorListener(cb: ErrorListener): () => void {
  errorListeners.add(cb)
  return () => errorListeners.delete(cb)
}

function notifyError(error: ApiError): void {
  errorListeners.forEach((cb) => cb(error))
}

function classifyError(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status >= 500) return 'server'
  return 'client'
}

function needsJsonBody(body: unknown): boolean {
  return (
    body !== undefined &&
    typeof body !== 'string' &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(body)
  )
}

async function tenantIdHeader(opts?: { tenantId?: number }): Promise<string | null> {
  if (opts?.tenantId !== undefined) return String(opts.tenantId)
  const sync = getCurrentTenantIdSync()
  if (sync !== null) return String(sync)
  const id = await getCurrentTenantId()
  return id !== null ? String(id) : null
}

function canQueueBody(body: unknown): boolean {
  return body === undefined || needsJsonBody(body)
}

async function performFetch<T>(path: string, opts: ApiOptions): Promise<T> {
  const tenantId = await tenantIdHeader(opts)
  const url = path.startsWith('http') ? path : `${API_V1_URL}${path}`

  const headers = new Headers(opts.headers)
  // Keep X-Api-Key for backwards compatibility — the backend's
  // APIKeyMiddleware short-circuits when a JWT is also present, so sending
  // both is harmless and lets us roll out auth without breaking existing
  // dev/e2e flows that rely on the shared key.
  headers.set('X-Api-Key', API_KEY)
  const token = getAuthToken()
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (tenantId !== null) {
    headers.set('X-Tenant-Id', tenantId)
  }

  const body = needsJsonBody(opts.body) ? JSON.stringify(opts.body) : (opts.body as BodyInit | undefined)
  if (body !== undefined && !headers.has('Content-Type') && needsJsonBody(opts.body)) {
    headers.set('Content-Type', 'application/json')
  }

  let res: Response
  try {
    res = await fetch(url, {
      ...opts,
      headers,
      body,
    })
  } catch {
    throw new ApiError(`Network error for ${opts.method ?? 'GET'} ${path}`, 'network')
  }

  if (!res.ok) {
    const kind = classifyError(res.status)
    // Try to lift the server's `{ error: "…" }` message out so callers can
    // surface it verbatim (e.g. "name already taken").
    // Falls back to a generic message when the body isn't a JSON envelope.
    let serverMessage = ''
    let serverCode: string | undefined
    try {
      const cloned = res.clone()
      const body = await cloned.json()
      if (body && typeof body.error === 'string') serverMessage = body.error
      if (body && typeof body.code === 'string') serverCode = body.code
    } catch {
      // non-JSON body — keep serverMessage empty
    }
    const message = serverMessage || `API ${opts.method ?? 'GET'} ${path} failed: ${res.status}`
    const err = new ApiError(message, kind, res.status, res)
    err.code = serverCode
    // The password was changed (e.g. a reset from another device): this
    // token is permanently dead, so drop it now rather than let every
    // request fail. AuthGuard then redirects to /login, which reads the
    // notice and explains why.
    if (res.status === 401 && serverCode === 'session_revoked' && getAuthToken()) {
      try {
        const email = useAuthStore.getState().user?.email ?? ''
        sessionStorage.setItem(AUTH_NOTICE_KEY, JSON.stringify({ reason: 'session_revoked', email }))
      } catch {
        // storage unavailable — the redirect still happens, just unexplained
      }
      useAuthStore.getState().clear()
    }
    notifyError(err)
    throw err
  }

  const contentType = res.headers.get('Content-Type') ?? ''
  if (!contentType.includes('application/json')) {
    return undefined as T
  }

  // 204 No Content responses may still carry an application/json MIME type
  // with an empty body; don't try to parse them.
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }

  const json = await res.json()
  if (opts.rawResponse) {
    return json as T
  }

  if (json && typeof json === 'object' && 'data' in json) {
    return (json as { data: T }).data
  }

  return json as T
}

const MAX_OFFLINE_RETRIES = 3

async function enqueueOfflineRequest(path: string, opts: ApiOptions, method: string): Promise<void> {
  const tenantId = await tenantIdHeader(opts)
  await enqueueRequest({
    method,
    path,
    body: opts.body,
    tenantId: tenantId ? Number(tenantId) : null,
    apiKey: API_KEY,
  })
}

/**
 * Replay every queued mutation in order. Stops if the browser goes offline
 * again. Drops requests that fail repeatedly with server/client errors after
 * `MAX_OFFLINE_RETRIES` attempts.
 */
export async function flushOfflineQueue(): Promise<void> {
  if (!isOnline()) return
  const requests = await peekQueue()
  for (const req of requests) {
    try {
      await apiFetch(req.path, {
        method: req.method as RequestInit['method'],
        body: req.body,
        tenantId: req.tenantId ?? undefined,
        skipOfflineQueue: true,
      })
      if (req.id !== undefined) await removeFromQueue(req.id)
    } catch (err) {
      const networkGone = err instanceof ApiError && err.kind === 'network'
      if (networkGone) break
      if (req.id === undefined) continue
      if (req.retryCount >= MAX_OFFLINE_RETRIES) {
        await removeFromQueue(req.id)
      } else {
        await incrementRetry(req.id)
      }
    }
  }
}

let flushScheduled = false
function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  setTimeout(() => {
    flushScheduled = false
    void flushOfflineQueue()
  }, 0)
}

if (typeof window !== 'undefined') {
  listenOnline(scheduleFlush)
  if (isOnline()) scheduleFlush()
}

/**
 * Low-level fetch wrapper used by every backend adapter.
 * Injects `X-Api-Key` and the reactive `X-Tenant-Id` header, serializes JSON
 * bodies, unwraps the standard `{ data: T }` response envelope, and retries
 * server errors once. Mutations made while offline are queued in IndexedDB
 * and flushed when connectivity returns.
 */
export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const isMutating = method !== 'GET' && method !== 'HEAD'

  if (!isOnline() && isMutating && canQueueBody(opts.body) && !opts.skipOfflineQueue) {
    await enqueueOfflineRequest(path, opts, method)
    throw new ApiError('Request queued for offline sync', 'network')
  }

  // The top loading bar (src/lib/loading-bar.ts): screen loads and writes.
  const endLoading = trackRequest(method, path, opts.silent)
  try {
    return await performFetch<T>(path, opts)
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'server') {
      return await performFetch<T>(path, opts)
    }
    if (
      err instanceof ApiError &&
      err.kind === 'network' &&
      isMutating &&
      canQueueBody(opts.body) &&
      !opts.skipOfflineQueue
    ) {
      await enqueueOfflineRequest(path, opts, method)
      throw new ApiError('Request queued for offline sync', 'network')
    }
    throw err
  } finally {
    endLoading?.()
  }
}

export function apiGet<T>(path: string, opts: Omit<ApiOptions, 'method'> = {}): Promise<T> {
  return apiFetch<T>(path, { ...opts, method: 'GET' })
}

export function apiPost<T>(path: string, body?: unknown, opts: Omit<ApiOptions, 'method' | 'body'> = {}): Promise<T> {
  return apiFetch<T>(path, { ...opts, method: 'POST', body })
}

export function apiPut<T>(path: string, body?: unknown, opts: Omit<ApiOptions, 'method' | 'body'> = {}): Promise<T> {
  return apiFetch<T>(path, { ...opts, method: 'PUT', body })
}

export function apiPatch<T>(path: string, body?: unknown, opts: Omit<ApiOptions, 'method' | 'body'> = {}): Promise<T> {
  return apiFetch<T>(path, { ...opts, method: 'PATCH', body })
}

export function apiDelete<T>(path: string, opts: Omit<ApiOptions, 'method'> = {}): Promise<T> {
  return apiFetch<T>(path, { ...opts, method: 'DELETE' })
}

/**
 * Public, unauthenticated fetch for the shareable presentation view. Hits
 * `/api/v1/public/*` with no `X-Api-Key` or `X-Tenant-Id` header and unwraps
 * the same `{ data: T }` envelope. Reuses `ApiError` so callers can handle
 * errors identically to `apiFetch`.
 */
export async function publicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_PUBLIC_URL}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  }).catch(() => {
    throw new ApiError(`Network error for GET ${path}`, 'network')
  })

  if (!res.ok) {
    const kind = classifyError(res.status)
    const err = new ApiError(`Public GET ${path} failed: ${res.status}`, kind, res.status, res)
    throw err
  }

  const contentType = res.headers.get('Content-Type') ?? ''
  if (!contentType.includes('application/json')) {
    return undefined as T
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }

  const json = await res.json()
  if (json && typeof json === 'object' && 'data' in json) {
    return (json as { data: T }).data
  }
  return json as T
}
