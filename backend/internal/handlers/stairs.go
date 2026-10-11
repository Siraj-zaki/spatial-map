package handlers

import (
	"context"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// StairRequest is the JSON body for creating or updating a stair shape.
// Vertices is a 2-element array: [[lng,lat],[lng,lat]] where vertices[0]
// is the bottom (first step) anchor and vertices[1] is the top anchor.
type StairRequest struct {
	Name        string          `json:"name" validate:"required"`
	Vertices    json.RawMessage `json:"vertices"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
}

type StairResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Vertices    json.RawMessage `json:"vertices,omitempty"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config,omitempty"`
	ZoneID      *int64          `json:"zoneId,omitempty"`
	FloorPlanID *int64          `json:"floorPlanId,omitempty"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func toStairResponse(row db.Stair) any {
	return baseShapeResponse(row.ID, row.TenantID, row.Name, row.Vertices, row.Rotation, row.Config, row.ZoneID, row.FloorPlanID, row.Unit, row.Visible, row.CreatedAt, row.UpdatedAt)
}

func stairParams(req StairRequest, tenantID int64) db.CreateStairParams {
	p := db.CreateStairParams{
		TenantID: tenantID,
		Name:     req.Name,
		Vertices: defaultJSONArray(req.Vertices),
		Rotation: req.Rotation,
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

func toUpdateStairParams(id, tenantID int64, p db.CreateStairParams) db.UpdateStairParams {
	return db.UpdateStairParams{
		ID: id, TenantID: tenantID,
		Name: p.Name, Vertices: p.Vertices, Rotation: p.Rotation, Config: p.Config,
		ZoneID: p.ZoneID, FloorPlanID: p.FloorPlanID, Unit: p.Unit, Visible: p.Visible,
	}
}

func StairsRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("stairs", q,
		func(ctx context.Context, tenantID int64) ([]db.Stair, error) { return q.ListStairs(ctx, tenantID) },
		toStairResponse,
		q.ListStairsByZone,
	))
	r.Post("/", shapeCreate("stair", q, func(ctx context.Context, p db.CreateStairParams) (db.Stair, error) { return q.CreateStair(ctx, p) }, stairParams, toStairResponse))
	r.Post("/bulk", shapeBulkCreate("stair", q, pool, func(tq *db.Queries) func(context.Context, db.CreateStairParams) (db.Stair, error) {
		return tq.CreateStair
	}, stairParams, toStairResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("stair", q, func(ctx context.Context, id, tenantID int64) (db.Stair, error) {
			return q.GetStair(ctx, db.GetStairParams{ID: id, TenantID: tenantID})
		}, toStairResponse))
		r.Patch("/", shapeUpdate("stair", q, func(ctx context.Context, p db.UpdateStairParams) (db.Stair, error) { return q.UpdateStair(ctx, p) }, func(ctx context.Context, id, tenantID int64) (db.Stair, error) {
			return q.GetStair(ctx, db.GetStairParams{ID: id, TenantID: tenantID})
		}, stairParams, toStairResponse, toUpdateStairParams))
		r.Delete("/", shapeDelete("stair", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteStair(ctx, db.DeleteStairParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
