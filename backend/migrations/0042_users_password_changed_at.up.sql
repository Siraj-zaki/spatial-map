-- Stamped whenever a user's password is set through the reset flow (and any
-- future change-password path). JWTs are stateless, so this is what lets a
-- reset sign out every session: the JWT middleware rejects any token whose
-- `iat` predates this timestamp. NULL means "never changed since signup" —
-- every existing token stays valid after the migration.
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
