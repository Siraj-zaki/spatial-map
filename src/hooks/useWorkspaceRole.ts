import { useSyncExternalStore } from 'react'
import { useAuthStore, type AuthRole } from '@/lib/auth-store'
import { BUILTIN_PERMISSIONS, type Permission } from '@/lib/permissions'
import { getCurrentTenantIdSync, subscribeTenantChanges } from '@/lib/tenant-store'

const NONE: Permission[] = []

/**
 * The signed-in user's role and permissions in the active workspace. Pages
 * gate UI on `can(permission)`; the API enforces the same rules — this only
 * keeps people from seeing buttons that would fail.
 */
export function useWorkspaceRole(): {
  role: AuthRole | null
  permissions: Permission[]
  can: (permission: Permission) => boolean
  /** members.manage — owners and admins */
  canManage: boolean
  /** facilities.edit — owners, admins and editors */
  canEdit: boolean
} {
  const tenantId = useSyncExternalStore(subscribeTenantChanges, getCurrentTenantIdSync, () => null)
  const role = useAuthStore((s) => s.tenants.find((t) => t.id === tenantId)?.role ?? null)
  const permissions = role ? BUILTIN_PERMISSIONS[role] : NONE
  const can = (p: Permission) => permissions.includes(p)
  return {
    role,
    permissions,
    can,
    canManage: can('members.manage'),
    canEdit: can('facilities.edit'),
  }
}
