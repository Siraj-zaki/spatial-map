/**
 * Workspace client. Wraps the backend /tenants routes with the semantics
 * the UI actually needs: create, rename, delete, leave, and switch — plus
 * keeping `useAuthStore.tenants` in sync so the trial banner, workspace
 * switcher, and role gates all see the update without a full page reload.
 *
 * Note: in the code + DB the entity is still called `tenant`. Only the
 * user-facing copy says "workspace". Keeping the code name stable avoids
 * touching 100+ files while the concept in the UI is the friendlier one.
 */

import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api-client'
import { useAuthStore, type AuthTenant } from '@/lib/auth-store'
import { setCurrentTenantId, getCurrentTenantIdSync } from '@/lib/tenant-store'

export interface WorkspaceInput {
  name: string
  color: string
}

/**
 * Fetch the current user's workspaces from the backend. Also replaces
 * `useAuthStore.tenants` so any subscriber (trial banner, switcher, etc.)
 * re-renders. Useful after operations the store can't be locally patched
 * for — e.g. leaving a workspace where the plan projection needs a
 * full re-fetch.
 */
export async function refreshWorkspaces(): Promise<AuthTenant[]> {
  const list = await apiGet<AuthTenant[]>('/tenants')
  useAuthStore.getState().setTenants(list)
  return list
}

/**
 * Create a new workspace. The backend stamps a fresh 7-day trial and adds
 * the caller as owner. Returns the newly-created AuthTenant with its plan
 * projection filled in.
 */
export async function createWorkspace(input: WorkspaceInput): Promise<AuthTenant> {
  const created = await apiPost<AuthTenant>('/tenants', {
    name: input.name.trim(),
    color: input.color || '#3b82f6',
  })
  const current = useAuthStore.getState().tenants
  useAuthStore.getState().setTenants([...current, created])
  return created
}

/**
 * Rename + recolor a workspace. Owner or admin only (server-enforced).
 * On success the local `tenants` array is patched in place so the
 * switcher label updates without a round-trip.
 */
export async function updateWorkspace(id: number, input: WorkspaceInput): Promise<AuthTenant> {
  const updated = await apiPatch<AuthTenant>(`/tenants/${id}`, {
    name: input.name.trim(),
    color: input.color || '#3b82f6',
  })
  const patched = useAuthStore
    .getState()
    .tenants.map((t) => (t.id === id ? { ...t, ...updated } : t))
  useAuthStore.getState().setTenants(patched)
  return updated
}

/**
 * Hard-delete a workspace. Owner-only (server-enforced). Refuses if this
 * is the caller's only workspace. Every child row cascades via FK; every
 * object-store file (images / image-planes / user-models) is reclaimed
 * server-side post-commit.
 *
 * If the deleted workspace was the caller's active one, we switch to the
 * next available one before returning. The caller (usually the dialog
 * that fired the delete) is responsible for triggering the full
 * spatial-store + door reload — see the switcher's onSwitch callback.
 */
export async function deleteWorkspace(id: number): Promise<{ next: AuthTenant | null }> {
  await apiDelete<void>(`/tenants/${id}`)
  const remaining = useAuthStore.getState().tenants.filter((t) => t.id !== id)
  useAuthStore.getState().setTenants(remaining)

  const currentId = getCurrentTenantIdSync()
  if (currentId === id && remaining.length > 0) {
    await setCurrentTenantId(remaining[0].id)
    return { next: remaining[0] }
  }
  return { next: null }
}

/**
 * Remove the caller from a workspace without deleting the workspace
 * itself. Refuses when: not a member; the caller has no other workspace;
 * the caller is the sole owner (transfer ownership first).
 *
 * Same "switch if this was current" logic as deleteWorkspace.
 */
export async function leaveWorkspace(id: number): Promise<{ next: AuthTenant | null }> {
  await apiPost<void>(`/tenants/${id}/leave`)
  const remaining = useAuthStore.getState().tenants.filter((t) => t.id !== id)
  useAuthStore.getState().setTenants(remaining)

  const currentId = getCurrentTenantIdSync()
  if (currentId === id && remaining.length > 0) {
    await setCurrentTenantId(remaining[0].id)
    return { next: remaining[0] }
  }
  return { next: null }
}
