-- Reverses 0031_stripe.up.sql. The shared customers / subscriptions
-- tables are untouched (Stripe rows sit alongside Paddle history).
DROP INDEX IF EXISTS stripe_webhook_events_received_at_idx;
DROP INDEX IF EXISTS stripe_webhook_events_type_idx;
DROP TABLE IF EXISTS stripe_webhook_events;
DROP INDEX IF EXISTS tenants_stripe_customer_idx;
ALTER TABLE tenants DROP COLUMN IF EXISTS stripe_subscription_id;
ALTER TABLE tenants DROP COLUMN IF EXISTS stripe_customer_id;