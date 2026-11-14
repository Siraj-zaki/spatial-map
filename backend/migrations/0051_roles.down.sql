DROP INDEX IF EXISTS user_tenants_custom_role_idx;
ALTER TABLE user_tenants DROP COLUMN IF EXISTS custom_role_id;
DROP INDEX IF EXISTS roles_name_per_tenant;
DROP TABLE IF EXISTS roles;
