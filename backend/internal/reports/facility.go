package reports

// Built-in facility sources (migration 0046).
//
// Each workspace has one `data_sources` row of kind 'facility' per
// entry in FacilityEntities. The row carries no data: the executor
// swaps its FROM clause for a subquery over the shape table, shaped
// like `data_source_rows` (tenant_id, source_id, entity_key, payload),
// so filters, group-by, metrics and sort compile exactly as they do
// for a user table.
//
// entity_key is "<api-kind>:<id>" (e.g. "markers:57") so a report row
// can be written back through the same shape API the map editor uses.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
)

// FacilityEntity describes one built-in facility source.
type FacilityEntity struct {
	// Key is stored as data_sources.config.facilityEntity.
	Key string
	// Name is the default source name (the SPA shows a translated one).
	Name       string
	EntityKind db.DataSourceEntityKind
	// APIKind is the shape API path (/api/v1/<APIKind>/{id}) and the
	// entity_key prefix.
	APIKind string
	Fields  []Field
	// query selects tenant_id, source_id, entity_key, payload (nulls
	// stripped, so the "is empty" operator's key test works). $TENANT
	// and $SOURCE are replaced with the caller's placeholders.
	query string
}

// Fields every entity shares, first in every column list.
var commonFacilityFields = []Field{
	{Key: "id", Label: "ID", Type: FieldNumber},
	{Key: "name", Label: "Name", Type: FieldText},
	{Key: "facility", Label: "Facility", Type: FieldText},
	{Key: "facility_id", Label: "Facility ID", Type: FieldNumber},
	{Key: "floor", Label: "Floor", Type: FieldText},
	{Key: "floor_id", Label: "Floor ID", Type: FieldNumber},
	{Key: "visible", Label: "Visible", Type: FieldBoolean},
	{Key: "created_at", Label: "Created", Type: FieldDatetime},
	{Key: "updated_at", Label: "Updated", Type: FieldDatetime},
}

// Shared tail fields for the common block, last in every column list.
var auditFacilityFields = map[string]bool{"created_at": true, "updated_at": true}

func withCommon(extra ...Field) []Field {
	out := make([]Field, 0, len(commonFacilityFields)+len(extra))
	for _, f := range commonFacilityFields {
		if !auditFacilityFields[f.Key] {
			out = append(out, f)
		}
	}
	out = append(out, extra...)
	for _, f := range commonFacilityFields {
		if auditFacilityFields[f.Key] {
			out = append(out, f)
		}
	}
	return out
}

// commonPayload is the jsonb_build_object argument list for the common
// fields, for a shape aliased `x` with floor `f` and zone `z` joined.
const commonPayload = `'id', x.id, 'name', x.name, 'facility', z.name, 'facility_id', x.zone_id,
  'floor', f.name, 'floor_id', x.floor_plan_id, 'visible', x.visible,
  'created_at', x.created_at, 'updated_at', x.updated_at`

const commonJoins = `LEFT JOIN zones z ON z.id = x.zone_id
LEFT JOIN images f ON f.id = x.floor_plan_id AND f.tenant_id = x.tenant_id`

// areasCTE: the areas a point can sit in — every polygon except
// furniture surfaces and floor slabs, with its geometry built once.
const areasCTE = `ar AS (
  SELECT a.name, a.zone_id, a.floor_plan_id, g.geom, ST_Area(g.geom) AS sz
  FROM polygons a
  CROSS JOIN LATERAL (SELECT sgv_vertices_polygon(a.vertices) AS geom) g
  WHERE a.tenant_id = $TENANT AND coalesce(a.role, '') NOT IN ('surface', 'floor-area')
    AND g.geom IS NOT NULL
)`

// areaAt names the smallest area on the same facility + floor that
// contains the point (lngExpr, latExpr).
func areaAt(lngExpr, latExpr string) string {
	return `LEFT JOIN LATERAL (
  SELECT ar.name FROM ar
  WHERE ar.zone_id IS NOT DISTINCT FROM x.zone_id
    AND ar.floor_plan_id IS NOT DISTINCT FROM x.floor_plan_id
    AND ST_Contains(ar.geom, ST_SetSRID(ST_MakePoint(` + lngExpr + `, ` + latExpr + `), 4326))
  ORDER BY ar.sz LIMIT 1
) area ON true`
}

// num reads a numeric config key, NULL when absent or not a number.
func num(path string) string {
	return fmt.Sprintf(`CASE WHEN jsonb_typeof(x.config%s) = 'number' THEN round((x.config%s)::numeric, 2) END`, path, path)
}

func shapeQuery(table, apiKind, ctes, extraJoins, payload, where string) string {
	with := ""
	if ctes != "" {
		with = "WITH " + ctes + "\n"
	}
	w := "x.tenant_id = $TENANT"
	if where != "" {
		w += " AND " + where
	}
	return with + `SELECT x.tenant_id, $SOURCE::bigint AS source_id,
  '` + apiKind + `:' || x.id AS entity_key,
  jsonb_strip_nulls(jsonb_build_object(` + commonPayload + `,
  ` + payload + `)) AS payload
FROM ` + table + ` x
` + commonJoins + `
` + extraJoins + `
WHERE ` + w
}

func stairEntity(key, name, where string) FacilityEntity {
	return FacilityEntity{
		Key: key, Name: name, EntityKind: db.DataSourceEntityKindMarker, APIKind: "stairs",
		Fields: withCommon(
			Field{Key: "type", Label: "Type", Type: FieldText},
			Field{Key: "from_floor", Label: "From floor", Type: FieldText},
			Field{Key: "to_floor", Label: "To floor", Type: FieldText},
			Field{Key: "served_floors", Label: "Floors served", Type: FieldText},
			Field{Key: "width_m", Label: "Width (m)", Type: FieldNumber},
			Field{Key: "length_m", Label: "Length (m)", Type: FieldNumber},
			Field{Key: "step_count", Label: "Steps", Type: FieldNumber},
			Field{Key: "rise_m", Label: "Rise (m)", Type: FieldNumber},
			Field{Key: "direction", Label: "Direction", Type: FieldText},
			Field{Key: "color", Label: "Colour", Type: FieldText},
		),
		query: shapeQuery("stairs", "stairs", "",
			`LEFT JOIN images ff ON ff.id = CASE WHEN jsonb_typeof(x.config->'fromFloorPlanId') = 'number' THEN (x.config->>'fromFloorPlanId')::bigint END AND ff.tenant_id = x.tenant_id
LEFT JOIN images tf ON tf.id = CASE WHEN jsonb_typeof(x.config->'toFloorPlanId') = 'number' THEN (x.config->>'toFloorPlanId')::bigint END AND tf.tenant_id = x.tenant_id`,
			`'type', x.config->>'stairType', 'from_floor', ff.name, 'to_floor', tf.name,
  'served_floors', (SELECT string_agg(sf.name, ', ' ORDER BY coalesce(CASE WHEN jsonb_typeof(sf.config->'elevation') = 'number' THEN (sf.config->>'elevation')::numeric END, 0))
                    FROM images sf
                    WHERE sf.tenant_id = x.tenant_id AND jsonb_typeof(x.config->'servedFloorPlanIds') = 'array'
                      AND x.config->'servedFloorPlanIds' @> to_jsonb(sf.id)),
  'width_m', `+num("->'width'")+`,
  'length_m', round(ST_Length(sgv_vertices_line(x.vertices)::geography)::numeric, 2),
  'step_count', `+num("->'stepCount'")+`, 'rise_m', `+num("->'rise'")+`,
  'direction', x.config->>'direction', 'color', x.config->>'color'`,
			where),
	}
}

// FacilityEntities is the catalog, in the order the builder lists them.
var FacilityEntities = []FacilityEntity{
	{
		Key: "floors", Name: "Floors", EntityKind: db.DataSourceEntityKindPolygon, APIKind: "images",
		Fields: withCommon(
			Field{Key: "elevation_m", Label: "Elevation (m)", Type: FieldNumber},
			Field{Key: "width_m", Label: "Width (m)", Type: FieldNumber},
			Field{Key: "depth_m", Label: "Depth (m)", Type: FieldNumber},
			Field{Key: "area_count", Label: "Areas", Type: FieldNumber},
			Field{Key: "marker_count", Label: "Markers", Type: FieldNumber},
			Field{Key: "rack_count", Label: "Racks", Type: FieldNumber},
			Field{Key: "wall_count", Label: "Walls", Type: FieldNumber},
			Field{Key: "door_count", Label: "Doors", Type: FieldNumber},
		),
		// A floor is an image; its own floor_plan_id is unused, so the
		// common floor columns come out empty.
		query: shapeQuery("images", "images", "",
			``,
			`'elevation_m', `+num("->'elevation'")+`,
  'width_m', round(ST_Distance(ST_SetSRID(ST_MakePoint(x.start_lng, x.start_lat), 4326)::geography,
                               ST_SetSRID(ST_MakePoint(x.current_lng, x.start_lat), 4326)::geography)::numeric, 2),
  'depth_m', round(ST_Distance(ST_SetSRID(ST_MakePoint(x.start_lng, x.start_lat), 4326)::geography,
                               ST_SetSRID(ST_MakePoint(x.start_lng, x.current_lat), 4326)::geography)::numeric, 2),
  'area_count', (SELECT count(*) FROM polygons s WHERE s.tenant_id = x.tenant_id AND s.floor_plan_id = x.id),
  'marker_count', (SELECT count(*) FROM markers s WHERE s.tenant_id = x.tenant_id AND s.floor_plan_id = x.id),
  'rack_count', (SELECT count(*) FROM grids s WHERE s.tenant_id = x.tenant_id AND s.floor_plan_id = x.id),
  'wall_count', (SELECT count(*) FROM lines s WHERE s.tenant_id = x.tenant_id AND s.floor_plan_id = x.id),
  'door_count', (SELECT count(*) FROM doors s WHERE s.tenant_id = x.tenant_id AND s.floor_plan_id = x.id)`,
			""),
	},
	{
		Key: "areas", Name: "Areas", EntityKind: db.DataSourceEntityKindPolygon, APIKind: "polygons",
		Fields: withCommon(
			Field{Key: "type", Label: "Type", Type: FieldText},
			Field{Key: "area_m2", Label: "Area (m²)", Type: FieldNumber},
			Field{Key: "perimeter_m", Label: "Perimeter (m)", Type: FieldNumber},
			Field{Key: "height_m", Label: "Height (m)", Type: FieldNumber},
			Field{Key: "elevation_m", Label: "Elevation (m)", Type: FieldNumber},
			Field{Key: "color", Label: "Colour", Type: FieldText},
			Field{Key: "label", Label: "Label", Type: FieldText},
		),
		query: shapeQuery("polygons", "polygons", "",
			`CROSS JOIN LATERAL (SELECT sgv_vertices_polygon(x.vertices) AS geom) g`,
			`'type', x.role,
  'area_m2', round(ST_Area(g.geom::geography)::numeric, 2),
  'perimeter_m', round(ST_Perimeter(g.geom::geography)::numeric, 2),
  'height_m', `+num("->'height'")+`, 'elevation_m', `+num("->'elevation'")+`,
  'color', x.config->>'color', 'label', nullif(x.config->>'label', '')`,
			""),
	},
	{
		Key: "markers", Name: "Markers", EntityKind: db.DataSourceEntityKindMarker, APIKind: "markers",
		Fields: withCommon(
			Field{Key: "icon", Label: "Icon", Type: FieldText},
			Field{Key: "asset_type", Label: "Asset type", Type: FieldText},
			Field{Key: "area", Label: "Area", Type: FieldText},
			Field{Key: "icon_color", Label: "Icon colour", Type: FieldText},
			Field{Key: "label", Label: "Label", Type: FieldText},
			Field{Key: "height_m", Label: "Pole height (m)", Type: FieldNumber},
			Field{Key: "elevation_m", Label: "Elevation (m)", Type: FieldNumber},
			Field{Key: "lng", Label: "Longitude", Type: FieldNumber},
			Field{Key: "lat", Label: "Latitude", Type: FieldNumber},
		),
		query: shapeQuery("markers", "markers", areasCTE, areaAt("x.lng", "x.lat"),
			`'icon', x.config->>'icon', 'asset_type', x.config->>'assetType', 'area', area.name,
  'icon_color', x.config->>'iconColor', 'label', nullif(x.config->>'label', ''),
  'height_m', `+num("->'height'")+`, 'elevation_m', `+num("->'elevation'")+`,
  'lng', x.lng, 'lat', x.lat`,
			""),
	},
	{
		Key: "racks", Name: "Racks", EntityKind: db.DataSourceEntityKindRackCell, APIKind: "grids",
		Fields: withCommon(
			Field{Key: "area", Label: "Area", Type: FieldText},
			Field{Key: "columns", Label: "Columns", Type: FieldNumber},
			Field{Key: "rows", Label: "Rows", Type: FieldNumber},
			Field{Key: "levels", Label: "Levels", Type: FieldNumber},
			Field{Key: "bays", Label: "Bays", Type: FieldNumber},
			Field{Key: "width_m", Label: "Width (m)", Type: FieldNumber},
			Field{Key: "depth_m", Label: "Depth (m)", Type: FieldNumber},
			Field{Key: "height_m", Label: "Height (m)", Type: FieldNumber},
			Field{Key: "elevation_m", Label: "Elevation (m)", Type: FieldNumber},
			Field{Key: "color", Label: "Colour", Type: FieldText},
		),
		query: shapeQuery("grids", "grids", areasCTE,
			`CROSS JOIN LATERAL (SELECT
    ST_Distance(ST_SetSRID(ST_MakePoint(x.start_lng, x.start_lat), 4326)::geography,
                ST_SetSRID(ST_MakePoint(x.current_lng, x.start_lat), 4326)::geography) AS w,
    ST_Distance(ST_SetSRID(ST_MakePoint(x.start_lng, x.start_lat), 4326)::geography,
                ST_SetSRID(ST_MakePoint(x.start_lng, x.current_lat), 4326)::geography) AS d,
    greatest(coalesce(CASE WHEN jsonb_typeof(x.config->'levels') = 'number' THEN (x.config->>'levels')::numeric END, 1), 1) AS lv,
    nullif(CASE WHEN jsonb_typeof(x.config->'xSize') = 'number' THEN (x.config->>'xSize')::numeric END, 0) AS cw,
    nullif(CASE WHEN jsonb_typeof(x.config->'ySize') = 'number' THEN (x.config->>'ySize')::numeric END, 0) AS ch
) dim
CROSS JOIN LATERAL (SELECT
    greatest(floor(dim.w::numeric / dim.cw + 0.000001), 1) AS cols,
    greatest(floor(dim.d::numeric / dim.ch + 0.000001), 1) AS nrows
) cnt
`+areaAt("(x.start_lng + x.current_lng) / 2", "(x.start_lat + x.current_lat) / 2"),
			`'area', area.name, 'columns', cnt.cols, 'rows', cnt.nrows, 'levels', dim.lv,
  'bays', cnt.cols * cnt.nrows * dim.lv,
  'width_m', round(dim.w::numeric, 2), 'depth_m', round(dim.d::numeric, 2),
  'height_m', CASE WHEN dim.lv > 1 THEN round(dim.lv * coalesce(CASE WHEN jsonb_typeof(x.config->'levelHeight') = 'number' THEN (x.config->>'levelHeight')::numeric END, 0), 2)
                   ELSE `+num("->'height'")+` END,
  'elevation_m', `+num("->'elevation'")+`, 'color', x.config->>'color'`,
			""),
	},
	{
		Key: "walls", Name: "Walls", EntityKind: db.DataSourceEntityKindPolygon, APIKind: "lines",
		Fields: withCommon(
			Field{Key: "type", Label: "Type", Type: FieldText},
			Field{Key: "length_m", Label: "Length (m)", Type: FieldNumber},
			Field{Key: "thickness_m", Label: "Thickness (m)", Type: FieldNumber},
			Field{Key: "height_m", Label: "Height (m)", Type: FieldNumber},
			Field{Key: "elevation_m", Label: "Elevation (m)", Type: FieldNumber},
			Field{Key: "color", Label: "Colour", Type: FieldText},
		),
		query: shapeQuery("lines", "lines", "", ``,
			`'type', CASE WHEN coalesce(CASE WHEN jsonb_typeof(x.config->'height') = 'number' THEN (x.config->>'height')::numeric END, 0) > 0 THEN 'wall' ELSE 'line' END,
  'length_m', round(ST_Length(sgv_vertices_line(x.vertices)::geography)::numeric, 2),
  'thickness_m', `+num("->'wallThickness'")+`, 'height_m', `+num("->'height'")+`,
  'elevation_m', `+num("->'elevation'")+`, 'color', x.config->>'color'`,
			""),
	},
	{
		Key: "doors", Name: "Doors", EntityKind: db.DataSourceEntityKindMarker, APIKind: "doors",
		Fields: withCommon(
			Field{Key: "type", Label: "Type", Type: FieldText},
			Field{Key: "state", Label: "State", Type: FieldText},
			Field{Key: "width_m", Label: "Width (m)", Type: FieldNumber},
			Field{Key: "height_m", Label: "Height (m)", Type: FieldNumber},
			Field{Key: "wall_id", Label: "Wall ID", Type: FieldNumber},
		),
		query: shapeQuery("doors", "doors", "", ``,
			`'type', x.config->>'kind', 'state', x.config->>'state',
  'width_m', round(ST_Length(sgv_vertices_line(x.vertices)::geography)::numeric, 2),
  'height_m', `+num("->'doorHeight'")+`, 'wall_id', `+num("->'attachedToLineId'"),
			""),
	},
	stairEntity("stairs", "Stairs", "coalesce(x.config->>'stairType', '') NOT IN ('escalator', 'elevator')"),
	stairEntity("lifts", "Lifts", "x.config->>'stairType' = 'elevator'"),
	stairEntity("escalators", "Escalators", "x.config->>'stairType' = 'escalator'"),
	{
		Key: "text-labels", Name: "Text labels", EntityKind: db.DataSourceEntityKindMarker, APIKind: "text-labels",
		Fields: withCommon(
			Field{Key: "text", Label: "Text", Type: FieldText},
			Field{Key: "area", Label: "Area", Type: FieldText},
			Field{Key: "size", Label: "Size", Type: FieldNumber},
			Field{Key: "color", Label: "Colour", Type: FieldText},
			Field{Key: "elevation_m", Label: "Elevation (m)", Type: FieldNumber},
		),
		query: shapeQuery("text_labels", "text-labels", areasCTE, areaAt("x.lng", "x.lat"),
			`'text', x.config->>'text', 'area', area.name, 'size', `+num("->'size'")+`,
  'color', x.config->>'color', 'elevation_m', `+num("->'elevation'"),
			""),
	},
	{
		Key: "models", Name: "3D models", EntityKind: db.DataSourceEntityKindMarker, APIKind: "models",
		Fields: withCommon(
			Field{Key: "model", Label: "Model", Type: FieldText},
			Field{Key: "area", Label: "Area", Type: FieldText},
			Field{Key: "scale", Label: "Scale", Type: FieldNumber},
			Field{Key: "rotation_deg", Label: "Rotation (°)", Type: FieldNumber},
			Field{Key: "elevation_m", Label: "Elevation (m)", Type: FieldNumber},
			Field{Key: "color", Label: "Colour", Type: FieldText},
		),
		query: shapeQuery("models", "models", areasCTE, areaAt("x.lng", "x.lat"),
			`'model', x.config->>'modelAssetId', 'area', area.name,
  'scale', `+num("->'scale'->0")+`, 'rotation_deg', `+num("->'rotation'->2")+`,
  'elevation_m', `+num("->'elevation'")+`, 'color', x.config->>'color'`,
			""),
	},
}

// FacilityEntityByKey looks an entity up by its config key.
func FacilityEntityByKey(key string) (*FacilityEntity, bool) {
	for i := range FacilityEntities {
		if FacilityEntities[i].Key == key {
			return &FacilityEntities[i], true
		}
	}
	return nil, false
}

// FacilityEntityKey reads config.facilityEntity off a data source's
// config, "" when absent.
func FacilityEntityKey(config json.RawMessage) string {
	var c struct {
		FacilityEntity string `json:"facilityEntity"`
	}
	if len(config) == 0 || json.Unmarshal(config, &c) != nil {
		return ""
	}
	return c.FacilityEntity
}

// fromSQL renders the entity's subquery with the caller's placeholders.
func (e *FacilityEntity) fromSQL(tenantPh, sourcePh string) string {
	s := strings.ReplaceAll(e.query, "$TENANT", tenantPh)
	return strings.ReplaceAll(s, "$SOURCE", sourcePh)
}

// EnsureFacilitySources creates any of the workspace's built-in facility
// sources that don't exist yet. Runs on every builder source listing, so
// it reads first and only upserts what's missing (an upsert that hits the
// conflict still burns a sequence value).
func EnsureFacilitySources(ctx context.Context, q *db.Queries, tenantID int64) error {
	_, err := ensureFacilitySources(ctx, q, tenantID)
	return err
}

func ensureFacilitySources(ctx context.Context, q *db.Queries, tenantID int64) ([]db.DataSource, error) {
	rows, err := q.ListFacilitySources(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	have := make(map[string]bool, len(rows))
	for _, r := range rows {
		have[FacilityEntityKey(r.Config)] = true
	}
	missing := false
	for _, e := range FacilityEntities {
		if have[e.Key] {
			continue
		}
		missing = true
		if err := q.EnsureFacilitySource(ctx, db.EnsureFacilitySourceParams{
			TenantID: tenantID, Name: e.Name, EntityKind: e.EntityKind, Entity: e.Key,
		}); err != nil {
			return nil, fmt.Errorf("ensure facility source %s: %w", e.Key, err)
		}
	}
	if !missing {
		return rows, nil
	}
	return q.ListFacilitySources(ctx, tenantID)
}

// FacilitySourceIDs maps entity key → source id for the workspace,
// creating the sources first if needed.
func FacilitySourceIDs(ctx context.Context, q *db.Queries, tenantID int64) (map[string]int64, error) {
	rows, err := ensureFacilitySources(ctx, q, tenantID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		if k := FacilityEntityKey(r.Config); k != "" {
			out[k] = r.ID
		}
	}
	return out, nil
}
