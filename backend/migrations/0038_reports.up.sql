-- Reports — user-composed views over data_sources (tables, REST, files,
-- webhooks). A report holds a JSON spec describing sources, filters,
-- aggregations, sort/pagination, and an ordered list of widgets
-- (KPI, table, chart, map, markdown, ...). The executor translates
-- the spec to safe parameterized SQL on `POST /reports/{id}/run` in
-- Phase 2 — this migration only lays down persistence.
--
-- Three tables:
--   1. reports              — the definition (name + JSONB spec)
--   2. report_permissions   — per-user view/edit ACL (creator + tenant
--                             owners/admins ALWAYS see it; entries here
--                             extend visibility to other tenant members)
--   3. report_runs          — execution snapshots powering the History
--                             drawer + reproducibility ("open this
--                             report as it was on 2026-08-01")
--
-- History reports (the "what changed with my data" screen) do NOT need
-- new storage — they aggregate over the existing `data_source_row_events`
-- append-only trail. Only report DEFINITIONS live here.

CREATE TABLE reports (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  -- Icon + color are display-only. Icon is a lucide-react name (matched
  -- against `src/lib/lucide-icons.ts`); color is a theme token key or a
  -- CSS hsl() string. Both are optional — the directory falls back to
  -- a Database icon + primary tint when either is empty.
  icon         TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT '',
  -- The report definition. Full shape lives in the frontend types + the
  -- Phase 2 executor. Kept as jsonb so aggregates and widget lists can
  -- evolve without a migration.
  spec         JSONB NOT NULL DEFAULT '{}'::jsonb,
  spec_version INT NOT NULL DEFAULT 1,
  -- Soft-delete so history + permission rows stay useful for audit even
  -- after the owner archives a report. `is_archived = true` hides the
  -- report from the directory + refuses runs, but keeps run history
  -- available to admins for compliance.
  is_archived  BOOLEAN NOT NULL DEFAULT false,
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Common listing filter: "active reports for a tenant". Partial index
-- keeps it small when archived reports dominate long-lived tenants.
CREATE INDEX reports_tenant_active_idx
  ON reports (tenant_id, updated_at DESC)
  WHERE NOT is_archived;

-- ACL. Absence of any row means "creator + tenant owners/admins only".
-- Presence of a row grants an additional tenant member view access (or
-- edit access when can_edit = true). Deletes cascade with the parent
-- report — an archived report keeps its ACL rows so unarchive restores
-- everyone's access.
CREATE TABLE report_permissions (
  report_id  BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_edit   BOOLEAN NOT NULL DEFAULT false,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (report_id, user_id)
);

-- Reverse lookup: "which reports can this user see?" — used to filter
-- the list for editor/viewer role members who aren't the creator.
CREATE INDEX report_permissions_user_idx
  ON report_permissions (user_id);

-- Execution snapshots. Powers:
--   * History drawer (list of past runs with duration + row count)
--   * Snapshot re-open (spec_snapshot preserves the spec even if the
--     live report was edited afterwards)
--   * Perf triage (ms_elapsed trend, status='error' rows)
CREATE TABLE report_runs (
  id             BIGSERIAL PRIMARY KEY,
  report_id      BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  tenant_id      BIGINT NOT NULL,
  -- Spec at execution time. Kept even after the parent report edits its
  -- own spec so historical runs remain reproducible.
  spec_snapshot  JSONB NOT NULL,
  -- Runtime overrides (e.g. dashboard-viewer filter chips) applied on
  -- top of the snapshot. Empty object when no overrides were used.
  filters_applied JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count      INT NOT NULL DEFAULT 0,
  ms_elapsed     INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,
  error          TEXT NOT NULL DEFAULT '',
  ran_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ran_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT report_runs_status_check CHECK (status IN ('ok', 'error'))
);

CREATE INDEX report_runs_report_idx
  ON report_runs (report_id, ran_at DESC);
