-- 0031_stripe.up.sql
-- Stripe billing wiring — replaces Paddle as the active billing provider.
-- The Paddle columns + tables (added in 0028 / 0029) are KEPT in place:
-- dropping them would be destructive to test/dev DBs and loses the
-- rollback path. They simply stop being written by new code; existing
-- rows are inert history.
--
-- The shared `customers` and `subscriptions` tables are REUSED. Stripe
-- customer ids (`cus_...`) and subscription ids (`sub_...`) don't collide
-- with Paddle's (`ctm_...` / numeric `sub_...`), so a single PK column
-- is sufficient. The `scheduled_change_*` columns stay nullable —
-- Stripe doesn't write them.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT NOT NULL DEFAULT '';

-- Fast lookup for webhook → tenant reverse mapping when a customer event
-- fires and we need to fan out UI invalidations. Mirrors the Paddle
-- partial-index shape.
CREATE INDEX IF NOT EXISTS tenants_stripe_customer_idx
  ON tenants (stripe_customer_id)
  WHERE stripe_customer_id <> '';

-- ---- webhook idempotency -----------------------------------------------------
--
-- Mirrors paddle_webhook_events. event_id is Stripe's `evt_...` id
-- (globally unique across Stripe accounts, so a single PK column is
-- sufficient). FK back-links are intentionally soft (no constraints) for
-- the same reason as 0029: a ledger row lands BEFORE the dispatch inserts
-- the customer / subscription rows, and out-of-order deliveries must
-- still record.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,                  -- e.g. "checkout.session.completed"
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id     TEXT,                            -- `cus_...` (nullable; not every event has one)
  subscription_id TEXT,                            -- `sub_...` (nullable)
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS stripe_webhook_events_received_at_idx
  ON stripe_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS stripe_webhook_events_type_idx
  ON stripe_webhook_events (event_type, received_at DESC);