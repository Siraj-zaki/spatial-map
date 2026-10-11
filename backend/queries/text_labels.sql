-- name: CreateTextLabel :one
INSERT INTO text_labels (tenant_id, name, lng, lat, rotation, config, zone_id, floor_plan_id, unit, visible)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: GetTextLabel :one
SELECT * FROM text_labels
WHERE id = $1 AND tenant_id = $2;

-- name: ListTextLabels :many
SELECT * FROM text_labels
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateTextLabel :one
UPDATE text_labels
SET name = $3, lng = $4, lat = $5, rotation = $6, config = $7, zone_id = $8, floor_plan_id = $9, unit = $10, visible = $11, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING *;

-- name: DeleteTextLabel :exec
DELETE FROM text_labels
WHERE id = $1 AND tenant_id = $2;

-- name: ListTextLabelsByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT * FROM text_labels
WHERE zone_id = $1
ORDER BY name;
