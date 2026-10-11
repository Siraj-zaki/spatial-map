/**
 * Public per-table CRUD client. Hits `/api/v1/public/tables/rows` with
 * a `Bearer sgv_tbl_...` token (see backend/internal/handlers/
 * table_token_auth.go + table_rows_public.go). The token resolves the
 * (tenant_id, source_id) on the server, so callers don't send
 * `X-Tenant-Id` or `X-Api-Key` — those headers would actively break
 * the auth path.
 *
 * The plaintext token lives in whatever the caller considers a safe
 * client-store (env var, secrets manager, fleet agent config). Don't
 * paste it into the SPA — these helpers exist for the user's own
 * scripts and for the in-map data-linked overlay's preview path.
 */

import { ApiError } from '@/lib/api-client'
import type { DataLinkFilter } from '@/lib/db'
import type { FieldDefinitionResponse } from '@/lib/tables-client'

export interface PublicRowRequest {
  entityKey: string
  payload: Record<string, unknown>
  position?: [number, number] // [lng, lat]
}

export interface PublicRowResponse {
  entityKey: string
  payload: Record<string, unknown>
  position?: [number, number]
  ts: string
  updatedAt: string
}

interface PublicFetchOptions {
  method?: string
  body?: unknown
}

/**
 * Build a fetch request against the public tables surface. Lives here
 * (not in `api-client.ts`) because the auth header is a per-table
 * bearer, NOT the SPA's `X-Api-Key`. Using `apiFetch` would silently
 * leak the SPA's API key into a request the user thought was scoped.
 */
async function publicTablesFetch<T>(
  path: string,
  token: string,
  opts: PublicFetchOptions = {},
): Promise<T> {
  const url = path.startsWith('http')
    ? path
    : `${import.meta.env.VITE_API_BASE_URL ?? ''}/api/v1/public/tables${path}`
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }).catch(() => {
    throw new ApiError(`Network error for ${opts.method ?? 'GET'} ${path}`, 'network')
  })

  if (res.status >= 400) {
    let msg = `${opts.method ?? 'GET'} ${path} failed: ${res.status}`
    try {
      const body = await res.clone().json()
      if (body && typeof body === 'object' && 'error' in body) {
        msg = String((body as { error: unknown }).error)
      }
    } catch {
      // ignore — keep the status-only message
    }
    const kind: ApiError['kind'] =
      res.status === 401 || res.status === 403
        ? 'auth'
        : res.status >= 500
          ? 'server'
          : 'client'
    throw new ApiError(msg, kind, res.status, res)
  }

  if (res.status === 204) return undefined as T
  const ct = res.headers.get('Content-Type') ?? ''
  if (!ct.includes('application/json')) return undefined as T
  const json = await res.json()
  if (json && typeof json === 'object' && 'data' in json) {
    return (json as { data: T }).data
  }
  return json as T
}

// ================================================================ CRUD

export async function upsertRow(
  token: string,
  req: PublicRowRequest,
): Promise<PublicRowResponse> {
  return publicTablesFetch<PublicRowResponse>('/rows', token, {
    method: 'POST',
    body: req,
  })
}

export async function listRows(token: string): Promise<PublicRowResponse[]> {
  const res = await publicTablesFetch<{ rows: PublicRowResponse[]; count: number }>(
    '/rows',
    token,
  )
  return res.rows
}

export async function getRow(
  token: string,
  entityKey: string,
): Promise<PublicRowResponse> {
  return publicTablesFetch<PublicRowResponse>(
    `/rows/${encodeURIComponent(entityKey)}`,
    token,
  )
}

export async function patchRow(
  token: string,
  entityKey: string,
  patch: Record<string, unknown>,
): Promise<PublicRowResponse> {
  return publicTablesFetch<PublicRowResponse>(
    `/rows/${encodeURIComponent(entityKey)}`,
    token,
    { method: 'PATCH', body: patch },
  )
}

export async function deleteRow(
  token: string,
  entityKey: string,
): Promise<void> {
  await publicTablesFetch<void>(`/rows/${encodeURIComponent(entityKey)}`, token, {
    method: 'DELETE',
  })
}

// ================================================================ Bulk + filter

export interface BulkUpsertRequest {
  rows: Array<{
    entityKey: string
    payload: Record<string, unknown>
    position?: [number, number]
  }>
}
export interface BulkUpsertResponse {
  upserted: number
  errors: Array<{ index: number; error: string }>
}

export async function bulkUpsertRows(
  token: string,
  req: BulkUpsertRequest,
): Promise<BulkUpsertResponse> {
  return publicTablesFetch<BulkUpsertResponse>('/rows/bulk', token, {
    method: 'POST',
    body: req,
  })
}

export type RowSortBy = 'entity_key' | 'ts' | 'updated_at'
export type SortDir = 'asc' | 'desc'

export interface QueryRowsRequest {
  filter?: DataLinkFilter | null
  page?: number
  pageSize?: number
  sortBy?: RowSortBy
  sortDir?: SortDir
  includeCount?: boolean
}
export interface QueryRowsResponse {
  rows: PublicRowResponse[]
  page?: number
  pageSize?: number
  totalCount?: number
  truncated: boolean
}

export async function queryRows(
  token: string,
  req: QueryRowsRequest,
): Promise<QueryRowsResponse> {
  return publicTablesFetch<QueryRowsResponse>('/rows/query', token, {
    method: 'POST',
    body: req,
  })
}

export async function listRowsPaged(
  token: string,
  opts: {
    page?: number
    pageSize?: number
    sortBy?: RowSortBy
    sortDir?: SortDir
  } = {},
): Promise<QueryRowsResponse> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
  if (opts.sortBy) params.set('sortBy', opts.sortBy)
  if (opts.sortDir) params.set('sortDir', opts.sortDir)
  const q = params.toString()
  return publicTablesFetch<QueryRowsResponse>(`/rows${q ? `?${q}` : ''}`, token)
}

export interface BulkPatchRequest {
  rows: Array<{ entityKey: string; patch: Record<string, unknown> }>
}
export interface BulkPatchResponse {
  updated: number
  errors: Array<{ index: number; error: string }>
}

export async function bulkPatchRows(
  token: string,
  req: BulkPatchRequest,
): Promise<BulkPatchResponse> {
  return publicTablesFetch<BulkPatchResponse>('/rows/bulk', token, {
    method: 'PATCH',
    body: req,
  })
}

export async function patchRowsByFilter(
  token: string,
  filter: DataLinkFilter,
  patch: Record<string, unknown>,
): Promise<{ updated: number }> {
  return publicTablesFetch<{ updated: number }>('/rows/by-filter', token, {
    method: 'PATCH',
    body: { filter, patch },
  })
}

export async function bulkDeleteRows(
  token: string,
  entityKeys: string[],
): Promise<{ deleted: number }> {
  return publicTablesFetch<{ deleted: number }>('/rows/bulk', token, {
    method: 'DELETE',
    body: { entityKeys },
  })
}

export async function deleteRowsByFilter(
  token: string,
  filter: DataLinkFilter,
): Promise<{ deleted: number }> {
  return publicTablesFetch<{ deleted: number }>('/rows/by-filter', token, {
    method: 'DELETE',
    body: { filter },
  })
}

export interface PublicTableSchema {
  fields: FieldDefinitionResponse[]
  rowCount: number
}

export async function fetchTableSchema(
  token: string,
): Promise<PublicTableSchema> {
  return publicTablesFetch<PublicTableSchema>('/rows/schema', token)
}