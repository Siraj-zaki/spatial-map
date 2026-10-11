// Package handlers — table_rows_authed.go
//
// Authed row CRUD for thing-type tables. Mounted at
// `/api/v1/tables/{id}/rows/...` INSIDE the tenant-scoped group, so
// the SPA can read/write table rows with the user's JWT + the active
// tenant header — no per-table bearer token required. This is the
// surface the Records data grid + History viewer use; the public
// `/api/v1/public/tables/rows` surface (table_rows_public.go) is for
// the user's own scripts (fleet agents, ETL) and stays bearer-only.
//
// Routes (mirror of the public surface, plus PUT for full replace):
//
//	POST   /rows                upsert one row
//	POST   /rows/bulk           upsert up to 1000 rows in one tx
//	GET    /rows                list rows (paginated, sorted)
//	POST   /rows/query          list rows matching a filter DSL
//	GET    /rows/schema         field defs + row count
//	GET    /rows/{key}          get one row
//	PATCH  /rows/{key}          partial update one row
//	PUT    /rows/{key}          full replace one row
//	PATCH  /rows/bulk           patch up to 1000 rows by key list
//	PATCH  /rows/by-filter      patch every row matching a filter (cap 5000)
//	DELETE /rows/{key}          delete one row
//	DELETE /rows/bulk           delete up to 1000 rows by key list
//	DELETE /rows/by-filter      delete every row matching a filter (cap 5000)
//
// All handlers reuse the helpers in table_rows_public.go
// (validateRowPayload, recordRowEvent, parsePageParams,
// sanitiseSortColumn, keysMatchingFilter, parseWktPoint) so the
// validation + audit trail semantics stay identical between the
// authed and public surfaces.
package handlers

import (
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

// authedTableContext resolves (tenantID, sourceID) from the JWT
// context + path id, and verifies the source is a table-kind source
// owned by the tenant. Returns ok=false on a mismatch — the caller
// writes the response.
func authedTableContext(w http.ResponseWriter, r *http.Request, q *db.Queries) (tenantID, sourceID int64, ok bool) {
	tenantID = api.TenantID(r.Context())
	if tenantID == 0 {
		api.Error(w, http.StatusUnauthorized, "tenant scope required")
		return 0, 0, false
	}
	sid, err := parseIDFromPath(r, "id")
	if err != nil {
		api.BadRequest(w, "invalid table id")
		return 0, 0, false
	}
	// Confirm the source exists in-tenant AND is a table-kind source.
	// A non-table source would let the SPA write rows through the
	// table surface into a file/REST/webhook pool, which is not what
	// the data grid is for.
	src, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
		ID: sid, TenantID: tenantID,
	})
	if err != nil {
		api.NotFound(w, "table not found")
		return 0, 0, false
	}
	if src.Kind != "table" {
		api.BadRequest(w, "source is not a table-kind data source")
		return 0, 0, false
	}
	return tenantID, sid, true
}

// --------------------------- single-row handlers ---------------------------

// authedUpsertRowHandler — POST /tables/{id}/rows.
func authedUpsertRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
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
		fields, err := listFieldDefs(r, q, sourceID, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp, _, err := upsertRowPayload(r, q, tenantID, sourceID, 0, req, fields)
		if err != nil {
			if _, ok := err.(*validationError); ok {
				api.BadRequest(w, err.Error())
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, resp)
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", sourceID, tenantID)
	}
}

// authedListRowsHandler — GET /tables/{id}/rows.
func authedListRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
			return
		}
		page, pageSize, sortBy, sortDir, err := parsePageParams(r)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		offset := (page - 1) * pageSize

		dir := "DESC"
		if strings.EqualFold(sortDir, "asc") {
			dir = "ASC"
		}
		args := []any{tenantID, sourceID}
		where := "tenant_id = $1 AND source_id = $2"

		// ?q= — case-insensitive match on the row key or any payload value
		// (values only: matching the JSON text would hit every row whose
		// payload merely has a key named like the search).
		if search := strings.TrimSpace(r.URL.Query().Get("q")); search != "" {
			args = append(args, escapeLike(search))
			n := len(args)
			where += fmt.Sprintf(` AND (entity_key ILIKE '%%' || $%d || '%%' OR CASE WHEN jsonb_typeof(payload) = 'object'
				THEN EXISTS (SELECT 1 FROM jsonb_each_text(payload) kv WHERE kv.value ILIKE '%%' || $%d || '%%')
				ELSE payload::text ILIKE '%%' || $%d || '%%' END)`, n, n, n)
		}

		// ?sortBy=field:<key> sorts by a declared field (numbers
		// numerically, everything else case-insensitively); the key is a
		// bound parameter and must be one of the table's fields.
		var orderExpr string
		if key, ok := strings.CutPrefix(sortBy, "field:"); ok {
			fields, ferr := q.ListTableFieldDefinitions(r.Context(), db.ListTableFieldDefinitionsParams{TenantID: tenantID, SourceID: sourceID})
			if ferr != nil {
				api.InternalError(w, r, ferr)
				return
			}
			dataType := ""
			for _, f := range fields {
				if f.FieldKey == key {
					dataType = string(f.DataType)
				}
			}
			if dataType == "" {
				api.BadRequest(w, fmt.Sprintf("sortBy field %q is not defined on this table", key))
				return
			}
			args = append(args, key)
			n := len(args)
			if dataType == "number" || dataType == "integer" {
				orderExpr = fmt.Sprintf(`CASE WHEN payload->>$%d ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN (payload->>$%d)::numeric END %s NULLS LAST`, n, n, dir)
			} else {
				orderExpr = fmt.Sprintf(`lower(payload->>$%d) %s NULLS LAST`, n, dir)
			}
		} else {
			col, serr := sanitiseSortColumn(sortBy)
			if serr != nil {
				api.BadRequest(w, serr.Error())
				return
			}
			orderExpr = col + " " + dir
		}

		args = append(args, pageSize, offset)
		listSQL := fmt.Sprintf(`
			SELECT id, source_id, entity_key, payload,
			       (COALESCE(ST_AsText(position)::text, ''))::text AS position_wkt,
			       COALESCE(linked_shape_name, '') AS linked_shape_name,
			       ts, updated_at,
			       COUNT(*) OVER() AS total_count
			FROM data_source_rows
			WHERE %s
			ORDER BY %s, entity_key ASC
			LIMIT $%d OFFSET $%d
		`, where, orderExpr, len(args)-1, len(args))

		rowsQ, qerr := pool.Query(r.Context(), listSQL, args...)
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
		api.JSON(w, http.StatusOK, map[string]any{
			"rows":       out,
			"page":       page,
			"pageSize":   pageSize,
			"totalCount": totalCount,
		})
	}
}

// authedGetRowHandler — GET /tables/{id}/rows/{key}.
func authedGetRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
			return
		}
		key := chi.URLParam(r, "key")
		if key == "" {
			api.BadRequest(w, "empty entity_key")
			return
		}
		row, err := q.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
			SourceID: sourceID, EntityKey: key, TenantID: tenantID,
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

// authedPatchRowHandler — PATCH /tables/{id}/rows/{key}. Partial
// merge — same semantics as the public surface.
func authedPatchRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
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
		existing, err := q.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
			SourceID: sourceID, EntityKey: key, TenantID: tenantID,
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
		fields, err := listFieldDefs(r, q, sourceID, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := validateRowPayload(r, q, tenantID, sourceID, key, mergedBytes, fields); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := q.UpsertDataSourceRow(r.Context(), db.UpsertDataSourceRowParams{
			TenantID:    tenantID,
			SourceID:    sourceID,
			EntityKey:   key,
			Payload:     mergedBytes,
			PositionWkt: existing.PositionWkt,
			Ts:          pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		recordRowEvent(r.Context(), q, tenantID, sourceID, key, mergedBytes, "update", clientIP(r), 0)
		api.JSON(w, http.StatusOK, PublicRowResponse{
			EntityKey: row.EntityKey,
			Payload:   row.Payload,
			Position:  parseWktPoint(row.PositionWkt),
			TS:        api.FormatTime(row.Ts),
			UpdatedAt: api.FormatTime(row.UpdatedAt),
		})
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", sourceID, tenantID)
	}
}

// authedPutRowHandler — PUT /tables/{id}/rows/{key}. Full replace —
// the request payload becomes the row's new payload verbatim (no
// merge). Matches the user's plan: PUT = full replace, PATCH = merge.
// Position is reset to the request's `position` (or cleared if absent).
func authedPutRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
			return
		}
		key := chi.URLParam(r, "key")
		if key == "" {
			api.BadRequest(w, "empty entity_key")
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
		// Ensure the row exists (PUT = replace existing, not create-with-key).
		// We treat PUT as "replace if exists, else 404" — a strict reading.
		// Callers who want upsert semantics use POST /rows.
		if _, err := q.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
			SourceID: sourceID, EntityKey: key, TenantID: tenantID,
		}); err != nil {
			api.NotFound(w, "row not found")
			return
		}
		fields, err := listFieldDefs(r, q, sourceID, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := validateRowPayload(r, q, tenantID, sourceID, key, req.Payload, fields); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		positionWKT := ""
		if req.Position != nil {
			positionWKT = fmt.Sprintf("POINT(%g %g)", req.Position[0], req.Position[1])
		}
		row, err := q.UpsertDataSourceRow(r.Context(), db.UpsertDataSourceRowParams{
			TenantID:    tenantID,
			SourceID:    sourceID,
			EntityKey:   key,
			Payload:     req.Payload,
			PositionWkt: positionWKT,
			Ts:          pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		recordRowEvent(r.Context(), q, tenantID, sourceID, key, req.Payload, "update", clientIP(r), 0)
		api.JSON(w, http.StatusOK, PublicRowResponse{
			EntityKey: row.EntityKey,
			Payload:   row.Payload,
			Position:  parseWktPoint(row.PositionWkt),
			TS:        api.FormatTime(row.Ts),
			UpdatedAt: api.FormatTime(row.UpdatedAt),
		})
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", sourceID, tenantID)
	}
}

// authedDeleteRowHandler — DELETE /tables/{id}/rows/{key}.
func authedDeleteRowHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
			return
		}
		key := chi.URLParam(r, "key")
		if key == "" {
			api.BadRequest(w, "empty entity_key")
			return
		}
		existing, err := q.GetDataSourceRow(r.Context(), db.GetDataSourceRowParams{
			SourceID: sourceID, EntityKey: key, TenantID: tenantID,
		})
		if err != nil {
			api.NotFound(w, "row not found")
			return
		}
		recordRowEvent(r.Context(), q, tenantID, sourceID, key, existing.Payload, "delete", clientIP(r), 0)
		if err := q.DeleteDataSourceRow(r.Context(), db.DeleteDataSourceRowParams{
			SourceID: sourceID, EntityKey: key, TenantID: tenantID,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", sourceID, tenantID)
	}
}

// --------------------------- bulk + filter handlers ---------------------------

// authedBulkUpsertRowsHandler — POST /tables/{id}/rows/bulk.
func authedBulkUpsertRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
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
		fields, err := listFieldDefs(r, q, sourceID, tenantID)
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
		upserted, errs := bulkUpsertRows(r.Context(), q, tx, tenantID, sourceID, 0, req.Rows, fields, clientIP(r))

		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, map[string]any{
			"upserted": upserted,
			"errors":   errs,
		})
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", tenantID)
	}
}

// authedQueryRowsHandler — POST /tables/{id}/rows/query.
func authedQueryRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
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
		compiler := NewFilterCompiler(tenantID, sourceID)
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
		api.JSON(w, http.StatusOK, resp)
	}
}

// authedSchemaHandler — GET /tables/{id}/rows/schema.
func authedSchemaHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
			return
		}
		fields, err := listFieldDefs(r, q, sourceID, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		count, err := q.CountDataSourceRows(r.Context(), db.CountDataSourceRowsParams{
			SourceID: sourceID, TenantID: tenantID,
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
		api.JSON(w, http.StatusOK, map[string]any{
			"fields":   out,
			"rowCount": count,
		})
	}
}

// authedBulkPatchRowsHandler — PATCH /tables/{id}/rows/bulk.
func authedBulkPatchRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
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
		fields, err := listFieldDefs(r, q, sourceID, tenantID)
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
				SourceID: sourceID, EntityKey: item.EntityKey, TenantID: tenantID,
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
			if verr := validateRowPayload(r, qtx, tenantID, sourceID, item.EntityKey, mergedBytes, fields); verr != nil {
				errs = append(errs, map[string]string{"index": strconv.Itoa(i), "error": verr.Error()})
				continue
			}
			if _, err := qtx.UpsertDataSourceRow(r.Context(), db.UpsertDataSourceRowParams{
				TenantID:    tenantID,
				SourceID:    sourceID,
				EntityKey:   item.EntityKey,
				Payload:     mergedBytes,
				PositionWkt: existing.PositionWkt,
				Ts:          pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
			}); err != nil {
				errs = append(errs, map[string]string{"index": strconv.Itoa(i), "error": err.Error()})
				continue
			}
			recordRowEvent(r.Context(), qtx, tenantID, sourceID, item.EntityKey, mergedBytes, "update", clientIP(r), 0)
			updated++
		}
		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, map[string]any{
			"updated": updated,
			"errors":  errs,
		})
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", tenantID)
	}
}

// authedPatchRowsByFilterHandler — PATCH /tables/{id}/rows/by-filter.
func authedPatchRowsByFilterHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
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
		keys, err := keysMatchingFilter(r, pool, tenantID, sourceID, req.Filter, byFilterRowsLimit)
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
		fields, err := listFieldDefs(r, q, sourceID, tenantID)
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
				SourceID: sourceID, EntityKey: key, TenantID: tenantID,
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
			if verr := validateRowPayload(r, qtx, tenantID, sourceID, key, mergedBytes, fields); verr != nil {
				continue
			}
			if _, err := qtx.UpsertDataSourceRow(r.Context(), db.UpsertDataSourceRowParams{
				TenantID:    tenantID,
				SourceID:    sourceID,
				EntityKey:   key,
				Payload:     mergedBytes,
				PositionWkt: existing.PositionWkt,
				Ts:          pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
			}); err != nil {
				continue
			}
			recordRowEvent(r.Context(), qtx, tenantID, sourceID, key, mergedBytes, "update", clientIP(r), 0)
			updated++
		}
		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, map[string]any{"updated": updated})
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", tenantID)
	}
}

// authedBulkDeleteRowsHandler — DELETE /tables/{id}/rows/bulk.
func authedBulkDeleteRowsHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
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
				SourceID: sourceID, EntityKey: key, TenantID: tenantID,
			})
			if err != nil {
				continue
			}
			recordRowEvent(r.Context(), qtx, tenantID, sourceID, key, existing.Payload, "delete", clientIP(r), 0)
			if err := qtx.DeleteDataSourceRow(r.Context(), db.DeleteDataSourceRowParams{
				SourceID: sourceID, EntityKey: key, TenantID: tenantID,
			}); err != nil {
				continue
			}
			deleted++
		}
		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, map[string]any{"deleted": deleted})
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", tenantID)
	}
}

// authedDeleteRowsByFilterHandler — DELETE /tables/{id}/rows/by-filter.
func authedDeleteRowsByFilterHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, sourceID, ok := authedTableContext(w, r, q)
		if !ok {
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
		keys, err := keysMatchingFilter(r, pool, tenantID, sourceID, req.Filter, byFilterRowsLimit)
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
				SourceID: sourceID, EntityKey: key, TenantID: tenantID,
			})
			if err != nil {
				continue
			}
			recordRowEvent(r.Context(), qtx, tenantID, sourceID, key, existing.Payload, "delete", clientIP(r), 0)
			if err := qtx.DeleteDataSourceRow(r.Context(), db.DeleteDataSourceRowParams{
				SourceID: sourceID, EntityKey: key, TenantID: tenantID,
			}); err != nil {
				continue
			}
			deleted++
		}
		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, map[string]any{"deleted": deleted})
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", tenantID)
	}
}

// Ensure pgx / errors imports stay referenced if future edits drop
// the only call sites (the `errors.Is` check in authedTableContext
// could move; keep the build clean).
var _ = errors.Is
var _ = pgx.ErrNoRows

// escapeLike makes user text literal inside an ILIKE pattern, so a search
// for "50%" or "a_b" doesn't act as a wildcard.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
