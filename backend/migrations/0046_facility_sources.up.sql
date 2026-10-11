-- Built-in facility sources for the Report Builder.
--
-- One `data_sources` row per workspace per spatial kind (areas, markers,
-- racks, floors, walls, doors, stairs, lifts, escalators, text labels,
-- 3D models), kind = 'facility', config = {"facilityEntity": "<key>"}.
-- The rows carry no data: the report executor reads the shape tables
-- directly (internal/reports/facility.go), so a report is never stale
-- and nothing is copied. A real row keeps the numeric source id every
-- report path already assumes (source picker, field cache, editable
-- table, solutions).
--
-- The generic data-source lists (Tables, Data, Integrations, layer
-- editor) exclude kind = 'facility' in their queries.

ALTER TYPE data_source_kind ADD VALUE 'facility';

-- One row per workspace per entity. Keyed on the config value rather
-- than `kind`, because a value added by ALTER TYPE can't be referenced
-- in the same transaction.
CREATE UNIQUE INDEX data_sources_facility_entity_uniq
  ON data_sources (tenant_id, (config->>'facilityEntity'))
  WHERE config->>'facilityEntity' IS NOT NULL;

-- Shape outlines are stored as JSONB [[lng, lat], ...]; there is no
-- geometry column. These build PostGIS geometry from them for area,
-- length and point-in-area. Invalid input yields NULL, never an error,
-- so one bad row can't fail a whole report.
CREATE FUNCTION sgv_vertices_line(v jsonb) RETURNS geometry
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) < 2 THEN
    RETURN NULL;
  END IF;
  RETURN ST_SetSRID(ST_MakeLine(ARRAY(
    SELECT ST_MakePoint((p->>0)::float8, (p->>1)::float8)
    FROM jsonb_array_elements(v) WITH ORDINALITY AS t(p, i)
    ORDER BY i
  )), 4326);
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;

CREATE FUNCTION sgv_vertices_polygon(v jsonb) RETURNS geometry
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  l geometry;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) < 3 THEN
    RETURN NULL;
  END IF;
  l := sgv_vertices_line(v);
  IF l IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT ST_Equals(ST_StartPoint(l), ST_EndPoint(l)) THEN
    l := ST_AddPoint(l, ST_StartPoint(l));
  END IF;
  -- MakeValid can return a collection; keep only the polygon part so
  -- ST_Contains / ST_Area accept it.
  RETURN ST_CollectionExtract(ST_MakeValid(ST_MakePolygon(l)), 3);
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;
