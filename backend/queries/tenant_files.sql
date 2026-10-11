-- Ownership index for stored objects (migration 0043). See
-- internal/handlers/files.go and recordTenantFile in file_cleanup.go.

-- name: RecordTenantFile :exec
-- Called after every successful upload. Re-uploading the same bytes keeps
-- the original created_at and refreshes size / type.
-- zone_id is the facility it was uploaded in (migration 0044); a zone the
-- tenant doesn't own resolves to NULL, and the first facility wins.
INSERT INTO tenant_files (tenant_id, object_key, size_bytes, content_type, uploaded_by, zone_id)
VALUES (
  sqlc.arg(tenant_id), sqlc.arg(object_key), sqlc.arg(size_bytes), sqlc.arg(content_type), sqlc.narg(uploaded_by),
  (SELECT z.id FROM zones z WHERE z.id = sqlc.narg(zone_id)::bigint AND z.tenant_id = sqlc.arg(tenant_id))
)
ON CONFLICT (tenant_id, object_key) DO UPDATE
SET size_bytes = EXCLUDED.size_bytes,
    content_type = EXCLUDED.content_type,
    zone_id = COALESCE(tenant_files.zone_id, EXCLUDED.zone_id);

-- name: ListTenantFiles :many
SELECT object_key, size_bytes, content_type, created_at
FROM tenant_files
WHERE tenant_id = $1;

-- name: DeleteTenantFile :exec
DELETE FROM tenant_files WHERE tenant_id = $1 AND object_key = $2;

-- name: CountTenantFileOwners :one
-- Tenants that still own the object. Physical deletion from the Files
-- screen waits until this is zero, so one workspace freeing a shared
-- upload never removes it from another.
SELECT COUNT(*)::bigint FROM tenant_files WHERE object_key = $1;

-- name: ListOwnedFileKeys :many
-- Every owned key, any tenant — part of cmd/cleanup-orphans' keep-set so
-- the sweeper only removes objects no workspace can see.
SELECT DISTINCT object_key FROM tenant_files;

-- name: TenantOwnsFile :one
SELECT EXISTS (SELECT 1 FROM tenant_files WHERE tenant_id = $1 AND object_key = $2);

-- name: ListLibraryFiles :many
-- The editor's upload library (handlers/library.go): every object this
-- workspace uploaded, with the facility it was uploaded in.
SELECT object_key, size_bytes, content_type, zone_id, created_at
FROM tenant_files
WHERE tenant_id = $1;
