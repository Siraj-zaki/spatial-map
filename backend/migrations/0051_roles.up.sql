-- Custom roles.
--
-- The four built-in roles (owner / admin / editor / viewer) stay as the
-- text in user_tenants.role, with fixed permission sets in code
-- (api.BuiltinPermissions). A custom role is a named permission list that
-- belongs to one workspace.
--
-- A member with a custom role keeps a base role in user_tenants.role
-- ('editor' when the role grants any change, else 'viewer') for the few
-- places that still group people by role (alert recipients); access is
-- decided by the custom role's permissions.

CREATE TABLE roles (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    description TEXT        NOT NULL DEFAULT '',
    permissions TEXT[]      NOT NULL DEFAULT '{}',
    created_by  BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX roles_name_per_tenant ON roles (tenant_id, lower(btrim(name)));

ALTER TABLE user_tenants
    ADD COLUMN custom_role_id BIGINT REFERENCES roles(id) ON DELETE RESTRICT;

CREATE INDEX user_tenants_custom_role_idx ON user_tenants (custom_role_id) WHERE custom_role_id IS NOT NULL;
