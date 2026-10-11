-- Per-table activity for the Tables screen, one round trip each instead
-- of a query per table. Grouped over every source in the tenant; the
-- handler keeps only table-kind ones.

-- name: ListTableRowStats :many
SELECT source_id,
       COUNT(*)::bigint            AS row_count,
       MAX(updated_at)::timestamptz AS last_write_at
FROM data_source_rows
WHERE tenant_id = $1
GROUP BY source_id;

-- name: ListTableKeyStats :many
-- Active (un-revoked) API keys per table and when any of them last wrote.
SELECT source_id,
       COUNT(*)::bigint               AS active_keys,
       MAX(last_used_at)::timestamptz AS key_last_used_at
FROM table_api_tokens
WHERE tenant_id = $1 AND revoked_at IS NULL
GROUP BY source_id;
