-- name: CreatePolygon :one
INSERT INTO polygons (tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, role)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role;

-- name: GetPolygon :one
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role
FROM polygons
WHERE id = $1 AND tenant_id = $2;

-- name: ListPolygons :many
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role
FROM polygons
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdatePolygon :one
UPDATE polygons
SET name = $3, vertices = $4, rotation = $5, config = $6, zone_id = $7, floor_plan_id = $8, unit = $9, visible = $10, role = $11, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role;

-- name: DeletePolygon :exec
DELETE FROM polygons
WHERE id = $1 AND tenant_id = $2;

-- name: ListPolygonsByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role
FROM polygons
WHERE zone_id = $1
ORDER BY name;
