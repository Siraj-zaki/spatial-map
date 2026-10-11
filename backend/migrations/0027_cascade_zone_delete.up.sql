-- Change every `zone_id` foreign key referencing `zones(id)` from
-- `ON DELETE SET NULL` to `ON DELETE CASCADE`.
--
-- Prior to this migration, deleting a warehouse (zone) silently
-- detached every shape (image, polygon, grid, model, image_plane, etc.)
-- from its warehouse instead of removing it, leaving both the DB row
-- AND the object-store file behind. The zone-delete handler then had
-- no way to reclaim the files without re-implementing the cascade in
-- Go.
--
-- After this migration:
--   DELETE FROM zones WHERE id = X;
-- removes every child shape row in one FK cascade. Object files are
-- reclaimed by the zone-delete handler which SELECTs their URLs BEFORE
-- the delete fires (see zones.go::deleteZone).
--
-- The constraint names below follow the PostgreSQL default naming
-- convention for FKs declared inline on a column: `<table>_<column>_fkey`.
-- If any of these were renamed at migration time (unlikely — the
-- schema was created in one sweep in 0001) this DROP will fail with a
-- specific constraint-not-found error and can be updated then.

ALTER TABLE grids
  DROP CONSTRAINT grids_zone_id_fkey,
  ADD CONSTRAINT grids_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE polygons
  DROP CONSTRAINT polygons_zone_id_fkey,
  ADD CONSTRAINT polygons_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE circles
  DROP CONSTRAINT circles_zone_id_fkey,
  ADD CONSTRAINT circles_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE lines
  DROP CONSTRAINT lines_zone_id_fkey,
  ADD CONSTRAINT lines_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE markers
  DROP CONSTRAINT markers_zone_id_fkey,
  ADD CONSTRAINT markers_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE images
  DROP CONSTRAINT images_zone_id_fkey,
  ADD CONSTRAINT images_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE models
  DROP CONSTRAINT models_zone_id_fkey,
  ADD CONSTRAINT models_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE text_labels
  DROP CONSTRAINT text_labels_zone_id_fkey,
  ADD CONSTRAINT text_labels_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE streams
  DROP CONSTRAINT streams_zone_id_fkey,
  ADD CONSTRAINT streams_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE data_sources
  DROP CONSTRAINT data_sources_zone_id_fkey,
  ADD CONSTRAINT data_sources_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE stairs
  DROP CONSTRAINT stairs_zone_id_fkey,
  ADD CONSTRAINT stairs_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE doors
  DROP CONSTRAINT doors_zone_id_fkey,
  ADD CONSTRAINT doors_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE image_planes
  DROP CONSTRAINT image_planes_zone_id_fkey,
  ADD CONSTRAINT image_planes_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;

ALTER TABLE routes
  DROP CONSTRAINT routes_zone_id_fkey,
  ADD CONSTRAINT routes_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE;
