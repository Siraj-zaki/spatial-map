-- Basic tenant CRUD used by the /tenants admin endpoint and the bootstrap
-- flow. Self-hosted Spatial Map has no plans, trials or quotas, so a tenant
-- is just (id, name, color).

-- name: ListTenants :many
SELECT id, name, color, created_at
FROM tenants
ORDER BY name;

-- name: GetTenant :one
SELECT id, name, color, created_at
FROM tenants
WHERE id = $1;

-- name: CreateTenant :one
INSERT INTO tenants (name, color)
VALUES ($1, $2)
RETURNING id, name, color, created_at;

-- name: GetDemoTenant :one
-- The demo workspace (internal/demo), if it was seeded and not deleted.
SELECT id, name, color, created_at
FROM tenants
WHERE is_demo;

-- name: UpdateTenant :exec
UPDATE tenants
SET name = $2, color = $3
WHERE id = $1;

-- name: DeleteTenant :exec
DELETE FROM tenants
WHERE id = $1;

-- name: CountTenantOwners :one
-- Number of owner-role memberships for a tenant. Used by the
-- leaveWorkspace + removeMember + updateMemberRole handlers to refuse
-- the operation that would leave a workspace ownerless (which locks
-- everyone out of the workspace delete controls).
SELECT COUNT(*)::bigint AS count
FROM user_tenants
WHERE tenant_id = $1 AND role = 'owner';

-- name: ListImageURLsByTenant :many
-- Every image_url stored under this tenant. Used by deleteTenant to
-- collect file URLs BEFORE the CASCADE fires so the object-store keys
-- can be reclaimed. Empty URLs (legacy inline-data rows) are filtered.
SELECT image_url FROM images
WHERE tenant_id = $1 AND image_url <> '';

-- name: ListImagePlaneURLsByTenant :many
-- Every image_url stored under this tenant's image_planes. Same
-- reclamation pattern as ListImageURLsByTenant.
SELECT image_url FROM image_planes
WHERE tenant_id = $1 AND image_url <> '';

-- name: ListUserModelURLsByTenant :many
-- Every model_url stored under this tenant's user_models catalog. Same
-- reclamation pattern. Unlike images/image_planes these are NOT zone-
-- scoped so warehouse-delete leaves them alone — only tenant-delete
-- reclaims them.
SELECT model_url FROM user_models
WHERE tenant_id = $1 AND model_url <> '';
