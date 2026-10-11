/**
 * Client for the generic `entity_states` endpoints (DESIGN-data-link.md
 * Slice 1c). Replaces per-entity service files (asset-service,
 * sensor-service, camera-service, shipment-service, rfid-service) with
 * a single stream-scoped fetch that returns raw payloads. The frontend
 * DataLinkConfig.fieldMapping decides how to interpret each row.
 *
 * Auth: routes through the same X-Api-Key + X-Tenant-Id `apiGet`
 * wrapper the other services use.
 */

import { apiGet } from '@/lib/api-client'
import type { EntityEvent, EntityState } from '@/lib/db'

/**
 * Wire response for GET /api/v1/streams/{id}/entities. `position` is
 * `[lng, lat] | undefined` when the publisher includes coord fields.
 * `lastSeenAt` / `updatedAt` come across as RFC3339 strings and get
 * parsed into Date objects by `parseRow` before we hand them to the
 * overlay.
 */
interface EntityStateResponse {
  id: number
  streamId: number
  entityKey: string
  payload: Record<string, unknown>
  position?: [number, number]
  lastSeenAt: string
  updatedAt: string
}

function parseRow(r: EntityStateResponse): EntityState {
  return {
    id: r.id,
    streamId: r.streamId,
    entityKey: r.entityKey,
    payload: r.payload,
    position: r.position,
    lastSeenAt: new Date(r.lastSeenAt),
    updatedAt: new Date(r.updatedAt),
  }
}

/**
 * Latest known state per entity for one stream. Called on a short
 * interval by the generic overlay; the SSE bus invalidates the query
 * cache whenever an ingest lands so a fresh event forces an immediate
 * refetch without waiting for the poll tick.
 */
export async function listEntityStatesForStream(
  streamId: number,
): Promise<EntityState[]> {
  const rows = await apiGet<EntityStateResponse[]>(
    `/streams/${streamId}/entities`,
  )
  return rows.map(parseRow)
}

/**
 * Wire response for GET /api/v1/streams/{id}/events?window=SEC&limit=N.
 * Order: newest first. Consumed by `heatmap` (density weight) and
 * `track` (LineString by ts ascending after client-side reverse) render
 * modes.
 */
interface EntityEventResponse {
  id: number
  streamId: number
  entityKey: string
  payload: Record<string, unknown>
  ts: string
}

function parseEvent(r: EntityEventResponse): EntityEvent {
  return {
    id: r.id,
    streamId: r.streamId,
    entityKey: r.entityKey,
    payload: r.payload,
    ts: new Date(r.ts),
  }
}

/**
 * Recent event log for one stream. Defaults to a 60 s window + 500-row
 * cap; callers override via `windowSec` / `limit`. Heatmap uses the
 * default; track uses a wider window (e.g. 5 min) since a shipment's
 * breadcrumb is more valuable over a longer horizon.
 */
export async function listEntityEventsForStream(
  streamId: number,
  options: { windowSec?: number; limit?: number } = {},
): Promise<EntityEvent[]> {
  const params = new URLSearchParams()
  if (options.windowSec !== undefined) params.set('window', String(options.windowSec))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const rows = await apiGet<EntityEventResponse[]>(
    `/streams/${streamId}/events${suffix}`,
  )
  return rows.map(parseEvent)
}

// ============================================================ tenant-wide

/**
 * Wire response for GET /api/v1/entity-states — the tenant-wide join
 * with `streams`. Adds `entityType` (from the stream config, not the
 * payload) + `streamName` so viewers can group live records by kind
 * without a second round-trip to /streams.
 *
 * Slice 6c2: replaces the four per-entity endpoints (assets, sensors,
 * cameras, shipments) with one aggregate call. Payload interpretation
 * still happens client-side via the DataLinkConfig.fieldMapping.
 */
interface EntityStateWithStreamResponse extends EntityStateResponse {
  entityType: string
  streamName: string
}

/**
 * Runtime shape used by the viewer's sidebar / detail panel. Extends
 * the base EntityState with the two stream-derived fields so a single
 * value carries everything the UI needs to render a live record row.
 */
export interface EntityStateWithStream extends EntityState {
  entityType: string
  streamName: string
}

function parseWithStream(r: EntityStateWithStreamResponse): EntityStateWithStream {
  return {
    ...parseRow(r),
    entityType: r.entityType,
    streamName: r.streamName,
  }
}

/**
 * Fetch every live entity across every stream in the caller's tenant.
 * Backed by ListEntityStatesWithStreamByTenant which caps at 2000 rows
 * server-side. The viewer filters client-side by `entityType` to drive
 * the asset / sensor / camera / shipment sidebar groupings.
 */
export async function listAllEntityStatesForTenant(): Promise<EntityStateWithStream[]> {
  const rows = await apiGet<EntityStateWithStreamResponse[]>('/entity-states')
  return rows.map(parseWithStream)
}
