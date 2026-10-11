-- name: CreateAttributeDefinition :one
INSERT INTO attribute_definitions (tenant_id, zone_id, scope, key, label, type, unit, enum_values, default_value, description)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id, tenant_id, zone_id, scope, key, label, type, unit, enum_values, default_value, description, created_at;

-- name: GetAttributeDefinition :one
SELECT id, tenant_id, zone_id, scope, key, label, type, unit, enum_values, default_value, description, created_at
FROM attribute_definitions
WHERE id = $1 AND tenant_id = $2;

-- name: ListAttributeDefinitions :many
-- Returns rows visible to the calling warehouse: tenant-shared
-- (zone_id IS NULL) plus rows scoped to this warehouse. Pass zone_id =
-- NULL to list only tenant-shared rows (used for tenant admin views).
SELECT id, tenant_id, zone_id, scope, key, label, type, unit, enum_values, default_value, description, created_at
FROM attribute_definitions
WHERE tenant_id = $1 AND (zone_id IS NULL OR zone_id = $2)
ORDER BY scope, key;

-- name: UpdateAttributeDefinition :one
UPDATE attribute_definitions
SET zone_id = $3, scope = $4, key = $5, label = $6, type = $7, unit = $8, enum_values = $9, default_value = $10, description = $11
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, zone_id, scope, key, label, type, unit, enum_values, default_value, description, created_at;

-- name: DeleteAttributeDefinition :exec
DELETE FROM attribute_definitions
WHERE id = $1 AND tenant_id = $2;