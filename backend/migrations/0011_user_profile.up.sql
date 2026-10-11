-- User profile fields. All optional so existing rows (created before this
-- migration ran) keep working without backfill.
ALTER TABLE users
  ADD COLUMN display_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN bio          TEXT NOT NULL DEFAULT '',
  ADD COLUMN location     TEXT NOT NULL DEFAULT '',
  ADD COLUMN pronouns     TEXT NOT NULL DEFAULT '',
  ADD COLUMN job_title    TEXT NOT NULL DEFAULT '',
  ADD COLUMN avatar_url   TEXT NOT NULL DEFAULT '';
