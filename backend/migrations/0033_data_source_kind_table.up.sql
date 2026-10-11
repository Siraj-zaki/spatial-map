-- User-defined "thing type" tables — the third ingestion mode alongside
-- file upload and REST polling. The user creates a thing type (camera,
-- asset, location, shipping, asn, soh, ...) by defining its fields + data
-- types in the UI, then pushes rows into it via per-table REST CRUD
-- endpoints authenticated by a scoped API token.
--
-- Architectural decision: do NOT create real dynamic Postgres tables per
-- user input (would break sqlc's compile-time codegen and risk unbounded
-- DDL on a shared database). Instead reuse the JSONB-row pattern — rows
-- live in `data_source_rows` (already a generic pool keyed by
-- (source_id, entity_key)) with `kind='table'`, and history lives in a
-- new `data_source_row_events` append-only table mirroring the existing
-- `entity_states` / `entity_events` split for streams.
--
-- Three new sidecar tables:
--   1. table_field_definitions — the field schema per thing type
--   2. data_source_row_events  — append-only history (the time-travel source)
--   3. table_api_tokens        — scoped per-table API tokens (SHA-256 hashed)
--
-- The `data_sources.kind = 'table'` row carries name / entity_kind /
-- config; the sidecars carry the per-table-specific bits the generic
-- `data_sources` schema can't express.

-- ---- enum extension ------------------------------------------------------

ALTER TYPE data_source_kind ADD VALUE 'table';

-- ---- field definitions ---------------------------------------------------
-- Per-thing-type field schema. Stored separately from `attribute_definitions`
-- because the latter is keyed by (scope, key) for the rack-cell/bin
-- attribute catalog and doesn't carry `is_required` / `is_unique` /
-- `sort_order`. A thing type's fields are scoped to one source_id and
-- don't collide across thing types — a "camera" and an "asset" both having
-- a "status" field is fine.

CREATE TABLE table_field_definitions (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id    BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  field_key    TEXT   NOT NULL,
  field_label  TEXT   NOT NULL,
  data_type    TEXT   NOT NULL,
  is_required  BOOLEAN NOT NULL DEFAULT FALSE,
  is_unique    BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order   INT    NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, field_key)
);

CREATE INDEX idx_tfd_tenant_source ON table_field_definitions (tenant_id, source_id);

-- ---- row events (history) ------------------------------------------------
-- Append-only event log for `data_source_rows`. Mirrors `entity_events`
-- shape and indexes — the existing streaming path proves the pattern.
-- `payload` is the full row snapshot at each event (not a diff), matching
-- entity_events semantics; diff-based history would complicate the
-- time-travel read path without buying enough to justify it.
--
-- `auth_token_id` is a soft FK to table_api_tokens. We deliberately do
-- NOT CASCADE — when a token is revoked we want the audit trail to
-- survive (source_ip + ts still anchor it; the dangling id is benign).
--
-- Retention: a future `TrimDataSourceRowEventsBefore` query (mirroring
-- `TrimEntityEventsBefore`) can be wired into a periodic job; left out
-- of v1.

CREATE TABLE data_source_row_events (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id     BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  entity_key    TEXT   NOT NULL,
  payload       JSONB  NOT NULL,
  operation     TEXT   NOT NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_ip     TEXT,
  auth_token_id BIGINT
);

CREATE INDEX idx_dsre_source_ts     ON data_source_row_events (source_id, ts DESC);
CREATE INDEX idx_dsre_source_key_ts ON data_source_row_events (tenant_id, source_id, entity_key, ts DESC);

-- ---- per-table API tokens ------------------------------------------------
-- Scoped write tokens for the public CRUD surface. The plaintext token
-- is returned ONCE on creation (POST /tables or POST /tables/{id}/tokens)
-- and never stored; we keep only the SHA-256 hash. This is a deliberate
-- security upgrade over the existing `share_links.token` (plaintext,
-- read-only) pattern, because these tokens grant WRITE access.
--
-- Revocation is non-destructive: set `revoked_at = now()` instead of
-- deleting the row so the audit trail (`last_used_at`, the row-events
-- referencing `auth_token_id`) stays interpretable.

CREATE TABLE table_api_tokens (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id    BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  token_hash   TEXT   NOT NULL,
  label        TEXT   NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX table_api_tokens_token_hash_uidx ON table_api_tokens (token_hash);
CREATE INDEX table_api_tokens_source_idx ON table_api_tokens (source_id, revoked_at);