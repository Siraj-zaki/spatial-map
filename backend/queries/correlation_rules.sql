-- name: CreateCorrelationRule :one
INSERT INTO correlation_rules (tenant_id, name, enabled, trigger, action, cooldown_ms)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, tenant_id, name, enabled, trigger, action, cooldown_ms, last_fired_at, fire_count, created_at, updated_at;

-- name: GetCorrelationRule :one
SELECT id, tenant_id, name, enabled, trigger, action, cooldown_ms, last_fired_at, fire_count, created_at, updated_at
FROM correlation_rules
WHERE id = $1 AND tenant_id = $2;

-- name: ListCorrelationRules :many
SELECT id, tenant_id, name, enabled, trigger, action, cooldown_ms, last_fired_at, fire_count, created_at, updated_at
FROM correlation_rules
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateCorrelationRule :one
UPDATE correlation_rules
SET name = $3, enabled = $4, trigger = $5, action = $6, cooldown_ms = $7, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, enabled, trigger, action, cooldown_ms, last_fired_at, fire_count, created_at, updated_at;

-- name: DeleteCorrelationRule :exec
DELETE FROM correlation_rules
WHERE id = $1 AND tenant_id = $2;
