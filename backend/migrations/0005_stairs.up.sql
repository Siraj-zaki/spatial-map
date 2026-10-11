-- Stairs: a parametric 3D staircase placed between two geographic points.
-- Modeled on the `lines` table so it can reuse the shared shape handlers
-- and the `vertices` JSONB convention (a 2-element [[lng,lat],[lng,lat]]
-- array carrying the bottom anchor and the top anchor of the run).
CREATE TABLE stairs (
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

CREATE INDEX stairs_tenant_idx ON stairs (tenant_id);
CREATE INDEX stairs_zone_idx ON stairs (zone_id);
