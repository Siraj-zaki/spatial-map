DROP INDEX IF EXISTS zones_share_token_uidx;

ALTER TABLE zones
  DROP COLUMN IF EXISTS is_public,
  DROP COLUMN IF EXISTS share_token,
  DROP COLUMN IF EXISTS default_view;