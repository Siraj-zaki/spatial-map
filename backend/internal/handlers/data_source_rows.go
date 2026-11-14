// Package handlers — V3 Slice 2 data-source-rows handlers.
//
// Every non-rack file/REST/webhook import upserts here via
// UpsertDataSourceRows (called from import_pipeline.go, webhooks.go,
// and REST rerun paths). Layer sub-renderers on the SPA read via
// GET /api/v1/data-sources/:id/rows.
//
// Streaming (WS + POST /streams/:id/ingest) continues writing to
// entity_states until Slice 6 unifies the read path.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// DataSourceRowInput — what the writer side (importer / drainer)
// hands us. `position` is optional; when nil the row goes in with a
// NULL position column.
type DataSourceRowInput struct {
	EntityKey       string
	Payload         json.RawMessage
	Position        *[2]float64 // [lng, lat]; nil = no position
	LinkedShapeName string
	TS              pgtype.Timestamptz // zero → default now()
}

// DataSourceRowResponse — JSON shape the SPA sees. Position is
// unpacked from WKT into [lng, lat] so the frontend never touches
// PostGIS text.
type DataSourceRowResponse struct {
	ID              int64           `json:"id"`
	SourceID        int64           `json:"sourceId"`
	EntityKey       string          `json:"entityKey"`
	Payload         json.RawMessage `json:"payload"`
	Position        *[2]float64     `json:"position,omitempty"`
	LinkedShapeName string          `json:"linkedShapeName,omitempty"`
	TS              string          `json:"ts"`
	UpdatedAt       string          `json:"updatedAt"`
}

// --------------------------------------- write side (called by others)

// UpsertDataSourceRows writes many rows for one source in one round
// trip's worth of statements. Errors on any individual row are
// collected and returned but the batch continues so a single bad row
// doesn't abort a large import. Returns the count of rows successfully
// upserted.
func UpsertDataSourceRows(
	ctx context.Context,
	q *db.Queries,
	tenantID, sourceID int64,
	rows []DataSourceRowInput,
) (int, []error) {
	if len(rows) == 0 {
		return 0, nil
	}
	var errs []error
	written := 0
	for _, r := range rows {
		if r.EntityKey == "" {
			errs = append(errs, fmt.Errorf("empty entity_key"))
			continue
		}
		positionWKT := ""
		if r.Position != nil {
			// SRID 4326. `ST_GeomFromText('POINT(<lng> <lat>)', 4326)`.
			positionWKT = fmt.Sprintf("POINT(%g %g)", r.Position[0], r.Position[1])
		}
		ts := r.TS
		if !ts.Valid {
			ts = pgtype.Timestamptz{Valid: false}
		}
		linked := pgtype.Text{}
		if r.LinkedShapeName != "" {
			linked = pgtype.Text{String: r.LinkedShapeName, Valid: true}
		}
		payload := r.Payload
		if len(payload) == 0 {
			payload = json.RawMessage(`{}`)
		}
		_, err := q.UpsertDataSourceRow(ctx, db.UpsertDataSourceRowParams{
			TenantID:        tenantID,
			SourceID:        sourceID,
			EntityKey:       r.EntityKey,
			Payload:         payload,
			PositionWkt:     positionWKT,
			LinkedShapeName: linked,
			Ts:              ts,
		})
		if err != nil {
			errs = append(errs, fmt.Errorf("upsert %q: %w", r.EntityKey, err))
			continue
		}
		written++
	}
	return written, errs
}

// --------------------------------------- read side (SPA-facing)

func listDataSourceRowsHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.Error(w, http.StatusUnauthorized, "tenant scope required")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid data-source id")
			return
		}
		serveDataSourceRows(w, r, q, tenantID, sourceID)
	}
}

// serveDataSourceRows writes every row of a source in the given tenant.
// Shared by the signed-in route and the report share-link route.
func serveDataSourceRows(w http.ResponseWriter, r *http.Request, q *db.Queries, tenantID, sourceID int64) {
	// Confirm the source exists in-tenant before reading rows —
	// otherwise a stale bookmark returns rows scoped to another
	// tenant's id which is a subtle leak.
	if _, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
		ID: sourceID, TenantID: tenantID,
	}); err != nil {
		api.NotFound(w, "data_source not found")
		return
	}
	rows, err := q.ListDataSourceRows(r.Context(), db.ListDataSourceRowsParams{
		SourceID: sourceID, TenantID: tenantID,
	})
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	out := make([]DataSourceRowResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, DataSourceRowResponse{
			ID:              row.ID,
			SourceID:        row.SourceID,
			EntityKey:       row.EntityKey,
			Payload:         row.Payload,
			Position:        parseWktPoint(row.PositionWkt),
			LinkedShapeName: row.LinkedShapeName.String,
			TS:              api.FormatTime(row.Ts),
			UpdatedAt:       api.FormatTime(row.UpdatedAt),
		})
	}
	api.JSON(w, http.StatusOK, map[string]any{
		"rows":  out,
		"count": len(out),
	})
}

func getDataSourceRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.Error(w, http.StatusUnauthorized, "tenant scope required")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid data-source id")
			return
		}
		entityKey := chi.URLParam(r, "entityKey")
		if entityKey == "" {
			api.BadRequest(w, "empty entity_key")
			return
		}
		row, err := q.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
			SourceID: sourceID, EntityKey: entityKey, TenantID: tenantID,
		})
		if err != nil {
			api.NotFound(w, "data_source_row not found")
			return
		}
		api.JSON(w, http.StatusOK, DataSourceRowResponse{
			ID:              row.ID,
			SourceID:        row.SourceID,
			EntityKey:       row.EntityKey,
			Payload:         row.Payload,
			Position:        parseWktPoint(row.PositionWkt),
			LinkedShapeName: row.LinkedShapeName.String,
			TS:              api.FormatTime(row.Ts),
			UpdatedAt:       api.FormatTime(row.UpdatedAt),
		})
	}
}

func deleteDataSourceRowsHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.Error(w, http.StatusUnauthorized, "tenant scope required")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid data-source id")
			return
		}
		if err := q.DeleteDataSourceRowsBySource(r.Context(), db.DeleteDataSourceRowsBySourceParams{
			SourceID: sourceID, TenantID: tenantID,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
	}
}

// -------------------------------------------------------------- utils

func parseIDFromPath(r *http.Request, param string) (int64, error) {
	raw := chi.URLParam(r, param)
	if raw == "" {
		return 0, errors.New("missing id")
	}
	return strconv.ParseInt(raw, 10, 64)
}

// parseWktPoint reads `POINT(lng lat)` (with optional SRID prefix from
// EWKT) into [lng, lat]. Returns nil when the input is empty or not
// parseable — callers should treat that as "no position".
func parseWktPoint(wkt string) *[2]float64 {
	if wkt == "" {
		return nil
	}
	// Accept both `POINT(lng lat)` and `POINT (lng lat)`.
	var lng, lat float64
	// Strip any leading `SRID=…;` prefix (EWKT) — ST_AsText normally
	// doesn't emit it but be defensive against future PostGIS changes.
	src := wkt
	if idx := indexByte(src, ';'); idx >= 0 && src[:5] == "SRID=" {
		src = src[idx+1:]
	}
	if _, err := fmt.Sscanf(src, "POINT(%g %g)", &lng, &lat); err == nil {
		return &[2]float64{lng, lat}
	}
	if _, err := fmt.Sscanf(src, "POINT (%g %g)", &lng, &lat); err == nil {
		return &[2]float64{lng, lat}
	}
	return nil
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
