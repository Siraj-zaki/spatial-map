/**
 * Client for the v3 data-source-rows endpoints — the reusable pool
 * that backs every non-rack import (file / REST / webhook). Streaming
 * still lives in entity_states until Slice 6 unifies reads.
 *
 * Endpoints:
 *   GET    /api/v1/data-sources/:id/rows            → { rows: [], count }
 *   GET    /api/v1/data-sources/:id/rows/:entityKey → DataSourceRow
 *   DELETE /api/v1/data-sources/:id/rows            → wipes every row for a source
 *
 * Sub-renderers in Slice 6 will call `listRowsForSource(sourceId)` to
 * hydrate a DataLinkConfig's data pool. The row shape matches
 * `EntityState` closely enough that the resolver treats them the same.
 */

import { apiGet, apiDelete } from '@/lib/api-client'

/** One record produced by a DataSource. Shape mirrors EntityState. */
export interface DataSourceRow {
  id: number
  sourceId: number
  entityKey: string
  /** Raw JSON row — column values keyed by the CSV/JSON keys, un-slugged. */
  payload: Record<string, unknown>
  /** Optional world coord. `[lng, lat]`. Missing when the row had no coord fields. */
  position?: [number, number]
  /** Convenience field lifted out of the payload for attribute-join lookups. */
  linkedShapeName?: string
  /** ISO-8601. When the row was last upserted (payload changed). */
  ts: string
  updatedAt: string
}

interface ListResponse {
  rows: Array<Omit<DataSourceRow, 'ts' | 'updatedAt'> & { ts: string; updatedAt: string }>
  count: number
}

/**
 * Fetch every row a source has produced. Slice 6 will call this from
 * MapDataLinkedOverlay sub-renderers in place of
 * `listEntityStatesForStream()` for non-streaming DataLinkConfigs.
 */
export async function listRowsForSource(sourceId: number): Promise<DataSourceRow[]> {
  const body = await apiGet<ListResponse>(`/data-sources/${sourceId}/rows`)
  return body.rows.map((r) => ({
    id: r.id,
    sourceId: r.sourceId,
    entityKey: r.entityKey,
    payload: r.payload as Record<string, unknown>,
    position: r.position,
    linkedShapeName: r.linkedShapeName,
    ts: r.ts,
    updatedAt: r.updatedAt,
  }))
}

/** Fetch a single row by (sourceId, entityKey). */
export async function getRowForSource(
  sourceId: number,
  entityKey: string,
): Promise<DataSourceRow | null> {
  try {
    return await apiGet<DataSourceRow>(
      `/data-sources/${sourceId}/rows/${encodeURIComponent(entityKey)}`,
    )
  } catch (err) {
    // 404 = row absent; anything else is a real error.
    if ((err as { status?: number }).status === 404) return null
    throw err
  }
}

/**
 * Wipe every row for a source — used before a full re-import so old
 * entity_keys that vanished from the new file don't linger.
 */
export async function clearRowsForSource(sourceId: number): Promise<void> {
  await apiDelete(`/data-sources/${sourceId}/rows`)
}
