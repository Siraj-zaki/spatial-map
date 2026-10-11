ALTER TABLE user_models DROP COLUMN thumbnail;
ALTER TABLE user_models DROP COLUMN zone_id;
DROP INDEX tenant_files_tenant_zone_idx;
ALTER TABLE tenant_files DROP COLUMN zone_id;
