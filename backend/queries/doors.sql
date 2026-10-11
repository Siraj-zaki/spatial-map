-- name: CreateDoor :one
INSERT INTO doors (tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: GetDoor :one
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM doors
WHERE id = $1 AND tenant_id = $2;

-- name: ListDoors :many
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM doors
WHERE tenant_id = $1
ORDER BY name;

-- name: UpdateDoor :one
UPDATE doors
SET name = $3, vertices = $4, rotation = $5, config = $6, zone_id = $7, floor_plan_id = $8, unit = $9, visible = $10, updated_at = now()
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at;

-- name: DeleteDoor :exec
DELETE FROM doors
WHERE id = $1 AND tenant_id = $2;

-- name: ListDoorsByZone :many
-- Public read (no tenant scope) for the shareable presentation view.
SELECT id, tenant_id, name, vertices, rotation, config, zone_id, floor_plan_id, unit, visible, created_at, updated_at
FROM doors
WHERE zone_id = $1
ORDER BY name;
