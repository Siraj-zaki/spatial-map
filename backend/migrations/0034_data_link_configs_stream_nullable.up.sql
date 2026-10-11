-- Allow `data_link_configs.stream_id` to be NULL.
--
-- When this column was added (migration 0014) every data-link config
-- bound to a Stream — file/REST/webhook sources all had a mirror stream
-- from `createDataSourceMirror`. Migration 0020 added `source_id` as
-- an alternative join key, but the NOT NULL on `stream_id` was kept
-- because every existing config had one.
--
-- The new `data_source.kind = 'table'` sources (migration 0033) do NOT
-- create a mirror stream — they have no polling schedule, no webhook
-- endpoint, no token to surface on streams. A `data_link_config` for a
-- table-kind source points at the source via `source_id` and leaves
-- `stream_id` NULL. Dropping NOT NULL is what unblocks the table-kind
-- render path on the map.
--
-- Overlay read path already branches on `config.sourceId ?? 'stream:'+config.streamId`
-- (src/lib/data-link/layer-rows.ts), so the SPA is ready. sqlc's
-- `CreateDataLinkConfig` params accept nullable Int64 for stream_id,
-- so the Go side is ready too. The only consumers that assumed
-- NOT NULL were the original 0014-era read queries; the data-link v3
-- refactor already routes through sourceId-first.

ALTER TABLE data_link_configs
  ALTER COLUMN stream_id DROP NOT NULL;