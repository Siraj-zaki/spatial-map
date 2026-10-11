/**
 * V3 Slice 6 — unified row fetcher for MapDataLinkedOverlay sub-renderers.
 *
 * A DataLinkConfig ("layer") reads its rows from ONE of two backends:
 *
 *   - `data_source_rows`  when the config has `sourceId` set (v3 path)
 *   - `entity_states`     when the config only has `streamId` (legacy)
 *
 * Both shapes are normalised to `EntityState` so downstream sub-renderers
 * (point-at-coord, point-on-shape, gauge, tint, heatmap, track, fov-cone,
 * roi-pulse) don't need to branch. See DESIGN-integrations-v3.md §5.4.
 */

import type { DataLinkConfig, DataLinkFilter, EntityState } from '@/lib/db'
import { listEntityStatesForStream } from './entity-state-service'
import { listRowsForSource, type DataSourceRow } from './data-source-rows'
import { isFilterActive, queryDataSource } from './query-client'
import { singleActiveFloor, type ActiveFloors } from './filter-evaluator'

/**
 * Fetch the layer's rows. Prefers `config.sourceId` (v3) and falls back
 * to `config.streamId` (v1/v2). Legacy configs continue to work without
 * migration.
 *
 * v4 — when a `filter` is present AND the layer has a `sourceId`, the
 * fetch goes through the server-side `POST /data-sources/:id/query`
 * endpoint so filtering happens in Postgres via JSONB. Only rows that
 * pass the filter cross the wire. `activeFloorPlanId` piggybacks on
 * the same call — no extra round trip.
 *
 * Legacy stream-backed layers can't use the DSL yet (entity_states is
 * on its own table), so they still fetch everything and the caller's
 * client-side evaluator prunes locally.
 */
export async function fetchLayerRows(
  config: DataLinkConfig,
  opts?: {
    filter?: DataLinkFilter | null
    /** One floor, several (filtered client-side) or all. */
    activeFloorPlanId?: ActiveFloors
    limit?: number
  },
): Promise<EntityState[]> {
  if (config.sourceId !== undefined && config.sourceId !== null) {
    const filter = opts?.filter ?? null
    // Floor gating is ONLY server-side-pushed when the config's
    // floorScope mode is `'auto'` — the payload-embedded floor case.
    // For `'specific'` (source pinned to a picked floor list) and
    // `'all'` (source ignores floor entirely), the backend filter would
    // wrongly drop rows whose payload has no floor key. The frontend's
    // `passesFloorScope` handles those modes cleanly on the already-
    // fetched rows, so we don't need the server to do it.
    // Same for `'auto'` with a text-field → floor map (`floorScope.field`,
    // e.g. floor: "Level 1" → 68): the server compares the raw payload
    // value against the floor id and would drop every row.
    const scope = config.fieldMapping?.floorScope
    const scopeMode = scope?.mode ?? 'auto'
    const floor =
      scopeMode === 'auto' && !scope?.field ? singleActiveFloor(opts?.activeFloorPlanId) : null
    // Server-side query path when there's actual work for it to do.
    if (isFilterActive(filter) || floor !== null || opts?.limit !== undefined) {
      const res = await queryDataSource(config.sourceId, {
        filter,
        floorPlanId: floor,
        limit: opts?.limit,
      })
      return res.rows.map(rowToEntityState)
    }
    // No filter — cheap plain list keeps the existing cache warm.
    const rows = await listRowsForSource(config.sourceId)
    return rows.map(rowToEntityState)
  }
  return listEntityStatesForStream(config.streamId)
}

/**
 * Adapter: DataSourceRow → EntityState. Preserves the payload verbatim
 * (so match-resolver semantics don't change) and lifts `position` +
 * timestamps to the fields sub-renderers already read.
 */
function rowToEntityState(row: DataSourceRow): EntityState {
  return {
    id: row.id,
    // streamId is not meaningful for a v3 row, but sub-renderers use
    // it only as a display / debug hint. Stamp 0 as a sentinel; the
    // resolver never inspects it.
    streamId: 0,
    entityKey: row.entityKey,
    payload: row.payload,
    position: row.position,
    lastSeenAt: new Date(row.ts),
    updatedAt: new Date(row.updatedAt),
  }
}
