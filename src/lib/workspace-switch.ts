/**
 * Wires a listener on tenant changes so that switching workspaces triggers
 * a full reload of every user-scoped store — spatial catalog, door tool,
 * useApiQuery cache. Without this, the switcher would just change the
 * `X-Tenant-Id` header and leave the previous workspace's data on screen.
 *
 * Boot once from `main.tsx`. Idempotent — repeated installs are no-ops.
 *
 * Why not put this in tenant-store.ts? To keep tenant-store dependency-
 * free. It owns just the id + persistence; the reload cascade is a
 * consumer concern. Same reason we don't call setSpatialStore from
 * auth-client — separation lets the stores be tested in isolation.
 */

import { useAuthStore } from '@/lib/auth-store'
import { resetSpatialSession, useSpatialStore } from '@/lib/spatial-store'
import { useDoorStore } from '@/lib/door/store'
import { queryCache } from '@/lib/useApiQuery'
import { subscribeTenantChanges } from '@/lib/tenant-store'

let installed = false
// Track the last-seen tenant id so we can distinguish "initial null → id"
// (boot) from "id A → id B" (real switch). Initial boot loads happen
// naturally through TenantProvider + the spatial-store's own init effect;
// only real switches need this cascade.
let lastSeen: number | null = null

/**
 * Install the reload subscription. Call once from application boot.
 */
export function installWorkspaceSwitchReloader(): () => void {
  if (installed) return () => {}
  installed = true
  lastSeen = null

  const unsubscribe = subscribeTenantChanges((nextTenantId) => {
    const prev = lastSeen
    lastSeen = nextTenantId

    // Ignore the boot transition — every consumer already re-runs on
    // its own initial-mount effects. We only care about real user-
    // driven switches between two live tenants.
    if (prev === null || nextTenantId === null || prev === nextTenantId) {
      return
    }

    void handleWorkspaceSwitch(nextTenantId)
  })

  return () => {
    unsubscribe()
    installed = false
  }
}

/**
 * Perform the cascade. Exposed so callers that want the reload without
 * relying on the subscription (e.g. right after a workspace was created
 * and the switcher wants to jump straight into it) can trigger it
 * synchronously.
 */
export async function handleWorkspaceSwitch(nextTenantId: number): Promise<void> {
  // 1. Freeze the spatial-store's active zone so overlays don't blink
  //    old warehouse ids while the reload flies. Empty every slice so
  //    any component still mounted (e.g. the layout editor if the user
  //    switched from another tab) renders "empty workspace" instead of
  //    the previous tenant's data.
  //    Save edits still queued in the old workspace first — requests
  //    carry the tenant header current at send time.
  await useSpatialStore.getState().commit().catch(() => {})
  resetSpatialSession()
  useSpatialStore.getState().setTenantId(nextTenantId)

  // 2. Door tool has its own store (see docs/frontend.md). Reset it so
  //    the previous workspace's doors and pending config don't leak
  //    into the new one.
  useDoorStore.getState().resetForNewSession()

  // 3. Drop every SWR-style cache entry (dashboard, warehouse
  //    summaries, integrations lists, etc.) so hooks polling those
  //    endpoints re-fetch with the new X-Tenant-Id header instead of
  //    serving cached rows from the old workspace.
  queryCache.invalidateAll()

  // 4. Refresh the auth store's `tenants` array so `isLocked`,
  //    `trialEndsAt`, and the plan projection reflect the new active
  //    workspace's state. The switcher usually reads role/plan from
  //    useAuthStore, so this keeps the trial banner + role gates in
  //    sync without a round-trip to /auth/me.
  useAuthStore.getState().setTenants(useAuthStore.getState().tenants)

  // 5. Re-hydrate the catalog for the new workspace. Runs in parallel
  //    for every entity kind — see useSpatialStore.loadAll.
  await useSpatialStore.getState().loadAll().catch((err) => {
    // Loading fails cleanly per-kind (each catches internally and
    // stamps state.error[kind]). A top-level throw here would be a
    // programming error; log so a regression surfaces.
    console.error('[workspace-switch] loadAll failed', err)
  })
}
