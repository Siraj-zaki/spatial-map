DROP INDEX IF EXISTS idx_audit_log_stream;
DROP INDEX IF EXISTS idx_audit_log_tenant;
DROP TABLE IF EXISTS audit_log;

DROP INDEX IF EXISTS idx_alerts_unacknowledged;
DROP INDEX IF EXISTS idx_alerts_tenant;
DROP TABLE IF EXISTS alerts;

DROP INDEX IF EXISTS idx_correlation_rules_tenant;
DROP TABLE IF EXISTS correlation_rules;

DROP TYPE IF EXISTS alert_level;

ALTER TABLE text_labels DROP COLUMN IF EXISTS rotation;
ALTER TABLE images DROP COLUMN IF EXISTS floor_plan_id;
