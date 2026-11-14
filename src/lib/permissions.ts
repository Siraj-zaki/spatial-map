/**
 * Workspace permissions. A role is a list of permissions; reading is never a
 * permission — every member sees the workspace's facilities and data — a
 * permission allows a kind of change. Pages gate buttons on
 * `useWorkspaceRole().can(permission)`; the API enforces the same rules.
 *
 * Only the four built-in roles exist, so the list a member holds comes from
 * `BUILTIN_PERMISSIONS`.
 */

import type { AuthRole } from './auth-store'

export type Permission =
  | 'facilities.edit'
  | 'facilities.manage'
  | 'data.manage'
  | 'reports.create'
  | 'reports.edit'
  | 'reports.viewAll'
  | 'reports.share'
  | 'alerts.respond'
  | 'alerts.manage'
  | 'solutions.manage'
  | 'ai.map'
  | 'files.manage'
  | 'members.manage'
  | 'roles.manage'
  | 'workspace.manage'
  | 'workspace.own'

const ADMIN: Permission[] = [
  'facilities.edit',
  'facilities.manage',
  'ai.map',
  'data.manage',
  'files.manage',
  'reports.viewAll',
  'reports.edit',
  'reports.create',
  'reports.share',
  'solutions.manage',
  'alerts.respond',
  'alerts.manage',
  'members.manage',
  'roles.manage',
  'workspace.manage',
]

/** The built-in roles' permissions. */
export const BUILTIN_PERMISSIONS: Record<AuthRole, Permission[]> = {
  owner: [...ADMIN, 'workspace.own'],
  admin: ADMIN,
  editor: [
    'facilities.edit',
    'facilities.manage',
    'data.manage',
    'reports.edit',
    'reports.share',
    'alerts.respond',
    'alerts.manage',
    'solutions.manage',
    'ai.map',
  ],
  viewer: [],
}
