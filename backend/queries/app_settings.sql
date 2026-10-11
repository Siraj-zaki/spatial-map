-- name: UpsertAppSetting :one
INSERT INTO app_settings (key, value, updated_at)
VALUES ($1, $2, now())
ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()
RETURNING key, value, updated_at;

-- name: GetAppSetting :one
SELECT key, value, updated_at
FROM app_settings
WHERE key = $1;

-- name: ListAppSettings :many
SELECT key, value, updated_at
FROM app_settings
ORDER BY key;

-- name: DeleteAppSetting :exec
DELETE FROM app_settings
WHERE key = $1;
