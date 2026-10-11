-- Column order below matches the auto-generated `db.DataLinkConfig`
-- model struct so sqlc reuses the shared type. source_id (v3 addition)
-- lives at the end since ALTER TABLE appended it.

-- name: CreateDataLinkConfig :one
INSERT INTO data_link_configs (
  tenant_id, zone_id, stream_id, name, target_kind, target_shape_id,
  render_mode, field_mapping, style, tooltip, style_rule_ids, enabled, source_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING id, tenant_id, zone_id, stream_id, name, target_kind, target_shape_id,
          render_mode, field_mapping, style, tooltip, style_rule_ids, enabled,
          created_at, updated_at, source_id;

-- name: GetDataLinkConfig :one
SELECT id, tenant_id, zone_id, stream_id, name, target_kind, target_shape_id,
       render_mode, field_mapping, style, tooltip, style_rule_ids, enabled,
       created_at, updated_at, source_id
FROM data_link_configs
WHERE id = $1 AND tenant_id = $2;

-- name: ListDataLinkConfigs :many
SELECT id, tenant_id, zone_id, stream_id, name, target_kind, target_shape_id,
       render_mode, field_mapping, style, tooltip, style_rule_ids, enabled,
       created_at, updated_at, source_id
FROM data_link_configs
WHERE tenant_id = $1
ORDER BY zone_id, name;

-- name: ListDataLinkConfigsByZone :many
SELECT id, tenant_id, zone_id, stream_id, name, target_kind, target_shape_id,
       render_mode, field_mapping, style, tooltip, style_rule_ids, enabled,
       created_at, updated_at, source_id
FROM data_link_configs
WHERE zone_id = $1
ORDER BY name;

-- name: ListDataLinkConfigsByStream :many
SELECT id, tenant_id, zone_id, stream_id, name, target_kind, target_shape_id,
       render_mode, field_mapping, style, tooltip, style_rule_ids, enabled,
       created_at, updated_at, source_id
FROM data_link_configs
WHERE stream_id = $1
ORDER BY name;

-- name: ListDataLinkConfigsBySource :many
SELECT id, tenant_id, zone_id, stream_id, name, target_kind, target_shape_id,
       render_mode, field_mapping, style, tooltip, style_rule_ids, enabled,
       created_at, updated_at, source_id
FROM data_link_configs
WHERE source_id = $1
ORDER BY name;

-- name: UpdateDataLinkConfig :one
UPDATE data_link_configs
SET zone_id         = $3,
    stream_id       = $4,
    name            = $5,
    target_kind     = $6,
    target_shape_id = $7,
    render_mode     = $8,
    field_mapping   = $9,
    style           = $10,
    tooltip         = $11,
    style_rule_ids  = $12,
    enabled         = $13,
    source_id       = $14,
    updated_at      = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, zone_id, stream_id, name, target_kind, target_shape_id,
          render_mode, field_mapping, style, tooltip, style_rule_ids, enabled,
          created_at, updated_at, source_id;

-- name: DeleteDataLinkConfig :exec
DELETE FROM data_link_configs
WHERE id = $1 AND tenant_id = $2;

-- name: ListDataLinkConfigRefsForSource :many
-- Data-link configs that would be affected if the given data_source
-- (and its mirror stream, if any) were hard-deleted. Used as a
-- pre-flight guard by the Integrations delete endpoint so users are
-- told to remove the link from the warehouse first instead of silently
-- losing the config to FK cascade.
SELECT dlc.id, dlc.name, dlc.zone_id, z.name AS zone_name
FROM data_link_configs dlc
JOIN zones z ON z.id = dlc.zone_id
WHERE dlc.tenant_id = $1
  AND (
    dlc.source_id = $2
    OR dlc.stream_id IN (
      SELECT s.id FROM streams s
      WHERE s.tenant_id = $1
        AND s.data_source_id = $2
    )
  )
ORDER BY z.name, dlc.name;
