package handlers

import (
	"context"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type LineRequest struct {
	Name        string          `json:"name" validate:"required"`
	Vertices    json.RawMessage `json:"vertices"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
}

type LineResponse struct {
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

func toLineResponse(row db.Line) any {
	return baseShapeResponse(row.ID, row.TenantID, row.Name, row.Vertices, row.Rotation, row.Config, row.ZoneID, row.FloorPlanID, row.Unit, row.Visible, row.CreatedAt, row.UpdatedAt)
}

func lineParams(req LineRequest, tenantID int64) db.CreateLineParams {
	p := db.CreateLineParams{
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

func toUpdateLineParams(id, tenantID int64, p db.CreateLineParams) db.UpdateLineParams {
	return db.UpdateLineParams{
		ID: id, TenantID: tenantID,
		Name: p.Name, Vertices: p.Vertices, Rotation: p.Rotation, Config: p.Config,
		ZoneID: p.ZoneID, FloorPlanID: p.FloorPlanID, Unit: p.Unit, Visible: p.Visible,
	}
}

func LinesRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("lines", q,
		func(ctx context.Context, tenantID int64) ([]db.Line, error) { return q.ListLines(ctx, tenantID) },
		toLineResponse,
		q.ListLinesByZone,
	))
	r.Post("/", shapeCreate("line", q, func(ctx context.Context, p db.CreateLineParams) (db.Line, error) { return q.CreateLine(ctx, p) }, lineParams, toLineResponse))
	r.Post("/bulk", shapeBulkCreate("line", q, pool, func(tq *db.Queries) func(context.Context, db.CreateLineParams) (db.Line, error) {
		return tq.CreateLine
	}, lineParams, toLineResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("line", q, func(ctx context.Context, id, tenantID int64) (db.Line, error) {
			return q.GetLine(ctx, db.GetLineParams{ID: id, TenantID: tenantID})
		}, toLineResponse))
		r.Patch("/", shapeUpdate("line", q, func(ctx context.Context, p db.UpdateLineParams) (db.Line, error) { return q.UpdateLine(ctx, p) }, func(ctx context.Context, id, tenantID int64) (db.Line, error) {
			return q.GetLine(ctx, db.GetLineParams{ID: id, TenantID: tenantID})
		}, lineParams, toLineResponse, toUpdateLineParams))
		r.Delete("/", shapeDelete("line", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteLine(ctx, db.DeleteLineParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
