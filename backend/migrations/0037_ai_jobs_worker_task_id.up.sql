-- 0037_ai_jobs_worker_task_id.up.sql
-- Phase-4 rewrite: retire the in-process Ollama detector, replace
-- with an out-of-process Python "ai-worker" service. Detection jobs
-- now enqueue a Dramatiq task to the worker; Go polls the worker's
-- `GET /detect/{task_id}` until terminal. The task id needs to
-- survive across Go's polling goroutine restarts (e.g. an API
-- redeploy mid-job) so we persist it on the ai_jobs row.
--
-- Empty string is the default for jobs whose worker hasn't been
-- successfully enqueued yet — startDetection sets it right after
-- the worker's POST /detect returns.

ALTER TABLE ai_jobs
  ADD COLUMN IF NOT EXISTS worker_task_id TEXT NOT NULL DEFAULT '';
