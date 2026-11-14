/**
 * Phase 7d — tenant service.
 *
 * Tenants are logical owners (customer / site / department) of every
 * connection, stream, rule, reference, and alert. Phase 7d-lite stops
 * at SPA-side filtering; the Worker stays single-tenant for now and
 * the auth surface doesn't change.
 *
 * The "current tenant" is managed by `src/lib/tenant-store.ts`, which
 * persists to the backend `settings/current-tenant` key while keeping a
 * Dexie fallback during the migration window. React components subscribe
 * via `useCurrentTenant()` and route writes through `setCurrentTenantId`.
 *
 * Tenant CRUD is now backed by the Go backend through `apiDb.tenants`.
 */

import { useSyncExternalStore } from 'react'
import {
  getCurrentTenantId,
  getCurrentTenantIdSync,
  setCurrentTenantId,
  subscribeTenantChanges,
} from '@/lib/tenant-store'

export { getCurrentTenantId, getCurrentTenantIdSync, setCurrentTenantId }

// Legacy CRUD helpers (listTenants/createTenant/renameTenant/
// setTenantColor/deleteTenant) that previously wrapped `apiDb.tenants`
// were retired alongside the Integrations page's "Tenants" tab. All
// workspace mutations now flow through `@/lib/workspace-client`, which
// hits the JWT-aware backend endpoints (owner/admin gates, trial
// stamping, file reclamation on delete). The `useCurrentTenant()`
// composite hook was also retired — the only remaining consumer needs
// just the active id, exposed as `useCurrentTenantId()` below.

/**
 * Convenience used by data-link scheduler + live-stream health hooks.
 * Returns the current tenant id or `null` while the SPA is still booting.
 * Components that need the full workspace projection (name, colour,
 * role, plan) should read `useAuthStore.tenants` directly.
 */
export function useCurrentTenantId(): number | null {
  return useSyncExternalStore(
    subscribeTenantChanges,
    () => getCurrentTenantIdSync(),
    () => null,
  )
}
