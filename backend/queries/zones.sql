-- name: CreateZone :one
INSERT INTO zones (tenant_id, name, color, description, center, address, default_view, share_token, is_public)
VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), $7, $8, $9, $10)
RETURNING id, tenant_id, name, color, description, ST_X(center) AS center_lng, ST_Y(center) AS center_lat, address, default_view, share_token, is_public, created_at, updated_at;

-- name: GetZone :one
SELECT id, tenant_id, name, color, description, ST_X(center) AS center_lng, ST_Y(center) AS center_lat, address, default_view, share_token, is_public, created_at, updated_at
FROM zones
WHERE id = $1 AND tenant_id = $2;

-- name: ListZones :many
SELECT id, tenant_id, name, color, description, ST_X(center) AS center_lng, ST_Y(center) AS center_lat, address, default_view, share_token, is_public, created_at, updated_at
FROM zones
WHERE tenant_id = $1
ORDER BY name;

-- name: GetZoneByID :one
-- Public read (no tenant scope) for the shareable presentation view.
SELECT id, tenant_id, name, color, description, ST_X(center) AS center_lng, ST_Y(center) AS center_lat, address, default_view, share_token, is_public, created_at, updated_at
FROM zones
WHERE id = $1;

-- name: GetZoneByShareToken :one
-- Public read by share token. Used by /api/v1/public/warehouses/by-token/:token.
-- The handler is responsible for the is_public check (returns 404 when false).
SELECT id, tenant_id, name, color, description, ST_X(center) AS center_lng, ST_Y(center) AS center_lat, address, default_view, share_token, is_public, created_at, updated_at
FROM zones
WHERE share_token = $1;

-- name: UpdateZone :one
UPDATE zones
SET name = $3, color = $4, description = $5, center = ST_SetSRID(ST_MakePoint($6, $7), 4326), address = $8, default_view = $9, share_token = $10, is_public = $11, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, color, description, ST_X(center) AS center_lng, ST_Y(center) AS center_lat, address, default_view, share_token, is_public, created_at, updated_at;

-- name: DeleteZone :exec
DELETE FROM zones
WHERE id = $1 AND tenant_id = $2;