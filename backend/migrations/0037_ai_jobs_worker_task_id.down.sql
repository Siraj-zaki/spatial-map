-- Reverses 0037_ai_jobs_worker_task_id.up.sql. Column drop loses the
-- task-id → job link used by the Phase-4 polling reconciler, so
-- rolling back requires a redeploy of the Phase-3 (Ollama) code.
ALTER TABLE ai_jobs DROP COLUMN IF EXISTS worker_task_id;
