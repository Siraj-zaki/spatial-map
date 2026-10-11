-- Stores the original bytes of file-backed data sources (csv / xlsx /
-- json / geojson) so they can be re-imported from the integrations page
-- without re-uploading. One row per data_source — re-upload replaces.
CREATE TABLE source_files (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  sheet_name TEXT,
  json_root_path TEXT,
  bytes BYTEA NOT NULL,
  bytes_size INT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id)
);

CREATE INDEX idx_source_files_tenant_source ON source_files(tenant_id, source_id);