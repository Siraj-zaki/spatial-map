// migrate-storage copies every file from the configured local uploads
// directory into MinIO. Idempotent: files already present in the bucket
// are skipped. Non-destructive: local files are NEVER deleted so a bad
// run can be redone or the fallback path can keep serving them.
//
// Usage:
//
//	# Copy ./uploads → MinIO bucket (reads env from .env.development)
//	make migrate-storage
//
//	# Or invoke directly with an explicit source dir:
//	SGV_STORAGE.BASE_PATH=/var/lib/sgv/uploads \
//	SGV_STORAGE.MINIO_ENDPOINT=minio.internal:9000 \
//	SGV_STORAGE.MINIO_ACCESS_KEY=... \
//	SGV_STORAGE.MINIO_SECRET_KEY=... \
//	SGV_STORAGE.MINIO_BUCKET=sgv-uploads \
//	  go run ./cmd/migrate-storage
//
// The recommended cutover procedure:
//  1. Boot MinIO (`docker compose up minio`) and confirm reachable.
//  2. Set SGV_STORAGE.TYPE=minio-fallback and restart the API. Existing
//     files still serve from disk; new uploads land in MinIO.
//  3. Run this command. Bulk-copies the disk contents into MinIO.
//  4. Set SGV_STORAGE.TYPE=minio and restart. The API now reads only
//     from MinIO; you can (optionally) delete ./uploads.
//
// Skipping step 2 is fine on a low-traffic system — the fallback mode
// exists so you can flip the flag first without a maintenance window.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/Siraj-zaki/spatial-map/backend/internal/config"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
)

func main() {
	cfgPath := config.StrEnv("SGV_CONFIG", "")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	if cfg.Storage.BasePath == "" {
		log.Fatalf("SGV_STORAGE.BASE_PATH is empty — nothing to migrate")
	}
	if cfg.Storage.MinIOEndpoint == "" || cfg.Storage.MinIOAccessKey == "" || cfg.Storage.MinIOSecretKey == "" || cfg.Storage.MinIOBucket == "" {
		log.Fatalf("MinIO config incomplete — set SGV_STORAGE.MINIO_{ENDPOINT,ACCESS_KEY,SECRET_KEY,BUCKET}")
	}

	minioStore, err := store.NewMinIOStore(store.MinIOConfig{
		Endpoint:  cfg.Storage.MinIOEndpoint,
		AccessKey: cfg.Storage.MinIOAccessKey,
		SecretKey: cfg.Storage.MinIOSecretKey,
		Bucket:    cfg.Storage.MinIOBucket,
		Region:    cfg.Storage.MinIORegion,
		UseSSL:    cfg.Storage.MinIOUseSSL,
	}, cfg.Storage.BaseURL)
	if err != nil {
		log.Fatalf("failed to connect to MinIO: %v", err)
	}

	ctx := context.Background()
	stats := migrateDir(ctx, minioStore, cfg.Storage.BasePath)

	slog.Info("storage migration complete",
		"source", cfg.Storage.BasePath,
		"bucket", cfg.Storage.MinIOBucket,
		"copied", stats.copied,
		"skipped", stats.skipped,
		"failed", stats.failed,
	)
	if stats.failed > 0 {
		os.Exit(1)
	}
}

type migrateStats struct {
	copied  int
	skipped int
	failed  int
}

// migrateDir walks basePath and uploads every regular file to MinIO. It
// skips files already present in the bucket so re-runs cost only a
// HEAD-equivalent per file. Symlinks are ignored; nested directories
// are supported (key = path relative to basePath).
func migrateDir(ctx context.Context, dst *store.MinIOStore, basePath string) migrateStats {
	var stats migrateStats

	err := filepath.WalkDir(basePath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			slog.Warn("walk error", "path", path, "error", err)
			return nil
		}
		if d.IsDir() {
			return nil
		}
		// Skip the atomic-write temp file LocalStore leaves behind.
		if filepath.Ext(path) == ".tmp" {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			slog.Warn("stat error", "path", path, "error", err)
			stats.failed++
			return nil
		}
		if !info.Mode().IsRegular() {
			return nil
		}

		relPath, err := filepath.Rel(basePath, path)
		if err != nil {
			slog.Warn("relpath error", "path", path, "error", err)
			stats.failed++
			return nil
		}
		key := filepath.ToSlash(relPath)

		if _, err := dst.Get(ctx, key); err == nil {
			stats.skipped++
			return nil
		} else if !errors.Is(err, store.ErrNotFound) {
			slog.Warn("bucket check failed", "key", key, "error", err)
			stats.failed++
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			slog.Warn("read failed", "path", path, "error", err)
			stats.failed++
			return nil
		}
		contentType := http.DetectContentType(data)
		if err := dst.Put(ctx, key, contentType, data); err != nil {
			slog.Warn("upload failed", "key", key, "error", err)
			stats.failed++
			return nil
		}
		stats.copied++
		if stats.copied%25 == 0 {
			fmt.Printf("  uploaded %d files…\n", stats.copied)
		}
		return nil
	})
	if err != nil {
		log.Fatalf("walk %q failed: %v", basePath, err)
	}
	return stats
}
