-- name: CreateImagePlane :one
INSERT INTO image_planes (tenant_id, name, lng, lat, image_url, mime_type, natural_width, natural_height, config, zone_id, floor_plan_id, unit, visible)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING id, tenant_id, name, lng, lat, image_url, mime_type, natural_width, natural_height, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: GetImagePlane :one
SELECT id, tenant_id, name, lng, lat, image_url, mime_type, natural_width, natural_height, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM image_planes
WHERE id = $1 AND tenant_id = $2;

-- name: ListImagePlanes :many
SELECT id, tenant_id, name, lng, lat, image_url, mime_type, natural_width, natural_height, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM image_planes
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateImagePlane :one
UPDATE image_planes
SET name = $3, lng = $4, lat = $5, image_url = $6, mime_type = $7, natural_width = $8, natural_height = $9, config = $10, zone_id = $11, floor_plan_id = $12, unit = $13, visible = $14, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, lng, lat, image_url, mime_type, natural_width, natural_height, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: DeleteImagePlane :exec
DELETE FROM image_planes
WHERE id = $1 AND tenant_id = $2;

-- name: ListImagePlanesByZone :many
SELECT id, tenant_id, name, lng, lat, image_url, mime_type, natural_width, natural_height, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM image_planes
WHERE zone_id = $1
ORDER BY name;
