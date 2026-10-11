package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/aiworker"
	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// modelTag is what we stamp into ai_jobs.model at creation time. The
// Python worker owns the real pipeline version; it also embeds
// `pipeline_version` inside the detections payload so the SPA can
// display exactly which build produced each result.
const modelTag = "python-cv"

// tenantFeatureFlagKey is the app_settings key format for the per-tenant
// AI opt-in. Kept in one place so a rename can't drift between the write
// path (admin UI, future) and the read check here.
func tenantFeatureFlagKey(tenantID int64) string {
	return "ai_floorplan_enabled:tenant:" + strconv.FormatInt(tenantID, 10)
}

// AIFloorPlansConfig bundles what the router constructor needs from the
// broader config so main.go doesn't have to reach for individual fields.
type AIFloorPlansConfig struct {
	// Worker is the HTTP client for the Python ai-worker service. Nil
	// means the feature is disabled server-wide (the endpoint 503s).
	Worker              *aiworker.Client
	MonthlyCapPerTenant int
	// HourlyRatePerTenant / HourlyBurstPerTenant configure a per-tenant
	// KeyedLimiter that fires 429 before we even touch the DB. Rate is
	// jobs per HOUR (the router converts to per-second). 0 disables.
	HourlyRatePerTenant  int
	HourlyBurstPerTenant int
}

// startDetectRequest is the POST /floorplans/{imageId}/detect body.
// Region is optional; when nil the whole image is sent to the worker.
type startDetectRequest struct {
	Region *aiworker.Region `json:"region,omitempty"`
}

// startDetectResponse just hands back the job id — the client subscribes
// to SSE (entity="ai-jobs", id=jobID) and polls GET /jobs/{id} for the
// full state on every event.
type startDetectResponse struct {
	JobID int64 `json:"jobId"`
}

// aiJobResponse is the flattened view of an ai_jobs row shipped back to
// the client. detections stays as a raw JSON blob so the frontend can
// decode it against its own typed schema without a Go round-trip.
type aiJobResponse struct {
	ID          int64           `json:"id"`
	ImageID     int64           `json:"imageId"`
	Status      string          `json:"status"`
	Model       string          `json:"model"`
	PromptVer   string          `json:"promptVersion"`
	Region      json.RawMessage `json:"region,omitempty"`
	Detections  json.RawMessage `json:"detections,omitempty"`
	AcceptedIDs json.RawMessage `json:"acceptedIds,omitempty"`
	RejectedIDs json.RawMessage `json:"rejectedIds,omitempty"`
	Error       string          `json:"error,omitempty"`
	TokensUsed  int             `json:"tokensUsed"`
	DurationMs  int             `json:"durationMs"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func toAIJobResponse(row db.GetAIJobRow) aiJobResponse {
	resp := aiJobResponse{
		ID:          row.ID,
		ImageID:     row.ImageID,
		Status:      row.Status,
		Model:       row.Model,
		PromptVer:   row.PromptVersion,
		Region:      json.RawMessage(row.RegionBbox),
		Detections:  json.RawMessage(row.Detections),
		AcceptedIDs: json.RawMessage(row.AcceptedIds),
		RejectedIDs: json.RawMessage(row.RejectedIds),
		TokensUsed:  int(row.TokensUsed),
		CreatedAt:   api.FormatTime(row.CreatedAt),
		UpdatedAt:   api.FormatTime(row.UpdatedAt),
	}
	if row.Error.Valid {
		resp.Error = row.Error.String
	}
	if row.DurationMs.Valid {
		resp.DurationMs = int(row.DurationMs.Int32)
	}
	return resp
}

// feedbackRequest carries the accepted/rejected detection ids after the
// user has reviewed. Purely for accuracy telemetry — no live behaviour
// depends on it; the accepted detections have already been turned into
// real shapes via the normal spatial store path.
type feedbackRequest struct {
	AcceptedIDs []string `json:"acceptedIds"`
	RejectedIDs []string `json:"rejectedIds"`
}

// AIFloorPlansRouter wires the AI Map endpoints under /floorplans.
//
//	POST /floorplans/{imageId}/detect       — start a detection job
//	GET  /floorplans/jobs/{jobId}           — poll a job's current state
//	POST /floorplans/jobs/{jobId}/cancel    — request cancel (best-effort)
//	POST /floorplans/jobs/{jobId}/feedback  — record accepted/rejected ids
//
// The router is intentionally lightweight: heavy lifting (worker enqueue,
// poll, DB completion) lives in a goroutine spawned by StartDetection.
// That goroutine uses context.Background() with an explicit timeout
// because the HTTP request context is canceled as soon as the client
// gets the jobId — but the worker is still running.
func AIFloorPlansRouter(q *db.Queries, objectStore store.ObjectStore, cfg AIFloorPlansConfig) chi.Router {
	r := chi.NewRouter()

	// Per-tenant burst throttle. Idle entries expire after 4h so a
	// tenant returning after a break gets a fresh burst budget rather
	// than the stale one that would linger without a reap. When the
	// rate is 0 the limiter is skipped entirely — the monthly cap
	// still applies.
	var limiter *api.KeyedLimiter
	if cfg.HourlyRatePerTenant > 0 {
		burst := cfg.HourlyBurstPerTenant
		if burst <= 0 {
			burst = 1
		}
		limiter = api.NewKeyedLimiter(float64(cfg.HourlyRatePerTenant)/3600.0, burst, 4*time.Hour)
	}

	r.Post("/{imageId}/detect", startDetection(q, cfg, limiter))
	r.Get("/jobs/{jobId}", getJob(q))
	r.Post("/jobs/{jobId}/cancel", cancelJob(q))
	r.Post("/jobs/{jobId}/feedback", recordFeedback(q))

	// objectStore is accepted for signature-parity with the previous
	// router constructor (and future features that may want to peek at
	// image bytes for validation). Silence the unused-parameter lint.
	_ = objectStore

	return r
}

// startDetection is the hot path. It does all the synchronous safety
// checks (feature flag, cap, image ownership) up front so the caller
// gets a clean 4xx before we ever spawn work, then hands off to a
// goroutine and returns 202 with the job id.
func startDetection(q *db.Queries, cfg AIFloorPlansConfig, limiter *api.KeyedLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.Error(w, http.StatusUnauthorized, "missing tenant")
			return
		}
		if cfg.Worker == nil || cfg.Worker.BaseURL == "" {
			// Feature is compiled in but no ai-worker URL was
			// configured. Treat the same as a global kill switch so
			// operators can flip it off in one place.
			api.Error(w, http.StatusServiceUnavailable, "ai floor plan detection is not configured on this server")
			return
		}
		// Per-tenant hourly throttle. Cheap to check, and fires before
		// we touch the DB — a burst of 429s is dramatically preferable
		// to a burst of PENDING rows that never resolve because the
		// tenant hit their monthly cap on the follow-up query.
		if limiter != nil && !limiter.Allow("tenant:"+strconv.FormatInt(tenantID, 10)) {
			api.Error(w, http.StatusTooManyRequests, "hourly ai detection rate exceeded — try again shortly")
			return
		}

		// Per-tenant opt-in flag. Missing row is treated as "false" —
		// the feature is opt-in, not opt-out (privacy default).
		flagOn, err := readTenantAIFlag(r.Context(), q, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if !flagOn {
			api.Error(w, http.StatusForbidden, "ai floor plan detection is not enabled for this tenant")
			return
		}

		// Monthly cap. Uses job COUNT (not token sum) as the cap unit
		// because token cost is unknown until the worker replies, and
		// we need the pre-request check to be deterministic. Adjust
		// the cap in config if the cost model changes.
		monthCount, err := q.CountAIJobsThisMonth(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if cfg.MonthlyCapPerTenant > 0 && monthCount >= int64(cfg.MonthlyCapPerTenant) {
			api.Error(w, http.StatusTooManyRequests, "monthly ai detection cap reached")
			return
		}

		imageID, err := api.IDParam(r, "imageId")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		img, err := q.GetImage(r.Context(), db.GetImageParams{ID: imageID, TenantID: tenantID})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "image not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}

		var body startDetectRequest
		if r.ContentLength > 0 {
			if err := api.DecodeBody(r, &body); err != nil {
				api.BadRequest(w, err.Error())
				return
			}
		}
		var regionBytes []byte
		if body.Region != nil {
			b, err := json.Marshal(body.Region)
			if err == nil {
				regionBytes = b
			}
		}

		job, err := q.CreateAIJob(r.Context(), db.CreateAIJobParams{
			TenantID:      tenantID,
			ImageID:       imageID,
			RegionBbox:    regionBytes,
			Model:         modelTag,
			PromptVersion: "",
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		// Fire the initial SSE so a subscriber that was already listening
		// for this image sees the pending row appear immediately.
		BroadcastEntityEvent("AI_JOB_UPDATED", "ai-jobs", job.ID, tenantID)

		// Fan out to background. Detached context on purpose — the HTTP
		// request is done as soon as we write the response.
		go runDetectionJob(q, cfg, job, img)

		api.JSON(w, http.StatusAccepted, startDetectResponse{JobID: job.ID})
	}
}

// runDetectionJob is the async body of a detection. Marked as its own
// function (not an inline goroutine) so failures at any stage can flow
// through a single defer that ensures the job row lands in a terminal
// state — a job stuck at 'running' forever would be worse than a job
// that failed cleanly.
func runDetectionJob(q *db.Queries, cfg AIFloorPlansConfig, job db.CreateAIJobRow, img db.Image) {
	// Wall-clock timeout independent of any request context. Adds a
	// small margin over the worker's poll ceiling so the final DB
	// writes always have room to complete even when the pipeline runs
	// long.
	ctx, cancel := context.WithTimeout(context.Background(), cfg.Worker.PollMaxDuration+15*time.Second)
	defer cancel()

	started := time.Now()
	// Guarantees a terminal state + SSE, even if we panic below.
	failed := true
	defer func() {
		if !failed {
			return
		}
		_ = q.FailAIJob(ctx, db.FailAIJobParams{
			ID:         job.ID,
			Error:      pgtype.Text{String: "internal error (panic?)", Valid: true},
			DurationMs: pgtype.Int4{Int32: int32(time.Since(started).Milliseconds()), Valid: true},
		})
		BroadcastEntityEvent("AI_JOB_UPDATED", "ai-jobs", job.ID, job.TenantID)
	}()

	if err := q.MarkAIJobRunning(ctx, job.ID); err != nil {
		slog.Error("ai runDetectionJob: mark running failed", "job", job.ID, "error", err)
		return
	}
	BroadcastEntityEvent("AI_JOB_UPDATED", "ai-jobs", job.ID, job.TenantID)

	// Build the worker request. The Python worker fetches the image
	// bytes from MinIO itself using the /files/<key> URL, so the Go
	// handler never loads pixels — a big win for API memory footprint
	// on multi-MB blueprints.
	placement, err := placementFromImage(img)
	if err != nil {
		completeFail(ctx, q, job.ID, started, "build placement: "+err.Error())
		failed = false
		BroadcastEntityEvent("AI_JOB_UPDATED", "ai-jobs", job.ID, job.TenantID)
		return
	}

	req := aiworker.DetectRequest{
		JobID:     job.ID,
		ImageURL:  img.ImageUrl,
		Placement: placement,
	}
	if len(job.RegionBbox) > 0 {
		var region aiworker.Region
		if err := json.Unmarshal(job.RegionBbox, &region); err == nil {
			req.Region = &region
		}
	}

	taskID, err := cfg.Worker.Enqueue(ctx, req)
	if err != nil {
		completeFail(ctx, q, job.ID, started, "enqueue: "+err.Error())
		failed = false
		BroadcastEntityEvent("AI_JOB_UPDATED", "ai-jobs", job.ID, job.TenantID)
		return
	}
	if err := q.SetAIJobWorkerTaskID(ctx, db.SetAIJobWorkerTaskIDParams{
		ID:           job.ID,
		WorkerTaskID: taskID,
	}); err != nil {
		// Non-fatal: we already have the taskID in memory. Log so an
		// operator can correlate a lost worker log to a Go job row.
		slog.Warn("ai runDetectionJob: persist worker task id failed",
			"job", job.ID, "task", taskID, "error", err)
	}

	rawResult, err := cfg.Worker.Poll(ctx, taskID)
	if err != nil {
		if errors.Is(err, aiworker.ErrTaskFailed) {
			completeFail(ctx, q, job.ID, started, err.Error())
		} else {
			completeFail(ctx, q, job.ID, started, "poll: "+err.Error())
		}
		failed = false
		BroadcastEntityEvent("AI_JOB_UPDATED", "ai-jobs", job.ID, job.TenantID)
		return
	}

	// The worker returns {detections: [...], pipeline_version: "..."}.
	// The SPA expects just the detections array wrapped in the ai_jobs
	// row's detections column, so we unwrap here and drop pipeline_version
	// on the floor (it stays inside the raw payload logged below for
	// support triage but doesn't need its own column).
	var wrap struct {
		Detections      json.RawMessage `json:"detections"`
		PipelineVersion string          `json:"pipeline_version"`
	}
	if err := json.Unmarshal(rawResult, &wrap); err != nil {
		completeFail(ctx, q, job.ID, started, "decode worker result: "+err.Error())
		failed = false
		BroadcastEntityEvent("AI_JOB_UPDATED", "ai-jobs", job.ID, job.TenantID)
		return
	}
	detectionsJSON := []byte(wrap.Detections)
	if len(detectionsJSON) == 0 {
		detectionsJSON = []byte("[]")
	}

	if err := q.CompleteAIJob(ctx, db.CompleteAIJobParams{
		ID:         job.ID,
		Detections: detectionsJSON,
		// tokens_used stays 0 for the CV pipeline — no LLM tokens
		// are consumed. Kept in the schema for the future case where
		// an OCR add-on charges per page.
		TokensUsed: 0,
		DurationMs: pgtype.Int4{Int32: int32(time.Since(started).Milliseconds()), Valid: true},
	}); err != nil {
		slog.Error("ai runDetectionJob: complete failed", "job", job.ID, "error", err)
		return
	}
	failed = false
	BroadcastEntityEvent("AI_JOB_UPDATED", "ai-jobs", job.ID, job.TenantID)
	slog.Info("ai runDetectionJob: done",
		"job", job.ID, "tenant", job.TenantID,
		"task", taskID, "pipeline_version", wrap.PipelineVersion,
		"duration_ms", time.Since(started).Milliseconds())
}

func completeFail(ctx context.Context, q *db.Queries, jobID int64, started time.Time, msg string) {
	_ = q.FailAIJob(ctx, db.FailAIJobParams{
		ID:         jobID,
		Error:      pgtype.Text{String: msg, Valid: true},
		DurationMs: pgtype.Int4{Int32: int32(time.Since(started).Milliseconds()), Valid: true},
	})
}

// placementFromImage translates a persisted images row into the
// Placement struct the Python worker needs for pixel→lng/lat
// reprojection. Crop lives in the JSONB config blob; a missing crop
// leaves the field nil which the Python side treats as "no crop".
func placementFromImage(img db.Image) (aiworker.Placement, error) {
	placement := aiworker.Placement{
		StartLng:   img.StartLng,
		StartLat:   img.StartLat,
		CurrentLng: img.CurrentLng,
		CurrentLat: img.CurrentLat,
		Rotation:   img.Rotation,
	}
	if len(img.Config) > 0 {
		var cfg struct {
			Crop *struct {
				Top    float64 `json:"top"`
				Right  float64 `json:"right"`
				Bottom float64 `json:"bottom"`
				Left   float64 `json:"left"`
			} `json:"crop"`
		}
		if err := json.Unmarshal(img.Config, &cfg); err == nil && cfg.Crop != nil {
			// Only forward a non-trivial crop; the zero rectangle is
			// the same as "no crop" and would just add JSON noise.
			c := *cfg.Crop
			if c.Top > 0 || c.Right > 0 || c.Bottom > 0 || c.Left > 0 {
				placement.Crop = map[string]float64{
					"top":    c.Top,
					"right":  c.Right,
					"bottom": c.Bottom,
					"left":   c.Left,
				}
			}
		}
	}
	return placement, nil
}

func getJob(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		jobID, err := api.IDParam(r, "jobId")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := q.GetAIJob(r.Context(), db.GetAIJobParams{ID: jobID, TenantID: tenantID})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "job not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, toAIJobResponse(row))
	}
}

func cancelJob(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		jobID, err := api.IDParam(r, "jobId")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := q.CancelAIJob(r.Context(), db.CancelAIJobParams{ID: jobID, TenantID: tenantID}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("AI_JOB_UPDATED", "ai-jobs", jobID, tenantID)
		api.JSON(w, http.StatusOK, map[string]bool{"canceled": true})
	}
}

func recordFeedback(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		jobID, err := api.IDParam(r, "jobId")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		var body feedbackRequest
		if err := api.DecodeBody(r, &body); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		acc, _ := json.Marshal(body.AcceptedIDs)
		rej, _ := json.Marshal(body.RejectedIDs)
		if err := q.RecordAIJobFeedback(r.Context(), db.RecordAIJobFeedbackParams{
			ID:          jobID,
			TenantID:    tenantID,
			AcceptedIds: acc,
			RejectedIds: rej,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, map[string]bool{"recorded": true})
	}
}

// readTenantAIFlag returns true when the per-tenant app_settings toggle
// is present AND set to a truthy value ("true" as a JSON string, or the
// JSON literal `true`). Anything else — including a missing row — is
// treated as opt-out. Errors other than ErrNoRows propagate; a missing
// row is not an error.
func readTenantAIFlag(ctx context.Context, q *db.Queries, tenantID int64) (bool, error) {
	row, err := q.GetAppSetting(ctx, tenantFeatureFlagKey(tenantID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	v := strings.Trim(strings.TrimSpace(string(row.Value)), `"`)
	return strings.EqualFold(v, "true"), nil
}
