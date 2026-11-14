-- Alert rules and alerts (server-side, over table rows).
--
-- An alert rule watches one data source (a table, or any source with rows in
-- data_source_rows) of one facility. Its `condition` is the data-link filter
-- tree the /data-sources/{id}/query endpoint already compiles
-- ({kind:'group', combine, conditions}); an empty group matches every row.
-- Four kinds:
--   condition — a row matches                       → one alert per row
--   duration  — a row has matched for duration_sec  → one alert per row
--   stale     — a matching row's time (stale_field, else the row's ts) is
--               older than duration_sec             → one alert per row
--   count     — the number of matching rows compared (comparison) with
--               threshold                           → one alert for the rule
-- The engine (internal/handlers/alert_engine.go) evaluates every enabled rule
-- every 15 s: it opens an alert when an item starts breaching, resolves it
-- when it stops, and won't reopen the same item within cooldown_sec of the
-- last resolve. Recipients pick who is notified (bell + toast); every member
-- can see every alert on the Alerts page.
--
-- The legacy correlation_rules / alerts tables (0002, browser-side engine over
-- the old streams) are untouched.

CREATE TABLE alert_rules (
    id                 BIGSERIAL PRIMARY KEY,
    tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    zone_id            BIGINT REFERENCES zones(id) ON DELETE CASCADE,
    source_id          BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    kind               TEXT NOT NULL CHECK (kind IN ('condition', 'duration', 'stale', 'count')),
    condition          JSONB NOT NULL DEFAULT '{}'::jsonb,
    duration_sec       INTEGER NOT NULL DEFAULT 0,
    stale_field        TEXT NOT NULL DEFAULT '',
    comparison         TEXT NOT NULL DEFAULT 'gt' CHECK (comparison IN ('gt', 'gte', 'lt', 'lte', 'eq')),
    threshold          INTEGER NOT NULL DEFAULT 0,
    severity           TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
    message            TEXT NOT NULL DEFAULT '',
    label_field        TEXT NOT NULL DEFAULT '',
    recipient_roles    TEXT[] NOT NULL DEFAULT '{}',
    recipient_user_ids BIGINT[] NOT NULL DEFAULT '{}',
    cooldown_sec       INTEGER NOT NULL DEFAULT 300,
    enabled            BOOLEAN NOT NULL DEFAULT true,
    created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_evaluated_at  TIMESTAMPTZ,
    last_error         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX alert_rules_tenant_idx ON alert_rules (tenant_id, zone_id);
CREATE INDEX alert_rules_enabled_idx ON alert_rules (enabled) WHERE enabled;

CREATE TABLE alert_events (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    rule_id         BIGINT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    zone_id         BIGINT REFERENCES zones(id) ON DELETE CASCADE,
    source_id       BIGINT,
    -- '' for a count rule (one alert for the whole rule).
    entity_key      TEXT NOT NULL DEFAULT '',
    item_label      TEXT NOT NULL DEFAULT '',
    severity        TEXT NOT NULL,
    message         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    -- The row's payload when the alert opened (count rules: {count}).
    snapshot        JSONB NOT NULL DEFAULT '{}'::jsonb,
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    -- NULL with resolved_at set = resolved by the engine (no longer breaching).
    resolved_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    note            TEXT NOT NULL DEFAULT ''
);
-- One active alert per rule and item.
CREATE UNIQUE INDEX alert_events_active_uidx ON alert_events (rule_id, entity_key) WHERE status <> 'resolved';
CREATE INDEX alert_events_tenant_idx ON alert_events (tenant_id, status, opened_at DESC);

-- Since when each item has matched a duration rule (cleared when it stops).
CREATE TABLE alert_rule_state (
    rule_id        BIGINT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    entity_key     TEXT NOT NULL,
    matching_since TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (rule_id, entity_key)
);

-- When each member last opened the bell (unread = alerts for them opened since).
CREATE TABLE alert_seen (
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);
