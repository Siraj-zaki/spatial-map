-- The 'facility' enum value stays: Postgres can't drop an enum value.
DELETE FROM data_sources WHERE config->>'facilityEntity' IS NOT NULL;
DROP INDEX IF EXISTS data_sources_facility_entity_uniq;
DROP FUNCTION IF EXISTS sgv_vertices_polygon(jsonb);
DROP FUNCTION IF EXISTS sgv_vertices_line(jsonb);
