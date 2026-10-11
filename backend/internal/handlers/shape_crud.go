package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// shapeCreate returns a handler that creates a shape and responds with its JSON form.
func shapeCreate[Req any, DBRow any, CreateParams any](
	name string,
	q *db.Queries,
	createFn func(context.Context, CreateParams) (DBRow, error),
	paramsFn func(Req, int64) CreateParams,
	respFn func(DBRow) any,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var req Req
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := createFn(r.Context(), paramsFn(req, tenantID))
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, respFn(row))
		BroadcastEntityEvent("ENTITY_CREATED", sseEntityKind(name), entityID(row), tenantID)
	}
}

// A bulk create exists because the SPA's flush is sequential: one
// createLocal per row becomes one POST per row, in order. That is fine for
// the handful of shapes a person draws and unusable for the thousand a CAD
// import extracts from a floor plan.
const (
	// bulkCreateLimit caps the rows one request may carry. The largest real
	// drawing in the fixture set yields ~1,100 walls, so this leaves room for
	// a much bigger building while keeping the transaction bounded.
	bulkCreateLimit = 10000
	// bulkCreateMaxBytes bounds the body independently of the row count,
	// because a row's vertex list has no length of its own.
	bulkCreateMaxBytes = 32 << 20
)

type bulkCreateRequest[Req any] struct {
	Items []Req `json:"items"`
}

type bulkCreateResponse struct {
	Created int   `json:"created"`
	Items   []any `json:"items"`
}

// shapeBulkCreate returns a handler that creates many shapes of one kind in a
// single transaction, reusing the kind's own params/response functions so no
// kind describes itself twice.
//
// Two properties make it safe to point an importer at. Every item is validated
// before any is written, and the whole run is one transaction — a half-landed
// import is worse than a refused one, because the user cannot tell it apart
// from a clean one and has to audit the drawing by hand to find what is
// missing. And it broadcasts a single kind-wide SSE rather than one event per
// row, so other clients answer a thousand new shapes with one reload.
//
// createFn takes the queries handle rather than being bound to one, so the
// handler can rebind it to the transaction.
func shapeBulkCreate[Req any, DBRow any, CreateParams any](
	name string,
	q *db.Queries,
	pool *pgxpool.Pool,
	createFn func(*db.Queries) func(context.Context, CreateParams) (DBRow, error),
	paramsFn func(Req, int64) CreateParams,
	respFn func(DBRow) any,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tenantID := api.TenantID(ctx)
		r.Body = http.MaxBytesReader(w, r.Body, bulkCreateMaxBytes)

		var req bulkCreateRequest[Req]
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if len(req.Items) == 0 {
			api.BadRequest(w, "items must not be empty")
			return
		}
		if len(req.Items) > bulkCreateLimit {
			api.BadRequest(w, fmt.Sprintf("items holds %d rows, over the limit of %d", len(req.Items), bulkCreateLimit))
			return
		}
		for i := range req.Items {
			if err := api.ValidateStruct(req.Items[i]); err != nil {
				api.BadRequest(w, fmt.Sprintf("items[%d]: %s", i, err))
				return
			}
		}

		tx, err := pool.Begin(ctx)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(ctx)
		create := createFn(q.WithTx(tx))

		out := make([]any, 0, len(req.Items))
		for i := range req.Items {
			row, err := create(ctx, paramsFn(req.Items[i], tenantID))
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			out = append(out, respFn(row))
		}
		if err := tx.Commit(ctx); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, bulkCreateResponse{Created: len(out), Items: out})
		BroadcastEntityKindEvent("ENTITY_CREATED", sseEntityKind(name), tenantID)
	}
}

// shapeGet returns a handler that fetches a single shape.
func shapeGet[DBRow any](
	name string,
	q *db.Queries,
	getFn func(context.Context, int64, int64) (DBRow, error),
	respFn func(DBRow) any,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := getFn(r.Context(), id, tenantID)
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, name+" not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, respFn(row))
	}
}

// shapeList returns a handler that lists shapes for a tenant. When the
// client passes a `?zoneId=<N>` query parameter AND a per-zone list
// function is supplied via the variadic `listByZoneFn`, the handler
// verifies that the zone belongs to the caller's tenant (via GetZone)
// and dispatches to the by-zone list. This lets the editor fetch only
// the shapes for the currently-active warehouse without pulling the
// whole tenant roster and filtering client-side.
//
// Backward-compat: existing call sites that don't provide a by-zone
// function keep working exactly as before — any zoneId param is
// silently ignored and the tenant-scoped list is returned.
func shapeList[DBRow any](
	name string,
	q *db.Queries,
	listFn func(context.Context, int64) ([]DBRow, error),
	respFn func(DBRow) any,
	listByZoneFn ...func(context.Context, pgtype.Int8) ([]DBRow, error),
) http.HandlerFunc {
	var byZone func(context.Context, pgtype.Int8) ([]DBRow, error)
	if len(listByZoneFn) > 0 {
		byZone = listByZoneFn[0]
	}
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var rows []DBRow
		var err error
		if raw := r.URL.Query().Get("zoneId"); raw != "" && byZone != nil {
			zoneID, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil {
				api.BadRequest(w, "invalid zoneId")
				return
			}
			// Tenant-scoped fetch of the zone — 404 if the caller
			// doesn't own it, so a leaked zone id from a different
			// tenant can't be used to enumerate our shapes.
			if _, zerr := q.GetZone(r.Context(), db.GetZoneParams{
				ID:       zoneID,
				TenantID: tenantID,
			}); zerr != nil {
				if zerr == pgx.ErrNoRows {
					api.NotFound(w, "zone not found")
					return
				}
				api.InternalError(w, r, zerr)
				return
			}
			rows, err = byZone(r.Context(), pgtype.Int8{Int64: zoneID, Valid: true})
		} else {
			rows, err = listFn(r.Context(), tenantID)
		}
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp := make([]any, len(rows))
		for i, row := range rows {
			resp[i] = respFn(row)
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

// shapeUpdate returns a handler that updates a shape.
// It supports partial PATCH semantics by fetching the existing row,
// merging only the JSON fields present in the request on top of the
// existing response, and validating the merged result. This lets UI
// interactions (drag, rotate, scale) send only the changed fields without
// resending required fields such as name or mimeType.
func shapeUpdate[Req any, DBRow any, CreateParams any, UpdateParams any](
	name string,
	q *db.Queries,
	updateFn func(context.Context, UpdateParams) (DBRow, error),
	getFn func(context.Context, int64, int64) (DBRow, error),
	paramsFn func(Req, int64) CreateParams,
	respFn func(DBRow) any,
	buildUpdateFn func(id int64, tenantID int64, p CreateParams) UpdateParams,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		// Decode the partial request as a map so missing fields do not
		// become zero-values that would overwrite existing data.
		var reqMap map[string]any
		if err := api.DecodeBody(r, &reqMap); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}

		existing, err := getFn(r.Context(), id, tenantID)
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, name+" not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}

		finalReq, err := mergeRequestWithExisting[Req](reqMap, respFn(existing))
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		if err := api.ValidateStruct(finalReq); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := updateFn(r.Context(), buildUpdateFn(id, tenantID, paramsFn(finalReq, tenantID)))
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, name+" not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, respFn(row))
		BroadcastEntityEvent("ENTITY_UPDATED", sseEntityKind(name), entityID(row), tenantID)
	}
}

// mergeRequestWithExisting overlays the partial request JSON onto the existing
// response so required fields from the original row remain present. Only keys
// explicitly sent by the client are overwritten.
func mergeRequestWithExisting[Req any](reqMap map[string]any, existing any) (Req, error) {
	existingJSON, err := json.Marshal(existing)
	if err != nil {
		var zero Req
		return zero, err
	}

	var merged map[string]any
	if err := json.Unmarshal(existingJSON, &merged); err != nil {
		var zero Req
		return zero, err
	}

	for k, v := range reqMap {
		merged[k] = v
	}

	mergedJSON, err := json.Marshal(merged)
	if err != nil {
		var zero Req
		return zero, err
	}

	var final Req
	if err := json.Unmarshal(mergedJSON, &final); err != nil {
		var zero Req
		return zero, err
	}
	return final, nil
}

// shapeDelete returns a handler that deletes a shape.
func shapeDelete(
	name string,
	q *db.Queries,
	deleteFn func(context.Context, int64, int64) error,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := deleteFn(r.Context(), id, tenantID); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_DELETED", sseEntityKind(name), id, tenantID)
	}
}

// shapeDeleteWithFile is the delete variant for shape kinds that own an
// object-store file (images, image_planes, user_models). It fetches the
// file URL(s) BEFORE the DB delete — otherwise the row is gone and we
// have no way to know which key to reclaim — then delegates to
// cleanupObjectURL AFTER the DB commit so the refcount reflects the
// removed row.
//
// urlLoader receives the row id + tenant id and returns the URLs to
// reclaim. Returning `pgx.ErrNoRows` is fine — the delete flows through
// as a plain 404-equivalent since deleteFn will report the same.
func shapeDeleteWithFile(
	name string,
	q *db.Queries,
	s store.ObjectStore,
	urlLoader func(ctx context.Context, id, tenantID int64) ([]string, error),
	deleteFn func(context.Context, int64, int64) error,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		urls, err := urlLoader(r.Context(), id, tenantID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			api.InternalError(w, r, err)
			return
		}
		if err := deleteFn(r.Context(), id, tenantID); err != nil {
			api.InternalError(w, r, err)
			return
		}
		cleanupObjectURLs(r.Context(), q, s, urls)
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_DELETED", sseEntityKind(name), id, tenantID)
	}
}
