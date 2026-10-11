-- Re-attach the FK constraints. Note: this WILL FAIL if any rows in
-- paddle_webhook_events point at customer_ids / subscription_ids that
-- no longer exist. Clean those up before rolling back.

ALTER TABLE paddle_webhook_events
  ADD CONSTRAINT paddle_webhook_events_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE SET NULL;
ALTER TABLE paddle_webhook_events
  ADD CONSTRAINT paddle_webhook_events_subscription_id_fkey
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(subscription_id) ON DELETE SET NULL;
