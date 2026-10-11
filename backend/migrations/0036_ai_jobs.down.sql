-- Reverses 0036_ai_jobs.up.sql. Dropping the table loses all telemetry
-- (per-job token spend, accepted/rejected accuracy signals) — acceptable
-- for a rollback since none of it is user-facing state.
DROP INDEX IF EXISTS ai_jobs_image_idx;
DROP INDEX IF EXISTS ai_jobs_tenant_status_idx;
DROP TABLE IF EXISTS ai_jobs;
