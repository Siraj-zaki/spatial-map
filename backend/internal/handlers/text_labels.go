package handlers

import (
	"context"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type TextLabelRequest struct {
	Name        string          `json:"name" validate:"required"`
	Position    [2]float64      `json:"position"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config"`
	ZoneID      *int64          `json:"zoneId"`
	FloorPlanID *int64          `json:"floorPlanId"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
}

type TextLabelResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Position    [2]float64      `json:"position"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config,omitempty"`
	ZoneID      *int64          `json:"zoneId,omitempty"`
	FloorPlanID *int64          `json:"floorPlanId,omitempty"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func toTextLabelResponse(row db.TextLabel) any {
	resp := TextLabelResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		Name:      row.Name,
		Position:  [2]float64{row.Lng, row.Lat},
		Rotation:  row.Rotation,
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

func textLabelParams(req TextLabelRequest, tenantID int64) db.CreateTextLabelParams {
	p := db.CreateTextLabelParams{
		TenantID: tenantID,
		Name:     req.Name,
		Lng:      req.Position[0],
		Lat:      req.Position[1],
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

func toUpdateTextLabelParams(id, tenantID int64, p db.CreateTextLabelParams) db.UpdateTextLabelParams {
	return db.UpdateTextLabelParams{
		ID: id, TenantID: tenantID,
		Name: p.Name, Lng: p.Lng, Lat: p.Lat, Rotation: p.Rotation, Config: p.Config,
		ZoneID: p.ZoneID, FloorPlanID: p.FloorPlanID, Unit: p.Unit, Visible: p.Visible,
	}
}

func TextLabelsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("text_labels", q,
		func(ctx context.Context, tenantID int64) ([]db.TextLabel, error) {
			return q.ListTextLabels(ctx, tenantID)
		},
		toTextLabelResponse,
		q.ListTextLabelsByZone,
	))
	r.Post("/", shapeCreate("text_label", q, func(ctx context.Context, p db.CreateTextLabelParams) (db.TextLabel, error) {
		return q.CreateTextLabel(ctx, p)
	}, textLabelParams, toTextLabelResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("text_label", q, func(ctx context.Context, id, tenantID int64) (db.TextLabel, error) {
			return q.GetTextLabel(ctx, db.GetTextLabelParams{ID: id, TenantID: tenantID})
		}, toTextLabelResponse))
		r.Patch("/", shapeUpdate("text_label", q, func(ctx context.Context, p db.UpdateTextLabelParams) (db.TextLabel, error) {
			return q.UpdateTextLabel(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.TextLabel, error) {
			return q.GetTextLabel(ctx, db.GetTextLabelParams{ID: id, TenantID: tenantID})
		}, textLabelParams, toTextLabelResponse, toUpdateTextLabelParams))
		r.Delete("/", shapeDelete("text_label", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteTextLabel(ctx, db.DeleteTextLabelParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
