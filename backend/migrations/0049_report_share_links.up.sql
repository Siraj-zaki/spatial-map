-- Report share links.
--
-- A share_links row can now point at a report instead of a whole facility:
-- `report_id` set = a public link to that report (its widgets, its live map
-- layers and their history, nothing else). The public endpoints under
-- /api/v1/public/report-share/{token} answer only for such rows, and the
-- facility share endpoints only for rows without one — one link never opens
-- the other kind of view.
--
-- `zone_id` becomes nullable: a report can span the whole workspace
-- (reports.zone_id IS NULL). A row still names a facility or a report.
-- Archiving a report leaves its links in place (the public read checks the
-- report is live); deleting it drops them.

ALTER TABLE share_links
    ADD COLUMN report_id BIGINT REFERENCES reports(id) ON DELETE CASCADE;

ALTER TABLE share_links ALTER COLUMN zone_id DROP NOT NULL;

ALTER TABLE share_links
    ADD CONSTRAINT share_links_target_chk CHECK (zone_id IS NOT NULL OR report_id IS NOT NULL);

CREATE INDEX share_links_report_idx ON share_links (report_id, revoked_at)
    WHERE report_id IS NOT NULL;
