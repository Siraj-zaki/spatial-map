-- name: CreateSourceFile :one
INSERT INTO source_files (tenant_id, source_id, filename, source_kind, sheet_name, json_root_path, bytes, bytes_size, content_sha256)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, tenant_id, source_id, filename, source_kind, sheet_name, json_root_path, bytes_size, content_sha256, created_at, updated_at;

-- name: UpsertSourceFile :one
INSERT INTO source_files (tenant_id, source_id, filename, source_kind, sheet_name, json_root_path, bytes, bytes_size, content_sha256)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (source_id) DO UPDATE SET
  filename = EXCLUDED.filename,
  source_kind = EXCLUDED.source_kind,
  sheet_name = EXCLUDED.sheet_name,
  json_root_path = EXCLUDED.json_root_path,
  bytes = EXCLUDED.bytes,
  bytes_size = EXCLUDED.bytes_size,
  content_sha256 = EXCLUDED.content_sha256,
  updated_at = now()
RETURNING id, tenant_id, source_id, filename, source_kind, sheet_name, json_root_path, bytes_size, content_sha256, created_at, updated_at;

-- name: GetSourceFileBySource :one
SELECT id, tenant_id, source_id, filename, source_kind, sheet_name, json_root_path, bytes, bytes_size, content_sha256, created_at, updated_at
FROM source_files
WHERE source_id = $1 AND tenant_id = $2;

-- name: DeleteSourceFile :exec
DELETE FROM source_files
WHERE source_id = $1 AND tenant_id = $2;