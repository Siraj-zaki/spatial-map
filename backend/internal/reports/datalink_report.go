package reports

// Linked-data reports: one ordinary report per data table linked to a
// facility's map (data_link_configs with a source_id), created when the
// first link to that table is saved (handlers/data_links.go) and
// backfilled by cmd/backfill-inventory-reports. Deletable like any
// report; spec.origin = {kind: "data-link", key: "source:<id>", zoneId}
// stops a deleted one from coming back.
//
// The report reads the table itself — KPIs over its numeric fields,
// breakdowns by status / floor, viewer filters on floor / status / a
// name search — and its explorer tab carries the data link id, so the
// SPA places each row on the map with the link's own matching rules
// (attribute join, coordinates, explicit shape) and shows the link's
// live layer on the map.

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5/pgtype"
)

// DataLinkOrigin is spec.origin.kind for linked-data reports.
const DataLinkOrigin = "data-link"

func dataLinkOriginKey(sourceID int64) string { return fmt.Sprintf("source:%d", sourceID) }

var (
	reIgnore  = regexp.MustCompile(`(?i)^(id|entity_key|lng|lat|longitude|latitude|position)$|_id$|^elevation|color$|colour$`)
	reFloor   = regexp.MustCompile(`(?i)^(floor|floor_name|level_name|storey|story)$|^floor`)
	reStatus  = regexp.MustCompile(`(?i)^(status|state|condition|health)$|status`)
	reName    = regexp.MustCompile(`(?i)(^|_)(name|label|title)$|^name`)
	reAverage = regexp.MustCompile(`(?i)pct|percent|rate|ratio|temp|fill|humidity|battery|rssi|dwell|_c$|avg|average`)
)

// linkFieldMapping is the slice of a data link's field_mapping we read.
type linkFieldMapping struct {
	LabelField string `json:"labelField"`
	Match      struct {
		Mode string `json:"mode"`
		Join struct {
			PayloadField string `json:"payloadField"`
		} `json:"join"`
	} `json:"match"`
}

func capitalise(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	return strings.ToUpper(string(r[0])) + string(r[1:])
}

// linkTargetLabel says what the rows are placed on, for the description.
func linkTargetLabel(link db.DataLinkConfig, fm linkFieldMapping) string {
	if fm.Match.Mode == "coord" || link.RenderMode == "point-at-coord" || link.RenderMode == "heatmap" {
		return "placed on the map by position"
	}
	switch link.TargetKind {
	case "polygon":
		return "linked to areas on the map"
	case "marker":
		return "linked to markers on the map"
	case "grid-cell":
		return "linked to rack cells on the map"
	case "line":
		return "linked to walls on the map"
	case "circle":
		return "linked to circles on the map"
	default:
		return "linked to the map"
	}
}

type dataFields struct {
	floor, status, name string
	numbers             []Field
}

func pickDataFields(fields []Field, fm linkFieldMapping) dataFields {
	var d dataFields
	byKey := map[string]Field{}
	for _, f := range fields {
		byKey[f.Key] = f
	}
	for _, f := range fields {
		if reIgnore.MatchString(f.Key) {
			continue
		}
		switch {
		case f.Type == FieldText && d.floor == "" && reFloor.MatchString(f.Key):
			d.floor = f.Key
		case f.Type == FieldText && d.status == "" && reStatus.MatchString(f.Key):
			d.status = f.Key
		case f.Type == FieldNumber && len(d.numbers) < 3:
			d.numbers = append(d.numbers, f)
		}
	}
	// The name: the link's join field, else a name-like field, else its
	// label field, else the first other text field.
	if j := fm.Match.Join.PayloadField; j != "" && byKey[j].Type == FieldText {
		d.name = j
	}
	for _, f := range fields {
		if d.name == "" && f.Type == FieldText && reName.MatchString(f.Key) && f.Key != d.floor && f.Key != d.status {
			d.name = f.Key
		}
	}
	if d.name == "" && byKey[fm.LabelField].Type == FieldText {
		d.name = fm.LabelField
	}
	for _, f := range fields {
		if d.name == "" && f.Type == FieldText && !reIgnore.MatchString(f.Key) && f.Key != d.floor && f.Key != d.status {
			d.name = f.Key
		}
	}
	return d
}

// DataLinkReportSpec builds the report for one linked table.
func DataLinkReportSpec(zoneID int64, link db.DataLinkConfig, src *Source) (FacilityReportDef, error) {
	var fm linkFieldMapping
	_ = json.Unmarshal(link.FieldMapping, &fm)
	d := pickDataFields(src.Fields, fm)
	ref := map[string]any{"kind": "dataSource", "id": src.ID}

	label := func(key string) string {
		for _, f := range src.Fields {
			if f.Key == key && f.Label != "" {
				return f.Label
			}
		}
		return key
	}

	// Viewer filters (same shape as the builder's spec.viewerFilters).
	type vf struct{ id, field, label, kind, op string }
	var vfs []vf
	if d.floor != "" {
		vfs = append(vfs, vf{"vf_" + d.floor, d.floor, label(d.floor), "dropdown", "eq"})
	}
	if d.status != "" {
		vfs = append(vfs, vf{"vf_" + d.status, d.status, label(d.status), "dropdown", "eq"})
	}
	if d.name != "" {
		vfs = append(vfs, vf{"vf_q", d.name, "Search", "search", "contains"})
	}
	filters := func(extra ...map[string]any) map[string]any {
		and := []any{}
		for _, e := range extra {
			and = append(and, e)
		}
		for _, v := range vfs {
			and = append(and, cond(v.field, v.op, vfRef(v.id)))
		}
		return map[string]any{"and": and}
	}

	var queries, widgets, params, viewerFilters []any
	order := 0.0
	widget := func(w map[string]any) {
		order++
		w["order"] = order
		widgets = append(widgets, w)
	}
	query := func(name string, q map[string]any) {
		q["name"] = name
		q["sourceRef"] = ref
		q["filters"] = filters()
		queries = append(queries, q)
	}

	// KPIs: rows, then up to three numeric fields.
	query("kpi_rows", map[string]any{"metrics": []any{metric("count", "", "v")}, "limit": 1})
	widget(map[string]any{"id": "kpi_rows", "kind": "bigValue", "queryRef": "kpi_rows", "columnSpan": 2, "title": "Rows",
		"bindings": map[string]any{"value": "v", "tone": "blue"}})
	tones := []string{"purple", "emerald", "amber"}
	for i, f := range d.numbers {
		fn, title := "sum", "Total "+strings.ToLower(label(f.Key))
		if reAverage.MatchString(f.Key) {
			fn, title = "avg", "Average "+strings.ToLower(label(f.Key))
		}
		name := "kpi_" + sanitizeQueryName(f.Key)
		query(name, map[string]any{"metrics": []any{metric(fn, f.Key, "v")}, "limit": 1})
		widget(map[string]any{"id": name, "kind": "bigValue", "queryRef": name, "columnSpan": 2, "title": title,
			"bindings": map[string]any{"value": "v", "tone": tones[i%len(tones)], "decimals": 1}})
	}

	// Breakdowns.
	if d.status != "" {
		query("chart_status", map[string]any{"groupBy": []string{d.status}, "metrics": []any{metric("count", "", "rows")},
			"sort": []any{map[string]any{"field": "rows", "dir": "desc"}}, "limit": 50})
		widget(map[string]any{"id": "chart_status", "kind": "donut", "queryRef": "chart_status", "columnSpan": 2,
			"title":    "By " + strings.ToLower(label(d.status)),
			"bindings": map[string]any{"xAxis": d.status, "series": []string{"rows"}, "seriesLabels": map[string]string{"rows": "Rows"}}})
	}
	if len(d.numbers) > 0 {
		n := d.numbers[0]
		fn := "sum"
		if reAverage.MatchString(n.Key) {
			fn = "avg"
		}
		group, title := d.floor, capitalise(label(n.Key))+" by "+strings.ToLower(label(d.floor))
		sortSpec := []any{map[string]any{"field": d.floor, "dir": "asc"}}
		limit := 50
		if group == "" {
			group, title = d.name, "Top 10 by "+strings.ToLower(label(n.Key))
			sortSpec = []any{map[string]any{"field": "v", "dir": "desc"}}
			limit = 10
		}
		if group != "" {
			query("chart_values", map[string]any{"groupBy": []string{group}, "metrics": []any{metric(fn, n.Key, "v")},
				"sort": sortSpec, "limit": limit})
			widget(map[string]any{"id": "chart_values", "kind": "bar", "queryRef": "chart_values", "columnSpan": 2, "title": title,
				"bindings": map[string]any{"xAxis": group, "series": []string{"v"}, "hideLegend": true, "seriesLabels": map[string]string{"v": label(n.Key)}}})
		}
	}

	// The explorer: every row on the map, placed by the link.
	rows := map[string]any{"limit": 5000}
	if d.name != "" {
		rows["sort"] = []any{map[string]any{"field": d.name, "dir": "asc"}}
	}
	query("rows", rows)
	var subtitle []string
	for _, k := range []string{d.status, d.floor} {
		if k != "" {
			subtitle = append(subtitle, k)
		}
	}
	if len(d.numbers) > 0 {
		subtitle = append(subtitle, d.numbers[0].Key)
	}
	widget(map[string]any{"id": "explorer", "kind": "facilityExplorer", "queryRef": "rows", "title": src.Name,
		"bindings": map[string]any{"zoneId": zoneID, "tabs": []any{map[string]any{
			"kind": "dataLink", "entity": "data", "dataLinkId": link.ID, "queryRef": "rows", "sourceId": src.ID,
			"label": src.Name, "titleField": d.name, "subtitle": subtitle,
		}}}})

	// Params + option queries for the viewer filters.
	for _, v := range vfs {
		vfMeta := map[string]any{"id": v.id, "field": v.field, "label": v.label, "kind": v.kind, "sourceIds": []int64{src.ID}}
		if v.kind == "search" {
			params = append(params, map[string]any{"id": v.id, "label": v.label, "input": map[string]any{"kind": "textInput", "placeholder": "Search by " + strings.ToLower(label(v.field))}})
			vfMeta["options"] = map[string]any{"placeholder": "Search by " + strings.ToLower(label(v.field))}
		} else {
			params = append(params, map[string]any{"id": v.id, "label": v.label, "input": map[string]any{"kind": "dropdown",
				"options": map[string]any{"fromQuery": "opt_" + v.id, "valueColumn": v.field}}})
			queries = append(queries, map[string]any{"name": "opt_" + v.id, "sourceRef": ref,
				"filters": map[string]any{"and": []any{map[string]any{"cond": map[string]any{"field": v.field, "op": "notnull"}}}},
				"groupBy": []string{v.field}, "sort": []any{map[string]any{"field": v.field, "dir": "asc"}}, "limit": 500})
		}
		viewerFilters = append(viewerFilters, vfMeta)
	}

	spec := map[string]any{
		"v": 2, "reportType": "detail",
		"origin":  map[string]any{"kind": DataLinkOrigin, "key": dataLinkOriginKey(src.ID), "zoneId": zoneID},
		"sources": []any{ref}, "params": params, "viewerFilters": viewerFilters, "queries": queries,
		"layout": map[string]any{"kind": "document"}, "widgets": widgets,
	}
	return FacilityReportDef{
		Key:         dataLinkOriginKey(src.ID),
		Name:        src.Name,
		Description: fmt.Sprintf("Live data from %s, %s.", src.Name, linkTargetLabel(link, fm)),
		Icon:        "activity",
		Color:       "#f97316",
		Spec:        spec,
	}, nil
}

// CreateDataLinkReports creates the missing linked-data reports for one
// facility: one per data table its links read (the lowest link id
// decides the placement rules). Returns the new report ids.
func CreateDataLinkReports(ctx context.Context, q *db.Queries, tenantID, zoneID, createdBy int64) ([]int64, error) {
	links, err := q.ListDataLinkConfigsByZone(ctx, zoneID)
	if err != nil {
		return nil, err
	}
	have, err := q.ListReportOriginKeys(ctx, db.ListReportOriginKeysParams{
		TenantID: tenantID, ZoneID: pgtype.Int8{Int64: zoneID, Valid: true}, Kind: DataLinkOrigin,
	})
	if err != nil {
		return nil, err
	}
	exists := map[string]bool{}
	for _, k := range have {
		exists[k] = true
	}
	sort.Slice(links, func(i, j int) bool { return links[i].ID < links[j].ID })
	var created []int64
	for _, link := range links {
		if link.TenantID != tenantID || !link.SourceID.Valid {
			continue
		}
		key := dataLinkOriginKey(link.SourceID.Int64)
		if exists[key] {
			continue
		}
		exists[key] = true
		src, err := ResolveSource(ctx, q, tenantID, SourceRef{Kind: "dataSource", ID: link.SourceID.Int64})
		if err != nil || src.Facility != nil {
			continue // source gone, or a built-in facility source
		}
		def, err := DataLinkReportSpec(zoneID, link, src)
		if err != nil {
			return created, err
		}
		raw, err := json.Marshal(def.Spec)
		if err != nil {
			return created, err
		}
		row, err := q.CreateReport(ctx, db.CreateReportParams{
			TenantID: tenantID, Name: def.Name, Description: def.Description, Icon: def.Icon, Color: def.Color,
			Spec: raw, SpecVersion: 2,
			CreatedBy: pgtype.Int8{Int64: createdBy, Valid: createdBy > 0},
			ZoneID:    pgtype.Int8{Int64: zoneID, Valid: true},
		})
		if err != nil {
			return created, fmt.Errorf("create report for source %d: %w", src.ID, err)
		}
		created = append(created, row.ID)
	}
	return created, nil
}
