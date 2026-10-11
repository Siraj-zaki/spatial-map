-- Per-thing-type scoped write tokens. The plaintext token is returned ONCE
-- on creation and never stored; we keep only the SHA-256 hash. Revocation
-- is non-destructive (set `revoked_at = now()`) so the audit trail in
-- `data_source_row_events` (which references `auth_token_id`) stays
-- interpretable.
--
-- `GetTableByToken` is the auth middleware's lookup: it resolves a bearer
-- token to the (source_id, tenant_id) the public CRUD handler operates on.
-- Revoked tokens (revoked_at IS NOT NULL) are filtered out so the same
-- query handles the "no such token" and "revoked" cases identically — the
-- middleware returns 401 either way without distinguishing them.

-- name: CreateTableAPIToken :one
INSERT INTO table_api_tokens (tenant_id, source_id, token_hash, label)
VALUES ($1, $2, $3, $4)
RETURNING id, tenant_id, source_id, token_hash, label, created_at, last_used_at, revoked_at;

-- name: GetTableByToken :one
-- Joins data_sources so the middleware gets the tenant_id back in one
-- trip. Filters revoked tokens AND soft-deleted sources — a revoked
-- token on a live source, or a live token on a deleted source, are both
-- 401.
SELECT t.id AS token_id, t.tenant_id, t.source_id, t.label, t.created_at, t.last_used_at, t.revoked_at,
       s.name AS source_name, s.entity_kind
FROM table_api_tokens t
JOIN data_sources s ON s.id = t.source_id
WHERE t.token_hash = $1 AND t.revoked_at IS NULL;

-- name: ListTableAPITokens :many
SELECT id, tenant_id, source_id, token_hash, label, created_at, last_used_at, revoked_at
FROM table_api_tokens
WHERE source_id = $1 AND tenant_id = $2 AND revoked_at IS NULL
ORDER BY created_at DESC;

-- name: RevokeTableAPIToken :exec
UPDATE table_api_tokens
SET revoked_at = now()
WHERE id = $1 AND tenant_id = $2 AND source_id = $3 AND revoked_at IS NULL;

-- name: TouchTableAPIToken :exec
-- Updates last_used_at on each successful authenticated write. Best-effort
-- — caller swallows the error so a stale timestamp never blocks a
-- legitimate row write.
UPDATE table_api_tokens
SET last_used_at = now()
WHERE id = $1 AND revoked_at IS NULL;