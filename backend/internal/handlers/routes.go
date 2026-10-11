package handlers

import (
	"context"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// RouteRequest — JSON body for POST + PATCH.
//
// Payload matches LineRequest — same vertices/rotation/config
// convention — but semantically these are wayfinding paths, not walls.
// The `type` (walking / driving / emergency / forklift / accessible)
// lives inside `Config` so new types can ship without a migration.
type RouteRequest struct {
	Name        string          `json:"name" validate:"required"`
	Vertices    json.RawMessage `json:"vertices"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
}

type RouteResponse struct {
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

func toRouteResponse(row db.Route) any {
	return baseShapeResponse(row.ID, row.TenantID, row.Name, row.Vertices, row.Rotation, row.Config, row.ZoneID, row.FloorPlanID, row.Unit, row.Visible, row.CreatedAt, row.UpdatedAt)
}

func routeParams(req RouteRequest, tenantID int64) db.CreateRouteParams {
	p := db.CreateRouteParams{
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

func toUpdateRouteParams(id, tenantID int64, p db.CreateRouteParams) db.UpdateRouteParams {
	return db.UpdateRouteParams{
		ID: id, TenantID: tenantID,
		Name: p.Name, Vertices: p.Vertices, Rotation: p.Rotation, Config: p.Config,
		ZoneID: p.ZoneID, FloorPlanID: p.FloorPlanID, Unit: p.Unit, Visible: p.Visible,
	}
}

func RoutesRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("routes", q,
		func(ctx context.Context, tenantID int64) ([]db.Route, error) { return q.ListRoutes(ctx, tenantID) },
		toRouteResponse,
		q.ListRoutesByZone,
	))
	r.Post("/", shapeCreate("route", q, func(ctx context.Context, p db.CreateRouteParams) (db.Route, error) { return q.CreateRoute(ctx, p) }, routeParams, toRouteResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("route", q, func(ctx context.Context, id, tenantID int64) (db.Route, error) {
			return q.GetRoute(ctx, db.GetRouteParams{ID: id, TenantID: tenantID})
		}, toRouteResponse))
		r.Patch("/", shapeUpdate("route", q, func(ctx context.Context, p db.UpdateRouteParams) (db.Route, error) { return q.UpdateRoute(ctx, p) }, func(ctx context.Context, id, tenantID int64) (db.Route, error) {
			return q.GetRoute(ctx, db.GetRouteParams{ID: id, TenantID: tenantID})
		}, routeParams, toRouteResponse, toUpdateRouteParams))
		r.Delete("/", shapeDelete("route", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteRoute(ctx, db.DeleteRouteParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
