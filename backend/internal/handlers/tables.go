// Package handlers — tables.go
//
// Authed CRUD for user-defined "thing type" tables — the third
// ingestion mode alongside file upload and REST polling. The user
// creates a thing type (camera, asset, location, shipping, asn, soh,
// ...) by defining its fields + data types in the SPA, then pushes
// rows into it via per-table REST CRUD endpoints authenticated by a
// scoped `table_api_tokens` bearer token (see table_rows_public.go).
//
// Storage layout: a `data_sources` row with `kind='table'` carries
// name / entity_kind / config. Three sidecars carry the
// per-table-specific bits the generic `data_sources` schema can't
// express:
//   - table_field_definitions — the field schema (key, label, type,
//     is_required, is_unique, sort_order)
//   - data_source_row_events   — append-only history (mirrors
//     entity_events; the time-travel source for the map recap)
//   - table_api_tokens         — scoped write tokens (SHA-256 hashed)
//
// `data_source_rows` is the reusable JSONB row pool keyed by
// (source_id, entity_key) — same table every file/REST source writes
// into. Rows from this kind are tagged `kind='table'` only via the
// parent `data_sources.kind`, not per row.
//
// Delete cascade: FK CASCADE on `table_field_definitions`,
// `data_source_row_events`, `table_api_tokens`, and `data_source_rows`
// all reference `data_sources.id` — deleting the parent row erases
// everything. The handler additionally reuses the data-link-config
// 409 guard so a table still referenced by a warehouse's
// `data_link_configs` cannot be deleted silently.
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

// --------------------------- wire types -----------------------------

// FieldDefinitionRequest — one field definition in the create/update
// payload. `field_key` is immutable on update (rename = remove+add so
// existing rows don't silently lose their data via a key change).
//
// `dataType` describes the value for the editor and the filter DSL; row
// payloads stay JSONB and are not coerced on write. The allow-list below
// mirrors `FieldDataType` in `src/lib/tables-client.ts` — extend both.
type FieldDefinitionRequest struct {
	FieldKey   string `json:"fieldKey" validate:"required,min=1,max=64"`
	FieldLabel string `json:"fieldLabel" validate:"required,min=1,max=128"`
	DataType   string `json:"dataType" validate:"required,oneof=text longtext email url phone uuid number integer boolean date datetime time json"`
	IsRequired bool   `json:"isRequired"`
	IsUnique   bool   `json:"isUnique"`
	SortOrder  int32  `json:"sortOrder"`
}

// CreateTableRequest — POST /tables body.
type CreateTableRequest struct {
	Name       string                   `json:"name" validate:"required,min=1,max=128"`
	EntityKind string                   `json:"entityKind"`
	ZoneID     *int64                   `json:"zoneId"`
	Config     json.RawMessage          `json:"config"`
	Fields     []FieldDefinitionRequest `json:"fields" validate:"required,min=1,dive"`
	TokenLabel string                   `json:"tokenLabel"`
}

// UpdateTableRequest — PATCH /tables/{id} body. `Fields` is the
// COMPLETE new field set — the handler diffs against the existing
// list and applies remove+add for keys that changed (see migration
// comment in table_field_definitions.sql).
type UpdateTableRequest struct {
	Name       *string                   `json:"name"`
	EntityKind *string                   `json:"entityKind"`
	ZoneID     *int64                    `json:"zoneId"`
	Config     json.RawMessage           `json:"config"`
	Fields     *[]FieldDefinitionRequest `json:"fields"`
}

// FieldDefinitionResponse — wire shape for a field definition.
type FieldDefinitionResponse struct {
	ID         int64  `json:"id"`
	SourceID   int64  `json:"sourceId"`
	FieldKey   string `json:"fieldKey"`
	FieldLabel string `json:"fieldLabel"`
	DataType   string `json:"dataType"`
	IsRequired bool   `json:"isRequired"`
	IsUnique   bool   `json:"isUnique"`
	SortOrder  int32  `json:"sortOrder"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

// TableTokenResponse — wire shape for a token. `token` (plaintext) is
// only populated by POST /tables and POST /tables/{id}/tokens — it is
// never returned by any GET.
type TableTokenResponse struct {
	ID         int64  `json:"id"`
	SourceID   int64  `json:"sourceId"`
	Label      string `json:"label"`
	Token      string `json:"token,omitempty"` // plaintext, only on mint
	CreatedAt  string `json:"createdAt"`
	LastUsedAt string `json:"lastUsedAt,omitempty"`
	RevokedAt  string `json:"revokedAt,omitempty"`
}

// TableResponse — wire shape for a thing-type table.
type TableResponse struct {
	DataSource DataSourceResponse        `json:"dataSource"`
	Fields     []FieldDefinitionResponse `json:"fields"`
	Tokens     []TableTokenResponse      `json:"tokens,omitempty"`
	Stats      *TableStats               `json:"stats,omitempty"`
}

// TableStats — what the table actually holds and how data reaches it.
// On GET /tables (where tokens aren't listed) this is the only source
// of key counts: the list once derived "no write token" from the absent
// `tokens` array and flagged every table as unable to receive data.
type TableStats struct {
	Rows          int64  `json:"rows"`
	LastWriteAt   string `json:"lastWriteAt,omitempty"`
	ActiveKeys    int64  `json:"activeKeys"`
	KeyLastUsedAt string `json:"keyLastUsedAt,omitempty"`
	// Polling is true while an external REST pull is configured
	// (config.pollUrl set — see setTableSourceHandler).
	Polling bool `json:"polling"`
}

func rfc3339(ts pgtype.Timestamptz) string {
	if !ts.Valid {
		return ""
	}
	return ts.Time.UTC().Format(time.RFC3339)
}

func tablePolling(src db.DataSource) bool {
	var cfg struct {
		PollURL string `json:"pollUrl"`
	}
	_ = json.Unmarshal(src.Config, &cfg)
	return strings.TrimSpace(cfg.PollURL) != ""
}

// loadTableStats returns per-source activity for the tenant in two
// aggregate queries (not one per table).
func loadTableStats(ctx context.Context, q *db.Queries, tenantID int64) (map[int64]*TableStats, error) {
	out := map[int64]*TableStats{}
	get := func(id int64) *TableStats {
		if out[id] == nil {
			out[id] = &TableStats{}
		}
		return out[id]
	}
	rows, err := q.ListTableRowStats(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		st := get(r.SourceID)
		st.Rows = r.RowCount
		st.LastWriteAt = rfc3339(r.LastWriteAt)
	}
	keys, err := q.ListTableKeyStats(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		st := get(k.SourceID)
		st.ActiveKeys = k.ActiveKeys
		st.KeyLastUsedAt = rfc3339(k.KeyLastUsedAt)
	}
	return out, nil
}

func statsFor(all map[int64]*TableStats, src db.DataSource) *TableStats {
	st := TableStats{}
	if s := all[src.ID]; s != nil {
		st = *s
	}
	st.Polling = tablePolling(src)
	return &st
}

// --------------------------- conversions -----------------------------

func toFieldDefinitionResponse(row db.TableFieldDefinition) FieldDefinitionResponse {
	return FieldDefinitionResponse{
		ID:         row.ID,
		SourceID:   row.SourceID,
		FieldKey:   row.FieldKey,
		FieldLabel: row.FieldLabel,
		DataType:   row.DataType,
		IsRequired: row.IsRequired,
		IsUnique:   row.IsUnique,
		SortOrder:  row.SortOrder,
		CreatedAt:  api.FormatTime(row.CreatedAt),
		UpdatedAt:  api.FormatTime(row.UpdatedAt),
	}
}

func toTableTokenResponse(row db.TableApiToken) TableTokenResponse {
	resp := TableTokenResponse{
		ID:        row.ID,
		SourceID:  row.SourceID,
		Label:     row.Label,
		CreatedAt: api.FormatTime(row.CreatedAt),
	}
	if row.LastUsedAt.Valid {
		resp.LastUsedAt = api.FormatTime(row.LastUsedAt)
	}
	if row.RevokedAt.Valid {
		resp.RevokedAt = api.FormatTime(row.RevokedAt)
	}
	return resp
}

// --------------------------- list / get ------------------------------

// listTablesHandler — GET /tables. Returns the data_sources rows with
// `kind='table'` plus each one's field definitions. Tokens are NOT
// included here — those only show up on the per-table GET.
func listTablesHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sources, err := q.ListDataSources(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		stats, err := loadTableStats(r.Context(), q, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]TableResponse, 0, len(sources))
		for _, src := range sources {
			if src.Kind != db.DataSourceKindTable {
				continue
			}
			fields, err := q.ListTableFieldDefinitions(r.Context(), db.ListTableFieldDefinitionsParams{
				TenantID: tenantID, SourceID: src.ID,
			})
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			fieldResps := make([]FieldDefinitionResponse, 0, len(fields))
			for _, f := range fields {
				fieldResps = append(fieldResps, toFieldDefinitionResponse(f))
			}
			out = append(out, TableResponse{
				DataSource: toDataSourceResponse(src),
				Fields:     fieldResps,
				Stats:      statsFor(stats, src),
			})
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// getTableHandler — GET /tables/{id}. Returns the data_source row,
// its field definitions, AND the active (non-revoked) tokens. The
// SPA's table-detail sheet uses this to render the manage-tokens view.
func getTableHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		src, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		})
		if err != nil {
			api.NotFound(w, "table not found")
			return
		}
		if src.Kind != db.DataSourceKindTable {
			api.NotFound(w, "table not found")
			return
		}
		fields, err := q.ListTableFieldDefinitions(r.Context(), db.ListTableFieldDefinitionsParams{
			TenantID: tenantID, SourceID: sourceID,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		tokens, err := q.ListTableAPITokens(r.Context(), db.ListTableAPITokensParams{
			TenantID: tenantID, SourceID: sourceID,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		fieldResps := make([]FieldDefinitionResponse, 0, len(fields))
		for _, f := range fields {
			fieldResps = append(fieldResps, toFieldDefinitionResponse(f))
		}
		tokenResps := make([]TableTokenResponse, 0, len(tokens))
		for _, t := range tokens {
			tokenResps = append(tokenResps, toTableTokenResponse(t))
		}
		stats, err := loadTableStats(r.Context(), q, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, TableResponse{
			DataSource: toDataSourceResponse(src),
			Fields:     fieldResps,
			Tokens:     tokenResps,
			Stats:      statsFor(stats, src),
		})
	}
}

// --------------------------- create ---------------------------------

// mintTableToken generates a plaintext token, stores its SHA-256 hash,
// and returns (plaintext, response). Plaintext only lives in memory
// for the duration of the request — it's returned to the caller ONCE
// and never persisted. The `sgv_tbl_` prefix lets a future token
// scanner distinguish these from other bearer tokens in accidental
// logs.
func mintTableToken(ctx context.Context, q *db.Queries, tenantID, sourceID int64, label string) (string, TableTokenResponse, error) {
	plaintext := "sgv_tbl_" + generateTokenRandom(32)
	hash := hashTableToken(plaintext)
	row, err := q.CreateTableAPIToken(ctx, db.CreateTableAPITokenParams{
		TenantID: tenantID, SourceID: sourceID,
		TokenHash: hash, Label: label,
	})
	if err != nil {
		return "", TableTokenResponse{}, err
	}
	resp := toTableTokenResponse(row)
	resp.Token = plaintext
	return plaintext, resp, nil
}

// createTableHandler — POST /tables. Creates the data_source row,
// the field definitions, and the first API token in one atomic
// transaction. Returns the full TableResponse including the plaintext
// token (only time the user sees it).
func createTableHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		var req CreateTableRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		// Reject duplicate field_keys at write time — the UNIQUE
		// constraint catches it at the DB level but surfacing it as a
		// 400 (not a 500 from a SQL violation) is what the SPA expects.
		if err := validateUniqueFieldKeys(req.Fields); err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		qtx := q.WithTx(tx)

		// 1. Create the data_source row.
		srcParams := db.CreateDataSourceParams{
			TenantID:   tenantID,
			Name:       req.Name,
			Kind:       db.DataSourceKindTable,
			EntityKind: coerceEntityKind(req.EntityKind),
			Config:     defaultJSONObject(req.Config),
			Mapping:    defaultJSONObject(nil),
			Schedule:   pgtype.Text{},
		}
		if req.ZoneID != nil {
			srcParams.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
		}
		src, err := qtx.CreateDataSource(r.Context(), srcParams)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		// 2. Insert field definitions.
		for i, f := range req.Fields {
			so := f.SortOrder
			if so == 0 {
				so = int32(i)
			}
			if _, err := qtx.CreateTableFieldDefinition(r.Context(), db.CreateTableFieldDefinitionParams{
				TenantID:   tenantID,
				SourceID:   src.ID,
				FieldKey:   f.FieldKey,
				FieldLabel: f.FieldLabel,
				DataType:   f.DataType,
				IsRequired: f.IsRequired,
				IsUnique:   f.IsUnique,
				SortOrder:  so,
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}
		}

		// 3. Mint the first API token.
		label := req.TokenLabel
		if label == "" {
			label = "default"
		}
		_, tokenResp, err := mintTableToken(r.Context(), qtx, tenantID, src.ID, label)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		// 4. Read the field definitions back so the response carries
		// the DB-assigned ids + timestamps.
		fields, err := qtx.ListTableFieldDefinitions(r.Context(), db.ListTableFieldDefinitionsParams{
			TenantID: tenantID, SourceID: src.ID,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		fieldResps := make([]FieldDefinitionResponse, 0, len(fields))
		for _, f := range fields {
			fieldResps = append(fieldResps, toFieldDefinitionResponse(f))
		}

		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}

		api.JSON(w, http.StatusCreated, TableResponse{
			DataSource: toDataSourceResponse(src),
			Fields:     fieldResps,
			Tokens:     []TableTokenResponse{tokenResp},
		})
		// SSE: kind-wide reload so the integrations list refreshes.
		BroadcastEntityKindEvent("ENTITY_CREATED", "data-sources", tenantID)
	}
}

// --------------------------- update ---------------------------------

// updateTableHandler — PATCH /tables/{id}. Updates name / entityKind
// / zoneId / config on the data_source row, AND replaces the field
// definitions if `fields` is present in the patch. Field replacement
// is a delete-all + re-insert in the same tx so the UNIQUE constraint
// can never fire on a stale row.
//
// Tokens are NOT touched here — token mint/revoke has its own
// dedicated endpoints.
func updateTableHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		src, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		})
		if err != nil {
			api.NotFound(w, "table not found")
			return
		}
		if src.Kind != db.DataSourceKindTable {
			api.NotFound(w, "table not found")
			return
		}

		var req UpdateTableRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if req.Fields != nil {
			if err := api.ValidateStruct(req); err != nil {
				api.BadRequest(w, err.Error())
				return
			}
			if err := validateUniqueFieldKeys(*req.Fields); err != nil {
				api.BadRequest(w, err.Error())
				return
			}
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		qtx := q.WithTx(tx)

		// 1. Update the data_source row.
		nextName := src.Name
		if req.Name != nil {
			nextName = *req.Name
		}
		nextEntityKind := src.EntityKind
		if req.EntityKind != nil {
			nextEntityKind = coerceEntityKind(*req.EntityKind)
		}
		nextZoneID := src.ZoneID
		if req.ZoneID != nil {
			nextZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
		}
		nextConfig := src.Config
		if len(req.Config) > 0 {
			nextConfig = defaultJSONObject(req.Config)
		}
		updated, err := qtx.UpdateDataSource(r.Context(), db.UpdateDataSourceParams{
			ID:              sourceID,
			TenantID:        tenantID,
			Name:            nextName,
			Kind:            src.Kind,
			EntityKind:      nextEntityKind,
			ZoneID:          nextZoneID,
			Config:          nextConfig,
			Mapping:         src.Mapping,
			Schedule:        src.Schedule,
			IntervalSeconds: src.IntervalSeconds,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		// 2. Replace field definitions if `fields` was provided. We
		// can't diff against existing rows (the payload JSONB on
		// data_source_rows is opaque) so a key change is treated as
		// remove+add — existing rows keep the orphan key in their
		// payload (no in-place migration); the field just disappears
		// from the schema. This matches the contract documented in
		// table_field_definitions.sql.
		var fieldResps []FieldDefinitionResponse
		if req.Fields != nil {
			if err := qtx.DeleteTableFieldDefinitionsBySource(r.Context(), db.DeleteTableFieldDefinitionsBySourceParams{
				SourceID: sourceID, TenantID: tenantID,
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}
			for i, f := range *req.Fields {
				so := f.SortOrder
				if so == 0 {
					so = int32(i)
				}
				if _, err := qtx.CreateTableFieldDefinition(r.Context(), db.CreateTableFieldDefinitionParams{
					TenantID:   tenantID,
					SourceID:   sourceID,
					FieldKey:   f.FieldKey,
					FieldLabel: f.FieldLabel,
					DataType:   f.DataType,
					IsRequired: f.IsRequired,
					IsUnique:   f.IsUnique,
					SortOrder:  so,
				}); err != nil {
					api.InternalError(w, r, err)
					return
				}
			}
			fields, err := qtx.ListTableFieldDefinitions(r.Context(), db.ListTableFieldDefinitionsParams{
				TenantID: tenantID, SourceID: sourceID,
			})
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			fieldResps = make([]FieldDefinitionResponse, 0, len(fields))
			for _, f := range fields {
				fieldResps = append(fieldResps, toFieldDefinitionResponse(f))
			}
		} else {
			fields, _ := q.ListTableFieldDefinitions(r.Context(), db.ListTableFieldDefinitionsParams{
				TenantID: tenantID, SourceID: sourceID,
			})
			fieldResps = make([]FieldDefinitionResponse, 0, len(fields))
			for _, f := range fields {
				fieldResps = append(fieldResps, toFieldDefinitionResponse(f))
			}
		}

		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}

		api.JSON(w, http.StatusOK, TableResponse{
			DataSource: toDataSourceResponse(updated),
			Fields:     fieldResps,
		})
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", sourceID, tenantID)
	}
}

// --------------------------- delete ---------------------------------

// deleteTableHandler — DELETE /tables/{id}. Reuses the
// `deleteDataSourceMirror` 409 guard so a table still referenced by a
// warehouse's `data_link_configs` cannot be deleted silently. FK
// CASCADE on the sidecar tables + data_source_rows means deleting the
// parent row erases everything else.
func deleteTableHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		src, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		})
		if err != nil {
			api.NotFound(w, "table not found")
			return
		}
		if src.Kind != db.DataSourceKindTable {
			api.NotFound(w, "table not found")
			return
		}
		// Reuse the data-source delete guard: refuses if any
		// data_link_configs reference this source (directly OR via a
		// mirror stream). Same 409 envelope shape the integrations
		// page already parses.
		if blocked, _ := dataSourceLinkedConfigsExist(r.Context(), q, tenantID, sourceID); blocked {
			api.Error(w, http.StatusConflict, "table is referenced by one or more data-link configs")
			return
		}
		if err := q.DeleteDataSource(r.Context(), db.DeleteDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_DELETED", "data-sources", sourceID, tenantID)
	}
}

// --------------------------- token sub-routes -----------------------

// createTableTokenHandler — POST /tables/{id}/tokens. Mints another
// token for the table. Returns the plaintext once.
func createTableTokenHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		src, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		})
		if err != nil || src.Kind != db.DataSourceKindTable {
			api.NotFound(w, "table not found")
			return
		}
		var req struct {
			Label string `json:"label"`
		}
		_ = api.DecodeBody(r, &req)
		label := req.Label
		if label == "" {
			label = "token-" + strconv.FormatInt(time.Now().Unix(), 10)
		}
		_, tokenResp, err := mintTableToken(r.Context(), q, tenantID, sourceID, label)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, tokenResp)
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", sourceID, tenantID)
	}
}

// revokeTableTokenHandler — DELETE /tables/{id}/tokens/{tokenId}.
// Non-destructive: sets `revoked_at = now()`. The audit trail in
// `data_source_row_events` (referencing `auth_token_id`) survives.
func revokeTableTokenHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		tokenID, err := strconv.ParseInt(chi.URLParam(r, "tokenId"), 10, 64)
		if err != nil {
			api.BadRequest(w, "invalid token id")
			return
		}
		if err := q.RevokeTableAPIToken(r.Context(), db.RevokeTableAPITokenParams{
			ID: tokenID, TenantID: tenantID, SourceID: sourceID,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", sourceID, tenantID)
	}
}

// --------------------------- history --------------------------------

// listTableEventsHandler — GET /tables/{id}/events?window=86400&limit=500.
// Returns append-only history events for the table (all rows). Used
// by the SPA's history viewer + the map recap animation.
func listTableEventsHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		if _, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		}); err != nil {
			api.NotFound(w, "table not found")
			return
		}
		windowSec := int64(86400) // default 24h
		if v := r.URL.Query().Get("window"); v != "" {
			if parsed, err := strconv.ParseInt(v, 10, 64); err == nil && parsed > 0 && parsed <= 30*86400 {
				windowSec = parsed
			}
		}
		limit := int32(500)
		if v := r.URL.Query().Get("limit"); v != "" {
			if parsed, err := strconv.ParseInt(v, 10, 32); err == nil && parsed > 0 && parsed <= 5000 {
				limit = int32(parsed)
			}
		}
		since := time.Now().UTC().Add(-time.Duration(windowSec) * time.Second)
		rows, err := q.ListDataSourceRowEventsBySource(r.Context(), db.ListDataSourceRowEventsBySourceParams{
			SourceID: sourceID, TenantID: tenantID,
			Ts:    pgtype.Timestamptz{Time: since, Valid: true},
			Limit: limit,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]dataSourceRowEventResponse, 0, len(rows))
		for _, e := range rows {
			out = append(out, toDataSourceRowEventResponse(e))
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// listTableRowEventsHandler — GET /tables/{id}/events/{key}. Per-row
// history trail — the per-row history view the user opens from the
// map popup to see one item's life cycle.
func listTableRowEventsHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		entityKey := chi.URLParam(r, "key")
		if entityKey == "" {
			api.BadRequest(w, "empty entity_key")
			return
		}
		if _, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		}); err != nil {
			api.NotFound(w, "table not found")
			return
		}
		limit := int32(500)
		if v := r.URL.Query().Get("limit"); v != "" {
			if parsed, err := strconv.ParseInt(v, 10, 32); err == nil && parsed > 0 && parsed <= 5000 {
				limit = int32(parsed)
			}
		}
		// Per-row trail defaults to ALL events for the key (no
		// window) — the user explicitly asked for this row.
		rows, err := q.ListDataSourceRowEventsForKey(r.Context(), db.ListDataSourceRowEventsForKeyParams{
			SourceID: sourceID, EntityKey: entityKey, TenantID: tenantID,
			Ts:    pgtype.Timestamptz{Time: time.Unix(0, 0).UTC(), Valid: true},
			Limit: limit,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]dataSourceRowEventResponse, 0, len(rows))
		for _, e := range rows {
			out = append(out, toDataSourceRowEventResponse(e))
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// buildTableResponse bundles a data_source row + its field defs + its
// active tokens into the wire shape the SPA expects. Returns (resp,
// false) if any sub-query failed — caller treats that as an internal
// error since the source row was already verified to exist.
func buildTableResponse(ctx context.Context, q *db.Queries, src db.DataSource) (TableResponse, bool) {
	fields, err := q.ListTableFieldDefinitions(ctx, db.ListTableFieldDefinitionsParams{
		TenantID: src.TenantID, SourceID: src.ID,
	})
	if err != nil {
		return TableResponse{}, false
	}
	tokens, err := q.ListTableAPITokens(ctx, db.ListTableAPITokensParams{
		TenantID: src.TenantID, SourceID: src.ID,
	})
	if err != nil {
		return TableResponse{}, false
	}
	fieldResps := make([]FieldDefinitionResponse, 0, len(fields))
	for _, f := range fields {
		fieldResps = append(fieldResps, toFieldDefinitionResponse(f))
	}
	tokenResps := make([]TableTokenResponse, 0, len(tokens))
	for _, t := range tokens {
		tokenResps = append(tokenResps, toTableTokenResponse(t))
	}
	return TableResponse{
		DataSource: toDataSourceResponse(src),
		Fields:     fieldResps,
		Tokens:     tokenResps,
	}, true
}

// --------------------------- external source polling ----------------

// TableSourceConfigRequest — body for POST /tables/{id}/source. Sets
// the external REST polling binding on a table-kind source. Empty
// `pollUrl` is the signal to stop polling — the worker skips sources
// whose config->>'pollUrl' is null/empty, and the handler also nulls
// `interval_seconds` so a "paused" config doesn't keep matching
// `ListPollableTableSources` on a stale interval.
type TableSourceConfigRequest struct {
	PollURL              string            `json:"pollUrl"`
	PollHeaders          map[string]string `json:"pollHeaders,omitempty"`
	PollJSONPath         string            `json:"pollJsonPath,omitempty"`
	PollEntityKeyField   string            `json:"pollEntityKeyField,omitempty"`
	PollFieldMapping     map[string]string `json:"pollFieldMapping,omitempty"`
	PollPositionLatField string            `json:"pollPositionLatField,omitempty"`
	PollPositionLngField string            `json:"pollPositionLngField,omitempty"`
	IntervalSeconds      int32             `json:"intervalSeconds"`
}

// setTableSourceHandler — POST /tables/{id}/source. Writes the
// external-polling binding into `data_sources.config` (JSONB) +
// `interval_seconds`. The worker picks it up on its next tick (60s).
// Returns the updated TableResponse so the SPA can render the new
// `lastRunAt` / `lastResult` fields without a separate fetch.
func setTableSourceHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		var req TableSourceConfigRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		// Fetch existing row to (a) verify it's table-kind + tenanted
		// and (b) preserve any non-polling config the SPA isn't aware of.
		existing, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		})
		if err != nil {
			api.NotFound(w, "table not found")
			return
		}
		if existing.Kind != "table" {
			api.BadRequest(w, "source is not a table-kind data source")
			return
		}
		// Build the new config: start from the existing config's
		// non-poll keys (preserves anything the SPA didn't send),
		// then overwrite the poll* keys. If pollUrl is empty, treat
		// it as "clear the binding" and drop the poll* keys entirely.
		cfg := map[string]any{}
		if len(existing.Config) > 0 {
			_ = json.Unmarshal(existing.Config, &cfg)
		}
		// Strip any prior poll* keys so a re-POST with a subset doesn't
		// leave stale fields behind.
		for k := range cfg {
			if strings.HasPrefix(k, "poll") {
				delete(cfg, k)
			}
		}
		var interval pgtype.Int4
		if req.PollURL != "" {
			cfg["pollUrl"] = req.PollURL
			if req.PollHeaders != nil {
				cfg["pollHeaders"] = req.PollHeaders
			}
			if req.PollJSONPath != "" {
				cfg["pollJsonPath"] = req.PollJSONPath
			}
			if req.PollEntityKeyField != "" {
				cfg["pollEntityKeyField"] = req.PollEntityKeyField
			}
			if req.PollFieldMapping != nil {
				cfg["pollFieldMapping"] = req.PollFieldMapping
			}
			if req.PollPositionLatField != "" {
				cfg["pollPositionLatField"] = req.PollPositionLatField
			}
			if req.PollPositionLngField != "" {
				cfg["pollPositionLngField"] = req.PollPositionLngField
			}
			if req.IntervalSeconds > 0 {
				interval.Valid = true
				interval.Int32 = req.IntervalSeconds
			}
		}
		// If pollUrl is empty, interval stays zero → worker won't pick
		// this source up regardless of any prior interval_seconds value.
		cfgJSON, err := json.Marshal(cfg)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		updated, err := q.UpdateTableSourceConfig(r.Context(), db.UpdateTableSourceConfigParams{
			ID: sourceID, TenantID: tenantID,
			Config:          cfgJSON,
			IntervalSeconds: interval,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		// Reuse the existing getTableHandler pipeline so the response
		// shape matches the SPA's `TableResponse` (fields + tokens).
		resp, ok := buildTableResponse(r.Context(), q, updated)
		if !ok {
			api.InternalError(w, r, fmt.Errorf("table vanished after update: %d", sourceID))
			return
		}
		api.JSON(w, http.StatusOK, resp)
		// Broadcast a kind-wide SSE so any open Integrations page refetches.
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", tenantID)
	}
}

// getTableSourceHandler — GET /tables/{id}/source. Returns the
// polling config extracted from `data_sources.config` (so the SPA
// doesn't have to parse the raw JSONB) + `interval_seconds` +
// `last_run_at` + `last_result` for the integrations panel's
// status display.
func getTableSourceHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		src, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		})
		if err != nil {
			api.NotFound(w, "table not found")
			return
		}
		if src.Kind != "table" {
			api.BadRequest(w, "source is not a table-kind data source")
			return
		}
		out := map[string]any{
			"pollUrl":              "",
			"pollHeaders":          map[string]string{},
			"pollJsonPath":         "",
			"pollEntityKeyField":   "",
			"pollFieldMapping":     map[string]string{},
			"pollPositionLatField": "",
			"pollPositionLngField": "",
			"intervalSeconds":      0,
			"lastRunAt":            api.FormatTime(src.LastRunAt),
			"lastResult":           src.LastResult.String,
		}
		if len(src.Config) > 0 {
			var cfg map[string]any
			if err := json.Unmarshal(src.Config, &cfg); err == nil {
				for k, v := range cfg {
					if !strings.HasPrefix(k, "poll") {
						continue
					}
					out[k] = v
				}
			}
		}
		if src.IntervalSeconds.Valid {
			out["intervalSeconds"] = src.IntervalSeconds.Int32
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// clearTableSourceHandler — DELETE /tables/{id}/source. Stops
// polling by clearing the poll* keys from config and nulling
// interval_seconds. The next worker tick will skip this source.
func clearTableSourceHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid table id")
			return
		}
		// Fetch existing to preserve non-poll config keys.
		existing, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		})
		if err != nil {
			api.NotFound(w, "table not found")
			return
		}
		if existing.Kind != "table" {
			api.BadRequest(w, "source is not a table-kind data source")
			return
		}
		cfg := map[string]any{}
		if len(existing.Config) > 0 {
			_ = json.Unmarshal(existing.Config, &cfg)
		}
		for k := range cfg {
			if strings.HasPrefix(k, "poll") {
				delete(cfg, k)
			}
		}
		cfgJSON, err := json.Marshal(cfg)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		updated, err := q.UpdateTableSourceConfig(r.Context(), db.UpdateTableSourceConfigParams{
			ID: sourceID, TenantID: tenantID,
			Config:          cfgJSON,
			IntervalSeconds: pgtype.Int4{},
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp, ok := buildTableResponse(r.Context(), q, updated)
		if !ok {
			api.InternalError(w, r, fmt.Errorf("table vanished after update: %d", sourceID))
			return
		}
		api.JSON(w, http.StatusOK, resp)
		BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", tenantID)
	}
}

// --------------------------- router --------------------------------

// TablesRouter wires the authed CRUD for thing-type tables. Mounted
// at `/api/v1/tables` inside the tenant-scoped group.
func TablesRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listTablesHandler(q))
	r.Post("/", createTableHandler(q, pool))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", getTableHandler(q))
		r.Patch("/", updateTableHandler(q, pool))
		r.Delete("/", deleteTableHandler(q, pool))
		r.Post("/tokens", createTableTokenHandler(q))
		r.Delete("/tokens/{tokenId}", revokeTableTokenHandler(q))
		r.Get("/events", listTableEventsHandler(q))
		r.Get("/events/{key}", listTableRowEventsHandler(q))

		// External source polling — set/get/clear the REST polling
		// binding stored in `data_sources.config` JSONB. The polling
		// worker reads this on its next tick (60s) to start/stop
		// polling this table.
		r.Get("/source", getTableSourceHandler(q))
		r.Post("/source", setTableSourceHandler(q))
		r.Delete("/source", clearTableSourceHandler(q))

		// Authed row CRUD — mirrors the public /api/v1/public/tables surface
		// but authenticates via JWT + TenantMiddleware instead of a bearer
		// table token. The SPA uses these routes for its own data grid + history
		// viewer because it doesn't have the plaintext table token after mint.
		// Literal paths (`/bulk`, `/query`, `/schema`, `/by-filter`) are
		// mounted BEFORE `{key}` so chi matches literals first.
		r.Route("/rows", func(r chi.Router) {
			r.Post("/", authedUpsertRowHandler(q))
			r.Post("/bulk", authedBulkUpsertRowsHandler(q, pool))
			r.Post("/query", authedQueryRowsHandler(q, pool))
			r.Get("/schema", authedSchemaHandler(q))
			r.Patch("/bulk", authedBulkPatchRowsHandler(q, pool))
			r.Patch("/by-filter", authedPatchRowsByFilterHandler(q, pool))
			r.Delete("/bulk", authedBulkDeleteRowsHandler(q, pool))
			r.Delete("/by-filter", authedDeleteRowsByFilterHandler(q, pool))

			r.Get("/", authedListRowsHandler(q, pool))
			r.Get("/{key}", authedGetRowHandler(q))
			r.Patch("/{key}", authedPatchRowHandler(q))
			r.Put("/{key}", authedPutRowHandler(q))
			r.Delete("/{key}", authedDeleteRowHandler(q))
		})
	})
	return r
}

// --------------------------- helpers --------------------------------

// validateUniqueFieldKeys rejects duplicate field_keys at write time
// — the UNIQUE constraint catches it at the DB level but surfacing
// it as a 400 (not a 500 from a SQL violation) is what the SPA expects.
func validateUniqueFieldKeys(fields []FieldDefinitionRequest) error {
	seen := make(map[string]bool, len(fields))
	for _, f := range fields {
		if seen[f.FieldKey] {
			return fmt.Errorf("duplicate field_key: %q", f.FieldKey)
		}
		seen[f.FieldKey] = true
	}
	return nil
}

// dataSourceLinkedConfigsExist returns true if any data_link_configs
// reference this source directly OR via a mirror stream. Reuses the
// existing query the data-source delete guard uses — same 409 shape.
func dataSourceLinkedConfigsExist(ctx context.Context, q *db.Queries, tenantID, sourceID int64) (bool, error) {
	refs, err := q.ListDataLinkConfigRefsForSource(ctx, db.ListDataLinkConfigRefsForSourceParams{
		TenantID: tenantID,
		SourceID: pgtype.Int8{Int64: sourceID, Valid: true},
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	return len(refs) > 0, nil
}
