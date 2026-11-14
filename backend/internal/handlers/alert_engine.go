package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------------------------------------------------------------------------
// Alert engine — evaluates every enabled alert rule (migration 0048) on a
// timer, server-side, so alerts fire with nobody looking.
//
// Each pass, per rule: find the items breaching it now (set-based SQL over
// data_source_rows, the rule's condition compiled by FilterCompiler), open
// an alert for each new one (unless the same item was resolved within the
// cooldown), and resolve the active alerts whose item no longer breaches.
// Duration rules keep "matching since" per item in alert_rule_state. Any
// change is broadcast as an `alerts` SSE event so open pages refresh.
// ---------------------------------------------------------------------------

const (
	alertTick        = 15 * time.Second
	alertMaxItems    = 5000
	alertMinDuration = 60
)

// StartAlertEngine evaluates the rules every alertTick until ctx ends.
func StartAlertEngine(ctx context.Context, q *db.Queries, pool *pgxpool.Pool, logger *slog.Logger) {
	go func() {
		t := time.NewTicker(alertTick)
		defer t.Stop()
		for {
			evaluateAlertRules(ctx, q, pool, logger)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

func evaluateAlertRules(ctx context.Context, q *db.Queries, pool *pgxpool.Pool, logger *slog.Logger) {
	rules, err := q.ListEnabledAlertRules(ctx)
	if err != nil {
		logger.Error("alerts: list rules", "err", err)
		return
	}
	changed := map[int64]bool{}
	for _, rule := range rules {
		opened, resolved, err := evaluateAlertRule(ctx, pool, rule)
		msg := ""
		if err != nil {
			msg = err.Error()
			logger.Warn("alerts: rule failed", "rule", rule.ID, "err", err)
		}
		_ = q.SetAlertRuleEvaluated(ctx, db.SetAlertRuleEvaluatedParams{ID: rule.ID, LastError: msg})
		if opened+resolved > 0 {
			changed[rule.TenantID] = true
		}
	}
	for tenantID := range changed {
		BroadcastEntityKindEvent("ENTITY_UPDATED", "alerts", tenantID)
	}
}

// alertItem is one item breaching a rule now.
type alertItem struct {
	key     string
	label   string
	payload map[string]any
}

// evaluateAlertRule syncs one rule's alerts with what breaches it now.
func evaluateAlertRule(ctx context.Context, pool *pgxpool.Pool, rule db.AlertRule) (opened, resolved int, err error) {
	items, err := alertBreaches(ctx, pool, rule)
	if err != nil {
		return 0, 0, err
	}
	keys := make([]string, 0, len(items))
	for k := range items {
		keys = append(keys, k)
	}

	// Resolve what no longer breaches.
	tag, err := pool.Exec(ctx, `UPDATE alert_events SET status = 'resolved', resolved_at = now()
		WHERE rule_id = $1 AND status <> 'resolved' AND NOT (entity_key = ANY($2::text[]))`, rule.ID, keys)
	if err != nil {
		return 0, 0, err
	}
	resolved = int(tag.RowsAffected())

	// Open what newly breaches: no active alert for the item, and none
	// resolved within the cooldown.
	if len(keys) > 0 {
		rows, err := pool.Query(ctx, `SELECT k FROM unnest($2::text[]) k
			WHERE NOT EXISTS (SELECT 1 FROM alert_events e WHERE e.rule_id = $1 AND e.entity_key = k
				AND (e.status <> 'resolved' OR e.resolved_at > now() - make_interval(secs => $3)))`, rule.ID, keys, float64(rule.CooldownSec))
		if err != nil {
			return 0, resolved, err
		}
		var fresh []string
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				rows.Close()
				return 0, resolved, err
			}
			fresh = append(fresh, k)
		}
		rows.Close()
		for _, k := range fresh {
			it := items[k]
			snap, _ := json.Marshal(it.payload)
			tag, err := pool.Exec(ctx, `INSERT INTO alert_events (tenant_id, rule_id, zone_id, source_id, entity_key, item_label, severity, message, snapshot)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				ON CONFLICT (rule_id, entity_key) WHERE status <> 'resolved' DO NOTHING`,
				rule.TenantID, rule.ID, rule.ZoneID, rule.SourceID, k, it.label, rule.Severity, alertMessage(rule, it), snap)
			if err != nil {
				return opened, resolved, err
			}
			opened += int(tag.RowsAffected())
		}
	}
	return opened, resolved, nil
}

// alertBreaches returns the items breaching the rule now, keyed by
// entity_key (” for a count rule's single item).
func alertBreaches(ctx context.Context, pool *pgxpool.Pool, rule db.AlertRule) (map[string]alertItem, error) {
	c, err := compileAlertCondition(rule)
	if err != nil {
		return nil, err
	}
	out := map[string]alertItem{}
	if rule.Kind == "count" {
		var n int64
		if err := pool.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM data_source_rows WHERE %s`, strings.Join(c.wheres, " AND ")), c.args...).Scan(&n); err != nil {
			return nil, err
		}
		if compareCount(n, rule.Comparison, int64(rule.Threshold)) {
			out[""] = alertItem{key: "", label: rule.Name, payload: map[string]any{"count": n, "threshold": rule.Threshold}}
		}
		return out, nil
	}
	if rule.Kind == "stale" {
		if err := pushStaleCond(c, rule); err != nil {
			return nil, err
		}
	}
	rows, err := pool.Query(ctx, fmt.Sprintf(`SELECT entity_key, payload FROM data_source_rows WHERE %s ORDER BY entity_key LIMIT %d`,
		strings.Join(c.wheres, " AND "), alertMaxItems), c.args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key string
		var raw []byte
		if err := rows.Scan(&key, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		payload := map[string]any{}
		_ = json.Unmarshal(raw, &payload)
		out[key] = alertItem{key: key, label: alertItemLabel(rule, key, payload), payload: payload}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if rule.Kind != "duration" {
		return out, nil
	}

	// Duration: an item breaches once it has matched for duration_sec.
	keys := make([]string, 0, len(out))
	for k := range out {
		keys = append(keys, k)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM alert_rule_state WHERE rule_id = $1 AND NOT (entity_key = ANY($2::text[]))`, rule.ID, keys); err != nil {
		return nil, err
	}
	if _, err := pool.Exec(ctx, `INSERT INTO alert_rule_state (rule_id, entity_key, matching_since)
		SELECT $1, k, now() FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, rule.ID, keys); err != nil {
		return nil, err
	}
	ripe := map[string]bool{}
	srows, err := pool.Query(ctx, `SELECT entity_key FROM alert_rule_state WHERE rule_id = $1 AND matching_since <= now() - make_interval(secs => $2)`,
		rule.ID, float64(rule.DurationSec))
	if err != nil {
		return nil, err
	}
	for srows.Next() {
		var k string
		if err := srows.Scan(&k); err != nil {
			srows.Close()
			return nil, err
		}
		ripe[k] = true
	}
	srows.Close()
	for k := range out {
		if !ripe[k] {
			delete(out, k)
		}
	}
	return out, nil
}

// compileAlertCondition scopes to the rule's source and adds its condition.
func compileAlertCondition(rule db.AlertRule) (*FilterCompiler, error) {
	c := NewFilterCompiler(rule.TenantID, rule.SourceID)
	if err := c.PushBase(); err != nil {
		return nil, err
	}
	if len(rule.Condition) > 0 && string(rule.Condition) != "{}" && string(rule.Condition) != "null" {
		var n FilterNode
		if err := json.Unmarshal(rule.Condition, &n); err != nil {
			return nil, fmt.Errorf("condition: %w", err)
		}
		if n.Kind != "" {
			if err := c.PushFilter(&n, 0, 0); err != nil {
				return nil, fmt.Errorf("condition: %w", err)
			}
		}
	}
	return c, nil
}

// isoDate is how a payload timestamp starts; anything else is ignored
// rather than failing the whole rule on one bad value.
const isoDate = `^\d{4}-\d{2}-\d{2}`

// pushStaleCond adds "the item's time is older than duration_sec": the
// row's own ts, or a timestamp field in the payload.
func pushStaleCond(c *FilterCompiler, rule db.AlertRule) error {
	c.args = append(c.args, float64(rule.DurationSec))
	secs := len(c.args)
	if rule.StaleField == "" {
		c.wheres = append(c.wheres, fmt.Sprintf(`ts < now() - make_interval(secs => $%d)`, secs))
		return nil
	}
	field, err := queryx.SanitiseField(rule.StaleField)
	if err != nil {
		return fmt.Errorf("stale field: %w", err)
	}
	expr := fmt.Sprintf(`payload->>'%s'`, strings.ReplaceAll(field, "'", "''"))
	c.wheres = append(c.wheres, fmt.Sprintf(`(CASE WHEN %s ~ '%s' THEN (%s)::timestamptz END) < now() - make_interval(secs => $%d)`, expr, isoDate, expr, secs))
	return nil
}

func compareCount(n int64, op string, threshold int64) bool {
	switch op {
	case "gte":
		return n >= threshold
	case "lt":
		return n < threshold
	case "lte":
		return n <= threshold
	case "eq":
		return n == threshold
	default:
		return n > threshold
	}
}

func alertItemLabel(rule db.AlertRule, key string, payload map[string]any) string {
	if rule.LabelField != "" {
		if v, ok := payload[rule.LabelField]; ok && v != nil && fmt.Sprint(v) != "" {
			return fmt.Sprint(v)
		}
	}
	return key
}

var alertPlaceholder = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_]+)\s*\}\}`)

// alertMessage fills the rule's template: {{field}} from the item's row,
// plus {{item}}, {{rule}}, and {{count}} / {{threshold}} for count rules.
// No template → "<rule> — <item>".
func alertMessage(rule db.AlertRule, it alertItem) string {
	if strings.TrimSpace(rule.Message) == "" {
		if it.key == "" {
			return fmt.Sprintf("%s — %v", rule.Name, it.payload["count"])
		}
		return fmt.Sprintf("%s — %s", rule.Name, it.label)
	}
	return alertPlaceholder.ReplaceAllStringFunc(rule.Message, func(m string) string {
		name := alertPlaceholder.FindStringSubmatch(m)[1]
		switch name {
		case "item":
			return it.label
		case "rule":
			return rule.Name
		}
		if v, ok := it.payload[name]; ok && v != nil {
			if f, ok := v.(float64); ok && f == float64(int64(f)) {
				return fmt.Sprint(int64(f))
			}
			return fmt.Sprint(v)
		}
		return "—"
	})
}

// validateAlertRuleShape checks the parts the engine would otherwise trip
// on at run time (kind, durations, comparison, condition, stale field).
func validateAlertRuleShape(rule db.AlertRule) error {
	switch rule.Kind {
	case "condition", "count":
	case "duration", "stale":
		if rule.DurationSec < alertMinDuration {
			return fmt.Errorf("a %s rule needs at least %d seconds", rule.Kind, alertMinDuration)
		}
	default:
		return errors.New("kind must be condition, duration, stale or count")
	}
	switch rule.Severity {
	case "info", "warning", "critical":
	default:
		return errors.New("severity must be info, warning or critical")
	}
	switch rule.Comparison {
	case "gt", "gte", "lt", "lte", "eq":
	default:
		return errors.New("comparison must be gt, gte, lt, lte or eq")
	}
	if rule.Threshold < 0 || rule.CooldownSec < 0 {
		return errors.New("threshold and cooldown can't be negative")
	}
	c, err := compileAlertCondition(rule)
	if err != nil {
		return err
	}
	if rule.Kind == "stale" {
		return pushStaleCond(c, rule)
	}
	return nil
}
