-- Alert rules + alerts (migration 0048). The engine's set-based evaluation
-- lives in handlers/alert_engine.go (dynamic SQL over data_source_rows);
-- these are the CRUD and listing queries.

-- name: ListAlertRules :many
SELECT * FROM alert_rules
WHERE tenant_id = sqlc.arg(tenant_id)
  AND (sqlc.narg(zone_id)::bigint IS NULL OR zone_id = sqlc.narg(zone_id))
ORDER BY name, id;

-- name: GetAlertRule :one
SELECT * FROM alert_rules WHERE id = $1 AND tenant_id = $2;

-- name: CreateAlertRule :one
INSERT INTO alert_rules (tenant_id, zone_id, source_id, name, description, kind, condition, duration_sec, stale_field,
  comparison, threshold, severity, message, label_field, recipient_roles, recipient_user_ids, cooldown_sec, enabled, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.narg(zone_id), sqlc.arg(source_id), sqlc.arg(name), sqlc.arg(description), sqlc.arg(kind),
  sqlc.arg(condition), sqlc.arg(duration_sec), sqlc.arg(stale_field), sqlc.arg(comparison), sqlc.arg(threshold), sqlc.arg(severity),
  sqlc.arg(message), sqlc.arg(label_field), sqlc.arg(recipient_roles), sqlc.arg(recipient_user_ids), sqlc.arg(cooldown_sec),
  sqlc.arg(enabled), sqlc.narg(created_by))
RETURNING *;

-- name: UpdateAlertRule :one
-- Full replace of the editable fields. Changing the source or kind of a rule
-- makes its open alerts meaningless — the handler resolves them.
UPDATE alert_rules SET zone_id = sqlc.narg(zone_id), source_id = sqlc.arg(source_id), name = sqlc.arg(name),
  description = sqlc.arg(description), kind = sqlc.arg(kind), condition = sqlc.arg(condition), duration_sec = sqlc.arg(duration_sec),
  stale_field = sqlc.arg(stale_field), comparison = sqlc.arg(comparison), threshold = sqlc.arg(threshold), severity = sqlc.arg(severity),
  message = sqlc.arg(message), label_field = sqlc.arg(label_field), recipient_roles = sqlc.arg(recipient_roles),
  recipient_user_ids = sqlc.arg(recipient_user_ids), cooldown_sec = sqlc.arg(cooldown_sec), enabled = sqlc.arg(enabled),
  last_error = '', updated_at = now()
WHERE id = sqlc.arg(id) AND tenant_id = sqlc.arg(tenant_id)
RETURNING *;

-- name: DeleteAlertRule :exec
DELETE FROM alert_rules WHERE id = $1 AND tenant_id = $2;

-- name: ListEnabledAlertRules :many
-- Every tenant's enabled rules, for the engine.
SELECT * FROM alert_rules WHERE enabled ORDER BY tenant_id, id;

-- name: SetAlertRuleEvaluated :exec
UPDATE alert_rules SET last_evaluated_at = now(), last_error = $2 WHERE id = $1;

-- name: ResolveAlertsForRule :exec
-- Close a rule's active alerts (rule edited, disabled or source changed).
UPDATE alert_events SET status = 'resolved', resolved_at = now()
WHERE rule_id = $1 AND status <> 'resolved';

-- name: ListAlertEvents :many
-- The Alerts page. `status`: 'active' (open + acknowledged), 'resolved', or
-- '' for every alert. `for_me` = the caller is one of the rule's recipients
-- (a rule without recipients notifies everyone).
SELECT e.*, r.name AS rule_name, r.kind AS rule_kind, COALESCE(z.name, '') AS zone_name,
  COALESCE((SELECT d.id FROM data_link_configs d WHERE d.tenant_id = e.tenant_id AND d.zone_id = e.zone_id AND d.source_id = e.source_id ORDER BY d.id LIMIT 1), 0)::bigint AS data_link_id,
  ((cardinality(r.recipient_roles) = 0 AND cardinality(r.recipient_user_ids) = 0)
    OR sqlc.arg(role)::text = ANY(r.recipient_roles) OR sqlc.arg(user_id)::bigint = ANY(r.recipient_user_ids))::boolean AS for_me
FROM alert_events e
JOIN alert_rules r ON r.id = e.rule_id
LEFT JOIN zones z ON z.id = e.zone_id
WHERE e.tenant_id = sqlc.arg(tenant_id)
  AND (sqlc.arg(status)::text = ''
    OR (sqlc.arg(status)::text = 'active' AND e.status <> 'resolved')
    OR e.status = sqlc.arg(status)::text)
  AND (sqlc.narg(zone_id)::bigint IS NULL OR e.zone_id = sqlc.narg(zone_id))
  AND (sqlc.arg(severity)::text = '' OR e.severity = sqlc.arg(severity)::text)
ORDER BY (e.status = 'resolved'), CASE e.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.opened_at DESC
LIMIT sqlc.arg(row_limit);

-- name: AlertSummaryForUser :one
-- The bell: active alerts, active critical ones, and the caller's unread
-- (active, for them, opened since they last opened the bell).
WITH seen AS (
  SELECT COALESCE((SELECT s.seen_at FROM alert_seen s WHERE s.tenant_id = sqlc.arg(tenant_id) AND s.user_id = sqlc.arg(user_id)), 'epoch'::timestamptz) AS at
)
SELECT
  count(*) FILTER (WHERE e.status <> 'resolved')::bigint AS active,
  count(*) FILTER (WHERE e.status <> 'resolved' AND e.severity = 'critical')::bigint AS critical,
  count(*) FILTER (WHERE e.status = 'open' AND e.opened_at > (SELECT at FROM seen)
    AND ((cardinality(r.recipient_roles) = 0 AND cardinality(r.recipient_user_ids) = 0)
      OR sqlc.arg(role)::text = ANY(r.recipient_roles) OR sqlc.arg(user_id)::bigint = ANY(r.recipient_user_ids)))::bigint AS unread
FROM alert_events e
JOIN alert_rules r ON r.id = e.rule_id
WHERE e.tenant_id = sqlc.arg(tenant_id);

-- name: MarkAlertsSeen :exec
INSERT INTO alert_seen (tenant_id, user_id, seen_at) VALUES ($1, $2, now())
ON CONFLICT (tenant_id, user_id) DO UPDATE SET seen_at = now();

-- name: AcknowledgeAlert :one
UPDATE alert_events SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = sqlc.narg(user_id)
WHERE id = sqlc.arg(id) AND tenant_id = sqlc.arg(tenant_id) AND status = 'open'
RETURNING *;

-- name: ResolveAlert :one
UPDATE alert_events SET status = 'resolved', resolved_at = now(), resolved_by = sqlc.narg(user_id), note = sqlc.arg(note)
WHERE id = sqlc.arg(id) AND tenant_id = sqlc.arg(tenant_id) AND status <> 'resolved'
RETURNING *;
