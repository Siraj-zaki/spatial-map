-- ---------------------------------------------------------------------------
-- Shareable warehouse presentation links
--
-- A single `zones.share_token` (added in 0006) was enough for the first-cut
-- "here's a link, anyone with it can view" experience but it can't answer any
-- of the questions a real customer asks:
--
--   * "I want two links — one for the sales team, one for the customer."
--   * "This link should expire on Friday."
--   * "This link should only allow 500 views, then die."
--   * "This link should open with the floor picker locked to level 3."
--   * "This link should hide the RFID data layer but keep sensors."
--   * "Kill THIS link without breaking the other three."
--
-- `share_links` is the answer: one row per issued link, per warehouse. Every
-- row carries an unguessable token, an optional expiry, an optional view
-- cap, a view counter, and a JSONB `settings` blob the viewer applies on
-- open (map style, palette, theme mode, initial floor plan, per-kind layer
-- visibility, data-link config on/off + filter overrides, chrome flags,
-- watermark, etc.). The blob is intentionally schemaless so we can iterate
-- on presentation options without another migration each time — the
-- backend never interprets its contents; it just returns them alongside
-- the WarehouseView envelope for the SPA to apply.
--
-- Revocation is a soft-delete: `revoked_at` is stamped and the public
-- endpoint returns 404. The row is kept so the audit log has a record
-- of who issued and killed the link.
--
-- The legacy `zones.share_token` from 0006 is left intact — the old
-- `/share/:token` URLs keep resolving through the public warehouse
-- endpoint. New links flow through `/api/v1/share/:token` and read the
-- richer envelope with settings.
-- ---------------------------------------------------------------------------

CREATE TABLE share_links (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    zone_id        BIGINT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    token          TEXT NOT NULL,
    label          TEXT NOT NULL DEFAULT '',
    settings       JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at     TIMESTAMPTZ,
    max_views      BIGINT,
    view_count     BIGINT NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ,
    created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at     TIMESTAMPTZ,
    revoked_by     BIGINT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX share_links_token_uidx ON share_links (token);
CREATE INDEX share_links_zone_idx        ON share_links (zone_id, revoked_at);
CREATE INDEX share_links_tenant_idx      ON share_links (tenant_id);
CREATE INDEX share_links_expires_idx     ON share_links (expires_at)
    WHERE expires_at IS NOT NULL AND revoked_at IS NULL;
