/**
 * v4 — clients for the two data-source query endpoints:
 *
 *   GET  /api/v1/data-sources/:id/schema
 *   POST /api/v1/data-sources/:id/query
 *
 * Both endpoints translate JSONB payload semantics to safe parameterized
 * SQL on the server, so the frontend never fetches the full row set to
 * apply a filter — the DB does the work. See
 * `backend/internal/handlers/data_source_query.go` for the compiler.
 *
 * The DSL types (`DataLinkFilter`, `DataLinkFilterCondition`,
 * `DataLinkFilterGroup`, etc.) live in `@/lib/db` alongside
 * `DataLinkConfig` so both the editor and the runtime overlay reach
 * for the same tree shape.
 */

import { apiGet, apiPost } from '@/lib/api-client'
import type {
  DataLinkFieldType,
  DataLinkFilter,
  DataLinkFilterCondition,
  DataLinkFilterGroup,
} from '@/lib/db'
import type { DataSourceRow } from './data-source-rows'

/**
 * One detected payload field on a data source. Returned by GET /schema.
 * The editor + filter widget consume this to render type-aware controls.
 */
export interface DataSourceFieldSchema {
  field: string
  type: DataLinkFieldType
  nonNullCount: number
  distinctCount: number
  /** Up to 20 distinct string reps — feeds enum-picker / suggestion pills. */
  sample?: string[]
  numericMin?: number
  numericMax?: number
}

export interface DataSourceSchema {
  fields: DataSourceFieldSchema[]
  rowCount: number
}

export async function fetchDataSourceSchema(
  sourceId: number,
): Promise<DataSourceSchema> {
  const body = await apiGet<{
    fields: DataSourceFieldSchema[]
    rowCount: number
  }>(`/data-sources/${sourceId}/schema`)
  return body
}

// -------------------------------------------------------------- query

/**
 * Request body for /query. `filter` mirrors the FE DSL tree exactly —
 * the backend understands both `{ kind: 'condition', … }` and
 * `{ kind: 'group', … }` recursively.
 *
 * `includeCount` triggers a second COUNT(*) query so the filter widget
 * can show "N of M". Skip it on the hot render path to keep the
 * response < 5 ms.
 */
export interface DataSourceQueryRequest {
  filter?: DataLinkFilter | null
  floorPlanId?: number | null
  limit?: number
  offset?: number
  includeCount?: boolean
}

export interface DataSourceQueryResponse {
  rows: DataSourceRow[]
  totalCount?: number
  truncated: boolean
}

/**
 * Server-side filter execution. Sub-renderers use this when a
 * `DataLinkConfig.sourceId` is set AND the layer has an active filter;
 * the backend narrows the row set on the DB side so the wire payload
 * matches the visual — no client-side "fetch everything then drop 99%."
 *
 * A `null` / undefined filter falls through to a plain tenant-scoped
 * list, so callers can use this endpoint uniformly.
 */
export async function queryDataSource(
  sourceId: number,
  req: DataSourceQueryRequest,
): Promise<DataSourceQueryResponse> {
  const body = await apiPost<{
    rows: Array<
      Omit<DataSourceRow, 'ts' | 'updatedAt'> & { ts: string; updatedAt: string }
    >
    totalCount?: number
    truncated: boolean
  }>(`/data-sources/${sourceId}/query`, req)
  return {
    rows: body.rows.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      entityKey: r.entityKey,
      payload: r.payload as Record<string, unknown>,
      position: r.position,
      linkedShapeName: r.linkedShapeName,
      ts: r.ts,
      updatedAt: r.updatedAt,
    })),
    totalCount: body.totalCount,
    truncated: body.truncated,
  }
}

// ---------------------------------------------------- DSL helpers

/**
 * Normalise a legacy flat filter shape (`{field, op, value}`) into a
 * proper `DataLinkFilterCondition` tree node so downstream code only
 * has to handle one form. New saves always store the tree form.
 */
export function normaliseFilter(
  f: DataLinkFilter | null | undefined,
): DataLinkFilterCondition | DataLinkFilterGroup | null {
  if (!f) return null
  if ('kind' in f) return f
  // Legacy flat shape.
  if (!f.field || !f.op) return null
  return {
    kind: 'condition',
    field: f.field,
    op: f.op,
    value: f.value,
  }
}

/** True when a filter has at least one usable leaf. */
export function isFilterActive(f: DataLinkFilter | null | undefined): boolean {
  const n = normaliseFilter(f)
  if (!n) return false
  if (n.kind === 'condition') return !!n.field && !!n.op
  return n.conditions.some((c) => isFilterActive(c))
}
