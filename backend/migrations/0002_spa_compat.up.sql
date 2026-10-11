-- ---------------------------------------------------------------------------
-- SPA compatibility additions
-- ---------------------------------------------------------------------------

-- Image overlays can be tied to a floor-plan image like every other shape.
ALTER TABLE images ADD COLUMN floor_plan_id BIGINT;

-- Text labels support rotation (only meaningful when pitchAlignment is 'map').
ALTER TABLE text_labels ADD COLUMN rotation DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Correlation engine alert levels.
CREATE TYPE alert_level AS ENUM ('info', 'warn', 'critical');

-- v22+. Cross-stream correlation rules.
CREATE TABLE correlation_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  trigger JSONB NOT NULL,
  action JSONB NOT NULL,
  cooldown_ms BIGINT NOT NULL DEFAULT 5000,
  last_fired_at TIMESTAMPTZ,
  fire_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_correlation_rules_tenant ON correlation_rules(tenant_id);

-- v23+. Alerts emitted by the correlation engine.
CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id BIGINT REFERENCES correlation_rules(id) ON DELETE SET NULL,
  rule_name TEXT NOT NULL,
  level alert_level NOT NULL,
  message TEXT NOT NULL,
  entity_ref TEXT,
  ts TIMESTAMPTZ NOT NULL,
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX idx_alerts_tenant ON alerts(tenant_id);
CREATE INDEX idx_alerts_unacknowledged ON alerts(tenant_id, acknowledged) WHERE NOT acknowledged;

-- v21+. Audit log for outbound writes back to external systems.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stream_id BIGINT,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL,
  before JSONB NOT NULL,
  after JSONB NOT NULL,
  status TEXT NOT NULL,
  http_status INT,
  message TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_tenant ON audit_log(tenant_id);
CREATE INDEX idx_audit_log_stream ON audit_log(stream_id);
