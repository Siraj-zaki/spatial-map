-- Deliberately does NOT drop customers / subscriptions / paddle_webhook_events
-- because per the operational guardrails those tables mirror live Paddle
-- state and are never disposable. A rollback of this migration means
-- "stop writing to the tables"; use a data-management script if you truly
-- need to purge Paddle state (and only after archiving).

ALTER TABLE tenants DROP COLUMN IF EXISTS paddle_customer_id;
DROP INDEX IF EXISTS tenants_paddle_customer_idx;
