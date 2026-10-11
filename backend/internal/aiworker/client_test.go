package aiworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// Uses httptest.Server so no real Python worker is needed to exercise
// the Enqueue → Poll → decode flow. Every scenario the handler cares
// about (fast success, slow success across multiple polls, failure,
// context cancel) is covered.

func newTestClient(baseURL string) *Client {
	// Very short poll interval so tests finish in ~milliseconds
	// rather than seconds.
	return NewClient(baseURL, 2*time.Second, 20*time.Millisecond, 5*time.Second)
}

func TestEnqueue_ReturnsTaskID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/detect" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = fmt.Fprintln(w, `{"taskId":"abc-123"}`)
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	taskID, err := c.Enqueue(context.Background(), DetectRequest{
		JobID: 42, ImageURL: "/files/x.jpg",
		Placement: Placement{StartLng: 0, StartLat: 0, CurrentLng: 1, CurrentLat: 1},
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if taskID != "abc-123" {
		t.Errorf("got taskId=%q want abc-123", taskID)
	}
}

func TestEnqueue_NonSuccessStatusIncludesBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = fmt.Fprintln(w, `{"detail":"missing field"}`)
	}))
	defer srv.Close()
	_, err := newTestClient(srv.URL).Enqueue(context.Background(), DetectRequest{})
	if err == nil || !contains(err.Error(), "worker 422") || !contains(err.Error(), "missing field") {
		t.Errorf("expected 422 error with body, got: %v", err)
	}
}

func TestPoll_ReturnsResultWhenTaskDone(t *testing.T) {
	// Simulate a worker that answers "pending" twice then "done".
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n < 3 {
			_, _ = fmt.Fprintln(w, `{"taskId":"t1","status":"pending"}`)
			return
		}
		_, _ = fmt.Fprintln(w, `{"taskId":"t1","status":"done","result":{"detections":[{"id":"d1","kind":"area"}],"pipeline_version":"phase3"}}`)
	}))
	defer srv.Close()

	result, err := newTestClient(srv.URL).Poll(context.Background(), "t1")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	// Result is raw JSON — a full decode + reshape happens in the
	// handler, so we just spot-check that the payload survived.
	var wrap struct {
		Detections      []map[string]any `json:"detections"`
		PipelineVersion string           `json:"pipeline_version"`
	}
	if err := json.Unmarshal(result, &wrap); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if wrap.PipelineVersion != "phase3" {
		t.Errorf("pipeline_version=%q want phase3", wrap.PipelineVersion)
	}
	if len(wrap.Detections) != 1 || wrap.Detections[0]["kind"] != "area" {
		t.Errorf("unexpected detections: %v", wrap.Detections)
	}
}

func TestPoll_ReturnsErrTaskFailed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintln(w, `{"taskId":"t2","status":"failed","error":"model checkpoint missing"}`)
	}))
	defer srv.Close()

	_, err := newTestClient(srv.URL).Poll(context.Background(), "t2")
	if !errors.Is(err, ErrTaskFailed) {
		t.Fatalf("expected ErrTaskFailed, got: %v", err)
	}
	if !contains(err.Error(), "model checkpoint missing") {
		t.Errorf("expected worker error message in wrapped err, got: %v", err)
	}
}

func TestPoll_ContextCancelStopsPolling(t *testing.T) {
	// Always answers pending — Poll should exit when ctx cancels.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintln(w, `{"taskId":"tX","status":"pending"}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	_, err := newTestClient(srv.URL).Poll(ctx, "tX")
	if err == nil {
		t.Fatal("expected error on ctx cancel")
	}
	// Either ctx.Err() itself or a wrap of it — accept both.
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Errorf("expected context error, got: %v", err)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || indexOf(haystack, needle) >= 0)
}

// Tiny substring search to avoid importing strings in a test file
// that otherwise wouldn't need it.
func indexOf(s, sub string) int {
	if sub == "" {
		return 0
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
