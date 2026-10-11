package handlers

import (
	"context"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DoorRequest is the JSON body for creating or updating a door shape.
// Vertices is a 2-element array: [[lng,lat],[lng,lat]] where the two
// entries are the v0 / v1 jamb anchors that define the opening width
// and heading.
type DoorRequest struct {
	Name        string          `json:"name" validate:"required"`
	Vertices    json.RawMessage `json:"vertices"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
}

func toDoorResponse(row db.Door) any {
	return baseShapeResponse(row.ID, row.TenantID, row.Name, row.Vertices, row.Rotation, row.Config, row.ZoneID, row.FloorPlanID, row.Unit, row.Visible, row.CreatedAt, row.UpdatedAt)
}

func doorParams(req DoorRequest, tenantID int64) db.CreateDoorParams {
	p := db.CreateDoorParams{
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

func toUpdateDoorParams(id, tenantID int64, p db.CreateDoorParams) db.UpdateDoorParams {
	return db.UpdateDoorParams{
		ID: id, TenantID: tenantID,
		Name: p.Name, Vertices: p.Vertices, Rotation: p.Rotation, Config: p.Config,
		ZoneID: p.ZoneID, FloorPlanID: p.FloorPlanID, Unit: p.Unit, Visible: p.Visible,
	}
}

func DoorsRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("doors", q,
		func(ctx context.Context, tenantID int64) ([]db.Door, error) { return q.ListDoors(ctx, tenantID) },
		toDoorResponse,
		q.ListDoorsByZone,
	))
	r.Post("/", shapeCreate("door", q, func(ctx context.Context, p db.CreateDoorParams) (db.Door, error) { return q.CreateDoor(ctx, p) }, doorParams, toDoorResponse))
	r.Post("/bulk", shapeBulkCreate("door", q, pool, func(tq *db.Queries) func(context.Context, db.CreateDoorParams) (db.Door, error) {
		return tq.CreateDoor
	}, doorParams, toDoorResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("door", q, func(ctx context.Context, id, tenantID int64) (db.Door, error) {
			return q.GetDoor(ctx, db.GetDoorParams{ID: id, TenantID: tenantID})
		}, toDoorResponse))
		r.Patch("/", shapeUpdate("door", q, func(ctx context.Context, p db.UpdateDoorParams) (db.Door, error) { return q.UpdateDoor(ctx, p) }, func(ctx context.Context, id, tenantID int64) (db.Door, error) {
			return q.GetDoor(ctx, db.GetDoorParams{ID: id, TenantID: tenantID})
		}, doorParams, toDoorResponse, toUpdateDoorParams))
		r.Delete("/", shapeDelete("door", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteDoor(ctx, db.DeleteDoorParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
