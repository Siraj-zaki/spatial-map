-- Append-only history for `data_source_rows`. Mirrors the
-- `entity_events` shape and indexes — the existing streaming path proves
-- the pattern. `payload` is the full row snapshot at each event (not a
-- diff), matching `entity_events` semantics; diff-based history would
-- complicate the time-travel read path without buying enough to justify
-- it.
--
-- `operation` is one of: 'insert' | 'update' | 'delete' (set by the
-- handler). For deletes the payload is the last-known row state so the
-- recap animation on the map can play back the row's life cycle.
--
-- Retention: a `TrimDataSourceRowEventsBefore` query can be wired into a
-- periodic job (mirroring `TrimEntityEventsBefore`); left out of v1 so
-- the operator chooses the window per deployment.

-- name: InsertDataSourceRowEvent :one
INSERT INTO data_source_row_events (tenant_id, source_id, entity_key, payload, operation, source_ip, auth_token_id)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, tenant_id, source_id, entity_key, payload, operation, ts, source_ip, auth_token_id;

-- name: ListDataSourceRowEventsBySource :many
-- Windowed lookup for the history player / heatmap: every event with
-- since <= ts <= until, oldest first. A "last 24 h" window passes
-- until = now(); a custom range passes both ends.
SELECT id, tenant_id, source_id, entity_key, payload, operation, ts, source_ip, auth_token_id
FROM data_source_row_events
WHERE source_id = sqlc.arg(source_id) AND tenant_id = sqlc.arg(tenant_id)
  AND ts >= sqlc.arg(since)::timestamptz AND ts <= sqlc.arg(until)::timestamptz
ORDER BY ts ASC
LIMIT sqlc.arg(row_limit);

-- name: ListDataSourceRowEventsForKey :many
-- Per-entity trail — the per-row history view the user opens from the
-- map popup to see one item's life cycle.
SELECT id, tenant_id, source_id, entity_key, payload, operation, ts, source_ip, auth_token_id
FROM data_source_row_events
WHERE source_id = $1 AND entity_key = $2 AND tenant_id = $3 AND ts >= $4
ORDER BY ts ASC
LIMIT $5;

-- name: TrimDataSourceRowEventsBefore :exec
-- Retention job — drops rows older than the cutoff. Wired into a
-- periodic job by the operator; v1 leaves this here for that future
-- caller to find.
DELETE FROM data_source_row_events
WHERE source_id = $1 AND tenant_id = $2 AND ts < $3;