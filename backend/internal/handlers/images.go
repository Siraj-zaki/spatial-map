package handlers

import (
	"context"
	"encoding/json"
	"image"
	"net/http"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type ImageRequest struct {
	Name          string          `json:"name" validate:"required"`
	Start         [2]float64      `json:"start"`
	Current       [2]float64      `json:"current"`
	Rotation      float64         `json:"rotation"`
	ImageUrl      string          `json:"imageUrl"`
	ImageData     string          `json:"imageData"`
	MimeType      string          `json:"mimeType" validate:"required"`
	NaturalWidth  int32           `json:"naturalWidth"`
	NaturalHeight int32           `json:"naturalHeight"`
	Config        json.RawMessage `json:"config"`
	ZoneID        *int64          `json:"zoneId"`
	FloorPlanID   *int64          `json:"floorPlanId"`
	Unit          string          `json:"unit"`
	Visible       bool            `json:"visible"`
}

type ImageResponse struct {
	ID            int64           `json:"id"`
	TenantID      int64           `json:"tenantId"`
	Name          string          `json:"name"`
	Start         [2]float64      `json:"start"`
	Current       [2]float64      `json:"current"`
	Rotation      float64         `json:"rotation"`
	ImageUrl      string          `json:"imageUrl"`
	ImageData     string          `json:"imageData,omitempty"`
	MimeType      string          `json:"mimeType"`
	NaturalWidth  int32           `json:"naturalWidth"`
	NaturalHeight int32           `json:"naturalHeight"`
	Config        json.RawMessage `json:"config,omitempty"`
	ZoneID        *int64          `json:"zoneId,omitempty"`
	FloorPlanID   *int64          `json:"floorPlanId,omitempty"`
	Unit          string          `json:"unit"`
	Visible       bool            `json:"visible"`
	CreatedAt     string          `json:"createdAt"`
	UpdatedAt     string          `json:"updatedAt"`
}

func toImageResponse(row db.Image) any {
	resp := ImageResponse{
		ID:            row.ID,
		TenantID:      row.TenantID,
		Name:          row.Name,
		Start:         [2]float64{row.StartLng, row.StartLat},
		Current:       [2]float64{row.CurrentLng, row.CurrentLat},
		Rotation:      row.Rotation,
		ImageUrl:      row.ImageUrl,
		MimeType:      row.MimeType,
		NaturalWidth:  row.NaturalWidth,
		NaturalHeight: row.NaturalHeight,
		Config:        row.Config,
		Unit:          row.Unit,
		Visible:       row.Visible,
		CreatedAt:     api.FormatTime(row.CreatedAt),
		UpdatedAt:     api.FormatTime(row.UpdatedAt),
	}
	if row.ImageData.Valid {
		resp.ImageData = row.ImageData.String
	}
	setInt64Ptr(&resp.ZoneID, row.ZoneID)
	setInt64Ptr(&resp.FloorPlanID, row.FloorPlanID)
	return resp
}

func imageParams(req ImageRequest, tenantID int64) db.CreateImageParams {
	p := db.CreateImageParams{
		TenantID:      tenantID,
		Name:          req.Name,
		StartLng:      req.Start[0],
		StartLat:      req.Start[1],
		CurrentLng:    req.Current[0],
		CurrentLat:    req.Current[1],
		Rotation:      req.Rotation,
		ImageUrl:      store.NormalizeAssetURL(req.ImageUrl),
		ImageData:     pgtype.Text{String: req.ImageData, Valid: req.ImageData != ""},
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

func toUpdateImageParams(id, tenantID int64, p db.CreateImageParams) db.UpdateImageParams {
	return db.UpdateImageParams{
		ID:            id,
		TenantID:      tenantID,
		Name:          p.Name,
		StartLng:      p.StartLng,
		StartLat:      p.StartLat,
		CurrentLng:    p.CurrentLng,
		CurrentLat:    p.CurrentLat,
		Rotation:      p.Rotation,
		ImageUrl:      p.ImageUrl,
		ImageData:     p.ImageData,
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

// decodeDataURL extracts the base64 payload from a data URL such as
// data:image/png;base64,iVBORw0KGgo=...
func decodeDataURL(dataURL string) ([]byte, string, bool) {
	if !strings.HasPrefix(dataURL, "data:") {
		return nil, "", false
	}
	idx := strings.Index(dataURL, ";")
	if idx == -1 {
		return nil, "", false
	}
	mimeType := dataURL[5:idx]
	rest := dataURL[idx:]
	if !strings.HasPrefix(rest, ";base64,") {
		return nil, "", false
	}
	payload := rest[len(";base64,"):]
	decoded, err := base64Decode(payload)
	if err != nil {
		return nil, "", false
	}
	return decoded, mimeType, true
}

func imageDimensions(data []byte) (width, height int32) {
	cfg, _, err := image.DecodeConfig(dataReader(data))
	if err != nil {
		return 0, 0
	}
	return int32(cfg.Width), int32(cfg.Height)
}

func uploadImage(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		file, header, err := r.FormFile("file")
		if err != nil {
			api.BadRequest(w, "missing file")
			return
		}
		defer file.Close()

		data, err := store.ReadAll(file)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		key := store.KeyFromData(header.Filename, data)
		if err := s.Put(r.Context(), key, header.Header.Get("Content-Type"), data); err != nil {
			api.InternalError(w, r, err)
			return
		}
		recordTenantFile(r, q, key, header.Header.Get("Content-Type"), len(data))

		width, height := imageDimensions(data)
		api.JSON(w, http.StatusCreated, map[string]any{
			"url":           store.NormalizeAssetURL(s.URL(key)),
			"mimeType":      header.Header.Get("Content-Type"),
			"naturalWidth":  width,
			"naturalHeight": height,
			"bytes":         int64(len(data)),
		})
	}
}

func ImagesRouter(q *db.Queries, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("images", q,
		func(ctx context.Context, tenantID int64) ([]db.Image, error) { return q.ListImages(ctx, tenantID) },
		toImageResponse,
		q.ListImagesByZone,
	))
	r.Post("/", shapeCreate("image", q, func(ctx context.Context, p db.CreateImageParams) (db.Image, error) { return q.CreateImage(ctx, p) }, imageParams, toImageResponse))
	r.Post("/upload", uploadImage(q, s))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("image", q, func(ctx context.Context, id, tenantID int64) (db.Image, error) {
			return q.GetImage(ctx, db.GetImageParams{ID: id, TenantID: tenantID})
		}, toImageResponse))
		r.Patch("/", shapeUpdate("image", q, func(ctx context.Context, p db.UpdateImageParams) (db.Image, error) { return q.UpdateImage(ctx, p) }, func(ctx context.Context, id, tenantID int64) (db.Image, error) {
			return q.GetImage(ctx, db.GetImageParams{ID: id, TenantID: tenantID})
		}, imageParams, toImageResponse, toUpdateImageParams))
		r.Delete("/", shapeDeleteWithFile("image", q, s,
			func(ctx context.Context, id, tenantID int64) ([]string, error) {
				row, err := q.GetImage(ctx, db.GetImageParams{ID: id, TenantID: tenantID})
				if err != nil {
					return nil, err
				}
				if row.ImageUrl == "" {
					return nil, nil
				}
				return []string{row.ImageUrl}, nil
			},
			func(ctx context.Context, id, tenantID int64) error {
				return q.DeleteImage(ctx, db.DeleteImageParams{ID: id, TenantID: tenantID})
			},
		))
	})
	return r
}
