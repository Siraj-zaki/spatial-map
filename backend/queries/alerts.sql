-- name: CreateAlert :one
INSERT INTO alerts (tenant_id, rule_id, rule_name, level, message, entity_ref, ts)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, tenant_id, rule_id, rule_name, level, message, entity_ref, ts, acknowledged, acknowledged_at;

-- name: GetAlert :one
SELECT id, tenant_id, rule_id, rule_name, level, message, entity_ref, ts, acknowledged, acknowledged_at
FROM alerts
WHERE id = $1 AND tenant_id = $2;

-- name: ListAlerts :many
SELECT id, tenant_id, rule_id, rule_name, level, message, entity_ref, ts, acknowledged, acknowledged_at
FROM alerts
WHERE tenant_id = $1
ORDER BY ts DESC;

-- name: UpdateAlert :one
UPDATE alerts
SET rule_id = $3, rule_name = $4, level = $5, message = $6, entity_ref = $7, ts = $8, acknowledged = $9, acknowledged_at = $10
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, rule_id, rule_name, level, message, entity_ref, ts, acknowledged, acknowledged_at;

-- name: DeleteAlert :exec
DELETE FROM alerts
WHERE id = $1 AND tenant_id = $2;
