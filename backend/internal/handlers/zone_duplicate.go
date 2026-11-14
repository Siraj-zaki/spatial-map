package handlers

import (
	"net/http"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DuplicateZoneRequest is the body for POST /zones/{id}/duplicate. `Name`
// and `Color` are required — everything else is copied from the source
// warehouse. The new warehouse gets a fresh (empty) share token so the
// duplicate isn't accidentally reachable via the source's /share/:token
// URL until the user explicitly re-shares it.
type DuplicateZoneRequest struct {
	Name  string `json:"name" validate:"required"`
	Color string `json:"color" validate:"required"`
}

// duplicateZone deep-copies a warehouse inside its workspace through the
// shared clone engine (workspace_clone.go — the same code a cross-workspace copy
// uses, so both copy the same tables and rewrite the same references):
// floor plans, grids, every shape kind, bins, per-warehouse attribute
// definitions, style rules, data sources with their fields, streams and
// data links. Row data, history, reports, alert rules and solutions are not
// copied; the facility report set is created fresh. Workspace-level rows
// (user models, workspace sources and style rules) are shared, not copied.
// One transaction — either the whole warehouse duplicates or none of it.
func duplicateZone(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		sourceID, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		src, err := q.GetZone(r.Context(), db.GetZoneParams{ID: sourceID, TenantID: tenantID})
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "zone not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}

		var req DuplicateZoneRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		ctx := r.Context()
		tx, err := pool.Begin(ctx)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(ctx)

		res, err := cloneFacilities(ctx, tx, q.WithTx(tx), cloneOptions{
			SrcTenant: tenantID, DstTenant: tenantID, ZoneIDs: []int64{src.ID},
			ZoneName: req.Name, ZoneColor: req.Color,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			api.InternalError(w, r, err)
			return
		}

		newZone, err := q.GetZone(ctx, db.GetZoneParams{ID: res.ZoneMap[src.ID], TenantID: tenantID})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		createFacilityReports(r, q, tenantID, newZone.ID)
		api.JSON(w, http.StatusCreated, toZoneResponse(db.CreateZoneRow(newZone)))
		BroadcastEntityEvent("ENTITY_CREATED", "zones", newZone.ID, tenantID)
	}
}
