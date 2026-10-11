-- name: CreateRoute :one
INSERT INTO routes (tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: GetRoute :one
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM routes
WHERE id = $1 AND tenant_id = $2;

-- name: ListRoutes :many
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM routes
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateRoute :one
UPDATE routes
SET name = $3, vertices = $4, rotation = $5, config = $6, zone_id = $7, floor_plan_id = $8, unit = $9, visible = $10, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: DeleteRoute :exec
DELETE FROM routes
WHERE id = $1 AND tenant_id = $2;

-- name: ListRoutesByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM routes
WHERE zone_id = $1
ORDER BY name;
