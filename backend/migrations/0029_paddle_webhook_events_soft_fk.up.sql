-- 0029_paddle_webhook_events_soft_fk.up.sql
-- Drop the FK constraints on paddle_webhook_events.customer_id and
-- .subscription_id. These columns are informational back-links only —
-- an ledger row lands BEFORE the dispatch inserts the customer /
-- subscription rows, so a strict FK trips the whole insert for the
-- first delivery of any new customer. Also lets us log out-of-order
-- deliveries (subscription.updated arriving before customer.created)
-- without the ledger insert failing. Idempotency + audit trail win
-- over referential neatness here.

ALTER TABLE paddle_webhook_events
  DROP CONSTRAINT IF EXISTS paddle_webhook_events_customer_id_fkey;
ALTER TABLE paddle_webhook_events
  DROP CONSTRAINT IF EXISTS paddle_webhook_events_subscription_id_fkey;
