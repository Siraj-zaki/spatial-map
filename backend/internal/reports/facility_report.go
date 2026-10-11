package reports

// The facility report set: eight ordinary reports created with every
// facility (handlers/zones.go createZone, zone_duplicate.go) and
// backfilled for existing ones by cmd/backfill-inventory-reports.
// Users can edit, rename or delete any of them; nothing is re-created
// behind their back.
//
// Each report has viewer filters (Floor / Area / Type / Search /
// Visible) that every data query on the page honours, KPIs and charts
// for its kind, and a `facilityExplorer` widget — list + detail panel +
// live map — with one tab per kind it covers.
//
// spec.origin = {kind: "facility-set", key, zoneId} identifies a report
// of the set (the backfill keys on it, so a renamed report still counts).

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5/pgtype"
)

// FacilitySetOrigin is spec.origin.kind for reports of the set.
const FacilitySetOrigin = "facility-set"

// FacilityReportDef is one report of the set.
type FacilityReportDef struct {
	Key, Name, Description, Icon, Color string
	Spec                                map[string]any
}

// facilityReportMeta lists the set in creation (and gallery) order.
var facilityReportMeta = []struct {
	key, name, description, icon, color string
}{
	{"overview", "Overview", "Everything in this facility at a glance — totals, what's on each floor, and every area, rack, marker and door on the map.", "layout-dashboard", "#0ea5e9"},
	{"floors", "Floors", "Every floor with its plan, height and what's on it.", "layers", "#6366f1"},
	{"areas", "Areas", "Zones, rooms and offices with their size, type and floor.", "shapes", "#8b5cf6"},
	{"racks", "Racks", "Racks and shelving with bays, levels and the area they stand in.", "grid-3x3", "#10b981"},
	{"markers", "Markers & sensors", "Markers, RFID readers and points of interest by type and area.", "map-pin", "#f59e0b"},
	{"walls-doors", "Walls & doors", "Wall lengths and every door by type and floor.", "brick-wall", "#64748b"},
	{"vertical", "Stairs, lifts & escalators", "Vertical transport and the floors each one connects.", "move-vertical", "#ec4899"},
	{"labels-models", "Labels & 3D models", "Text labels and 3D models placed in the facility.", "box", "#14b8a6"},
}

// FacilityReportKeys returns the set's keys in order.
func FacilityReportKeys() []string {
	out := make([]string, len(facilityReportMeta))
	for i, m := range facilityReportMeta {
		out[i] = m.key
	}
	return out
}

// Fields each entity's explorer list shows under the name, and the
// columns the detail panel may edit (must be writable — see
// src/lib/reports/facility-sources.ts).
var explorerFacts = map[string]struct{ subtitle, editable []string }{
	"floors":      {[]string{"elevation_m", "area_count", "rack_count", "marker_count"}, []string{"name", "elevation_m", "visible"}},
	"areas":       {[]string{"type", "floor", "area_m2"}, []string{"name", "type", "color", "visible"}},
	"racks":       {[]string{"area", "floor", "bays"}, []string{"name", "color", "visible"}},
	"markers":     {[]string{"icon", "area", "floor"}, []string{"name", "icon", "label", "visible"}},
	"walls":       {[]string{"type", "floor", "length_m"}, []string{"name", "thickness_m", "height_m", "color", "visible"}},
	"doors":       {[]string{"type", "floor", "width_m"}, []string{"name", "visible"}},
	"stairs":      {[]string{"type", "floor", "to_floor"}, []string{"name", "visible"}},
	"lifts":       {[]string{"served_floors"}, []string{"name", "visible"}},
	"escalators":  {[]string{"floor", "direction", "to_floor"}, []string{"name", "visible"}},
	"text-labels": {[]string{"text", "area", "floor"}, []string{"name", "text", "visible"}},
	"models":      {[]string{"model", "area", "floor"}, []string{"name", "visible"}},
}

// FacilityEditableColumns is the write-back allow-list per entity.
func FacilityEditableColumns(entity string) []string {
	return explorerFacts[entity].editable
}

// typeField is the field the "Type" filter matches, per entity.
var typeField = map[string]string{"areas": "type", "markers": "icon", "walls": "type", "doors": "type"}

// specBuilder accumulates one report's queries, params and widgets.
type specBuilder struct {
	zone   int64
	ids    map[string]int64
	params []string // filter ids this report offers, in bar order
	// optEntity is the entity whose distinct values feed the Area / Type
	// dropdowns (and the only one the Type filter applies to).
	optEntity string
	queries   []any
	widgets   []any
	sources   map[int64]bool
	// applied: viewer filter id → source ids whose queries carry it
	// (spec.viewerFilters[].sourceIds, so the builder re-injects the
	// same conditions on save).
	applied map[string]map[int64]bool
	order   float64
	err     error
}

func newSpec(zone int64, ids map[string]int64, optEntity string, params ...string) *specBuilder {
	return &specBuilder{zone: zone, ids: ids, params: params, optEntity: optEntity, sources: map[int64]bool{}, applied: map[string]map[int64]bool{}}
}

func (b *specBuilder) ref(entity string) map[string]any {
	id, ok := b.ids[entity]
	if !ok && b.err == nil {
		b.err = fmt.Errorf("no facility source for %s", entity)
	}
	b.sources[id] = true
	return map[string]any{"kind": "dataSource", "id": id}
}

func cond(field, op string, value any) map[string]any {
	return map[string]any{"cond": map[string]any{"field": field, "op": op, "value": value}}
}

func (b *specBuilder) has(param string) bool {
	for _, p := range b.params {
		if p == param {
			return true
		}
	}
	return false
}

func entityHasField(entity, key string) bool {
	e, ok := FacilityEntityByKey(entity)
	if !ok {
		return false
	}
	for _, f := range e.Fields {
		if f.Key == key {
			return true
		}
	}
	return false
}

// Viewer filter ids (params) — the `vf_` prefix marks filters managed by
// the builder's Viewer filters step (src/lib/reports/viewer-filters.ts).
const (
	vfFloor   = "vf_floor"
	vfArea    = "vf_area"
	vfType    = "vf_type"
	vfSearch  = "vf_q"
	vfVisible = "vf_visible"
)

func vfRef(id string) string { return "{{param." + id + "}}" }

// filters: always the facility; plus every viewer filter this report
// offers that applies to the entity. Unset filters drop out at run time.
// The floors source has no meaningful "floor" column, so the Floor
// filter skips it.
func (b *specBuilder) filters(entity string, extra ...map[string]any) map[string]any {
	// Fixed conditions first, then viewer filters — the order the builder
	// produces when it re-injects them.
	and := []any{cond("facility_id", "eq", b.zone)}
	for _, e := range extra {
		and = append(and, e)
	}
	src := b.ids[entity]
	add := func(id string, c map[string]any) {
		and = append(and, c)
		if b.applied[id] == nil {
			b.applied[id] = map[int64]bool{}
		}
		b.applied[id][src] = true
	}
	// In filter-bar order — the builder re-injects them in that order, so
	// a save from the builder leaves the queries byte-identical.
	for _, p := range b.params {
		switch p {
		case "floor":
			if entity != "floors" {
				add(vfFloor, cond("floor", "eq", vfRef(vfFloor)))
			}
		case "area":
			if entityHasField(entity, "area") {
				add(vfArea, cond("area", "eq", vfRef(vfArea)))
			}
		case "type":
			if f, ok := typeField[entity]; ok && entity == b.optEntity {
				add(vfType, cond(f, "eq", vfRef(vfType)))
			}
		case "q":
			add(vfSearch, cond("name", "contains", vfRef(vfSearch)))
		case "visible":
			add(vfVisible, cond("visible", "eq", vfRef(vfVisible)))
		}
	}
	return map[string]any{"and": and}
}

func (b *specBuilder) query(name, entity string, q map[string]any, extra ...map[string]any) {
	q["name"] = name
	q["sourceRef"] = b.ref(entity)
	q["filters"] = b.filters(entity, extra...)
	b.queries = append(b.queries, q)
}

func (b *specBuilder) widget(w map[string]any) {
	b.order++
	w["order"] = b.order
	b.widgets = append(b.widgets, w)
}

func metric(fn, field, as string) map[string]any {
	m := map[string]any{"fn": fn, "as": as}
	if field != "" {
		m["field"] = field
	}
	return m
}

// kpi adds a one-row aggregate query + bigValue widget.
func (b *specBuilder) kpi(id, entity, title, tone, fn, field, suffix string, extra ...map[string]any) {
	b.query("kpi_"+id, entity, map[string]any{"metrics": []any{metric(fn, field, "v")}, "limit": 1}, extra...)
	bind := map[string]any{"value": "v", "tone": tone}
	if suffix != "" {
		bind["suffix"] = suffix
	}
	if fn == "avg" || fn == "sum" {
		bind["decimals"] = 1
	}
	b.widget(map[string]any{"id": "kpi_" + id, "kind": "bigValue", "queryRef": "kpi_" + id, "columnSpan": 2, "title": title, "bindings": bind})
}

// chart adds a grouped query + chart widget. top > 0 keeps the largest N.
func (b *specBuilder) chart(id, kind, entity, title, groupBy string, metrics []any, series []string, sortField string, top int) {
	q := map[string]any{"groupBy": []string{groupBy}, "metrics": metrics, "limit": 50}
	if sortField != "" {
		q["sort"] = []any{map[string]any{"field": sortField, "dir": "desc"}}
	}
	if top > 0 {
		q["limit"] = top
	}
	b.query("chart_"+id, entity, q)
	labels := map[string]string{}
	for _, s := range series {
		if l, ok := metricLabels[s]; ok {
			labels[s] = l
		}
	}
	bind := map[string]any{"xAxis": groupBy, "series": series, "seriesLabels": labels}
	if len(series) == 1 {
		bind["hideLegend"] = true
	}
	b.widget(map[string]any{"id": "chart_" + id, "kind": kind, "queryRef": "chart_" + id, "columnSpan": 2, "title": title, "bindings": bind})
}

// rowsChart is a chart over raw rows (one bar per floor, …).
func (b *specBuilder) rowsChart(id, entity, title, xAxis, sortField string, series []string) {
	b.query("chart_"+id, entity, map[string]any{"sort": []any{map[string]any{"field": sortField, "dir": "asc"}}, "limit": 100})
	bind := map[string]any{"xAxis": xAxis, "series": series, "seriesLabels": seriesLabels(entity, series)}
	if len(series) == 1 {
		bind["hideLegend"] = true
	}
	b.widget(map[string]any{"id": "chart_" + id, "kind": "bar", "queryRef": "chart_" + id, "columnSpan": 2, "title": title, "bindings": bind})
}

// metricLabels names the aggregate columns the set's charts use.
var metricLabels = map[string]string{
	"areas": "Areas", "racks": "Racks", "markers": "Markers", "doors": "Doors",
	"bays": "Bays", "m2": "Floor area (m²)", "m": "Length (m)",
}

// seriesLabels names chart series after the facility field labels
// ("area_count" → "Areas") instead of the raw column name.
func seriesLabels(entity string, series []string) map[string]string {
	out := map[string]string{}
	e, ok := FacilityEntityByKey(entity)
	if !ok {
		return out
	}
	for _, s := range series {
		for _, f := range e.Fields {
			if f.Key == s {
				out[s] = f.Label
			}
		}
	}
	return out
}

// explorer adds one rows query per tab and the facilityExplorer widget.
func (b *specBuilder) explorer(title string, entities ...string) {
	var tabs []any
	for _, e := range entities {
		name := "rows_" + sanitizeQueryName(e)
		b.query(name, e, map[string]any{"sort": []any{map[string]any{"field": "name", "dir": "asc"}}, "limit": 5000})
		ent, _ := FacilityEntityByKey(e)
		f := explorerFacts[e]
		tabs = append(tabs, map[string]any{
			"entity": e, "queryRef": name, "sourceId": b.ids[e], "label": ent.Name,
			"subtitle": f.subtitle, "editable": f.editable,
		})
	}
	b.widget(map[string]any{
		"id": "explorer", "kind": "facilityExplorer", "queryRef": "rows_" + sanitizeQueryName(entities[0]), "title": title,
		"bindings": map[string]any{"zoneId": b.zone, "tabs": tabs},
	})
}

// viewerFilters renders the report's viewer filters twice: as params
// (what the runtime reads) and as spec.viewerFilters (what the builder's
// Viewer filters step edits). Option lists come from their own queries
// (`opt_<id>`, never filtered by the params) so a dropdown doesn't
// shrink to the current pick.
func (b *specBuilder) viewerFilters() (params, filters []any) {
	sourceIDs := func(id string) []int64 {
		var out []int64
		for _, e := range FacilityEntities {
			if sid, ok := b.ids[e.Key]; ok && b.applied[id][sid] {
				out = append(out, sid)
			}
		}
		return out
	}
	optQuery := func(id, entity, field, sortField string) map[string]any {
		q := map[string]any{"name": "opt_" + id, "sourceRef": b.ref(entity),
			"filters": map[string]any{"and": []any{cond("facility_id", "eq", b.zone), map[string]any{"cond": map[string]any{"field": field, "op": "notnull"}}}},
			"limit":   500}
		if sortField != "" {
			// Raw rows in a meaningful order (floors by height).
			q["sort"] = []any{map[string]any{"field": sortField, "dir": "asc"}}
		} else {
			q["groupBy"] = []string{field}
			q["sort"] = []any{map[string]any{"field": field, "dir": "asc"}}
		}
		b.queries = append(b.queries, q)
		opts := map[string]any{"sourceId": b.ids[entity], "valueColumn": field,
			"filters": map[string]any{"and": []any{cond("facility_id", "eq", b.zone)}}}
		if sortField != "" {
			opts["sortField"] = sortField
		}
		return opts
	}
	dropdown := func(id string) map[string]any {
		return map[string]any{"kind": "dropdown", "options": map[string]any{"fromQuery": "opt_" + id, "valueColumn": ""}}
	}
	push := func(id, field, label, kind string, input map[string]any, options map[string]any) {
		if opts, ok := input["options"].(map[string]any); ok && opts["fromQuery"] != nil {
			opts["valueColumn"] = options["valueColumn"]
		}
		params = append(params, map[string]any{"id": id, "label": label, "input": input})
		vf := map[string]any{"id": id, "field": field, "label": label, "kind": kind, "sourceIds": sourceIDs(id)}
		if options != nil {
			vf["options"] = options
		}
		filters = append(filters, vf)
	}
	for _, p := range b.params {
		switch p {
		case "floor":
			push(vfFloor, "floor", "Floor", "dropdown", dropdown(vfFloor), optQuery(vfFloor, "floors", "name", "elevation_m"))
		case "area":
			push(vfArea, "area", "Area", "dropdown", dropdown(vfArea), optQuery(vfArea, b.optEntity, "area", ""))
		case "type":
			f := typeField[b.optEntity]
			label := "Type"
			if f == "icon" {
				label = "Icon"
			}
			push(vfType, f, label, "dropdown", dropdown(vfType), optQuery(vfType, b.optEntity, f, ""))
		case "q":
			push(vfSearch, "name", "Search", "search", map[string]any{"kind": "textInput", "placeholder": "Search by name"}, map[string]any{"placeholder": "Search by name"})
		case "visible":
			push(vfVisible, "visible", "Visibility", "yesNo", map[string]any{"kind": "buttonGroup", "options": map[string]any{"static": []any{
				map[string]any{"value": "true", "label": "Visible"},
				map[string]any{"value": "false", "label": "Hidden"},
			}}}, map[string]any{"trueLabel": "Visible", "falseLabel": "Hidden"})
		}
	}
	return params, filters
}

func (b *specBuilder) spec(key string) (map[string]any, error) {
	params, viewerFilters := b.viewerFilters()
	if b.err != nil {
		return nil, b.err
	}
	var sources []any
	for _, e := range FacilityEntities {
		if id, ok := b.ids[e.Key]; ok && b.sources[id] {
			sources = append(sources, map[string]any{"kind": "dataSource", "id": id})
		}
	}
	return map[string]any{
		"v": 2, "reportType": "editable",
		"origin":  map[string]any{"kind": FacilitySetOrigin, "key": key, "zoneId": b.zone},
		"sources": sources, "params": params, "viewerFilters": viewerFilters, "queries": b.queries,
		"layout": map[string]any{"kind": "document"}, "widgets": b.widgets,
	}, nil
}

func count(as string) []any { return []any{metric("count", "", as)} }

// FacilityReportSet builds the eight specs for one facility. `ids` maps
// entity key → the workspace's facility source id.
func FacilityReportSet(zoneID int64, ids map[string]int64) ([]FacilityReportDef, error) {
	isWall := cond("type", "eq", "wall")
	hidden := cond("visible", "eq", false)
	build := map[string]func() *specBuilder{
		"overview": func() *specBuilder {
			b := newSpec(zoneID, ids, "", "floor", "q")
			b.kpi("floors", "floors", "Floors", "blue", "count", "", "")
			b.kpi("areas", "areas", "Areas", "purple", "count", "", "")
			b.kpi("racks", "racks", "Racks", "emerald", "count", "", "")
			b.kpi("markers", "markers", "Markers", "amber", "count", "", "")
			b.rowsChart("floors", "floors", "What's on each floor", "name", "elevation_m", []string{"area_count", "rack_count", "marker_count", "door_count"})
			b.chart("area_types", "donut", "areas", "Areas by type", "type", count("areas"), []string{"areas"}, "areas", 0)
			b.explorer("Facility map", "areas", "racks", "markers", "doors")
			return b
		},
		"floors": func() *specBuilder {
			b := newSpec(zoneID, ids, "", "q")
			b.kpi("floors", "floors", "Floors", "blue", "count", "", "")
			b.kpi("areas", "floors", "Areas", "purple", "sum", "area_count", "")
			b.kpi("racks", "floors", "Racks", "emerald", "sum", "rack_count", "")
			b.kpi("markers", "floors", "Markers", "amber", "sum", "marker_count", "")
			b.rowsChart("items", "floors", "What's on each floor", "name", "elevation_m", []string{"area_count", "rack_count", "marker_count", "wall_count", "door_count"})
			b.rowsChart("height", "floors", "Floor height (m)", "name", "elevation_m", []string{"elevation_m"})
			b.explorer("Floors", "floors")
			return b
		},
		"areas": func() *specBuilder {
			b := newSpec(zoneID, ids, "areas", "floor", "type", "q", "visible")
			b.kpi("count", "areas", "Areas", "purple", "count", "", "")
			b.kpi("total", "areas", "Total floor area", "blue", "sum", "area_m2", " m²")
			b.kpi("avg", "areas", "Average size", "emerald", "avg", "area_m2", " m²")
			b.kpi("types", "areas", "Types", "amber", "countDistinct", "type", "")
			b.chart("types", "donut", "areas", "Areas by type", "type", count("areas"), []string{"areas"}, "areas", 0)
			b.chart("by_floor", "bar", "areas", "Floor area by floor (m²)", "floor", []any{metric("sum", "area_m2", "m2")}, []string{"m2"}, "", 0)
			b.explorer("Areas", "areas")
			return b
		},
		"racks": func() *specBuilder {
			b := newSpec(zoneID, ids, "racks", "floor", "area", "q", "visible")
			b.kpi("count", "racks", "Racks", "emerald", "count", "", "")
			b.kpi("bays", "racks", "Bays", "blue", "sum", "bays", "")
			b.kpi("levels", "racks", "Average levels", "purple", "avg", "levels", "")
			b.kpi("areas", "racks", "Areas with racks", "amber", "countDistinct", "area", "")
			b.chart("by_floor", "bar", "racks", "Racks by floor", "floor", count("racks"), []string{"racks"}, "", 0)
			b.chart("by_area", "bar", "racks", "Bays by area (top 10)", "area", []any{metric("sum", "bays", "bays")}, []string{"bays"}, "bays", 10)
			b.explorer("Racks", "racks")
			return b
		},
		"markers": func() *specBuilder {
			b := newSpec(zoneID, ids, "markers", "floor", "type", "area", "q", "visible")
			b.kpi("count", "markers", "Markers", "amber", "count", "", "")
			b.kpi("icons", "markers", "Kinds", "blue", "countDistinct", "icon", "")
			b.kpi("areas", "markers", "Areas covered", "emerald", "countDistinct", "area", "")
			b.kpi("hidden", "markers", "Hidden", "purple", "count", "", "", hidden)
			b.chart("icons", "bar", "markers", "Markers by icon", "icon", count("markers"), []string{"markers"}, "markers", 0)
			b.chart("areas", "bar", "markers", "Markers by area (top 10)", "area", count("markers"), []string{"markers"}, "markers", 10)
			b.explorer("Markers & sensors", "markers")
			return b
		},
		"walls-doors": func() *specBuilder {
			b := newSpec(zoneID, ids, "", "floor", "q")
			b.kpi("walls", "walls", "Walls", "blue", "count", "", "", isWall)
			b.kpi("length", "walls", "Wall length", "purple", "sum", "length_m", " m", isWall)
			b.kpi("doors", "doors", "Doors", "emerald", "count", "", "")
			b.kpi("door_types", "doors", "Door types", "amber", "countDistinct", "type", "")
			b.chart("length", "bar", "walls", "Wall length by floor (m)", "floor", []any{metric("sum", "length_m", "m")}, []string{"m"}, "", 0)
			b.chart("door_types", "donut", "doors", "Doors by type", "type", count("doors"), []string{"doors"}, "doors", 0)
			b.explorer("Walls & doors", "walls", "doors")
			return b
		},
		"vertical": func() *specBuilder {
			b := newSpec(zoneID, ids, "", "floor", "q")
			b.kpi("stairs", "stairs", "Stairs", "blue", "count", "", "")
			b.kpi("lifts", "lifts", "Lifts", "purple", "count", "", "")
			b.kpi("escalators", "escalators", "Escalators", "emerald", "count", "", "")
			b.explorer("Stairs, lifts & escalators", "stairs", "lifts", "escalators")
			return b
		},
		"labels-models": func() *specBuilder {
			b := newSpec(zoneID, ids, "text-labels", "floor", "area", "q")
			b.kpi("labels", "text-labels", "Text labels", "blue", "count", "", "")
			b.kpi("models", "models", "3D models", "emerald", "count", "", "")
			b.explorer("Labels & 3D models", "text-labels", "models")
			return b
		},
	}
	var out []FacilityReportDef
	for _, m := range facilityReportMeta {
		spec, err := build[m.key]().spec(m.key)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", m.key, err)
		}
		out = append(out, FacilityReportDef{Key: m.key, Name: m.name, Description: m.description, Icon: m.icon, Color: m.color, Spec: spec})
	}
	return out, nil
}

// sanitizeQueryName keeps query / widget names valid identifiers
// ("text-labels" → "text_labels").
func sanitizeQueryName(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c == '-' {
			b[i] = '_'
		}
	}
	return string(b)
}

// CreateFacilityReports creates the reports of the set listed in `keys`
// (all of them when keys is nil) for one facility and returns their
// ids. createdBy may be 0 (system / backfill).
func CreateFacilityReports(ctx context.Context, q *db.Queries, tenantID, zoneID, createdBy int64, keys []string) ([]int64, error) {
	ids, err := FacilitySourceIDs(ctx, q, tenantID)
	if err != nil {
		return nil, err
	}
	set, err := FacilityReportSet(zoneID, ids)
	if err != nil {
		return nil, err
	}
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
	}
	var created []int64
	for _, def := range set {
		if keys != nil && !want[def.Key] {
			continue
		}
		raw, err := json.Marshal(def.Spec)
		if err != nil {
			return created, err
		}
		row, err := q.CreateReport(ctx, db.CreateReportParams{
			TenantID:    tenantID,
			Name:        def.Name,
			Description: def.Description,
			Icon:        def.Icon,
			Color:       def.Color,
			Spec:        raw,
			SpecVersion: 2,
			CreatedBy:   pgtype.Int8{Int64: createdBy, Valid: createdBy > 0},
			ZoneID:      pgtype.Int8{Int64: zoneID, Valid: true},
		})
		if err != nil {
			return created, fmt.Errorf("create %s: %w", def.Key, err)
		}
		created = append(created, row.ID)
	}
	return created, nil
}
