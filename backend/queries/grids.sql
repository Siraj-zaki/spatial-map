-- name: CreateGrid :one
INSERT INTO grids (tenant_id, name, start_lng, start_lat, current_lng, current_lat, config, zone_id, floor_plan_id, visible)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id, tenant_id, name, start_lng, start_lat, current_lng, current_lat, config, zone_id, floor_plan_id, created_at, updated_at, visible;

-- name: GetGrid :one
SELECT id, tenant_id, name, start_lng, start_lat, current_lng, current_lat, config, zone_id, floor_plan_id, created_at, updated_at, visible
FROM grids
WHERE id = $1 AND tenant_id = $2;

-- name: ListGrids :many
SELECT id, tenant_id, name, start_lng, start_lat, current_lng, current_lat, config, zone_id, floor_plan_id, created_at, updated_at, visible
FROM grids
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateGrid :one
UPDATE grids
SET name = $3, start_lng = $4, start_lat = $5, current_lng = $6, current_lat = $7, config = $8, zone_id = $9, floor_plan_id = $10, visible = $11, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, start_lng, start_lat, current_lng, current_lat, config, zone_id, floor_plan_id, created_at, updated_at, visible;

-- name: DeleteGrid :exec
DELETE FROM grids
WHERE id = $1 AND tenant_id = $2;

-- name: ListGridsByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT id, tenant_id, name, start_lng, start_lat, current_lng, current_lat, config, zone_id, floor_plan_id, created_at, updated_at, visible
FROM grids
WHERE zone_id = $1
ORDER BY name;
