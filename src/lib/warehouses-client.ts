/**
 * Server-driven warehouse-summaries client.
 *
 * The dashboard / `/warehouses` table calls `listWarehouseSummaries` with the
 * current filter + sort + pagination state. The backend does ONE SQL query
 * (CTE aggregates + window-function total) — so even for tenants with
 * thousands of warehouses, the React table only handles `pageSize` rows
 * per render and one network round-trip per filter change.
 *
 * Why this lives outside `apiDb` and `useApiQuery`:
 *   - `apiDb` is a Dexie-shaped facade for plain CRUD; this is an
 *     aggregation/reporting endpoint with custom query params.
 *   - `useApiQuery` is fine for the fetch itself; the typed helper below
 *     just keeps the param shape and result type close to the endpoint.
 */

import { apiGet } from './api-client'
import type { ShareLinkStatus } from './share-link-client'

export type WarehouseSummarySort =
  | 'name'
  | 'binCount'
  | 'occupiedPct'
  | 'assetCount'
  | 'rackCount'
  | 'floorCount'
  | 'updatedAt'

export type WarehouseSummaryDir = 'asc' | 'desc'

export interface WarehouseSummaryParams {
  /** Free-text search matched against name + address (case-insensitive). */
  search?: string
  /** When true, only include warehouses with 0 bins. */
  emptyOnly?: boolean
  sort?: WarehouseSummarySort
  dir?: WarehouseSummaryDir
  /** 1-based page index. */
  page?: number
  pageSize?: number
  /** Only this solution's facilities (`solutions-client.ts`); KPI stats follow. */
  solution?: number | null
}

/**
 * Trimmed share-link row embedded per warehouse in the listing response.
 * Enough to render a named chip, copy its URL, and tone its status badge —
 * the full row (settings blob, audit fields) comes from `listShareLinks`
 * when the share dialog opens.
 */
export interface WarehouseShareLinkSummary {
  id: number
  token: string
  /** May be empty — the table falls back to "Untitled link". */
  label: string
  status: ShareLinkStatus
  viewCount: number
  expiresAt?: string
}

export interface WarehouseSummaryRow {
  id: number
  name: string
  color: string
  address?: string
  /**
   * Legacy `zones.share_token` (migration 0006). Still returned so old
   * `/share/:token` URLs keep resolving — do NOT gate share UI on it;
   * links issued since migration 0024 live in `shareLinks` below.
   */
  shareToken?: string
  /** Capped at 6 by the backend; `shareLinkCount` is the real total. */
  shareLinks?: WarehouseShareLinkSummary[]
  shareLinkCount: number
  isPublic: boolean
  rackCount: number
  binCount: number
  occupiedCount: number
  /** 0..1. Frontend renders as `Math.round(occupiedPct * 100)`. */
  occupiedPct: number
  assetCount: number
  floorCount: number
  /** First visible base-floor plan image (relative /files/ URL); absent when the facility has none. */
  thumbnailUrl?: string
  /** ISO 8601 / RFC3339. */
  updatedAt: string
}

export interface WarehouseSummariesStats {
  totalWarehouses: number
  totalBins: number
  occupiedBins: number
  totalAssets: number
}

/**
 * Aggregates over the FULL filtered set (across all pages). Drives the
 * KPI strip on the warehouses page so the numbers react to filter changes.
 */
export interface WarehouseFilteredStats {
  warehouses: number
  bins: number
  occupied: number
  assets: number
  /** 0..1 ratio across the filtered set. */
  avgOccupiedPct: number
}

export interface WarehouseSummariesResponse {
  rows: WarehouseSummaryRow[]
  total: number
  page: number
  pageSize: number
  stats: WarehouseSummariesStats
  filteredStats: WarehouseFilteredStats
}

/**
 * Stats-only fetch. Returns just the tenant-wide totals block — same shape
 * as the `stats` field on the listing response, but without the row list.
 * Used by the dashboard's KPI cards so they don't pull a page of rows just
 * to read the totals.
 */
export function getWarehouseStats(): Promise<WarehouseSummariesStats> {
  return apiGet<WarehouseSummariesStats>('/warehouse-summaries/stats')
}

export function listWarehouseSummaries(
  params: WarehouseSummaryParams = {},
): Promise<WarehouseSummariesResponse> {
  const qs = new URLSearchParams()
  if (params.search) qs.set('search', params.search)
  if (params.emptyOnly) qs.set('emptyOnly', 'true')
  if (params.sort) qs.set('sort', params.sort)
  if (params.dir) qs.set('dir', params.dir)
  if (params.page !== undefined) qs.set('page', String(params.page))
  if (params.pageSize !== undefined) qs.set('pageSize', String(params.pageSize))
  if (params.solution != null) qs.set('solution', String(params.solution))
  const q = qs.toString()
  return apiGet<WarehouseSummariesResponse>(
    q ? `/warehouse-summaries?${q}` : '/warehouse-summaries',
  )
}
