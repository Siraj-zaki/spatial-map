// Package handlers — demo.go
//
// Idempotent "seed a starter demo" endpoint. Powers the /reports empty
// state's "Seed demo data" button: creates one warehouse-events table
// with realistic-looking rows and three sample v2 reports so a new
// user can click through the whole builder + viewer stack immediately.
//
// Safe to call multiple times — each piece is name-scoped and skipped
// if it already exists.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Response shape — used by the SPA to render a summary toast after
// the seed runs.
type demoSeedResponse struct {
	TableID        int64  `json:"tableId"`
	TableName      string `json:"tableName"`
	SourcesCreated int    `json:"sourcesCreated"`
	RowsCreated    int    `json:"rowsCreated"`
	ReportsCreated int    `json:"reportsCreated"`
	AlreadySeeded  bool   `json:"alreadySeeded"`
}

const (
	demoTableName       = "Demo · Warehouse Events"
	demoTableEntityKind = "asset"
	demoOverviewReport  = "Demo · Warehouse Overview"
	demoDetailReport    = "Demo · Recent Events"
	demoHistoryReport   = "Demo · Event Trend"
)

// DemoRouter mounts POST /api/v1/demo/seed inside the tenant-scoped
// group so tenantID is populated from context.
func DemoRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Post("/seed", demoSeedHandler(q, pool))
	return r
}

func demoSeedHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}

		ctx := r.Context()
		tx, err := pool.Begin(ctx)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(ctx)
		qtx := q.WithTx(tx)

		resp := demoSeedResponse{}

		// 1. Table — reuse if one with the demo name already exists.
		sources, err := qtx.ListDataSources(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		var demoSource *db.DataSource
		for i := range sources {
			if sources[i].Name == demoTableName {
				demoSource = &sources[i]
				break
			}
		}
		var sourceID int64
		if demoSource == nil {
			created, err := seedDemoTable(ctx, qtx, tenantID)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			sourceID = created
			resp.SourcesCreated = 1
			rowsCreated, err := seedDemoRows(ctx, qtx, tenantID, sourceID)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			resp.RowsCreated = rowsCreated
		} else {
			sourceID = demoSource.ID
		}
		resp.TableID = sourceID
		resp.TableName = demoTableName

		// 2. Reports — skip whichever names already exist. Every demo
		// report references sourceID via `sourceRef.id`.
		reports, err := qtx.ListReportsForTenant(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		existing := make(map[string]bool, len(reports))
		for _, rr := range reports {
			existing[rr.Name] = true
		}

		wantReports := []struct {
			name string
			spec map[string]any
		}{
			{demoOverviewReport, demoOverviewSpec(sourceID)},
			{demoDetailReport, demoDetailSpec(sourceID)},
			{demoHistoryReport, demoHistorySpec(sourceID)},
		}
		for _, wr := range wantReports {
			if existing[wr.name] {
				continue
			}
			specJSON, err := json.Marshal(wr.spec)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			if _, err := qtx.CreateReport(ctx, db.CreateReportParams{
				TenantID:    tenantID,
				Name:        wr.name,
				Description: "Auto-generated demo report",
				Icon:        "",
				Color:       "",
				Spec:        specJSON,
				SpecVersion: 2,
				CreatedBy:   pgtype.Int8{},
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}
			resp.ReportsCreated++
		}

		resp.AlreadySeeded = demoSource != nil && resp.ReportsCreated == 0

		if err := tx.Commit(ctx); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

// seedDemoTable creates the data_source row + its 4 field
// definitions. Fields chosen so every widget kind in the demo reports
// has a natural binding: text/categorical + numeric + timestamp.
func seedDemoTable(ctx context.Context, q *db.Queries, tenantID int64) (int64, error) {
	src, err := q.CreateDataSource(ctx, db.CreateDataSourceParams{
		TenantID:   tenantID,
		Name:       demoTableName,
		Kind:       db.DataSourceKindTable,
		EntityKind: db.DataSourceEntityKind(demoTableEntityKind),
		Config:     json.RawMessage(`{}`),
		Mapping:    json.RawMessage(`{}`),
		Schedule:   pgtype.Text{},
	})
	if err != nil {
		return 0, fmt.Errorf("create data_source: %w", err)
	}

	fields := []struct {
		key, label, dtype string
	}{
		{"zone", "Zone", "text"},
		{"event_type", "Event type", "text"},
		{"units", "Units", "number"},
		{"event_ts", "Event time", "datetime"},
	}
	for i, f := range fields {
		if _, err := q.CreateTableFieldDefinition(ctx, db.CreateTableFieldDefinitionParams{
			TenantID:   tenantID,
			SourceID:   src.ID,
			FieldKey:   f.key,
			FieldLabel: f.label,
			DataType:   f.dtype,
			IsRequired: false,
			IsUnique:   false,
			SortOrder:  int32(i),
		}); err != nil {
			return 0, fmt.Errorf("create field %s: %w", f.key, err)
		}
	}
	return src.ID, nil
}

// seedDemoRows populates ~120 rows: 4 zones × 3 event types × 10
// days, with a random-but-plausible unit count. Timestamps are
// deterministic-per-index so re-runs would produce a stable series
// (though re-runs never happen because we skip when the table exists).
func seedDemoRows(ctx context.Context, q *db.Queries, tenantID, sourceID int64) (int, error) {
	zones := []string{"Receiving", "Storage-A", "Storage-B", "Shipping"}
	events := []string{"pick", "putaway", "cycle_count"}
	// Deterministic PRNG — the specific numbers don't matter, but a
	// stable seed keeps demo screenshots reproducible.
	rng := rand.New(rand.NewSource(42))
	now := time.Now().UTC().Truncate(time.Hour)

	inserted := 0
	for d := 0; d < 10; d++ {
		day := now.Add(time.Duration(-d) * 24 * time.Hour)
		for _, z := range zones {
			for _, e := range events {
				// Slight tone-per-event-type — picks are the busiest,
				// cycle_counts the rarest.
				base := 20
				switch e {
				case "pick":
					base = 60
				case "putaway":
					base = 30
				}
				units := base + rng.Intn(30)
				ts := day.Add(time.Duration(rng.Intn(8*60)) * time.Minute)
				payload := map[string]any{
					"zone":       z,
					"event_type": e,
					"units":      units,
					"event_ts":   ts.Format(time.RFC3339),
				}
				payloadJSON, err := json.Marshal(payload)
				if err != nil {
					return inserted, err
				}
				key := fmt.Sprintf("evt_%d_%s_%s", d, z, e)
				if _, err := q.UpsertDataSourceRow(ctx, db.UpsertDataSourceRowParams{
					TenantID:    tenantID,
					SourceID:    sourceID,
					EntityKey:   key,
					Payload:     payloadJSON,
					PositionWkt: "",
					Ts:          pgtype.Timestamptz{Time: ts, Valid: true},
				}); err != nil {
					return inserted, err
				}
				inserted++
			}
		}
	}
	return inserted, nil
}

// ─────────────────────────────────────────────── report specs
//
// Each spec is v2, references the newly-created source by id, and is
// intentionally minimal — enough to render meaningfully in the viewer
// but leaves room for the user to customise via the wizard.

func demoOverviewSpec(sourceID int64) map[string]any {
	sourceRef := map[string]any{"kind": "dataSource", "id": sourceID}
	return map[string]any{
		"v":          2,
		"reportType": "summary",
		"sources":    []any{sourceRef},
		"queries": []any{
			map[string]any{
				"name":      "primary",
				"sourceRef": sourceRef,
				"groupBy":   []string{"zone"},
				"metrics": []any{
					map[string]any{"fn": "sum", "field": "units", "as": "total_units"},
					map[string]any{"fn": "count", "as": "event_count"},
				},
				"limit": 500,
			},
			map[string]any{
				"name":      "totals",
				"sourceRef": sourceRef,
				"metrics": []any{
					map[string]any{"fn": "sum", "field": "units", "as": "total_units"},
					map[string]any{"fn": "count", "as": "event_count"},
				},
				"limit": 1,
			},
		},
		"layout": map[string]any{"kind": "document"},
		"widgets": []any{
			map[string]any{
				"id": "kpi_total_units", "kind": "bigValue",
				"queryRef": "totals", "order": 5, "columnSpan": 2,
				"title":    "Total units",
				"bindings": map[string]any{"value": "total_units", "label": "Total units", "tone": "blue"},
			},
			map[string]any{
				"id": "kpi_event_count", "kind": "bigValue",
				"queryRef": "totals", "order": 5.01, "columnSpan": 2,
				"title":    "Events",
				"bindings": map[string]any{"value": "event_count", "label": "Events", "tone": "purple"},
			},
			map[string]any{
				"id": "chart_zone_units", "kind": "bar",
				"queryRef": "primary", "order": 10,
				"title":    "Units by zone",
				"bindings": map[string]any{"xAxis": "zone", "series": []string{"total_units"}},
			},
		},
	}
}

func demoDetailSpec(sourceID int64) map[string]any {
	sourceRef := map[string]any{"kind": "dataSource", "id": sourceID}
	return map[string]any{
		"v":          2,
		"reportType": "detail",
		"sources":    []any{sourceRef},
		"queries": []any{
			map[string]any{
				"name":      "primary",
				"sourceRef": sourceRef,
				"sort":      []any{map[string]any{"field": "event_ts", "dir": "desc"}},
				"limit":     200,
			},
		},
		"layout": map[string]any{"kind": "document"},
		"widgets": []any{
			map[string]any{
				"id": "primary_detail", "kind": "dataTable",
				"queryRef": "primary", "order": 10,
				"title": "Recent events",
				"bindings": map[string]any{
					"columns":      []string{"event_ts", "zone", "event_type", "units"},
					"pageSize":     25,
					"searchable":   true,
					"columnToggle": true,
				},
			},
		},
	}
}

func demoHistorySpec(sourceID int64) map[string]any {
	sourceRef := map[string]any{"kind": "dataSource", "id": sourceID}
	return map[string]any{
		"v":          2,
		"reportType": "history",
		"sources":    []any{sourceRef},
		"queries": []any{
			map[string]any{
				"name":      "primary",
				"sourceRef": sourceRef,
				"sort":      []any{map[string]any{"field": "event_ts", "dir": "asc"}},
				"limit":     500,
			},
		},
		"layout": map[string]any{"kind": "document"},
		"widgets": []any{
			map[string]any{
				"id": "primary_history_chart", "kind": "line",
				"queryRef": "primary", "order": 5,
				"title":    "Units over time",
				"bindings": map[string]any{"xAxis": "event_ts", "series": []string{"units"}},
			},
			map[string]any{
				"id": "primary_history_table", "kind": "dataTable",
				"queryRef": "primary", "order": 10,
				"title": "Underlying events",
				"bindings": map[string]any{
					"columns":      []string{"event_ts", "zone", "event_type", "units"},
					"pageSize":     25,
					"searchable":   true,
					"columnToggle": true,
				},
			},
		},
	}
}
