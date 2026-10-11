-- name: CreateEntityReference :one
INSERT INTO entity_references (tenant_id, type, source_key, target_key, label, payload, source_stream_id)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, tenant_id, type, source_key, target_key, label, payload, source_stream_id, created_at, updated_at;

-- name: GetEntityReference :one
SELECT id, tenant_id, type, source_key, target_key, label, payload, source_stream_id, created_at, updated_at
FROM entity_references
WHERE id = $1 AND tenant_id = $2;

-- name: ListEntityReferences :many
SELECT id, tenant_id, type, source_key, target_key, label, payload, source_stream_id, created_at, updated_at
FROM entity_references
WHERE tenant_id = $1
ORDER BY type, source_key;

-- name: UpdateEntityReference :one
UPDATE entity_references
SET type = $3, source_key = $4, target_key = $5, label = $6, payload = $7, source_stream_id = $8, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, type, source_key, target_key, label, payload, source_stream_id, created_at, updated_at;

-- name: DeleteEntityReference :exec
DELETE FROM entity_references
WHERE id = $1 AND tenant_id = $2;
