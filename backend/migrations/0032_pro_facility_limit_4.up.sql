-- Backfill Pro tenants to the new 4-facility limit. Existing subscribers
-- had warehouse_limit = 10 stamped at activation; the live tier config
-- (internal/stripe/tiers.go) is now 4, so the gating check would still
-- allow 10 until the next webhook event re-stamps the column. Snap every
-- Pro tenant to the current limit in one step.
UPDATE tenants
SET warehouse_limit = 4
WHERE plan = 'pro' AND warehouse_limit > 4;