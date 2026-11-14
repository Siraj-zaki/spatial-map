package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------------------------------------------------------------------------
// Alerts — rules (CRUD + live preview) and the alerts they raise.
//
//   GET    /alert-rules?zoneId=        → rules
//   POST   /alert-rules                → create (owner / admin / editor)
//   POST   /alert-rules/preview        → what a draft rule matches now
//   PUT    /alert-rules/{id}           → replace (resolves its active alerts)
//   DELETE /alert-rules/{id}
//   GET    /alert-events?status=active|resolved&zoneId=&severity=&limit=
//   GET    /alert-events/summary             → { active, critical, unread } for the bell
//   POST   /alert-events/seen                → the caller opened the bell (viewers too)
//   POST   /alert-events/{id}/acknowledge
//   POST   /alert-events/{id}/resolve        → { note }
//
// The engine is alert_engine.go. Signed-in members only. (/alerts is the
// legacy correlation engine's, correlation.go.)
// ---------------------------------------------------------------------------

// AlertRuleRequest is the create / update / preview body.
type AlertRuleRequest struct {
	ZoneID           *int64          `json:"zoneId"`
	SourceID         int64           `json:"sourceId"`
	Name             string          `json:"name"`
	Description      string          `json:"description"`
	Kind             string          `json:"kind"`
	Condition        json.RawMessage `json:"condition"`
	DurationSec      int32           `json:"durationSec"`
	StaleField       string          `json:"staleField"`
	Comparison       string          `json:"comparison"`
	Threshold        int32           `json:"threshold"`
	Severity         string          `json:"severity"`
	Message          string          `json:"message"`
	LabelField       string          `json:"labelField"`
	RecipientRoles   []string        `json:"recipientRoles"`
	RecipientUserIDs []int64         `json:"recipientUserIds"`
	CooldownSec      *int32          `json:"cooldownSec"`
	Enabled          *bool           `json:"enabled"`
}

type AlertRuleResponse struct {
	ID               int64           `json:"id"`
	ZoneID           *int64          `json:"zoneId,omitempty"`
	SourceID         int64           `json:"sourceId"`
	Name             string          `json:"name"`
	Description      string          `json:"description"`
	Kind             string          `json:"kind"`
	Condition        json.RawMessage `json:"condition"`
	DurationSec      int32           `json:"durationSec"`
	StaleField       string          `json:"staleField"`
	Comparison       string          `json:"comparison"`
	Threshold        int32           `json:"threshold"`
	Severity         string          `json:"severity"`
	Message          string          `json:"message"`
	LabelField       string          `json:"labelField"`
	RecipientRoles   []string        `json:"recipientRoles"`
	RecipientUserIDs []int64         `json:"recipientUserIds"`
	CooldownSec      int32           `json:"cooldownSec"`
	Enabled          bool            `json:"enabled"`
	CreatedAt        string          `json:"createdAt"`
	UpdatedAt        string          `json:"updatedAt"`
	LastEvaluatedAt  string          `json:"lastEvaluatedAt,omitempty"`
	LastError        string          `json:"lastError,omitempty"`
}

type AlertEventResponse struct {
	ID             int64           `json:"id"`
	RuleID         int64           `json:"ruleId"`
	RuleName       string          `json:"ruleName"`
	RuleKind       string          `json:"ruleKind"`
	ZoneID         *int64          `json:"zoneId,omitempty"`
	ZoneName       string          `json:"zoneName"`
	SourceID       int64           `json:"sourceId"`
	DataLinkID     int64           `json:"dataLinkId,omitempty"`
	EntityKey      string          `json:"entityKey"`
	ItemLabel      string          `json:"itemLabel"`
	Severity       string          `json:"severity"`
	Message        string          `json:"message"`
	Status         string          `json:"status"`
	Snapshot       json.RawMessage `json:"snapshot"`
	OpenedAt       string          `json:"openedAt"`
	AcknowledgedAt string          `json:"acknowledgedAt,omitempty"`
	ResolvedAt     string          `json:"resolvedAt,omitempty"`
	// AutoResolved: the engine closed it (the item stopped breaching).
	AutoResolved bool   `json:"autoResolved"`
	Note         string `json:"note,omitempty"`
	ForMe        bool   `json:"forMe"`
}

func toAlertRuleResponse(r db.AlertRule) AlertRuleResponse {
	out := AlertRuleResponse{
		ID: r.ID, SourceID: r.SourceID, Name: r.Name, Description: r.Description, Kind: r.Kind,
		Condition: defaultJSONObject(r.Condition), DurationSec: r.DurationSec, StaleField: r.StaleField, Comparison: r.Comparison,
		Threshold: r.Threshold, Severity: r.Severity, Message: r.Message, LabelField: r.LabelField,
		RecipientRoles: nonNil(r.RecipientRoles), RecipientUserIDs: nonNil(r.RecipientUserIds), CooldownSec: r.CooldownSec, Enabled: r.Enabled,
		CreatedAt: api.FormatTime(r.CreatedAt), UpdatedAt: api.FormatTime(r.UpdatedAt), LastError: r.LastError,
	}
	if r.ZoneID.Valid {
		z := r.ZoneID.Int64
		out.ZoneID = &z
	}
	if r.LastEvaluatedAt.Valid {
		out.LastEvaluatedAt = api.FormatTime(r.LastEvaluatedAt)
	}
	return out
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func toAlertEventResponse(e db.AlertEvent, ruleName, ruleKind, zoneName string, dataLinkID int64, forMe bool) AlertEventResponse {
	out := AlertEventResponse{
		ID: e.ID, RuleID: e.RuleID, RuleName: ruleName, RuleKind: ruleKind, ZoneName: zoneName, SourceID: e.SourceID.Int64, DataLinkID: dataLinkID,
		EntityKey: e.EntityKey, ItemLabel: e.ItemLabel, Severity: e.Severity, Message: e.Message, Status: e.Status,
		Snapshot: defaultJSONObject(e.Snapshot), OpenedAt: api.FormatTime(e.OpenedAt), Note: e.Note, ForMe: forMe,
		AutoResolved: e.ResolvedAt.Valid && !e.ResolvedBy.Valid,
	}
	if e.ZoneID.Valid {
		z := e.ZoneID.Int64
		out.ZoneID = &z
	}
	if e.AcknowledgedAt.Valid {
		out.AcknowledgedAt = api.FormatTime(e.AcknowledgedAt)
	}
	if e.ResolvedAt.Valid {
		out.ResolvedAt = api.FormatTime(e.ResolvedAt)
	}
	return out
}

var alertRecipientRoles = map[string]bool{RoleOwner: true, RoleAdmin: true, RoleEditor: true, RoleViewer: true}

// alertRuleFromRequest validates the body against the tenant and returns the
// rule it describes (id / audit fields unset).
func alertRuleFromRequest(w http.ResponseWriter, r *http.Request, q *db.Queries) (db.AlertRule, bool) {
	tenantID := api.TenantID(r.Context())
	var req AlertRuleRequest
	if err := api.DecodeBody(r, &req); err != nil {
		api.BadRequest(w, "invalid request body")
		return db.AlertRule{}, false
	}
	rule := db.AlertRule{
		TenantID: tenantID, SourceID: req.SourceID, Name: strings.TrimSpace(req.Name), Description: strings.TrimSpace(req.Description),
		Kind: req.Kind, Condition: defaultJSONObject(req.Condition), DurationSec: req.DurationSec, StaleField: strings.TrimSpace(req.StaleField),
		Comparison: req.Comparison, Threshold: req.Threshold, Severity: req.Severity, Message: strings.TrimSpace(req.Message),
		LabelField: strings.TrimSpace(req.LabelField), RecipientRoles: nonNil(req.RecipientRoles), RecipientUserIds: nonNil(req.RecipientUserIDs),
		CooldownSec: 300, Enabled: true,
	}
	if rule.Comparison == "" {
		rule.Comparison = "gt"
	}
	if req.CooldownSec != nil {
		rule.CooldownSec = *req.CooldownSec
	}
	if req.Enabled != nil {
		rule.Enabled = *req.Enabled
	}
	if rule.Name == "" {
		api.BadRequest(w, "name is required")
		return db.AlertRule{}, false
	}
	if _, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{ID: rule.SourceID, TenantID: tenantID}); err != nil {
		api.BadRequest(w, "unknown table")
		return db.AlertRule{}, false
	}
	if req.ZoneID != nil {
		if _, err := q.GetZone(r.Context(), db.GetZoneParams{ID: *req.ZoneID, TenantID: tenantID}); err != nil {
			api.BadRequest(w, "unknown facility")
			return db.AlertRule{}, false
		}
		rule.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	for _, role := range rule.RecipientRoles {
		if !alertRecipientRoles[role] {
			api.BadRequest(w, "unknown recipient role "+role)
			return db.AlertRule{}, false
		}
	}
	for _, uid := range rule.RecipientUserIds {
		if _, err := q.GetUserTenantMembership(r.Context(), db.GetUserTenantMembershipParams{UserID: uid, TenantID: tenantID}); err != nil {
			api.BadRequest(w, "a recipient isn't a member of this workspace")
			return db.AlertRule{}, false
		}
	}
	if err := validateAlertRuleShape(rule); err != nil {
		api.BadRequest(w, err.Error())
		return db.AlertRule{}, false
	}
	return rule, true
}

func listAlertRulesHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := callerRole(w, r, q); !ok {
			return
		}
		var zone pgtype.Int8
		if z := api.Int64Query(r, "zoneId", 0); z > 0 {
			zone = pgtype.Int8{Int64: int64(z), Valid: true}
		}
		rows, err := q.ListAlertRules(r.Context(), db.ListAlertRulesParams{TenantID: api.TenantID(r.Context()), ZoneID: zone})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]AlertRuleResponse, 0, len(rows))
		for _, row := range rows {
			out = append(out, toAlertRuleResponse(row))
		}
		api.JSON(w, http.StatusOK, out)
	}
}

func createAlertRuleHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermAlertsManage) {
			return
		}
		rule, ok := alertRuleFromRequest(w, r, q)
		if !ok {
			return
		}
		var createdBy pgtype.Int8
		if uid := api.UserID(r.Context()); uid != 0 {
			createdBy = pgtype.Int8{Int64: uid, Valid: true}
		}
		row, err := q.CreateAlertRule(r.Context(), db.CreateAlertRuleParams{
			TenantID: rule.TenantID, ZoneID: rule.ZoneID, SourceID: rule.SourceID, Name: rule.Name, Description: rule.Description, Kind: rule.Kind,
			Condition: rule.Condition, DurationSec: rule.DurationSec, StaleField: rule.StaleField, Comparison: rule.Comparison, Threshold: rule.Threshold,
			Severity: rule.Severity, Message: rule.Message, LabelField: rule.LabelField, RecipientRoles: rule.RecipientRoles,
			RecipientUserIds: rule.RecipientUserIds, CooldownSec: rule.CooldownSec, Enabled: rule.Enabled, CreatedBy: createdBy,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, toAlertRuleResponse(row))
	}
}

func updateAlertRuleHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermAlertsManage) {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid id")
			return
		}
		rule, ok := alertRuleFromRequest(w, r, q)
		if !ok {
			return
		}
		row, err := q.UpdateAlertRule(r.Context(), db.UpdateAlertRuleParams{
			ID: id, TenantID: rule.TenantID, ZoneID: rule.ZoneID, SourceID: rule.SourceID, Name: rule.Name, Description: rule.Description, Kind: rule.Kind,
			Condition: rule.Condition, DurationSec: rule.DurationSec, StaleField: rule.StaleField, Comparison: rule.Comparison, Threshold: rule.Threshold,
			Severity: rule.Severity, Message: rule.Message, LabelField: rule.LabelField, RecipientRoles: rule.RecipientRoles,
			RecipientUserIds: rule.RecipientUserIds, CooldownSec: rule.CooldownSec, Enabled: rule.Enabled,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "rule not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		// What the old rule raised no longer means anything; the next pass
		// reopens whatever the new one catches.
		_ = q.ResolveAlertsForRule(r.Context(), row.ID)
		BroadcastEntityKindEvent("ENTITY_UPDATED", "alerts", row.TenantID)
		api.JSON(w, http.StatusOK, toAlertRuleResponse(row))
	}
}

func deleteAlertRuleHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermAlertsManage) {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid id")
			return
		}
		tenantID := api.TenantID(r.Context())
		if err := q.DeleteAlertRule(r.Context(), db.DeleteAlertRuleParams{ID: id, TenantID: tenantID}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityKindEvent("ENTITY_UPDATED", "alerts", tenantID)
		w.WriteHeader(http.StatusNoContent)
	}
}

// previewAlertRuleHandler — what a draft rule would catch now: for a
// duration rule, the items matching now (they'd alert after the wait).
func previewAlertRuleHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := callerRole(w, r, q); !ok {
			return
		}
		rule, ok := alertRuleFromRequest(w, r, q)
		if !ok {
			return
		}
		probe := rule
		if probe.Kind == "duration" {
			probe.Kind = "condition"
		}
		items, err := alertBreaches(r.Context(), pool, probe)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		type sample struct {
			Key     string `json:"key"`
			Label   string `json:"label"`
			Message string `json:"message"`
		}
		samples := []sample{}
		for _, it := range items {
			if len(samples) == 8 {
				break
			}
			samples = append(samples, sample{Key: it.key, Label: it.label, Message: alertMessage(rule, it)})
		}
		resp := map[string]any{"matching": len(items), "samples": samples}
		if rule.Kind == "count" {
			// The live count, breaching or not.
			c, _ := compileAlertCondition(rule)
			var n int64
			if c != nil {
				_ = pool.QueryRow(r.Context(), "SELECT count(*) FROM data_source_rows WHERE "+strings.Join(c.wheres, " AND "), c.args...).Scan(&n)
			}
			resp["count"] = n
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

func listAlertsHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role, ok := callerRole(w, r, q)
		if !ok {
			return
		}
		var zone pgtype.Int8
		if z := api.Int64Query(r, "zoneId", 0); z > 0 {
			zone = pgtype.Int8{Int64: int64(z), Valid: true}
		}
		limit := api.IntQuery(r, "limit", 200)
		if limit <= 0 || limit > 1000 {
			limit = 200
		}
		status := r.URL.Query().Get("status")
		if status != "" && status != "active" && status != "open" && status != "acknowledged" && status != "resolved" {
			api.BadRequest(w, "status must be active, open, acknowledged or resolved")
			return
		}
		rows, err := q.ListAlertEvents(r.Context(), db.ListAlertEventsParams{
			TenantID: api.TenantID(r.Context()), UserID: api.UserID(r.Context()), Role: role, Status: status,
			ZoneID: zone, Severity: r.URL.Query().Get("severity"), RowLimit: int32(limit),
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]AlertEventResponse, 0, len(rows))
		for _, row := range rows {
			e := db.AlertEvent{ID: row.ID, TenantID: row.TenantID, RuleID: row.RuleID, ZoneID: row.ZoneID, SourceID: row.SourceID, EntityKey: row.EntityKey,
				ItemLabel: row.ItemLabel, Severity: row.Severity, Message: row.Message, Status: row.Status, Snapshot: row.Snapshot, OpenedAt: row.OpenedAt,
				AcknowledgedAt: row.AcknowledgedAt, AcknowledgedBy: row.AcknowledgedBy, ResolvedAt: row.ResolvedAt, ResolvedBy: row.ResolvedBy, Note: row.Note}
			out = append(out, toAlertEventResponse(e, row.RuleName, row.RuleKind, row.ZoneName, row.DataLinkID, row.ForMe))
		}
		api.JSON(w, http.StatusOK, out)
	}
}

func alertSummaryHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role, ok := callerRole(w, r, q)
		if !ok {
			return
		}
		s, err := q.AlertSummaryForUser(r.Context(), db.AlertSummaryForUserParams{TenantID: api.TenantID(r.Context()), UserID: api.UserID(r.Context()), Role: role})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, map[string]int64{"active": s.Active, "critical": s.Critical, "unread": s.Unread})
	}
}

func markAlertsSeenHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := callerRole(w, r, q); !ok {
			return
		}
		if err := q.MarkAlertsSeen(r.Context(), db.MarkAlertsSeenParams{TenantID: api.TenantID(r.Context()), UserID: api.UserID(r.Context())}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// alertActionHandler acknowledges or resolves one alert (any member but a viewer).
func alertActionHandler(q *db.Queries, resolve bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermAlertsRespond) {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid id")
			return
		}
		tenantID := api.TenantID(r.Context())
		var by pgtype.Int8
		if uid := api.UserID(r.Context()); uid != 0 {
			by = pgtype.Int8{Int64: uid, Valid: true}
		}
		if resolve {
			var body struct {
				Note string `json:"note"`
			}
			_ = api.DecodeBody(r, &body)
			_, err = q.ResolveAlert(r.Context(), db.ResolveAlertParams{ID: id, TenantID: tenantID, UserID: by, Note: strings.TrimSpace(body.Note)})
		} else {
			_, err = q.AcknowledgeAlert(r.Context(), db.AcknowledgeAlertParams{ID: id, TenantID: tenantID, UserID: by})
		}
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "alert not found or already handled")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityKindEvent("ENTITY_UPDATED", "alerts", tenantID)
		w.WriteHeader(http.StatusNoContent)
	}
}

// AlertRulesRouter mounts on /api/v1/alert-rules.
func AlertRulesRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listAlertRulesHandler(q))
	r.Post("/", createAlertRuleHandler(q))
	r.Post("/preview", previewAlertRuleHandler(q, pool))
	r.Put("/{id}", updateAlertRuleHandler(q))
	r.Delete("/{id}", deleteAlertRuleHandler(q))
	return r
}

// AlertEventsRouter mounts on /api/v1/alert-events.
func AlertEventsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listAlertsHandler(q))
	r.Get("/summary", alertSummaryHandler(q))
	r.Post("/seen", markAlertsSeenHandler(q))
	r.Post("/{id}/acknowledge", alertActionHandler(q, false))
	r.Post("/{id}/resolve", alertActionHandler(q, true))
	return r
}
