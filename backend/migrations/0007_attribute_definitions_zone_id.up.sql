-- Warehouse-scoped attribute definitions.
--
-- `attribute_definitions` was tenant-scoped only: every warehouse under
-- the same tenant saw the same field catalog. Warehouses need their own
-- schemas (rack fields differ between a cold-storage warehouse and a
-- hazmat one), so we add a nullable `zone_id` referencing zones(id).
--
-- `zone_id IS NULL` keeps the tenant-shared semantics: those rows are
-- inherited by every warehouse under the tenant. Per-warehouse rows
-- (`zone_id = X`) are visible only to that warehouse.
--
-- The unique constraint widens to include zone_id. NULLs don't play
-- with UNIQUE in Postgres, so we use a COALESCE-based expression index
-- to keep both `NULL` (tenant-shared) and per-warehouse rows unique
-- within their scope.

ALTER TABLE attribute_definitions
  ADD COLUMN zone_id BIGINT REFERENCES zones(id) ON DELETE CASCADE;

-- Drop the existing UNIQUE(tenant_id, scope, key) constraint (and its
-- backing index) before installing the per-warehouse-aware version.
ALTER TABLE attribute_definitions
  DROP CONSTRAINT IF EXISTS attribute_definitions_tenant_id_scope_key_key;

-- Per-warehouse uniqueness: (tenant_id, zone_id, scope, key). NULL
-- zone_id collides with itself only via COALESCE.
CREATE UNIQUE INDEX attribute_definitions_tenant_zone_scope_key_uidx
  ON attribute_definitions (tenant_id, COALESCE(zone_id, 0), scope, key);

-- Speed up "list definitions visible to this warehouse": tenant-shared
-- rows + rows scoped to this warehouse.
CREATE INDEX attribute_definitions_tenant_zone_idx
  ON attribute_definitions (tenant_id, zone_id);