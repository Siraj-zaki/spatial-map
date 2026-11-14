-- name: CreateBin :one
INSERT INTO bins (tenant_id, target_kind, grid_id, row, col, level, shape_id, status, sku, capacity, notes, external_code, custom_properties, sync_source, floor_plan_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
RETURNING id, tenant_id, target_kind, grid_id, row, col, level, shape_id, status, sku, capacity, notes, external_code, custom_properties, last_synced_at, sync_source, floor_plan_id, updated_at;

-- name: GetBin :one
SELECT id, tenant_id, target_kind, grid_id, row, col, level, shape_id, status, sku, capacity, notes, external_code, custom_properties, last_synced_at, sync_source, floor_plan_id, updated_at
FROM bins
WHERE id = $1 AND tenant_id = $2;

-- name: ListBins :many
SELECT id, tenant_id, target_kind, grid_id, row, col, level, shape_id, status, sku, capacity, notes, external_code, custom_properties, last_synced_at, sync_source, floor_plan_id, updated_at
FROM bins
WHERE tenant_id = $1
ORDER BY id;

-- name: ListBinsByZone :many
-- One facility's bins: grid cells of its racks / seating, and bins bound to its shapes. The map asks
-- with ?zoneId — the whole workspace's bins (tens of thousands of seats) made every facility open slow.
SELECT b.id, b.tenant_id, b.target_kind, b.grid_id, b.row, b.col, b.level, b.shape_id, b.status, b.sku, b.capacity, b.notes, b.external_code, b.custom_properties, b.last_synced_at, b.sync_source, b.floor_plan_id, b.updated_at
FROM bins b
WHERE b.tenant_id = sqlc.arg(tenant_id) AND (
  b.grid_id IN (SELECT g.id FROM grids g WHERE g.tenant_id = sqlc.arg(tenant_id) AND g.zone_id = sqlc.arg(zone_id)::bigint)
  OR (b.target_kind = 'polygon' AND b.shape_id IN (SELECT x.id FROM polygons x WHERE x.tenant_id = sqlc.arg(tenant_id) AND x.zone_id = sqlc.arg(zone_id)::bigint))
  OR (b.target_kind = 'circle'  AND b.shape_id IN (SELECT x.id FROM circles  x WHERE x.tenant_id = sqlc.arg(tenant_id) AND x.zone_id = sqlc.arg(zone_id)::bigint))
  OR (b.target_kind = 'line'    AND b.shape_id IN (SELECT x.id FROM lines    x WHERE x.tenant_id = sqlc.arg(tenant_id) AND x.zone_id = sqlc.arg(zone_id)::bigint))
  OR (b.target_kind = 'marker'  AND b.shape_id IN (SELECT x.id FROM markers  x WHERE x.tenant_id = sqlc.arg(tenant_id) AND x.zone_id = sqlc.arg(zone_id)::bigint))
  OR (b.target_kind = 'image'   AND b.shape_id IN (SELECT x.id FROM images   x WHERE x.tenant_id = sqlc.arg(tenant_id) AND x.zone_id = sqlc.arg(zone_id)::bigint))
  OR (b.target_kind = 'model'   AND b.shape_id IN (SELECT x.id FROM models   x WHERE x.tenant_id = sqlc.arg(tenant_id) AND x.zone_id = sqlc.arg(zone_id)::bigint))
)
ORDER BY b.id;

-- name: UpdateBin :one
UPDATE bins
SET target_kind = $3, grid_id = $4, row = $5, col = $6, level = $7, shape_id = $8, status = $9, sku = $10, capacity = $11, notes = $12, external_code = $13, custom_properties = $14, sync_source = $15, floor_plan_id = $16, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, target_kind, grid_id, row, col, level, shape_id, status, sku, capacity, notes, external_code, custom_properties, last_synced_at, sync_source, floor_plan_id, updated_at;

-- name: DeleteBin :exec
DELETE FROM bins
WHERE id = $1 AND tenant_id = $2;

-- name: GetBinByExternalCode :one
SELECT id, tenant_id, target_kind, grid_id, row, col, level, shape_id, status, sku, capacity, notes, external_code, custom_properties, last_synced_at, sync_source, floor_plan_id, updated_at
FROM bins
WHERE tenant_id = $1 AND external_code = $2;

-- name: GetBinByGridCell :one
SELECT id, tenant_id, target_kind, grid_id, row, col, level, shape_id, status, sku, capacity, notes, external_code, custom_properties, last_synced_at, sync_source, floor_plan_id, updated_at
FROM bins
WHERE tenant_id = $1 AND grid_id = $2 AND row = $3 AND col = $4 AND level = $5;

-- name: GetBinByShape :one
SELECT id, tenant_id, target_kind, grid_id, row, col, level, shape_id, status, sku, capacity, notes, external_code, custom_properties, last_synced_at, sync_source, floor_plan_id, updated_at
FROM bins
WHERE tenant_id = $1 AND target_kind = $2 AND shape_id = $3;

-- name: ListBinsByGridZone :many
-- Public read (no tenant scope). Returns bins attached to grids whose
-- zone_id matches $1. Shape-attached bins (polygons/circles/etc.) are
-- intentionally omitted from v1 — they're a small minority and would
-- require 9 subqueries or a UNION ALL.
SELECT b.id, b.tenant_id, b.target_kind, b.grid_id, b.row, b.col, b.level, b.shape_id, b.status, b.sku, b.capacity, b.notes, b.external_code, b.custom_properties, b.last_synced_at, b.sync_source, b.floor_plan_id, b.updated_at
FROM bins b
JOIN grids g ON g.id = b.grid_id
WHERE g.zone_id = $1
ORDER BY b.id;
