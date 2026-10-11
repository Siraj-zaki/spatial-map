-- 0023_revenuecat.up.sql
-- Wire RevenueCat's subscription state onto the tenants row so we can render
-- accurate billing UI + gate access without hitting the RC API on every read.
-- The columns are populated by the /webhooks/revenuecat handler as RC pushes
-- INITIAL_PURCHASE / RENEWAL / CANCELLATION / EXPIRATION / PRODUCT_CHANGE
-- events. `revenuecat_customer_id` is the stable app_user_id we send to RC
-- (equal to the tenant.id string) so a re-issued webhook lands on the right
-- row even if the SPA has never re-authed the SDK.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS revenuecat_customer_id     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revenuecat_subscription_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revenuecat_product_id      TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revenuecat_entitlement_id  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS plan_renews_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS billing_provider           TEXT NOT NULL DEFAULT '';

-- Fast lookup from a webhook payload's app_user_id → tenant row.
CREATE INDEX IF NOT EXISTS tenants_revenuecat_customer_idx
  ON tenants (revenuecat_customer_id)
  WHERE revenuecat_customer_id <> '';

-- Idempotency for webhook replays. Each event carries a unique id; we
-- persist the ones we've processed so a re-delivery is a no-op.
CREATE TABLE IF NOT EXISTS revenuecat_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  tenant_id    BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS revenuecat_webhook_events_received_at_idx
  ON revenuecat_webhook_events (received_at DESC);
