-- name: CreateAuditLogEntry :one
INSERT INTO audit_log (tenant_id, stream_id, entity_type, entity_key, url, method, before, after, status, http_status, message, ts)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id, tenant_id, stream_id, entity_type, entity_key, url, method, before, after, status, http_status, message, ts;

-- name: ListAuditLogEntries :many
SELECT id, tenant_id, stream_id, entity_type, entity_key, url, method, before, after, status, http_status, message, ts
FROM audit_log
WHERE tenant_id = $1
ORDER BY ts DESC
LIMIT sqlc.arg(limit_);
