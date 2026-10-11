/**
 * Reactive tenant store that drives the X-Tenant-Id header on every backend
 * request. The source of truth is the backend `settings/current-tenant` key.
 * If that key is missing and the backend is reachable, a default tenant is
 * created automatically. Legacy Dexie `settings.tenant.current` is no longer
 * consulted after M9 backfill.
 */

import { API_V1_URL, API_KEY } from '@/config/api'
import { useAuthStore, getAuthToken } from './auth-store'

/** Build headers that carry BOTH the JWT (if we have one) AND the API
 *  key fallback. Order matters at the server: OptionalJWTMiddleware runs
 *  first, sets user context if the Bearer parses, then APIKeyMiddleware
 *  short-circuits when a user is already authenticated. This means the
 *  presence of a valid JWT lets us through even if VITE_API_KEY doesn't
 *  match the server (which is the case in production where VITE_API_KEY
 *  is a public "placeholder"). Same shape as api-client.ts uses. */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Api-Key': API_KEY,
    ...extra,
  }
  const token = getAuthToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

type ChangeListener = (tenantId: number | null) => void

const listeners = new Set<ChangeListener>()

// In-memory current tenant id. Components and api-client read this directly.
let currentTenantId: number | null = null
let initialized = false
// Cached in-flight init promise so concurrent callers share one round-trip
// instead of racing 4× GET / 3× PUT to /settings/current-tenant.
let initPromise: Promise<number | null> | null = null

function emit(tenantId: number | null) {
  currentTenantId = tenantId
  listeners.forEach((cb) => cb(tenantId))
}

export function subscribeTenantChanges(cb: ChangeListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getCurrentTenantIdSync(): number | null {
  return currentTenantId
}

async function fetchBackendTenant(): Promise<number | null> {
  try {
    const res = await fetch(`${API_V1_URL}/settings/current-tenant`, {
      headers: authHeaders(),
    })
    if (!res.ok) return null
    const { data } = await res.json()
    if (data?.value?.tenantId) {
      return Number(data.value.tenantId)
    }
  } catch {
    // Backend not reachable — keep the legacy value.
  }
  return null
}

async function saveBackendTenant(tenantId: number): Promise<void> {
  const res = await fetch(`${API_V1_URL}/settings/current-tenant`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ value: { tenantId } }),
  })
  if (!res.ok) throw new Error(`failed to save current tenant: ${res.status}`)
}

/**
 * Initialize the tenant store from the best available source:
 * 1. backend settings/current-tenant
 * 2. legacy Dexie settings.tenant.current
 * 3. create a default tenant on the backend and use that
 *
 * Concurrent callers share one in-flight promise — the async body used
 * to run once per caller, so N components hitting `getCurrentTenantId()`
 * before init resolved caused N GETs + N PUTs to `/settings/current-tenant`.
 */
export async function initTenantStore(): Promise<number | null> {
  if (initialized) return currentTenantId
  if (initPromise) return initPromise
  initPromise = runInit().finally(() => {
    initPromise = null
  })
  return initPromise
}

async function runInit(): Promise<number | null> {
  // Auth-first: if the user is logged in, use their tenant memberships as the
  // source of truth. Falls through to the legacy backend/settings flow for
  // API-key-only callers (e2e tests, dev tools).
  const authTenants = useAuthStore.getState().tenants
  if (authTenants.length > 0) {
    const stored = await fetchBackendTenant()
    // Prefer the previously-selected tenant if the user is still a member.
    const pick = stored !== null && authTenants.some((t) => t.id === stored)
      ? stored
      : authTenants[0].id
    initialized = true
    emit(pick)
    // Only PUT if the backend didn't already have the same pick — avoids
    // a needless write on every boot when nothing changed.
    if (stored !== pick) {
      void saveBackendTenant(pick).catch(() => {})
    }
    return pick
  }

  // Signed out (login / signup / share pages): no workspace to resolve.
  // Every app page needs a session; looking one up here 401'd behind an
  // enforced API key, and creating a "Default" left an empty, memberless
  // workspace on every fresh install. Login resets the store.
  if (!getAuthToken()) {
    initialized = true
    emit(null)
    return null
  }

  let tenantId = await fetchBackendTenant()

  if (tenantId === null) {
    // Try to create a default tenant on the backend.
    try {
      const res = await fetch(`${API_V1_URL}/tenants`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': API_KEY,
        },
        body: JSON.stringify({ name: 'Default', color: '#3b82f6' }),
      })
      if (res.ok) {
        const { data } = await res.json()
        tenantId = data?.id ?? null
        if (tenantId !== null) {
          await saveBackendTenant(tenantId)
        }
      }
    } catch {
      // Backend not reachable.
    }
  }

  initialized = true
  emit(tenantId)
  return tenantId
}

/**
 * Reset the initialization flag so the next `initTenantStore` call re-runs
 * from scratch. Called by the auth flow after login/logout to pick up the
 * new user's tenant memberships.
 */
export function resetTenantStore(): void {
  initialized = false
  initPromise = null
  emit(null)
}

export async function setCurrentTenantId(tenantId: number): Promise<void> {
  await saveBackendTenant(tenantId)
  emit(tenantId)
}

export async function getCurrentTenantId(): Promise<number | null> {
  if (!initialized) return initTenantStore()
  return currentTenantId
}
