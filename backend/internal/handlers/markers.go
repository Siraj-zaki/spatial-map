package handlers

import (
	"context"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type MarkerRequest struct {
	Name        string          `json:"name" validate:"required"`
	Position    [2]float64      `json:"position"`
	Bearing     float64         `json:"bearing"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
}

type MarkerResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Position    [2]float64      `json:"position"`
	Bearing     float64         `json:"bearing"`
	Config      json.RawMessage `json:"config,omitempty"`
	ZoneID      *int64          `json:"zoneId,omitempty"`
	FloorPlanID *int64          `json:"floorPlanId,omitempty"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func toMarkerResponse(row db.Marker) any {
	resp := MarkerResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		Name:      row.Name,
		Position:  [2]float64{row.Lng, row.Lat},
		Bearing:   row.Bearing,
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

func markerParams(req MarkerRequest, tenantID int64) db.CreateMarkerParams {
	p := db.CreateMarkerParams{
		TenantID: tenantID,
		Name:     req.Name,
		Lng:      req.Position[0],
		Lat:      req.Position[1],
		Bearing:  req.Bearing,
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

func toUpdateMarkerParams(id, tenantID int64, p db.CreateMarkerParams) db.UpdateMarkerParams {
	return db.UpdateMarkerParams{
		ID: id, TenantID: tenantID,
		Name: p.Name, Lng: p.Lng, Lat: p.Lat, Bearing: p.Bearing, Config: p.Config,
		ZoneID: p.ZoneID, FloorPlanID: p.FloorPlanID, Unit: p.Unit, Visible: p.Visible,
	}
}

func MarkersRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("markers", q,
		func(ctx context.Context, tenantID int64) ([]db.Marker, error) { return q.ListMarkers(ctx, tenantID) },
		toMarkerResponse,
		q.ListMarkersByZone,
	))
	r.Post("/", shapeCreate("marker", q, func(ctx context.Context, p db.CreateMarkerParams) (db.Marker, error) { return q.CreateMarker(ctx, p) }, markerParams, toMarkerResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("marker", q, func(ctx context.Context, id, tenantID int64) (db.Marker, error) {
			return q.GetMarker(ctx, db.GetMarkerParams{ID: id, TenantID: tenantID})
		}, toMarkerResponse))
		r.Patch("/", shapeUpdate("marker", q, func(ctx context.Context, p db.UpdateMarkerParams) (db.Marker, error) { return q.UpdateMarker(ctx, p) }, func(ctx context.Context, id, tenantID int64) (db.Marker, error) {
			return q.GetMarker(ctx, db.GetMarkerParams{ID: id, TenantID: tenantID})
		}, markerParams, toMarkerResponse, toUpdateMarkerParams))
		r.Delete("/", shapeDelete("marker", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteMarker(ctx, db.DeleteMarkerParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
