-- name: CreateModel :one
INSERT INTO models (tenant_id, name, lng, lat, config, zone_id, floor_plan_id, unit, visible)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, tenant_id, name, lng, lat, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: GetModel :one
SELECT id, tenant_id, name, lng, lat, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM models
WHERE id = $1 AND tenant_id = $2;

-- name: ListModels :many
SELECT id, tenant_id, name, lng, lat, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM models
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateModel :one
UPDATE models
SET name = $3, lng = $4, lat = $5, config = $6, zone_id = $7, floor_plan_id = $8, unit = $9, visible = $10, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, lng, lat, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: DeleteModel :exec
DELETE FROM models
WHERE id = $1 AND tenant_id = $2;

-- name: ListModelsByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT id, tenant_id, name, lng, lat, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM models
WHERE zone_id = $1
ORDER BY name;
