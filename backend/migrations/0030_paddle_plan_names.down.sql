-- Roll back to the pre-Paddle plan set. WARNING: any tenants that
-- managed to land on plan='starter' or 'advanced' will violate the
-- restored constraint. Migrate them first (UPDATE tenants SET plan='pro'
-- WHERE plan IN ('starter','advanced')) before running this.

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_plan_check
  CHECK (plan IN ('trial', 'basic', 'pro', 'custom', 'lifetime'));
