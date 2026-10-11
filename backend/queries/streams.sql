-- name: CreateStream :one
INSERT INTO streams (tenant_id, connection_id, data_source_id, name, entity_type, kind, binding, endpoint, zone_id, schedule, interval_seconds)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id, tenant_id, connection_id, data_source_id, name, entity_type, kind, binding, endpoint, zone_id, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, deleted_at;

-- name: GetStream :one
SELECT id, tenant_id, connection_id, data_source_id, name, entity_type, kind, binding, endpoint, zone_id, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, deleted_at
FROM streams
WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL;

-- name: ListStreams :many
SELECT id, tenant_id, connection_id, data_source_id, name, entity_type, kind, binding, endpoint, zone_id, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, deleted_at
FROM streams
WHERE tenant_id = $1 AND deleted_at IS NULL
ORDER BY name;

-- name: ListStreamsIncludingArchived :many
SELECT id, tenant_id, connection_id, data_source_id, name, entity_type, kind, binding, endpoint, zone_id, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, deleted_at
FROM streams
WHERE tenant_id = $1
ORDER BY deleted_at NULLS FIRST, name;

-- name: UpdateStream :one
UPDATE streams
SET connection_id = $3, data_source_id = $4, name = $5, entity_type = $6, kind = $7, binding = $8, endpoint = $9, zone_id = $10, schedule = $11, interval_seconds = $12, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, connection_id, data_source_id, name, entity_type, kind, binding, endpoint, zone_id, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, deleted_at;

-- name: SoftDeleteStream :exec
UPDATE streams
SET deleted_at = now(), updated_at = now()
WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL;

-- name: DeleteStream :exec
DELETE FROM streams
WHERE id = $1 AND tenant_id = $2;

-- name: GetStreamByToken :one
SELECT id, tenant_id, connection_id, data_source_id, name, entity_type, kind, binding, endpoint, zone_id, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, deleted_at
FROM streams
WHERE endpoint ->> 'sourceToken' = $1::text AND deleted_at IS NULL;
