-- 0047_drop_billing.down.sql
-- Reverse of 0047_drop_billing.up.sql: recreates the billing schema shape
-- (as left by 0022-0032) so `migrate down` past this point keeps working.
-- Data is NOT restored — the dropped rows are gone. Existing tenants are
-- stamped 'lifetime' / unlimited / active so rolling back never locks
-- anyone out; new rows get the original 'trial' defaults.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS plan                       TEXT NOT NULL DEFAULT 'lifetime',
  ADD COLUMN IF NOT EXISTS warehouse_limit            INTEGER NOT NULL DEFAULT 999999,
  ADD COLUMN IF NOT EXISTS trial_ends_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_status        TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS subscribed_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revenuecat_customer_id     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revenuecat_subscription_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revenuecat_product_id      TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revenuecat_entitlement_id  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS plan_renews_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS billing_provider           TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS paddle_customer_id         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS stripe_customer_id         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS stripe_subscription_id     TEXT NOT NULL DEFAULT '';

ALTER TABLE tenants ALTER COLUMN plan SET DEFAULT 'trial';
ALTER TABLE tenants ALTER COLUMN warehouse_limit SET DEFAULT 5;
ALTER TABLE tenants ALTER COLUMN subscription_status SET DEFAULT 'trialing';

ALTER TABLE tenants
  ADD CONSTRAINT tenants_plan_check
  CHECK (plan IN ('trial', 'starter', 'basic', 'pro', 'advanced', 'custom', 'lifetime'));
ALTER TABLE tenants
  ADD CONSTRAINT tenants_subscription_status_check
  CHECK (subscription_status IN ('trialing', 'active', 'expired', 'canceled'));

CREATE INDEX IF NOT EXISTS tenants_revenuecat_customer_idx
  ON tenants (revenuecat_customer_id) WHERE revenuecat_customer_id <> '';
CREATE INDEX IF NOT EXISTS tenants_paddle_customer_idx
  ON tenants (paddle_customer_id) WHERE paddle_customer_id <> '';
CREATE INDEX IF NOT EXISTS tenants_stripe_customer_idx
  ON tenants (stripe_customer_id) WHERE stripe_customer_id <> '';

CREATE TABLE IF NOT EXISTS contact_requests (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  tenant_id    BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
  email        TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  company      TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_requests_status_check CHECK (status IN ('new', 'in_progress', 'closed'))
);
CREATE INDEX IF NOT EXISTS contact_requests_email_idx      ON contact_requests (lower(email));
CREATE INDEX IF NOT EXISTS contact_requests_created_at_idx ON contact_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS revenuecat_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  tenant_id    BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS revenuecat_webhook_events_received_at_idx
  ON revenuecat_webhook_events (received_at DESC);

CREATE TABLE IF NOT EXISTS customers (
  customer_id  TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  locale       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (lower(email));

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id           TEXT PRIMARY KEY,
  customer_id               TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  status                    TEXT NOT NULL,
  price_id                  TEXT NOT NULL,
  product_id                TEXT NOT NULL,
  scheduled_change_action   TEXT,
  scheduled_change_at       TIMESTAMPTZ,
  current_period_starts_at  TIMESTAMPTZ,
  current_period_ends_at    TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_customer_id_idx ON subscriptions (customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions (status);

CREATE TABLE IF NOT EXISTS paddle_webhook_events (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id     TEXT,
  subscription_id TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS paddle_webhook_events_received_at_idx
  ON paddle_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS paddle_webhook_events_type_idx
  ON paddle_webhook_events (event_type, received_at DESC);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id     TEXT,
  subscription_id TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS stripe_webhook_events_received_at_idx
  ON stripe_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS stripe_webhook_events_type_idx
  ON stripe_webhook_events (event_type, received_at DESC);
