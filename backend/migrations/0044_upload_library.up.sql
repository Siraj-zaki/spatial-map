-- Upload library: every upload belongs to a workspace (tenant_files /
-- user_models.tenant_id) AND remembers the facility it was uploaded in, so
-- the editor's pickers can offer "This facility" first and "Whole
-- workspace" one click away. Never shown across workspaces.
--
-- zone_id is "uploaded in", not "used in" — usage is derived from the rows
-- that reference the file. ON DELETE SET NULL: deleting a facility keeps
-- the workspace's uploads reusable elsewhere.
ALTER TABLE tenant_files ADD COLUMN zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL;
CREATE INDEX tenant_files_tenant_zone_idx ON tenant_files (tenant_id, zone_id);

ALTER TABLE user_models ADD COLUMN zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL;
-- Small inline preview (data:image/webp;base64,…, ~10 KB) rendered in the
-- browser at upload time. Inline on purpose: as a /files object it would
-- need refcounting and would show up as a stray image on the Files screen.
ALTER TABLE user_models ADD COLUMN thumbnail TEXT NOT NULL DEFAULT '';

-- Backfill "uploaded in" from the earliest row that uses each upload.
UPDATE tenant_files tf
SET zone_id = first_use.zone_id
FROM (
  SELECT DISTINCT ON (tenant_id, key) tenant_id, key, zone_id
  FROM (
    SELECT tenant_id, substring(image_url FROM '/files/(.+)$') AS key, zone_id, created_at FROM images WHERE zone_id IS NOT NULL
    UNION ALL
    SELECT tenant_id, substring(image_url FROM '/files/(.+)$'), zone_id, created_at FROM image_planes WHERE zone_id IS NOT NULL
  ) refs
  WHERE key IS NOT NULL
  ORDER BY tenant_id, key, created_at
) first_use
WHERE tf.tenant_id = first_use.tenant_id AND tf.object_key = first_use.key;

UPDATE user_models um
SET zone_id = first_use.zone_id
FROM (
  SELECT DISTINCT ON (tenant_id, config->>'modelAssetId') tenant_id, config->>'modelAssetId' AS asset_id, zone_id
  FROM models
  WHERE zone_id IS NOT NULL AND config->>'modelAssetId' LIKE 'user\_%'
  ORDER BY tenant_id, config->>'modelAssetId', created_at
) first_use
WHERE first_use.tenant_id = um.tenant_id AND first_use.asset_id = 'user_' || um.id;

-- Model files are owned by the workspace too, attributed to the same facility.
UPDATE tenant_files tf
SET zone_id = um.zone_id
FROM user_models um
WHERE tf.zone_id IS NULL AND um.zone_id IS NOT NULL
  AND tf.tenant_id = um.tenant_id
  AND tf.object_key = substring(um.model_url FROM '/files/(.+)$');
