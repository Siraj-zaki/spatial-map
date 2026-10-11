-- 0022_auth_trial_subscription.up.sql
-- Email-OTP verification + 7-day trial + plan-gated warehouse limits.

-- 1. Mark users as verified only after they complete the email-OTP flow.
--    The bootstrap admin gets stamped immediately (see auth.Bootstrap).
--    Existing rows are back-filled as verified so pre-migration users are
--    not accidentally locked out.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
UPDATE users SET verified_at = now() WHERE verified_at IS NULL;

-- 2. OTP codes issued for signup verification. code_hash is a bcrypt-style
--    hash of the 6-digit code so a DB dump does not expose live codes.
--    A single email may have multiple rows over time; the handler picks the
--    latest un-used one and increments attempts on wrong entries.
CREATE TABLE IF NOT EXISTS otp_codes (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  purpose      TEXT NOT NULL DEFAULT 'signup',
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT otp_codes_purpose_check CHECK (purpose IN ('signup', 'password_reset'))
);
CREATE INDEX IF NOT EXISTS otp_codes_email_idx      ON otp_codes (lower(email));
CREATE INDEX IF NOT EXISTS otp_codes_expires_at_idx ON otp_codes (expires_at);

-- 3. Plan + trial + subscription tracking on tenants. Every existing tenant
--    is stamped as 'lifetime' with unlimited warehouses so upgrading a live
--    DB never locks someone out. New tenants created via the signup flow
--    default to 'trial' with a 7-day window and a 5-warehouse cap (enforced
--    in the createZone handler).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS plan                TEXT NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS warehouse_limit     INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS trial_ends_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'trialing',
  ADD COLUMN IF NOT EXISTS subscribed_at       TIMESTAMPTZ;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_plan_check CHECK (plan IN ('trial', 'basic', 'pro', 'custom', 'lifetime'));

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_subscription_status_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_subscription_status_check
    CHECK (subscription_status IN ('trialing', 'active', 'expired', 'canceled'));

-- Existing tenants are grandfathered so a live DB upgrade never locks them out.
UPDATE tenants
SET plan = 'lifetime',
    warehouse_limit = 999999,
    subscription_status = 'active',
    subscribed_at = COALESCE(subscribed_at, now())
WHERE trial_ends_at IS NULL AND plan = 'trial';

-- 4. Contact-form submissions from the "Custom solution" plan card. Not
--    tenant-scoped because a user may submit before choosing a workspace,
--    and the sales / support workflow lives outside the app anyway.
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
