-- name: CreateShareLink :one
INSERT INTO share_links (tenant_id, zone_id, token, label, settings, expires_at, max_views, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id;

-- name: GetShareLinkByID :one
-- Tenant-scoped read for the editor UI. Returns even revoked rows so the
-- dashboard's Manage-Links table can render a "Revoked" badge and expose
-- a permanent-delete action. The public read-path uses GetShareLinkByToken
-- which enforces revoked_at IS NULL itself.
SELECT id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id
FROM share_links
WHERE id = $1 AND tenant_id = $2;

-- name: ListShareLinksByZone :many
-- Tenant-scoped listing for the editor's "Manage share links" panel.
-- Ordered newest-first so the most recently issued link is on top.
-- Revoked rows are included and shown greyed-out in the UI so users
-- can audit "who did I share this with, and did I already kill it?".
SELECT id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id
FROM share_links
WHERE tenant_id = $1 AND zone_id = $2 AND report_id IS NULL
ORDER BY created_at DESC;

-- name: GetShareLinkByToken :one
-- Public read (no tenant scope). Returns the row joined with the zone
-- so the handler can build the WarehouseView in one query pair. Enforces:
--   * revoked_at IS NULL           (link killed by editor)
--   * expires_at IS NULL OR expires_at > now()  (temporal expiry)
--   * max_views IS NULL OR view_count < max_views (view cap)
-- Any failure returns pgx.ErrNoRows so the caller responds 404 — never
-- 403 — so an attacker can't distinguish an expired link from a fake
-- one.
SELECT id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id
FROM share_links
WHERE token = $1
  AND report_id IS NULL
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND (max_views IS NULL OR view_count < max_views);

-- name: UpdateShareLink :one
-- Sparse update for the "edit link" flow. All settings/expiry/label/max_views
-- can be re-set from the dialog; the token, tenant_id, zone_id, view_count,
-- and audit fields are immutable through this path.
UPDATE share_links
SET label = $3, settings = $4, expires_at = $5, max_views = $6, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id;

-- name: RevokeShareLink :one
-- Soft-delete. The row stays for audit; the public endpoint returns 404
-- because GetShareLinkByToken filters on `revoked_at IS NULL`. Idempotent:
-- running twice does not clobber the original revoker/timestamp because
-- the WHERE clause requires `revoked_at IS NULL`.
UPDATE share_links
SET revoked_at = now(), revoked_by = $3, updated_at = now()
WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
RETURNING id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id;

-- name: DeleteShareLink :exec
-- Hard-delete for the "purge from history" flow. Only exposed to owners.
DELETE FROM share_links
WHERE id = $1 AND tenant_id = $2;

-- name: IncrementShareLinkView :exec
-- Atomic view-count bump. Race-safe: two concurrent viewers hit the
-- endpoint, both queries fire, both increment — max_views is enforced
-- on the READ query (GetShareLinkByToken) which is idempotent under a
-- max_views violation because the WHERE clause simply returns no rows.
-- We don't need row-level locking here because the write is a single
-- UPDATE.
UPDATE share_links
SET view_count = view_count + 1,
    last_accessed_at = now()
WHERE id = $1;

-- name: CreateReportShareLink :one
-- A public link to one report. zone_id is the report's facility (NULL for
-- a workspace-wide report) — kept for the audit trail and the cascade.
INSERT INTO share_links (tenant_id, zone_id, report_id, token, label, settings, expires_at, max_views, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id;

-- name: ListShareLinksByReport :many
-- The report's Share dialog: every link issued for it, newest first,
-- revoked ones included (shown greyed out).
SELECT id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id
FROM share_links
WHERE tenant_id = $1 AND report_id = $2
ORDER BY created_at DESC;

-- name: GetReportShareLinkByToken :one
-- Public read for /public/report-share/{token}. Same gates as
-- GetShareLinkByToken (revoked, expired, view cap → no rows → 404), and
-- only report links answer.
SELECT id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id
FROM share_links
WHERE token = $1
  AND report_id IS NOT NULL
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND (max_views IS NULL OR view_count < max_views);

-- name: GetReportShareLinkForData :one
-- The data calls a shared report page makes after it opened (run, map
-- rows, history). The view cap counts page opens, so the open that used
-- the last view keeps working (view_count <= max_views); revoking or
-- expiry stop it at once.
SELECT id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id
FROM share_links
WHERE token = $1
  AND report_id IS NOT NULL
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND (max_views IS NULL OR view_count <= max_views);

-- name: GetShareLinkForData :one
-- The data calls a shared facility page makes after it opened (layer
-- rows, history, live positions) — like GetReportShareLinkForData: the
-- open that used the last view keeps working.
SELECT id, tenant_id, zone_id, token, label, settings, expires_at, max_views, view_count, last_accessed_at, created_by, created_at, updated_at, revoked_at, revoked_by, report_id
FROM share_links
WHERE token = $1
  AND report_id IS NULL
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND (max_views IS NULL OR view_count <= max_views);
