-- Strip absolute host prefixes from asset URLs so the DB only stores
-- the relative `/files/<key>` path (see backend/internal/store/store.go
-- `NormalizeAssetURL` for the write-time guard that keeps future rows
-- clean). Legacy rows from a period when `SGV_STORAGE.BASE_URL` was
-- misconfigured as `http://localhost:8080/files` carry the host in
-- their URL columns and break rendering the moment another host serves
-- the SPA.
--
-- Idempotent: rows already in relative form or containing no `/files/`
-- segment are left untouched (the SUBSTRING extracts nothing so the
-- update is a no-op).

UPDATE user_models
SET model_url = SUBSTRING(model_url FROM POSITION('/files/' IN model_url))
WHERE model_url ~* '^https?://[^/]+/files/';

UPDATE images
SET image_url = SUBSTRING(image_url FROM POSITION('/files/' IN image_url))
WHERE image_url ~* '^https?://[^/]+/files/';

UPDATE image_planes
SET image_url = SUBSTRING(image_url FROM POSITION('/files/' IN image_url))
WHERE image_url ~* '^https?://[^/]+/files/';

UPDATE users
SET avatar_url = SUBSTRING(avatar_url FROM POSITION('/files/' IN avatar_url))
WHERE avatar_url ~* '^https?://[^/]+/files/';
