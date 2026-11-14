-- Column order in SELECTs/RETURNINGs matches the physical table column order
-- so sqlc returns the canonical `db.User` type rather than per-query Row types.
-- Order is: id, email, password_hash, (timestamps from migration 0010),
-- (profile fields from migration 0011 in alter-table order), (verified_at
-- from migration 0022), (password_changed_at from migration 0042).

-- name: CreateUser :one
INSERT INTO users (email, password_hash)
VALUES (lower(sqlc.arg(email)::text), sqlc.arg(password_hash)::text)
RETURNING id, email, password_hash, created_at, updated_at, last_login_at,
          display_name, bio, location, pronouns, job_title, avatar_url, verified_at, password_changed_at;

-- name: GetUserByEmail :one
SELECT id, email, password_hash, created_at, updated_at, last_login_at,
       display_name, bio, location, pronouns, job_title, avatar_url, verified_at, password_changed_at
FROM users
WHERE lower(email) = lower(sqlc.arg(email)::text);

-- name: GetUserByID :one
SELECT id, email, password_hash, created_at, updated_at, last_login_at,
       display_name, bio, location, pronouns, job_title, avatar_url, verified_at, password_changed_at
FROM users
WHERE id = $1;

-- name: UpdateUserLastLogin :exec
UPDATE users SET last_login_at = now(), updated_at = now()
WHERE id = $1;

-- name: UpdateUserPassword :one
-- Also stamps password_changed_at, which revokes every JWT issued before
-- it (see api.SessionRevocationCheck). Returns the stamp so the caller can
-- prime the middleware's cache without a second read.
UPDATE users
SET password_hash = $2, password_changed_at = now(), updated_at = now()
WHERE id = $1
RETURNING password_changed_at;

-- name: GetUserPasswordChangedAt :one
-- Hot path: read by the JWT middleware (behind a short cache) on every
-- authenticated request, so it touches only the primary-key index.
SELECT password_changed_at FROM users WHERE id = $1;

-- name: MarkUserVerified :exec
-- Called from the complete-signup handler after OTP verification succeeds
-- and the password is set. Also stamped by the bootstrap admin path.
UPDATE users SET verified_at = now(), updated_at = now()
WHERE id = $1 AND verified_at IS NULL;

-- name: UpdateUserProfile :one
-- Updates editable profile fields. Avatar is updated via a separate query
-- so the upload endpoint can stay focused. Email + password are immutable
-- here for safety — there are dedicated endpoints for those.
UPDATE users
SET display_name = $2,
    bio          = $3,
    location     = $4,
    pronouns     = $5,
    job_title    = $6,
    updated_at   = now()
WHERE id = $1
RETURNING id, email, password_hash, created_at, updated_at, last_login_at,
          display_name, bio, location, pronouns, job_title, avatar_url, verified_at, password_changed_at;

-- name: UpdateUserAvatar :one
UPDATE users
SET avatar_url = $2,
    updated_at = now()
WHERE id = $1
RETURNING id, email, password_hash, created_at, updated_at, last_login_at,
          display_name, bio, location, pronouns, job_title, avatar_url, verified_at, password_changed_at;

-- name: GmailInboxHasUser :one
-- True when an account already uses the Gmail inbox `identity` — the local
-- part without dots or a +suffix (handlers/signup_guard.go gmailIdentity):
-- le.d.ao.0.0.8@gmail.com and ledao008+x@googlemail.com are the same inbox.
SELECT EXISTS (
  SELECT 1 FROM users
  WHERE split_part(lower(email), '@', 2) IN ('gmail.com', 'googlemail.com')
    AND replace(split_part(split_part(lower(email), '@', 1), '+', 1), '.', '') = sqlc.arg(identity)::text
)::boolean;
