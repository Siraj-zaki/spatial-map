-- name: CreateAIJob :one
INSERT INTO ai_jobs (tenant_id, image_id, region_bbox, status, model, prompt_version)
VALUES ($1, $2, $3, 'pending', $4, $5)
RETURNING id, tenant_id, image_id, region_bbox, status, model, prompt_version,
          detections, accepted_ids, rejected_ids, error, tokens_used, duration_ms,
          created_at, updated_at;

-- name: GetAIJob :one
SELECT id, tenant_id, image_id, region_bbox, status, model, prompt_version,
       detections, accepted_ids, rejected_ids, error, tokens_used, duration_ms,
       created_at, updated_at
FROM ai_jobs
WHERE id = $1 AND tenant_id = $2;

-- name: MarkAIJobRunning :exec
UPDATE ai_jobs
SET status = 'running', updated_at = now()
WHERE id = $1 AND status = 'pending';

-- name: SetAIJobWorkerTaskID :exec
-- Persist the ai-worker's Dramatiq task id on the job row so the
-- polling goroutine can resume across API restarts.
UPDATE ai_jobs
SET worker_task_id = $2, updated_at = now()
WHERE id = $1;

-- name: CompleteAIJob :exec
UPDATE ai_jobs
SET status = 'done',
    detections = $2,
    tokens_used = $3,
    duration_ms = $4,
    updated_at = now()
WHERE id = $1;

-- name: FailAIJob :exec
UPDATE ai_jobs
SET status = 'failed',
    error = $2,
    duration_ms = $3,
    updated_at = now()
WHERE id = $1;

-- name: CancelAIJob :exec
UPDATE ai_jobs
SET status = 'canceled', updated_at = now()
WHERE id = $1 AND tenant_id = $2 AND status IN ('pending','running');

-- name: RecordAIJobFeedback :exec
UPDATE ai_jobs
SET accepted_ids = $3,
    rejected_ids = $4,
    updated_at = now()
WHERE id = $1 AND tenant_id = $2;

-- name: SumAIJobTokensThisMonth :one
-- Drives the per-tenant monthly cost cap. Counts every terminal + in-flight
-- job so a burst of concurrent requests can't slip past the cap.
SELECT COALESCE(SUM(tokens_used), 0)::BIGINT AS total
FROM ai_jobs
WHERE tenant_id = $1
  AND created_at >= date_trunc('month', now());

-- name: CountAIJobsThisMonth :one
-- Fallback cap check for the case where a job errored before tokens_used
-- was recorded — still counts against the tenant's monthly quota so a
-- flapping backend can't be used to exhaust the wallet.
SELECT COUNT(*)::BIGINT AS total
FROM ai_jobs
WHERE tenant_id = $1
  AND created_at >= date_trunc('month', now());

-- name: LatestAIJobForImage :one
-- Used by the toolbar to check "is there an in-flight job on this image?"
-- so we can disable the button + re-attach the SSE stream instead of
-- kicking off a duplicate job.
SELECT id, tenant_id, image_id, region_bbox, status, model, prompt_version,
       detections, accepted_ids, rejected_ids, error, tokens_used, duration_ms,
       created_at, updated_at
FROM ai_jobs
WHERE image_id = $1 AND tenant_id = $2
ORDER BY created_at DESC
LIMIT 1;
