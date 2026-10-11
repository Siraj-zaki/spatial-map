-- Restore the original `ON DELETE SET NULL` behavior for every
-- `zone_id` FK. Rolling back this migration WITHOUT restoring the
-- shape rows that were destroyed by the new cascade behavior would
-- leave the affected zones as ghost references — but since the rows
-- are already gone at that point there's nothing SET NULL can do.

ALTER TABLE grids
  DROP CONSTRAINT grids_zone_id_fkey,
  ADD CONSTRAINT grids_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE polygons
  DROP CONSTRAINT polygons_zone_id_fkey,
  ADD CONSTRAINT polygons_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE circles
  DROP CONSTRAINT circles_zone_id_fkey,
  ADD CONSTRAINT circles_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE lines
  DROP CONSTRAINT lines_zone_id_fkey,
  ADD CONSTRAINT lines_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE markers
  DROP CONSTRAINT markers_zone_id_fkey,
  ADD CONSTRAINT markers_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE images
  DROP CONSTRAINT images_zone_id_fkey,
  ADD CONSTRAINT images_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE models
  DROP CONSTRAINT models_zone_id_fkey,
  ADD CONSTRAINT models_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE text_labels
  DROP CONSTRAINT text_labels_zone_id_fkey,
  ADD CONSTRAINT text_labels_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE streams
  DROP CONSTRAINT streams_zone_id_fkey,
  ADD CONSTRAINT streams_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE data_sources
  DROP CONSTRAINT data_sources_zone_id_fkey,
  ADD CONSTRAINT data_sources_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE stairs
  DROP CONSTRAINT stairs_zone_id_fkey,
  ADD CONSTRAINT stairs_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE doors
  DROP CONSTRAINT doors_zone_id_fkey,
  ADD CONSTRAINT doors_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE image_planes
  DROP CONSTRAINT image_planes_zone_id_fkey,
  ADD CONSTRAINT image_planes_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;

ALTER TABLE routes
  DROP CONSTRAINT routes_zone_id_fkey,
  ADD CONSTRAINT routes_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL;
