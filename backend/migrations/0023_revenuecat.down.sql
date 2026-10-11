-- Reverse of 0023_revenuecat.up.sql.

DROP TABLE IF EXISTS revenuecat_webhook_events;

DROP INDEX IF EXISTS tenants_revenuecat_customer_idx;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS billing_provider,
  DROP COLUMN IF EXISTS cancel_at_period_end,
  DROP COLUMN IF EXISTS plan_renews_at,
  DROP COLUMN IF EXISTS revenuecat_entitlement_id,
  DROP COLUMN IF EXISTS revenuecat_product_id,
  DROP COLUMN IF EXISTS revenuecat_subscription_id,
  DROP COLUMN IF EXISTS revenuecat_customer_id;
