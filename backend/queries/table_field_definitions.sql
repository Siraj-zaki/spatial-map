-- CRUD for the per-thing-type field schema. One row per (source_id,
-- field_key) — the UNIQUE constraint enforces the no-collision invariant.
-- The handler reads the ordered list when validating public CRUD writes
-- and when rendering the field editor in the SPA.

-- name: CreateTableFieldDefinition :one
INSERT INTO table_field_definitions (
  tenant_id, source_id, field_key, field_label, data_type,
  is_required, is_unique, sort_order
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, tenant_id, source_id, field_key, field_label, data_type,
          is_required, is_unique, sort_order, created_at, updated_at;

-- name: ListTableFieldDefinitions :many
SELECT id, tenant_id, source_id, field_key, field_label, data_type,
       is_required, is_unique, sort_order, created_at, updated_at
FROM table_field_definitions
WHERE tenant_id = $1 AND source_id = $2
ORDER BY sort_order, field_key;

-- name: GetTableFieldDefinition :one
SELECT id, tenant_id, source_id, field_key, field_label, data_type,
       is_required, is_unique, sort_order, created_at, updated_at
FROM table_field_definitions
WHERE id = $1 AND tenant_id = $2;

-- name: DeleteTableFieldDefinition :exec
-- Single-field delete — used by PATCH /tables/{id} when the user removes
-- a field. Existing rows keep the orphan key in their payload JSONB
-- (no in-place migration); the field just disappears from the schema.
DELETE FROM table_field_definitions
WHERE id = $1 AND tenant_id = $2 AND source_id = $3;

-- name: DeleteTableFieldDefinitionsBySource :exec
-- Cascade proxy — used when the thing type is deleted. FK CASCADE on
-- the table itself already does this, but the handler calls this to
-- be explicit and to keep the delete path idempotent.
DELETE FROM table_field_definitions
WHERE source_id = $1 AND tenant_id = $2;

-- name: UpdateTableFieldDefinition :one
-- Update label / data_type / is_required / is_unique / sort_order. The
-- field_key is NOT updatable here — renaming a field is treated as
-- remove+add in the handler so existing rows don't silently lose
-- their data via a key change.
UPDATE table_field_definitions
SET field_label = $4,
    data_type   = $5,
    is_required = $6,
    is_unique   = $7,
    sort_order  = $8,
    updated_at  = now()
WHERE id = $1 AND tenant_id = $2 AND source_id = $3
RETURNING id, tenant_id, source_id, field_key, field_label, data_type,
          is_required, is_unique, sort_order, created_at, updated_at;