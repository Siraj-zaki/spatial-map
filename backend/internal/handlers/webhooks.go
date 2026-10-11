package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// maxWebhookPayloadBytes caps the body size an external sender may POST.
const maxWebhookPayloadBytes = 1 << 20 // 1 MiB

// WebhookEventsRouter mounts public-ish ingest + drain endpoints under
// /api/v1/webhooks. Both routes resolve tenant scoping from the stream token
// because external publishers cannot send X-Tenant-Id.
func WebhookEventsRouter(q *db.Queries, apiKey string) chi.Router {
	r := chi.NewRouter()
	r.Post("/{token}", ingestWebhookEvent(q, apiKey))
	r.Get("/{token}", getWebhookStream(q, apiKey))
	r.Get("/{token}/drain", drainWebhookEvents(q, apiKey))
	return r
}

type webhookIngestResponse struct {
	Received int `json:"received"`
}

// ingestWebhookEvent accepts a single JSON object or a JSON array of objects
// and stores each object as a queued webhook event for the stream token.
func ingestWebhookEvent(q *db.Queries, apiKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := validateWebhookAPIKey(r, apiKey); err != nil {
			api.Error(w, http.StatusUnauthorized, err.Error())
			return
		}

		token := chi.URLParam(r, "token")
		if token == "" {
			api.BadRequest(w, "missing webhook token")
			return
		}

		stream, err := q.GetStreamByToken(r.Context(), token)
		if err != nil {
			api.NotFound(w, "stream not found")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxWebhookPayloadBytes)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			api.BadRequest(w, "request body too large")
			return
		}

		// Verify against the exact bytes received, before any parsing.
		if err := checkWebhookSignature(webhookSigningFor(stream.Endpoint), r.Header.Get(webhookSignatureHeader), body, time.Now()); err != nil {
			api.Error(w, http.StatusUnauthorized, err.Error())
			return
		}

		var payloads []json.RawMessage
		if len(body) > 0 && body[0] == '[' {
			if err := json.Unmarshal(body, &payloads); err != nil {
				api.BadRequest(w, "body must be a JSON object or array of objects")
				return
			}
		} else {
			payloads = []json.RawMessage{body}
		}

		received := 0
		for _, raw := range payloads {
			// Skip completely empty/whitespace payloads.
			if len(raw) == 0 {
				continue
			}
			if _, err := q.InsertWebhookEvent(r.Context(), db.InsertWebhookEventParams{
				TenantID: stream.TenantID,
				StreamID: stream.ID,
				Token:    token,
				Payload:  raw,
			}); err != nil {
				slog.Warn("failed to insert webhook event", "token", token, "error", err)
				api.InternalError(w, r, err)
				return
			}
			received++
		}

		api.JSON(w, http.StatusAccepted, webhookIngestResponse{Received: received})
	}
}

type webhookEventResponse struct {
	ID         int64           `json:"id"`
	Payload    json.RawMessage `json:"payload"`
	ReceivedAt int64           `json:"receivedAt"`
}

type webhookDrainResponse struct {
	Events         []webhookEventResponse `json:"events"`
	Remaining      int64                  `json:"remaining"`
	LastReceivedAt *int64                 `json:"lastReceivedAt,omitempty"`
	Error          string                 `json:"error,omitempty"`
}

// drainWebhookEvents atomically dequeues up to `max` undrained events for the
// stream token and returns them in insertion order. The SPA hands the payloads
// to the existing JSON import pipeline.
func drainWebhookEvents(q *db.Queries, apiKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := validateWebhookAPIKey(r, apiKey); err != nil {
			api.Error(w, http.StatusUnauthorized, err.Error())
			return
		}

		token := chi.URLParam(r, "token")
		if token == "" {
			api.BadRequest(w, "missing webhook token")
			return
		}

		stream, err := q.GetStreamByToken(r.Context(), token)
		if err != nil {
			api.NotFound(w, "stream not found")
			return
		}

		max := int32(500)
		if m, err := strconv.Atoi(r.URL.Query().Get("max")); err == nil && m > 0 && m <= 5000 {
			max = int32(m)
		}

		rows, err := q.DrainWebhookEvents(r.Context(), db.DrainWebhookEventsParams{
			TenantID: stream.TenantID,
			StreamID: stream.ID,
			Limit:    max,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		events := make([]webhookEventResponse, 0, len(rows))
		var lastReceivedAt *int64
		for _, row := range rows {
			ts := int64(row.ReceivedAtMs)
			events = append(events, webhookEventResponse{
				ID:         row.ID,
				Payload:    row.Payload,
				ReceivedAt: ts,
			})
			if lastReceivedAt == nil || ts > *lastReceivedAt {
				lastReceivedAt = &ts
			}
		}

		remaining := int64(0)
		if len(events) > 0 {
			count, err := q.CountUndrainedWebhookEvents(r.Context(), db.CountUndrainedWebhookEventsParams{
				TenantID: stream.TenantID,
				StreamID: stream.ID,
			})
			if err == nil {
				remaining = count
			}
		}

		resp := webhookDrainResponse{
			Events:         events,
			Remaining:      remaining,
			LastReceivedAt: lastReceivedAt,
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

// getWebhookStream returns a lightweight health/info response so the SPA's
// "register" step can verify the token exists before saving the source.
func getWebhookStream(q *db.Queries, apiKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := validateWebhookAPIKey(r, apiKey); err != nil {
			api.Error(w, http.StatusUnauthorized, err.Error())
			return
		}

		token := chi.URLParam(r, "token")
		if token == "" {
			api.BadRequest(w, "missing webhook token")
			return
		}

		stream, err := q.GetStreamByToken(r.Context(), token)
		if err != nil {
			api.NotFound(w, "stream not found")
			return
		}

		api.JSON(w, http.StatusOK, map[string]any{
			"token":      token,
			"streamId":   stream.ID,
			"tenantId":   stream.TenantID,
			"entityType": stream.EntityType,
			"name":       stream.Name,
		})
	}
}

// validateWebhookAPIKey checks the shared server key. Publishers cannot
// always set custom headers on a plain HTTP POST or a WebSocket handshake,
// so api.RequestAPIKey also accepts the apiKey query parameter.
func validateWebhookAPIKey(r *http.Request, apiKey string) error {
	if apiKey == "" {
		return nil
	}
	if !api.APIKeyMatches(api.RequestAPIKey(r), apiKey) {
		return fmt.Errorf("unauthorized")
	}
	return nil
}

// webhookTimestamp converts a pgtype.Timestamptz to unix-ms for response bodies.
func webhookTimestamp(t pgtype.Timestamptz) int64 {
	if !t.Valid {
		return time.Now().UnixMilli()
	}
	return t.Time.UnixMilli()
}
