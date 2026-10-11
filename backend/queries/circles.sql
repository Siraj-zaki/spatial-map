-- name: CreateCircle :one
INSERT INTO circles (tenant_id, name, mode, center_lng, center_lat, radius, start_lng, start_lat, current_lng, current_lat, cell_radius, cell_size, rotation, config, zone_id, floor_plan_id, unit, visible, role)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
RETURNING id, tenant_id, name, mode, center_lng, center_lat, radius, start_lng, start_lat, current_lng, current_lat, cell_radius, cell_size, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role;

-- name: GetCircle :one
SELECT id, tenant_id, name, mode, center_lng, center_lat, radius, start_lng, start_lat, current_lng, current_lat, cell_radius, cell_size, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role
FROM circles
WHERE id = $1 AND tenant_id = $2;

-- name: ListCircles :many
SELECT id, tenant_id, name, mode, center_lng, center_lat, radius, start_lng, start_lat, current_lng, current_lat, cell_radius, cell_size, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role
FROM circles
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateCircle :one
UPDATE circles
SET name = $3, mode = $4, center_lng = $5, center_lat = $6, radius = $7, start_lng = $8, start_lat = $9, current_lng = $10, current_lat = $11, cell_radius = $12, cell_size = $13, rotation = $14, config = $15, zone_id = $16, floor_plan_id = $17, unit = $18, visible = $19, role = $20, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, mode, center_lng, center_lat, radius, start_lng, start_lat, current_lng, current_lat, cell_radius, cell_size, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role;

-- name: DeleteCircle :exec
DELETE FROM circles
WHERE id = $1 AND tenant_id = $2;

-- name: ListCirclesByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT id, tenant_id, name, mode, center_lng, center_lat, radius, start_lng, start_lat, current_lng, current_lat, cell_radius, cell_size, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at, role
FROM circles
WHERE zone_id = $1
ORDER BY name;
