/**
 * Platform-admin API client. One endpoint today: /admin/metrics —
 * signup + workspace rollups shown on the main dashboard when the
 * caller's email matches SGV_AUTH.BOOTSTRAP_EMAIL on the backend.
 *
 * Non-admin callers hit a 403; the caller handles that by not
 * rendering the admin section at all (see `AdminOverviewChapter`).
 */
import { apiGet } from '@/lib/api-client'

/** One day's user-signup count in the 30-day trend chart. */
export interface DailySignup {
  /** YYYY-MM-DD (UTC). */
  date: string
  count: number
}

/** Full response shape from GET /admin/metrics. */
export interface AdminMetrics {
  dailySignups: DailySignup[]
  totalUsers: number
  verifiedUsers: number
  signupsLast7Days: number
  signupsLast30Days: number
  totalTenants: number
}

/** Fetch the admin metrics blob. Throws on 403 for non-admin
 *  callers — the caller should catch and render nothing (or a hint
 *  to log in as the platform admin). */
export async function fetchAdminMetrics(): Promise<AdminMetrics> {
  return apiGet<AdminMetrics>('/admin/metrics')
}

/** One workspace a user belongs to. */
export interface AdminMembership {
  tenantId: number
  tenantName: string
  role: string
}

/** One row in the admin users table. */
export interface AdminUserRow {
  id: number
  email: string
  displayName: string
  jobTitle?: string
  createdAt: string
  verifiedAt?: string
  lastLoginAt?: string
  memberships: AdminMembership[]
}

/** Paginated response from GET /admin/users. */
export interface AdminUsersResponse {
  users: AdminUserRow[]
  totalCount: number
  page: number
  pageSize: number
}

/** Fetch a page of platform users. `search` matches lowercased
 *  email + display name via a LIKE. */
export async function fetchAdminUsers(opts: {
  page?: number
  pageSize?: number
  search?: string
} = {}): Promise<AdminUsersResponse> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
  if (opts.search && opts.search.trim()) params.set('q', opts.search.trim())
  const suffix = params.toString()
  return apiGet<AdminUsersResponse>(`/admin/users${suffix ? `?${suffix}` : ''}`)
}
