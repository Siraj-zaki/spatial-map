-- entity_states — latest known state per (stream, entity_key).
-- Generic replacement for the per-entity state tables (`assets`,
-- `sensors`, `cameras`, `shipments`, `rfid_tags`). During the dual-
-- write transition, writers populate BOTH the legacy table AND this
-- one; the new MapDataLinkedOverlay reads from here.
--
-- `payload` is the raw JSON from the publisher — the DataLinkConfig's
-- field_mapping decides which keys drive label / color / icon / tooltip.
-- `position` is extracted at write time for spatial indexing (PostGIS
-- GIST index) whenever the payload includes lng/lat-like fields, so
-- the frontend can filter by bbox without payload parsing.

CREATE TABLE entity_states (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stream_id     BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  entity_key    TEXT   NOT NULL,
  payload       JSONB  NOT NULL,
  position      GEOMETRY(Point, 4326),
  last_seen_at  TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stream_id, entity_key)
);

CREATE INDEX entity_states_tenant_stream_idx ON entity_states (tenant_id, stream_id);
CREATE INDEX entity_states_last_seen_idx     ON entity_states (last_seen_at DESC);
CREATE INDEX entity_states_position_gix      ON entity_states USING GIST (position);
