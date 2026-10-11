-- Multi-query runs — extends `report_runs` so a single dashboard
-- execution can attribute per-query timing / rowcount / errors under
-- one parent row.
--
-- Model:
--   * The "header" row is what the History drawer lists: one row per
--     user-initiated `POST /reports/:id/run`. Its parent_run_id is NULL
--     and its query_name is '' (empty). Its row_count / ms_elapsed /
--     status reflect the aggregate — sum of children's rowcounts, max
--     of their elapsed, error if any child errored.
--   * The "child" rows carry per-query detail. parent_run_id points at
--     the header; query_name is the spec's query key. Children only
--     exist for v2 (multi-query) specs.
--
-- v1-era rows (pre-0039) are trivially valid: parent_run_id defaults
-- to NULL, query_name defaults to '' — they look like headers with no
-- children, which is exactly the right thing.
--
-- One retention job (TrimReportRunsBefore) still covers everything —
-- ON DELETE CASCADE takes children with the header.

ALTER TABLE report_runs
  ADD COLUMN parent_run_id BIGINT REFERENCES report_runs(id) ON DELETE CASCADE,
  ADD COLUMN query_name    TEXT NOT NULL DEFAULT '';

-- Partial index — the vast majority of report_runs will be headers
-- (parent NULL) once the child pattern stabilises. Only the child
-- rows need this index for the "list children of X" drill-down.
CREATE INDEX report_runs_parent_idx
  ON report_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL;
