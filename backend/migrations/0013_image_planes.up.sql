-- Image planes — user uploads an image, places it at a lng/lat anchor,
-- and the renderer wraps it in a textured-plane GLB so Mapbox's `model`
-- layer can show it at any elevation with full X/Y/Z rotation.
--
-- Storage shape mirrors `models`:
--   - lng/lat = anchor point
--   - image_url = path in the object store (`/files/<key>`)
--   - config JSONB holds the 3D transform: width, height, elevation,
--     rotationX, rotationY, rotationZ, opacity, color (tint), labels.
--
-- The GLB is generated client-side at render time (cheap — a plane is
-- ~1 KB) so we don't need to persist a derived model asset.

CREATE TABLE image_planes (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  image_url     TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT '',
  natural_width  INTEGER NOT NULL DEFAULT 0,
  natural_height INTEGER NOT NULL DEFAULT 0,
  config        JSONB NOT NULL,
  zone_id       BIGINT REFERENCES zones(id) ON DELETE SET NULL,
  floor_plan_id BIGINT,
  unit          TEXT NOT NULL,
  visible       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX image_planes_tenant_id_idx ON image_planes (tenant_id);
CREATE INDEX image_planes_zone_id_idx   ON image_planes (zone_id);
