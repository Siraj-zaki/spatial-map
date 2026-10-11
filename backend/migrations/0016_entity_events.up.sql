-- entity_events — append-only event log per (stream, entity_key).
-- Generic replacement for the per-entity event tables
-- (`asset_positions`, `sensor_readings`, `rfid_reads`, `cv_detections`).
-- Correlation engine, heatmap render mode, and track render mode all
-- consume this table.
--
-- No unique constraint (event stream, duplicates possible during
-- retries). Retention is app-level; a scheduled job trims older rows
-- per Stream's configured window.

CREATE TABLE entity_events (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stream_id     BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  entity_key    TEXT   NOT NULL,
  payload       JSONB  NOT NULL,
  ts            TIMESTAMPTZ NOT NULL
);

CREATE INDEX entity_events_stream_ts_idx        ON entity_events (stream_id, ts DESC);
CREATE INDEX entity_events_tenant_key_ts_idx    ON entity_events (tenant_id, stream_id, entity_key, ts DESC);
