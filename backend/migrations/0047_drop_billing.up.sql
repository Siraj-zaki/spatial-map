-- 0047_drop_billing.up.sql
-- Spatial Map is self-hosted and free: there are no plans, trials, quotas or
-- payment providers. This drops everything the hosted product's billing
-- layer added in 0022 (plan/trial columns + contact_requests), 0023
-- (RevenueCat), 0028-0030 (Paddle) and 0031-0032 (Stripe). The earlier
-- migrations are left untouched so schema history stays replayable; this
-- migration simply removes their billing-only objects at the end.
--
-- Nothing outside the billing code read these objects, so the drop is
-- safe. users.verified_at and otp_codes (also from 0022) are NOT billing —
-- they back email verification and password reset — and are kept.

-- ---- billing-only tables -----------------------------------------------------

DROP TABLE IF EXISTS stripe_webhook_events;
DROP TABLE IF EXISTS paddle_webhook_events;
DROP TABLE IF EXISTS revenuecat_webhook_events;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS contact_requests;

-- ---- billing-only tenant columns --------------------------------------------

DROP INDEX IF EXISTS tenants_revenuecat_customer_idx;
DROP INDEX IF EXISTS tenants_paddle_customer_idx;
DROP INDEX IF EXISTS tenants_stripe_customer_idx;

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_subscription_status_check;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS plan,
  DROP COLUMN IF EXISTS warehouse_limit,
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS subscription_status,
  DROP COLUMN IF EXISTS subscribed_at,
  DROP COLUMN IF EXISTS revenuecat_customer_id,
  DROP COLUMN IF EXISTS revenuecat_subscription_id,
  DROP COLUMN IF EXISTS revenuecat_product_id,
  DROP COLUMN IF EXISTS revenuecat_entitlement_id,
  DROP COLUMN IF EXISTS plan_renews_at,
  DROP COLUMN IF EXISTS cancel_at_period_end,
  DROP COLUMN IF EXISTS billing_provider,
  DROP COLUMN IF EXISTS paddle_customer_id,
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id;
