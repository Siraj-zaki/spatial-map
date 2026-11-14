package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// ---------------- Attribute Definitions ----------------

type AttributeDefinitionRequest struct {
	// Optional warehouse scope. When nil the definition is tenant-shared
	// (visible to every warehouse under the tenant). When set it is only
	// visible to that warehouse.
	ZoneID       *int64          `json:"zoneId"`
	Scope        string          `json:"scope" validate:"required"`
	Key          string          `json:"key" validate:"required"`
	Label        string          `json:"label" validate:"required"`
	Type         string          `json:"type" validate:"required"`
	Unit         string          `json:"unit"`
	EnumValues   []string        `json:"enumValues"`
	DefaultValue json.RawMessage `json:"defaultValue"`
	Description  string          `json:"description"`
}

type AttributeDefinitionResponse struct {
	ID           int64           `json:"id"`
	TenantID     int64           `json:"tenantId"`
	ZoneID       *int64          `json:"zoneId,omitempty"`
	Scope        string          `json:"scope"`
	Key          string          `json:"key"`
	Label        string          `json:"label"`
	Type         string          `json:"type"`
	Unit         string          `json:"unit,omitempty"`
	EnumValues   []string        `json:"enumValues,omitempty"`
	DefaultValue json.RawMessage `json:"defaultValue,omitempty"`
	Description  string          `json:"description,omitempty"`
	CreatedAt    string          `json:"createdAt"`
}

func zoneIDParam(p pgtype.Int8) *int64 {
	if !p.Valid {
		return nil
	}
	return &p.Int64
}

func zoneIDFromReq(z *int64) pgtype.Int8 {
	if z == nil || *z <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *z, Valid: true}
}

func toAttributeDefinitionResponse(row db.AttributeDefinition) AttributeDefinitionResponse {
	return AttributeDefinitionResponse{
		ID:           row.ID,
		TenantID:     row.TenantID,
		ZoneID:       zoneIDParam(row.ZoneID),
		Scope:        row.Scope,
		Key:          row.Key,
		Label:        row.Label,
		Type:         row.Type,
		Unit:         row.Unit.String,
		EnumValues:   row.EnumValues,
		DefaultValue: row.DefaultValue,
		Description:  row.Description.String,
		CreatedAt:    api.FormatTime(row.CreatedAt),
	}
}

// toModel flattens any of the per-query row types into the shared
// `db.AttributeDefinition` model so the response/handler code can stay
// single-typed.
func toModel(r db.CreateAttributeDefinitionRow) db.AttributeDefinition {
	return db.AttributeDefinition{
		ID: r.ID, TenantID: r.TenantID, ZoneID: r.ZoneID, Scope: r.Scope, Key: r.Key,
		Label: r.Label, Type: r.Type, Unit: r.Unit, EnumValues: r.EnumValues,
		DefaultValue: r.DefaultValue, Description: r.Description, CreatedAt: r.CreatedAt,
	}
}

func getModel(r db.GetAttributeDefinitionRow) db.AttributeDefinition {
	return db.AttributeDefinition{
		ID: r.ID, TenantID: r.TenantID, ZoneID: r.ZoneID, Scope: r.Scope, Key: r.Key,
		Label: r.Label, Type: r.Type, Unit: r.Unit, EnumValues: r.EnumValues,
		DefaultValue: r.DefaultValue, Description: r.Description, CreatedAt: r.CreatedAt,
	}
}

func listModel(r db.ListAttributeDefinitionsRow) db.AttributeDefinition {
	return db.AttributeDefinition{
		ID: r.ID, TenantID: r.TenantID, ZoneID: r.ZoneID, Scope: r.Scope, Key: r.Key,
		Label: r.Label, Type: r.Type, Unit: r.Unit, EnumValues: r.EnumValues,
		DefaultValue: r.DefaultValue, Description: r.Description, CreatedAt: r.CreatedAt,
	}
}

func updateModel(r db.UpdateAttributeDefinitionRow) db.AttributeDefinition {
	return db.AttributeDefinition{
		ID: r.ID, TenantID: r.TenantID, ZoneID: r.ZoneID, Scope: r.Scope, Key: r.Key,
		Label: r.Label, Type: r.Type, Unit: r.Unit, EnumValues: r.EnumValues,
		DefaultValue: r.DefaultValue, Description: r.Description, CreatedAt: r.CreatedAt,
	}
}

func attributeDefinitionParams(req AttributeDefinitionRequest, tenantID int64) db.CreateAttributeDefinitionParams {
	return db.CreateAttributeDefinitionParams{
		TenantID:     tenantID,
		ZoneID:       zoneIDFromReq(req.ZoneID),
		Scope:        req.Scope,
		Key:          req.Key,
		Label:        req.Label,
		Type:         req.Type,
		Unit:         pgtype.Text{String: req.Unit, Valid: req.Unit != ""},
		EnumValues:   req.EnumValues,
		DefaultValue: req.DefaultValue,
		Description:  pgtype.Text{String: req.Description, Valid: req.Description != ""},
	}
}

func AttributeDefinitionsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	// Custom list handler: reads ?zoneId=<n> query param so the editor
	// can fetch the catalog visible to a specific warehouse (tenant-shared
	// NULL rows + rows scoped to this warehouse). When zoneId is absent
	// only tenant-shared rows are returned.
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var zoneID pgtype.Int8
		if raw := r.URL.Query().Get("zoneId"); raw != "" {
			if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
				zoneID = pgtype.Int8{Int64: n, Valid: true}
			}
		}
		rows, err := q.ListAttributeDefinitions(r.Context(), db.ListAttributeDefinitionsParams{
			TenantID: tenantID,
			ZoneID:   zoneID,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp := make([]any, len(rows))
		for i, row := range rows {
			resp[i] = toAttributeDefinitionResponse(listModel(row))
		}
		api.JSON(w, http.StatusOK, resp)
	})
	r.Post("/", shapeCreate("attribute_definition", q, func(ctx context.Context, p db.CreateAttributeDefinitionParams) (db.AttributeDefinition, error) {
		row, err := q.CreateAttributeDefinition(ctx, p)
		if err != nil {
			return db.AttributeDefinition{}, err
		}
		return toModel(row), nil
	}, attributeDefinitionParams, func(row db.AttributeDefinition) any { return toAttributeDefinitionResponse(row) }))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("attribute_definition", q, func(ctx context.Context, id, tenantID int64) (db.AttributeDefinition, error) {
			row, err := q.GetAttributeDefinition(ctx, db.GetAttributeDefinitionParams{ID: id, TenantID: tenantID})
			if err != nil {
				return db.AttributeDefinition{}, err
			}
			return getModel(row), nil
		}, func(row db.AttributeDefinition) any { return toAttributeDefinitionResponse(row) }))
		r.Patch("/", shapeUpdate("attribute_definition", q, func(ctx context.Context, p db.UpdateAttributeDefinitionParams) (db.AttributeDefinition, error) {
			row, err := q.UpdateAttributeDefinition(ctx, p)
			if err != nil {
				return db.AttributeDefinition{}, err
			}
			return updateModel(row), nil
		}, func(ctx context.Context, id, tenantID int64) (db.AttributeDefinition, error) {
			row, err := q.GetAttributeDefinition(ctx, db.GetAttributeDefinitionParams{ID: id, TenantID: tenantID})
			if err != nil {
				return db.AttributeDefinition{}, err
			}
			return getModel(row), nil
		}, attributeDefinitionParams, func(row db.AttributeDefinition) any { return toAttributeDefinitionResponse(row) }, func(id, tenantID int64, p db.CreateAttributeDefinitionParams) db.UpdateAttributeDefinitionParams {
			return db.UpdateAttributeDefinitionParams{
				ID: id, TenantID: tenantID,
				ZoneID:       p.ZoneID,
				Scope:        p.Scope,
				Key:          p.Key,
				Label:        p.Label,
				Type:         p.Type,
				Unit:         p.Unit,
				EnumValues:   p.EnumValues,
				DefaultValue: p.DefaultValue,
				Description:  p.Description,
			}
		}))
		r.Delete("/", shapeDelete("attribute_definition", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteAttributeDefinition(ctx, db.DeleteAttributeDefinitionParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}

// ---------------- Style Rules ----------------

type StyleRuleRequest struct {
	Name       string          `json:"name" validate:"required"`
	Scope      string          `json:"scope" validate:"required"`
	ZoneID     *int64          `json:"zoneId"`
	Enabled    bool            `json:"enabled"`
	Priority   int32           `json:"priority"`
	Combine    string          `json:"combine" validate:"required"`
	Conditions json.RawMessage `json:"conditions"`
	Style      json.RawMessage `json:"style"`
}

type StyleRuleResponse struct {
	ID         int64           `json:"id"`
	TenantID   int64           `json:"tenantId"`
	Name       string          `json:"name"`
	Scope      string          `json:"scope"`
	ZoneID     *int64          `json:"zoneId,omitempty"`
	Enabled    bool            `json:"enabled"`
	Priority   int32           `json:"priority"`
	Combine    string          `json:"combine"`
	Conditions json.RawMessage `json:"conditions,omitempty"`
	Style      json.RawMessage `json:"style,omitempty"`
	CreatedAt  string          `json:"createdAt"`
	UpdatedAt  string          `json:"updatedAt"`
}

func toStyleRuleResponse(row db.StyleRule) StyleRuleResponse {
	resp := StyleRuleResponse{
		ID:         row.ID,
		TenantID:   row.TenantID,
		Name:       row.Name,
		Scope:      row.Scope,
		Enabled:    row.Enabled,
		Priority:   row.Priority,
		Combine:    row.Combine,
		Conditions: row.Conditions,
		Style:      row.Style,
		CreatedAt:  api.FormatTime(row.CreatedAt),
		UpdatedAt:  api.FormatTime(row.UpdatedAt),
	}
	setInt64Ptr(&resp.ZoneID, row.ZoneID)
	return resp
}

func StyleRulesRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("style_rules", q, func(ctx context.Context, tenantID int64) ([]db.StyleRule, error) {
		return q.ListStyleRules(ctx, tenantID)
	}, func(row db.StyleRule) any { return toStyleRuleResponse(row) },
		// v5.4 — per-zone filter. `ListStyleRulesByZone` returns
		// tenant-wide rules (scope='tenant') plus rules scoped to
		// this specific zone, so a per-zone fetch still receives
		// rules that would evaluate against the zone's shapes. The
		// caller (shapeList) has already tenant-checked the zone,
		// but the query also filters by tenant_id defensively.
		func(ctx context.Context, zoneID pgtype.Int8) ([]db.StyleRule, error) {
			return q.ListStyleRulesByZone(ctx, db.ListStyleRulesByZoneParams{
				TenantID: api.TenantID(ctx),
				ZoneID:   zoneID,
			})
		},
	))
	r.Post("/", shapeCreate("style_rule", q, func(ctx context.Context, p db.CreateStyleRuleParams) (db.StyleRule, error) {
		return q.CreateStyleRule(ctx, p)
	}, styleRuleParams, func(row db.StyleRule) any { return toStyleRuleResponse(row) }))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("style_rule", q, func(ctx context.Context, id, tenantID int64) (db.StyleRule, error) {
			return q.GetStyleRule(ctx, db.GetStyleRuleParams{ID: id, TenantID: tenantID})
		}, func(row db.StyleRule) any { return toStyleRuleResponse(row) }))
		r.Patch("/", shapeUpdate("style_rule", q, func(ctx context.Context, p db.UpdateStyleRuleParams) (db.StyleRule, error) {
			return q.UpdateStyleRule(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.StyleRule, error) {
			return q.GetStyleRule(ctx, db.GetStyleRuleParams{ID: id, TenantID: tenantID})
		}, styleRuleParams, func(row db.StyleRule) any { return toStyleRuleResponse(row) }, func(id, tenantID int64, p db.CreateStyleRuleParams) db.UpdateStyleRuleParams {
			return db.UpdateStyleRuleParams{
				ID: id, TenantID: tenantID,
				Name:       p.Name,
				Scope:      p.Scope,
				ZoneID:     p.ZoneID,
				Enabled:    p.Enabled,
				Priority:   p.Priority,
				Combine:    p.Combine,
				Conditions: p.Conditions,
				Style:      p.Style,
			}
		}))
		r.Delete("/", shapeDelete("style_rule", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteStyleRule(ctx, db.DeleteStyleRuleParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}

func styleRuleParams(req StyleRuleRequest, tenantID int64) db.CreateStyleRuleParams {
	p := db.CreateStyleRuleParams{
		TenantID:   tenantID,
		Name:       req.Name,
		Scope:      req.Scope,
		Enabled:    req.Enabled,
		Priority:   req.Priority,
		Combine:    req.Combine,
		Conditions: defaultJSONObject(req.Conditions),
		Style:      defaultJSONObject(req.Style),
	}
	if req.ZoneID != nil {
		p.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	return p
}

// ---------------- App Settings ----------------

type AppSettingRequest struct {
	Value json.RawMessage `json:"value" validate:"required"`
}

type AppSettingResponse struct {
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	UpdatedAt string          `json:"updatedAt"`
}

// mayWriteAppSetting refuses writes from a caller with neither a signed-in
// user nor the configured API key (machine access). RequireUserOrAPIKey
// already refuses those on the real router; this keeps the rule when the
// handler is mounted elsewhere.
func mayWriteAppSetting(w http.ResponseWriter, r *http.Request) bool {
	if api.UserID(r.Context()) == 0 && !api.APIKeyCaller(r.Context()) {
		api.Error(w, http.StatusUnauthorized, "sign in required")
		return false
	}
	return true
}

func AppSettingsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		items, err := q.ListAppSettings(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp := make([]AppSettingResponse, len(items))
		for i, item := range items {
			resp[i] = AppSettingResponse{Key: item.Key, Value: item.Value, UpdatedAt: api.FormatTime(item.UpdatedAt)}
		}
		api.JSON(w, http.StatusOK, resp)
	})
	r.Route("/{key}", func(r chi.Router) {
		r.Get("/", func(w http.ResponseWriter, r *http.Request) {
			key := chi.URLParam(r, "key")
			item, err := q.GetAppSetting(r.Context(), key)
			if err != nil {
				if err == pgx.ErrNoRows {
					// A GET-or-nothing lookup like `warehouse:<id>:layerOrder`
					// on a freshly created warehouse: the row legitimately
					// doesn't exist. Reply 200 with a null value so the browser
					// doesn't log a spurious "Failed to load resource: 404" on
					// every editor mount; the frontend already treats a null
					// value as "no saved setting, fall back to defaults".
					api.JSON(w, http.StatusOK, AppSettingResponse{Key: key, Value: nil, UpdatedAt: ""})
					return
				}
				api.InternalError(w, r, err)
				return
			}
			api.JSON(w, http.StatusOK, AppSettingResponse{Key: item.Key, Value: item.Value, UpdatedAt: api.FormatTime(item.UpdatedAt)})
		})
		r.Put("/", func(w http.ResponseWriter, r *http.Request) {
			key := chi.URLParam(r, "key")
			if !mayWriteAppSetting(w, r) {
				return
			}
			var req AppSettingRequest
			if err := api.DecodeBody(r, &req); err != nil {
				api.BadRequest(w, "invalid request body")
				return
			}
			item, err := q.UpsertAppSetting(r.Context(), db.UpsertAppSettingParams{Key: key, Value: req.Value})
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			api.JSON(w, http.StatusOK, AppSettingResponse{Key: item.Key, Value: item.Value, UpdatedAt: api.FormatTime(item.UpdatedAt)})
		})
		r.Delete("/", func(w http.ResponseWriter, r *http.Request) {
			key := chi.URLParam(r, "key")
			if !mayWriteAppSetting(w, r) {
				return
			}
			if err := q.DeleteAppSetting(r.Context(), key); err != nil {
				api.InternalError(w, r, err)
				return
			}
			api.JSON(w, http.StatusNoContent, nil)
		})
	})
	return r
}

// ---------------- Entity References ----------------

type EntityReferenceRequest struct {
	Type           string          `json:"type" validate:"required"`
	SourceKey      string          `json:"sourceKey" validate:"required"`
	TargetKey      string          `json:"targetKey" validate:"required"`
	Label          string          `json:"label"`
	Payload        json.RawMessage `json:"payload"`
	SourceStreamID *int64          `json:"sourceStreamId"`
}

type EntityReferenceResponse struct {
	ID             int64           `json:"id"`
	TenantID       int64           `json:"tenantId"`
	Type           string          `json:"type"`
	SourceKey      string          `json:"sourceKey"`
	TargetKey      string          `json:"targetKey"`
	Label          string          `json:"label,omitempty"`
	Payload        json.RawMessage `json:"payload,omitempty"`
	SourceStreamID *int64          `json:"sourceStreamId,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
}

func toEntityReferenceResponse(row db.EntityReference) EntityReferenceResponse {
	resp := EntityReferenceResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		Type:      row.Type,
		SourceKey: row.SourceKey,
		TargetKey: row.TargetKey,
		Label:     row.Label.String,
		Payload:   row.Payload,
		CreatedAt: api.FormatTime(row.CreatedAt),
		UpdatedAt: api.FormatTime(row.UpdatedAt),
	}
	setInt64Ptr(&resp.SourceStreamID, row.SourceStreamID)
	return resp
}

func entityReferenceParams(req EntityReferenceRequest, tenantID int64) db.CreateEntityReferenceParams {
	p := db.CreateEntityReferenceParams{
		TenantID:  tenantID,
		Type:      req.Type,
		SourceKey: req.SourceKey,
		TargetKey: req.TargetKey,
		Label:     pgtype.Text{String: req.Label, Valid: req.Label != ""},
		Payload:   defaultJSONObject(req.Payload),
	}
	if req.SourceStreamID != nil {
		p.SourceStreamID = pgtype.Int8{Int64: *req.SourceStreamID, Valid: true}
	}
	return p
}

func EntityReferencesRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("entity_references", q, func(ctx context.Context, tenantID int64) ([]db.EntityReference, error) {
		return q.ListEntityReferences(ctx, tenantID)
	}, func(row db.EntityReference) any { return toEntityReferenceResponse(row) }))
	r.Post("/", shapeCreate("entity_reference", q, func(ctx context.Context, p db.CreateEntityReferenceParams) (db.EntityReference, error) {
		return q.CreateEntityReference(ctx, p)
	}, entityReferenceParams, func(row db.EntityReference) any { return toEntityReferenceResponse(row) }))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("entity_reference", q, func(ctx context.Context, id, tenantID int64) (db.EntityReference, error) {
			return q.GetEntityReference(ctx, db.GetEntityReferenceParams{ID: id, TenantID: tenantID})
		}, func(row db.EntityReference) any { return toEntityReferenceResponse(row) }))
		r.Patch("/", shapeUpdate("entity_reference", q, func(ctx context.Context, p db.UpdateEntityReferenceParams) (db.EntityReference, error) {
			return q.UpdateEntityReference(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.EntityReference, error) {
			return q.GetEntityReference(ctx, db.GetEntityReferenceParams{ID: id, TenantID: tenantID})
		}, entityReferenceParams, func(row db.EntityReference) any { return toEntityReferenceResponse(row) }, func(id, tenantID int64, p db.CreateEntityReferenceParams) db.UpdateEntityReferenceParams {
			return db.UpdateEntityReferenceParams{
				ID: id, TenantID: tenantID,
				Type:           p.Type,
				SourceKey:      p.SourceKey,
				TargetKey:      p.TargetKey,
				Label:          p.Label,
				Payload:        p.Payload,
				SourceStreamID: p.SourceStreamID,
			}
		}))
		r.Delete("/", shapeDelete("entity_reference", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteEntityReference(ctx, db.DeleteEntityReferenceParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}

// ---------------- User Models ----------------

type UserModelRequest struct {
	Name           string          `json:"name" validate:"required"`
	MimeType       string          `json:"mimeType" validate:"required"`
	ModelUrl       string          `json:"modelUrl"`
	Data           string          `json:"data"`
	Bytes          int64           `json:"bytes"`
	Category       string          `json:"category"`
	DefaultScale   *float64        `json:"defaultScale"`
	BoundingCenter json.RawMessage `json:"boundingCenter"`
	Inspector      json.RawMessage `json:"inspector"`
	// Facility it was uploaded in (migration 0044); foreign zones → NULL.
	ZoneId *int64 `json:"zoneId"`
	// Inline preview rendered in the browser (data:image/…;base64).
	Thumbnail string `json:"thumbnail" validate:"max=262144"`
}

type UserModelResponse struct {
	ID             int64           `json:"id"`
	TenantID       int64           `json:"tenantId"`
	Name           string          `json:"name"`
	MimeType       string          `json:"mimeType"`
	ModelUrl       string          `json:"modelUrl"`
	Data           string          `json:"data,omitempty"`
	Bytes          int64           `json:"bytes"`
	Category       string          `json:"category,omitempty"`
	DefaultScale   *float64        `json:"defaultScale,omitempty"`
	BoundingCenter json.RawMessage `json:"boundingCenter,omitempty"`
	Inspector      json.RawMessage `json:"inspector,omitempty"`
	ZoneId         *int64          `json:"zoneId,omitempty"`
	Thumbnail      string          `json:"thumbnail,omitempty"`
	CreatedAt      string          `json:"createdAt"`
}

func toUserModelResponse(row db.UserModel) UserModelResponse {
	resp := UserModelResponse{
		ID:             row.ID,
		TenantID:       row.TenantID,
		Name:           row.Name,
		MimeType:       row.MimeType,
		ModelUrl:       row.ModelUrl,
		Bytes:          row.Bytes,
		Category:       row.Category.String,
		BoundingCenter: row.BoundingCenter,
		Inspector:      row.Inspector,
		Thumbnail:      row.Thumbnail,
		CreatedAt:      api.FormatTime(row.CreatedAt),
	}
	if row.ZoneID.Valid {
		zoneID := row.ZoneID.Int64
		resp.ZoneId = &zoneID
	}
	if len(row.Data) > 0 {
		resp.Data = base64.StdEncoding.EncodeToString(row.Data)
	}
	setFloatPtr(&resp.DefaultScale, row.DefaultScale)
	return resp
}

func userModelParams(req UserModelRequest, tenantID int64) db.CreateUserModelParams {
	var data []byte
	if req.Data != "" {
		data, _ = base64.StdEncoding.DecodeString(req.Data)
	}
	p := db.CreateUserModelParams{
		TenantID: tenantID,
		Name:     req.Name,
		MimeType: req.MimeType,
		// Strip any accidental absolute-host prefix so the DB only
		// ever stores the relative `/files/<key>` path — see
		// `store.NormalizeAssetURL` for the rationale.
		ModelUrl:       store.NormalizeAssetURL(req.ModelUrl),
		Data:           data,
		Bytes:          req.Bytes,
		Category:       pgtype.Text{String: req.Category, Valid: req.Category != ""},
		BoundingCenter: defaultJSONObject(req.BoundingCenter),
		Inspector:      defaultJSONObject(req.Inspector),
	}
	if strings.HasPrefix(req.Thumbnail, "data:image/") {
		p.Thumbnail = req.Thumbnail
	}
	if req.ZoneId != nil && *req.ZoneId > 0 {
		p.ZoneID = pgtype.Int8{Int64: *req.ZoneId, Valid: true}
	}
	if req.DefaultScale != nil {
		p.DefaultScale = pgtype.Float8{Float64: *req.DefaultScale, Valid: true}
	}
	return p
}

func uploadUserModel(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
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

		api.JSON(w, http.StatusCreated, map[string]any{
			// Normalize so a misconfigured baseURL (fully-qualified
			// host) can never leak into the JSON we hand back to the
			// client — the client would then round-trip that into the
			// next `POST /user-models` write.
			"url":      store.NormalizeAssetURL(s.URL(key)),
			"mimeType": header.Header.Get("Content-Type"),
			"bytes":    int64(len(data)),
		})
	}
}

// deleteUserModel removes a shared 3D-model catalog entry. Because
// `models.config->>'modelAssetId'` is a JSONB reference (no FK), a naïve
// delete would silently break every placement that pointed at the
// asset. So we count placements first and refuse the delete with a
// `409 Conflict` unless the caller opts in with `?force=true`, in
// which case placements + catalog row + object file all go together.
//
// The `?force=true` variant is what powers the SPA's "Yes, delete
// anyway (N placements)" confirmation. Deleting without force gives
// the frontend a chance to render the confirmation dialog with an
// accurate placement count.
func deleteUserModel(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		row, err := q.GetUserModel(r.Context(), db.GetUserModelParams{ID: id, TenantID: tenantID})
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "user_model not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}

		assetID := "user_" + strconv.FormatInt(id, 10)
		placementCount, err := q.CountModelPlacementsForUserModel(r.Context(), db.CountModelPlacementsForUserModelParams{
			TenantID: tenantID,
			AssetID:  assetID,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		force := r.URL.Query().Get("force") == "true"
		if placementCount > 0 && !force {
			// 409 with a structured body so the SPA can render an
			// accurate "N placements will be deleted — continue?"
			// dialog. Body is written directly (rather than through
			// api.Error) so the placement count survives.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error":          "user_model is in use",
				"placementCount": placementCount,
				"hint":           "re-send with ?force=true to cascade-delete placements",
			})
			return
		}

		if placementCount > 0 {
			if err := q.DeleteModelPlacementsForUserModel(r.Context(), db.DeleteModelPlacementsForUserModelParams{
				TenantID: tenantID,
				AssetID:  assetID,
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}
			// SSE fan-out per broken placement so open editors drop them.
			// We don't know the individual ids after a bulk DELETE, so
			// send a coarse "models" invalidation — matches the pattern
			// zone-delete uses.
			BroadcastEntityEvent("ENTITY_INVALIDATED", "models", 0, tenantID)
		}

		if err := q.DeleteUserModel(r.Context(), db.DeleteUserModelParams{ID: id, TenantID: tenantID}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		// Deleting from the model library is the explicit "remove this
		// upload" action, so once no catalog row in this workspace points
		// at the file, drop the workspace's ownership too — otherwise
		// cleanupObjectURL keeps the object for the (now empty) library.
		if remaining, err := q.CountUserModelsByURL(r.Context(), db.CountUserModelsByURLParams{TenantID: tenantID, ModelUrl: row.ModelUrl}); err == nil && remaining == 0 {
			if key := store.KeyFromURL(row.ModelUrl); key != "" {
				if err := q.DeleteTenantFile(r.Context(), db.DeleteTenantFileParams{TenantID: tenantID, ObjectKey: key}); err != nil {
					slog.WarnContext(r.Context(), "drop model file ownership failed", "key", key, "error", err)
				}
			}
		}
		cleanupObjectURLs(r.Context(), q, s, []string{row.ModelUrl})
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_DELETED", "user-models", id, tenantID)
	}
}

func UserModelsRouter(q *db.Queries, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("user_models", q, func(ctx context.Context, tenantID int64) ([]db.UserModel, error) {
		return q.ListUserModels(ctx, tenantID)
	}, func(row db.UserModel) any { return toUserModelResponse(row) }))
	r.Post("/", shapeCreate("user_model", q, func(ctx context.Context, p db.CreateUserModelParams) (db.UserModel, error) {
		return q.CreateUserModel(ctx, p)
	}, userModelParams, func(row db.UserModel) any { return toUserModelResponse(row) }))
	r.Post("/upload", uploadUserModel(q, s))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("user_model", q, func(ctx context.Context, id, tenantID int64) (db.UserModel, error) {
			return q.GetUserModel(ctx, db.GetUserModelParams{ID: id, TenantID: tenantID})
		}, func(row db.UserModel) any { return toUserModelResponse(row) }))
		r.Patch("/", shapeUpdate("user_model", q, func(ctx context.Context, p db.UpdateUserModelParams) (db.UserModel, error) {
			return q.UpdateUserModel(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.UserModel, error) {
			return q.GetUserModel(ctx, db.GetUserModelParams{ID: id, TenantID: tenantID})
		}, userModelParams, func(row db.UserModel) any { return toUserModelResponse(row) }, func(id, tenantID int64, p db.CreateUserModelParams) db.UpdateUserModelParams {
			return db.UpdateUserModelParams{
				ID: id, TenantID: tenantID,
				Name:           p.Name,
				MimeType:       p.MimeType,
				ModelUrl:       p.ModelUrl,
				Data:           p.Data,
				Bytes:          p.Bytes,
				Category:       p.Category,
				DefaultScale:   p.DefaultScale,
				BoundingCenter: p.BoundingCenter,
				Inspector:      p.Inspector,
				Thumbnail:      p.Thumbnail,
				ZoneID:         p.ZoneID,
			}
		}))
		r.Delete("/", deleteUserModel(q, s))
	})
	return r
}
