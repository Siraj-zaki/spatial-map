// cleanup-orphans reclaims object-store files that no DB row references
// and no workspace owns (tenant_files). Two use cases:
//
//  1. First-time reclaim of orphans accumulated BEFORE the delete-flow
//     fix (see internal/handlers/file_cleanup.go). Every shape delete,
//     avatar replacement, and catalog remove used to leak — this
//     command sweeps the backlog.
//
//  2. Ongoing safety net. The transactional cleanup path could miss a
//     file if the API server crashes between the DB commit and the
//     store.Delete call, or if a very-narrow race between "delete row"
//     and "re-upload same bytes" leaves a hanging URL (see the race
//     note in cleanupObjectURL). Running this weekly reclaims the
//     stragglers.
//
// Usage:
//
//	# Dry run — prints what would be deleted, changes nothing
//	make cleanup-orphans
//
//	# Actually delete
//	make cleanup-orphans APPLY=1
//
// It's safe to interrupt mid-run: it's idempotent (a partial pass
// leaves the store in a valid state; the next run picks up where it
// left off).
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"os"

	"github.com/Siraj-zaki/spatial-map/backend/internal/config"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
)

func main() {
	apply := flag.Bool("apply", false, "actually delete orphan files (default: dry run)")
	flag.Parse()

	cfgPath := config.StrEnv("SGV_CONFIG", "")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	ctx := context.Background()

	pool, err := db.NewPool(ctx, cfg.Database.URL, cfg.Database.MaxOpenConns, cfg.Database.MaxIdleConns, cfg.Database.ConnMaxLifetime)
	if err != nil {
		log.Fatalf("failed to connect to db: %v", err)
	}
	defer pool.Close()
	q := db.New(pool)

	objectStore, err := store.New(store.Config{
		Type:     cfg.Storage.Type,
		BasePath: cfg.Storage.BasePath,
		BaseURL:  cfg.Storage.BaseURL,
		MinIO: store.MinIOConfig{
			Endpoint:  cfg.Storage.MinIOEndpoint,
			AccessKey: cfg.Storage.MinIOAccessKey,
			SecretKey: cfg.Storage.MinIOSecretKey,
			Bucket:    cfg.Storage.MinIOBucket,
			Region:    cfg.Storage.MinIORegion,
			UseSSL:    cfg.Storage.MinIOUseSSL,
		},
	})
	if err != nil {
		log.Fatalf("failed to create object store: %v", err)
	}

	fmt.Printf("cleanup-orphans: storage=%s dry_run=%t\n", cfg.Storage.Type, !*apply)

	// Build the keep-set from every referenced URL. `KeyFromURL` maps
	// each URL back to its storage key; any key not in this set is
	// unreferenced.
	referencedURLs, err := q.ListReferencedFileURLs(ctx)
	if err != nil {
		log.Fatalf("failed to list referenced urls: %v", err)
	}
	keep := make(map[string]struct{}, len(referencedURLs))
	for _, url := range referencedURLs {
		key := store.KeyFromURL(url)
		if key != "" {
			keep[key] = struct{}{}
		}
	}
	fmt.Printf("  referenced keys in DB: %d\n", len(keep))

	// Uploads a workspace owns (tenant_files) are kept even when unused:
	// that workspace sees them on its Files screen as "Unused" and decides.
	// Only objects no workspace owns or references are swept.
	ownedKeys, err := q.ListOwnedFileKeys(ctx)
	if err != nil {
		log.Fatalf("failed to list owned keys: %v", err)
	}
	for _, key := range ownedKeys {
		keep[key] = struct{}{}
	}
	fmt.Printf("  kept (referenced or owned): %d\n", len(keep))

	allObjects, err := objectStore.ListObjects(ctx)
	if err != nil {
		log.Fatalf("failed to list object-store keys: %v", err)
	}
	fmt.Printf("  keys in object store:  %d\n", len(allObjects))

	var orphans []string
	for _, o := range allObjects {
		if _, ok := keep[o.Key]; ok {
			continue
		}
		orphans = append(orphans, o.Key)
	}
	fmt.Printf("  orphaned keys:         %d\n", len(orphans))

	if len(orphans) == 0 {
		fmt.Println("nothing to reclaim.")
		return
	}

	if !*apply {
		fmt.Println("\ndry run — the following keys WOULD be deleted (re-run with --apply to commit):")
		for _, k := range orphans {
			fmt.Printf("  - %s\n", k)
		}
		return
	}

	var deleted, failed int
	for _, k := range orphans {
		if err := objectStore.Delete(ctx, k); err != nil {
			slog.Warn("delete failed", "key", k, "error", err)
			failed++
			continue
		}
		deleted++
		if deleted%25 == 0 {
			fmt.Printf("  deleted %d orphans…\n", deleted)
		}
	}
	fmt.Printf("done. deleted=%d failed=%d\n", deleted, failed)
	if failed > 0 {
		os.Exit(1)
	}
}
