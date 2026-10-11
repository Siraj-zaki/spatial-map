// Package aiworker is a thin HTTP client for the Python detection
// service that lives at backend/ai-worker/. Introduced in Phase 4 of
// the AI Map rewrite to replace the in-process Ollama-Cloud call
// path (backend/internal/ai/, now deleted).
//
// Wire protocol mirrors the Python FastAPI schemas in
// backend/ai-worker/src/aiworker/main.py:
//
//	POST /detect            -> 202 { taskId }
//	GET  /detect/{taskId}   -> 200 { taskId, status, result?, error? }
//	                           status ∈ {"pending","done","failed"}
//
// The result payload is passed through verbatim as `json.RawMessage`
// so any change to the Python-side detection shape (Phase 5 upgrades,
// added properties, etc.) requires zero Go changes.
package aiworker

import (
	"encoding/json"
)

// Placement mirrors ai_floorplan.go's frameFromImage output shape
// AND Python's Placement pydantic model. Field names are camelCase
// to match the JSON wire — Go's json tags handle the case flip.
type Placement struct {
	StartLng   float64 `json:"startLng"`
	StartLat   float64 `json:"startLat"`
	CurrentLng float64 `json:"currentLng"`
	CurrentLat float64 `json:"currentLat"`
	Rotation   float64 `json:"rotation"`
	// Crop is the placed image's persisted crop percentages
	// (0..100 per edge). Absent when the source images row has no
	// non-trivial crop.
	Crop map[string]float64 `json:"crop,omitempty"`
}

// Region is the optional user-drawn detection region — normalized
// UV [0,1] on the source image, y-down. Matches the JSON body the
// SPA already sends to /api/v1/floorplans/{id}/detect.
type Region struct {
	X0 float64 `json:"x0"`
	Y0 float64 `json:"y0"`
	X1 float64 `json:"x1"`
	Y1 float64 `json:"y1"`
}

// DetectRequest is the body of POST /detect on the ai-worker.
type DetectRequest struct {
	JobID     int64     `json:"jobId"`
	ImageURL  string    `json:"imageUrl"` // /files/<key>
	Placement Placement `json:"placement"`
	Region    *Region   `json:"region,omitempty"`
}

// EnqueueResponse is the 202 body of POST /detect.
type EnqueueResponse struct {
	TaskID string `json:"taskId"`
}

// TaskStatus enumerates the FastAPI worker's task lifecycle states.
// "pending" = not yet run; "done" = result available; "failed" =
// worker raised. The API also emits "running" inside its own
// Dramatiq machinery but that's not distinguishable from "pending"
// via the /detect/{taskId} endpoint.
type TaskStatus string

const (
	StatusPending TaskStatus = "pending"
	StatusDone    TaskStatus = "done"
	StatusFailed  TaskStatus = "failed"
)

// TaskStatusResponse is the 200 body of GET /detect/{taskId}.
// `Result` carries whatever the Python pipeline emits — currently:
//
//	{"detections": [ AIDetection, … ], "pipeline_version": "…"}
//
// We keep it as json.RawMessage so any Python-side change to the
// detection shape (Phase 5 upgrades, new properties, etc.) is a
// zero-Go-change deploy.
type TaskStatusResponse struct {
	TaskID string          `json:"taskId"`
	Status TaskStatus      `json:"status"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}
