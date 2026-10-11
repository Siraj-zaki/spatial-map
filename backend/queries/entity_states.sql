-- name: UpsertEntityState :one
-- Upsert on (stream_id, entity_key). position is nullable — pass NULL
-- (via `ST_GeomFromText`) when the payload has no lng/lat.
-- Out-of-order guard: an event older than the stored state does not
-- overwrite it (devices batch and retry, so arrival order is not event
-- order). The statement then returns no row — callers treat
-- pgx.ErrNoRows as "stale", still log the event, and move on.
INSERT INTO entity_states (tenant_id, stream_id, entity_key, payload, position, last_seen_at)
VALUES (
  sqlc.arg(tenant_id), sqlc.arg(stream_id), sqlc.arg(entity_key),
  sqlc.arg(payload),
  ST_GeomFromText(NULLIF(sqlc.arg(position_wkt)::text, ''), 4326),
  sqlc.arg(last_seen_at)
)
ON CONFLICT (stream_id, entity_key)
DO UPDATE SET
  payload      = EXCLUDED.payload,
  position     = EXCLUDED.position,
  last_seen_at = EXCLUDED.last_seen_at,
  updated_at   = now()
WHERE entity_states.last_seen_at <= EXCLUDED.last_seen_at
RETURNING id, tenant_id, stream_id, entity_key, payload,
          (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
          last_seen_at, updated_at;

-- name: GetEntityState :one
SELECT id, tenant_id, stream_id, entity_key, payload,
       (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
       last_seen_at, updated_at
FROM entity_states
WHERE stream_id = $1 AND entity_key = $2 AND tenant_id = $3;

-- name: ListEntityStatesByStream :many
SELECT id, tenant_id, stream_id, entity_key, payload,
       (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
       last_seen_at, updated_at
FROM entity_states
WHERE stream_id = $1 AND tenant_id = $2
ORDER BY last_seen_at DESC;

-- name: ListEntityStatesByTenant :many
-- Fresh-only view — respects a "seen within window" filter for the
-- viewer to drop stale entities without a payload scan.
SELECT id, tenant_id, stream_id, entity_key, payload,
       (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
       last_seen_at, updated_at
FROM entity_states
WHERE tenant_id = $1
  AND ($2::TIMESTAMPTZ IS NULL OR last_seen_at >= $2)
ORDER BY last_seen_at DESC;

-- name: ListEntityStatesWithStreamByTenant :many
-- Tenant-wide join with `streams` so the viewer sidebar can group
-- everything a warehouse's tenant is streaming without N per-entity
-- fetches. entity_type comes from the stream (not the payload) —
-- publishers just push raw JSON and the stream config classifies it.
SELECT s.id, s.tenant_id, s.stream_id, s.entity_key, s.payload,
       (COALESCE(ST_AsText(s.position)::text, ''))::text AS position_wkt,
       s.last_seen_at, s.updated_at,
       st.entity_type, st.name AS stream_name
FROM entity_states s
JOIN streams st ON st.id = s.stream_id
WHERE s.tenant_id = $1
ORDER BY s.last_seen_at DESC
LIMIT 2000;

-- name: DeleteEntityStatesForStream :exec
DELETE FROM entity_states
WHERE stream_id = $1 AND tenant_id = $2;

-- name: DeleteEntityState :exec
DELETE FROM entity_states
WHERE stream_id = $1 AND entity_key = $2 AND tenant_id = $3;
