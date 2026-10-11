-- Routes: user-drawn navigation paths (walking / driving / emergency / etc)
-- rendered as a distinct polyline overlay from `lines` (which model walls
-- and aisles). Each row carries an ordered vertex list; each vertex is a
-- waypoint that later becomes a node in the pathfinding graph once
-- turn-by-turn navigation ships. Schema mirrors `lines` on purpose so the
-- same shape_crud helpers, SSE broadcast, and public-warehouse envelope
-- code paths pick this kind up for free.
--
-- `route_type` (walking / driving / emergency / forklift / accessible)
-- lives inside the `config` JSONB — no top-level column — so new types
-- can be added by the frontend without a migration. The overlay reads
-- config.type to pick the paint (colour + dash + arrow).
CREATE TABLE routes (
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

CREATE INDEX routes_tenant_idx ON routes (tenant_id);
CREATE INDEX routes_zone_idx ON routes (zone_id);
