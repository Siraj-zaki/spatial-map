-- GIN index on data_source_rows.payload for filter performance at scale.
-- The filter compiler renders `payload->>'field' = $N` / `payload @> $N` etc;
-- without an index those are full-table scans, which is fine at 100 rows
-- and unusable at 1M. GIN supports the containment operators the compiler
-- emits for `in` / `eq` on JSONB values.
--
-- Default opclass (jsonb_ops) is the right choice — `jsonb_path_ops` is
-- smaller but doesn't support the top-level `?` / `@>` operators the
-- compiler uses for `exists` / `missing`.
CREATE INDEX IF NOT EXISTS idx_dsr_payload_gin
  ON data_source_rows USING GIN (payload);