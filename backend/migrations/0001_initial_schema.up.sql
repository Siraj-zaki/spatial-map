CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE binding_kind AS ENUM (
  'grid-cell', 'polygon', 'circle', 'line', 'marker', 'image', 'model'
);

CREATE TYPE bin_status AS ENUM ('empty', 'occupied', 'reserved');

CREATE TYPE data_source_kind AS ENUM ('csv', 'xlsx', 'json', 'geojson', 'rest', 'webhook');

CREATE TYPE shipment_state AS ENUM (
  'scheduled', 'arrived', 'docked', 'loading', 'departed', 'cancelled'
);

CREATE TYPE import_job_status AS ENUM ('running', 'ok', 'error', 'partial');

-- ---------------------------------------------------------------------------
-- Tenants + settings
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Reference / config tables
-- ---------------------------------------------------------------------------
CREATE TABLE attribute_definitions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  unit TEXT,
  enum_values TEXT[],
  default_value JSONB,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, scope, key)
);

CREATE TABLE style_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  zone_id BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INT NOT NULL DEFAULT 0,
  combine TEXT NOT NULL,
  conditions JSONB NOT NULL,
  style JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE import_jobs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status import_job_status NOT NULL,
  stats JSONB NOT NULL,
  error_report TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE entity_references (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  label TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  source_stream_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, type, source_key)
);

-- ---------------------------------------------------------------------------
-- Spatial catalog
-- ---------------------------------------------------------------------------
CREATE TABLE zones (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  center GEOMETRY(POINT, 4326),
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE grids (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_lng DOUBLE PRECISION NOT NULL,
  start_lat DOUBLE PRECISION NOT NULL,
  current_lng DOUBLE PRECISION NOT NULL,
  current_lat DOUBLE PRECISION NOT NULL,
  config JSONB NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  floor_plan_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE polygons (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  vertices JSONB NOT NULL,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  config JSONB NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  floor_plan_id BIGINT,
  unit TEXT NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE circles (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  center_lng DOUBLE PRECISION,
  center_lat DOUBLE PRECISION,
  radius DOUBLE PRECISION,
  start_lng DOUBLE PRECISION,
  start_lat DOUBLE PRECISION,
  current_lng DOUBLE PRECISION,
  current_lat DOUBLE PRECISION,
  cell_radius DOUBLE PRECISION,
  cell_size DOUBLE PRECISION,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  config JSONB NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  floor_plan_id BIGINT,
  unit TEXT NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lines (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  vertices JSONB NOT NULL,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  config JSONB NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  floor_plan_id BIGINT,
  unit TEXT NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE markers (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  bearing DOUBLE PRECISION NOT NULL DEFAULT 0,
  config JSONB NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  floor_plan_id BIGINT,
  unit TEXT NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE images (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_lng DOUBLE PRECISION NOT NULL,
  start_lat DOUBLE PRECISION NOT NULL,
  current_lng DOUBLE PRECISION NOT NULL,
  current_lat DOUBLE PRECISION NOT NULL,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  image_data TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  natural_width INT NOT NULL,
  natural_height INT NOT NULL,
  config JSONB NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  unit TEXT NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE models (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  config JSONB NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  floor_plan_id BIGINT,
  unit TEXT NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE text_labels (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  config JSONB NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  floor_plan_id BIGINT,
  unit TEXT NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_models (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  bytes BIGINT NOT NULL,
  category TEXT,
  default_scale DOUBLE PRECISION,
  bounding_center JSONB,
  inspector JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Bins
-- ---------------------------------------------------------------------------
CREATE TABLE bins (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_kind binding_kind NOT NULL,
  grid_id BIGINT REFERENCES grids(id) ON DELETE CASCADE,
  row INT,
  col INT,
  level INT DEFAULT 0,
  shape_id BIGINT,
  status bin_status,
  sku TEXT,
  capacity DOUBLE PRECISION,
  notes TEXT,
  external_code TEXT,
  custom_properties JSONB NOT NULL DEFAULT '{}',
  last_synced_at TIMESTAMPTZ,
  sync_source BIGINT,
  floor_plan_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, grid_id, row, col, level),
  UNIQUE(tenant_id, target_kind, shape_id)
);

-- ---------------------------------------------------------------------------
-- Data-link layer
-- ---------------------------------------------------------------------------
CREATE TABLE connections (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  auth JSONB NOT NULL DEFAULT '{}',
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE streams (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id BIGINT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  data_source_id BIGINT,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  binding JSONB NOT NULL,
  endpoint JSONB NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  schedule TEXT,
  interval_seconds INT,
  last_run_at TIMESTAMPTZ,
  last_result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE data_sources (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind data_source_kind NOT NULL,
  zone_id BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  config JSONB NOT NULL DEFAULT '{}',
  mapping JSONB NOT NULL,
  schedule TEXT,
  interval_seconds INT,
  last_run_at TIMESTAMPTZ,
  last_result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Live entity state tables
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  source_stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  type TEXT,
  label TEXT,
  current_position GEOMETRY(POINT, 4326),
  heading DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  status TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, asset_id, source_stream_id)
);

CREATE TABLE asset_positions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_stream_id BIGINT NOT NULL,
  asset_id TEXT NOT NULL,
  position GEOMETRY(POINT, 4326) NOT NULL,
  heading DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  ts BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sensors (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sensor_id TEXT NOT NULL,
  source_stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  kind TEXT,
  unit TEXT,
  label TEXT,
  last_value DOUBLE PRECISION,
  last_ts BIGINT,
  mounted_on JSONB,
  position GEOMETRY(POINT, 4326),
  thresholds JSONB,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, sensor_id, source_stream_id)
);

CREATE TABLE sensor_readings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_stream_id BIGINT NOT NULL,
  sensor_id TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  ts BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rfid_tags (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL,
  source_stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  last_antenna_id TEXT,
  last_position GEOMETRY(POINT, 4326),
  last_rssi DOUBLE PRECISION,
  last_zone_id BIGINT,
  label TEXT,
  last_read_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, tag_id, source_stream_id)
);

CREATE TABLE rfid_reads (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_stream_id BIGINT NOT NULL,
  tag_id TEXT NOT NULL,
  antenna_id TEXT,
  position GEOMETRY(POINT, 4326) NOT NULL,
  rssi DOUBLE PRECISION,
  zone_id BIGINT,
  ts BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shipment_id TEXT NOT NULL,
  source_stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  kind TEXT,
  state shipment_state NOT NULL,
  carrier TEXT,
  label TEXT,
  current_position GEOMETRY(POINT, 4326),
  heading DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  route GEOMETRY(LINESTRING, 4326),
  door_id BIGINT,
  door_kind TEXT,
  scheduled_at TIMESTAMPTZ,
  eta_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, shipment_id, source_stream_id)
);

CREATE TABLE cameras (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  camera_id TEXT NOT NULL,
  source_stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  label TEXT,
  kind TEXT,
  height_m DOUBLE PRECISION,
  yaw DOUBLE PRECISION,
  pitch DOUBLE PRECISION,
  fov_deg DOUBLE PRECISION DEFAULT 60,
  view_distance_m DOUBLE PRECISION DEFAULT 25,
  position GEOMETRY(POINT, 4326),
  mounted_on JSONB,
  stream_url TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, camera_id, source_stream_id)
);

CREATE TABLE cv_detections (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_stream_id BIGINT NOT NULL,
  camera_id TEXT NOT NULL,
  object_class TEXT NOT NULL,
  count INT NOT NULL DEFAULT 1,
  confidence DOUBLE PRECISION,
  bbox DOUBLE PRECISION[4],
  target_shape_kind TEXT,
  target_shape_id BIGINT,
  position GEOMETRY(POINT, 4326),
  ts BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX idx_zones_tenant_name ON zones(tenant_id, name);
CREATE INDEX idx_grids_tenant_zone ON grids(tenant_id, zone_id);

CREATE INDEX idx_polygons_tenant_zone ON polygons(tenant_id, zone_id);
CREATE INDEX idx_circles_tenant_zone ON circles(tenant_id, zone_id);
CREATE INDEX idx_lines_tenant_zone ON lines(tenant_id, zone_id);
CREATE INDEX idx_markers_tenant_zone ON markers(tenant_id, zone_id);
CREATE INDEX idx_images_tenant_zone ON images(tenant_id, zone_id);
CREATE INDEX idx_models_tenant_zone ON models(tenant_id, zone_id);
CREATE INDEX idx_text_labels_tenant_zone ON text_labels(tenant_id, zone_id);

CREATE INDEX idx_bins_external_code ON bins(tenant_id, external_code);
CREATE INDEX idx_bins_sync_source ON bins(tenant_id, sync_source);
CREATE INDEX idx_bins_grid ON bins(tenant_id, grid_id);

CREATE INDEX idx_connections_tenant_transport ON connections(tenant_id, transport);
CREATE INDEX idx_streams_tenant_entity ON streams(tenant_id, entity_type);
CREATE INDEX idx_streams_connection ON streams(connection_id);
CREATE INDEX idx_streams_data_source ON streams(data_source_id);

CREATE INDEX idx_assets_tenant_stream ON assets(tenant_id, source_stream_id);
CREATE INDEX idx_assets_position ON assets USING GIST(current_position);
CREATE INDEX idx_sensors_tenant_stream ON sensors(tenant_id, source_stream_id);
CREATE INDEX idx_rfid_tags_tenant_stream ON rfid_tags(tenant_id, source_stream_id);
CREATE INDEX idx_shipments_tenant_stream ON shipments(tenant_id, source_stream_id);
CREATE INDEX idx_cameras_tenant_stream ON cameras(tenant_id, source_stream_id);


-- GIN indexes on frequently-filtered JSONB columns
CREATE INDEX idx_streams_binding ON streams USING GIN(binding);
CREATE INDEX idx_streams_endpoint ON streams USING GIN(endpoint);
CREATE INDEX idx_connections_auth ON connections USING GIN(auth);
CREATE INDEX idx_connections_config ON connections USING GIN(config);
CREATE INDEX idx_data_sources_config ON data_sources USING GIN(config);
CREATE INDEX idx_style_rules_style ON style_rules USING GIN(style);
