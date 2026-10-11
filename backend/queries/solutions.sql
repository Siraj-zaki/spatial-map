-- Solutions (migration 0045): named groups of facilities, reports and data
-- sources inside a workspace. See internal/handlers/solutions.go.

-- name: ListSolutions :many
SELECT * FROM solutions
WHERE tenant_id = $1
ORDER BY position, id;

-- name: GetSolution :one
SELECT * FROM solutions
WHERE id = $1 AND tenant_id = $2;

-- name: CreateSolution :one
INSERT INTO solutions (tenant_id, name, description, icon, color, template, position, created_by)
VALUES (
  sqlc.arg(tenant_id), sqlc.arg(name), sqlc.arg(description), sqlc.arg(icon), sqlc.arg(color), sqlc.arg(template),
  (SELECT COALESCE(MAX(s.position), -1) + 1 FROM solutions s WHERE s.tenant_id = sqlc.arg(tenant_id)),
  sqlc.narg(created_by)
)
RETURNING *;

-- name: UpdateSolution :one
UPDATE solutions
SET name = $3, description = $4, icon = $5, color = $6, position = $7, updated_at = now()
WHERE solutions.id = $1 AND solutions.tenant_id = $2
RETURNING *;

-- name: DeleteSolution :exec
DELETE FROM solutions WHERE id = $1 AND tenant_id = $2;

-- name: TouchSolution :exec
UPDATE solutions SET updated_at = now() WHERE id = $1 AND tenant_id = $2;

-- name: ListSolutionItemsByTenant :many
-- Every live member of every solution in the workspace. Soft-deleted data
-- sources are left out (hard deletes are handled by the FK cascade).
SELECT si.solution_id, si.zone_id, si.report_id, si.data_source_id
FROM solution_items si
LEFT JOIN data_sources ds ON ds.id = si.data_source_id
WHERE si.tenant_id = $1
  AND (si.data_source_id IS NULL OR ds.deleted_at IS NULL)
ORDER BY si.solution_id, si.id;

-- Adds take a list of ids and keep only the ones this tenant owns, so an
-- id from another workspace is silently ignored. Re-adding is a no-op.

-- name: AddSolutionZones :exec
INSERT INTO solution_items (solution_id, tenant_id, zone_id)
SELECT sqlc.arg(solution_id), sqlc.arg(tenant_id), z.id
FROM zones z
WHERE z.tenant_id = sqlc.arg(tenant_id) AND z.id = ANY(sqlc.arg(ids)::bigint[])
ON CONFLICT DO NOTHING;

-- name: AddSolutionReports :exec
INSERT INTO solution_items (solution_id, tenant_id, report_id)
SELECT sqlc.arg(solution_id), sqlc.arg(tenant_id), r.id
FROM reports r
WHERE r.tenant_id = sqlc.arg(tenant_id) AND r.id = ANY(sqlc.arg(ids)::bigint[])
ON CONFLICT DO NOTHING;

-- name: AddSolutionDataSources :exec
INSERT INTO solution_items (solution_id, tenant_id, data_source_id)
SELECT sqlc.arg(solution_id), sqlc.arg(tenant_id), d.id
FROM data_sources d
WHERE d.tenant_id = sqlc.arg(tenant_id) AND d.deleted_at IS NULL AND d.id = ANY(sqlc.arg(ids)::bigint[])
ON CONFLICT DO NOTHING;

-- name: RemoveSolutionZones :exec
DELETE FROM solution_items
WHERE solution_id = sqlc.arg(solution_id) AND tenant_id = sqlc.arg(tenant_id) AND zone_id = ANY(sqlc.arg(ids)::bigint[]);

-- name: RemoveSolutionReports :exec
DELETE FROM solution_items
WHERE solution_id = sqlc.arg(solution_id) AND tenant_id = sqlc.arg(tenant_id) AND report_id = ANY(sqlc.arg(ids)::bigint[]);

-- name: RemoveSolutionDataSources :exec
DELETE FROM solution_items
WHERE solution_id = sqlc.arg(solution_id) AND tenant_id = sqlc.arg(tenant_id) AND data_source_id = ANY(sqlc.arg(ids)::bigint[]);

-- name: ClearSolutionItems :exec
DELETE FROM solution_items WHERE solution_id = $1 AND tenant_id = $2;

-- name: SolutionZoneIDs :many
SELECT zone_id::bigint FROM solution_items
WHERE solution_id = $1 AND tenant_id = $2 AND zone_id IS NOT NULL;

-- name: SolutionDataSourceIDs :many
SELECT si.data_source_id::bigint FROM solution_items si
JOIN data_sources ds ON ds.id = si.data_source_id AND ds.deleted_at IS NULL
WHERE si.solution_id = $1 AND si.tenant_id = $2;

-- name: SolutionRowStats :one
-- Live-data KPIs for the solution overview: rows held by its data sources
-- and how many changed in the last 24 h.
SELECT
  COUNT(*)::bigint AS total_rows,
  COUNT(*) FILTER (WHERE r.updated_at > now() - interval '24 hours')::bigint AS updated_24h,
  MAX(r.updated_at)::timestamptz AS last_update
FROM data_source_rows r
WHERE r.tenant_id = sqlc.arg(tenant_id) AND r.source_id = ANY(sqlc.arg(source_ids)::bigint[]);

-- name: SolutionRecentRuns :many
SELECT j.id, j.source_id, ds.name AS source_name, j.status::text AS status, j.started_at, j.finished_at, j.created_at
FROM import_jobs j
JOIN data_sources ds ON ds.id = j.source_id
WHERE j.tenant_id = sqlc.arg(tenant_id) AND j.source_id = ANY(sqlc.arg(source_ids)::bigint[])
ORDER BY j.created_at DESC
LIMIT 6;
