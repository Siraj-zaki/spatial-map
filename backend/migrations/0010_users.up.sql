-- Auth foundation: users + user_tenants.
-- Each user owns at least one tenant; user_tenants.role drives coarse-grained
-- access today and is the substrate for finer per-resource permissions later.

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Emails are stored lowercased; the unique index enforces no duplicates
-- regardless of how the client cased the input.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- Membership join table. Composite PK prevents duplicate links and gives
-- us a natural lookup index for "does this user belong to this tenant?".
CREATE TABLE user_tenants (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id),
  CONSTRAINT user_tenants_role_check CHECK (role IN ('owner', 'admin', 'editor', 'viewer'))
);

CREATE INDEX user_tenants_tenant_idx ON user_tenants (tenant_id);
