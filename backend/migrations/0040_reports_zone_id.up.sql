-- Reports facility-scoping. Adds a nullable zone_id column so the
-- Reports directory can filter by facility (matching how data_link_configs
-- + style_rules already scope). NULL = "cross-facility" (visible in
-- the "All facilities" tab, hidden from a specific facility filter).
--
-- ON DELETE SET NULL: dropping a zone doesn't cascade into losing the
-- report definitions. The zone_id just becomes NULL and the report
-- shows up in the cross-facility bucket, so operators can re-assign it.
--
-- Backfill: assign every existing report to its tenant's first zone
-- (ordered by id). Chosen intentionally: only two tenants exist today
-- (21: Hospital + Mall, 27: Acme) and each has a clear "primary" zone
-- at the top of the sort. Operators can re-assign in the UI post-ship.

ALTER TABLE reports
  ADD COLUMN zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL;

-- Composite index for the common "list this facility's reports" query.
-- Partial on NOT is_archived to match the sibling reports_tenant_active_idx.
CREATE INDEX reports_tenant_zone_idx
  ON reports (tenant_id, zone_id, updated_at DESC)
  WHERE NOT is_archived;

-- One-shot backfill. Uses a correlated subquery so multi-tenant setups
-- each get their own tenant's first zone. NULL survives when a tenant
-- has no zones at all (rare — new tenants that haven't onboarded).
UPDATE reports r
SET zone_id = (
  SELECT id FROM zones z
  WHERE z.tenant_id = r.tenant_id
  ORDER BY id ASC
  LIMIT 1
)
WHERE zone_id IS NULL;
