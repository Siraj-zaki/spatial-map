-- name: CreateUserModel :one
INSERT INTO user_models (tenant_id, name, mime_type, model_url, data, bytes, category, default_scale, bounding_center, inspector, thumbnail, zone_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
  (SELECT z.id FROM zones z WHERE z.id = sqlc.narg(zone_id)::bigint AND z.tenant_id = $1))
RETURNING *;

-- name: GetUserModel :one
SELECT * FROM user_models
WHERE id = $1 AND tenant_id = $2;

-- name: ListUserModels :many
SELECT * FROM user_models
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateUserModel :one
UPDATE user_models
SET name = $3, mime_type = $4, model_url = $5, data = $6, bytes = $7, category = $8, default_scale = $9, bounding_center = $10, inspector = $11, thumbnail = $12,
    zone_id = (SELECT z.id FROM zones z WHERE z.id = sqlc.narg(zone_id)::bigint AND z.tenant_id = $2)
WHERE user_models.id = $1 AND user_models.tenant_id = $2
RETURNING *;

-- name: DeleteUserModel :exec
DELETE FROM user_models
WHERE id = $1 AND tenant_id = $2;

-- name: CountUserModelsByURL :one
-- Catalog rows in this workspace still pointing at a model file; the
-- catalog delete drops the workspace's ownership of the file at zero.
SELECT COUNT(*)::bigint FROM user_models WHERE tenant_id = $1 AND model_url = $2;

-- name: ListUserModelBounds :many
-- The local bounding boxes (inspector.bounds) of a facility's 3D models,
-- for the facility envelope: the mobile app routes around their footprints.
SELECT id, coalesce(inspector->'bounds', 'null'::jsonb)::jsonb AS bounds
FROM user_models
WHERE tenant_id = $1 AND id = ANY(sqlc.arg(ids)::bigint[]);
