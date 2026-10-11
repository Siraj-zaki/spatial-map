// seed-demo — end-to-end demo environment for the v2 Reports feature.
//
// Provisions realistic warehouse-operations data + 3 showcase
// dashboards so the app opens with meaningful content out of the box:
//
//  1. Picks (or errors on) the first tenant.
//  2. Idempotently creates three data-source tables:
//     - warehouse_events   (5 fields, ~500 rows)
//     - daily_kpis         (5 fields, 90 × 4 = 360 rows)
//     - alerts             (5 fields, 150 rows)
//  3. Writes three v2-shape reports directly into `reports.spec`
//     that exercise every widget kind we ship: KPIs, BigValue+Delta,
//     Line/Bar/Area/Pie/Donut/Scatter/Heatmap, DataTable,
//     DimensionGrid, Note/Alert.
//
// Usage:
//
//	cd backend
//	go run ./cmd/seed-demo              # add / update the demo data
//	go run ./cmd/seed-demo --reset      # wipe the demo tables + reports first
//
// Only the demo-tagged rows are touched; existing user data is safe.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math"
	"math/rand"
	"os"
	"strconv"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/config"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	demoSourceEventsName = "demo · warehouse_events"
	demoSourceKPIsName   = "demo · daily_kpis"
	demoSourceAlertsName = "demo · alerts"

	demoReportOverviewName = "demo · Warehouse Overview"
	demoReportExplorerName = "demo · Event Explorer"
	demoReportAlertsName   = "demo · Alerts Dashboard"
)

func main() {
	reset := flag.Bool("reset", false, "wipe demo tables + reports before seeding")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	cfg, err := config.Load("")
	if err != nil {
		fail(logger, "load config", err)
	}
	if cfg.Database.URL == "" {
		fail(logger, "empty SGV_DATABASE.URL", errors.New("set it in .env.development"))
	}

	ctx := context.Background()
	pool, err := db.NewPool(ctx, cfg.Database.URL, 5, 5, 5*time.Minute)
	if err != nil {
		fail(logger, "connect", err)
	}
	defer pool.Close()
	q := db.New(pool)

	tenantID, tenantName, err := pickFirstTenant(ctx, pool)
	if err != nil {
		fail(logger, "pick tenant — sign up first", err)
	}
	logger.Info("using tenant", "id", tenantID, "name", tenantName)

	if *reset {
		if err := wipeDemo(ctx, pool, tenantID); err != nil {
			fail(logger, "wipe demo", err)
		}
		logger.Info("wiped demo data + reports")
	}

	// Seed sources + rows.
	eventsID, err := ensureEventsSource(ctx, pool, q, tenantID)
	if err != nil {
		fail(logger, "events source", err)
	}
	kpisID, err := ensureKPIsSource(ctx, pool, q, tenantID)
	if err != nil {
		fail(logger, "kpis source", err)
	}
	alertsID, err := ensureAlertsSource(ctx, pool, q, tenantID)
	if err != nil {
		fail(logger, "alerts source", err)
	}
	logger.Info("sources ready", "events", eventsID, "kpis", kpisID, "alerts", alertsID)

	if err := seedEvents(ctx, pool, tenantID, eventsID); err != nil {
		fail(logger, "seed events", err)
	}
	if err := seedKPIs(ctx, pool, tenantID, kpisID); err != nil {
		fail(logger, "seed kpis", err)
	}
	if err := seedAlerts(ctx, pool, tenantID, alertsID); err != nil {
		fail(logger, "seed alerts", err)
	}

	// Write v2 dashboards.
	if err := ensureReport(ctx, pool, tenantID, demoReportOverviewName, "Live warehouse KPIs, throughput and alerts.", overviewSpec(kpisID, alertsID)); err != nil {
		fail(logger, "overview report", err)
	}
	if err := ensureReport(ctx, pool, tenantID, demoReportExplorerName, "Event explorer with filters and drill-down.", explorerSpec(eventsID)); err != nil {
		fail(logger, "explorer report", err)
	}
	if err := ensureReport(ctx, pool, tenantID, demoReportAlertsName, "Live alerts with DimensionGrid filtering.", alertsSpec(alertsID)); err != nil {
		fail(logger, "alerts report", err)
	}

	logger.Info("demo seeding complete — open /reports to see 3 dashboards")
}

func fail(l *slog.Logger, msg string, err error) {
	l.Error(msg, "err", err)
	os.Exit(1)
}

// ---------------------------------------- tenants + wipe

func pickFirstTenant(ctx context.Context, pool *pgxpool.Pool) (int64, string, error) {
	var id int64
	var name string
	err := pool.QueryRow(ctx, `SELECT id, name FROM tenants ORDER BY id ASC LIMIT 1`).Scan(&id, &name)
	return id, name, err
}

func wipeDemo(ctx context.Context, pool *pgxpool.Pool, tenantID int64) error {
	// Order matters — reports have no FK to sources but we treat both
	// as one bundle. Cascades take permissions + runs with them.
	_, err := pool.Exec(ctx, `
		DELETE FROM reports WHERE tenant_id = $1 AND name LIKE 'demo · %'
	`, tenantID)
	if err != nil {
		return fmt.Errorf("reports: %w", err)
	}
	_, err = pool.Exec(ctx, `
		DELETE FROM data_source_rows
		WHERE tenant_id = $1
		  AND source_id IN (SELECT id FROM data_sources WHERE tenant_id = $1 AND name LIKE 'demo · %')
	`, tenantID)
	if err != nil {
		return fmt.Errorf("rows: %w", err)
	}
	_, err = pool.Exec(ctx, `
		DELETE FROM table_field_definitions
		WHERE tenant_id = $1
		  AND source_id IN (SELECT id FROM data_sources WHERE tenant_id = $1 AND name LIKE 'demo · %')
	`, tenantID)
	if err != nil {
		return fmt.Errorf("fields: %w", err)
	}
	_, err = pool.Exec(ctx, `
		DELETE FROM data_sources WHERE tenant_id = $1 AND name LIKE 'demo · %'
	`, tenantID)
	if err != nil {
		return fmt.Errorf("sources: %w", err)
	}
	return nil
}

// ---------------------------------------- source scaffolding

func ensureEventsSource(ctx context.Context, pool *pgxpool.Pool, q *db.Queries, tenantID int64) (int64, error) {
	fields := []db.CreateTableFieldDefinitionParams{
		{FieldKey: "ts", FieldLabel: "Timestamp", DataType: "datetime"},
		{FieldKey: "zone", FieldLabel: "Zone", DataType: "text"},
		{FieldKey: "event_type", FieldLabel: "Event", DataType: "text"},
		{FieldKey: "operator", FieldLabel: "Operator", DataType: "text"},
		{FieldKey: "duration_sec", FieldLabel: "Duration (s)", DataType: "number"},
	}
	return ensureTableSource(ctx, pool, q, tenantID, demoSourceEventsName, fields)
}

func ensureKPIsSource(ctx context.Context, pool *pgxpool.Pool, q *db.Queries, tenantID int64) (int64, error) {
	fields := []db.CreateTableFieldDefinitionParams{
		{FieldKey: "date", FieldLabel: "Date", DataType: "date"},
		{FieldKey: "zone", FieldLabel: "Zone", DataType: "text"},
		{FieldKey: "throughput", FieldLabel: "Throughput", DataType: "number"},
		{FieldKey: "dwell_avg_min", FieldLabel: "Avg dwell (min)", DataType: "number"},
		{FieldKey: "error_rate_pct", FieldLabel: "Error rate %", DataType: "number"},
	}
	return ensureTableSource(ctx, pool, q, tenantID, demoSourceKPIsName, fields)
}

func ensureAlertsSource(ctx context.Context, pool *pgxpool.Pool, q *db.Queries, tenantID int64) (int64, error) {
	fields := []db.CreateTableFieldDefinitionParams{
		{FieldKey: "created_at", FieldLabel: "Created", DataType: "datetime"},
		{FieldKey: "zone", FieldLabel: "Zone", DataType: "text"},
		{FieldKey: "severity", FieldLabel: "Severity", DataType: "text"},
		{FieldKey: "category", FieldLabel: "Category", DataType: "text"},
		{FieldKey: "resolved", FieldLabel: "Resolved", DataType: "boolean"},
	}
	return ensureTableSource(ctx, pool, q, tenantID, demoSourceAlertsName, fields)
}

func ensureTableSource(
	ctx context.Context,
	pool *pgxpool.Pool,
	q *db.Queries,
	tenantID int64,
	name string,
	fields []db.CreateTableFieldDefinitionParams,
) (int64, error) {
	// Find existing.
	var id int64
	err := pool.QueryRow(ctx,
		`SELECT id FROM data_sources WHERE tenant_id = $1 AND name = $2`,
		tenantID, name,
	).Scan(&id)
	if err == nil {
		return id, nil
	}
	// Create fresh.
	src, err := q.CreateDataSource(ctx, db.CreateDataSourceParams{
		TenantID:   tenantID,
		Name:       name,
		Kind:       db.DataSourceKindTable,
		Config:     json.RawMessage(`{}`),
		Mapping:    json.RawMessage(`{}`),
		Schedule:   pgtype.Text{String: "manual", Valid: true},
		EntityKind: db.DataSourceEntityKind("asset"),
	})
	if err != nil {
		return 0, fmt.Errorf("create source: %w", err)
	}
	for _, f := range fields {
		f.TenantID = tenantID
		f.SourceID = src.ID
		if _, err := q.CreateTableFieldDefinition(ctx, f); err != nil {
			return 0, fmt.Errorf("field %s: %w", f.FieldKey, err)
		}
	}
	return src.ID, nil
}

// ---------------------------------------- row generators

// rng seeded once so successive runs produce the same series — useful
// for eyeballing regressions in the shipped widgets.
var rng = rand.New(rand.NewSource(1))

var zones = []string{"A", "B", "C", "D"}
var eventTypes = []string{"pick", "putaway", "count", "scan"}
var operators = []string{"Sam", "Alex", "Jordan", "Casey", "Riley", "Morgan", "Reese", "Drew"}
var severities = []string{"info", "warn", "critical"}
var categories = []string{"temp", "battery", "fill", "motion"}

func seedEvents(ctx context.Context, pool *pgxpool.Pool, tenantID, sourceID int64) error {
	// Delete any existing demo rows first — idempotent seeding.
	if _, err := pool.Exec(ctx, `DELETE FROM data_source_rows WHERE tenant_id = $1 AND source_id = $2`, tenantID, sourceID); err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(time.Hour)
	// 500 events over the last 30 days with a mild weekday hump.
	for i := 0; i < 500; i++ {
		dayOffset := rng.Intn(30)
		day := now.AddDate(0, 0, -dayOffset)
		// weekday 1-5 gets 1.5x weight
		if day.Weekday() >= time.Saturday && rng.Float64() < 0.35 {
			continue // skip some weekend rows to create the hump
		}
		ts := day.Add(time.Duration(rng.Intn(24)) * time.Hour).Add(time.Duration(rng.Intn(60)) * time.Minute)
		zone := zones[rng.Intn(len(zones))]
		et := eventTypes[rng.Intn(len(eventTypes))]
		op := operators[rng.Intn(len(operators))]
		dur := 4 + rng.Intn(120)
		payload := map[string]any{
			"ts":           ts.Format(time.RFC3339),
			"zone":         zone,
			"event_type":   et,
			"operator":     op,
			"duration_sec": dur,
		}
		if err := insertRow(ctx, pool, tenantID, sourceID, "event-"+strconv.Itoa(i), payload, ts); err != nil {
			return err
		}
	}
	return nil
}

func seedKPIs(ctx context.Context, pool *pgxpool.Pool, tenantID, sourceID int64) error {
	if _, err := pool.Exec(ctx, `DELETE FROM data_source_rows WHERE tenant_id = $1 AND source_id = $2`, tenantID, sourceID); err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(24 * time.Hour)
	// 90 days x 4 zones — 360 rows.
	for d := 0; d < 90; d++ {
		date := now.AddDate(0, 0, -89+d)
		weekdayBoost := 1.0
		if date.Weekday() >= time.Monday && date.Weekday() <= time.Friday {
			weekdayBoost = 1.35
		}
		// Small phase-shift per zone so charts have shape.
		for zi, zone := range zones {
			base := 40.0 + float64(zi)*20 // zone-specific baseline
			throughput := math.Round((base + 30*math.Sin(float64(d)/12+float64(zi))) * weekdayBoost * (0.85 + rng.Float64()*0.3))
			dwell := math.Round((6+float64(zi)*2-2*math.Cos(float64(d)/8))*(0.8+rng.Float64()*0.4)*10) / 10
			errRate := math.Round((0.3+float64(zi)*0.15+rng.Float64()*0.4)*100) / 100
			payload := map[string]any{
				"date":           date.Format("2006-01-02"),
				"zone":           zone,
				"throughput":     throughput,
				"dwell_avg_min":  dwell,
				"error_rate_pct": errRate,
			}
			key := fmt.Sprintf("kpi-%s-%s", date.Format("2006-01-02"), zone)
			if err := insertRow(ctx, pool, tenantID, sourceID, key, payload, date); err != nil {
				return err
			}
		}
	}
	return nil
}

func seedAlerts(ctx context.Context, pool *pgxpool.Pool, tenantID, sourceID int64) error {
	if _, err := pool.Exec(ctx, `DELETE FROM data_source_rows WHERE tenant_id = $1 AND source_id = $2`, tenantID, sourceID); err != nil {
		return err
	}
	now := time.Now().UTC()
	for i := 0; i < 150; i++ {
		daysAgo := rng.Intn(30)
		ts := now.AddDate(0, 0, -daysAgo).Add(-time.Duration(rng.Intn(24)) * time.Hour)
		// Severity distribution weighted toward warn.
		sev := severities[weightedIndex([]int{25, 60, 15})]
		payload := map[string]any{
			"created_at": ts.Format(time.RFC3339),
			"zone":       zones[rng.Intn(len(zones))],
			"severity":   sev,
			"category":   categories[rng.Intn(len(categories))],
			"resolved":   rng.Float64() < 0.45,
		}
		if err := insertRow(ctx, pool, tenantID, sourceID, "alert-"+strconv.Itoa(i), payload, ts); err != nil {
			return err
		}
	}
	return nil
}

func weightedIndex(weights []int) int {
	sum := 0
	for _, w := range weights {
		sum += w
	}
	r := rng.Intn(sum)
	for i, w := range weights {
		if r < w {
			return i
		}
		r -= w
	}
	return len(weights) - 1
}

// insertRow bypasses sqlc for the geometry-heavy UpsertDataSourceRow.
func insertRow(ctx context.Context, pool *pgxpool.Pool, tenantID, sourceID int64, entityKey string, payload map[string]any, ts time.Time) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO data_source_rows (tenant_id, source_id, entity_key, payload, ts)
		VALUES ($1, $2, $3, $4::jsonb, $5)
		ON CONFLICT (source_id, entity_key) DO UPDATE
		  SET payload = EXCLUDED.payload, ts = EXCLUDED.ts, updated_at = now()
	`, tenantID, sourceID, entityKey, b, ts)
	return err
}

// ---------------------------------------- v2 spec builders

// overviewSpec — dashboard #1: KPI strip + line chart + bar + alerts table.
func overviewSpec(kpisID, alertsID int64) map[string]any {
	return map[string]any{
		"v":       2,
		"sources": []map[string]any{{"kind": "dataSource", "id": kpisID}, {"kind": "dataSource", "id": alertsID}},
		"layout":  map[string]any{"kind": "document"},
		"params": []map[string]any{
			{
				"id":    "zone",
				"label": "Zone",
				"input": map[string]any{
					"kind": "dropdown",
					"options": map[string]any{
						"static": []map[string]any{
							{"value": "A", "label": "Zone A"},
							{"value": "B", "label": "Zone B"},
							{"value": "C", "label": "Zone C"},
							{"value": "D", "label": "Zone D"},
						},
					},
				},
			},
		},
		"queries": []map[string]any{
			// Aggregate KPIs across the selected zone (or all zones if empty).
			{
				"name":      "totals",
				"sourceRef": map[string]any{"kind": "dataSource", "id": kpisID},
				"filters": map[string]any{"and": []map[string]any{
					{"cond": map[string]any{"field": "zone", "op": "eq", "value": "{{param.zone}}"}},
				}},
				"metrics": []map[string]any{
					{"fn": "sum", "field": "throughput", "as": "total_throughput"},
					{"fn": "avg", "field": "dwell_avg_min", "as": "avg_dwell"},
					{"fn": "avg", "field": "error_rate_pct", "as": "avg_error"},
					{"fn": "count", "as": "total_rows"},
				},
			},
			// Time series for the line chart.
			{
				"name":      "by_day",
				"sourceRef": map[string]any{"kind": "dataSource", "id": kpisID},
				"filters": map[string]any{"and": []map[string]any{
					{"cond": map[string]any{"field": "zone", "op": "eq", "value": "{{param.zone}}"}},
				}},
				"groupBy": []string{"date"},
				"metrics": []map[string]any{{"fn": "sum", "field": "throughput", "as": "throughput"}},
				"sort":    []map[string]any{{"field": "date", "dir": "asc"}},
				"limit":   365,
			},
			// Bar per zone.
			{
				"name":      "by_zone",
				"sourceRef": map[string]any{"kind": "dataSource", "id": kpisID},
				"groupBy":   []string{"zone"},
				"metrics":   []map[string]any{{"fn": "sum", "field": "throughput", "as": "throughput"}},
				"sort":      []map[string]any{{"field": "zone", "dir": "asc"}},
			},
			// Recent alerts table.
			{
				"name":      "recent_alerts",
				"sourceRef": map[string]any{"kind": "dataSource", "id": alertsID},
				"sort":      []map[string]any{{"field": "created_at", "dir": "desc"}},
				"limit":     15,
			},
		},
		"widgets": []map[string]any{
			{"id": "kpi_throughput", "kind": "bigValue", "order": 1, "queryRef": "totals",
				"bindings": map[string]any{"value": "total_throughput", "label": "Total throughput", "tone": "blue", "format": "number"}},
			{"id": "kpi_dwell", "kind": "bigValue", "order": 2, "queryRef": "totals",
				"bindings": map[string]any{"value": "avg_dwell", "label": "Avg dwell (min)", "tone": "purple", "format": "number"}},
			{"id": "kpi_err", "kind": "bigValue", "order": 3, "queryRef": "totals",
				"bindings": map[string]any{"value": "avg_error", "label": "Avg error %", "tone": "amber", "format": "number"}},
			{"id": "kpi_rows", "kind": "bigValue", "order": 4, "queryRef": "totals",
				"bindings": map[string]any{"value": "total_rows", "label": "Data points", "tone": "emerald", "format": "number"}},
			{"id": "chart_line", "kind": "line", "order": 10, "queryRef": "by_day", "title": "Daily throughput",
				"bindings": map[string]any{"xAxis": "date", "series": []string{"throughput"}}},
			{"id": "chart_bar", "kind": "bar", "order": 20, "queryRef": "by_zone", "title": "Throughput by zone", "columnSpan": 2,
				"bindings": map[string]any{"xAxis": "zone", "series": []string{"throughput"}}},
			{"id": "chart_donut", "kind": "donut", "order": 21, "queryRef": "by_zone", "title": "Zone share", "columnSpan": 2,
				"bindings": map[string]any{"xAxis": "zone", "series": []string{"throughput"}}},
			{"id": "table_alerts", "kind": "dataTable", "order": 30, "queryRef": "recent_alerts", "title": "Recent alerts",
				"bindings": map[string]any{"pageSize": 10, "searchable": true, "columnToggle": true}},
		},
	}
}

// explorerSpec — dashboard #2: filters + scatter + dataTable.
func explorerSpec(eventsID int64) map[string]any {
	return map[string]any{
		"v":       2,
		"sources": []map[string]any{{"kind": "dataSource", "id": eventsID}},
		"layout":  map[string]any{"kind": "document"},
		"params": []map[string]any{
			{
				"id":    "event_type",
				"label": "Event type",
				"input": map[string]any{
					"kind": "buttonGroup",
					"options": map[string]any{
						"static": []map[string]any{
							{"value": "pick", "label": "Pick"},
							{"value": "putaway", "label": "Putaway"},
							{"value": "count", "label": "Count"},
							{"value": "scan", "label": "Scan"},
						},
					},
				},
			},
			{
				"id":    "operator",
				"label": "Operator",
				"input": map[string]any{
					"kind":    "dropdown",
					"options": map[string]any{"fromQuery": "operators_options", "valueColumn": "operator"},
				},
			},
		},
		"queries": []map[string]any{
			{
				"name":      "operators_options",
				"sourceRef": map[string]any{"kind": "dataSource", "id": eventsID},
				"groupBy":   []string{"operator"},
				"sort":      []map[string]any{{"field": "operator", "dir": "asc"}},
				"limit":     50,
			},
			{
				"name":      "events",
				"sourceRef": map[string]any{"kind": "dataSource", "id": eventsID},
				"filters": map[string]any{"and": []map[string]any{
					{"cond": map[string]any{"field": "event_type", "op": "eq", "value": "{{param.event_type}}"}},
					{"cond": map[string]any{"field": "operator", "op": "eq", "value": "{{param.operator}}"}},
				}},
				"sort":  []map[string]any{{"field": "duration_sec", "dir": "desc"}},
				"limit": 300,
			},
			{
				"name":      "by_operator",
				"sourceRef": map[string]any{"kind": "dataSource", "id": eventsID},
				"filters": map[string]any{"and": []map[string]any{
					{"cond": map[string]any{"field": "event_type", "op": "eq", "value": "{{param.event_type}}"}},
				}},
				"groupBy": []string{"operator"},
				"metrics": []map[string]any{
					{"fn": "avg", "field": "duration_sec", "as": "avg_duration"},
					{"fn": "count", "as": "event_count"},
				},
			},
		},
		"widgets": []map[string]any{
			{"id": "note_intro", "kind": "note", "order": 0,
				"bindings": map[string]any{"content": "Explore individual events with the filters at top. The scatter shows avg duration vs volume per operator.", "tone": "info"}},
			{"id": "scatter", "kind": "scatter", "order": 10, "queryRef": "by_operator", "title": "Avg duration vs volume",
				"bindings": map[string]any{"xAxis": "event_count", "yAxis": "avg_duration"}},
			{"id": "table", "kind": "dataTable", "order": 20, "queryRef": "events", "title": "Matching events",
				"bindings": map[string]any{"pageSize": 20, "searchable": true, "columnToggle": true}},
		},
	}
}

// alertsSpec — dashboard #3: DimensionGrid filter + dataTable.
func alertsSpec(alertsID int64) map[string]any {
	return map[string]any{
		"v":       2,
		"sources": []map[string]any{{"kind": "dataSource", "id": alertsID}},
		"layout":  map[string]any{"kind": "document"},
		"params": []map[string]any{
			{
				"id":    "selection",
				"label": "Filter dimensions",
				"input": map[string]any{
					"kind":    "dimensionGrid",
					"columns": []string{"zone", "severity", "category"},
				},
			},
		},
		"queries": []map[string]any{
			{
				"name":      "counts",
				"sourceRef": map[string]any{"kind": "dataSource", "id": alertsID},
				"metrics": []map[string]any{
					{"fn": "count", "as": "total"},
				},
				"extraFilter": "[[ {{param.selection}} ]]",
			},
			{
				"name":        "matching",
				"sourceRef":   map[string]any{"kind": "dataSource", "id": alertsID},
				"sort":        []map[string]any{{"field": "created_at", "dir": "desc"}},
				"limit":       100,
				"extraFilter": "[[ {{param.selection}} ]]",
			},
			{
				"name":      "by_severity",
				"sourceRef": map[string]any{"kind": "dataSource", "id": alertsID},
				"groupBy":   []string{"severity"},
				"metrics":   []map[string]any{{"fn": "count", "as": "count"}},
			},
		},
		"widgets": []map[string]any{
			{"id": "kpi_total", "kind": "bigValue", "order": 1, "queryRef": "counts",
				"bindings": map[string]any{"value": "total", "label": "Matching alerts", "tone": "amber"}},
			{"id": "pie_severity", "kind": "pie", "order": 10, "queryRef": "by_severity", "title": "Alerts by severity",
				"bindings": map[string]any{"xAxis": "severity", "series": []string{"count"}}},
			{"id": "note_grid", "kind": "note", "order": 20,
				"bindings": map[string]any{"content": "Pick chips in the filter above to narrow the table below.", "tone": "tip"}},
			{"id": "table_alerts", "kind": "dataTable", "order": 30, "queryRef": "matching", "title": "Matching alerts",
				"bindings": map[string]any{"pageSize": 15, "searchable": true, "columnToggle": true}},
		},
	}
}

// ---------------------------------------- report persistence

func ensureReport(ctx context.Context, pool *pgxpool.Pool, tenantID int64, name, description string, spec map[string]any) error {
	specJSON, err := json.Marshal(spec)
	if err != nil {
		return err
	}
	// Update existing demo report with the same name, or insert new.
	tag, err := pool.Exec(ctx, `
		UPDATE reports
		SET description = $3, spec = $4::jsonb, spec_version = 2, updated_at = now()
		WHERE tenant_id = $1 AND name = $2
	`, tenantID, name, description, specJSON)
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO reports (tenant_id, name, description, spec, spec_version)
		VALUES ($1, $2, $3, $4::jsonb, 2)
	`, tenantID, name, description, specJSON)
	if err != nil {
		return fmt.Errorf("insert: %w", err)
	}
	return nil
}
