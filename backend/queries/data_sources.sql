-- Column order below matches the auto-generated `db.DataSource` model
-- struct so sqlc reuses that type for every RETURNING/SELECT (see the
-- CLAUDE.md note on column ordering).

-- name: CreateDataSource :one
INSERT INTO data_sources (tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, entity_kind)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at;

-- name: GetDataSource :one
SELECT id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at
FROM data_sources
WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL;

-- name: GetDataSourceIncludingArchived :one
SELECT id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at
FROM data_sources
WHERE id = $1 AND tenant_id = $2;

-- name: ListDataSources :many
SELECT id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at
FROM data_sources
WHERE tenant_id = $1 AND deleted_at IS NULL AND kind <> 'facility'
ORDER BY name;

-- name: ListFacilitySources :many
-- Built-in facility sources (migration 0046) — only the Report Builder
-- lists these; every generic list above excludes them.
SELECT id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at
FROM data_sources
WHERE tenant_id = $1 AND kind = 'facility' AND deleted_at IS NULL
ORDER BY id;

-- name: EnsureFacilitySource :exec
-- Idempotent: one row per workspace per entity key. A soft-deleted
-- row is revived rather than duplicated.
INSERT INTO data_sources (tenant_id, name, kind, config, mapping, entity_kind)
VALUES ($1, $2, 'facility', jsonb_build_object('facilityEntity', sqlc.arg(entity)::text), '{}'::jsonb, $3)
ON CONFLICT (tenant_id, (config->>'facilityEntity')) WHERE config->>'facilityEntity' IS NOT NULL
DO UPDATE SET deleted_at = NULL
WHERE data_sources.deleted_at IS NOT NULL;

-- name: ListDataSourcesIncludingArchived :many
SELECT id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at
FROM data_sources
WHERE tenant_id = $1 AND kind <> 'facility'
ORDER BY deleted_at NULLS FIRST, name;

-- name: ListDataSourcesByEntityKind :many
SELECT id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at
FROM data_sources
WHERE tenant_id = $1 AND entity_kind = $2 AND deleted_at IS NULL AND kind <> 'facility'
ORDER BY name;

-- name: UpdateDataSource :one
UPDATE data_sources
SET name = $3, kind = $4, zone_id = $5, config = $6, mapping = $7, schedule = $8, interval_seconds = $9, entity_kind = $10, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at;

-- name: UpdateDataSourceWithRun :one
UPDATE data_sources
SET name = $3, kind = $4, zone_id = $5, config = $6, mapping = $7, schedule = $8, interval_seconds = $9, last_run_at = $10, last_result = $11, entity_kind = $12, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at;

-- name: SoftDeleteDataSource :exec
UPDATE data_sources
SET deleted_at = now(), updated_at = now()
WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL;

-- name: DeleteDataSource :exec
DELETE FROM data_sources
WHERE id = $1 AND tenant_id = $2;

-- name: ListPollableTableSources :many
-- Worker loop: every table-kind source with a non-empty config.pollUrl
-- AND a non-zero interval_seconds AND whose last_run_at is older than
-- interval_seconds ago (or NULL). Capped at LIMIT per tick so a slow
-- poll backlog doesn't starve the next tick.
SELECT id, tenant_id, name, kind, config, mapping, schedule, interval_seconds, last_run_at, last_result
FROM data_sources
WHERE kind = 'table'
  AND deleted_at IS NULL
  AND config IS NOT NULL
  AND config->>'pollUrl' IS NOT NULL
  AND config->>'pollUrl' <> ''
  AND interval_seconds IS NOT NULL
  AND interval_seconds > 0
  AND (last_run_at IS NULL
       OR last_run_at + (interval_seconds * interval '1 second') <= now())
ORDER BY last_run_at NULLS FIRST
LIMIT 50;

-- name: UpdateDataSourcePollResult :exec
-- Worker writes the outcome of a poll: last_run_at = now, last_result =
-- a short string the SPA shows ("ok: 42 rows", "error: connection
-- refused", etc). Used by the table's Integrations tab to show the
-- last-run status without a separate events query.
UPDATE data_sources
SET last_run_at = now(), last_result = $3, updated_at = now()
WHERE id = $1 AND tenant_id = $2;

-- name: UpdateTableSourceConfig :one
-- Set or clear the external-polling binding on a table-kind data source.
-- `config` carries pollUrl/pollHeaders/pollJsonPath/pollEntityKeyField/
-- pollFieldMapping/pollPositionLatField/pollPositionLngField as JSONB.
-- `interval_seconds` is the poll cadence; NULL or 0 stops the worker.
-- Returns the updated row so the caller can hand it back to the SPA.
UPDATE data_sources
SET config = $3, interval_seconds = $4, updated_at = now()
WHERE id = $1 AND tenant_id = $2 AND kind = 'table' AND deleted_at IS NULL
RETURNING id, tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at, entity_kind, deleted_at;
