-- Queries powering the Files admin screen (see
-- internal/handlers/files.go). The Files screen lists every object in
-- the bucket, joined against every DB row that references it, so the
-- user can distinguish "attached to a live warehouse", "ghost row"
-- (image with no zone, unplaced catalog entry), and "orphan" (no DB
-- row at all).

-- name: ListFileReferencesByTenant :many
-- Every URL referenced by a row visible to the tenant, with row
-- metadata for the gallery card. Union'd across every URL-holding
-- column. `zone_id` and `zone_name` are populated for shape kinds that
-- have a warehouse; NULL for catalog entries and avatars. `is_ghost`
-- is TRUE when the row exists but is itself detached from any
-- warehouse — either an image/image_plane with no zone_id, or a
-- user_model with zero placements.
SELECT
  file_url    AS file_url,
  kind        AS kind,
  ref_id      AS ref_id,
  ref_name    AS ref_name,
  zone_id     AS zone_id,
  zone_name   AS zone_name,
  is_ghost    AS is_ghost
FROM (
  SELECT
    i.image_url                            AS file_url,
    'image'::text                          AS kind,
    i.id                                   AS ref_id,
    i.name                                 AS ref_name,
    i.zone_id                              AS zone_id,
    z.name                                 AS zone_name,
    (i.zone_id IS NULL)::boolean           AS is_ghost
  FROM images i
  LEFT JOIN zones z ON z.id = i.zone_id
  WHERE i.tenant_id = sqlc.arg(tenant_id)::bigint AND i.image_url <> ''

  UNION ALL

  SELECT
    ip.image_url                           AS file_url,
    'image_plane'::text                    AS kind,
    ip.id                                  AS ref_id,
    ip.name                                AS ref_name,
    ip.zone_id                             AS zone_id,
    z.name                                 AS zone_name,
    (ip.zone_id IS NULL)::boolean          AS is_ghost
  FROM image_planes ip
  LEFT JOIN zones z ON z.id = ip.zone_id
  WHERE ip.tenant_id = sqlc.arg(tenant_id)::bigint AND ip.image_url <> ''

  UNION ALL

  SELECT
    um.model_url                           AS file_url,
    'user_model'::text                     AS kind,
    um.id                                  AS ref_id,
    um.name                                AS ref_name,
    NULL::bigint                           AS zone_id,
    NULL::text                             AS zone_name,
    (NOT EXISTS (
      SELECT 1 FROM models m
      WHERE m.tenant_id = um.tenant_id
        AND m.config->>'modelAssetId' = 'user_' || um.id::text
    ))::boolean                            AS is_ghost
  FROM user_models um
  WHERE um.tenant_id = sqlc.arg(tenant_id)::bigint AND um.model_url <> ''

) t
ORDER BY file_url, kind, ref_id;

-- Avatar files (users.avatar_url) are intentionally EXCLUDED from
-- ListFileReferencesByTenant. They're personal profile data, not
-- warehouse assets, and surfacing them in the admin Files gallery
-- was confusing. Refcount + cleanup logic (ListReferencedFileURLs,
-- cleanupObjectURL) still counts them, so nobody can delete a live
-- avatar file via the Files DELETE handler.

-- name: ListAvatarURLsByTenant :many
-- Every avatar_url currently claimed by a user who's a member of this
-- tenant. Used by the Files admin screen to (a) skip avatar files
-- entirely in the gallery enumeration and (b) refuse DELETE with a
-- clearer 409 than the silent-nothing behaviour that cleanupObjectURL
-- would otherwise produce (refcount check finds the avatar and skips
-- the physical delete, but the handler returned 204 anyway → user
-- sees "success" but file survives).
SELECT u.avatar_url FROM users u
WHERE u.id IN (
  SELECT ut.user_id FROM user_tenants ut
  WHERE ut.tenant_id = sqlc.arg(tenant_id)::bigint
) AND u.avatar_url <> '';

-- name: ListUserModelPlacementsByTenant :many
-- For every (user_model, warehouse) pair where the catalog entry has
-- at least one placement, returns the warehouse id + name. The Files
-- handler joins this against user_model file references to build the
-- "used in Hospital, Airport" badge — a single catalog GLB placed in
-- three warehouses shows all three, so the warehouse sidebar filter
-- picks it up from any of them.
SELECT DISTINCT
  um.id::bigint    AS user_model_id,
  m.zone_id        AS zone_id,
  z.name           AS zone_name
FROM user_models um
JOIN models m
  ON m.tenant_id = um.tenant_id
  AND m.config->>'modelAssetId' = 'user_' || um.id::text
LEFT JOIN zones z ON z.id = m.zone_id
WHERE um.tenant_id = sqlc.arg(tenant_id)::bigint
  AND m.zone_id IS NOT NULL;

-- name: ListGhostImageIDsByTenant :many
-- Image rows whose warehouse is gone (zone_id NULL). Used by the Files
-- screen's "Clean ghost row" action to hard-delete the DB row so its
-- file becomes a plain orphan the same DELETE call can then reclaim.
SELECT id FROM images
WHERE tenant_id = sqlc.arg(tenant_id)::bigint
  AND image_url = sqlc.arg(file_url)::text
  AND zone_id IS NULL;

-- name: ListGhostImagePlaneIDsByTenant :many
SELECT id FROM image_planes
WHERE tenant_id = sqlc.arg(tenant_id)::bigint
  AND image_url = sqlc.arg(file_url)::text
  AND zone_id IS NULL;

-- name: ListGhostUserModelIDsByTenant :many
-- User_model catalog entries with zero placements — the "uploaded but
-- never used" bucket.
SELECT um.id FROM user_models um
WHERE um.tenant_id = sqlc.arg(tenant_id)::bigint
  AND um.model_url = sqlc.arg(file_url)::text
  AND NOT EXISTS (
    SELECT 1 FROM models m
    WHERE m.tenant_id = um.tenant_id
      AND m.config->>'modelAssetId' = 'user_' || um.id::text
  );

-- name: DeleteImagesByIDs :exec
DELETE FROM images
WHERE tenant_id = sqlc.arg(tenant_id)::bigint AND id = ANY(sqlc.arg(ids)::bigint[]);

-- name: DeleteImagePlanesByIDs :exec
DELETE FROM image_planes
WHERE tenant_id = sqlc.arg(tenant_id)::bigint AND id = ANY(sqlc.arg(ids)::bigint[]);

-- name: DeleteUserModelsByIDs :exec
DELETE FROM user_models
WHERE tenant_id = sqlc.arg(tenant_id)::bigint AND id = ANY(sqlc.arg(ids)::bigint[]);

-- name: ListLibraryImageUses :many
-- Every floor plan / image plane row using an image, for the editor's
-- upload library (handlers/library.go): where each file is used, plus the
-- pixel size so a picked file places without re-measuring.
SELECT image_url AS file_url, 'floorplan'::text AS kind, zone_id, natural_width, natural_height, mime_type, name, created_at
FROM images
WHERE tenant_id = sqlc.arg(tenant_id)::bigint AND image_url <> ''
UNION ALL
SELECT image_url, 'plane'::text, zone_id, natural_width, natural_height, mime_type, name, created_at
FROM image_planes
WHERE tenant_id = sqlc.arg(tenant_id)::bigint AND image_url <> ''
ORDER BY created_at;

-- name: ListUserModelUses :many
-- Placements per catalog model and facility, for the model library.
SELECT (config->>'modelAssetId')::text AS asset_id, zone_id, COUNT(*)::bigint AS cnt
FROM models
WHERE tenant_id = sqlc.arg(tenant_id)::bigint AND config->>'modelAssetId' LIKE 'user\_%'
GROUP BY 1, 2;
