-- 0036_ai_jobs.up.sql
-- Backs the "AI Map" tool: async detection jobs that ship a placed floor plan
-- image to a hosted vision-language model (Ollama Cloud) and return draft
-- aisles / areas / doors / stairs for the user to review + accept.
--
-- The job row is created synchronously on POST /floorplans/{id}/detect
-- (status='pending'), a goroutine flips it to 'running', and the final
-- 'done' / 'failed' state carries the parsed detections in the detections
-- column. SSE broadcasts AI_JOB_PROGRESS on each transition; the row itself
-- is the source of truth for polling clients.
--
-- accepted_ids / rejected_ids are populated by the frontend after the user
-- reviews. They feed accuracy telemetry — no live behaviour depends on them,
-- but keeping them lets us measure the model over time and decide when to
-- swap the primary/fallback pair without guessing.
--
-- model + prompt_version are frozen at request time so accuracy metrics stay
-- honest when we edit the prompt or the community model behind the primary
-- tag gets re-uploaded with different weights.

CREATE TABLE IF NOT EXISTS ai_jobs (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  image_id       BIGINT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  region_bbox    JSONB,                        -- {x0,y0,x1,y1} normalized [0,1] on the source image; NULL = whole image
  status         TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','canceled')),
  model          TEXT NOT NULL,                -- exact Ollama tag actually used (may be fallback)
  prompt_version TEXT NOT NULL,                -- e.g. "v1"; matches the constant in backend/internal/ai/prompt.go
  detections     JSONB,                        -- [{kind,geometry,label?,confidence}] — NULL until 'done'
  accepted_ids   JSONB,                        -- [detectionId, ...] — populated by feedback endpoint
  rejected_ids   JSONB,                        -- [detectionId, ...]
  error          TEXT,                         -- non-empty when status='failed'
  tokens_used    INT NOT NULL DEFAULT 0,
  duration_ms    INT,                          -- wall time from 'running' → terminal state
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cost cap query: SUM(tokens_used) WHERE tenant_id=$1 AND created_at > date_trunc('month', now())
-- Also drives the "your jobs" list in the review dialog when the user reopens
-- a session mid-flight.
CREATE INDEX IF NOT EXISTS ai_jobs_tenant_status_idx
  ON ai_jobs (tenant_id, status, created_at DESC);

-- Fast lookup for "does this image already have an in-flight job?" so the
-- toolbar can disable the button and re-attach to the existing SSE stream.
CREATE INDEX IF NOT EXISTS ai_jobs_image_idx
  ON ai_jobs (image_id, created_at DESC);
