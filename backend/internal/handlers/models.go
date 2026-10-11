package handlers

import (
	"context"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type ModelRequest struct {
	Name        string          `json:"name" validate:"required"`
	Position    [2]float64      `json:"position"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
}

type ModelResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Position    [2]float64      `json:"position"`
	Config      json.RawMessage `json:"config,omitempty"`
	ZoneID      *int64          `json:"zoneId,omitempty"`
	FloorPlanID *int64          `json:"floorPlanId,omitempty"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func toModelResponse(row db.Model) any {
	resp := ModelResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		Name:      row.Name,
		Position:  [2]float64{row.Lng, row.Lat},
		Config:    row.Config,
		Unit:      row.Unit,
		Visible:   row.Visible,
		CreatedAt: api.FormatTime(row.CreatedAt),
		UpdatedAt: api.FormatTime(row.UpdatedAt),
	}
	setInt64Ptr(&resp.ZoneID, row.ZoneID)
	setInt64Ptr(&resp.FloorPlanID, row.FloorPlanID)
	return resp
}

func modelParams(req ModelRequest, tenantID int64) db.CreateModelParams {
	p := db.CreateModelParams{
		TenantID: tenantID,
		Name:     req.Name,
		Lng:      req.Position[0],
		Lat:      req.Position[1],
		Config:   defaultJSONObject(req.Config),
		Unit:     req.Unit,
		Visible:  req.Visible,
	}
	if req.ZoneID != nil {
		p.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	if req.FloorPlanID != nil {
		p.FloorPlanID = pgtype.Int8{Int64: *req.FloorPlanID, Valid: true}
	}
	return p
}

func toUpdateModelParams(id, tenantID int64, p db.CreateModelParams) db.UpdateModelParams {
	return db.UpdateModelParams{
		ID: id, TenantID: tenantID,
		Name: p.Name, Lng: p.Lng, Lat: p.Lat, Config: p.Config,
		ZoneID: p.ZoneID, FloorPlanID: p.FloorPlanID, Unit: p.Unit, Visible: p.Visible,
	}
}

func ModelsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("models", q,
		func(ctx context.Context, tenantID int64) ([]db.Model, error) { return q.ListModels(ctx, tenantID) },
		toModelResponse,
		q.ListModelsByZone,
	))
	r.Post("/", shapeCreate("model", q, func(ctx context.Context, p db.CreateModelParams) (db.Model, error) { return q.CreateModel(ctx, p) }, modelParams, toModelResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("model", q, func(ctx context.Context, id, tenantID int64) (db.Model, error) {
			return q.GetModel(ctx, db.GetModelParams{ID: id, TenantID: tenantID})
		}, toModelResponse))
		r.Patch("/", shapeUpdate("model", q, func(ctx context.Context, p db.UpdateModelParams) (db.Model, error) { return q.UpdateModel(ctx, p) }, func(ctx context.Context, id, tenantID int64) (db.Model, error) {
			return q.GetModel(ctx, db.GetModelParams{ID: id, TenantID: tenantID})
		}, modelParams, toModelResponse, toUpdateModelParams))
		r.Delete("/", shapeDelete("model", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteModel(ctx, db.DeleteModelParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
