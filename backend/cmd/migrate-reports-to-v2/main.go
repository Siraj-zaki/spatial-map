// migrate-reports-to-v2 — one-shot migrator that rewrites every
// v1-shaped `reports.spec` row into the v2 shape defined in
// [github.com/Siraj-zaki/spatial-map/backend/internal/reports/v2].
//
// Run once after deploying the v2 handler:
//
//	cd backend
//	go run ./cmd/migrate-reports-to-v2
//
// The program:
//  1. Loads the same config the API server uses (respects SGV_MODE).
//  2. Selects every row in `reports` whose spec_version < 2.
//  3. For each row: calls [specmigrate.FromRaw], marshals the result,
//     writes the new JSONB back and bumps spec_version to 2.
//  4. Reports counts + any rows that failed.
//
// The migration is idempotent — running it twice on the same DB after
// success finds nothing to do. Failed rows are left as v1 with an
// error log; the operator can fix and re-run.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/config"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports/specmigrate"
	v2 "github.com/Siraj-zaki/spatial-map/backend/internal/reports/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	dry := flag.Bool("dry-run", false, "print the migration plan without writing")
	flag.Parse()

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

	if err := run(ctx, pool, logger, *dry); err != nil {
		logger.Error("migrate", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, dry bool) error {
	// Pull only the rows that need attention — cheap even on large
	// deployments because the filter is on an indexed column.
	rows, err := pool.Query(ctx,
		`SELECT id, tenant_id, name, spec, spec_version FROM reports WHERE spec_version < $1`,
		v2.SpecVersion,
	)
	if err != nil {
		return fmt.Errorf("select v1 rows: %w", err)
	}
	defer rows.Close()

	type target struct {
		id          int64
		tenantID    int64
		name        string
		raw         json.RawMessage
		specVersion int32
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.tenantID, &t.name, &t.raw, &t.specVersion); err != nil {
			return fmt.Errorf("scan row: %w", err)
		}
		targets = append(targets, t)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iter: %w", err)
	}

	logger.Info("found v1 rows to migrate", "count", len(targets))
	if len(targets) == 0 {
		return nil
	}

	if dry {
		for _, t := range targets {
			res, err := specmigrate.FromRaw(t.raw, t.specVersion)
			if err != nil {
				logger.Warn("dry-run: migrate error", "id", t.id, "name", t.name, "err", err)
				continue
			}
			logger.Info("dry-run",
				"id", t.id,
				"name", t.name,
				"queries", len(res.Spec.Queries),
				"widgets", len(res.Spec.Widgets),
				"params", len(res.Spec.Params),
			)
		}
		return nil
	}

	ok, failed := 0, 0
	// Do each row in its own tiny transaction so a bad row doesn't
	// abort the batch. The v1→v2 conversion is idempotent so a
	// crash mid-batch means the next run just picks up where we left
	// off.
	for _, t := range targets {
		if err := migrateOne(ctx, pool, t.id, t.tenantID, t.raw, t.specVersion); err != nil {
			logger.Warn("row failed", "id", t.id, "name", t.name, "err", err)
			failed++
			continue
		}
		ok++
	}
	logger.Info("done", "migrated", ok, "failed", failed, "total", len(targets))
	if failed > 0 {
		return errors.New("some rows failed to migrate")
	}
	return nil
}

func migrateOne(ctx context.Context, pool *pgxpool.Pool, id, tenantID int64, raw json.RawMessage, storedVersion int32) error {
	res, err := specmigrate.FromRaw(raw, storedVersion)
	if err != nil {
		return fmt.Errorf("convert: %w", err)
	}
	if !res.Migrated {
		// Already v2 for some reason — bump the version so future
		// runs stop selecting it.
		if _, err := pool.Exec(ctx,
			`UPDATE reports SET spec_version = $1 WHERE id = $2 AND tenant_id = $3`,
			v2.SpecVersion, id, tenantID,
		); err != nil {
			return fmt.Errorf("update version: %w", err)
		}
		return nil
	}
	newRaw, err := json.Marshal(res.Spec)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // safe: no-op after commit
	if _, err := tx.Exec(ctx,
		`UPDATE reports
		 SET spec = $1::jsonb, spec_version = $2
		 WHERE id = $3 AND tenant_id = $4`,
		newRaw, v2.SpecVersion, id, tenantID,
	); err != nil {
		return fmt.Errorf("update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}
