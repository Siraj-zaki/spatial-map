-- Restore the NOT NULL constraint. Fails if any row has a NULL stream_id
-- (e.g. a table-kind data_link_config has been created). Callers wiping
-- those configs first can run this safely.

ALTER TABLE data_link_configs
  ALTER COLUMN stream_id SET NOT NULL;