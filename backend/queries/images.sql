-- name: CreateImage :one
INSERT INTO images (tenant_id, name, start_lng, start_lat, current_lng, current_lat, rotation, image_url, image_data, mime_type, natural_width, natural_height, config, zone_id, floor_plan_id, unit, visible)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
RETURNING *;

-- name: GetImage :one
SELECT * FROM images
WHERE id = $1 AND tenant_id = $2;

-- name: ListImages :many
SELECT * FROM images
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateImage :one
UPDATE images
SET name = $3, start_lng = $4, start_lat = $5, current_lng = $6, current_lat = $7, rotation = $8, image_url = $9, image_data = $10, mime_type = $11, natural_width = $12, natural_height = $13, config = $14, zone_id = $15, floor_plan_id = $16, unit = $17, visible = $18, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING *;

-- name: DeleteImage :exec
DELETE FROM images
WHERE id = $1 AND tenant_id = $2;

-- name: ListImagesByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT * FROM images
WHERE zone_id = $1
ORDER BY name;
