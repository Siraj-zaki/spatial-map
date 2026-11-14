-- Custom roles (migration 0051). A role belongs to one workspace.

-- name: GetMemberAccess :one
-- What TenantMiddleware needs per request: the member's role and, when a
-- custom role is assigned, its name and permissions.
SELECT ut.role, ut.custom_role_id,
       coalesce(r.name, '')::text AS custom_role_name,
       coalesce(r.permissions, '{}'::text[])::text[] AS custom_permissions
FROM user_tenants ut
LEFT JOIN roles r ON r.id = ut.custom_role_id
WHERE ut.user_id = $1 AND ut.tenant_id = $2;

-- name: ListRolesForTenant :many
SELECT r.id, r.tenant_id, r.name, r.description, r.permissions, r.created_at, r.updated_at,
       (SELECT count(*) FROM user_tenants ut WHERE ut.custom_role_id = r.id)::bigint AS member_count
FROM roles r
WHERE r.tenant_id = sqlc.arg(tenant_id)::bigint
ORDER BY lower(r.name);

-- name: GetRoleForTenant :one
-- One role, only when it belongs to this workspace.
SELECT r.id, r.tenant_id, r.name, r.description, r.permissions, r.created_at, r.updated_at
FROM roles r
WHERE r.id = sqlc.arg(id)::bigint AND r.tenant_id = sqlc.arg(tenant_id)::bigint;

-- name: CreateRole :one
INSERT INTO roles (tenant_id, name, description, permissions, created_by)
VALUES (sqlc.arg(tenant_id)::bigint, btrim(sqlc.arg(name)::text),
        sqlc.arg(description)::text, sqlc.arg(permissions)::text[], sqlc.narg(created_by)::bigint)
RETURNING id;

-- name: UpdateRole :exec
UPDATE roles
SET name = btrim(sqlc.arg(name)::text), description = sqlc.arg(description)::text,
    permissions = sqlc.arg(permissions)::text[], updated_at = now()
WHERE id = sqlc.arg(id)::bigint;

-- name: DeleteRole :exec
DELETE FROM roles WHERE id = $1;

-- name: CountRoleMembers :one
SELECT count(*)::bigint AS count FROM user_tenants WHERE custom_role_id = $1;

-- name: SetMemberRole :exec
-- Assigns a built-in role (custom_role_id NULL) or a custom role (role =
-- its base role).
UPDATE user_tenants
SET role = sqlc.arg(role)::text, custom_role_id = sqlc.narg(custom_role_id)::bigint
WHERE user_id = sqlc.arg(user_id)::bigint AND tenant_id = sqlc.arg(tenant_id)::bigint;

-- name: SetMemberBaseRoleForRole :exec
-- Keeps every member's base role in step after a custom role is edited.
UPDATE user_tenants SET role = sqlc.arg(role)::text WHERE custom_role_id = sqlc.arg(id)::bigint;

-- name: ListTenantMembersWithRoles :many
SELECT ut.user_id, ut.role, ut.custom_role_id, coalesce(r.name, '')::text AS custom_role_name,
       u.email, u.display_name
FROM user_tenants ut
JOIN users u ON u.id = ut.user_id
LEFT JOIN roles r ON r.id = ut.custom_role_id
WHERE ut.tenant_id = $1
ORDER BY ut.created_at ASC;
