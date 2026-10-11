package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// ---------------- Correlation Rules ----------------

type CorrelationRuleRequest struct {
	Name       string          `json:"name" validate:"required"`
	Enabled    bool            `json:"enabled"`
	Trigger    json.RawMessage `json:"trigger"`
	Action     json.RawMessage `json:"action"`
	CooldownMs int64           `json:"cooldownMs"`
}

type CorrelationRuleResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Enabled     bool            `json:"enabled"`
	Trigger     json.RawMessage `json:"trigger,omitempty"`
	Action      json.RawMessage `json:"action,omitempty"`
	CooldownMs  int64           `json:"cooldownMs"`
	LastFiredAt string          `json:"lastFiredAt,omitempty"`
	FireCount   int64           `json:"fireCount"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func toCorrelationRuleResponse(row db.CorrelationRule) CorrelationRuleResponse {
	resp := CorrelationRuleResponse{
		ID:         row.ID,
		TenantID:   row.TenantID,
		Name:       row.Name,
		Enabled:    row.Enabled,
		Trigger:    row.Trigger,
		Action:     row.Action,
		CooldownMs: row.CooldownMs,
		FireCount:  row.FireCount,
		CreatedAt:  api.FormatTime(row.CreatedAt),
		UpdatedAt:  api.FormatTime(row.UpdatedAt),
	}
	if row.LastFiredAt.Valid {
		resp.LastFiredAt = api.FormatTime(row.LastFiredAt)
	}
	return resp
}

func correlationRuleParams(req CorrelationRuleRequest, tenantID int64) db.CreateCorrelationRuleParams {
	cooldown := req.CooldownMs
	if cooldown == 0 {
		cooldown = 5000
	}
	return db.CreateCorrelationRuleParams{
		TenantID:   tenantID,
		Name:       req.Name,
		Enabled:    req.Enabled,
		Trigger:    defaultJSONObject(req.Trigger),
		Action:     defaultJSONObject(req.Action),
		CooldownMs: cooldown,
	}
}

func toUpdateCorrelationRuleParams(id, tenantID int64, p db.CreateCorrelationRuleParams) db.UpdateCorrelationRuleParams {
	return db.UpdateCorrelationRuleParams{
		ID:         id,
		TenantID:   tenantID,
		Name:       p.Name,
		Enabled:    p.Enabled,
		Trigger:    p.Trigger,
		Action:     p.Action,
		CooldownMs: p.CooldownMs,
	}
}

func CorrelationRulesRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("correlation_rules", q, func(ctx context.Context, tenantID int64) ([]db.CorrelationRule, error) {
		return q.ListCorrelationRules(ctx, tenantID)
	}, func(row db.CorrelationRule) any { return toCorrelationRuleResponse(row) }))
	r.Post("/", shapeCreate("correlation_rule", q, func(ctx context.Context, p db.CreateCorrelationRuleParams) (db.CorrelationRule, error) {
		return q.CreateCorrelationRule(ctx, p)
	}, correlationRuleParams, func(row db.CorrelationRule) any { return toCorrelationRuleResponse(row) }))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("correlation_rule", q, func(ctx context.Context, id, tenantID int64) (db.CorrelationRule, error) {
			return q.GetCorrelationRule(ctx, db.GetCorrelationRuleParams{ID: id, TenantID: tenantID})
		}, func(row db.CorrelationRule) any { return toCorrelationRuleResponse(row) }))
		r.Patch("/", shapeUpdate("correlation_rule", q, func(ctx context.Context, p db.UpdateCorrelationRuleParams) (db.CorrelationRule, error) {
			return q.UpdateCorrelationRule(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.CorrelationRule, error) {
			return q.GetCorrelationRule(ctx, db.GetCorrelationRuleParams{ID: id, TenantID: tenantID})
		}, correlationRuleParams, func(row db.CorrelationRule) any { return toCorrelationRuleResponse(row) }, toUpdateCorrelationRuleParams))
		r.Delete("/", shapeDelete("correlation_rule", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteCorrelationRule(ctx, db.DeleteCorrelationRuleParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}

// ---------------- Alerts ----------------

type AlertRequest struct {
	RuleID    *int64 `json:"ruleId"`
	RuleName  string `json:"ruleName" validate:"required"`
	Level     string `json:"level" validate:"required"`
	Message   string `json:"message" validate:"required"`
	EntityRef string `json:"entityRef"`
	Ts        string `json:"ts" validate:"required"`
}

type AlertResponse struct {
	ID             int64  `json:"id"`
	TenantID       int64  `json:"tenantId"`
	RuleID         *int64 `json:"ruleId,omitempty"`
	RuleName       string `json:"ruleName"`
	Level          string `json:"level"`
	Message        string `json:"message"`
	EntityRef      string `json:"entityRef,omitempty"`
	Ts             string `json:"ts"`
	Acknowledged   bool   `json:"acknowledged"`
	AcknowledgedAt string `json:"acknowledgedAt,omitempty"`
}

func toAlertResponse(row db.Alert) AlertResponse {
	resp := AlertResponse{
		ID:           row.ID,
		TenantID:     row.TenantID,
		RuleName:     row.RuleName,
		Level:        string(row.Level),
		Message:      row.Message,
		Ts:           api.FormatTime(row.Ts),
		Acknowledged: row.Acknowledged,
	}
	setInt64Ptr(&resp.RuleID, row.RuleID)
	if row.EntityRef.Valid {
		resp.EntityRef = row.EntityRef.String
	}
	if row.AcknowledgedAt.Valid {
		resp.AcknowledgedAt = api.FormatTime(row.AcknowledgedAt)
	}
	return resp
}

func alertParams(req AlertRequest, tenantID int64) db.CreateAlertParams {
	p := db.CreateAlertParams{
		TenantID:  tenantID,
		RuleName:  req.RuleName,
		Level:     db.AlertLevel(req.Level),
		Message:   req.Message,
		EntityRef: pgtype.Text{String: req.EntityRef, Valid: req.EntityRef != ""},
	}
	if req.RuleID != nil {
		p.RuleID = pgtype.Int8{Int64: *req.RuleID, Valid: true}
	}
	if req.Ts != "" {
		if t, err := time.Parse(time.RFC3339, req.Ts); err == nil {
			p.Ts = pgtype.Timestamptz{Time: t, Valid: true}
		}
	}
	return p
}

func toUpdateAlertParams(id, tenantID int64, p db.CreateAlertParams) db.UpdateAlertParams {
	return db.UpdateAlertParams{
		ID:             id,
		TenantID:       tenantID,
		RuleID:         p.RuleID,
		RuleName:       p.RuleName,
		Level:          p.Level,
		Message:        p.Message,
		EntityRef:      p.EntityRef,
		Ts:             p.Ts,
		Acknowledged:   false,
		AcknowledgedAt: pgtype.Timestamptz{},
	}
}

func AlertsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("alerts", q, func(ctx context.Context, tenantID int64) ([]db.Alert, error) {
		return q.ListAlerts(ctx, tenantID)
	}, func(row db.Alert) any { return toAlertResponse(row) }))
	r.Post("/", shapeCreate("alert", q, func(ctx context.Context, p db.CreateAlertParams) (db.Alert, error) {
		return q.CreateAlert(ctx, p)
	}, alertParams, func(row db.Alert) any { return toAlertResponse(row) }))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("alert", q, func(ctx context.Context, id, tenantID int64) (db.Alert, error) {
			return q.GetAlert(ctx, db.GetAlertParams{ID: id, TenantID: tenantID})
		}, func(row db.Alert) any { return toAlertResponse(row) }))
		r.Patch("/", shapeUpdate("alert", q, func(ctx context.Context, p db.UpdateAlertParams) (db.Alert, error) {
			return q.UpdateAlert(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.Alert, error) {
			return q.GetAlert(ctx, db.GetAlertParams{ID: id, TenantID: tenantID})
		}, alertParams, func(row db.Alert) any { return toAlertResponse(row) }, toUpdateAlertParams))
		r.Delete("/", shapeDelete("alert", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteAlert(ctx, db.DeleteAlertParams{ID: id, TenantID: tenantID})
		}))
		r.Post("/acknowledge", acknowledgeAlert(q))
	})
	return r
}

func acknowledgeAlert(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid alert id")
			return
		}
		tenantID := api.TenantID(r.Context())
		row, err := q.GetAlert(r.Context(), db.GetAlertParams{ID: id, TenantID: tenantID})
		if err != nil {
			if err.Error() == "no rows in result set" {
				api.NotFound(w, "alert not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		updated, err := q.UpdateAlert(r.Context(), db.UpdateAlertParams{
			ID:             id,
			TenantID:       tenantID,
			RuleID:         row.RuleID,
			RuleName:       row.RuleName,
			Level:          row.Level,
			Message:        row.Message,
			EntityRef:      row.EntityRef,
			Ts:             row.Ts,
			Acknowledged:   true,
			AcknowledgedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, toAlertResponse(updated))
		BroadcastEntityEvent("ENTITY_UPDATED", "alerts", updated.ID, tenantID)
	}
}

// ---------------- Audit Log ----------------

type AuditLogRequest struct {
	StreamID   *int64          `json:"streamId"`
	EntityType string          `json:"entityType" validate:"required"`
	EntityKey  string          `json:"entityKey" validate:"required"`
	URL        string          `json:"url" validate:"required"`
	Method     string          `json:"method" validate:"required"`
	Before     json.RawMessage `json:"before"`
	After      json.RawMessage `json:"after"`
	Status     string          `json:"status" validate:"required"`
	HTTPStatus *int32          `json:"httpStatus"`
	Message    string          `json:"message"`
	Ts         string          `json:"ts"`
}

type AuditLogResponse struct {
	ID         int64           `json:"id"`
	TenantID   int64           `json:"tenantId"`
	StreamID   *int64          `json:"streamId,omitempty"`
	EntityType string          `json:"entityType"`
	EntityKey  string          `json:"entityKey"`
	URL        string          `json:"url"`
	Method     string          `json:"method"`
	Before     json.RawMessage `json:"before,omitempty"`
	After      json.RawMessage `json:"after,omitempty"`
	Status     string          `json:"status"`
	HTTPStatus *int32          `json:"httpStatus,omitempty"`
	Message    string          `json:"message,omitempty"`
	Ts         string          `json:"ts"`
}

func toAuditLogResponse(row db.AuditLog) AuditLogResponse {
	resp := AuditLogResponse{
		ID:         row.ID,
		TenantID:   row.TenantID,
		EntityType: row.EntityType,
		EntityKey:  row.EntityKey,
		URL:        row.Url,
		Method:     row.Method,
		Before:     row.Before,
		After:      row.After,
		Status:     row.Status,
		Ts:         api.FormatTime(row.Ts),
	}
	setInt64Ptr(&resp.StreamID, row.StreamID)
	setInt32Ptr(&resp.HTTPStatus, row.HttpStatus)
	if row.Message.Valid {
		resp.Message = row.Message.String
	}
	return resp
}

func auditLogParams(req AuditLogRequest, tenantID int64) db.CreateAuditLogEntryParams {
	p := db.CreateAuditLogEntryParams{
		TenantID:   tenantID,
		EntityType: req.EntityType,
		EntityKey:  req.EntityKey,
		Url:        req.URL,
		Method:     req.Method,
		Before:     defaultJSONObject(req.Before),
		After:      defaultJSONObject(req.After),
		Status:     req.Status,
		Message:    pgtype.Text{String: req.Message, Valid: req.Message != ""},
	}
	if req.StreamID != nil {
		p.StreamID = pgtype.Int8{Int64: *req.StreamID, Valid: true}
	}
	if req.HTTPStatus != nil {
		p.HttpStatus = pgtype.Int4{Int32: *req.HTTPStatus, Valid: true}
	}
	if req.Ts != "" {
		if t, err := time.Parse(time.RFC3339, req.Ts); err == nil {
			p.Ts = pgtype.Timestamptz{Time: t, Valid: true}
		}
	} else {
		p.Ts = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	}
	return p
}

func AuditLogRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		items, err := q.ListAuditLogEntries(r.Context(), db.ListAuditLogEntriesParams{
			TenantID: api.TenantID(r.Context()),
			Limit:    int32(api.IntQuery(r, "limit", 100)),
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp := make([]any, len(items))
		for i, item := range items {
			resp[i] = toAuditLogResponse(item)
		}
		api.JSON(w, http.StatusOK, resp)
	})
	r.Post("/", func(w http.ResponseWriter, r *http.Request) {
		var req AuditLogRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		item, err := q.CreateAuditLogEntry(r.Context(), auditLogParams(req, api.TenantID(r.Context())))
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, toAuditLogResponse(item))
	})
	return r
}
