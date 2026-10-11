-- Data screen prerequisite — soft-delete the integration mirror trio so that
-- ingested rows (data_source_rows, entity_states, entity_events, source_files,
-- import_jobs) survive a user "deleting" an integration on the Integrations
-- page. Only explicit purge actions from the Data screen do hard deletes.
--
-- Because streams.stream_id CASCADE-deletes entity_states / entity_events,
-- we must soft-delete streams too, not just the parent DataSource.

ALTER TABLE data_sources ADD COLUMN deleted_at TIMESTAMPTZ NULL;
ALTER TABLE connections  ADD COLUMN deleted_at TIMESTAMPTZ NULL;
ALTER TABLE streams      ADD COLUMN deleted_at TIMESTAMPTZ NULL;

CREATE INDEX idx_data_sources_active ON data_sources (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_streams_active      ON streams      (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_connections_active  ON connections  (tenant_id) WHERE deleted_at IS NULL;
