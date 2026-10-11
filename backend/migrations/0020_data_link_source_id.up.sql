-- V3 Slice 5 — DataLinkConfig (aka Layer) references its source
-- directly instead of only via stream_id. See
-- DESIGN-integrations-v3.md §3.3.
--
-- source_id is nullable during migration so legacy configs keep
-- resolving via stream_id → streams.data_source_id. Slice 6 wires the
-- SPA to prefer source_id when set.

ALTER TABLE data_link_configs
  ADD COLUMN source_id BIGINT REFERENCES data_sources(id) ON DELETE CASCADE;

-- Backfill from streams so existing configs pick up the new source_id
-- automatically. Streams that lack a data_source_id (older WS-only
-- streams) leave the config's source_id NULL — Slice 6 still reads
-- from entity_states for those.
UPDATE data_link_configs c
   SET source_id = s.data_source_id
  FROM streams s
 WHERE c.stream_id = s.id
   AND s.data_source_id IS NOT NULL;

CREATE INDEX idx_data_link_configs_source ON data_link_configs (source_id);
