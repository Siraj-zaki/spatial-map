/**
 * Dashboard overview client. Wraps the single-round-trip
 * `/api/v1/dashboard-overview` endpoint that returns everything the
 * `/dashboard` screen renders.
 *
 * The response shape reflects the 2026-07-20 dashboard reframe: counts
 * of what exists in the workspace (facilities / members / integrations /
 * streams / files / bytes stored), a 30-day workspace-growth timeline,
 * and the most recently added warehouses. Operational KPIs (racks,
 * occupancy, bin status, top-N warehouses) moved to `/warehouses`
 * where they respond to filters.
 */

import { apiGet } from './api-client'

/** Tile grid on the dashboard. Every field is tenant-scoped. */
export interface DashboardCounts {
  totalWarehouses: number
  warehousesLast30d: number
  totalMembers: number
  membersLast30d: number
  /** Active data sources (soft-deleted rows excluded). */
  totalIntegrations: number
  integrationsLast30d: number
  /** Active streams (soft-deleted rows excluded). */
  activeStreams: number
  /** Distinct object-store keys referenced by this tenant's images / image_planes / user_models. */
  totalFiles: number
  /** Sum of file sizes in bytes for the same set as totalFiles. */
  totalStorageBytes: number
}

/**
 * One day in the 30-day workspace-growth timeline. `warehouses` /
 * `members` / `integrations` mirror the tile categories so the chart's
 * legend maps onto the KPI grid above it.
 */
export interface DashboardTimelinePoint {
  date: string // 'YYYY-MM-DD'
  warehouses: number
  members: number
  integrations: number
}

export interface DashboardRecentRow {
  id: number
  name: string
  color: string
  /** RFC3339. */
  createdAt: string
}

export interface DashboardOverview {
  counts: DashboardCounts
  timeline: DashboardTimelinePoint[]
  recentWarehouses: DashboardRecentRow[]
}

export function getDashboardOverview(): Promise<DashboardOverview> {
  return apiGet<DashboardOverview>('/dashboard-overview')
}
