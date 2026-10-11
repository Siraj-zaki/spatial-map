-- Queries that support the object-store cleanup path (see
-- internal/handlers/file_cleanup.go). Every column that stores a
-- `/files/<key>` URL is checked here; when a new URL-holding column is
-- added, extend CountFileURLReferences AND ListReferencedFileURLs so
-- refcount stays accurate and the orphan sweeper doesn't wipe live
-- files.

-- name: CountFileURLReferences :one
-- Number of DB rows that reference the given file URL across every
-- column that stores one. Zero means the file is safe to physically
-- delete from the object store.
SELECT
  (SELECT COUNT(*) FROM images        WHERE images.image_url        = sqlc.arg(file_url)::text)::bigint +
  (SELECT COUNT(*) FROM image_planes  WHERE image_planes.image_url  = sqlc.arg(file_url)::text)::bigint +
  (SELECT COUNT(*) FROM user_models   WHERE user_models.model_url   = sqlc.arg(file_url)::text)::bigint +
  (SELECT COUNT(*) FROM users         WHERE users.avatar_url        = sqlc.arg(file_url)::text)::bigint
AS refcount;

-- name: ListReferencedFileURLs :many
-- Every file URL currently referenced from the DB. Used by
-- cmd/cleanup-orphans to build the "keep" set before sweeping the
-- object store. Empty rows are filtered so the result is dense.
SELECT url FROM (
  SELECT image_url AS url FROM images WHERE image_url <> ''
  UNION
  SELECT image_url FROM image_planes WHERE image_url <> ''
  UNION
  SELECT model_url FROM user_models WHERE model_url <> ''
  UNION
  SELECT avatar_url FROM users WHERE avatar_url <> ''
) t;

-- name: ListImageURLsByZone :many
-- The `image_url` of every image row assigned to a zone. Used by the
-- zone-delete handler to collect files-to-reclaim BEFORE the CASCADE
-- fires so we can still look them up.
SELECT image_url FROM images
WHERE tenant_id = $1 AND zone_id = $2 AND image_url <> '';

-- name: ListImagePlaneURLsByZone :many
-- Same idea as ListImageURLsByZone, for the 3D image plane table.
SELECT image_url FROM image_planes
WHERE tenant_id = $1 AND zone_id = $2 AND image_url <> '';

-- name: CountModelPlacementsForUserModel :one
-- Number of `models` rows whose `config->>'modelAssetId'` points at the
-- given user_models row (asset id is the JSON string `user_<id>`).
-- Used to gate destructive deletes of a shared catalog entry.
SELECT COUNT(*)::bigint AS cnt FROM models
WHERE tenant_id = sqlc.arg(tenant_id)::bigint
  AND config->>'modelAssetId' = sqlc.arg(asset_id)::text;

-- name: DeleteModelPlacementsForUserModel :exec
-- Cascade delete every placement that references the given user_models
-- id. Used by the `?force=true` variant of the catalog delete.
DELETE FROM models
WHERE tenant_id = sqlc.arg(tenant_id)::bigint
  AND config->>'modelAssetId' = sqlc.arg(asset_id)::text;

-- name: GetUserAvatarURL :one
-- Current avatar_url for a user, for the "delete old file after upload"
-- flow. Returns empty string when unset.
SELECT avatar_url FROM users WHERE id = $1;
