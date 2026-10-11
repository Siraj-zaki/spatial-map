import { useSyncExternalStore } from 'react'
import { useAuthStore, type AuthRole } from '@/lib/auth-store'
import { getCurrentTenantIdSync, subscribeTenantChanges } from '@/lib/tenant-store'

/**
 * The signed-in user's role in the active workspace, plus the capability
 * flags pages gate UI on. The API enforces the same rules — this only
 * keeps viewers from seeing buttons that would fail.
 */
export function useWorkspaceRole(): {
  role: AuthRole | null
  /** owner / admin — members, files, integrations, destructive admin actions */
  canManage: boolean
  /** owner / admin / editor — create and edit content */
  canEdit: boolean
} {
  const tenantId = useSyncExternalStore(subscribeTenantChanges, getCurrentTenantIdSync, () => null)
  const role = useAuthStore((s) => s.tenants.find((t) => t.id === tenantId)?.role ?? null)
  return {
    role,
    canManage: role === 'owner' || role === 'admin',
    canEdit: role === 'owner' || role === 'admin' || role === 'editor',
  }
}
