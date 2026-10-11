-- Data-link config — per-warehouse binding of one Stream to one map
-- object (marker / polygon / grid cell / etc.) with user-picked visuals
-- + tooltip config + style rules. This is the core of the generic
-- data-link architecture (see DESIGN-data-link.md).
--
-- One Stream can have many DataLinkConfigs — same live feed can render
-- as a marker in one warehouse and as a polygon tint in another.
--
-- `target_shape_id` is nullable because some render modes
-- (`point-at-coord`, `heatmap`, `track`) get their geometry from the
-- payload itself and don't need to be bound to a specific shape.

CREATE TABLE data_link_configs (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id           BIGINT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  stream_id         BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  name              TEXT   NOT NULL,
  -- Shape kind the link is anchored to. When target_shape_id is null,
  -- geometry comes from the payload; target_kind is still recorded so
  -- the sidebar can group configs (e.g. "all data linked to polygons").
  target_kind       TEXT   NOT NULL,
  target_shape_id   BIGINT,
  -- Render dispatch. See DESIGN-data-link.md §5 for the mode → sub-
  -- renderer mapping.
  render_mode       TEXT   NOT NULL,
  -- User-picked payload → visual field bindings. See TS type
  -- `DataLinkFieldMapping` for shape.
  field_mapping     JSONB  NOT NULL DEFAULT '{}'::jsonb,
  -- Default visuals when the field mapping is unset or the payload
  -- lacks the field: { defaultIcon, defaultColor, defaultSize,
  -- cluster?, iconLibrary? }.
  style             JSONB  NOT NULL DEFAULT '{}'::jsonb,
  -- { trigger: 'hover'|'click', fields: string[], template?: string }
  tooltip           JSONB  NOT NULL DEFAULT '{}'::jsonb,
  -- FK array into style_rules — allows one config to compose many rules.
  style_rule_ids    BIGINT[] NOT NULL DEFAULT '{}',
  enabled           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX data_link_configs_tenant_zone_idx  ON data_link_configs (tenant_id, zone_id);
CREATE INDEX data_link_configs_stream_id_idx    ON data_link_configs (stream_id);
CREATE INDEX data_link_configs_target_idx       ON data_link_configs (target_kind, target_shape_id);
