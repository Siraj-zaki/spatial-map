-- Report links can't survive the rollback: without report_id they would
-- read as facility links.
DELETE FROM share_links WHERE report_id IS NOT NULL;
DROP INDEX IF EXISTS share_links_report_idx;
ALTER TABLE share_links DROP CONSTRAINT IF EXISTS share_links_target_chk;
ALTER TABLE share_links ALTER COLUMN zone_id SET NOT NULL;
ALTER TABLE share_links DROP COLUMN IF EXISTS report_id;
