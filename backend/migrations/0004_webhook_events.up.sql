-- ---------------------------------------------------------------------------
-- Webhook event queue for pull-based bin-upsert sources.
--
-- External senders POST events to /api/v1/webhooks/:token; the backend
-- stores them here. The SPA drains them on its polling interval and the
-- import pipeline converts each payload into a bin upsert.
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  drained_at TIMESTAMPTZ
);

CREATE INDEX idx_webhook_events_stream_undrained ON webhook_events(tenant_id, stream_id, drained_at) WHERE drained_at IS NULL;
CREATE INDEX idx_webhook_events_token ON webhook_events(token);
