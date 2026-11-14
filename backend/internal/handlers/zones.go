package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ZoneRequest is the JSON body for creating or updating a zone.
//
// The new fields are optional so older clients that don't know about them
// still work: a missing DefaultView clears the saved viewport, a missing
// ShareToken clears the token, and a missing IsPublic defaults to true
// (preserving the pre-Phase-14 "anyone with the link can view" behaviour).
type ZoneRequest struct {
	Name        string          `json:"name" validate:"required"`
	Color       string          `json:"color" validate:"required"`
	Description string          `json:"description"`
	Center      *[2]float64     `json:"center"`
	Address     string          `json:"address"`
	DefaultView json.RawMessage `json:"defaultView"`
	ShareToken  *string         `json:"shareToken"`
	IsPublic    *bool           `json:"isPublic"`
}

// ZoneResponse is the JSON representation returned by the API.
type ZoneResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Color       string          `json:"color"`
	Description string          `json:"description"`
	Center      *[2]float64     `json:"center,omitempty"`
	Address     string          `json:"address,omitempty"`
	DefaultView json.RawMessage `json:"defaultView,omitempty"`
	ShareToken  string          `json:"shareToken,omitempty"`
	IsPublic    bool            `json:"isPublic"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

// toZoneResponse + zoneRowToResponse build the JSON envelope from any of
// the sqlc-generated zone row structs. Every zone query selects the same
// column list, so every row struct has an identical field layout and the
// callers can cast to db.CreateZoneRow before invoking toZoneResponse.

func toZoneResponse(row db.CreateZoneRow) ZoneResponse {
	return zoneRowToResponse(row.ID, row.TenantID, row.Name, row.Color, row.Description, row.CenterLng, row.CenterLat, row.Address, row.DefaultView, row.ShareToken, row.IsPublic, row.CreatedAt, row.UpdatedAt)
}

func zoneRowToResponse(id, tenantID int64, name, color, description string, centerLng, centerLat interface{}, address pgtype.Text, defaultView []byte, shareToken pgtype.Text, isPublic bool, createdAt, updatedAt pgtype.Timestamptz) ZoneResponse {
	resp := ZoneResponse{
		ID:          id,
		TenantID:    tenantID,
		Name:        name,
		Color:       color,
		Description: description,
		Address:     address.String,
		IsPublic:    isPublic,
		DefaultView: json.RawMessage(defaultView),
	}
	if createdAt.Valid {
		resp.CreatedAt = createdAt.Time.Format(time.RFC3339)
	}
	if updatedAt.Valid {
		resp.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
	}
	if address.Valid {
		resp.Address = address.String
	}
	if centerLng != nil && centerLat != nil {
		lng, _ := centerLng.(float64)
		lat, _ := centerLat.(float64)
		resp.Center = &[2]float64{lng, lat}
	}
	if shareToken.Valid {
		resp.ShareToken = shareToken.String
	}
	// Treat an empty/NULL default_view as absent so the JSON omits it
	// (omitempty on a json.RawMessage only triggers on nil, not on an
	// empty slice — guard explicitly).
	if len(resp.DefaultView) == 0 {
		resp.DefaultView = nil
	}
	return resp
}

// ZonesRouter mounts zone CRUD routes. The `pool` is used by the
// duplicate endpoint, which deep-copies a warehouse and every zone-
// scoped row inside a single transaction. `s` is used by the delete
// endpoint to reclaim object-store files that were owned by shapes in
// the zone.
func ZonesRouter(q *db.Queries, pool *pgxpool.Pool, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listZones(q))
	r.Post("/", createZone(q))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", getZone(q))
		r.Get("/view", getZoneView(q))
		r.Patch("/", updateZone(q))
		r.Delete("/", deleteZone(q, s))
		// Mounted inside the /{id} group so the path param resolves
		// consistently with the other zone routes.
		r.Post("/duplicate", duplicateZone(q, pool))
	})
	return r
}

func createZone(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var req ZoneRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		var lng, lat float64
		if req.Center != nil {
			lng, lat = req.Center[0], req.Center[1]
		}

		isPublic := true
		if req.IsPublic != nil {
			isPublic = *req.IsPublic
		}

		row, err := q.CreateZone(r.Context(), db.CreateZoneParams{
			TenantID:      tenantID,
			Name:          req.Name,
			Color:         req.Color,
			Description:   req.Description,
			StMakepoint:   lng,
			StMakepoint_2: lat,
			Address:       pgtype.Text{String: req.Address, Valid: req.Address != ""},
			DefaultView:   []byte(req.DefaultView),
			ShareToken:    shareTokenParam(req.ShareToken),
			IsPublic:      isPublic,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		createFacilityReports(r, q, tenantID, row.ID)
		api.JSON(w, http.StatusCreated, toZoneResponse(row))
		BroadcastEntityEvent("ENTITY_CREATED", "zones", row.ID, tenantID)
	}
}

// createFacilityReports adds the facility report set (Overview, Floors,
// Areas, Racks, …) for a new facility. Best-effort: the facility is
// already created, so a failure is logged rather than failing the
// request.
func createFacilityReports(r *http.Request, q *db.Queries, tenantID, zoneID int64) {
	if _, err := reports.CreateFacilityReports(r.Context(), q, tenantID, zoneID, api.UserID(r.Context()), nil); err != nil {
		slog.WarnContext(r.Context(), "create facility reports failed", "zone", zoneID, "error", err)
	}
}

func getZone(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := q.GetZone(r.Context(), db.GetZoneParams{ID: id, TenantID: tenantID})
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "zone not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, toZoneResponse(db.CreateZoneRow(row)))
	}
}

// getZoneView returns the facility with every shape and bin in one call —
// the same WarehouseView envelope a share link gets (buildWarehouseViewPayload),
// for members of the facility's workspace whether or not it is public. The
// mobile app loads a facility with it.
func getZoneView(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := q.GetZone(r.Context(), db.GetZoneParams{ID: id, TenantID: api.TenantID(r.Context())})
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "zone not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		view, ok := buildWarehouseViewPayload(q, r, db.CreateZoneRow(row), true)
		if !ok {
			api.NotFound(w, "zone not found")
			return
		}
		api.JSON(w, http.StatusOK, view)
	}
}

func listZones(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		rows, err := q.ListZones(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp := make([]ZoneResponse, len(rows))
		for i, row := range rows {
			resp[i] = zoneRowToResponse(row.ID, row.TenantID, row.Name, row.Color, row.Description, row.CenterLng, row.CenterLat, row.Address, row.DefaultView, row.ShareToken, row.IsPublic, row.CreatedAt, row.UpdatedAt)
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

func updateZone(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		var req ZoneRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		var lng, lat float64
		if req.Center != nil {
			lng, lat = req.Center[0], req.Center[1]
		}

		isPublic := true
		if req.IsPublic != nil {
			isPublic = *req.IsPublic
		}

		row, err := q.UpdateZone(r.Context(), db.UpdateZoneParams{
			ID:            id,
			TenantID:      tenantID,
			Name:          req.Name,
			Color:         req.Color,
			Description:   req.Description,
			StMakepoint:   lng,
			StMakepoint_2: lat,
			Address:       pgtype.Text{String: req.Address, Valid: req.Address != ""},
			DefaultView:   []byte(req.DefaultView),
			ShareToken:    shareTokenParam(req.ShareToken),
			IsPublic:      isPublic,
		})
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "zone not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, toZoneResponse(db.CreateZoneRow(row)))
		BroadcastEntityEvent("ENTITY_UPDATED", "zones", row.ID, tenantID)
	}
}

// deleteZone hard-removes a warehouse and every shape/data-source/etc.
// row that pointed at it (via ON DELETE CASCADE — see migration
// 0027). Object-store files owned by images + image_planes in the
// zone are also reclaimed here.
//
// Order matters:
//  1. Collect the file URLs from images + image_planes BEFORE the
//     DELETE fires — once CASCADE runs the rows (and thus the URLs)
//     are unrecoverable.
//  2. Run the zone DELETE. Postgres cascades to every child.
//  3. AFTER the DB commit, delete each collected file. Doing this
//     post-commit means a mid-flight crash leaves an orphan file
//     (safe — cleanup-orphans sweeps them) rather than a live DB row
//     pointing at a missing file (unsafe).
//
// user_models are NOT zone-scoped so their files are unaffected here.
// Legacy avatar / catalog cleanup lives in their own delete flows.
func deleteZone(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		imageURLs, err := q.ListImageURLsByZone(r.Context(), db.ListImageURLsByZoneParams{
			TenantID: tenantID,
			ZoneID:   pgtype.Int8{Int64: id, Valid: true},
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		planeURLs, err := q.ListImagePlaneURLsByZone(r.Context(), db.ListImagePlaneURLsByZoneParams{
			TenantID: tenantID,
			ZoneID:   pgtype.Int8{Int64: id, Valid: true},
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		if err := q.DeleteZone(r.Context(), db.DeleteZoneParams{ID: id, TenantID: tenantID}); err != nil {
			api.InternalError(w, r, err)
			return
		}

		cleanupObjectURLs(r.Context(), q, s, append(imageURLs, planeURLs...))
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_DELETED", "zones", id, tenantID)
	}
}

// shareTokenParam converts the request's optional `shareToken` into the
// pgtype.Text the generated query expects. nil pointer → invalid (NULL);
// empty string → invalid (NULL) so clients can clear the token by sending "".
func shareTokenParam(tok *string) pgtype.Text {
	if tok == nil || *tok == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *tok, Valid: true}
}
