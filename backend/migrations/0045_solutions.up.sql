-- Solutions: named groups inside a workspace ("Hospital", "Anti-theft")
-- that collect the facilities, reports and data sources (user tables,
-- integrations, files) for one use case. NOT a tenant layer — same
-- members and roles as the workspace; a solution only points at items,
-- so deleting it never deletes data. An item may be in many solutions.
CREATE TABLE solutions (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '',
  template    TEXT NOT NULL DEFAULT '',
  position    INT NOT NULL DEFAULT 0,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX solutions_tenant_idx ON solutions (tenant_id, position, id);

-- One row per member item, with exactly one of the three references set.
-- Real FKs (not a kind/ref_id pair) so deleting a facility, report or
-- data source drops it from every solution — those deletes are hard
-- deletes, and a polymorphic reference would leave dangling members.
CREATE TABLE solution_items (
  id             BIGSERIAL PRIMARY KEY,
  solution_id    BIGINT NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id        BIGINT REFERENCES zones(id) ON DELETE CASCADE,
  report_id      BIGINT REFERENCES reports(id) ON DELETE CASCADE,
  data_source_id BIGINT REFERENCES data_sources(id) ON DELETE CASCADE,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(zone_id, report_id, data_source_id) = 1)
);
CREATE UNIQUE INDEX solution_items_zone_uq ON solution_items (solution_id, zone_id) WHERE zone_id IS NOT NULL;
CREATE UNIQUE INDEX solution_items_report_uq ON solution_items (solution_id, report_id) WHERE report_id IS NOT NULL;
CREATE UNIQUE INDEX solution_items_source_uq ON solution_items (solution_id, data_source_id) WHERE data_source_id IS NOT NULL;
CREATE INDEX solution_items_tenant_idx ON solution_items (tenant_id);
