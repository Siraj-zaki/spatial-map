-- name: InsertEntityEvent :one
INSERT INTO entity_events (tenant_id, stream_id, entity_key, payload, ts)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, tenant_id, stream_id, entity_key, payload, ts;

-- name: ListEntityEventsByStream :many
-- Windowed lookup for heatmap + track render modes. `since_ts` is the
-- lower bound; pass e.g. `now() - interval '30 seconds'` from the
-- handler.
SELECT id, tenant_id, stream_id, entity_key, payload, ts
FROM entity_events
WHERE stream_id = $1 AND tenant_id = $2 AND ts >= $3
ORDER BY ts DESC
LIMIT $4;

-- name: ListEntityEventsForKey :many
-- Per-entity trail — used by the `track` render mode to draw one
-- LineString per entity_key.
SELECT id, tenant_id, stream_id, entity_key, payload, ts
FROM entity_events
WHERE stream_id = $1 AND entity_key = $2 AND tenant_id = $3 AND ts >= $4
ORDER BY ts DESC
LIMIT $5;

-- name: TrimEntityEventsBefore :exec
-- Retention job — drops rows older than the cutoff. Run per stream
-- with the stream's configured window.
DELETE FROM entity_events
WHERE stream_id = $1 AND ts < $2;
