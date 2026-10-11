-- 0028_paddle.up.sql
-- Paddle billing wiring — replaces RevenueCat as the active billing provider
-- for new subscriptions. The RC columns (added in 0023) are kept but treated
-- as deprecated read-only history for tenants that were on RC before the
-- migration (in practice, only the grandfathered `lifetime` tenants).
--
-- Design:
--   * `customers` and `subscriptions` are the canonical mirror of Paddle
--     state, per the user's spec. They're populated by verified webhooks;
--     never blind-inserted from any other source.
--   * `tenants.paddle_customer_id` links a tenant to a Paddle customer.
--     Nullable because trial-only tenants and legacy RC-lifetime tenants
--     don't have Paddle customers yet.
--   * `paddle_webhook_events` is the idempotency ledger — mirrors the
--     shape of `revenuecat_webhook_events` so operators see a consistent
--     pattern across providers.

-- ---- customers ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customers (
  customer_id  TEXT PRIMARY KEY,           -- Paddle `ctm_...` id (authoritative)
  email        TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  locale       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (lower(email));

-- ---- subscriptions ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id           TEXT PRIMARY KEY,     -- Paddle `sub_...` id
  customer_id               TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  status                    TEXT NOT NULL,        -- active | trialing | canceled | paused | past_due
  price_id                  TEXT NOT NULL,
  product_id                TEXT NOT NULL,
  -- Scheduled changes are informational only. Access is granted based on
  -- current `status`, NOT the presence of a scheduled cancel — a user who
  -- cancels mid-period keeps access until the period end.
  scheduled_change_action   TEXT,                 -- cancel | pause | resume | null
  scheduled_change_at       TIMESTAMPTZ,
  -- Period boundaries so the UI can render "renews on X" / "ends on X".
  current_period_starts_at  TIMESTAMPTZ,
  current_period_ends_at    TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_customer_id_idx ON subscriptions (customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions (status);

-- ---- tenants → paddle customer link ------------------------------------------

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS paddle_customer_id TEXT NOT NULL DEFAULT '';

-- Fast lookup for webhook → tenant reverse mapping when a customer event
-- fires and we need to fan out UI invalidations.
CREATE INDEX IF NOT EXISTS tenants_paddle_customer_idx
  ON tenants (paddle_customer_id)
  WHERE paddle_customer_id <> '';

-- ---- webhook idempotency -----------------------------------------------------

CREATE TABLE IF NOT EXISTS paddle_webhook_events (
  -- Paddle event id (`evt_...`). Never null because a delivery without an
  -- id would fail signature verification long before it reaches this row.
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,               -- e.g. "subscription.created"
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Optional back-links so operators can trace state changes without a
  -- payload archaeology dig. All nullable because not every event type
  -- carries both.
  customer_id     TEXT REFERENCES customers(customer_id) ON DELETE SET NULL,
  subscription_id TEXT REFERENCES subscriptions(subscription_id) ON DELETE SET NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS paddle_webhook_events_received_at_idx
  ON paddle_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS paddle_webhook_events_type_idx
  ON paddle_webhook_events (event_type, received_at DESC);
