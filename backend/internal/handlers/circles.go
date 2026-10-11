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

type CircleRequest struct {
	Name        string          `json:"name" validate:"required"`
	Mode        string          `json:"mode" validate:"required"`
	Center      *[2]float64     `json:"center"`
	Radius      *float64        `json:"radius"`
	Start       *[2]float64     `json:"start"`
	Current     *[2]float64     `json:"current"`
	CellRadius  *float64        `json:"cellRadius"`
	CellSize    *float64        `json:"cellSize"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
	// Role is a key from the host warehouse's `roleVocabulary.circle`
	// list. See PolygonRequest.Role for semantics.
	Role *string `json:"role"`
}

type CircleResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Mode        string          `json:"mode"`
	Center      *[2]float64     `json:"center,omitempty"`
	Radius      *float64        `json:"radius,omitempty"`
	Start       *[2]float64     `json:"start,omitempty"`
	Current     *[2]float64     `json:"current,omitempty"`
	CellRadius  *float64        `json:"cellRadius,omitempty"`
	CellSize    *float64        `json:"cellSize,omitempty"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config,omitempty"`
	ZoneID      *int64          `json:"zoneId,omitempty"`
	FloorPlanID *int64          `json:"floorPlanId,omitempty"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
	Role        *string         `json:"role,omitempty"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func toCircleResponse(row db.Circle) any {
	resp := CircleResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		Name:      row.Name,
		Mode:      row.Mode,
		Rotation:  row.Rotation,
		Config:    row.Config,
		Unit:      row.Unit,
		Visible:   row.Visible,
		CreatedAt: api.FormatTime(row.CreatedAt),
		UpdatedAt: api.FormatTime(row.UpdatedAt),
	}
	setPositionPtr(&resp.Center, row.CenterLng, row.CenterLat)
	setFloatPtr(&resp.Radius, row.Radius)
	setPositionPtr(&resp.Start, row.StartLng, row.StartLat)
	setPositionPtr(&resp.Current, row.CurrentLng, row.CurrentLat)
	setFloatPtr(&resp.CellRadius, row.CellRadius)
	setFloatPtr(&resp.CellSize, row.CellSize)
	setInt64Ptr(&resp.ZoneID, row.ZoneID)
	setInt64Ptr(&resp.FloorPlanID, row.FloorPlanID)
	if row.Role.Valid {
		v := row.Role.String
		resp.Role = &v
	}
	return resp
}

func circleParams(req CircleRequest, tenantID int64) db.CreateCircleParams {
	config := req.Config
	if len(config) == 0 {
		config = json.RawMessage("{}")
	}
	p := db.CreateCircleParams{
		TenantID: tenantID,
		Name:     req.Name,
		Mode:     req.Mode,
		Rotation: req.Rotation,
		Config:   config,
		Unit:     req.Unit,
		Visible:  req.Visible,
	}
	setPositionParam(&p.CenterLng, &p.CenterLat, req.Center)
	setFloatParam(&p.Radius, req.Radius)
	setPositionParam(&p.StartLng, &p.StartLat, req.Start)
	setPositionParam(&p.CurrentLng, &p.CurrentLat, req.Current)
	setFloatParam(&p.CellRadius, req.CellRadius)
	setFloatParam(&p.CellSize, req.CellSize)
	if req.ZoneID != nil {
		p.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	if req.FloorPlanID != nil {
		p.FloorPlanID = pgtype.Int8{Int64: *req.FloorPlanID, Valid: true}
	}
	if req.Role != nil && *req.Role != "" {
		p.Role = pgtype.Text{String: *req.Role, Valid: true}
	}
	return p
}

func toUpdateCircleParams(id, tenantID int64, p db.CreateCircleParams) db.UpdateCircleParams {
	return db.UpdateCircleParams{
		ID:          id,
		TenantID:    tenantID,
		Name:        p.Name,
		Mode:        p.Mode,
		CenterLng:   p.CenterLng,
		CenterLat:   p.CenterLat,
		Radius:      p.Radius,
		StartLng:    p.StartLng,
		StartLat:    p.StartLat,
		CurrentLng:  p.CurrentLng,
		CurrentLat:  p.CurrentLat,
		CellRadius:  p.CellRadius,
		CellSize:    p.CellSize,
		Rotation:    p.Rotation,
		Config:      p.Config,
		ZoneID:      p.ZoneID,
		FloorPlanID: p.FloorPlanID,
		Unit:        p.Unit,
		Visible:     p.Visible,
		Role:        p.Role,
	}
}

func CirclesRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("circles", q,
		func(ctx context.Context, tenantID int64) ([]db.Circle, error) { return q.ListCircles(ctx, tenantID) },
		toCircleResponse,
		q.ListCirclesByZone,
	))
	r.Post("/", shapeCreate("circle", q, func(ctx context.Context, p db.CreateCircleParams) (db.Circle, error) { return q.CreateCircle(ctx, p) }, circleParams, toCircleResponse))
	r.Post("/bulk", shapeBulkCreate("circle", q, pool, func(tq *db.Queries) func(context.Context, db.CreateCircleParams) (db.Circle, error) {
		return tq.CreateCircle
	}, circleParams, toCircleResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("circle", q, func(ctx context.Context, id, tenantID int64) (db.Circle, error) {
			return q.GetCircle(ctx, db.GetCircleParams{ID: id, TenantID: tenantID})
		}, toCircleResponse))
		r.Patch("/", shapeUpdate("circle", q, func(ctx context.Context, p db.UpdateCircleParams) (db.Circle, error) { return q.UpdateCircle(ctx, p) }, func(ctx context.Context, id, tenantID int64) (db.Circle, error) {
			return q.GetCircle(ctx, db.GetCircleParams{ID: id, TenantID: tenantID})
		}, circleParams, toCircleResponse, toUpdateCircleParams))
		r.Delete("/", shapeDelete("circle", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteCircle(ctx, db.DeleteCircleParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}

func setPositionPtr(dst **[2]float64, lng, lat pgtype.Float8) {
	if lng.Valid && lat.Valid {
		v := [2]float64{lng.Float64, lat.Float64}
		*dst = &v
	}
}

func setPositionParam(lngDst, latDst *pgtype.Float8, src *[2]float64) {
	if src != nil {
		lngDst.Valid = true
		lngDst.Float64 = (*src)[0]
		latDst.Valid = true
		latDst.Float64 = (*src)[1]
	}
}
