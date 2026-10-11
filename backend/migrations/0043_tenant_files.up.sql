-- Which workspace uploaded which stored object. The object store is shared
-- by every tenant and keys are content-addressed (`name-<sha>.ext`), so the
-- same bytes uploaded by two workspaces are ONE object with two owners —
-- hence (tenant_id, object_key), not a key column on some upload row.
--
-- Before this table, a file only "belonged" to a tenant once a shape row
-- pointed at it; unused uploads had no tenant at all, so the Files screen
-- showed them to every workspace. This is an ownership index, not a
-- refcount: cleanupObjectURL still decides physical deletion from the URL
-- columns, and the Files handler skips rows whose object is gone.
CREATE TABLE tenant_files (
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_key   TEXT NOT NULL,
  size_bytes   BIGINT,
  content_type TEXT,
  uploaded_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_key)
);

CREATE INDEX tenant_files_object_key_idx ON tenant_files (object_key);

-- Backfill from every URL column a tenant already uses. Unused objects with
-- no referencing row can't be attributed and stay owner-less: hidden from
-- every workspace's Files screen, swept by cmd/cleanup-orphans.
INSERT INTO tenant_files (tenant_id, object_key, created_at)
SELECT tenant_id, key, min(created_at)
FROM (
  SELECT tenant_id, substring(image_url FROM '/files/(.+)$') AS key, created_at FROM images
  UNION ALL
  SELECT tenant_id, substring(image_url FROM '/files/(.+)$'), created_at FROM image_planes
  UNION ALL
  SELECT tenant_id, substring(model_url FROM '/files/(.+)$'), created_at FROM user_models
) refs
WHERE key IS NOT NULL AND key <> ''
GROUP BY tenant_id, key
ON CONFLICT DO NOTHING;
