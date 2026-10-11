-- name: CreateStyleRule :one
INSERT INTO style_rules (tenant_id, name, scope, zone_id, enabled, priority, combine, conditions, style)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, tenant_id, name, scope, zone_id, enabled, priority, combine, conditions, style, created_at, updated_at;

-- name: GetStyleRule :one
SELECT id, tenant_id, name, scope, zone_id, enabled, priority, combine, conditions, style, created_at, updated_at
FROM style_rules
WHERE id = $1 AND tenant_id = $2;

-- name: ListStyleRules :many
SELECT id, tenant_id, name, scope, zone_id, enabled, priority, combine, conditions, style, created_at, updated_at
FROM style_rules
WHERE tenant_id = $1
ORDER BY priority DESC, name;

-- name: UpdateStyleRule :one
UPDATE style_rules
SET name = $3, scope = $4, zone_id = $5, enabled = $6, priority = $7, combine = $8, conditions = $9, style = $10, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, scope, zone_id, enabled, priority, combine, conditions, style, created_at, updated_at;

-- name: DeleteStyleRule :exec
DELETE FROM style_rules
WHERE id = $1 AND tenant_id = $2;

-- name: ListStyleRulesByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
-- Returns tenant-wide rules (scope='tenant') plus rules scoped to this
-- specific zone so the shared viewer applies the same style resolution
-- the authed editor would. Ordered by priority DESC so the resolver
-- picks the highest-priority match first (mirrors ListStyleRules).
SELECT id, tenant_id, name, scope, zone_id, enabled, priority, combine, conditions, style, created_at, updated_at
FROM style_rules
WHERE tenant_id = $1
  AND (scope = 'tenant' OR zone_id = $2)
ORDER BY priority DESC, name;
