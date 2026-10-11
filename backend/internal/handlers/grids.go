package handlers

import (
	"context"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// GridRequest is the JSON body for creating or updating a grid.
type GridRequest struct {
	Name        string          `json:"name" validate:"required"`
	Start       [2]float64      `json:"start"`
	Current     [2]float64      `json:"current"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Visible     bool            `json:"visible"`
}

// GridResponse is the JSON representation returned by the API.
type GridResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Start       [2]float64      `json:"start"`
	Current     [2]float64      `json:"current"`
	Config      json.RawMessage `json:"config,omitempty"`
	ZoneID      *int64          `json:"zoneId,omitempty"`
	FloorPlanID *int64          `json:"floorPlanId,omitempty"`
	Visible     bool            `json:"visible"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func toGridResponse(row db.Grid) any {
	resp := GridResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		Name:      row.Name,
		Start:     [2]float64{row.StartLng, row.StartLat},
		Current:   [2]float64{row.CurrentLng, row.CurrentLat},
		Config:    row.Config,
		Visible:   row.Visible,
		CreatedAt: api.FormatTime(row.CreatedAt),
		UpdatedAt: api.FormatTime(row.UpdatedAt),
	}
	setInt64Ptr(&resp.ZoneID, row.ZoneID)
	setInt64Ptr(&resp.FloorPlanID, row.FloorPlanID)
	return resp
}

func gridParams(req GridRequest, tenantID int64) db.CreateGridParams {
	config := req.Config
	if len(config) == 0 {
		config = json.RawMessage("{}")
	}
	p := db.CreateGridParams{
		TenantID:   tenantID,
		Name:       req.Name,
		StartLng:   req.Start[0],
		StartLat:   req.Start[1],
		CurrentLng: req.Current[0],
		CurrentLat: req.Current[1],
		Config:     config,
		Visible:    req.Visible,
	}
	if req.ZoneID != nil {
		p.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	if req.FloorPlanID != nil {
		p.FloorPlanID = pgtype.Int8{Int64: *req.FloorPlanID, Valid: true}
	}
	return p
}

func toUpdateGridParams(id, tenantID int64, p db.CreateGridParams) db.UpdateGridParams {
	return db.UpdateGridParams{
		ID:          id,
		TenantID:    tenantID,
		Name:        p.Name,
		StartLng:    p.StartLng,
		StartLat:    p.StartLat,
		CurrentLng:  p.CurrentLng,
		CurrentLat:  p.CurrentLat,
		Config:      p.Config,
		ZoneID:      p.ZoneID,
		FloorPlanID: p.FloorPlanID,
		Visible:     p.Visible,
	}
}

// GridsRouter mounts grid CRUD routes.
func GridsRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("grids", q,
		func(ctx context.Context, tenantID int64) ([]db.Grid, error) {
			return q.ListGrids(ctx, tenantID)
		},
		toGridResponse,
		q.ListGridsByZone,
	))
	r.Post("/", shapeCreate("grid", q, func(ctx context.Context, p db.CreateGridParams) (db.Grid, error) {
		return q.CreateGrid(ctx, p)
	}, gridParams, toGridResponse))
	r.Post("/bulk", shapeBulkCreate("grid", q, pool, func(tq *db.Queries) func(context.Context, db.CreateGridParams) (db.Grid, error) {
		return tq.CreateGrid
	}, gridParams, toGridResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("grid", q, func(ctx context.Context, id, tenantID int64) (db.Grid, error) {
			return q.GetGrid(ctx, db.GetGridParams{ID: id, TenantID: tenantID})
		}, toGridResponse))
		r.Patch("/", shapeUpdate("grid", q, func(ctx context.Context, p db.UpdateGridParams) (db.Grid, error) {
			return q.UpdateGrid(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.Grid, error) {
			return q.GetGrid(ctx, db.GetGridParams{ID: id, TenantID: tenantID})
		}, gridParams, toGridResponse, toUpdateGridParams))
		r.Delete("/", shapeDelete("grid", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteGrid(ctx, db.DeleteGridParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
