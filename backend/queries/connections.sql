-- name: CreateConnection :one
INSERT INTO connections (tenant_id, name, transport, auth, config)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, tenant_id, name, transport, auth, config, created_at, updated_at, deleted_at;

-- name: GetConnection :one
SELECT id, tenant_id, name, transport, auth, config, created_at, updated_at, deleted_at
FROM connections
WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL;

-- name: ListConnections :many
SELECT id, tenant_id, name, transport, auth, config, created_at, updated_at, deleted_at
FROM connections
WHERE tenant_id = $1 AND deleted_at IS NULL
ORDER BY name;

-- name: UpdateConnection :one
UPDATE connections
SET name = $3, transport = $4, auth = $5, config = $6, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, transport, auth, config, created_at, updated_at, deleted_at;

-- name: SoftDeleteConnection :exec
UPDATE connections
SET deleted_at = now(), updated_at = now()
WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL;

-- name: DeleteConnection :exec
DELETE FROM connections
WHERE id = $1 AND tenant_id = $2;
