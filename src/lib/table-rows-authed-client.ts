/**
 * Authed per-table row CRUD client. Hits `/api/v1/tables/:id/rows/...`
 * with the SPA's JWT + tenant headers (auto-injected by `apiGet`/`apiPost`
 * /`apiPatch`/`apiPut`/`apiDelete` from `api-client.ts`).
 *
 * This is the SPA's OWN data-grid surface — distinct from the bearer-
 * token public surface in `table-rows-public-client.ts`. The SPA can't
 * use the public surface because it doesn't have the plaintext table
 * token after the create-time mint; it only has the hashed version
 * stored on `table_api_tokens`. So the SPA authenticates as the logged-
 * in user against the authed routes mounted inside `TablesRouter`'s
 * `/{id}/rows` block (see backend/internal/handlers/table_rows_authed.go).
 *
 * Wire shapes mirror the public client so the data grid can swap to
 * the public surface for a "try it with my token" mode later without
 * touching the component.
 */

import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api-client'
import type { DataLinkFilter } from '@/lib/db'
import type { FieldDefinitionResponse } from '@/lib/tables-client'

export interface AuthedRowRequest {
  entityKey: string
  payload: Record<string, unknown>
  position?: [number, number] // [lng, lat]
}

export interface AuthedRowResponse {
  entityKey: string
  payload: Record<string, unknown>
  position?: [number, number]
  ts: string
  updatedAt: string
}

/** Built-in columns, or `field:<key>` for any declared field (the list
 *  endpoint sorts numbers numerically; `/query` ignores field sorts). */
export type AuthedRowSortBy = 'entity_key' | 'ts' | 'updated_at' | `field:${string}`
export type SortDir = 'asc' | 'desc'

export interface AuthedListRowsOpts {
  page?: number
  pageSize?: number
  sortBy?: AuthedRowSortBy
  sortDir?: SortDir
  /** Case-insensitive match on the row key or any value. */
  q?: string
}
export interface AuthedListRowsResponse {
  rows: AuthedRowResponse[]
  page: number
  pageSize: number
  totalCount: number
}

export interface AuthedQueryRowsRequest {
  filter?: DataLinkFilter | null
  page?: number
  pageSize?: number
  sortBy?: AuthedRowSortBy
  sortDir?: SortDir
  includeCount?: boolean
}
export interface AuthedQueryRowsResponse {
  rows: AuthedRowResponse[]
  page?: number
  pageSize?: number
  totalCount?: number
  truncated: boolean
}

export interface AuthedBulkUpsertRequest {
  rows: Array<{
    entityKey: string
    payload: Record<string, unknown>
    position?: [number, number]
  }>
}
export interface AuthedBulkUpsertResponse {
  upserted: number
  errors: Array<{ index: number; error: string }>
}

export interface AuthedBulkPatchRequest {
  rows: Array<{ entityKey: string; patch: Record<string, unknown> }>
}
export interface AuthedBulkPatchResponse {
  updated: number
  errors: Array<{ index: number; error: string }>
}

// ================================================================ CRUD

function rowsPath(tableId: number, suffix?: string): string {
  const base = `/tables/${tableId}/rows`
  return suffix ? `${base}${suffix}` : base
}

export async function upsertAuthedRow(
  tableId: number,
  req: AuthedRowRequest,
): Promise<AuthedRowResponse> {
  return apiPost<AuthedRowResponse>(rowsPath(tableId), req)
}

export async function listAuthedRows(
  tableId: number,
  opts: AuthedListRowsOpts = {},
): Promise<AuthedListRowsResponse> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
  if (opts.sortBy) params.set('sortBy', opts.sortBy)
  if (opts.sortDir) params.set('sortDir', opts.sortDir)
  if (opts.q?.trim()) params.set('q', opts.q.trim())
  const q = params.toString()
  return apiGet<AuthedListRowsResponse>(rowsPath(tableId, q ? `?${q}` : ''))
}

export async function getAuthedRow(
  tableId: number,
  entityKey: string,
): Promise<AuthedRowResponse> {
  return apiGet<AuthedRowResponse>(
    rowsPath(tableId, `/${encodeURIComponent(entityKey)}`),
  )
}

export async function patchAuthedRow(
  tableId: number,
  entityKey: string,
  patch: Record<string, unknown>,
): Promise<AuthedRowResponse> {
  return apiPatch<AuthedRowResponse>(
    rowsPath(tableId, `/${encodeURIComponent(entityKey)}`),
    patch,
  )
}

/** Full-replace PUT — overwrites the row's payload with the request body. */
export async function putAuthedRow(
  tableId: number,
  entityKey: string,
  req: AuthedRowRequest,
): Promise<AuthedRowResponse> {
  return apiPut<AuthedRowResponse>(
    rowsPath(tableId, `/${encodeURIComponent(entityKey)}`),
    req,
  )
}

export async function deleteAuthedRow(
  tableId: number,
  entityKey: string,
): Promise<void> {
  await apiDelete<void>(rowsPath(tableId, `/${encodeURIComponent(entityKey)}`))
}

// ================================================================ Bulk + filter

export async function bulkUpsertAuthedRows(
  tableId: number,
  req: AuthedBulkUpsertRequest,
): Promise<AuthedBulkUpsertResponse> {
  return apiPost<AuthedBulkUpsertResponse>(rowsPath(tableId, '/bulk'), req)
}

export async function queryAuthedRows(
  tableId: number,
  req: AuthedQueryRowsRequest,
): Promise<AuthedQueryRowsResponse> {
  return apiPost<AuthedQueryRowsResponse>(rowsPath(tableId, '/query'), req)
}

export async function bulkPatchAuthedRows(
  tableId: number,
  req: AuthedBulkPatchRequest,
): Promise<AuthedBulkPatchResponse> {
  return apiPatch<AuthedBulkPatchResponse>(rowsPath(tableId, '/bulk'), req)
}

export async function patchAuthedRowsByFilter(
  tableId: number,
  filter: DataLinkFilter,
  patch: Record<string, unknown>,
): Promise<{ updated: number }> {
  return apiPatch<{ updated: number }>(rowsPath(tableId, '/by-filter'), {
    filter,
    patch,
  })
}

export async function bulkDeleteAuthedRows(
  tableId: number,
  entityKeys: string[],
): Promise<{ deleted: number }> {
  return apiDelete<{ deleted: number }>(rowsPath(tableId, '/bulk'), {
    body: { entityKeys },
  })
}

export async function deleteAuthedRowsByFilter(
  tableId: number,
  filter: DataLinkFilter,
): Promise<{ deleted: number }> {
  return apiDelete<{ deleted: number }>(rowsPath(tableId, '/by-filter'), {
    body: { filter },
  })
}

export interface AuthedTableSchema {
  fields: FieldDefinitionResponse[]
  rowCount: number
}

export async function fetchAuthedTableSchema(
  tableId: number,
): Promise<AuthedTableSchema> {
  return apiGet<AuthedTableSchema>(rowsPath(tableId, '/schema'))
}