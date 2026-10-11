-- name: CreateStair :one
INSERT INTO stairs (tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: GetStair :one
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM stairs
WHERE id = $1 AND tenant_id = $2;

-- name: ListStairs :many
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM stairs
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateStair :one
UPDATE stairs
SET name = $3, vertices = $4, rotation = $5, config = $6, zone_id = $7, floor_plan_id = $8, unit = $9, visible = $10, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: DeleteStair :exec
DELETE FROM stairs
WHERE id = $1 AND tenant_id = $2;

-- name: ListStairsByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM stairs
WHERE zone_id = $1
ORDER BY name;
