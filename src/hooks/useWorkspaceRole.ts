import { useSyncExternalStore } from 'react'
import { useAuthStore, type AuthRole } from '@/lib/auth-store'
import { BUILTIN_PERMISSIONS, type Permission } from '@/lib/permissions'
import { getCurrentTenantIdSync, subscribeTenantChanges } from '@/lib/tenant-store'

const NONE: string[] = []

/**
 * The signed-in user's role and permissions in the active workspace. Pages
 * gate UI on `can(permission)`; the API enforces the same rules — this only
 * keeps people from seeing buttons that would fail.
 */
export function useWorkspaceRole(): {
  role: AuthRole | null
  /** A custom role's name, else undefined. */
  roleName: string | undefined
  permissions: string[]
  can: (permission: Permission) => boolean
  /** members.manage — owners, admins and roles that manage people */
  canManage: boolean
  /** facilities.edit — create and edit content */
  canEdit: boolean
} {
  const tenantId = useSyncExternalStore(subscribeTenantChanges, getCurrentTenantIdSync, () => null)
  const tenant = useAuthStore((s) => s.tenants.find((t) => t.id === tenantId) ?? null)
  const role = tenant?.role ?? null
  // A session saved before custom roles has no list: use the built-in one.
  const permissions = tenant?.permissions ?? (role ? BUILTIN_PERMISSIONS[role] : NONE)
  const can = (p: Permission) => permissions.includes(p)
  return {
    role,
    roleName: tenant?.roleName || undefined,
    permissions,
    can,
    canManage: can('members.manage'),
    canEdit: can('facilities.edit'),
  }
}
