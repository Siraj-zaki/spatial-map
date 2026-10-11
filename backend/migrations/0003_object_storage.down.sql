-- ---------------------------------------------------------------------------
-- Revert object storage migration.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_images_tenant_url;
DROP INDEX IF EXISTS idx_user_models_tenant_url;

ALTER TABLE images
  DROP COLUMN IF EXISTS image_url;

ALTER TABLE images
  ALTER COLUMN image_data SET NOT NULL;

ALTER TABLE user_models
  DROP COLUMN IF EXISTS model_url;

ALTER TABLE user_models
  ALTER COLUMN data SET NOT NULL;
