package aiworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// ErrTaskFailed is returned by Poll when the worker reports
// status="failed". Callers can distinguish "network / timeout" from
// "worker itself said no" using errors.Is.
var ErrTaskFailed = errors.New("aiworker: task failed")

// maxResponseBytes caps a runaway JSON response. Python's task
// results are typically 5-50 KB (a FeatureCollection with 30-100
// detections); 4 MB is an order-of-magnitude ceiling that still
// stops an OOM from a broken pipeline emitting infinite JSON.
const maxResponseBytes = 4 * 1024 * 1024

// Client is a thin HTTP client for the Python ai-worker service.
// One instance per API server; the http.Client's connection pool
// amortises across concurrent detection jobs.
type Client struct {
	HTTP            *http.Client
	BaseURL         string        // e.g. http://ai-worker:8100
	PollInterval    time.Duration // how often to hit GET /detect/{taskId} until terminal
	PollMaxDuration time.Duration // absolute budget across all poll iterations
}

// NewClient builds a Client with the configured timeouts. The
// per-request timeout is passed via RequestTimeout — same knob the
// polling worker uses. Zero values fall back to sensible defaults
// so a partial config still boots the service.
func NewClient(baseURL string, requestTimeout, pollInterval, pollMaxDuration time.Duration) *Client {
	if requestTimeout <= 0 {
		requestTimeout = 30 * time.Second
	}
	if pollInterval <= 0 {
		pollInterval = 3 * time.Second
	}
	if pollMaxDuration <= 0 {
		pollMaxDuration = 5 * time.Minute
	}
	return &Client{
		HTTP:            &http.Client{Timeout: requestTimeout},
		BaseURL:         baseURL,
		PollInterval:    pollInterval,
		PollMaxDuration: pollMaxDuration,
	}
}

// Enqueue posts a detection request to POST /detect and returns the
// worker's Dramatiq task id. Sync — returns as soon as the worker
// acknowledges (202), NOT when the task completes.
func (c *Client) Enqueue(ctx context.Context, req DetectRequest) (string, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("aiworker.Enqueue: marshal: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.BaseURL+"/detect", bytes.NewReader(body),
	)
	if err != nil {
		return "", fmt.Errorf("aiworker.Enqueue: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("aiworker.Enqueue: transport: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return "", fmt.Errorf("aiworker.Enqueue: read body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("aiworker.Enqueue: worker %d: %s", resp.StatusCode, string(raw))
	}
	var out EnqueueResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("aiworker.Enqueue: decode: %w (body=%s)", err, string(raw))
	}
	if out.TaskID == "" {
		return "", fmt.Errorf("aiworker.Enqueue: worker returned empty taskId (body=%s)", string(raw))
	}
	return out.TaskID, nil
}

// GetResult hits GET /detect/{taskId} exactly once. Prefer Poll for
// end-to-end job execution; GetResult is exposed so a Phase-4.5
// webhook implementation can look up a specific task on demand.
func (c *Client) GetResult(ctx context.Context, taskID string) (*TaskStatusResponse, error) {
	httpReq, err := http.NewRequestWithContext(
		ctx, http.MethodGet, c.BaseURL+"/detect/"+taskID, nil,
	)
	if err != nil {
		return nil, fmt.Errorf("aiworker.GetResult: build request: %w", err)
	}
	resp, err := c.HTTP.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("aiworker.GetResult: transport: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("aiworker.GetResult: read body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("aiworker.GetResult: worker %d: %s", resp.StatusCode, string(raw))
	}
	var out TaskStatusResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("aiworker.GetResult: decode: %w (body=%s)", err, string(raw))
	}
	return &out, nil
}

// Poll loops GET /detect/{taskId} every PollInterval until the task
// reaches a terminal state (done or failed) or the caller's ctx is
// canceled. Bounded by PollMaxDuration as a belt-and-suspenders
// against a runaway task the worker never marks failed.
//
// Returns:
//   - (result, nil) on status="done"
//   - (nil, ErrTaskFailed wrapped with worker error message) on "failed"
//   - (nil, ctx.Err()) on context cancel / deadline
//   - (nil, other error) on network / decode failure
func (c *Client) Poll(ctx context.Context, taskID string) (json.RawMessage, error) {
	deadline := time.Now().Add(c.PollMaxDuration)
	pollCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	ticker := time.NewTicker(c.PollInterval)
	defer ticker.Stop()

	// Fire once immediately so a fast task (typical for a small
	// image + Phase-3 SAM pipeline: ~5-20 s but sometimes <1 s
	// on cached model + cropped region) doesn't wait a full
	// PollInterval before we see the result.
	for attempt := 0; ; attempt++ {
		resp, err := c.GetResult(pollCtx, taskID)
		if err != nil {
			// Transient network errors: log + keep polling.
			// A hard 5xx from the worker itself would surface
			// on the next GetResult call as a proper error.
			slog.Warn("aiworker.Poll: transient GET failure, retrying", "task", taskID, "attempt", attempt, "error", err)
		} else {
			switch resp.Status {
			case StatusDone:
				return resp.Result, nil
			case StatusFailed:
				return nil, fmt.Errorf("%w: %s", ErrTaskFailed, resp.Error)
			case StatusPending:
				// keep polling
			default:
				slog.Warn("aiworker.Poll: unknown status, treating as pending", "task", taskID, "status", resp.Status)
			}
		}
		select {
		case <-pollCtx.Done():
			return nil, pollCtx.Err()
		case <-ticker.C:
			// next tick
		}
	}
}
