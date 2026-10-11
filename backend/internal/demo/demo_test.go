package demo

// Loads the real pack into a freshly migrated Postgres+PostGIS container:
// the only way to prove every exported column still parses (geometry,
// enums, arrays, JSONB) against the current schema. Gated like the other
// container tests — set RUN_INTEGRATION=true in CI.

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/auth"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/migrate"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func setupPostgres(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	cwd, err := os.Getwd()
	require.NoError(t, err)

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
	t.Cleanup(func() { _ = container.Terminate(ctx) })

	connStr, err := container.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	require.NoError(t, migrate.Up(connStr, filepath.Join(cwd, "..", "..", "migrations")))

	pool, err := db.NewPool(ctx, connStr, 5, 5, 30*time.Minute)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool
}

func TestSeed_LoadsPackOnceIntoEmptyDatabase(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	ctx := context.Background()
	pool := setupPostgres(t)
	objects, err := store.New(store.Config{Type: "local", BasePath: t.TempDir(), BaseURL: "/files"})
	require.NoError(t, err)

	man, err := readManifest(pack)
	require.NoError(t, err)
	now := man.ExportedAt.Add(30 * 24 * time.Hour)

	tenantID, err := seed(ctx, pool, objects, pack, now)
	require.NoError(t, err)
	require.NotZero(t, tenantID)

	// Every row of every table landed, in the demo workspace.
	for _, tbl := range man.Tables {
		var n int
		require.NoError(t, pool.QueryRow(ctx,
			"SELECT count(*) FROM "+pgx.Identifier{tbl.Name}.Sanitize()).Scan(&n), tbl.Name)
		require.Equal(t, tbl.Rows, n, tbl.Name)
	}
	var foreign int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM zones WHERE tenant_id <> $1`, tenantID).Scan(&foreign))
	require.Zero(t, foreign)

	q := db.New(pool)
	d, err := q.GetDemoTenant(ctx)
	require.NoError(t, err)
	require.Equal(t, tenantID, d.ID)
	require.Equal(t, WorkspaceName, d.Name)

	// Geometry survived the round trip.
	var withCenter int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM zones WHERE center IS NOT NULL AND ST_SRID(center) = 4326`).Scan(&withCenter))
	require.Equal(t, rowsIn(man, "zones"), withCenter)

	// Every table's newest row lands at seed time.
	var stale int
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT count(*) FROM (
		  SELECT source_id, max(greatest(updated_at, ts)) AS newest
		  FROM data_source_rows GROUP BY source_id
		) s WHERE abs(extract(epoch FROM s.newest - $1::timestamptz)) > 1`, now).Scan(&stale))
	require.Zero(t, stale)

	// Sequences moved past the kept ids: a plain insert gets a fresh id.
	var maxID, newID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT max(id) FROM polygons`).Scan(&maxID))
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO polygons (tenant_id, zone_id, name, vertices, config, unit)
		SELECT $1, id, 'probe', '[]'::jsonb, '{}'::jsonb, 'm' FROM zones LIMIT 1 RETURNING id`, tenantID).Scan(&newID))
	require.Greater(t, newID, maxID)

	// Files were stored.
	for _, f := range man.Files {
		_, err := objects.Get(ctx, f.Key)
		require.NoError(t, err, f.Key)
	}

	// The bootstrap admin owns the demo and gets a workspace of their own.
	require.NoError(t, auth.Bootstrap(ctx, q, "admin@example.com", "a-long-test-password"))
	admin, err := q.GetUserByEmail(ctx, "admin@example.com")
	require.NoError(t, err)
	memberships, err := q.ListUserTenants(ctx, admin.ID)
	require.NoError(t, err)
	require.Len(t, memberships, 2)
	for _, m := range memberships {
		require.Equal(t, "owner", m.Role)
	}

	// Never again: not while workspaces exist, and not after the demo is
	// deleted along with every other workspace.
	again, err := seed(ctx, pool, objects, pack, now)
	require.NoError(t, err)
	require.Zero(t, again)
	_, err = pool.Exec(ctx, `DELETE FROM tenants`)
	require.NoError(t, err)
	again, err = seed(ctx, pool, objects, pack, now)
	require.NoError(t, err)
	require.Zero(t, again)
}

func TestShiftTimes(t *testing.T) {
	d := 48 * time.Hour
	got := shiftTimes(map[string]any{
		"ts":   "2026-10-01T08:30:00.5+00:00",
		"day":  "2026-10-01",
		"name": "Aisle 2026-10-01 B",
		"list": []any{"2026-10-02T00:00:00Z", 3},
	}, d).(map[string]any)
	require.Equal(t, "2026-10-03T08:30:00.5Z", got["ts"])
	require.Equal(t, "2026-10-03", got["day"])
	require.Equal(t, "Aisle 2026-10-01 B", got["name"])
	require.Equal(t, "2026-10-04T00:00:00Z", got["list"].([]any)[0])
}

func rowsIn(m *manifest, table string) int {
	for _, t := range m.Tables {
		if t.Name == table {
			return t.Rows
		}
	}
	return 0
}
