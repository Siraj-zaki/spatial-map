// Package handlers — entity_ingest.go
//
// Generic ingest endpoint for the new data-link architecture (see
// DESIGN-data-link.md). Publishers POST a batch of events to
// `/api/v1/streams/{id}/ingest`; each event upserts into
// `entity_states` (latest known state per entity_key) and appends
// into `entity_events` (time-series log for heatmaps, tracks, and the
// correlation engine).
//
// The payload is arbitrary JSON. The `entity_key` field is required
// (that's the publisher's stable ID for the entity); everything else
// is opaque and interpreted downstream by the DataLinkConfig's
// field_mapping. An optional top-level `position: [lng, lat]` unlocks
// the PostGIS spatial index for bbox filtering.
//
// Auth: tenant-scoped via X-Api-Key + X-Tenant-Id middleware.
// Stream ownership: the handler verifies the stream belongs to the
// caller's tenant before writing — otherwise a leaked stream_id
// would let anyone dump events under any tenant.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// EntityIngestEvent — one entity update in an ingest batch.
//
// `Payload` is the full raw JSON the publisher sent (asset row,
// sensor reading, RFID tag read, whatever). It gets stored as-is; the
// frontend's DataLinkConfig.field_mapping picks which keys drive
// visuals. Publishers who don't send lng/lat can omit `Position` and
// the row still upserts — it just won't render on `point-at-coord`
// modes until the payload includes coordinate fields.
type EntityIngestEvent struct {
	EntityKey string          `json:"entityKey" validate:"required"`
	Payload   json.RawMessage `json:"payload"`
	Position  *[2]float64     `json:"position,omitempty"` // [lng, lat]
	// TS is the publisher's event time: an RFC 3339 string, or epoch
	// seconds / milliseconds as a number or numeric string. When absent
	// the server stamps `now()`. An unreadable or far-future value
	// rejects that event (see parseEventTime) rather than silently
	// becoming "now" — the latest-state upsert orders by this time.
	TS json.RawMessage `json:"ts,omitempty"`
}

type EntityIngestRequest struct {
	Events []EntityIngestEvent `json:"events" validate:"required,min=1"`
}

const (
	// ingestMaxBytes / ingestMaxEvents bound one /ingest request. Devices
	// that buffer while offline should flush in several requests.
	ingestMaxBytes  = 8 << 20
	ingestMaxEvents = 5000
	// eventMaxFutureSkew tolerates small device clock drift. Anything
	// further ahead is rejected: the out-of-order guard would otherwise
	// let one bad clock freeze an entity's state until that time passes.
	eventMaxFutureSkew = 5 * time.Minute
)

// parseEventTime reads a publisher timestamp. v is the decoded JSON value
// (nil when absent). Numbers below 1e11 are epoch seconds, larger ones
// epoch milliseconds — 1e11 s is the year 5138, 1e11 ms is 1973.
func parseEventTime(v any, now time.Time) (time.Time, error) {
	var t time.Time
	switch x := v.(type) {
	case nil:
		return now, nil
	case string:
		if x == "" {
			return now, nil
		}
		if parsed, err := time.Parse(time.RFC3339Nano, x); err == nil {
			t = parsed
		} else if n, nerr := strconv.ParseFloat(x, 64); nerr == nil {
			t = epochTime(n)
		} else {
			return time.Time{}, fmt.Errorf("ts %q is not RFC 3339 or epoch seconds/milliseconds", x)
		}
	case float64:
		t = epochTime(x)
	default:
		return time.Time{}, fmt.Errorf("ts must be a string or a number")
	}
	if t.After(now.Add(eventMaxFutureSkew)) {
		return time.Time{}, fmt.Errorf("ts %s is more than 5 minutes ahead of server time", t.UTC().Format(time.RFC3339))
	}
	return t.UTC(), nil
}

func epochTime(n float64) time.Time {
	if n < 1e11 {
		return time.UnixMilli(int64(n * 1000))
	}
	return time.UnixMilli(int64(n))
}

// writeEntityEvent upserts the latest state and appends the history row.
// stale reports that a newer state was already stored: the event is still
// logged, but the state is left alone.
func writeEntityEvent(ctx context.Context, q *db.Queries, tenantID, streamID int64, entityKey string, payload json.RawMessage, positionWKT string, ts time.Time) (stale bool, err error) {
	at := pgtype.Timestamptz{Time: ts, Valid: true}
	if _, err := q.UpsertEntityState(ctx, db.UpsertEntityStateParams{
		TenantID:    tenantID,
		StreamID:    streamID,
		EntityKey:   entityKey,
		Payload:     payload,
		PositionWkt: positionWKT,
		LastSeenAt:  at,
	}); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		stale = true
	}
	if _, err := q.InsertEntityEvent(ctx, db.InsertEntityEventParams{
		TenantID:  tenantID,
		StreamID:  streamID,
		EntityKey: entityKey,
		Payload:   payload,
		Ts:        at,
	}); err != nil {
		// State truth is what rendering needs; a missing history row is
		// logged, not fatal.
		slog.ErrorContext(ctx, "insert entity event failed",
			"stream_id", streamID, "entity_key", entityKey, "error", err)
	}
	return stale, nil
}

type EntityIngestResponse struct {
	Accepted int `json:"accepted"`
	Rejected int `json:"rejected"`
	// Stale counts accepted events older than the stored state: logged
	// to history, but the latest state was not rolled back.
	Stale    int                `json:"stale"`
	StreamID int64              `json:"streamId"`
	Errors   []ingestEventError `json:"errors,omitempty"`
}

// ingestEventError explains one rejected event by its index in the batch.
type ingestEventError struct {
	Index int    `json:"index"`
	Error string `json:"error"`
}

// EntityStateResponse — one row from ListEntityStatesByStream. Kept
// intentionally close to the DB shape; the frontend applies the
// DataLinkConfig.fieldMapping to interpret `payload` at render time.
type EntityStateResponse struct {
	ID         int64           `json:"id"`
	StreamID   int64           `json:"streamId"`
	EntityKey  string          `json:"entityKey"`
	Payload    json.RawMessage `json:"payload"`
	Position   *[2]float64     `json:"position,omitempty"`
	LastSeenAt string          `json:"lastSeenAt"`
	UpdatedAt  string          `json:"updatedAt"`
}

// EntityIngestRouter — POST /api/v1/streams/{id}/ingest handler.
// Wired underneath the existing StreamsRouter so the tenant + auth
// middleware chain is inherited.
func handleEntityIngest(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		streamID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			api.BadRequest(w, "invalid stream id")
			return
		}
		// Verify the stream belongs to this tenant. Otherwise a
		// leaked ID would let anyone write to it.
		if _, err := q.GetStream(r.Context(), db.GetStreamParams{ID: streamID, TenantID: tenantID}); err != nil {
			api.NotFound(w, "stream not found")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, ingestMaxBytes)
		var req EntityIngestRequest
		if err := api.DecodeBody(r, &req); err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				api.Error(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("body is over %d MB; send events in smaller batches", ingestMaxBytes>>20))
				return
			}
			api.BadRequest(w, err.Error())
			return
		}
		if len(req.Events) == 0 {
			api.BadRequest(w, "events required")
			return
		}
		if len(req.Events) > ingestMaxEvents {
			api.Error(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("events holds %d items, over the limit of %d", len(req.Events), ingestMaxEvents))
			return
		}
		resp := EntityIngestResponse{StreamID: streamID}
		reject := func(i int, msg string) {
			resp.Rejected++
			resp.Errors = append(resp.Errors, ingestEventError{Index: i, Error: msg})
		}
		now := time.Now().UTC()
		for i, ev := range req.Events {
			if ev.EntityKey == "" {
				reject(i, "entityKey is required")
				continue
			}
			var tsValue any
			if len(ev.TS) > 0 {
				if err := json.Unmarshal(ev.TS, &tsValue); err != nil {
					reject(i, "ts is not valid JSON")
					continue
				}
			}
			ts, err := parseEventTime(tsValue, now)
			if err != nil {
				reject(i, err.Error())
				continue
			}
			payload := ev.Payload
			if len(payload) == 0 {
				payload = json.RawMessage(`{}`)
			}
			positionWKT := ""
			if ev.Position != nil {
				positionWKT = fmt.Sprintf("POINT(%f %f)", ev.Position[0], ev.Position[1])
			}
			stale, err := writeEntityEvent(r.Context(), q, tenantID, streamID, ev.EntityKey, payload, positionWKT, ts)
			if err != nil {
				slog.ErrorContext(r.Context(), "upsert entity state failed",
					"stream_id", streamID, "entity_key", ev.EntityKey, "error", err)
				reject(i, "could not be stored")
				continue
			}
			resp.Accepted++
			if stale {
				resp.Stale++
			}
		}
		// Nudge the SSE bus so viewers subscribed to this tenant
		// invalidate their entity-state caches and refetch. `id=0`
		// is a no-op guard inside BroadcastEntityEvent, so we pass
		// the streamID to signal "this specific stream just took
		// data" — subscribers key their cache on stream id.
		if resp.Accepted > 0 {
			BroadcastEntityEvent("update", "entity-states", streamID, tenantID)
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

// handleListEntityStates — GET /api/v1/streams/{id}/entities.
// Returns the latest state per entity for a stream. The frontend
// polls this endpoint (or subscribes via SSE) to drive the generic
// overlay.
func handleListEntityStates(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		streamID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			api.BadRequest(w, "invalid stream id")
			return
		}
		rows, err := q.ListEntityStatesByStream(r.Context(), db.ListEntityStatesByStreamParams{
			StreamID: streamID,
			TenantID: tenantID,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]EntityStateResponse, 0, len(rows))
		for _, row := range rows {
			resp := EntityStateResponse{
				ID:         row.ID,
				StreamID:   row.StreamID,
				EntityKey:  row.EntityKey,
				Payload:    row.Payload,
				LastSeenAt: api.FormatTime(row.LastSeenAt),
				UpdatedAt:  api.FormatTime(row.UpdatedAt),
			}
			// PositionWkt is `POINT(lng lat)` or empty string when NULL.
			if lng, lat, ok := parsePointWKT(row.PositionWkt); ok {
				resp.Position = &[2]float64{lng, lat}
			}
			out = append(out, resp)
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// EntityEventResponse — wire shape for /streams/:id/events. The
// frontend consumes this for heatmap (density over recent positions)
// and track (per-entity breadcrumb LineString) render modes.
type EntityEventResponse struct {
	ID        int64           `json:"id"`
	StreamID  int64           `json:"streamId"`
	EntityKey string          `json:"entityKey"`
	Payload   json.RawMessage `json:"payload"`
	Ts        string          `json:"ts"`
}

// handleListEntityEvents — GET /api/v1/streams/{id}/events?window=60&limit=500.
// `window` is seconds; only events with `ts >= now() - window` are
// returned. Defaults to 60s window + 500-row cap so a chatty stream
// can't dump 100k rows into a single request.
func handleListEntityEvents(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		streamID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			api.BadRequest(w, "invalid stream id")
			return
		}
		windowSec := int64(60)
		if v := r.URL.Query().Get("window"); v != "" {
			if parsed, err := strconv.ParseInt(v, 10, 64); err == nil && parsed > 0 && parsed <= 3600 {
				windowSec = parsed
			}
		}
		limit := int32(500)
		if v := r.URL.Query().Get("limit"); v != "" {
			if parsed, err := strconv.ParseInt(v, 10, 32); err == nil && parsed > 0 && parsed <= 5000 {
				limit = int32(parsed)
			}
		}
		since := time.Now().UTC().Add(-time.Duration(windowSec) * time.Second)
		rows, err := q.ListEntityEventsByStream(r.Context(), db.ListEntityEventsByStreamParams{
			StreamID: streamID,
			TenantID: tenantID,
			Ts:       pgtype.Timestamptz{Time: since, Valid: true},
			Limit:    limit,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]EntityEventResponse, 0, len(rows))
		for _, row := range rows {
			out = append(out, EntityEventResponse{
				ID:        row.ID,
				StreamID:  row.StreamID,
				EntityKey: row.EntityKey,
				Payload:   row.Payload,
				Ts:        api.FormatTime(row.Ts),
			})
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// EntityStateWithStreamResponse — one row from the tenant-wide join.
// Adds `entityType` + `streamName` so the viewer sidebar can group
// without a second round-trip to /streams. Same payload / position
// shape as EntityStateResponse otherwise, so the frontend can reuse
// the same rendering path.
type EntityStateWithStreamResponse struct {
	ID         int64           `json:"id"`
	StreamID   int64           `json:"streamId"`
	EntityKey  string          `json:"entityKey"`
	EntityType string          `json:"entityType"`
	StreamName string          `json:"streamName"`
	Payload    json.RawMessage `json:"payload"`
	Position   *[2]float64     `json:"position,omitempty"`
	LastSeenAt string          `json:"lastSeenAt"`
	UpdatedAt  string          `json:"updatedAt"`
}

// handleListAllEntityStates — GET /api/v1/entity-states.
// Returns the latest state for every entity across every stream in
// the caller's tenant, joined with `streams` for entity_type +
// stream name. Replaces the four per-entity endpoints (assets,
// sensors, cameras, shipments) with a single generic query — the
// viewer sidebar filters by `entityType` client-side. Capped at 2000
// rows in SQL to bound wire size on chatty tenants.
func handleListAllEntityStates(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		rows, err := q.ListEntityStatesWithStreamByTenant(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]EntityStateWithStreamResponse, 0, len(rows))
		for _, row := range rows {
			resp := EntityStateWithStreamResponse{
				ID:         row.ID,
				StreamID:   row.StreamID,
				EntityKey:  row.EntityKey,
				EntityType: row.EntityType,
				StreamName: row.StreamName,
				Payload:    row.Payload,
				LastSeenAt: api.FormatTime(row.LastSeenAt),
				UpdatedAt:  api.FormatTime(row.UpdatedAt),
			}
			if lng, lat, ok := parsePointWKT(row.PositionWkt); ok {
				resp.Position = &[2]float64{lng, lat}
			}
			out = append(out, resp)
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// parsePointWKT parses `POINT(lng lat)` into two floats. Returns
// (0, 0, false) on any unexpected input so the caller can just skip
// the row without erroring.
func parsePointWKT(wkt string) (float64, float64, bool) {
	if wkt == "" {
		return 0, 0, false
	}
	var lng, lat float64
	// Scanf handles whitespace, matches "POINT(x y)" strictly.
	n, err := fmt.Sscanf(wkt, "POINT(%f %f)", &lng, &lat)
	if err != nil || n != 2 {
		return 0, 0, false
	}
	return lng, lat, true
}
