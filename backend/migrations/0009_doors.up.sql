-- Doors: a parametric door shape anchored by two geographic points
-- describing the opening (width + heading). Modeled on the `stairs` and
-- `lines` tables so it can reuse the shared shape handlers and the
-- `vertices` JSONB convention (`[[lng,lat],[lng,lat]]`).
CREATE TABLE doors (
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

CREATE INDEX doors_tenant_idx ON doors (tenant_id);
CREATE INDEX doors_zone_idx ON doors (zone_id);
