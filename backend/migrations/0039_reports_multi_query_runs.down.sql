DROP INDEX IF EXISTS report_runs_parent_idx;
ALTER TABLE report_runs
  DROP COLUMN IF EXISTS query_name,
  DROP COLUMN IF EXISTS parent_run_id;
