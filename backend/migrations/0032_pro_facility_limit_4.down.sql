-- Restore the previous 10-warehouse Pro limit (no-op for tenants whose
-- limit was already <= 4 — they came in after this migration shipped).
UPDATE tenants
SET warehouse_limit = 10
WHERE plan = 'pro' AND warehouse_limit = 4;