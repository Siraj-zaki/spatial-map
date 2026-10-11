// Package handlers — data_links.go
//
// CRUD for `data_link_configs` (see DESIGN-data-link.md). Each row
// binds one Stream to one map object in one warehouse and carries the
// user-picked visual + tooltip + style-rule config the generic
// MapDataLinkedOverlay renders from.
//
// Contract mirrors the other tenant-scoped catalog routes: `X-Api-Key`
// + `X-Tenant-Id` middleware runs upstream; the routes themselves just
// dispatch to the sqlc-generated queries.
package handlers

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// DataLinkConfigRequest — JSON body for POST + PATCH.
//
// The visual + tooltip + style bags are `json.RawMessage` because
// their schema evolves alongside the frontend; the backend has no
// business inspecting individual keys. See TS `DataLinkConfig` for
// the current shape.
type DataLinkConfigRequest struct {
	ZoneID int64 `json:"zoneId" validate:"required"`
	// The paired `required_without` tags mean "at least one of stream or
	// source". StreamID stopped being unconditionally required in
	// migration 0034: a `kind='table'` source has no mirror stream, so the
	// SPA sends 0 and dataLinkConfigParams maps that to NULL.
	StreamID int64 `json:"streamId" validate:"required_without=SourceID"`
	// v3 — a layer's canonical source. Nullable during migration; when
	// unset, sub-renderers fall back to the streams → entity_states
	// legacy read path. See DESIGN-integrations-v3.md §3.3.
	SourceID      *int64          `json:"sourceId" validate:"required_without=StreamID"`
	Name          string          `json:"name" validate:"required"`
	TargetKind    string          `json:"targetKind" validate:"required"`
	TargetShapeID *int64          `json:"targetShapeId"`
	RenderMode    string          `json:"renderMode" validate:"required"`
	FieldMapping  json.RawMessage `json:"fieldMapping"`
	Style         json.RawMessage `json:"style"`
	Tooltip       json.RawMessage `json:"tooltip"`
	StyleRuleIDs  []int64         `json:"styleRuleIds"`
	Enabled       *bool           `json:"enabled"`
}

type DataLinkConfigResponse struct {
	ID            int64           `json:"id"`
	TenantID      int64           `json:"tenantId"`
	ZoneID        int64           `json:"zoneId"`
	StreamID      int64           `json:"streamId"`
	SourceID      *int64          `json:"sourceId,omitempty"`
	Name          string          `json:"name"`
	TargetKind    string          `json:"targetKind"`
	TargetShapeID *int64          `json:"targetShapeId,omitempty"`
	RenderMode    string          `json:"renderMode"`
	FieldMapping  json.RawMessage `json:"fieldMapping,omitempty"`
	Style         json.RawMessage `json:"style,omitempty"`
	Tooltip       json.RawMessage `json:"tooltip,omitempty"`
	StyleRuleIDs  []int64         `json:"styleRuleIds"`
	Enabled       bool            `json:"enabled"`
	CreatedAt     string          `json:"createdAt"`
	UpdatedAt     string          `json:"updatedAt"`
}

func toDataLinkConfigResponse(row db.DataLinkConfig) any {
	resp := DataLinkConfigResponse{
		ID:           row.ID,
		TenantID:     row.TenantID,
		ZoneID:       row.ZoneID,
		Name:         row.Name,
		TargetKind:   row.TargetKind,
		RenderMode:   row.RenderMode,
		FieldMapping: row.FieldMapping,
		Style:        row.Style,
		Tooltip:      row.Tooltip,
		StyleRuleIDs: row.StyleRuleIds,
		Enabled:      row.Enabled,
		CreatedAt:    api.FormatTime(row.CreatedAt),
		UpdatedAt:    api.FormatTime(row.UpdatedAt),
	}
	if row.StreamID.Valid {
		resp.StreamID = row.StreamID.Int64
	}
	setInt64Ptr(&resp.TargetShapeID, row.TargetShapeID)
	setInt64Ptr(&resp.SourceID, row.SourceID)
	return resp
}

// dataLinkConfigParams builds the sqlc-generated create-params from
// the incoming JSON request. Defaults `enabled` to true when the
// client omits it — new bindings should light up immediately.
func dataLinkConfigParams(req DataLinkConfigRequest, tenantID int64) db.CreateDataLinkConfigParams {
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	p := db.CreateDataLinkConfigParams{
		TenantID:     tenantID,
		ZoneID:       req.ZoneID,
		Name:         req.Name,
		TargetKind:   req.TargetKind,
		RenderMode:   req.RenderMode,
		FieldMapping: defaultJSONObject(req.FieldMapping),
		Style:        defaultJSONObject(req.Style),
		Tooltip:      defaultJSONObject(req.Tooltip),
		StyleRuleIds: req.StyleRuleIDs,
		Enabled:      enabled,
	}
	// stream_id is now nullable (migration 0034). The frontend sends 0 when
	// the config targets a table-kind source (no mirror stream), so 0 → NULL.
	if req.StreamID != 0 {
		p.StreamID = pgtype.Int8{Int64: req.StreamID, Valid: true}
	}
	if req.TargetShapeID != nil {
		p.TargetShapeID = pgtype.Int8{Int64: *req.TargetShapeID, Valid: true}
	}
	if req.SourceID != nil {
		p.SourceID = pgtype.Int8{Int64: *req.SourceID, Valid: true}
	}
	return p
}

func toUpdateDataLinkConfigParams(id, tenantID int64, p db.CreateDataLinkConfigParams) db.UpdateDataLinkConfigParams {
	return db.UpdateDataLinkConfigParams{
		ID:            id,
		TenantID:      tenantID,
		ZoneID:        p.ZoneID,
		StreamID:      p.StreamID,
		SourceID:      p.SourceID,
		Name:          p.Name,
		TargetKind:    p.TargetKind,
		TargetShapeID: p.TargetShapeID,
		RenderMode:    p.RenderMode,
		FieldMapping:  p.FieldMapping,
		Style:         p.Style,
		Tooltip:       p.Tooltip,
		StyleRuleIds:  p.StyleRuleIds,
		Enabled:       p.Enabled,
	}
}

// DataLinkConfigsRouter wires CRUD onto `/api/v1/data-links`. Reuses
// the generic shape_crud helpers — same SSE broadcast, same request
// validation, same error envelope as every other catalog route.
func DataLinkConfigsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("data_link_configs", q, func(ctx context.Context, tenantID int64) ([]db.DataLinkConfig, error) {
		return q.ListDataLinkConfigs(ctx, tenantID)
	}, toDataLinkConfigResponse,
		// v5.4 — per-zone filter. `shapeList` verifies the caller
		// owns the zone before calling this, and the SQL query is
		// zone-scoped on its own, so we don't need a redundant
		// tenant check here.
		func(ctx context.Context, zoneID pgtype.Int8) ([]db.DataLinkConfig, error) {
			return q.ListDataLinkConfigsByZone(ctx, zoneID.Int64)
		},
	))
	r.Post("/", shapeCreate("data_link_config", q, func(ctx context.Context, p db.CreateDataLinkConfigParams) (db.DataLinkConfig, error) {
		row, err := q.CreateDataLinkConfig(ctx, p)
		if err == nil && row.SourceID.Valid {
			// The first link to a table gives the facility a report for
			// that table. Best-effort: the link is already saved.
			if _, rerr := reports.CreateDataLinkReports(ctx, q, row.TenantID, row.ZoneID, api.UserID(ctx)); rerr != nil {
				slog.WarnContext(ctx, "create linked-data report failed", "link", row.ID, "error", rerr)
			}
		}
		return row, err
	}, dataLinkConfigParams, toDataLinkConfigResponse))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("data_link_config", q, func(ctx context.Context, id, tenantID int64) (db.DataLinkConfig, error) {
			return q.GetDataLinkConfig(ctx, db.GetDataLinkConfigParams{ID: id, TenantID: tenantID})
		}, toDataLinkConfigResponse))
		r.Patch("/", shapeUpdate("data_link_config", q, func(ctx context.Context, p db.UpdateDataLinkConfigParams) (db.DataLinkConfig, error) {
			return q.UpdateDataLinkConfig(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.DataLinkConfig, error) {
			return q.GetDataLinkConfig(ctx, db.GetDataLinkConfigParams{ID: id, TenantID: tenantID})
		}, dataLinkConfigParams, toDataLinkConfigResponse, toUpdateDataLinkConfigParams))
		r.Delete("/", shapeDelete("data_link_config", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteDataLinkConfig(ctx, db.DeleteDataLinkConfigParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}
