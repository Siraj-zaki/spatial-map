-- V3 Slice 2 — CRUD for the reusable data pool.
--
-- Every non-rack file/REST/webhook import upserts here. Streaming
-- sources keep hitting entity_states for now; Slice 6 unifies reads.
--
-- Semantics: latest-row-per-(source_id, entity_key). Position is
-- optional — for rows with lng/lat we stamp it via ST_GeomFromText.
-- Empty WKT collapses to NULL via `NULLIF(...)` so PostGIS doesn't
-- error on rows without coordinates.

-- name: UpsertDataSourceRow :one
INSERT INTO data_source_rows (tenant_id, source_id, entity_key, payload, position, linked_shape_name, ts)
VALUES (
  sqlc.arg(tenant_id),
  sqlc.arg(source_id),
  sqlc.arg(entity_key),
  sqlc.arg(payload),
  ST_GeomFromText(NULLIF(sqlc.arg(position_wkt)::text, ''), 4326),
  sqlc.arg(linked_shape_name),
  sqlc.arg(ts)
)
ON CONFLICT (source_id, entity_key)
DO UPDATE SET
  payload           = EXCLUDED.payload,
  position          = EXCLUDED.position,
  linked_shape_name = EXCLUDED.linked_shape_name,
  ts                = EXCLUDED.ts,
  updated_at        = now()
RETURNING id, tenant_id, source_id, entity_key, payload,
          (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
          linked_shape_name, ts, updated_at;

-- name: GetDataSourceRow :one
SELECT id, tenant_id, source_id, entity_key, payload,
       (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
       linked_shape_name, ts, updated_at
FROM data_source_rows
WHERE source_id = $1 AND entity_key = $2 AND tenant_id = $3;

-- name: ListDataSourceRows :many
SELECT id, tenant_id, source_id, entity_key, payload,
       (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
       linked_shape_name, ts, updated_at
FROM data_source_rows
WHERE source_id = $1 AND tenant_id = $2
ORDER BY ts DESC;

-- name: ListDataSourceRowsByTenant :many
-- Tenant-wide view — used by the layer editor when it needs to
-- preview rows before the user picks a specific source.
SELECT id, tenant_id, source_id, entity_key, payload,
       (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
       linked_shape_name, ts, updated_at
FROM data_source_rows
WHERE tenant_id = $1
ORDER BY ts DESC
LIMIT $2;

-- name: DeleteDataSourceRowsBySource :exec
-- Wipes every row for a source (used when the user re-imports a file
-- from scratch — same source_id, but rows should not accumulate old
-- entity_keys that vanished from the new import).
DELETE FROM data_source_rows
WHERE source_id = $1 AND tenant_id = $2;

-- name: DeleteDataSourceRow :exec
-- Single-row delete — used by the public CRUD `DELETE /tables/{id}/rows/{key}`
-- path. The handler also writes a `data_source_row_events` row with
-- operation='delete' BEFORE calling this so the last-known state survives
-- in the history table for the recap animation.
DELETE FROM data_source_rows
WHERE source_id = $1 AND entity_key = $2 AND tenant_id = $3;

-- name: CountDataSourceRows :one
SELECT COUNT(*)::BIGINT AS n
FROM data_source_rows
WHERE source_id = $1 AND tenant_id = $2;
