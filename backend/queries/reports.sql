-- Reports — persistence for user-defined report definitions, per-user
-- ACLs, and per-execution snapshots. All tenant-scoped; per-user access
-- to a specific report is decided in the handler after loading its row.
--
-- List / read queries filter on `is_archived = false` by default; the
-- admin-only archive view uses the `WithArchived` variants.

-- ============================================================ CRUD

-- name: CreateReport :one
INSERT INTO reports (
  tenant_id, name, description, icon, color, spec, spec_version, created_by, zone_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, tenant_id, name, description, icon, color, spec, spec_version,
          is_archived, created_by, created_at, updated_at, zone_id;

-- name: GetReport :one
SELECT id, tenant_id, name, description, icon, color, spec, spec_version,
       is_archived, created_by, created_at, updated_at, zone_id
FROM reports
WHERE id = $1 AND tenant_id = $2;

-- name: ListReportsForTenant :many
-- Directory listing. Callers filter the returned rows further based on
-- ACL — this query returns ALL non-archived reports for the tenant and
-- the handler drops the ones the caller can't see.
SELECT id, tenant_id, name, description, icon, color, spec, spec_version,
       is_archived, created_by, created_at, updated_at, zone_id
FROM reports
WHERE tenant_id = $1 AND NOT is_archived
ORDER BY updated_at DESC;

-- name: ListReportsForTenantByZone :many
-- Facility-scoped listing. Matches ListDataLinkConfigsByZone / ListStyleRulesByZone
-- pattern. When the caller filters by a specific facility, both the reports
-- pinned to that zone AND cross-facility (zone_id IS NULL) reports come back
-- so "shared" definitions surface everywhere — the frontend can partition
-- them into two sections if it wants.
SELECT id, tenant_id, name, description, icon, color, spec, spec_version,
       is_archived, created_by, created_at, updated_at, zone_id
FROM reports
WHERE tenant_id = $1 AND NOT is_archived
  AND (zone_id = $2 OR zone_id IS NULL)
ORDER BY updated_at DESC;

-- name: ListReportsForTenantWithArchived :many
-- Admin variant — includes archived. Not exposed to non-admins.
SELECT id, tenant_id, name, description, icon, color, spec, spec_version,
       is_archived, created_by, created_at, updated_at, zone_id
FROM reports
WHERE tenant_id = $1
ORDER BY is_archived ASC, updated_at DESC;

-- name: UpdateReport :one
-- Full update. Handler always sends every field — patch semantics live
-- above this. `updated_at` is bumped explicitly so the directory sort
-- ("recently updated") tracks meaningful changes, not silent DB writes.
UPDATE reports
SET name = $3, description = $4, icon = $5, color = $6,
    spec = $7, spec_version = $8, zone_id = $9, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, description, icon, color, spec, spec_version,
          is_archived, created_by, created_at, updated_at, zone_id;

-- name: SetReportArchived :exec
-- Soft-delete / restore. History rows stay intact.
UPDATE reports SET is_archived = $3, updated_at = now()
WHERE id = $1 AND tenant_id = $2;

-- name: DeleteReport :exec
-- Hard delete. Cascades to report_permissions + report_runs. Restricted
-- to owner role at the handler layer.
DELETE FROM reports WHERE id = $1 AND tenant_id = $2;

-- ============================================================ ACL

-- name: ListReportPermissions :many
SELECT rp.report_id, rp.user_id, rp.can_edit, rp.granted_at, rp.granted_by,
       u.email AS user_email
FROM report_permissions rp
JOIN users u ON u.id = rp.user_id
WHERE rp.report_id = $1
ORDER BY rp.granted_at ASC;

-- name: ListReportIDsVisibleToUser :many
-- Reverse ACL lookup. Returns report_ids where the user has a permission
-- row (view or edit). Combined in the handler with "created_by = me"
-- and "role in (owner, admin)" to build the full visible set.
SELECT report_id, can_edit
FROM report_permissions
WHERE user_id = $1;

-- name: UpsertReportPermission :exec
INSERT INTO report_permissions (report_id, user_id, can_edit, granted_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (report_id, user_id) DO UPDATE
SET can_edit = EXCLUDED.can_edit, granted_at = now(), granted_by = EXCLUDED.granted_by;

-- name: DeleteReportPermission :exec
DELETE FROM report_permissions WHERE report_id = $1 AND user_id = $2;

-- name: DeleteAllReportPermissions :exec
-- Used before a full "replace ACL" write from the builder.
DELETE FROM report_permissions WHERE report_id = $1;

-- ============================================================ runs

-- name: CreateReportRun :one
-- Legacy v1 shape: creates a single-row run (parent_run_id NULL,
-- query_name ''). Kept for the historical single-query executor path.
-- v2 dashboards use CreateReportRunHeader + CreateReportRunChild.
INSERT INTO report_runs (
  report_id, tenant_id, spec_snapshot, filters_applied,
  row_count, ms_elapsed, status, error, ran_by
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, report_id, tenant_id, spec_snapshot, filters_applied,
          row_count, ms_elapsed, status, error, ran_by, ran_at,
          parent_run_id, query_name;

-- name: CreateReportRunHeader :one
-- v2 dashboard header. row_count is the SUM of children's rowcounts;
-- ms_elapsed is the MAX (dashboards wait for the slowest query);
-- status is 'error' if any child errored, 'ok' otherwise. The header
-- carries the full spec snapshot + resolved params applied.
INSERT INTO report_runs (
  report_id, tenant_id, spec_snapshot, filters_applied,
  row_count, ms_elapsed, status, error, ran_by,
  parent_run_id, query_name
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, '')
RETURNING id, report_id, tenant_id, spec_snapshot, filters_applied,
          row_count, ms_elapsed, status, error, ran_by, ran_at,
          parent_run_id, query_name;

-- name: CreateReportRunChild :exec
-- v2 per-query child row. parent_run_id points at the header;
-- query_name is the spec's query key. Children inherit spec_snapshot
-- from the header (stored empty JSON here to save space — the caller
-- always loads the header when drilling in).
INSERT INTO report_runs (
  report_id, tenant_id, spec_snapshot, filters_applied,
  row_count, ms_elapsed, status, error, ran_by,
  parent_run_id, query_name
)
VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, $3, $4, $5, $6, $7, $8, $9);

-- name: ListReportRuns :many
-- History drawer. Filters to headers only (parent_run_id IS NULL) so
-- the drawer isn't drowned in per-query child rows. `limit` is capped
-- by the handler (default 50, max 500).
SELECT id, report_id, tenant_id, spec_snapshot, filters_applied,
       row_count, ms_elapsed, status, error, ran_by, ran_at,
       parent_run_id, query_name
FROM report_runs
WHERE report_id = $1 AND tenant_id = $2 AND parent_run_id IS NULL
ORDER BY ran_at DESC
LIMIT $3;

-- name: ListReportRunChildren :many
-- Drill-down for one header: per-query rows in query_name order for a
-- stable display. Only returns rows whose parent matches — caller
-- verifies the header's tenant first.
SELECT id, report_id, tenant_id, row_count, ms_elapsed, status, error,
       ran_at, parent_run_id, query_name
FROM report_runs
WHERE parent_run_id = $1 AND tenant_id = $2
ORDER BY query_name ASC, ran_at ASC;

-- name: GetReportRun :one
SELECT id, report_id, tenant_id, spec_snapshot, filters_applied,
       row_count, ms_elapsed, status, error, ran_by, ran_at,
       parent_run_id, query_name
FROM report_runs
WHERE id = $1 AND report_id = $2 AND tenant_id = $3;

-- ============================================================ history

-- name: BucketDataSourceRowEvents :many
-- Groups events on `data_source_row_events` into fixed time buckets +
-- operation (insert / update / delete). Powers the History widget's
-- change-over-time chart. `bucket` is a Postgres interval string
-- (`'1 hour'`, `'1 day'`, `'1 week'`) — the caller validates the
-- shape and the query passes it via date_trunc.
--
-- `since_ts` is the lower bound (exclusive), `bucket_unit` the
-- date_trunc unit (`'hour'` / `'day'` / `'week'` / `'month'`). Both
-- ride as parameters so the plan can be reused across window sizes.
SELECT
  date_trunc(sqlc.arg(bucket_unit)::text, ts)::timestamptz AS bucket_ts,
  operation,
  COUNT(*)::bigint AS event_count
FROM data_source_row_events
WHERE source_id = $1 AND tenant_id = $2 AND ts >= $3
GROUP BY date_trunc(sqlc.arg(bucket_unit)::text, ts), operation
ORDER BY bucket_ts ASC, operation ASC;

-- name: RecentDataSourceRowEvents :many
-- Small window of the most recent events for the History widget's
-- "recent changes" list. Payload is included so the UI can render the
-- row's current shape without a second lookup. Kept separate from the
-- bucket query so the caller can tune the two limits independently.
SELECT id, tenant_id, source_id, entity_key, payload, operation, ts, source_ip, auth_token_id
FROM data_source_row_events
WHERE source_id = $1 AND tenant_id = $2 AND ts >= $3
ORDER BY ts DESC
LIMIT $4;

-- ============================================================ source hints

-- name: SampleDataSourceRowFields :many
-- Returns the union of top-level payload keys across the most recently
-- updated N rows for a source. Used by the builder's field picker when
-- the source is REST / file / webhook (i.e. no fixed schema — table
-- sources use table_field_definitions instead). Rows are fetched via a
-- subquery so DISTINCT operates on the sampled set, not the whole
-- table. `sample` should be small (100–500 rows is plenty).
SELECT DISTINCT jsonb_object_keys(payload) AS field_key
FROM (
  SELECT payload FROM data_source_rows
  WHERE source_id = $1 AND tenant_id = $2
  ORDER BY updated_at DESC
  LIMIT $3
) sub
ORDER BY field_key;

-- ============================================================ retention

-- name: TrimReportRunsBefore :exec
-- Retention hook. Not wired to a scheduler in v1 — left for an operator
-- job. Mirrors `TrimDataSourceRowEventsBefore` / `TrimEntityEventsBefore`.
DELETE FROM report_runs WHERE report_id = $1 AND tenant_id = $2 AND ran_at < $3;

-- name: ListReportOriginKeys :many
-- Keys of the generated reports (spec.origin) pinned to a facility —
-- archived ones included, so a report the user deleted is never
-- re-created by the generators in internal/reports.
SELECT coalesce(spec->'origin'->>'key', '')::text AS key
FROM reports
WHERE tenant_id = $1 AND zone_id = $2 AND spec->'origin'->>'kind' = sqlc.arg(kind)::text;

-- name: GrantTenantReportsToUser :exec
-- View access to every report of a workspace, for a member who joins the
-- demo workspace (handlers/auth.go): editors don't see a report without
-- a grant, and the demo's reports are the point of joining it.
INSERT INTO report_permissions (report_id, user_id, can_edit)
SELECT r.id, $2, false
FROM reports r
WHERE r.tenant_id = $1
ON CONFLICT (report_id, user_id) DO NOTHING;
