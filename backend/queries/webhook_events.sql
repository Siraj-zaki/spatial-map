-- name: InsertWebhookEvent :one
INSERT INTO webhook_events (tenant_id, stream_id, token, payload)
VALUES (sqlc.arg(tenant_id_), sqlc.arg(stream_id_), sqlc.arg(token), sqlc.arg(payload))
RETURNING id, tenant_id, stream_id, token, payload, received_at, drained_at;

-- name: CountUndrainedWebhookEvents :one
SELECT COUNT(*) AS remaining FROM webhook_events
WHERE webhook_events.tenant_id = sqlc.arg(tenant_id_) AND webhook_events.stream_id = sqlc.arg(stream_id_) AND webhook_events.drained_at IS NULL;

-- name: DrainWebhookEvents :many
WITH drained AS (
  DELETE FROM webhook_events
  WHERE webhook_events.id IN (
    SELECT webhook_events.id FROM webhook_events
    WHERE webhook_events.tenant_id = sqlc.arg(tenant_id_) AND webhook_events.stream_id = sqlc.arg(stream_id_) AND webhook_events.drained_at IS NULL
    ORDER BY webhook_events.received_at ASC
    LIMIT sqlc.arg(limit_)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING webhook_events.id, webhook_events.payload, webhook_events.received_at
)
SELECT drained.id, drained.payload, (EXTRACT(EPOCH FROM drained.received_at) * 1000)::bigint AS received_at_ms FROM drained
ORDER BY received_at_ms ASC;

-- name: DeleteWebhookEventsForStream :exec
DELETE FROM webhook_events WHERE webhook_events.tenant_id = sqlc.arg(tenant_id_) AND webhook_events.stream_id = sqlc.arg(stream_id_);
