// backfill-inventory-reports — one-shot: gives every existing facility
// the facility report set (Overview, Floors, Areas, Racks, Markers &
// sensors, Walls & doors, Stairs/lifts/escalators, Labels & 3D models)
// that new facilities get on create (handlers/zones.go). Run once after
// deploying:
//
//	cd backend
//	go run ./cmd/backfill-inventory-reports [-dry-run] [-tenant N]
//
// Per facility, only the reports of the set it doesn't have yet are
// created. A report counts as present when any report pinned to the
// facility carries spec.origin {kind: "facility-set", key} — archived
// ones included, so a report the user deleted is not brought back, and
// a second run does nothing.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/config"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	dry := flag.Bool("dry-run", false, "list what would be created, write nothing")
	tenant := flag.Int64("tenant", 0, "only this workspace (0 = all)")
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

	if err := run(ctx, pool, logger, *tenant, *dry); err != nil {
		logger.Error("backfill", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, tenant int64, dry bool) error {
	rows, err := pool.Query(ctx, `
		SELECT z.tenant_id, z.id, z.name,
		       coalesce(array_agg(r.spec->'origin'->>'key') FILTER (WHERE r.id IS NOT NULL), '{}')
		FROM zones z
		LEFT JOIN reports r ON r.tenant_id = z.tenant_id AND r.zone_id = z.id
		     AND r.spec->'origin'->>'kind' = $2
		WHERE ($1::bigint = 0 OR z.tenant_id = $1)
		GROUP BY z.tenant_id, z.id, z.name
		ORDER BY z.tenant_id, z.id`, tenant, reports.FacilitySetOrigin)
	if err != nil {
		return fmt.Errorf("select facilities: %w", err)
	}
	type zone struct {
		tenant, id int64
		name       string
		missing    []string
	}
	var todo []zone
	for rows.Next() {
		var z zone
		var have []string
		if err := rows.Scan(&z.tenant, &z.id, &z.name, &have); err != nil {
			rows.Close()
			return err
		}
		got := map[string]bool{}
		for _, k := range have {
			got[k] = true
		}
		for _, k := range reports.FacilityReportKeys() {
			if !got[k] {
				z.missing = append(z.missing, k)
			}
		}
		if len(z.missing) > 0 {
			todo = append(todo, z)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	q := db.New(pool)
	created, failed := 0, 0
	for _, z := range todo {
		if dry {
			logger.Info("would create", "tenant", z.tenant, "facility", z.id, "name", z.name, "reports", z.missing)
			continue
		}
		ids, err := reports.CreateFacilityReports(ctx, q, z.tenant, z.id, 0, z.missing)
		created += len(ids)
		if err != nil {
			failed++
			logger.Error("create", "tenant", z.tenant, "facility", z.id, "err", err)
			continue
		}
		logger.Info("created", "tenant", z.tenant, "facility", z.id, "name", z.name, "reports", ids)
	}
	// Linked-data reports: one per data table linked to each facility.
	zones, err := pool.Query(ctx, `SELECT DISTINCT d.tenant_id, d.zone_id FROM data_link_configs d
		WHERE d.source_id IS NOT NULL AND ($1::bigint = 0 OR d.tenant_id = $1) ORDER BY 1, 2`, tenant)
	if err != nil {
		return fmt.Errorf("select linked facilities: %w", err)
	}
	type tz struct{ tenant, zone int64 }
	var linked []tz
	for zones.Next() {
		var x tz
		if err := zones.Scan(&x.tenant, &x.zone); err != nil {
			zones.Close()
			return err
		}
		linked = append(linked, x)
	}
	zones.Close()
	for _, x := range linked {
		if dry {
			logger.Info("would create linked-data reports", "tenant", x.tenant, "facility", x.zone)
			continue
		}
		ids, err := reports.CreateDataLinkReports(ctx, q, x.tenant, x.zone, 0)
		created += len(ids)
		if err != nil {
			failed++
			logger.Error("linked-data reports", "tenant", x.tenant, "facility", x.zone, "err", err)
			continue
		}
		if len(ids) > 0 {
			logger.Info("created linked-data reports", "tenant", x.tenant, "facility", x.zone, "reports", ids)
		}
	}
	logger.Info("done", "facilities", len(todo), "reports", created, "failed", failed, "dryRun", dry)
	if failed > 0 {
		return fmt.Errorf("%d facilities failed", failed)
	}
	return nil
}
