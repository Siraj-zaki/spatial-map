-- Bulk-assign queries. One UPDATE per shape kind that reassigns
-- `zone_id` and/or `floor_plan_id` on all rows in an id list in a
-- single statement. Frontend `BulkAssignDialog` (bulk-assign-dialog.tsx)
-- was previously firing N per-id PATCHes serially, which meant a
-- 200-item bulk assign hit the API 200 times sequentially — a very
-- long wait and a lot of noise in the SSE stream. These queries
-- collapse that to one round-trip per kind.
--
-- Semantics of the two set-flags: the frontend distinguishes three
-- states per field (skip / clear / assign to value). We can't express
-- that with a single nullable parameter (`null` collides with the
-- "clear" semantic), so we take a boolean `set_*` flag plus the value.
-- Flag = false → keep the column untouched. Flag = true + value NULL
-- → set NULL. Flag = true + value present → set to value.
--
-- Every query is tenant-scoped and returns the ids that were actually
-- updated so the handler can broadcast SSE for exactly those rows.
-- `id = ANY($n::bigint[])` gives us a single index-friendly plan.

-- name: BulkAssignPolygons :many
UPDATE polygons
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignGrids :many
UPDATE grids
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignMarkers :many
UPDATE markers
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignCircles :many
UPDATE circles
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignLines :many
UPDATE lines
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignModels :many
UPDATE models
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignStairs :many
UPDATE stairs
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignTextLabels :many
UPDATE text_labels
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignImages :many
UPDATE images
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignDoors :many
UPDATE doors
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;

-- name: BulkAssignImagePlanes :many
UPDATE image_planes
SET
    zone_id       = CASE WHEN sqlc.arg(set_zone)::boolean  THEN sqlc.narg(zone_id)::bigint  ELSE zone_id END,
    floor_plan_id = CASE WHEN sqlc.arg(set_floor)::boolean THEN sqlc.narg(floor_plan_id)::bigint ELSE floor_plan_id END,
    updated_at    = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(ids)::bigint[])
RETURNING id;
