-- OTP codes are short-lived (default 10 minutes). Each row stores the
-- bcrypt-style hash of the emailed 6-digit code so a DB dump does not
-- expose live codes. The handler looks up the LATEST unused, unexpired
-- row for an email, and increments `attempts` when the user enters a
-- wrong code — after N wrong attempts the row is marked used to force a
-- fresh request.

-- name: CreateOTPCode :one
INSERT INTO otp_codes (email, code_hash, purpose, expires_at)
VALUES (lower(sqlc.arg(email)::text), sqlc.arg(code_hash)::text, sqlc.arg(purpose)::text, sqlc.arg(expires_at)::timestamptz)
RETURNING id, email, code_hash, purpose, attempts, expires_at, used_at, created_at;

-- name: GetLatestActiveOTP :one
SELECT id, email, code_hash, purpose, attempts, expires_at, used_at, created_at
FROM otp_codes
WHERE lower(email) = lower(sqlc.arg(email)::text)
  AND purpose = sqlc.arg(purpose)::text
  AND used_at IS NULL
  AND expires_at > now()
ORDER BY created_at DESC
LIMIT 1;

-- name: MarkOTPUsed :exec
UPDATE otp_codes SET used_at = now() WHERE id = $1;

-- name: IncrementOTPAttempts :exec
UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1;

-- name: InvalidateOTPCodesForEmail :exec
-- Marks any pending OTPs for the email as used. Called before issuing a
-- fresh code so only one code is ever active at a time.
UPDATE otp_codes SET used_at = now()
WHERE lower(email) = lower(sqlc.arg(email)::text)
  AND purpose = sqlc.arg(purpose)::text
  AND used_at IS NULL;
