-- name: CreateImportJob :one
INSERT INTO import_jobs (tenant_id, source_id, started_at, finished_at, status, stats, error_report)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, tenant_id, source_id, started_at, finished_at, status, stats, error_report, created_at;

-- name: GetImportJob :one
SELECT id, tenant_id, source_id, started_at, finished_at, status, stats, error_report, created_at
FROM import_jobs
WHERE id = $1 AND tenant_id = $2;

-- name: ListImportJobs :many
SELECT id, tenant_id, source_id, started_at, finished_at, status, stats, error_report, created_at
FROM import_jobs
WHERE tenant_id = $1
ORDER BY created_at DESC;

-- name: UpdateImportJob :one
UPDATE import_jobs
SET source_id = $3, started_at = $4, finished_at = $5, status = $6, stats = $7, error_report = $8
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, source_id, started_at, finished_at, status, stats, error_report, created_at;

-- name: DeleteImportJob :exec
DELETE FROM import_jobs
WHERE id = $1 AND tenant_id = $2;
