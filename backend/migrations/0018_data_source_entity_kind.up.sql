-- V3 refactor — sources as datasets (DESIGN-integrations-v3.md §3.1).
--
-- Adds `entity_kind` to `data_sources` so /integrations can tag every
-- connection with the kind of data it produces. Downstream (validation,
-- default match strategy in the layer editor, default render mode)
-- keys off this field.
--
-- Advisory only: a marker source can still drive a polygon-tint layer.
-- The tag steers UX defaults, not backend enforcement.

CREATE TYPE data_source_entity_kind AS ENUM (
  'polygon',
  'circle',
  'marker',
  'asset',
  'camera',
  'sensor',
  'shipment',
  'rfid-tag',
  'rack-cell',
  'streaming'
);

ALTER TABLE data_sources
  ADD COLUMN entity_kind data_source_entity_kind;

-- Existing rows default to 'marker' — the closest generic POI-ish
-- concept. Users can update via PATCH /data-sources/:id afterwards.
UPDATE data_sources SET entity_kind = 'marker' WHERE entity_kind IS NULL;

ALTER TABLE data_sources
  ALTER COLUMN entity_kind SET NOT NULL;
