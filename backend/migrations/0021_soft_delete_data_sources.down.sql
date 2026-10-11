DROP INDEX IF EXISTS idx_connections_active;
DROP INDEX IF EXISTS idx_streams_active;
DROP INDEX IF EXISTS idx_data_sources_active;

ALTER TABLE streams      DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE connections  DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE data_sources DROP COLUMN IF EXISTS deleted_at;
