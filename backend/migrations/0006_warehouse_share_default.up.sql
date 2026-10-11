-- ---------------------------------------------------------------------------
-- Warehouse sharing + default view
--
-- Adds three columns to `zones`:
--   * default_view JSONB  — saved viewport {lng, lat, zoom, pitch, bearing,
--     floorId} that the editor and public viewer fly to on open. NULL means
--     "no saved view, fall back to legacy `center` / first shape".
--   * share_token TEXT    — unguessable token used by /share/:token routes
--     instead of the numeric ID. Unique partial index: only one warehouse
--     can own a given token, and NULLs are allowed (warehouse has never been
--     shared). The dashboard regenerates this on demand for revocation.
--   * is_public BOOLEAN   — when false, the public endpoints return 404 so
--     a leaked token can be effectively killed without rotation. Default
--     true to preserve current behaviour (anyone with the ID can view).
--
-- Existing rows get a deterministic backfill token derived from sha256(id)
-- so every warehouse is shareable immediately after the migration without
-- an app-side pass.
-- ---------------------------------------------------------------------------

ALTER TABLE zones
  ADD COLUMN default_view JSONB,
  ADD COLUMN share_token TEXT,
  ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX zones_share_token_uidx
  ON zones (share_token)
  WHERE share_token IS NOT NULL;

UPDATE zones
SET share_token = encode(sha256(id::text::bytea), 'hex')
WHERE share_token IS NULL;