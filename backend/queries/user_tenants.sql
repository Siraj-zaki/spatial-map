-- name: AddUserTenant :one
INSERT INTO user_tenants (user_id, tenant_id, role)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role
RETURNING user_id, tenant_id, role, created_at;

-- name: ListUserTenants :many
-- Returns every tenant a user is a member of, with role and tenant metadata.
SELECT ut.user_id, ut.tenant_id, ut.role, ut.created_at,
       t.name AS tenant_name, t.color AS tenant_color
FROM user_tenants ut
JOIN tenants t ON t.id = ut.tenant_id
WHERE ut.user_id = $1
ORDER BY ut.created_at ASC;

-- name: GetUserTenantMembership :one
-- Used by middleware to verify a user has access to the requested tenant.
SELECT user_id, tenant_id, role, created_at
FROM user_tenants
WHERE user_id = $1 AND tenant_id = $2;

-- name: ListTenantMembers :many
-- For the admin invite/manage screen: who else has access to this tenant.
SELECT ut.user_id, ut.tenant_id, ut.role, ut.created_at,
       u.email AS user_email
FROM user_tenants ut
JOIN users u ON u.id = ut.user_id
WHERE ut.tenant_id = $1
ORDER BY ut.created_at ASC;

-- name: UpdateUserTenantRole :exec
UPDATE user_tenants SET role = $3
WHERE user_id = $1 AND tenant_id = $2;

-- name: RemoveUserTenant :exec
DELETE FROM user_tenants
WHERE user_id = $1 AND tenant_id = $2;
