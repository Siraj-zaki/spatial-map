-- The demo workspace: seeded by internal/demo into an empty database on
-- first start, and joined by every new account (handlers/auth.go). At
-- most one workspace carries the flag.
ALTER TABLE tenants ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX tenants_one_demo ON tenants (is_demo) WHERE is_demo;
