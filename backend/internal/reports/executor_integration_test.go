package reports_test

// End-to-end tests for the report executor against a real Postgres
// container. These are heavier than the compile-only unit tests in
// `executor_test.go` — they actually run the compiled SQL — but they
// are the only way to catch SQL-shape bugs the compiler can't spot
// (mismatched SELECT/GROUP BY expressions, misordered args, unsupported
// operator combinations). Every scenario that has shipped as a real
// user-facing bug should live here so a regression can't slip past
// `make sqlc` and `go build` again.
//
// The container spin-up cost is ~20 s per run — the tests are gated
// on `RUN_INTEGRATION=true` in CI, matching the convention set by
// `handlers/handlers_test.go`.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/migrate"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// setupPostgres spins up a Postgres+PostGIS container, applies the
// full migration set, and returns a pool + cleanup. The `spatial`
// database + user match the handler tests so a single running Postgres
// image serves both.
func setupPostgres(t *testing.T) (*pgxpool.Pool, *db.Queries, func()) {
	t.Helper()
	ctx := context.Background()
	cwd, err := os.Getwd()
	require.NoError(t, err)
	migrationsPath := filepath.Join(cwd, "..", "..", "migrations")

	container, err := postgres.Run(ctx,
		"postgis/postgis:16-3.4",
		postgres.WithDatabase("spatial"),
		postgres.WithUsername("spatial"),
		postgres.WithPassword("spatial"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	require.NoError(t, err)

	connStr, err := container.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	require.NoError(t, migrate.Up(connStr, migrationsPath))

	pool, err := db.NewPool(ctx, connStr, 5, 5, 30*time.Minute)
	require.NoError(t, err)

	return pool, db.New(pool), func() {
		pool.Close()
		_ = container.Terminate(ctx)
	}
}

// seedFixture inserts one tenant, one `kind='table'` data source with
// three field definitions (status TEXT, quantity NUMBER, created_at
// DATETIME), and four rows so the executor has something to aggregate
// over. Returns tenantID + sourceID.
func seedFixture(t *testing.T, pool *pgxpool.Pool) (int64, int64) {
	t.Helper()
	ctx := context.Background()

	var tenantID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO tenants (name, color) VALUES ('exec-test', '#000000') RETURNING id`,
	).Scan(&tenantID))

	var sourceID int64
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO data_sources (tenant_id, name, kind, entity_kind, config, mapping)
		VALUES ($1, 'fixture', 'table', 'marker', '{}'::jsonb, '{}'::jsonb)
		RETURNING id
	`, tenantID).Scan(&sourceID))

	for i, def := range []struct {
		key, label, dt string
	}{
		{"status", "Status", "text"},
		{"quantity", "Quantity", "number"},
		{"created_at", "Created", "datetime"},
	} {
		_, err := pool.Exec(ctx, `
			INSERT INTO table_field_definitions
			  (tenant_id, source_id, field_key, field_label, data_type, is_required, is_unique, sort_order)
			VALUES ($1, $2, $3, $4, $5, false, false, $6)
		`, tenantID, sourceID, def.key, def.label, def.dt, i)
		require.NoError(t, err)
	}

	rows := []map[string]any{
		{"status": "occupied", "quantity": 10, "created_at": "2026-08-01T00:00:00Z"},
		{"status": "occupied", "quantity": 20, "created_at": "2026-08-02T00:00:00Z"},
		{"status": "empty", "quantity": 0, "created_at": "2026-08-03T00:00:00Z"},
		{"status": "reserved", "quantity": 5, "created_at": "2026-08-04T00:00:00Z"},
	}
	for i, r := range rows {
		payload, _ := json.Marshal(r)
		_, err := pool.Exec(ctx, `
			INSERT INTO data_source_rows (tenant_id, source_id, entity_key, payload)
			VALUES ($1, $2, $3, $4::jsonb)
		`, tenantID, sourceID, fixtureKey(i), payload)
		require.NoError(t, err)
	}
	return tenantID, sourceID
}

func fixtureKey(i int) string { return "row-" + string(rune('a'+i)) }

// TestExecutor_GroupByAndMetric_ActualSQL is the test that would have
// caught the bug the user reported ("column data_source_rows.payload
// must appear in the GROUP BY clause"). It runs the compiled SQL
// against real Postgres for every field type we support in a groupBy
// position. A mismatch between the SELECT projection and the GROUP BY
// expression fails at query time, not at compile time — this is the
// only test shape that catches it.
func TestExecutor_GroupByAndMetric_ActualSQL(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	pool, q, cleanup := setupPostgres(t)
	defer cleanup()

	tenantID, sourceID := seedFixture(t, pool)
	exec := reports.NewExecutor(pool)

	src, err := reports.ResolveSource(context.Background(), q, tenantID,
		reports.SourceRef{Kind: "dataSource", ID: sourceID})
	require.NoError(t, err)

	// Text groupBy + count metric — the shape from the original bug.
	res, err := exec.Run(context.Background(), tenantID, src, reports.Spec{
		Sources: []reports.SourceRef{{Kind: "dataSource", ID: sourceID}},
		GroupBy: []string{"status"},
		Metrics: []reports.Metric{{Fn: "count", As: "total"}},
	})
	require.NoError(t, err, "groupBy=text + count should execute cleanly")
	require.Equal(t, 3, len(res.Rows), "expected 3 distinct statuses")

	// Number groupBy + count metric — a shape that would break with
	// the pre-fix compiler (SELECT projected `(payload->>'quantity')::numeric`,
	// GROUP BY had `payload->>'quantity'`).
	_, err = exec.Run(context.Background(), tenantID, src, reports.Spec{
		Sources: []reports.SourceRef{{Kind: "dataSource", ID: sourceID}},
		GroupBy: []string{"quantity"},
		Metrics: []reports.Metric{{Fn: "count", As: "total"}},
	})
	require.NoError(t, err, "groupBy=number + count should execute cleanly")

	// Datetime groupBy + count metric.
	_, err = exec.Run(context.Background(), tenantID, src, reports.Spec{
		Sources: []reports.SourceRef{{Kind: "dataSource", ID: sourceID}},
		GroupBy: []string{"created_at"},
		Metrics: []reports.Metric{{Fn: "count", As: "total"}},
	})
	require.NoError(t, err, "groupBy=datetime + count should execute cleanly")

	// GroupBy + metric + sort on the groupBy field (legal).
	_, err = exec.Run(context.Background(), tenantID, src, reports.Spec{
		Sources: []reports.SourceRef{{Kind: "dataSource", ID: sourceID}},
		GroupBy: []string{"status"},
		Metrics: []reports.Metric{{Fn: "count", As: "total"}},
		Sort:    []reports.SortKey{{Field: "status", Dir: "asc"}},
	})
	require.NoError(t, err, "sort on groupBy field should execute cleanly")

	// GroupBy + metric + sort on metric alias (legal).
	_, err = exec.Run(context.Background(), tenantID, src, reports.Spec{
		Sources: []reports.SourceRef{{Kind: "dataSource", ID: sourceID}},
		GroupBy: []string{"status"},
		Metrics: []reports.Metric{{Fn: "count", As: "total"}},
		Sort:    []reports.SortKey{{Field: "total", Dir: "desc"}},
	})
	require.NoError(t, err, "sort on metric alias should execute cleanly")

	// GroupBy + metric + sort on OTHER schema field — must be rejected
	// at compile time (this is the second half of the bug fix).
	_, err = exec.Run(context.Background(), tenantID, src, reports.Spec{
		Sources: []reports.SourceRef{{Kind: "dataSource", ID: sourceID}},
		GroupBy: []string{"status"},
		Metrics: []reports.Metric{{Fn: "count", As: "total"}},
		Sort:    []reports.SortKey{{Field: "created_at", Dir: "desc"}},
	})
	require.Error(t, err, "sort on ungrouped field in aggregate context must be rejected")
}

// TestExecutor_MetricsWithoutGroupBy verifies the pure-aggregate case
// (no groupBy, multiple metrics) — should collapse to a single row
// with the aggregate values.
func TestExecutor_MetricsWithoutGroupBy(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	pool, q, cleanup := setupPostgres(t)
	defer cleanup()
	tenantID, sourceID := seedFixture(t, pool)

	src, err := reports.ResolveSource(context.Background(), q, tenantID,
		reports.SourceRef{Kind: "dataSource", ID: sourceID})
	require.NoError(t, err)

	res, err := reports.NewExecutor(pool).Run(context.Background(), tenantID, src, reports.Spec{
		Sources: []reports.SourceRef{{Kind: "dataSource", ID: sourceID}},
		Metrics: []reports.Metric{
			{Fn: "count", As: "total"},
			{Fn: "sum", Field: "quantity", As: "sum_qty"},
			{Fn: "avg", Field: "quantity", As: "avg_qty"},
		},
	})
	require.NoError(t, err)
	require.Equal(t, 1, len(res.Rows), "aggregate-only result should be one row")
	require.Equal(t, 3, len(res.Columns))
}

// TestExecutor_RunReturnsEmptyRowsNotNil guards the wire shape of
// `Result.Rows` when the query has zero matching rows. Go's `var
// rows [][]any` serializes to JSON `null`, which crashed the viewer
// at `result.rows.length` (2026-08-23). The fix initializes Rows to
// `[][]any{}` in the executor so the wire is always `"rows": []`.
func TestExecutor_RunReturnsEmptyRowsNotNil(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	pool, q, cleanup := setupPostgres(t)
	defer cleanup()
	tenantID, sourceID := seedFixture(t, pool)

	src, err := reports.ResolveSource(context.Background(), q, tenantID,
		reports.SourceRef{Kind: "dataSource", ID: sourceID})
	require.NoError(t, err)

	// A filter that matches nothing — forces an empty result set.
	res, err := reports.NewExecutor(pool).Run(context.Background(), tenantID, src, reports.Spec{
		Sources: []reports.SourceRef{{Kind: "dataSource", ID: sourceID}},
		Filters: &reports.Node{Cond: &reports.Cond{
			Field: "status", Op: "eq", Value: []byte(`"__never_matches__"`),
		}},
	})
	require.NoError(t, err)
	require.NotNil(t, res.Rows, "Rows must be an initialized slice, never nil")
	require.Equal(t, 0, len(res.Rows))
	require.NotNil(t, res.Columns)
}

// TestExecutor_HistoryEmpty is a small guard for the History widget's
// wire contract: when a source has zero events the query still
// returns a `[]` — not nil — so the frontend can call `.length` on it
// without crashing. The bug it defends against shipped once
// (2026-08-23: "Uncaught TypeError: Cannot read properties of null
// (reading 'length')") when the handler was initializing
// `recentEvents` as a nil slice.
func TestExecutor_HistoryEmpty(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	pool, q, cleanup := setupPostgres(t)
	defer cleanup()
	tenantID, sourceID := seedFixture(t, pool)

	ctx := context.Background()
	buckets, err := q.BucketDataSourceRowEvents(ctx, db.BucketDataSourceRowEventsParams{
		SourceID:   sourceID,
		TenantID:   tenantID,
		Ts:         pgtype.Timestamptz{Time: time.Now().UTC().Add(-24 * time.Hour), Valid: true},
		BucketUnit: "day",
	})
	require.NoError(t, err)
	// `emit_empty_slices: true` in sqlc.yaml means an empty result is
	// still an initialized slice, never nil.
	require.NotNil(t, buckets)
	require.Equal(t, 0, len(buckets))

	recent, err := q.RecentDataSourceRowEvents(ctx, db.RecentDataSourceRowEventsParams{
		SourceID: sourceID, TenantID: tenantID,
		Ts:    pgtype.Timestamptz{Time: time.Now().UTC().Add(-24 * time.Hour), Valid: true},
		Limit: 20,
	})
	require.NoError(t, err)
	require.NotNil(t, recent)
	require.Equal(t, 0, len(recent))
}

// TestExecutor_HistoryBucketing verifies the History widget's backing
// queries fold events into per-bucket rows correctly. Directly hits
// the sqlc-generated `BucketDataSourceRowEvents` + `RecentDataSourceRowEvents`
// so a regression in the query text (e.g. GROUP BY drift) shows up
// here even without the handler layer.
func TestExecutor_HistoryBucketing(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	pool, q, cleanup := setupPostgres(t)
	defer cleanup()
	tenantID, sourceID := seedFixture(t, pool)

	ctx := context.Background()
	now := time.Now().UTC()
	insertEvent := func(offset time.Duration, op string) {
		_, err := pool.Exec(ctx, `
			INSERT INTO data_source_row_events
			  (tenant_id, source_id, entity_key, payload, operation, ts)
			VALUES ($1, $2, 'row-a', '{}'::jsonb, $3, $4)
		`, tenantID, sourceID, op, now.Add(offset))
		require.NoError(t, err)
	}
	// 3 events today (2 inserts, 1 update), 1 update yesterday.
	insertEvent(-1*time.Hour, "insert")
	insertEvent(-2*time.Hour, "insert")
	insertEvent(-3*time.Hour, "update")
	insertEvent(-25*time.Hour, "update")

	buckets, err := q.BucketDataSourceRowEvents(ctx, db.BucketDataSourceRowEventsParams{
		SourceID:   sourceID,
		TenantID:   tenantID,
		Ts:         pgtype.Timestamptz{Time: now.Add(-48 * time.Hour), Valid: true},
		BucketUnit: "day",
	})
	require.NoError(t, err)
	// Two buckets (today, yesterday) × operations that appear.
	// Today has (insert=2, update=1); yesterday has (update=1). So 3 rows.
	require.Equal(t, 3, len(buckets))
	// Sanity: sum of counts equals number of inserted events.
	var total int64
	for _, b := range buckets {
		total += b.EventCount
	}
	require.Equal(t, int64(4), total)

	recent, err := q.RecentDataSourceRowEvents(ctx, db.RecentDataSourceRowEventsParams{
		SourceID: sourceID, TenantID: tenantID,
		Ts:    pgtype.Timestamptz{Time: now.Add(-48 * time.Hour), Valid: true},
		Limit: 10,
	})
	require.NoError(t, err)
	require.Equal(t, 4, len(recent))
	// Most recent first — the event -1h ago should be [0].
	require.Equal(t, "insert", recent[0].Operation)
}

// TestExecutor_RawRowProjection verifies the no-groupBy no-metrics
// path returns one row per data_source_row with entity_key + all
// declared fields projected.
func TestExecutor_RawRowProjection(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	pool, q, cleanup := setupPostgres(t)
	defer cleanup()
	tenantID, sourceID := seedFixture(t, pool)

	src, err := reports.ResolveSource(context.Background(), q, tenantID,
		reports.SourceRef{Kind: "dataSource", ID: sourceID})
	require.NoError(t, err)

	res, err := reports.NewExecutor(pool).Run(context.Background(), tenantID, src, reports.Spec{
		Sources: []reports.SourceRef{{Kind: "dataSource", ID: sourceID}},
	})
	require.NoError(t, err)
	require.Equal(t, 4, len(res.Rows), "expected all four seeded rows")
	// entity_key + 3 declared fields.
	require.Equal(t, 4, len(res.Columns))
}
