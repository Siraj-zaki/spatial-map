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

// PolygonRequest is the JSON body for creating or updating a polygon.
type PolygonRequest struct {
	Name        string          `json:"name" validate:"required"`
	Vertices    json.RawMessage `json:"vertices"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
	// Role is a key from the host warehouse's `roleVocabulary.polygon`
	// list (e.g. "office", "loading"). Pointer so the client can send
	// `null` to clear it; absent JSON field also clears.
	Role *string `json:"role"`
}

// PolygonResponse is the JSON representation returned by the API.
type PolygonResponse struct {
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
	Role        *string         `json:"role,omitempty"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func toPolygonResponse(row db.Polygon) any {
	resp := PolygonResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		Name:      row.Name,
		Vertices:  row.Vertices,
		Rotation:  row.Rotation,
		Config:    row.Config,
		Unit:      row.Unit,
		Visible:   row.Visible,
		CreatedAt: api.FormatTime(row.CreatedAt),
		UpdatedAt: api.FormatTime(row.UpdatedAt),
	}
	if row.ZoneID.Valid {
		v := row.ZoneID.Int64
		resp.ZoneID = &v
	}
	if row.FloorPlanID.Valid {
		v := row.FloorPlanID.Int64
		resp.FloorPlanID = &v
	}
	if row.Role.Valid {
		v := row.Role.String
		resp.Role = &v
	}
	return resp
}

func polygonParams(req PolygonRequest, tenantID int64) db.CreatePolygonParams {
	config := req.Config
	if len(config) == 0 {
		config = json.RawMessage("{}")
	}
	vertices := req.Vertices
	if len(vertices) == 0 {
		vertices = json.RawMessage("[]")
	}
	p := db.CreatePolygonParams{
		TenantID: tenantID,
		Name:     req.Name,
		Vertices: vertices,
		Rotation: req.Rotation,
		Config:   config,
		Unit:     req.Unit,
		Visible:  req.Visible,
	}
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

func toUpdatePolygonParams(id, tenantID int64, p db.CreatePolygonParams) db.UpdatePolygonParams {
	return db.UpdatePolygonParams{
		ID:          id,
		TenantID:    tenantID,
		Name:        p.Name,
		Vertices:    p.Vertices,
		Rotation:    p.Rotation,
		Config:      p.Config,
		ZoneID:      p.ZoneID,
		FloorPlanID: p.FloorPlanID,
		Unit:        p.Unit,
		Visible:     p.Visible,
		Role:        p.Role,
	}
}

func PolygonsRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("polygons", q,
		func(ctx context.Context, tenantID int64) ([]db.Polygon, error) { return q.ListPolygons(ctx, tenantID) },
		toPolygonResponse,
		q.ListPolygonsByZone,
	))
	r.Post("/", shapeCreate("polygon", q, func(ctx context.Context, p db.CreatePolygonParams) (db.Polygon, error) {
		return q.CreatePolygon(ctx, p)
	}, polygonParams, toPolygonResponse))
	r.Post("/bulk", shapeBulkCreate("polygon", q, pool, func(tq *db.Queries) func(context.Context, db.CreatePolygonParams) (db.Polygon, error) {
		return tq.CreatePolygon
	}, polygonParams, toPolygonResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("polygon", q, func(ctx context.Context, id, tenantID int64) (db.Polygon, error) {
			return q.GetPolygon(ctx, db.GetPolygonParams{ID: id, TenantID: tenantID})
		}, toPolygonResponse))
		r.Patch("/", shapeUpdate("polygon", q, func(ctx context.Context, p db.UpdatePolygonParams) (db.Polygon, error) {
			return q.UpdatePolygon(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.Polygon, error) {
			return q.GetPolygon(ctx, db.GetPolygonParams{ID: id, TenantID: tenantID})
		}, polygonParams, toPolygonResponse, toUpdatePolygonParams))
		r.Delete("/", shapeDelete("polygon", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeletePolygon(ctx, db.DeletePolygonParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
