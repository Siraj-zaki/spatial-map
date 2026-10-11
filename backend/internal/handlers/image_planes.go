package handlers

import (
	"context"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// ImagePlaneRequest is the JSON body for creating / updating an image
// plane. Mirrors `ModelRequest` plus image-specific fields. The 3D
// transform (elevation, rotation, scale, etc.) lives inside `config`
// so the contract stays open-ended; the frontend's `ImagePlaneConfig`
// dictates the schema.
type ImagePlaneRequest struct {
	Name          string          `json:"name" validate:"required"`
	Position      [2]float64      `json:"position"`
	ImageURL      string          `json:"imageUrl"`
	MimeType      string          `json:"mimeType"`
	NaturalWidth  int32           `json:"naturalWidth"`
	NaturalHeight int32           `json:"naturalHeight"`
	Config        json.RawMessage `json:"config"`
	ZoneID        *int64          `json:"zoneId"`
	FloorPlanID   *int64          `json:"floorPlanId"`
	Unit          string          `json:"unit"`
	Visible       bool            `json:"visible"`
}

type ImagePlaneResponse struct {
	ID            int64           `json:"id"`
	TenantID      int64           `json:"tenantId"`
	Name          string          `json:"name"`
	Position      [2]float64      `json:"position"`
	ImageURL      string          `json:"imageUrl"`
	MimeType      string          `json:"mimeType,omitempty"`
	NaturalWidth  int32           `json:"naturalWidth,omitempty"`
	NaturalHeight int32           `json:"naturalHeight,omitempty"`
	Config        json.RawMessage `json:"config,omitempty"`
	ZoneID        *int64          `json:"zoneId,omitempty"`
	FloorPlanID   *int64          `json:"floorPlanId,omitempty"`
	Unit          string          `json:"unit"`
	Visible       bool            `json:"visible"`
	CreatedAt     string          `json:"createdAt"`
	UpdatedAt     string          `json:"updatedAt"`
}

func toImagePlaneResponse(row db.ImagePlane) any {
	resp := ImagePlaneResponse{
		ID:            row.ID,
		TenantID:      row.TenantID,
		Name:          row.Name,
		Position:      [2]float64{row.Lng, row.Lat},
		ImageURL:      row.ImageUrl,
		MimeType:      row.MimeType,
		NaturalWidth:  row.NaturalWidth,
		NaturalHeight: row.NaturalHeight,
		Config:        row.Config,
		Unit:          row.Unit,
		Visible:       row.Visible,
		CreatedAt:     api.FormatTime(row.CreatedAt),
		UpdatedAt:     api.FormatTime(row.UpdatedAt),
	}
	setInt64Ptr(&resp.ZoneID, row.ZoneID)
	setInt64Ptr(&resp.FloorPlanID, row.FloorPlanID)
	return resp
}

func imagePlaneParams(req ImagePlaneRequest, tenantID int64) db.CreateImagePlaneParams {
	p := db.CreateImagePlaneParams{
		TenantID:      tenantID,
		Name:          req.Name,
		Lng:           req.Position[0],
		Lat:           req.Position[1],
		ImageUrl:      store.NormalizeAssetURL(req.ImageURL),
		MimeType:      req.MimeType,
		NaturalWidth:  req.NaturalWidth,
		NaturalHeight: req.NaturalHeight,
		Config:        defaultJSONObject(req.Config),
		Unit:          req.Unit,
		Visible:       req.Visible,
	}
	if req.ZoneID != nil {
		p.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	if req.FloorPlanID != nil {
		p.FloorPlanID = pgtype.Int8{Int64: *req.FloorPlanID, Valid: true}
	}
	return p
}

func toUpdateImagePlaneParams(id, tenantID int64, p db.CreateImagePlaneParams) db.UpdateImagePlaneParams {
	return db.UpdateImagePlaneParams{
		ID:            id,
		TenantID:      tenantID,
		Name:          p.Name,
		Lng:           p.Lng,
		Lat:           p.Lat,
		ImageUrl:      p.ImageUrl,
		MimeType:      p.MimeType,
		NaturalWidth:  p.NaturalWidth,
		NaturalHeight: p.NaturalHeight,
		Config:        p.Config,
		ZoneID:        p.ZoneID,
		FloorPlanID:   p.FloorPlanID,
		Unit:          p.Unit,
		Visible:       p.Visible,
	}
}

func ImagePlanesRouter(q *db.Queries, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("image-planes", q,
		func(ctx context.Context, tenantID int64) ([]db.ImagePlane, error) {
			return q.ListImagePlanes(ctx, tenantID)
		},
		toImagePlaneResponse,
		q.ListImagePlanesByZone,
	))
	r.Post("/", shapeCreate("image-plane", q, func(ctx context.Context, p db.CreateImagePlaneParams) (db.ImagePlane, error) {
		return q.CreateImagePlane(ctx, p)
	}, imagePlaneParams, toImagePlaneResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("image-plane", q, func(ctx context.Context, id, tenantID int64) (db.ImagePlane, error) {
			return q.GetImagePlane(ctx, db.GetImagePlaneParams{ID: id, TenantID: tenantID})
		}, toImagePlaneResponse))
		r.Patch("/", shapeUpdate("image-plane", q, func(ctx context.Context, p db.UpdateImagePlaneParams) (db.ImagePlane, error) {
			return q.UpdateImagePlane(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.ImagePlane, error) {
			return q.GetImagePlane(ctx, db.GetImagePlaneParams{ID: id, TenantID: tenantID})
		}, imagePlaneParams, toImagePlaneResponse, toUpdateImagePlaneParams))
		r.Delete("/", shapeDeleteWithFile("image-plane", q, s,
			func(ctx context.Context, id, tenantID int64) ([]string, error) {
				row, err := q.GetImagePlane(ctx, db.GetImagePlaneParams{ID: id, TenantID: tenantID})
				if err != nil {
					return nil, err
				}
				if row.ImageUrl == "" {
					return nil, nil
				}
				return []string{row.ImageUrl}, nil
			},
			func(ctx context.Context, id, tenantID int64) error {
				return q.DeleteImagePlane(ctx, db.DeleteImagePlaneParams{ID: id, TenantID: tenantID})
			},
		))
	})
	return r
}
