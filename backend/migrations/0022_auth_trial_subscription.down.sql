-- Reverse of 0022_auth_trial_subscription.up.sql.

DROP TABLE IF EXISTS contact_requests;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_subscription_status_check;
ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE tenants
  DROP COLUMN IF EXISTS subscribed_at,
  DROP COLUMN IF EXISTS subscription_status,
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS warehouse_limit,
  DROP COLUMN IF EXISTS plan;

DROP TABLE IF EXISTS otp_codes;

ALTER TABLE users DROP COLUMN IF EXISTS verified_at;
