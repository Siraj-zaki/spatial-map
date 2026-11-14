package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// BinRequest is the JSON body for creating or updating a bin.
type BinRequest struct {
	TargetKind       string          `json:"targetKind" validate:"required"`
	GridID           *int64          `json:"gridId"`
	Row              *int32          `json:"row"`
	Col              *int32          `json:"col"`
	Level            *int32          `json:"level"`
	ShapeID          *int64          `json:"shapeId"`
	Status           string          `json:"status"`
	Sku              string          `json:"sku"`
	Capacity         *float64        `json:"capacity"`
	Notes            string          `json:"notes"`
	ExternalCode     string          `json:"externalCode"`
	CustomProperties json.RawMessage `json:"customProperties"`
	SyncSource       *int64          `json:"syncSource"`
	FloorPlanID      *int64          `json:"floorPlanId"`
}

// BinResponse is the JSON representation returned by the API.
type BinResponse struct {
	ID               int64           `json:"id"`
	TenantID         int64           `json:"tenantId"`
	TargetKind       string          `json:"targetKind"`
	GridID           *int64          `json:"gridId,omitempty"`
	Row              *int32          `json:"row,omitempty"`
	Col              *int32          `json:"col,omitempty"`
	Level            *int32          `json:"level,omitempty"`
	ShapeID          *int64          `json:"shapeId,omitempty"`
	Status           string          `json:"status,omitempty"`
	Sku              string          `json:"sku,omitempty"`
	Capacity         *float64        `json:"capacity,omitempty"`
	Notes            string          `json:"notes,omitempty"`
	ExternalCode     string          `json:"externalCode,omitempty"`
	CustomProperties json.RawMessage `json:"customProperties,omitempty"`
	LastSyncedAt     string          `json:"lastSyncedAt,omitempty"`
	SyncSource       *int64          `json:"syncSource,omitempty"`
	FloorPlanID      *int64          `json:"floorPlanId,omitempty"`
	UpdatedAt        string          `json:"updatedAt"`
}

func toBinResponse(row db.Bin) BinResponse {
	resp := BinResponse{
		ID:               row.ID,
		TenantID:         row.TenantID,
		TargetKind:       string(row.TargetKind),
		Status:           string(row.Status.BinStatus),
		Sku:              row.Sku.String,
		Notes:            row.Notes.String,
		ExternalCode:     row.ExternalCode.String,
		CustomProperties: row.CustomProperties,
		UpdatedAt:        api.FormatTime(row.UpdatedAt),
	}
	if row.GridID.Valid {
		v := row.GridID.Int64
		resp.GridID = &v
	}
	if row.Row.Valid {
		v := row.Row.Int32
		resp.Row = &v
	}
	if row.Col.Valid {
		v := row.Col.Int32
		resp.Col = &v
	}
	if row.Level.Valid {
		v := row.Level.Int32
		resp.Level = &v
	}
	if row.ShapeID.Valid {
		v := row.ShapeID.Int64
		resp.ShapeID = &v
	}
	if row.Capacity.Valid {
		v := row.Capacity.Float64
		resp.Capacity = &v
	}
	if row.LastSyncedAt.Valid {
		resp.LastSyncedAt = api.FormatTime(row.LastSyncedAt)
	}
	if row.SyncSource.Valid {
		v := row.SyncSource.Int64
		resp.SyncSource = &v
	}
	if row.FloorPlanID.Valid {
		v := row.FloorPlanID.Int64
		resp.FloorPlanID = &v
	}
	return resp
}

// BinsRouter mounts bin CRUD routes.
func BinsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listBins(q))
	r.Post("/", createBin(q))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", getBin(q))
		r.Patch("/", updateBin(q))
		r.Delete("/", deleteBin(q))
	})
	return r
}

func binParams(req BinRequest, tenantID int64) db.CreateBinParams {
	customProps := req.CustomProperties
	if len(customProps) == 0 {
		customProps = json.RawMessage("{}")
	}
	p := db.CreateBinParams{
		TenantID:         tenantID,
		TargetKind:       db.BindingKind(req.TargetKind),
		Sku:              pgtype.Text{String: req.Sku, Valid: req.Sku != ""},
		Notes:            pgtype.Text{String: req.Notes, Valid: req.Notes != ""},
		ExternalCode:     pgtype.Text{String: req.ExternalCode, Valid: req.ExternalCode != ""},
		CustomProperties: customProps,
	}
	if req.Status != "" {
		p.Status = db.NullBinStatus{BinStatus: db.BinStatus(req.Status), Valid: true}
	}
	if req.GridID != nil {
		p.GridID = pgtype.Int8{Int64: *req.GridID, Valid: true}
	}
	if req.Row != nil {
		p.Row = pgtype.Int4{Int32: *req.Row, Valid: true}
	}
	if req.Col != nil {
		p.Col = pgtype.Int4{Int32: *req.Col, Valid: true}
	}
	if req.Level != nil {
		p.Level = pgtype.Int4{Int32: *req.Level, Valid: true}
	}
	if req.ShapeID != nil {
		p.ShapeID = pgtype.Int8{Int64: *req.ShapeID, Valid: true}
	}
	if req.Capacity != nil {
		p.Capacity = pgtype.Float8{Float64: *req.Capacity, Valid: true}
	}
	if req.SyncSource != nil {
		p.SyncSource = pgtype.Int8{Int64: *req.SyncSource, Valid: true}
	}
	if req.FloorPlanID != nil {
		p.FloorPlanID = pgtype.Int8{Int64: *req.FloorPlanID, Valid: true}
	}
	return p
}

func createBin(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var req BinRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := q.CreateBin(r.Context(), binParams(req, tenantID))
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, toBinResponse(row))
		BroadcastEntityEvent("ENTITY_CREATED", "bins", row.ID, tenantID)
	}
}

func getBin(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := q.GetBin(r.Context(), db.GetBinParams{ID: id, TenantID: tenantID})
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "bin not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, toBinResponse(row))
	}
}

func listBins(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		// ?zoneId=N → that facility's bins only (the map's request); without it, every bin as before.
		var rows []db.Bin
		var err error
		if zoneID := api.Int64Query(r, "zoneId", 0); zoneID > 0 {
			rows, err = q.ListBinsByZone(r.Context(), db.ListBinsByZoneParams{TenantID: tenantID, ZoneID: zoneID})
		} else {
			rows, err = q.ListBins(r.Context(), tenantID)
		}
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp := make([]BinResponse, len(rows))
		for i, row := range rows {
			resp[i] = toBinResponse(row)
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

func updateBin(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		var req BinRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		p := binParams(req, tenantID)
		row, err := q.UpdateBin(r.Context(), db.UpdateBinParams{
			ID:               id,
			TenantID:         tenantID,
			TargetKind:       p.TargetKind,
			GridID:           p.GridID,
			Row:              p.Row,
			Col:              p.Col,
			Level:            p.Level,
			ShapeID:          p.ShapeID,
			Status:           p.Status,
			Sku:              p.Sku,
			Capacity:         p.Capacity,
			Notes:            p.Notes,
			ExternalCode:     p.ExternalCode,
			CustomProperties: p.CustomProperties,
			SyncSource:       p.SyncSource,
			FloorPlanID:      p.FloorPlanID,
		})
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "bin not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, toBinResponse(row))
		BroadcastEntityEvent("ENTITY_UPDATED", "bins", row.ID, tenantID)
	}
}

func deleteBin(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := q.DeleteBin(r.Context(), db.DeleteBinParams{ID: id, TenantID: tenantID}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_DELETED", "bins", id, tenantID)
	}
}
