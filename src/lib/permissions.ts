/**
 * Custom roles (backend: api/permissions.go, handlers/roles.go).
 *
 * A role is a list of permissions. Reading is never a permission — every
 * member sees the workspace's facilities and data; a permission allows a
 * kind of change. The server sends each workspace's permissions with the
 * session (`AuthTenant.permissions`); `BUILTIN_PERMISSIONS` only covers a
 * session saved before roles existed.
 */

import { apiDelete, apiGet, apiPatch, apiPost } from './api-client'
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

/** The permissions a custom role may hold, grouped for the role editor (same order as the server). */
export const PERMISSION_GROUPS: { key: string; fallback: string; permissions: { key: Permission; fallback: string; hint: string }[] }[] = [
  {
    key: 'facilities',
    fallback: 'Facilities',
    permissions: [
      { key: 'facilities.edit', fallback: 'Edit facilities', hint: 'Draw and change floors, rooms, models and labels; import floor plans.' },
      { key: 'facilities.manage', fallback: 'Create and delete facilities', hint: 'Add, duplicate and delete whole facilities.' },
      { key: 'ai.map', fallback: 'Use AI Map', hint: 'Let AI draw a floor plan from an uploaded drawing.' },
    ],
  },
  {
    key: 'data',
    fallback: 'Data',
    permissions: [
      { key: 'data.manage', fallback: 'Manage data', hint: 'Tables, records, integrations, map data layers and colour rules.' },
      { key: 'files.manage', fallback: 'Manage files', hint: 'Delete stored files on the Files page.' },
    ],
  },
  {
    key: 'reports',
    fallback: 'Reports',
    permissions: [
      { key: 'reports.viewAll', fallback: 'See every report', hint: 'Without it, only reports they made or were given.' },
      { key: 'reports.edit', fallback: 'Edit reports', hint: 'Change the reports they can see.' },
      { key: 'reports.create', fallback: 'Create and delete reports', hint: 'Make new reports, archive them, and choose who sees them.' },
      { key: 'reports.share', fallback: 'Share links', hint: 'Public links to reports and facilities.' },
      { key: 'solutions.manage', fallback: 'Manage solutions', hint: 'Create solutions and choose what is in them.' },
    ],
  },
  {
    key: 'alerts',
    fallback: 'Alerts',
    permissions: [
      { key: 'alerts.respond', fallback: 'Respond to alerts', hint: 'Acknowledge and resolve alerts.' },
      { key: 'alerts.manage', fallback: 'Manage alert rules', hint: 'Create, change and turn off alert rules.' },
    ],
  },
  {
    key: 'people',
    fallback: 'People and workspace',
    permissions: [
      { key: 'members.manage', fallback: 'Manage people', hint: 'Add and create accounts, change roles, remove people.' },
      { key: 'roles.manage', fallback: 'Manage roles', hint: 'Create and change custom roles.' },
      { key: 'workspace.manage', fallback: 'Workspace settings', hint: 'Rename the workspace.' },
    ],
  },
]

const ALL_ASSIGNABLE: Permission[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key))

/** The built-in roles' permissions — a mirror of api.BuiltinPermissions. */
export const BUILTIN_PERMISSIONS: Record<AuthRole, Permission[]> = {
  owner: [...ALL_ASSIGNABLE, 'workspace.own'],
  admin: ALL_ASSIGNABLE,
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

// ---------- API ----------

export interface RoleView {
  /** Absent for a built-in role. */
  id?: number
  /** owner / admin / editor / viewer, or 'custom'. */
  key: AuthRole | 'custom'
  name: string
  description: string
  permissions: Permission[]
  builtIn: boolean
  memberCount: number
}

export interface RolesResponse {
  roles: RoleView[]
  assignable: Permission[]
}

export function listRoles(): Promise<RolesResponse> {
  return apiGet<RolesResponse>('/roles')
}

export function createRole(input: { name: string; description: string; permissions: Permission[] }): Promise<RoleView> {
  return apiPost<RoleView>('/roles', input)
}

export function updateRole(id: number, input: Partial<{ name: string; description: string; permissions: Permission[] }>): Promise<RoleView> {
  return apiPatch<RoleView>(`/roles/${id}`, input)
}

export function deleteRole(id: number): Promise<void> {
  return apiDelete<void>(`/roles/${id}`)
}

/** A role choice as one string, for <select>: "builtin:editor" or "custom:12". */
export type RoleChoice = `builtin:${AuthRole}` | `custom:${number}`

export function roleChoiceOf(member: { role: AuthRole; customRoleId?: number }): RoleChoice {
  return member.customRoleId ? `custom:${member.customRoleId}` : `builtin:${member.role}`
}

/** The request fields for a choice: `{role}` or `{roleId}`. */
export function roleChoiceBody(choice: RoleChoice): { role?: AuthRole; roleId?: number } {
  const [kind, value] = choice.split(':') as [string, string]
  return kind === 'custom' ? { roleId: Number(value) } : { role: value as AuthRole }
}
