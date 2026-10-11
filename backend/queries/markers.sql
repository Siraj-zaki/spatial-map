-- name: CreateMarker :one
INSERT INTO markers (tenant_id, name, lng, lat, bearing, config, zone_id, floor_plan_id, unit, visible)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id, tenant_id, name, lng, lat, bearing, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: GetMarker :one
SELECT id, tenant_id, name, lng, lat, bearing, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM markers
WHERE id = $1 AND tenant_id = $2;

-- name: ListMarkers :many
SELECT id, tenant_id, name, lng, lat, bearing, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM markers
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateMarker :one
UPDATE markers
SET name = $3, lng = $4, lat = $5, bearing = $6, config = $7, zone_id = $8, floor_plan_id = $9, unit = $10, visible = $11, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, lng, lat, bearing, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: DeleteMarker :exec
DELETE FROM markers
WHERE id = $1 AND tenant_id = $2;

-- name: ListMarkersByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT id, tenant_id, name, lng, lat, bearing, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM markers
WHERE zone_id = $1
ORDER BY name;
