-- ---------------------------------------------------------------------------
-- Object storage migration: move images and user models from inline storage
-- to URL references. Legacy inline columns are kept nullable during the
-- transition so existing rows keep working while the SPA migrates them.
-- ---------------------------------------------------------------------------

ALTER TABLE images
  ADD COLUMN image_url TEXT;

ALTER TABLE images
  ALTER COLUMN image_data DROP NOT NULL;

ALTER TABLE user_models
  ADD COLUMN model_url TEXT;

ALTER TABLE user_models
  ALTER COLUMN data DROP NOT NULL;

-- Backfill rows that already have inline data but no URL: synthesize a key
-- so the application can lazily upload them later.
UPDATE images SET image_url = '' WHERE image_url IS NULL;
UPDATE user_models SET model_url = '' WHERE model_url IS NULL;

-- Ensure non-null constraints on the URL columns for new rows going forward.
ALTER TABLE images
  ALTER COLUMN image_url SET NOT NULL;

ALTER TABLE user_models
  ALTER COLUMN model_url SET NOT NULL;

CREATE INDEX idx_images_tenant_url ON images(tenant_id, image_url);
CREATE INDEX idx_user_models_tenant_url ON user_models(tenant_id, model_url);
