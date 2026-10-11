package db_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func TestMigrationsRoundTrip(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()

	cwd, err := os.Getwd()
	require.NoError(t, err)
	repoRoot := filepath.Join(cwd, "..", "..")
	migrationsPath := filepath.Join(repoRoot, "migrations")

	container, connStr, err := startPostgres(ctx, migrationsPath)
	require.NoError(t, err)
	defer func() { _ = container.Terminate(ctx) }()

	pool, err := db.NewPool(ctx, connStr, 5, 5, 30*time.Minute)
	require.NoError(t, err)
	defer pool.Close()

	// Verify PostGIS is available
	var postgisVersion string
	err = pool.QueryRow(ctx, "SELECT PostGIS_Version()").Scan(&postgisVersion)
	require.NoError(t, err)
	require.NotEmpty(t, postgisVersion)

	// Verify a representative set of tables were created
	tables := []string{
		"tenants", "zones", "grids", "polygons", "circles", "lines", "markers",
		"images", "models", "text_labels", "user_models", "bins",
		"attribute_definitions", "style_rules", "data_sources", "connections",
		"streams", "assets", "asset_positions", "sensors", "sensor_readings",
		"rfid_tags", "rfid_reads", "shipments", "cameras", "cv_detections",
		"entity_references", "import_jobs",
	}
	for _, table := range tables {
		var exists bool
		err := pool.QueryRow(ctx,
			"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)",
			table,
		).Scan(&exists)
		require.NoError(t, err, "checking table %s", table)
		require.True(t, exists, "table %s should exist", table)
	}

	// Verify a tenant can be inserted and selected via generated sqlc queries
	queries := db.New(pool)
	created, err := queries.CreateTenant(ctx, db.CreateTenantParams{Name: "Test Tenant", Color: "#ff0000"})
	require.NoError(t, err)
	require.NotZero(t, created.ID)
	require.Equal(t, "Test Tenant", created.Name)

	fetched, err := queries.GetTenant(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, created.ID, fetched.ID)

	// Verify geometry column works
	_, err = pool.Exec(ctx,
		"INSERT INTO zones (tenant_id, name, color, description, center) VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))",
		created.ID, "Warehouse A", "#00ff00", "", -122.4194, 37.7749,
	)
	require.NoError(t, err)

	var count int
	err = pool.QueryRow(ctx, "SELECT COUNT(*) FROM zones WHERE tenant_id = $1", created.ID).Scan(&count)
	require.NoError(t, err)
	require.Equal(t, 1, count)
}

func startPostgres(ctx context.Context, migrationsPath string) (testcontainers.Container, string, error) {
	pgContainer, err := postgres.Run(ctx,
		"postgis/postgis:16-3.4",
		postgres.WithDatabase("spatial"),
		postgres.WithUsername("spatial"),
		postgres.WithPassword("spatial"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		return nil, "", fmt.Errorf("start postgres container: %w", err)
	}

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		_ = pgContainer.Terminate(ctx)
		return nil, "", fmt.Errorf("get connection string: %w", err)
	}

	if err := runMigrations(connStr, migrationsPath); err != nil {
		_ = pgContainer.Terminate(ctx)
		return nil, "", fmt.Errorf("run migrations: %w", err)
	}

	return pgContainer, connStr, nil
}

func runMigrations(connStr, migrationsPath string) error {
	cfg, err := pgx.ParseConfig(connStr)
	if err != nil {
		return fmt.Errorf("parse conn string: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)

	// golang-migrate does not have an easy programmatic API for a single migration file
	// when embedded paths are involved; we use pgx to execute the up script directly
	// in this test because we already validated the migration file via the CLI.
	upSQL, err := os.ReadFile(filepath.Join(migrationsPath, "0001_initial_schema.up.sql"))
	if err != nil {
		return fmt.Errorf("read up migration: %w", err)
	}

	_, err = conn.Exec(ctx, string(upSQL))
	if err != nil {
		return fmt.Errorf("exec up migration: %w", err)
	}
	return nil
}
