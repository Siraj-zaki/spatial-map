-- 0030_paddle_plan_names.up.sql
-- Extend tenants.plan CHECK constraint to include the Paddle tier
-- literals: starter / advanced. The legacy names (trial / basic / pro /
-- custom / lifetime) stay in the list because grandfathered tenants
-- still carry them — dropping `basic` would violate their existing rows.
--
-- `pro` intentionally overlaps between the old RC-era catalog and the
-- new Paddle catalog; it's the same tier semantically (25 warehouses)
-- so no data migration is needed.

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_plan_check
  CHECK (plan IN ('trial', 'starter', 'basic', 'pro', 'advanced', 'custom', 'lifetime'));
