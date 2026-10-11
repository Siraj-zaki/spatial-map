-- Reverse the sidecar tables. The `data_source_kind` enum value 'table'
-- cannot be removed in Postgres (no `ALTER TYPE ... REMOVE VALUE`), so
-- it stays in the catalog unused after this down migration — same
-- trade-off migration 0018 accepts for `data_source_entity_kind`.

DROP TABLE table_api_tokens;
DROP TABLE data_source_row_events;
DROP TABLE table_field_definitions;