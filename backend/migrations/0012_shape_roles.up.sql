-- Per-warehouse role for polygons and circles. The frontend lets users tag
-- a polygon/circle with a vocabulary entry from the host warehouse's
-- `roleVocabulary` (e.g. "Office", "Storage", "Loading dock") so reports
-- and the side panel can group shapes by what they represent. The field
-- references a `key` defined in the zone's `roleVocabulary.<kind>` array
-- — there's no FK because the vocabulary lives inside the zone's
-- `settings` JSONB blob.
--
-- Nullable: old rows + shapes the user hasn't tagged yet have NULL and
-- render as their generic kind ("Polygon", "Area", etc.).

ALTER TABLE polygons ADD COLUMN role TEXT;
ALTER TABLE circles  ADD COLUMN role TEXT;
