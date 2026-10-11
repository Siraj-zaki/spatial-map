package reports_test

// Built-in facility sources against real Postgres + PostGIS: every
// entity's subquery must run, scope to the tenant, and compile through
// the same filter / group-by / sort paths as a user table.

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports/interpolate"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports/specmigrate"
	v2 "github.com/Siraj-zaki/spatial-map/backend/internal/reports/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

type facilityFixture struct {
	tenant, other, zone, floor int64
}

// square returns a closed-or-open ring around (cx, cy) with half-size h
// degrees, as the JSONB the shape tables store.
func square(cx, cy, h float64) string {
	b, _ := json.Marshal([][2]float64{{cx - h, cy - h}, {cx + h, cy - h}, {cx + h, cy + h}, {cx - h, cy + h}})
	return string(b)
}

func seedFacility(t *testing.T, pool *pgxpool.Pool) facilityFixture {
	t.Helper()
	ctx := context.Background()
	var f facilityFixture
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	one := func(dst *int64, sql string, args ...any) {
		t.Helper()
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(dst), sql)
	}
	one(&f.tenant, `INSERT INTO tenants (name, color) VALUES ('fac', '#000000') RETURNING id`)
	one(&f.other, `INSERT INTO tenants (name, color) VALUES ('other', '#000000') RETURNING id`)
	one(&f.zone, `INSERT INTO zones (tenant_id, name, color, center) VALUES ($1, 'Store', '#333333', ST_SetSRID(ST_MakePoint(0, 0), 4326)) RETURNING id`, f.tenant)
	one(&f.floor, `INSERT INTO images (tenant_id, name, start_lng, start_lat, current_lng, current_lat, mime_type, natural_width, natural_height, config, unit, image_url, zone_id)
		VALUES ($1, 'Level 1', 0, 0.002, 0.002, 0, 'image/png', 10, 10, '{"elevation": 4.2}', 'm', 'x.png', $2) RETURNING id`, f.tenant, f.zone)

	// Grocery (big) contains Dairy (small); a furniture surface covers
	// everything but must never be "the area" a point sits in.
	poly := `INSERT INTO polygons (tenant_id, name, vertices, config, unit, zone_id, floor_plan_id, role) VALUES ($1, $2, $3::jsonb, $4::jsonb, 'm', $5, $6, $7)`
	exec(poly, f.tenant, "Grocery", square(0.001, 0.001, 0.0008), `{"color": "#ff0000", "height": 0}`, f.zone, f.floor, "zone")
	exec(poly, f.tenant, "Dairy", square(0.0005, 0.0005, 0.0002), `{"color": "#00ff00"}`, f.zone, f.floor, "zone")
	exec(poly, f.tenant, "Table", square(0.001, 0.001, 0.0009), `{}`, f.zone, f.floor, "surface")
	exec(poly, f.tenant, "Broken", `[[0,0]]`, `{}`, f.zone, f.floor, nil)
	exec(poly, f.other, "Other tenant area", square(0.001, 0.001, 0.0008), `{}`, nil, nil, "zone")

	mk := `INSERT INTO markers (tenant_id, name, lng, lat, config, unit, zone_id, floor_plan_id) VALUES ($1, $2, $3, $4, $5::jsonb, 'm', $6, $7)`
	exec(mk, f.tenant, "RFID in dairy", 0.0005, 0.0005, `{"icon": "nfc", "height": 2}`, f.zone, f.floor)
	exec(mk, f.tenant, "RFID in grocery", 0.0015, 0.0015, `{"icon": "nfc"}`, f.zone, f.floor)
	exec(mk, f.tenant, "Outside", 0.01, 0.01, `{"icon": "map-pin"}`, f.zone, f.floor)
	exec(mk, f.tenant, "No floor", 0.0005, 0.0005, `{"icon": "map-pin"}`, f.zone, nil)

	// ~11.1 m x ~2.2 m rack, 1 m cells, 4 levels of 0.4 m.
	exec(`INSERT INTO grids (tenant_id, name, start_lng, start_lat, current_lng, current_lat, config, zone_id, floor_plan_id)
		VALUES ($1, 'Aisle 1', 0.0012, 0.0012, 0.0013, 0.00122, '{"xSize": 1, "ySize": 1, "levels": 4, "levelHeight": 0.4}', $2, $3)`, f.tenant, f.zone, f.floor)
	exec(`INSERT INTO lines (tenant_id, name, vertices, config, unit, zone_id, floor_plan_id) VALUES ($1, 'North wall', '[[0,0.002],[0.002,0.002]]', '{"height": 3, "wallThickness": 0.3}', 'm', $2, $3)`, f.tenant, f.zone, f.floor)
	exec(`INSERT INTO lines (tenant_id, name, vertices, config, unit, zone_id, floor_plan_id) VALUES ($1, 'Guide', '[[0,0],[0.001,0]]', '{"height": 0}', 'm', $2, $3)`, f.tenant, f.zone, f.floor)
	exec(`INSERT INTO doors (tenant_id, name, vertices, config, unit, zone_id, floor_plan_id) VALUES ($1, 'Entry', '[[0,0],[0.00001,0]]', '{"kind": "double", "doorHeight": 2.1}', 'm', $2, $3)`, f.tenant, f.zone, f.floor)
	st := `INSERT INTO stairs (tenant_id, name, vertices, config, unit, zone_id, floor_plan_id) VALUES ($1, $2, '[[0,0],[0.00003,0]]', $3::jsonb, 'm', $4, $5)`
	exec(st, f.tenant, "Main stair", `{"stairType": "u", "width": 1.2}`, f.zone, f.floor)
	exec(st, f.tenant, "Lift A", `{"stairType": "elevator", "toFloorPlanId": `+itoa(f.floor)+`, "servedFloorPlanIds": [`+itoa(f.floor)+`]}`, f.zone, f.floor)
	exec(st, f.tenant, "Escalator up", `{"stairType": "escalator", "direction": "up"}`, f.zone, f.floor)
	exec(`INSERT INTO text_labels (tenant_id, name, lng, lat, config, unit, zone_id, floor_plan_id) VALUES ($1, 'Sign', 0.0005, 0.0005, '{"text": "DAIRY", "size": 14}', 'm', $2, $3)`, f.tenant, f.zone, f.floor)
	exec(`INSERT INTO models (tenant_id, name, lng, lat, config, unit, zone_id, floor_plan_id) VALUES ($1, 'Fridge', 0.0005, 0.0005, '{"modelAssetId": "fridge", "scale": [1.5, 1.5, 1.5], "rotation": [0, 0, 90]}', 'm', $2, $3)`, f.tenant, f.zone, f.floor)
	return f
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func skipInCI(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
}

// rowsByName runs a raw query and returns each row as column → value,
// keyed by the "name" column.
func rowsByName(t *testing.T, res reports.Result) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, r := range res.Rows {
		m := map[string]any{}
		for i, c := range res.Columns {
			m[c.Name] = r[i]
		}
		name, _ := m["name"].(string)
		out[name] = m
	}
	return out
}

func asFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	}
	b, _ := json.Marshal(v)
	var f float64
	_ = json.Unmarshal(b, &f)
	return f
}

func TestFacilitySources(t *testing.T) {
	skipInCI(t)
	pool, q, cleanup := setupPostgres(t)
	defer cleanup()
	ctx := context.Background()
	f := seedFacility(t, pool)

	ids, err := reports.FacilitySourceIDs(ctx, q, f.tenant)
	require.NoError(t, err)
	require.Len(t, ids, len(reports.FacilityEntities))
	// Idempotent.
	again, err := reports.FacilitySourceIDs(ctx, q, f.tenant)
	require.NoError(t, err)
	require.Equal(t, ids, again)

	// Generic lists never show the built-in sources.
	listed, err := q.ListDataSources(ctx, f.tenant)
	require.NoError(t, err)
	require.Empty(t, listed)

	exec := reports.NewExecutor(pool)
	run := func(entity string, spec reports.Spec) reports.Result {
		t.Helper()
		src, err := reports.ResolveSource(ctx, q, f.tenant, reports.SourceRef{Kind: "dataSource", ID: ids[entity]})
		require.NoError(t, err)
		require.NotNil(t, src.Facility)
		spec.Sources = []reports.SourceRef{{Kind: "dataSource", ID: ids[entity]}}
		res, err := exec.Run(ctx, f.tenant, src, spec)
		require.NoError(t, err, entity)
		return res
	}

	t.Run("every entity runs", func(t *testing.T) {
		want := map[string]int{
			"areas": 4, "markers": 4, "racks": 1, "floors": 1, "walls": 2, "doors": 1,
			"stairs": 1, "lifts": 1, "escalators": 1, "text-labels": 1, "models": 1,
		}
		for _, e := range reports.FacilityEntities {
			res := run(e.Key, reports.Spec{})
			require.Equal(t, want[e.Key], len(res.Rows), e.Key)
			require.Equal(t, "entity_key", res.Columns[0].Name)
			require.Regexp(t, "^"+e.APIKind+":[0-9]+$", res.Rows[0][0], e.Key)
		}
	})

	t.Run("areas: size, tenant scope, broken outline", func(t *testing.T) {
		got := rowsByName(t, run("areas", reports.Spec{}))
		require.NotContains(t, got, "Other tenant area")
		require.InDelta(t, 177.7*177.0, asFloat(got["Grocery"]["area_m2"]), 400) // ~0.0016° square
		require.Equal(t, "Level 1", got["Grocery"]["floor"])
		require.Equal(t, "Store", got["Grocery"]["facility"])
		require.Equal(t, "zone", got["Grocery"]["type"])
		require.Nil(t, got["Broken"]["area_m2"], "an invalid outline reports no size instead of failing")
	})

	t.Run("markers sit in the smallest real area on their floor", func(t *testing.T) {
		got := rowsByName(t, run("markers", reports.Spec{}))
		require.Equal(t, "Dairy", got["RFID in dairy"]["area"])
		require.Equal(t, "Grocery", got["RFID in grocery"]["area"])
		require.Nil(t, got["Outside"]["area"])
		require.Nil(t, got["No floor"]["area"], "a floorless marker doesn't match floor areas")
	})

	t.Run("racks: bays from cell size and levels", func(t *testing.T) {
		got := rowsByName(t, run("racks", reports.Spec{}))["Aisle 1"]
		require.Equal(t, "Grocery", got["area"])
		require.InDelta(t, 11, asFloat(got["columns"]), 0.5)
		require.InDelta(t, 2, asFloat(got["rows"]), 0.5)
		require.InDelta(t, 4, asFloat(got["levels"]), 0)
		require.InDelta(t, asFloat(got["columns"])*asFloat(got["rows"])*4, asFloat(got["bays"]), 0)
		require.InDelta(t, 1.6, asFloat(got["height_m"]), 0.001)
	})

	t.Run("floors, walls, lifts, models", func(t *testing.T) {
		fl := rowsByName(t, run("floors", reports.Spec{}))["Level 1"]
		require.InDelta(t, 4.2, asFloat(fl["elevation_m"]), 0.001)
		require.InDelta(t, 4, asFloat(fl["area_count"]), 0)
		require.InDelta(t, 3, asFloat(fl["marker_count"]), 0, "the floorless marker isn't on Level 1")
		w := rowsByName(t, run("walls", reports.Spec{}))
		require.Equal(t, "wall", w["North wall"]["type"])
		require.Equal(t, "line", w["Guide"]["type"])
		require.InDelta(t, 222.4, asFloat(w["North wall"]["length_m"]), 1)
		lift := rowsByName(t, run("lifts", reports.Spec{}))["Lift A"]
		require.Equal(t, "Level 1", lift["to_floor"])
		require.Equal(t, "Level 1", lift["served_floors"])
		require.InDelta(t, 90, asFloat(rowsByName(t, run("models", reports.Spec{}))["Fridge"]["rotation_deg"]), 0)
	})

	t.Run("filters, group-by, metrics and sort compile over a facility source", func(t *testing.T) {
		eq := func(field, v string) *reports.Node {
			raw, _ := json.Marshal(v)
			return &reports.Node{Cond: &queryx.Cond{Field: field, Op: "eq", Value: raw}}
		}
		require.Len(t, run("markers", reports.Spec{Filters: eq("icon", "nfc")}).Rows, 2)
		// "is empty" relies on null keys being stripped from the payload.
		empty := run("markers", reports.Spec{Filters: &reports.Node{Cond: &queryx.Cond{Field: "area", Op: "isnull"}}})
		require.Len(t, empty.Rows, 2)
		grouped := run("markers", reports.Spec{
			GroupBy: []string{"icon"},
			Metrics: []reports.Metric{{Fn: "count", As: "n"}, {Fn: "avg", Field: "height_m", As: "h"}},
			// n ties at 2; the group field breaks the tie.
			Sort: []reports.SortKey{{Field: "n", Dir: "desc"}, {Field: "icon", Dir: "desc"}},
		})
		require.Len(t, grouped.Rows, 2)
		require.Equal(t, "nfc", grouped.Rows[0][0])
		sorted := run("areas", reports.Spec{Sort: []reports.SortKey{{Field: "area_m2", Dir: "desc"}}, Limit: 1})
		require.Equal(t, "Table", rowsByName(t, sorted)["Table"]["name"])
	})

	t.Run("v2 RunMany", func(t *testing.T) {
		src, err := reports.ResolveSource(ctx, q, f.tenant, reports.SourceRef{Kind: "dataSource", ID: ids["areas"]})
		require.NoError(t, err)
		res, err := exec.RunMany(ctx, f.tenant, map[string]*reports.Source{"by_floor": src}, v2.Spec{
			V: 2,
			Queries: []v2.Query{{
				Name:      "by_floor",
				SourceRef: v2.SourceRef{Kind: "dataSource", ID: ids["areas"]},
				GroupBy:   []string{"floor"},
				Metrics:   []v2.Metric{{Fn: "count", As: "n"}, {Fn: "sum", Field: "area_m2", As: "m2"}},
			}},
		}, nil)
		require.NoError(t, err)
		qr := res.Queries["by_floor"]
		require.Empty(t, qr.Err)
		require.Len(t, qr.Result.Rows, 1)
	})

	t.Run("facility report set runs every query, with and without filters", func(t *testing.T) {
		ids, err := reports.FacilitySourceIDs(ctx, q, f.tenant)
		require.NoError(t, err)
		set, err := reports.FacilityReportSet(f.zone, ids)
		require.NoError(t, err)
		require.Len(t, set, 8)
		single := func(v string) interpolate.ParamValue {
			raw, _ := json.Marshal(v)
			return interpolate.ParamValue{Kind: interpolate.KindSingle, Scalar: v, Raw: raw}
		}
		filtered := map[string]interpolate.ParamValue{
			"vf_floor": single("Level 1"), "vf_q": single("i"), "vf_visible": single("true"),
			"vf_type": single("zone"), "vf_area": single("Grocery"),
		}
		for _, def := range set {
			raw, _ := json.Marshal(def.Spec)
			migrated, err := specmigrate.FromRaw(raw, 2)
			require.NoError(t, err, def.Key)
			sources := map[string]*reports.Source{}
			for _, qq := range migrated.Spec.Queries {
				src, err := reports.ResolveSource(ctx, q, f.tenant, reports.SourceRef{Kind: qq.SourceRef.Kind, ID: qq.SourceRef.ID})
				require.NoError(t, err, def.Key+"/"+qq.Name)
				sources[qq.Name] = src
			}
			for _, params := range []map[string]interpolate.ParamValue{nil, filtered} {
				res, err := exec.RunMany(ctx, f.tenant, sources, migrated.Spec, params)
				require.NoError(t, err, def.Key)
				for name, qr := range res.Queries {
					require.Empty(t, qr.Err, def.Key+"/"+name)
				}
			}
		}

		// Filters narrow the data: Markers report, area = Dairy.
		var markers reports.FacilityReportDef
		for _, d := range set {
			if d.Key == "markers" {
				markers = d
			}
		}
		raw, _ := json.Marshal(markers.Spec)
		migrated, _ := specmigrate.FromRaw(raw, 2)
		sources := map[string]*reports.Source{}
		for _, qq := range migrated.Spec.Queries {
			sources[qq.Name], _ = reports.ResolveSource(ctx, q, f.tenant, reports.SourceRef{Kind: qq.SourceRef.Kind, ID: qq.SourceRef.ID})
		}
		all, err := exec.RunMany(ctx, f.tenant, sources, migrated.Spec, nil)
		require.NoError(t, err)
		require.Len(t, all.Queries["rows_markers"].Result.Rows, 4)
		dairy, err := exec.RunMany(ctx, f.tenant, sources, migrated.Spec, map[string]interpolate.ParamValue{"vf_area": single("Dairy")})
		require.NoError(t, err)
		require.Len(t, dairy.Queries["rows_markers"].Result.Rows, 1)
		require.Equal(t, float64(1), asFloat(dairy.Queries["kpi_count"].Result.Rows[0][0]))
		// Option lists ignore the filters.
		require.Len(t, dairy.Queries["opt_vf_area"].Result.Rows, 2)
		hidden, err := exec.RunMany(ctx, f.tenant, sources, migrated.Spec, map[string]interpolate.ParamValue{"vf_visible": single("false")})
		require.NoError(t, err)
		require.Empty(t, hidden.Queries["rows_markers"].Result.Rows)

		// Another facility's reports see none of this one's shapes.
		var other int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO zones (tenant_id, name, color, center) VALUES ($1, 'Empty', '#333', ST_SetSRID(ST_MakePoint(0, 0), 4326)) RETURNING id`, f.tenant).Scan(&other))
		otherSet, err := reports.FacilityReportSet(other, ids)
		require.NoError(t, err)
		for _, d := range otherSet {
			if d.Key != "markers" {
				continue
			}
			raw, _ := json.Marshal(d.Spec)
			parsed, _ := specmigrate.FromRaw(raw, 2)
			res, err := exec.RunMany(ctx, f.tenant, sources, parsed.Spec, nil)
			require.NoError(t, err)
			require.Empty(t, res.Queries["rows_markers"].Result.Rows)
		}

		created, err := reports.CreateFacilityReports(ctx, q, f.tenant, f.zone, 0, []string{"areas", "racks"})
		require.NoError(t, err)
		require.Len(t, created, 2)
	})

	t.Run("whole-day date range from a viewer filter", func(t *testing.T) {
		ids, err := reports.FacilitySourceIDs(ctx, q, f.tenant)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE markers SET created_at = '2026-10-08 23:30:00+00' WHERE tenant_id = $1 AND name = 'RFID in dairy'`, f.tenant)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE markers SET created_at = '2026-10-01 08:00:00+00' WHERE tenant_id = $1 AND name <> 'RFID in dairy'`, f.tenant)
		require.NoError(t, err)
		ref := v2.SourceRef{Kind: "dataSource", ID: ids["markers"]}
		raw := func(v string) json.RawMessage { b, _ := json.Marshal(v); return b }
		spec := v2.Spec{V: 2, Queries: []v2.Query{{
			Name: "rows", SourceRef: ref,
			Filters: &queryx.Node{And: []queryx.Node{
				{Cond: &queryx.Cond{Field: "created_at", Op: "onOrAfter", Value: raw("{{param.vf_created.start}}")}},
				{Cond: &queryx.Cond{Field: "created_at", Op: "onOrBefore", Value: raw("{{param.vf_created.end}}")}},
			}},
		}}}
		src, err := reports.ResolveSource(ctx, q, f.tenant, reports.SourceRef{Kind: "dataSource", ID: ids["markers"]})
		require.NoError(t, err)
		run := func(start, end any) int {
			params := map[string]interpolate.ParamValue{}
			if start != nil || end != nil {
				pv := interpolate.ParamValue{Kind: interpolate.KindDateRange}
				pv.Range.Start, pv.Range.End = start, end
				params["vf_created"] = pv
			}
			res, err := exec.RunMany(ctx, f.tenant, map[string]*reports.Source{"rows": src}, spec, params)
			require.NoError(t, err)
			require.Empty(t, res.Queries["rows"].Err)
			return len(res.Queries["rows"].Result.Rows)
		}
		require.Equal(t, 4, run(nil, nil), "unset range = all")
		require.Equal(t, 1, run("2026-10-08", "2026-10-08"), "the end day is included whole")
		require.Equal(t, 3, run("2026-09-30", "2026-10-07"))
		require.Equal(t, 4, run("2026-10-01", nil), "open-ended range")
	})

	t.Run("linked-data reports: one per linked table, filters work, never duplicated", func(t *testing.T) {
		var tableID int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO data_sources (tenant_id, name, kind, entity_kind, config, mapping, zone_id)
			VALUES ($1, 'Shelf stock', 'table', 'rack-cell', '{}', '{}', $2) RETURNING id`, f.tenant, f.zone).Scan(&tableID))
		for i, d := range []struct{ key, label, dt string }{
			{"rack_name", "Rack", "text"}, {"floor", "Floor", "text"}, {"status", "Status", "text"},
			{"fill_pct", "Fill %", "number"}, {"units", "Units", "integer"}, {"lng", "Longitude", "number"}, {"lat", "Latitude", "number"},
		} {
			_, err := pool.Exec(ctx, `INSERT INTO table_field_definitions (tenant_id, source_id, field_key, field_label, data_type, is_required, is_unique, sort_order)
				VALUES ($1, $2, $3, $4, $5, false, false, $6)`, f.tenant, tableID, d.key, d.label, d.dt, i)
			require.NoError(t, err)
		}
		for _, r := range []string{
			`{"rack_name":"A1","floor":"Level 1","status":"OK","fill_pct":80,"units":120,"lng":0.0012,"lat":0.0012}`,
			`{"rack_name":"A2","floor":"Level 1","status":"Low","fill_pct":30,"units":40,"lng":0.0013,"lat":0.0012}`,
			`{"rack_name":"B1","floor":"Ground","status":"OK","fill_pct":95,"units":200,"lng":0.0014,"lat":0.0012}`,
		} {
			var key string
			require.NoError(t, json.Unmarshal([]byte(r), &map[string]any{}))
			m := map[string]any{}
			_ = json.Unmarshal([]byte(r), &m)
			key = m["rack_name"].(string)
			_, err := pool.Exec(ctx, `INSERT INTO data_source_rows (tenant_id, source_id, entity_key, payload) VALUES ($1, $2, $3, $4::jsonb)`, f.tenant, tableID, key, r)
			require.NoError(t, err)
		}
		mapping := `{"match":{"mode":"coord"},"coordFields":{"lng":"lng","lat":"lat"},"labelField":"fill_pct"}`
		for _, name := range []string{"Shelf stock badges", "Shelf stock heatmap"} {
			_, err := pool.Exec(ctx, `INSERT INTO data_link_configs (tenant_id, zone_id, name, target_kind, render_mode, field_mapping, source_id)
				VALUES ($1, $2, $3, 'marker', 'point-at-coord', $4::jsonb, $5)`, f.tenant, f.zone, name, mapping, tableID)
			require.NoError(t, err)
		}

		created, err := reports.CreateDataLinkReports(ctx, q, f.tenant, f.zone, 0)
		require.NoError(t, err)
		require.Len(t, created, 1, "two links to one table → one report")
		again, err := reports.CreateDataLinkReports(ctx, q, f.tenant, f.zone, 0)
		require.NoError(t, err)
		require.Empty(t, again)
		_, err = pool.Exec(ctx, `UPDATE reports SET is_archived = true WHERE id = $1`, created[0])
		require.NoError(t, err)
		again, err = reports.CreateDataLinkReports(ctx, q, f.tenant, f.zone, 0)
		require.NoError(t, err)
		require.Empty(t, again, "a deleted report is not brought back")

		var raw []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT spec FROM reports WHERE id = $1`, created[0]).Scan(&raw))
		migrated, err := specmigrate.FromRaw(raw, 2)
		require.NoError(t, err)
		src, err := reports.ResolveSource(ctx, q, f.tenant, reports.SourceRef{Kind: "dataSource", ID: tableID})
		require.NoError(t, err)
		sources := map[string]*reports.Source{}
		for _, qq := range migrated.Spec.Queries {
			sources[qq.Name] = src
		}
		single := func(v string) interpolate.ParamValue {
			b, _ := json.Marshal(v)
			return interpolate.ParamValue{Kind: interpolate.KindSingle, Scalar: v, Raw: b}
		}
		res, err := exec.RunMany(ctx, f.tenant, sources, migrated.Spec, nil)
		require.NoError(t, err)
		for name, qr := range res.Queries {
			require.Empty(t, qr.Err, name)
		}
		require.Len(t, res.Queries["rows"].Result.Rows, 3)
		require.Len(t, res.Queries["opt_vf_floor"].Result.Rows, 2)
		res, err = exec.RunMany(ctx, f.tenant, sources, migrated.Spec, map[string]interpolate.ParamValue{
			"vf_floor": single("Level 1"), "vf_status": single("OK"), "vf_q": single("a"),
		})
		require.NoError(t, err)
		require.Len(t, res.Queries["rows"].Result.Rows, 1)
		require.Equal(t, float64(1), asFloat(res.Queries["kpi_rows"].Result.Rows[0][0]))
	})
}
