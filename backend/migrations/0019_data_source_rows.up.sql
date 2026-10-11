-- V3 Slice 2 — the reusable data pool (DESIGN-integrations-v3.md §3.2).
--
-- Every file / REST / webhook import writes rows into this table
-- instead of bin.custom_properties (except rack-cell imports, which
-- keep the bin-writing path — the map-grid-overlay reads bins directly
-- for occupancy tinting).
--
-- Latest-known-row-per-entityKey-per-source semantics — same shape as
-- entity_states, which streaming sources still use. Slice 6 will add a
-- read-through so a DataLinkConfig with source_id set can read from
-- either table transparently.
--
-- No history table this pass; entity_events already exists for the
-- streaming side and will be extended for file/REST if we need audit.

CREATE TABLE data_source_rows (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id          BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  entity_key         TEXT NOT NULL,
  payload            JSONB NOT NULL,
  position           geometry(Point, 4326),
  linked_shape_name  TEXT,
  ts                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, entity_key)
);

CREATE INDEX idx_dsr_tenant_source     ON data_source_rows (tenant_id, source_id);
CREATE INDEX idx_dsr_linked_shape_name ON data_source_rows (linked_shape_name);
CREATE INDEX idx_dsr_position_gix      ON data_source_rows USING GIST (position);
