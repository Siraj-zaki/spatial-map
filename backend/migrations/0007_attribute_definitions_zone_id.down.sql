-- Reverse: drop the per-warehouse scoping and restore the original
-- tenant-scoped unique constraint.

DROP INDEX IF EXISTS attribute_definitions_tenant_zone_idx;
DROP INDEX IF EXISTS attribute_definitions_tenant_zone_scope_key_uidx;

ALTER TABLE attribute_definitions DROP COLUMN zone_id;

-- Restore the original unique constraint that migrations/0001 created.
-- (golang-migrate replays 0001's down then up on a full reset, so this
-- is only needed for a targeted rollback of 0007.)
CREATE UNIQUE INDEX IF NOT EXISTS attribute_definitions_tenant_id_scope_key_key
  ON attribute_definitions (tenant_id, scope, key);