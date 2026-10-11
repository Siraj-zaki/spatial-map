// Package handlers — table_rows_public.go
//
// Public REST CRUD for rows in a user-defined "thing type" table.
// Authenticated by a scoped `table_api_tokens` bearer token (see
// table_token_auth.go) — NOT by the SPA's JWT or the global API key,
// because these endpoints are hit from the user's own code (curl,
// Python, postman, fleet agent) and a JWT would leak the SPA's
// session.
//
// Routes (mounted at /api/v1/public/tables):
//
//	POST   /rows                upsert one row (insert OR update)
//	POST   /rows/bulk           upsert up to 1000 rows in one transaction
//	GET    /rows                list rows (paginated, sorted)
//	POST   /rows/query          list rows matching a filter DSL
//	GET    /rows/schema         return the table's field definitions + row count
//	GET    /rows/{key}          get one row
//	PATCH  /rows/{key}          partial update one row
//	PATCH  /rows/bulk           patch up to 1000 rows by key list
//	PATCH  /rows/by-filter      patch every row matching a filter (cap 5000)
//	DELETE /rows/{key}          delete one row (records 'delete' event first)
//	DELETE /rows/bulk            delete up to 1000 rows by key list
//	DELETE /rows/by-filter      delete every row matching a filter (cap 5000)
//
// The source_id (table id) and tenant_id both come from the bearer
// token — they're not in the path. This avoids a security check
// ("does the token match the path id?") and keeps the public surface
// simple: one token, one table.
//
// Field validation: the handler reads the ordered list of
// `table_field_definitions` and validates the payload against the
// schema (required fields present, unique fields not colliding with
// another row). Schema changes mid-flight (user editing fields in the
// SPA) are tolerated — the validation runs against the current
// definition set at the time of the request.
//
// History: every write inserts a `data_source_row_events` row with the
// full payload snapshot + operation tag + source_ip + auth_token_id.
// This is the time-travel source for the map recap.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PublicRowRequest — POST /rows body. `entityKey` identifies the row
// (the publisher's stable ID — same as file/REST ingest). `payload`
// is the full row state, opaque JSON; the field definitions are
// validated against it but the bytes are stored as-is. Optional
// `position: [lng, lat]` lets a publisher push geo-located rows that
// the layer sub-renderer can pick up without a second pass.
type PublicRowRequest struct {
	EntityKey string          `json:"entityKey" validate:"required,min=1,max=256"`
	Payload   json.RawMessage `json:"payload" validate:"required"`
	Position  *[2]float64     `json:"position,omitempty"`
}

// PublicRowResponse — wire shape returned by GET / POST / PATCH /
// DELETE. Matches the existing `DataSourceRowResponse` shape but
// carried inside the public namespace so a publisher can use one
// client library for everything.
type PublicRowResponse struct {
	EntityKey string          `json:"entityKey"`
	Payload   json.RawMessage `json:"payload"`
	Position  *[2]float64     `json:"position,omitempty"`
	TS        string          `json:"ts"`
	UpdatedAt string          `json:"updatedAt"`
}

// --------------------------- helpers --------------------------------

// listFieldDefs reads the field definitions for the table. Returns
// nil if the schema is empty (the table is still writable — empty
// schema means the user created the table but hasn't added fields
// yet; the row upserts with an empty payload).
func listFieldDefs(r *http.Request, q *db.Queries, sourceID, tenantID int64) ([]db.TableFieldDefinition, error) {
	return listFieldDefsCtx(r.Context(), q, sourceID, tenantID)
}

// listFieldDefsCtx is the context-only variant — used by the polling
// worker, which has no *http.Request.
func listFieldDefsCtx(ctx context.Context, q *db.Queries, sourceID, tenantID int64) ([]db.TableFieldDefinition, error) {
	return q.ListTableFieldDefinitions(ctx, db.ListTableFieldDefinitionsParams{
		TenantID: tenantID, SourceID: sourceID,
	})
}

// ListTableFields is the exported wrapper for the polling worker (in
// internal/polling). It returns the field definitions for a table so
// the worker can validate + map incoming payload against the schema.
func ListTableFields(ctx context.Context, q *db.Queries, sourceID, tenantID int64) ([]db.TableFieldDefinition, error) {
	return listFieldDefsCtx(ctx, q, sourceID, tenantID)
}

// validateRowPayload validates the payload against the field
// definitions. Required fields must be present; unique fields must
// not collide with another row. Returns a `*validationError` so the
// caller can distinguish "user payload failed schema validation" (400)
// from "DB / transport failed" (500) via type-assertion.
func validateRowPayload(
	r *http.Request,
	q *db.Queries,
	tenantID, sourceID int64,
	entityKey string,
	payload json.RawMessage,
	fields []db.TableFieldDefinition,
) error {
	return validateRowPayloadCtx(r.Context(), q, tenantID, sourceID, entityKey, payload, fields)
}

// validateRowPayloadCtx is the context-only variant. Used by the
// polling worker, which has no *http.Request.
func validateRowPayloadCtx(
	ctx context.Context,
	q *db.Queries,
	tenantID, sourceID int64,
	entityKey string,
	payload json.RawMessage,
	fields []db.TableFieldDefinition,
) error {
	if len(fields) == 0 {
		return nil // empty schema = no validation
	}
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return &validationError{msg: "payload is not a JSON object"}
	}
	// Required-field check.
	for _, f := range fields {
		if !f.IsRequired {
			continue
		}
		v, ok := obj[f.FieldKey]
		if !ok {
			return &validationError{msg: "missing required field: " + f.FieldKey}
		}
		if v == nil {
			return &validationError{msg: "required field is null: " + f.FieldKey}
		}
	}
	// Unique check. For each unique field, scan existing rows for a
	// payload that has the same value at that key — excluding the row
	// being written (so re-upserting the same row doesn't trip the
	// constraint). We list all rows here because the per-table row
	// count is bounded by the tenant's warehouse scale; building a
	// parameterised JSONB containment query per unique field buys
	// nothing until that count crosses thousands.
	for _, f := range fields {
		if !f.IsUnique {
			continue
		}
		v, ok := obj[f.FieldKey]
		if !ok || v == nil {
			continue
		}
		rows, err := q.ListDataSourceRows(ctx, db.ListDataSourceRowsParams{
			SourceID: sourceID, TenantID: tenantID,
		})
		if err != nil {
			return fmt.Errorf("unique check failed: %w", err)
		}
		for _, row := range rows {
			if row.EntityKey == entityKey {
				continue
			}
			var existing map[string]any
			if err := json.Unmarshal(row.Payload, &existing); err != nil {
				continue
			}
			if existing[f.FieldKey] == v {
				return &validationError{msg: fmt.Sprintf(
					"unique constraint violated: %s = %v (already used by row %q)",
					f.FieldKey, v, row.EntityKey)}
			}
		}
	}
	return nil
}

// recordRowEvent inserts a `data_source_row_events` row with the
// full payload snapshot. `operation` is 'insert' | 'update' | 'delete'.
// Best-effort — a failure to insert the event is logged but does not
// fail the write, because the row truth is the `data_source_rows`
// table; missing history is recoverable from the row state.
func recordRowEvent(
	ctx context.Context,
	q *db.Queries,
	tenantID, sourceID int64,
	entityKey string,
	payload json.RawMessage,
	operation string,
	sourceIP string,
	tokenID int64,
) {
	params := db.InsertDataSourceRowEventParams{
		TenantID:  tenantID,
		SourceID:  sourceID,
		EntityKey: entityKey,
		Payload:   payload,
		Operation: operation,
	}
	if sourceIP != "" {
		params.SourceIp = pgtype.Text{String: sourceIP, Valid: true}
	}
	if tokenID != 0 {
		params.AuthTokenID = pgtype.Int8{Int64: tokenID, Valid: true}
	}
	if _, err := q.InsertDataSourceRowEvent(ctx, params); err != nil {
		// Log via slog — we don't have `r` here so we use the slog
		// default. The handler's api.InternalError path logs via
		// the request-aware slog.ErrorContext elsewhere.
		fmt.Printf("recordRowEvent: %v\n", err)
	}
}

// clientIP returns the request's source IP for the audit trail. We
// do NOT honour X-Forwarded-For unconditionally because the rate
// limiter's `api.ClientIP` already gates that on a trusted-proxy
// CIDR — but this surface is mounted OUTSIDE the tenant-middleware
// group and runs on a different router, so re-using `api.ClientIP`
// is the safer choice than reaching for `r.RemoteAddr` directly.
func clientIP(r *http.Request) string {
	return api.ClientIP(r)
}

// upsertRowPayload writes the row + records the event. Returns the
// DB row + the operation tag (so the caller can decide what to log).
// The operation is 'insert' if the row didn't exist before, 'update'
// otherwise — determined by a pre-flight GetDataSourceRow.
func upsertRowPayload(
	r *http.Request,
	q *db.Queries,
	tenantID, sourceID, tokenID int64,
	req PublicRowRequest,
	fields []db.TableFieldDefinition,
) (PublicRowResponse, string, error) {
	return upsertRowPayloadCtx(r.Context(), q, tenantID, sourceID, tokenID, req, fields, clientIP(r))
}

// upsertRowPayloadCtx is the context-only variant. `sourceIP` is the
// caller's IP for the audit trail — empty string means "no IP" (the
// polling worker uses this since it has no client request).
func upsertRowPayloadCtx(
	ctx context.Context,
	q *db.Queries,
	tenantID, sourceID, tokenID int64,
	req PublicRowRequest,
	fields []db.TableFieldDefinition,
	sourceIP string,
) (PublicRowResponse, string, error) {
	// Determine operation: insert if row doesn't exist, else update.
	_, err := q.GetDataSourceRow(ctx, db.GetDataSourceRowParams{
		SourceID: sourceID, EntityKey: req.EntityKey, TenantID: tenantID,
	})
	operation := "insert"
	if err == nil {
		operation = "update"
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return PublicRowResponse{}, "", err
	}
	// Validate against schema.
	if err := validateRowPayloadCtx(ctx, q, tenantID, sourceID, req.EntityKey, req.Payload, fields); err != nil {
		return PublicRowResponse{}, "", err
	}
	// Upsert the row.
	positionWKT := ""
	if req.Position != nil {
		positionWKT = fmt.Sprintf("POINT(%g %g)", req.Position[0], req.Position[1])
	}
	row, err := q.UpsertDataSourceRow(ctx, db.UpsertDataSourceRowParams{
		TenantID:    tenantID,
		SourceID:    sourceID,
		EntityKey:   req.EntityKey,
		Payload:     req.Payload,
		PositionWkt: positionWKT,
		Ts:          pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	if err != nil {
		return PublicRowResponse{}, "", err
	}
	// Record the event (best-effort).
	recordRowEvent(ctx, q, tenantID, sourceID, req.EntityKey, req.Payload, operation, sourceIP, tokenID)
	return PublicRowResponse{
		EntityKey: row.EntityKey,
		Payload:   row.Payload,
		Position:  parseWktPoint(row.PositionWkt),
		TS:        api.FormatTime(row.Ts),
		UpdatedAt: api.FormatTime(row.UpdatedAt),
	}, operation, nil
}

// UpsertTableRow is the exported wrapper for non-HTTP paths (the
// polling worker in internal/polling). It writes one row + records
// the audit event with no token, no source IP, and no client request
// — the worker has none of those. Returns the operation tag
// ("insert"/"update") so the caller can decide what to log.
func UpsertTableRow(
	ctx context.Context,
	q *db.Queries,
	tenantID, sourceID int64,
	req PublicRowRequest,
	fields []db.TableFieldDefinition,
) (PublicRowResponse, string, error) {
	return upsertRowPayloadCtx(ctx, q, tenantID, sourceID, 0, req, fields, "")
}

// --------------------------- handlers -------------------------------

// publicUpsertRowHandler — POST /rows.
func publicUpsertRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		var req PublicRowRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		fields, err := listFieldDefs(r, q, info.SourceID, info.TenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp, _, err := upsertRowPayload(r, q, info.TenantID, info.SourceID, info.TokenID, req, fields)
		if err != nil {
			// Validation errors are 400; everything else is 500.
			if _, ok := err.(*validationError); ok {
				api.BadRequest(w, err.Error())
				return
			}
			api.InternalError(w, r, err)
			return
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, resp)
		// Nudge the SSE bus so viewers subscribed to this tenant
		// invalidate the data-linked layer cache.
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", info.SourceID, info.TenantID)
	}
}

// publicListRowsHandler — GET /rows. Paginated + sorted listing.
// Query params: page (1-based, default 1), pageSize (default 100, max 500),
// sortBy (entity_key|ts|updated_at, default ts), sortDir (asc|desc, default desc).
// Response always includes totalCount via COUNT(*) OVER() — the page UI
// needs it. For filter-based queries, use POST /rows/query with includeCount.
func publicListRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		page, pageSize, sortBy, sortDir, err := parsePageParams(r)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		offset := (page - 1) * pageSize

		orderExpr, err := sanitiseSortColumn(sortBy)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		dir := "DESC"
		if strings.EqualFold(sortDir, "asc") {
			dir = "ASC"
		}

		// COUNT(*) OVER() gives us the total in the same scan — no
		// second round trip. Cap is enforced by LIMIT/OFFSET.
		listSQL := fmt.Sprintf(`
			SELECT id, source_id, entity_key, payload,
			       (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
			       COALESCE(linked_shape_name, '') AS linked_shape_name,
			       ts, updated_at,
			       COUNT(*) OVER() AS total_count
			FROM data_source_rows
			WHERE tenant_id = $1 AND source_id = $2
			ORDER BY %s %s, entity_key ASC
			LIMIT $3 OFFSET $4
		`, orderExpr, dir)

		rowsQ, qerr := pool.Query(r.Context(), listSQL,
			info.TenantID, info.SourceID, pageSize, offset)
		if qerr != nil {
			api.InternalError(w, r, qerr)
			return
		}
		defer rowsQ.Close()

		out := make([]PublicRowResponse, 0, pageSize)
		var totalCount int64
		for rowsQ.Next() {
			var (
				id, sid                int64
				entityKey, linkedShape string
				payload                []byte
				wkt                    string
				ts, updatedAt          time.Time
				tc                     int64
			)
			if err := rowsQ.Scan(&id, &sid, &entityKey, &payload, &wkt, &linkedShape, &ts, &updatedAt, &tc); err != nil {
				api.InternalError(w, r, err)
				return
			}
			totalCount = tc
			out = append(out, PublicRowResponse{
				EntityKey: entityKey,
				Payload:   payload,
				Position:  parseWktPoint(wkt),
				TS:        ts.Format(time.RFC3339),
				UpdatedAt: updatedAt.Format(time.RFC3339),
			})
		}
		if err := rowsQ.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, map[string]any{
			"rows":       out,
			"page":       page,
			"pageSize":   pageSize,
			"totalCount": totalCount,
		})
	}
}

// publicGetRowHandler — GET /rows/{key}.
func publicGetRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		key := chi.URLParam(r, "key")
		if key == "" {
			api.BadRequest(w, "empty entity_key")
			return
		}
		row, err := q.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
			SourceID: info.SourceID, EntityKey: key, TenantID: info.TenantID,
		})
		if err != nil {
			api.NotFound(w, "row not found")
			return
		}
		api.JSON(w, http.StatusOK, PublicRowResponse{
			EntityKey: row.EntityKey,
			Payload:   row.Payload,
			Position:  parseWktPoint(row.PositionWkt),
			TS:        api.FormatTime(row.Ts),
			UpdatedAt: api.FormatTime(row.UpdatedAt),
		})
	}
}

// publicPatchRowHandler — PATCH /rows/{key}. Partial update: only
// the keys present in the request body are overwritten on the payload.
// The merge happens on the JSON map, not the JSONB column, so a
// request that sends `{"status": "active"}` patches only `status`
// and leaves the rest of the payload untouched.
func publicPatchRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		key := chi.URLParam(r, "key")
		if key == "" {
			api.BadRequest(w, "empty entity_key")
			return
		}
		var patch map[string]any
		if err := api.DecodeBody(r, &patch); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		// Fetch the existing row, merge the patch on the payload map.
		existing, err := q.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
			SourceID: info.SourceID, EntityKey: key, TenantID: info.TenantID,
		})
		if err != nil {
			api.NotFound(w, "row not found")
			return
		}
		var merged map[string]any
		if len(existing.Payload) > 0 {
			if err := json.Unmarshal(existing.Payload, &merged); err != nil {
				api.InternalError(w, r, err)
				return
			}
		} else {
			merged = map[string]any{}
		}
		for k, v := range patch {
			merged[k] = v
		}
		mergedBytes, err := json.Marshal(merged)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		// Validate the merged payload against the schema.
		fields, err := listFieldDefs(r, q, info.SourceID, info.TenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := validateRowPayload(r, q, info.TenantID, info.SourceID, key, mergedBytes, fields); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		// Preserve the existing position unless the patch explicitly
		// sets one. We re-upsert with the merged payload + existing
		// position (so a partial PATCH doesn't drop the row's geo).
		positionWKT := existing.PositionWkt
		row, err := q.UpsertDataSourceRow(r.Context(), db.UpsertDataSourceRowParams{
			TenantID:    info.TenantID,
			SourceID:    info.SourceID,
			EntityKey:   key,
			Payload:     mergedBytes,
			PositionWkt: positionWKT,
			Ts:          pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		recordRowEvent(r.Context(), q, info.TenantID, info.SourceID, key, mergedBytes, "update", clientIP(r), info.TokenID)
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, PublicRowResponse{
			EntityKey: row.EntityKey,
			Payload:   row.Payload,
			Position:  parseWktPoint(row.PositionWkt),
			TS:        api.FormatTime(row.Ts),
			UpdatedAt: api.FormatTime(row.UpdatedAt),
		})
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", info.SourceID, info.TenantID)
	}
}

// publicDeleteRowHandler — DELETE /rows/{key}. Records a 'delete'
// event with the last-known state BEFORE the actual delete so the
// recap animation can play back the row's life cycle.
func publicDeleteRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		key := chi.URLParam(r, "key")
		if key == "" {
			api.BadRequest(w, "empty entity_key")
			return
		}
		// Read the row before deleting so the event carries the
		// last-known state.
		existing, err := q.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
			SourceID: info.SourceID, EntityKey: key, TenantID: info.TenantID,
		})
		if err != nil {
			api.NotFound(w, "row not found")
			return
		}
		// Record the delete event first.
		recordRowEvent(r.Context(), q, info.TenantID, info.SourceID, key, existing.Payload, "delete", clientIP(r), info.TokenID)
		// Then delete the row.
		if err := q.DeleteDataSourceRow(r.Context(), db.DeleteDataSourceRowParams{
			SourceID: info.SourceID, EntityKey: key, TenantID: info.TenantID,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", info.SourceID, info.TenantID)
	}
}

// --------------------------- pagination helpers --------------------------------

const (
	defaultPage     = 1
	defaultPageSize = 100
	maxPageSize     = 500
)

// parsePageParams pulls page / pageSize / sortBy / sortDir from the
// query string and applies defaults + caps. sortBy is validated
// separately by sanitiseSortColumn because the column name is spliced
// into SQL (parameterisation isn't possible for ORDER BY columns).
func parsePageParams(r *http.Request) (page, pageSize int, sortBy, sortDir string, err error) {
	page = defaultPage
	pageSize = defaultPageSize
	sortBy = "ts"
	sortDir = "desc"

	if raw := r.URL.Query().Get("page"); raw != "" {
		v, perr := strconv.Atoi(raw)
		if perr != nil || v < 1 {
			return 0, 0, "", "", errors.New("page must be a positive integer")
		}
		page = v
	}
	if raw := r.URL.Query().Get("pageSize"); raw != "" {
		v, perr := strconv.Atoi(raw)
		if perr != nil || v < 1 {
			return 0, 0, "", "", errors.New("pageSize must be a positive integer")
		}
		pageSize = v
	}
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}
	if raw := r.URL.Query().Get("sortBy"); raw != "" {
		sortBy = raw
	}
	if raw := r.URL.Query().Get("sortDir"); raw != "" {
		sortDir = raw
	}
	return page, pageSize, sortBy, sortDir, nil
}

// sanitiseSortColumn allow-lists the columns we'll splice into ORDER BY.
// Arbitrary payload-field sorts would need a per-field expression index,
// which is out of scope; clients that need payload-field sort can do it
// client-side on the fetched page.
func sanitiseSortColumn(sortBy string) (string, error) {
	switch sortBy {
	case "entity_key":
		return "entity_key", nil
	case "ts":
		return "ts", nil
	case "updated_at":
		return "updated_at", nil
	default:
		return "", fmt.Errorf("sortBy must be one of entity_key|ts|updated_at, got %q", sortBy)
	}
}

// --------------------------- bulk + filter handlers --------------------------------

const (
	bulkRowsLimit     = 1000
	byFilterRowsLimit = 5000
	bulkRowsMaxBytes  = 32 * 1024 * 1024 // 32 MB body cap
)

// publicBulkUpsertRowsHandler — POST /rows/bulk. Up to 1000 rows in
// one transaction. Partial-success: validation failures are collected
// per-row, valid rows still commit. One kind-wide SSE broadcast at
// the end (NOT 1000 per-row events) — see the docs/pitfalls-backend.md
// row on BroadcastEntityEvent with synthetic zero id.
func publicBulkUpsertRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, bulkRowsMaxBytes)
		var req struct {
			Rows []PublicRowRequest `json:"rows"`
		}
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body: "+err.Error())
			return
		}
		if len(req.Rows) == 0 {
			api.BadRequest(w, "rows must not be empty")
			return
		}
		if len(req.Rows) > bulkRowsLimit {
			api.BadRequest(w, fmt.Sprintf("rows holds %d items, over the limit of %d", len(req.Rows), bulkRowsLimit))
			return
		}

		fields, err := listFieldDefs(r, q, info.SourceID, info.TenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		upserted, errs := bulkUpsertRows(r.Context(), q, tx, info.TenantID, info.SourceID, info.TokenID, req.Rows, fields, clientIP(r))

		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, map[string]any{
			"upserted": upserted,
			"errors":   errs,
		})
		// One kind-wide SSE — clients reload the table's rows once,
		// not once per row.
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", info.TenantID)
	}
}

// bulkUpsertRows writes rows inside tx with partial success. Each row runs
// under its own savepoint: Postgres aborts the whole transaction on any
// statement error, so without one a single failing row (or a failed
// history insert) would sink every row after it and the commit.
// The operation (insert/update) is decided before the upsert — afterwards
// the row always exists.
func bulkUpsertRows(
	ctx context.Context,
	q *db.Queries,
	tx pgx.Tx,
	tenantID, sourceID, tokenID int64,
	rows []PublicRowRequest,
	fields []db.TableFieldDefinition,
	sourceIP string,
) (int, []map[string]string) {
	upserted := 0
	var errs []map[string]string
	fail := func(i int, err error) {
		errs = append(errs, map[string]string{"index": strconv.Itoa(i), "error": err.Error()})
	}
	for i, rowReq := range rows {
		if verr := api.ValidateStruct(rowReq); verr != nil {
			fail(i, verr)
			continue
		}
		sp, err := tx.Begin(ctx)
		if err != nil {
			fail(i, err)
			continue
		}
		qsp := q.WithTx(sp)
		if err := upsertOneBulkRow(ctx, qsp, tenantID, sourceID, tokenID, rowReq, fields, sourceIP); err != nil {
			_ = sp.Rollback(ctx)
			fail(i, err)
			continue
		}
		if err := sp.Commit(ctx); err != nil {
			fail(i, err)
			continue
		}
		upserted++
	}
	return upserted, errs
}

func upsertOneBulkRow(
	ctx context.Context,
	q *db.Queries,
	tenantID, sourceID, tokenID int64,
	rowReq PublicRowRequest,
	fields []db.TableFieldDefinition,
	sourceIP string,
) error {
	if err := validateRowPayloadCtx(ctx, q, tenantID, sourceID, rowReq.EntityKey, rowReq.Payload, fields); err != nil {
		return err
	}
	operation := "insert"
	if _, err := q.GetDataSourceRow(ctx, db.GetDataSourceRowParams{
		SourceID: sourceID, EntityKey: rowReq.EntityKey, TenantID: tenantID,
	}); err == nil {
		operation = "update"
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	positionWKT := ""
	if rowReq.Position != nil {
		positionWKT = fmt.Sprintf("POINT(%g %g)", rowReq.Position[0], rowReq.Position[1])
	}
	if _, err := q.UpsertDataSourceRow(ctx, db.UpsertDataSourceRowParams{
		TenantID:    tenantID,
		SourceID:    sourceID,
		EntityKey:   rowReq.EntityKey,
		Payload:     rowReq.Payload,
		PositionWkt: positionWKT,
		Ts:          pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	}); err != nil {
		return err
	}
	recordRowEvent(ctx, q, tenantID, sourceID, rowReq.EntityKey, rowReq.Payload, operation, sourceIP, tokenID)
	return nil
}

// publicQueryRowsHandler — POST /rows/query. Filtered + paginated +
// sorted read. Reuses the filterCompiler from data_source_query.go
// verbatim — same DSL as /data-sources/:id/query.
func publicQueryRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		var req QueryRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body: "+err.Error())
			return
		}
		if req.Limit <= 0 {
			req.Limit = defaultQueryLimit
		}
		if req.Limit > maxQueryLimit {
			req.Limit = maxQueryLimit
		}
		if req.Offset < 0 {
			req.Offset = 0
		}

		compiler := NewFilterCompiler(info.TenantID, info.SourceID)
		if err := compiler.PushBase(); err != nil {
			api.InternalError(w, r, err)
			return
		}
		if req.Filter != nil {
			if err := compiler.PushFilter(req.Filter, 0, 0); err != nil {
				api.BadRequest(w, err.Error())
				return
			}
		}
		if req.FloorPlanID != nil {
			compiler.PushFloor(*req.FloorPlanID)
		}

		whereSQL := strings.Join(compiler.wheres, " AND ")
		listSQL := fmt.Sprintf(`
			SELECT id, source_id, entity_key, payload,
			       (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
			       COALESCE(linked_shape_name, '') AS linked_shape_name,
			       ts, updated_at
			FROM data_source_rows
			WHERE %s
			ORDER BY ts DESC
			LIMIT $%d OFFSET $%d
		`, whereSQL, len(compiler.args)+1, len(compiler.args)+2)
		listArgs := append(append([]any{}, compiler.args...), req.Limit, req.Offset)

		rowsQ, err := pool.Query(r.Context(), listSQL, listArgs...)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rowsQ.Close()

		out := make([]PublicRowResponse, 0)
		for rowsQ.Next() {
			var (
				id, sid                int64
				entityKey, linkedShape string
				payload                []byte
				wkt                    string
				ts, updatedAt          time.Time
			)
			if err := rowsQ.Scan(&id, &sid, &entityKey, &payload, &wkt, &linkedShape, &ts, &updatedAt); err != nil {
				api.InternalError(w, r, err)
				return
			}
			out = append(out, PublicRowResponse{
				EntityKey: entityKey,
				Payload:   payload,
				Position:  parseWktPoint(wkt),
				TS:        ts.Format(time.RFC3339),
				UpdatedAt: updatedAt.Format(time.RFC3339),
			})
		}
		if err := rowsQ.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		truncated := len(out) == req.Limit
		resp := map[string]any{
			"rows":      out,
			"truncated": truncated,
		}
		if req.IncludeCount {
			countSQL := fmt.Sprintf(`SELECT COUNT(*) FROM data_source_rows WHERE %s`, whereSQL)
			var total int64
			if err := pool.QueryRow(r.Context(), countSQL, compiler.args...).Scan(&total); err != nil {
				api.InternalError(w, r, err)
				return
			}
			resp["totalCount"] = total
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, resp)
	}
}

// publicSchemaHandler — GET /rows/schema. Returns the table's own
// field definitions + total row count. Cheaper than the generic
// /data-sources/:id/schema introspection because we already know the
// schema — no jsonb_each aggregation needed.
func publicSchemaHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		fields, err := listFieldDefs(r, q, info.SourceID, info.TenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		count, err := q.CountDataSourceRows(r.Context(), db.CountDataSourceRowsParams{
			SourceID: info.SourceID, TenantID: info.TenantID,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]map[string]any, 0, len(fields))
		for _, f := range fields {
			out = append(out, map[string]any{
				"fieldKey":   f.FieldKey,
				"fieldLabel": f.FieldLabel,
				"dataType":   f.DataType,
				"isRequired": f.IsRequired,
				"isUnique":   f.IsUnique,
				"sortOrder":  f.SortOrder,
			})
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, map[string]any{
			"fields":   out,
			"rowCount": count,
		})
	}
}

// publicBulkPatchRowsHandler — PATCH /rows/bulk. Per-key patch list.
// Single transaction, partial-success. Each entry's patch is merged
// onto the existing row's payload (same semantics as PATCH /rows/{key}).
func publicBulkPatchRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, bulkRowsMaxBytes)
		var req struct {
			Rows []struct {
				EntityKey string          `json:"entityKey" validate:"required"`
				Patch     json.RawMessage `json:"patch" validate:"required"`
			} `json:"rows"`
		}
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body: "+err.Error())
			return
		}
		if len(req.Rows) == 0 {
			api.BadRequest(w, "rows must not be empty")
			return
		}
		if len(req.Rows) > bulkRowsLimit {
			api.BadRequest(w, fmt.Sprintf("rows holds %d items, over the limit of %d", len(req.Rows), bulkRowsLimit))
			return
		}

		fields, err := listFieldDefs(r, q, info.SourceID, info.TenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		qtx := q.WithTx(tx)

		updated := 0
		var errs []map[string]string
		for i, item := range req.Rows {
			existing, err := qtx.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
				SourceID: info.SourceID, EntityKey: item.EntityKey, TenantID: info.TenantID,
			})
			if err != nil {
				errs = append(errs, map[string]string{"index": strconv.Itoa(i), "error": "row not found: " + item.EntityKey})
				continue
			}
			var patch map[string]any
			if err := json.Unmarshal(item.Patch, &patch); err != nil {
				errs = append(errs, map[string]string{"index": strconv.Itoa(i), "error": "patch is not a JSON object"})
				continue
			}
			var merged map[string]any
			if len(existing.Payload) > 0 {
				if err := json.Unmarshal(existing.Payload, &merged); err != nil {
					errs = append(errs, map[string]string{"index": strconv.Itoa(i), "error": err.Error()})
					continue
				}
			} else {
				merged = map[string]any{}
			}
			for k, v := range patch {
				merged[k] = v
			}
			mergedBytes, err := json.Marshal(merged)
			if err != nil {
				errs = append(errs, map[string]string{"index": strconv.Itoa(i), "error": err.Error()})
				continue
			}
			if verr := validateRowPayload(r, qtx, info.TenantID, info.SourceID, item.EntityKey, mergedBytes, fields); verr != nil {
				errs = append(errs, map[string]string{"index": strconv.Itoa(i), "error": verr.Error()})
				continue
			}
			if _, err := qtx.UpsertDataSourceRow(r.Context(), db.UpsertDataSourceRowParams{
				TenantID:    info.TenantID,
				SourceID:    info.SourceID,
				EntityKey:   item.EntityKey,
				Payload:     mergedBytes,
				PositionWkt: existing.PositionWkt,
				Ts:          pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
			}); err != nil {
				errs = append(errs, map[string]string{"index": strconv.Itoa(i), "error": err.Error()})
				continue
			}
			recordRowEvent(r.Context(), qtx, info.TenantID, info.SourceID, item.EntityKey, mergedBytes, "update", clientIP(r), info.TokenID)
			updated++
		}

		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, map[string]any{
			"updated": updated,
			"errors":  errs,
		})
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", info.TenantID)
	}
}

// publicPatchRowsByFilterHandler — PATCH /rows/by-filter. Patches
// every row matching the filter. Cap 5000 rows touched per call to
// guard against accidental mass-update. Hitting the cap returns 413.
func publicPatchRowsByFilterHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		var req struct {
			Filter *FilterNode     `json:"filter"`
			Patch  json.RawMessage `json:"patch" validate:"required"`
		}
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body: "+err.Error())
			return
		}
		if req.Filter == nil {
			api.BadRequest(w, "filter is required")
			return
		}

		// Resolve matching keys first (capped).
		keys, err := keysMatchingFilter(r, pool, info.TenantID, info.SourceID, req.Filter, byFilterRowsLimit)
		if err != nil {
			if _, ok := err.(*filterCapExceeded); ok {
				api.Error(w, http.StatusRequestEntityTooLarge,
					fmt.Sprintf("filter matches more than %d rows; narrow the filter or use paged calls", byFilterRowsLimit))
				return
			}
			if isFilterCompileError(err) {
				api.BadRequest(w, err.Error())
				return
			}
			api.InternalError(w, r, err)
			return
		}

		fields, err := listFieldDefs(r, q, info.SourceID, info.TenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		var patch map[string]any
		if err := json.Unmarshal(req.Patch, &patch); err != nil {
			api.BadRequest(w, "patch is not a JSON object")
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		qtx := q.WithTx(tx)

		updated := 0
		for _, key := range keys {
			existing, err := qtx.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
				SourceID: info.SourceID, EntityKey: key, TenantID: info.TenantID,
			})
			if err != nil {
				continue
			}
			var merged map[string]any
			if len(existing.Payload) > 0 {
				if err := json.Unmarshal(existing.Payload, &merged); err != nil {
					continue
				}
			} else {
				merged = map[string]any{}
			}
			for k, v := range patch {
				merged[k] = v
			}
			mergedBytes, err := json.Marshal(merged)
			if err != nil {
				continue
			}
			if verr := validateRowPayload(r, qtx, info.TenantID, info.SourceID, key, mergedBytes, fields); verr != nil {
				continue
			}
			if _, err := qtx.UpsertDataSourceRow(r.Context(), db.UpsertDataSourceRowParams{
				TenantID:    info.TenantID,
				SourceID:    info.SourceID,
				EntityKey:   key,
				Payload:     mergedBytes,
				PositionWkt: existing.PositionWkt,
				Ts:          pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
			}); err != nil {
				continue
			}
			recordRowEvent(r.Context(), qtx, info.TenantID, info.SourceID, key, mergedBytes, "update", clientIP(r), info.TokenID)
			updated++
		}

		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, map[string]any{"updated": updated})
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", info.TenantID)
	}
}

// publicBulkDeleteRowsHandler — DELETE /rows/bulk. Delete by list of
// keys. Single transaction.
func publicBulkDeleteRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, bulkRowsMaxBytes)
		var req struct {
			EntityKeys []string `json:"entityKeys"`
		}
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body: "+err.Error())
			return
		}
		if len(req.EntityKeys) == 0 {
			api.BadRequest(w, "entityKeys must not be empty")
			return
		}
		if len(req.EntityKeys) > bulkRowsLimit {
			api.BadRequest(w, fmt.Sprintf("entityKeys holds %d items, over the limit of %d", len(req.EntityKeys), bulkRowsLimit))
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		qtx := q.WithTx(tx)

		deleted := 0
		for _, key := range req.EntityKeys {
			existing, err := qtx.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
				SourceID: info.SourceID, EntityKey: key, TenantID: info.TenantID,
			})
			if err != nil {
				continue // not found — skip
			}
			recordRowEvent(r.Context(), qtx, info.TenantID, info.SourceID, key, existing.Payload, "delete", clientIP(r), info.TokenID)
			if err := qtx.DeleteDataSourceRow(r.Context(), db.DeleteDataSourceRowParams{
				SourceID: info.SourceID, EntityKey: key, TenantID: info.TenantID,
			}); err != nil {
				continue
			}
			deleted++
		}

		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, map[string]any{"deleted": deleted})
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", info.TenantID)
	}
}

// publicDeleteRowsByFilterHandler — DELETE /rows/by-filter. Delete
// every row matching the filter. Cap 5000 rows touched.
func publicDeleteRowsByFilterHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := tableTokenFromContext(r.Context())
		if info.SourceID == 0 {
			api.Error(w, http.StatusUnauthorized, "no table token")
			return
		}
		var req struct {
			Filter *FilterNode `json:"filter"`
		}
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body: "+err.Error())
			return
		}
		if req.Filter == nil {
			api.BadRequest(w, "filter is required")
			return
		}

		keys, err := keysMatchingFilter(r, pool, info.TenantID, info.SourceID, req.Filter, byFilterRowsLimit)
		if err != nil {
			if _, ok := err.(*filterCapExceeded); ok {
				api.Error(w, http.StatusRequestEntityTooLarge,
					fmt.Sprintf("filter matches more than %d rows; narrow the filter or use paged calls", byFilterRowsLimit))
				return
			}
			if isFilterCompileError(err) {
				api.BadRequest(w, err.Error())
				return
			}
			api.InternalError(w, r, err)
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		qtx := q.WithTx(tx)

		deleted := 0
		for _, key := range keys {
			existing, err := qtx.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
				SourceID: info.SourceID, EntityKey: key, TenantID: info.TenantID,
			})
			if err != nil {
				continue
			}
			recordRowEvent(r.Context(), qtx, info.TenantID, info.SourceID, key, existing.Payload, "delete", clientIP(r), info.TokenID)
			if err := qtx.DeleteDataSourceRow(r.Context(), db.DeleteDataSourceRowParams{
				SourceID: info.SourceID, EntityKey: key, TenantID: info.TenantID,
			}); err != nil {
				continue
			}
			deleted++
		}

		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		touchTableToken(r.Context(), q, info.TokenID)
		api.JSON(w, http.StatusOK, map[string]any{"deleted": deleted})
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", info.TenantID)
	}
}

// --------------------------- filter helpers --------------------------------

// filterCapExceeded is returned by keysMatchingFilter when the filter
// matches more rows than the caller's cap. The handler converts it
// to a 413 response.
type filterCapExceeded struct{ cap int }

func (e *filterCapExceeded) Error() string {
	return fmt.Sprintf("filter matches more than %d rows", e.cap)
}

// isFilterCompileError returns true for errors returned by the filter
// compiler's PushFilter (which surface as plain errors with helpful
// messages). We treat them as 400.
func isFilterCompileError(err error) bool {
	if err == nil {
		return false
	}
	// The compiler returns errors.New / fmt.Errorf with messages like
	// "filter tree too deep", "unsupported operator", "invalid character".
	// We don't have a sentinel type — match on the known prefixes.
	msg := err.Error()
	for _, prefix := range []string{
		"filter", "unsupported operator", "invalid character",
		"empty field", "field name too long", "unknown filter",
		"between requires", "in/notIn requires", "value must be",
	} {
		if strings.HasPrefix(msg, prefix) {
			return true
		}
	}
	return false
}

// keysMatchingFilter compiles the filter + returns the entity_keys of
// matching rows, capped at `cap` rows. Exceeding the cap returns
// *filterCapExceeded so the caller can map it to 413.
func keysMatchingFilter(
	r *http.Request,
	pool *pgxpool.Pool,
	tenantID, sourceID int64,
	filter *FilterNode,
	cap int,
) ([]string, error) {
	compiler := NewFilterCompiler(tenantID, sourceID)
	if err := compiler.PushBase(); err != nil {
		return nil, err
	}
	if err := compiler.PushFilter(filter, 0, 0); err != nil {
		return nil, err
	}
	whereSQL := strings.Join(compiler.wheres, " AND ")
	// LIMIT cap+1 — if we get cap+1 rows back, the filter exceeds the cap.
	listSQL := fmt.Sprintf(`
		SELECT entity_key
		FROM data_source_rows
		WHERE %s
		LIMIT $%d
	`, whereSQL, len(compiler.args)+1)
	listArgs := append(append([]any{}, compiler.args...), cap+1)

	rowsQ, err := pool.Query(r.Context(), listSQL, listArgs...)
	if err != nil {
		return nil, err
	}
	defer rowsQ.Close()

	out := make([]string, 0, cap)
	for rowsQ.Next() {
		var key string
		if err := rowsQ.Scan(&key); err != nil {
			return nil, err
		}
		out = append(out, key)
	}
	if err := rowsQ.Err(); err != nil {
		return nil, err
	}
	if len(out) > cap {
		return nil, &filterCapExceeded{cap: cap}
	}
	return out, nil
}

// --------------------------- router --------------------------------

// PublicTableRowsRouter wires the public REST CRUD for rows in a
// thing-type table. Mounted at `/api/v1/public/tables` — OUTSIDE
// the tenant-middleware group because the bearer token resolves
// the tenant itself (no X-Tenant-Id header required).
func PublicTableRowsRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Use(TableTokenMiddleware(q))
	// Single-row CRUD (existing).
	r.Post("/rows", publicUpsertRowHandler(q))
	r.Get("/rows", publicListRowsHandler(q, pool))
	r.Get("/rows/{key}", publicGetRowHandler(q))
	r.Patch("/rows/{key}", publicPatchRowHandler(q))
	r.Delete("/rows/{key}", publicDeleteRowHandler(q))
	// Bulk + filter + schema (new). Mounted AFTER the {key} routes so
	// chi's path matching picks the literal `/rows/bulk` before the
	// `{key}` placeholder would catch `bulk` as a key.
	r.Post("/rows/bulk", publicBulkUpsertRowsHandler(q, pool))
	r.Post("/rows/query", publicQueryRowsHandler(q, pool))
	r.Get("/rows/schema", publicSchemaHandler(q))
	r.Patch("/rows/bulk", publicBulkPatchRowsHandler(q, pool))
	r.Patch("/rows/by-filter", publicPatchRowsByFilterHandler(q, pool))
	r.Delete("/rows/bulk", publicBulkDeleteRowsHandler(q, pool))
	r.Delete("/rows/by-filter", publicDeleteRowsByFilterHandler(q, pool))
	return r
}

// validationError is a sentinel used by the public handlers to
// distinguish "user payload failed schema validation" (400) from
// "DB / transport failed" (500). It's returned by `upsertRowPayload`
// — but currently that function returns a plain error, so this type
// is kept for future use and to make the caller's type-assertion
// explicit. (Currently `validateRowPayload` returns a plain
// `fmt.Errorf`-style error; the caller matches on the *validationError
// type and treats it as 400. To use this, replace the returns in
// `validateRowPayload` with `&validationError{msg: ...}`.)
type validationError struct {
	msg string
}

func (e *validationError) Error() string { return e.msg }
