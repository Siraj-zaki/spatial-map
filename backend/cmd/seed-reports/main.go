// seed-reports — inserts sample reports covering every widget kind
// shipped so far, so the Report Builder can be tested in the browser
// without hand-composing a spec.
//
// Usage:
//
//	cd backend
//	go run ./cmd/seed-reports
//
// The program:
//  1. Loads the same config the API server uses (respects SGV_MODE).
//  2. Picks the first tenant it finds (fails if none exists — sign up
//     first).
//  3. Picks the first `kind='table'` data source that has both field
//     definitions AND at least one row (this is the shape the reports
//     can meaningfully render).
//  4. Creates 3 sample reports directly in the `reports` table,
//     bypassing the HTTP CRUD (no auth token required):
//     * "Sample · Summary" — KPIs + bar chart + donut
//     * "Sample · Detail"  — full-column table + markdown notes
//     * "Sample · History" — history widget + line chart of counts
//
// The reports use permissive ACL (no `report_permissions` rows) —
// tenant owners/admins see them; add explicit rows if a viewer needs
// access.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/config"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	cfg, err := config.Load("")
	if err != nil {
		logger.Error("load config", "err", err)
		os.Exit(1)
	}
	if cfg.Database.URL == "" {
		logger.Error("SGV_DATABASE.URL is empty — set it in .env.development or the env")
		os.Exit(1)
	}

	ctx := context.Background()
	pool, err := db.NewPool(ctx, cfg.Database.URL, 5, 5, 5*time.Minute)
	if err != nil {
		logger.Error("connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	q := db.New(pool)

	tenantID, tenantName, err := pickFirstTenant(ctx, pool)
	if err != nil {
		logger.Error("pick tenant", "err", err)
		os.Exit(1)
	}
	logger.Info("using tenant", "id", tenantID, "name", tenantName)

	src, err := pickSeedableSource(ctx, pool, tenantID)
	if err != nil {
		logger.Error("pick source", "err", err)
		logger.Info("hint: create a table with at least 1 field and push a row before running seed-reports")
		os.Exit(1)
	}
	logger.Info("using source",
		"id", src.ID, "name", src.Name, "kind", src.Kind,
		"fields", len(src.Fields), "rows", src.RowCount,
	)
	if len(src.Fields) == 0 {
		logger.Error("source has no fields — nothing to render")
		os.Exit(1)
	}

	// Pick a text-ish field for grouping and a number-ish one for
	// aggregating. Fall back to the first field for both.
	groupField := firstFieldOfType(src.Fields, "text")
	numericField := firstFieldOfType(src.Fields, "number", "integer")
	if groupField == "" {
		groupField = src.Fields[0].Key
	}
	if numericField == "" && len(src.Fields) > 0 {
		numericField = src.Fields[0].Key
	}

	reports := []struct {
		name        string
		description string
		icon        string
		color       string
		spec        map[string]any
	}{
		{
			name:        "Sample · Summary",
			description: "KPIs + bar + donut. Grouped by " + groupField + ".",
			icon:        "BarChart3",
			color:       "hsl(200 70% 50%)",
			spec: map[string]any{
				"sources": []map[string]any{{"kind": "dataSource", "id": src.ID}},
				"groupBy": []string{groupField},
				"metrics": []map[string]any{
					{"fn": "count", "as": "total"},
				},
				"widgets": []map[string]any{
					{
						"id": "w_kpi", "kind": "kpi", "title": "Total records",
						"bindings": map[string]any{"value": "total", "tone": "blue"},
					},
					{
						"id": "w_bar", "kind": "bar", "title": "Records by " + groupField,
						"bindings": map[string]any{
							"xAxis":  groupField,
							"series": []string{"total"},
						},
					},
					{
						"id": "w_donut", "kind": "donut", "title": "Distribution",
						"bindings": map[string]any{
							"xAxis":  groupField,
							"series": []string{"total"},
						},
					},
				},
			},
		},
		{
			name:        "Sample · Detail",
			description: "Full-row projection with a note above.",
			icon:        "Table2",
			color:       "hsl(160 60% 45%)",
			spec: map[string]any{
				"sources": []map[string]any{{"kind": "dataSource", "id": src.ID}},
				"limit":   500,
				"widgets": []map[string]any{
					{
						"id":   "w_md",
						"kind": "markdown",
						"bindings": map[string]any{
							"content": "## Detail view\n\nEvery row on `" + src.Name + "` as it stands now.\nUse the column header to sort, and the pager below to page.",
						},
					},
					{
						"id": "w_table", "kind": "table", "title": src.Name,
						"bindings": map[string]any{"pageSize": 25},
					},
				},
			},
		},
		{
			name:        "Sample · History",
			description: "What changed on this source over the last 7 days.",
			icon:        "History",
			color:       "hsl(0 70% 55%)",
			spec: map[string]any{
				"sources": []map[string]any{{"kind": "dataSource", "id": src.ID}},
				"widgets": []map[string]any{
					{
						"id": "w_history", "kind": "history", "title": "Row changes (7 days)",
						"bindings": map[string]any{
							"sourceId":   src.ID,
							"windowDays": 7,
							"bucket":     "day",
							"recent":     20,
						},
					},
				},
			},
		},
		{
			name:        "Sample · Interactive",
			description: "Prompt filter (empty value) + custom column headers + conditional rendering + chip cells + column footers.",
			icon:        "Filter",
			color:       "hsl(280 60% 55%)",
			spec:        buildInteractiveSpec(src, groupField, numericField),
		},
	}

	// If a numeric field exists, add a sum-metric line-chart widget to
	// the summary report so we get a second chart type in the sample.
	if numericField != "" && numericField != groupField {
		summary := reports[0].spec
		summary["metrics"] = append(
			summary["metrics"].([]map[string]any),
			map[string]any{"fn": "sum", "field": numericField, "as": "sum_" + numericField},
		)
		summary["widgets"] = append(
			summary["widgets"].([]map[string]any),
			map[string]any{
				"id": "w_line", "kind": "line",
				"title":    "Sum of " + numericField + " by " + groupField,
				"bindings": map[string]any{"xAxis": groupField, "series": []string{"sum_" + numericField}},
			},
		)
	}

	created := 0
	for _, r := range reports {
		specJSON, err := json.Marshal(r.spec)
		if err != nil {
			logger.Error("marshal spec", "name", r.name, "err", err)
			continue
		}
		row, err := q.CreateReport(ctx, db.CreateReportParams{
			TenantID:    tenantID,
			Name:        r.name,
			Description: r.description,
			Icon:        r.icon,
			Color:       r.color,
			Spec:        specJSON,
			SpecVersion: 1,
		})
		if err != nil {
			logger.Error("insert report", "name", r.name, "err", err)
			continue
		}
		created++
		logger.Info("created report", "id", row.ID, "name", row.Name)
	}
	logger.Info("done", "created", created, "of", len(reports))
	if created > 0 {
		fmt.Fprintln(os.Stdout)
		fmt.Fprintln(os.Stdout, "→ Open /reports in the SPA to see the seeded reports.")
	}
}

// -------- helpers ---------------------------------------------------

func pickFirstTenant(ctx context.Context, pool *pgxpool.Pool) (int64, string, error) {
	var id int64
	var name string
	err := pool.QueryRow(ctx, `SELECT id, name FROM tenants ORDER BY id ASC LIMIT 1`).Scan(&id, &name)
	if err != nil {
		return 0, "", fmt.Errorf("no tenants found — sign up first")
	}
	return id, name, nil
}

type seedableField struct {
	Key   string
	Label string
	Type  string
}

type seedableSource struct {
	ID       int64
	Name     string
	Kind     string
	Fields   []seedableField
	RowCount int64
}

// pickSeedableSource returns the first data source that has at least
// one field definition (for `kind='table'`) OR at least one row (for
// `kind='rest'|'webhook'|'file'`). Table-kind is preferred because its
// schema is authoritative — sample-inferred schemas from other kinds
// depend on rows already being present.
func pickSeedableSource(ctx context.Context, pool *pgxpool.Pool, tenantID int64) (*seedableSource, error) {
	// Preferred: any table-kind source with at least one field.
	rows, err := pool.Query(ctx, `
		SELECT ds.id, ds.name, ds.kind::text
		FROM data_sources ds
		WHERE ds.tenant_id = $1 AND ds.kind = 'table' AND ds.deleted_at IS NULL
		ORDER BY ds.id ASC
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var candidates []seedableSource
	for rows.Next() {
		var s seedableSource
		if err := rows.Scan(&s.ID, &s.Name, &s.Kind); err != nil {
			return nil, err
		}
		candidates = append(candidates, s)
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	// For each candidate, load fields + row count and pick the first
	// that has both.
	for i := range candidates {
		c := &candidates[i]
		fieldRows, err := pool.Query(ctx, `
			SELECT field_key, field_label, data_type
			FROM table_field_definitions
			WHERE source_id = $1 AND tenant_id = $2
			ORDER BY sort_order ASC, id ASC
		`, c.ID, tenantID)
		if err != nil {
			return nil, err
		}
		for fieldRows.Next() {
			var f seedableField
			if err := fieldRows.Scan(&f.Key, &f.Label, &f.Type); err != nil {
				fieldRows.Close()
				return nil, err
			}
			c.Fields = append(c.Fields, f)
		}
		fieldRows.Close()
		if fieldRows.Err() != nil {
			return nil, fieldRows.Err()
		}
		_ = pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM data_source_rows WHERE source_id = $1 AND tenant_id = $2
		`, c.ID, tenantID).Scan(&c.RowCount)
		if len(c.Fields) > 0 && c.RowCount > 0 {
			return c, nil
		}
	}

	// Fallback: any table-kind with fields (rows can arrive later).
	for _, c := range candidates {
		if len(c.Fields) > 0 {
			return &c, nil
		}
	}
	if len(candidates) > 0 {
		return &candidates[0], fmt.Errorf("no source has field definitions yet — create a table with fields first")
	}
	return nil, fmt.Errorf("no data sources found for tenant %d", tenantID)
}

// buildInteractiveSpec composes the "Sample · Interactive" report:
//   - A prompt filter on `groupField` (empty value → viewer shows an
//     input for it; nothing is filtered until the user fills it in).
//   - A table widget with an explicit column list, custom labels, a
//     number format on the numeric field, right-alignment, and a
//     conditional rule that highlights values > 0 in emerald.
//   - A page size small enough (10) that pagination is visible on
//     even modest data volumes.
func buildInteractiveSpec(src *seedableSource, groupField, numericField string) map[string]any {
	// Column list = every schema field, in declared order.
	columns := make([]string, 0, len(src.Fields))
	for _, f := range src.Fields {
		columns = append(columns, f.Key)
	}
	columnConfig := map[string]any{}
	for _, f := range src.Fields {
		cfg := map[string]any{"label": titleCase(f.Label)}
		if f.Type == "number" || f.Type == "integer" {
			cfg["format"] = "number"
			cfg["align"] = "right"
		}
		// Any short-form text field (name matches status/type/state/
		// role/kind/severity/level) becomes a chip column by default —
		// this is the most common "status-ish" pattern and it makes
		// the seed report look immediately data-dense in the viewer.
		lower := strings.ToLower(f.Key)
		for _, hint := range []string{"status", "type", "state", "role", "kind", "severity", "level", "category"} {
			if strings.Contains(lower, hint) {
				cfg["chip"] = true
				break
			}
		}
		// Numeric fields get a sum footer so the seeded report demos
		// the column-aggregation UI immediately.
		if f.Type == "number" || f.Type == "integer" {
			cfg["footer"] = "sum"
		}
		columnConfig[f.Key] = cfg
	}
	// Conditional highlight on the numeric field, if we have one:
	// values greater than 0 render in emerald + semibold.
	if numericField != "" {
		if _, ok := columnConfig[numericField]; !ok {
			columnConfig[numericField] = map[string]any{}
		}
		cfg := columnConfig[numericField].(map[string]any)
		cfg["conditions"] = []map[string]any{
			{
				"column":    numericField,
				"op":        "gt",
				"value":     0,
				"className": "text-success font-semibold",
			},
		}
		columnConfig[numericField] = cfg
	}
	spec := map[string]any{
		"sources": []map[string]any{{"kind": "dataSource", "id": src.ID}},
		"limit":   500,
		// Empty-value filter → runtime prompt in the viewer.
		"filters": map[string]any{
			"and": []map[string]any{
				{
					"cond": map[string]any{
						"field": groupField,
						"op":    "eq",
						"value": "",
					},
				},
			},
		},
		"widgets": []map[string]any{
			{
				"id":   "w_md",
				"kind": "markdown",
				"bindings": map[string]any{
					"content": "## Interactive report\n\n**Prompt filter** — the input above the widget lets you pick a value at run time.\nColumns have **custom headers**, the numeric column is right-aligned + formatted, and positive values are highlighted.",
				},
			},
			{
				"id":    "w_table",
				"kind":  "table",
				"title": "Filtered rows",
				"bindings": map[string]any{
					"pageSize":     10,
					"columns":      columns,
					"columnConfig": columnConfig,
				},
			},
		},
	}
	return spec
}

// titleCase — small helper to give the seeded custom labels a
// prettier look than the raw field key ("bin_status" → "Bin Status").
// Deliberately avoids strings.Title (deprecated in Go 1.18+).
func titleCase(s string) string {
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == '_' || r == '-' || r == ' ' })
	for i, p := range parts {
		if len(p) == 0 {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, " ")
}

func firstExactField(fields []seedableField, hints ...string) string {
	for _, f := range fields {
		low := strings.ToLower(f.Key)
		for _, h := range hints {
			if low == h {
				return f.Key
			}
		}
	}
	return ""
}

// pickMapSource picks the best source for a map sample. Preference:
//  1. A source (any kind) with populated `position` PostGIS points —
//     the executor projects `_lng`/`_lat` for free so no payload
//     dependency is needed.
//  2. The primary source if it has an EXACT `lat`+`lng` pair in its
//     declared fields.
//
// Returns (source, latCol, lngCol) or (nil, "", "") when nothing
// suitable is available. `latCol`/`lngCol` are the coord column names
// the map widget should bind to.
func firstFieldOfType(fields []seedableField, types ...string) string {
	for _, f := range fields {
		for _, t := range types {
			if strings.EqualFold(f.Type, t) {
				return f.Key
			}
		}
	}
	return ""
}
