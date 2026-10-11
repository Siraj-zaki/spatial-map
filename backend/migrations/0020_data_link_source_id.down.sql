DROP INDEX IF EXISTS idx_data_link_configs_source;
ALTER TABLE data_link_configs DROP COLUMN source_id;
