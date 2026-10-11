package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrNotFound is returned by ObjectStore.Get when the key doesn't exist.
// FallbackStore keys read-fallthrough on it — every implementation should
// translate its backend-specific "no such key" error into this value so
// callers can distinguish "missing" from "transport failure".
var ErrNotFound = errors.New("object not found")

// NormalizeAssetURL strips any host prefix from a stored asset URL so
// the DB only ever contains the relative `/files/<key>` path, never
// `http://localhost:8080/files/…` or a similar absolute form.
//
// Historic bug: when the storage BASE_URL was accidentally configured
// as a fully-qualified `http://host:port/files`, uploads landed in the
// DB with that host baked in — breaking rendering the moment another
// LAN machine, a different port, or a production hostname served the
// SPA. The frontend already has a read-time rewrite
// (`rewriteFilesUrlSameOrigin` in `binary-store.ts`), but this is the
// write-time guard so future rows never carry a host at all.
//
// Rules:
//   - data:/blob:/protocol-relative URLs are passed through unchanged.
//   - Relative URLs are passed through unchanged.
//   - Absolute HTTP(S) URLs that contain a `/files/` segment are
//     trimmed to just that segment (`/files/…`).
//   - Absolute HTTP(S) URLs that do NOT contain `/files/` (e.g. a
//     user-supplied external image) are returned unchanged — we
//     don't want to accidentally mangle a legitimate external asset.
func NormalizeAssetURL(url string) string {
	if url == "" {
		return url
	}
	if strings.HasPrefix(url, "data:") ||
		strings.HasPrefix(url, "blob:") ||
		strings.HasPrefix(url, "//") {
		return url
	}
	if !strings.HasPrefix(strings.ToLower(url), "http://") &&
		!strings.HasPrefix(strings.ToLower(url), "https://") {
		return url
	}
	idx := strings.Index(url, "/files/")
	if idx == -1 {
		return url
	}
	return url[idx:]
}

// ObjectInfo describes a stored object without loading its bytes.
// Populated by ObjectStore.ListObjects for the Files admin screen and
// cleanup-orphans sweeper.
type ObjectInfo struct {
	Key        string
	Size       int64
	UploadedAt time.Time
}

// ObjectStore abstracts file/object storage for binary uploads (images, 3D models).
type ObjectStore interface {
	// Put writes an object and returns a stable key.
	Put(ctx context.Context, key string, contentType string, data []byte) error
	// Get reads an object by key. Implementations MUST return ErrNotFound
	// when the key is missing so wrapping stores can fall through.
	Get(ctx context.Context, key string) (Object, error)
	// URL returns the public or presigned URL for an object.
	URL(key string) string
	// Delete removes an object by key. Missing keys are NOT an error —
	// implementations translate their backend's not-found into a nil
	// return so callers can safely delete idempotently (e.g. after a
	// crash between DB commit and file delete).
	Delete(ctx context.Context, key string) error
	// ListObjects enumerates every object held by the store with
	// lightweight metadata (size, upload time) but WITHOUT loading the
	// bytes. Used by cmd/cleanup-orphans (for orphan detection) and the
	// Files admin screen (for the gallery view). Order is
	// implementation-defined; callers should not depend on it.
	ListObjects(ctx context.Context) ([]ObjectInfo, error)
}

// KeyFromURL extracts the storage key from a stored file URL. Because every
// URL persisted in the DB is a relative `/files/<key>` (see
// NormalizeAssetURL), the key is everything after the last `/files/` segment.
// Returns an empty string when the URL is empty, external, or doesn't point
// at our proxy — callers should treat that as "no file to reclaim".
func KeyFromURL(url string) string {
	if url == "" {
		return ""
	}
	idx := strings.Index(url, "/files/")
	if idx == -1 {
		return ""
	}
	key := url[idx+len("/files/"):]
	// Guard against a bare "/files/" or embedded query strings.
	if q := strings.IndexByte(key, '?'); q >= 0 {
		key = key[:q]
	}
	return key
}

// Object is the result of a Get call.
type Object struct {
	ContentType string
	Data        []byte
}

// Config bundles the parameters store.New needs. Existing call sites can
// keep using the four positional args via NewLegacy; new code (main.go,
// migrate-storage) uses Config so MinIO fields don't blow up the
// signature.
type Config struct {
	Type     string
	BasePath string
	BaseURL  string
	MinIO    MinIOConfig
}

// New builds an ObjectStore from configuration.
//
// Supported types:
//   - "local", "": filesystem-backed store at BasePath.
//   - "minio": MinIO / S3-compatible object store. Writes go to the
//     bucket; reads come from the bucket. Existing files on disk are
//     invisible — run cmd/migrate-storage first (or use "minio-fallback"
//     during the cutover).
//   - "minio-fallback": MinIO primary + local disk read fallback. All
//     writes go to MinIO. Reads try MinIO first; on ErrNotFound they
//     fall through to the local disk at BasePath. This is the safe
//     cutover mode — flip to it before the migration script has run
//     and every legacy file keeps serving until the bulk copy catches
//     up. Non-destructive: local files are never deleted.
func New(cfg Config) (ObjectStore, error) {
	switch cfg.Type {
	case "local", "":
		return NewLocalStore(cfg.BasePath, cfg.BaseURL)
	case "minio":
		return NewMinIOStore(cfg.MinIO, cfg.BaseURL)
	case "minio-fallback":
		primary, err := NewMinIOStore(cfg.MinIO, cfg.BaseURL)
		if err != nil {
			return nil, fmt.Errorf("minio-fallback: primary: %w", err)
		}
		secondary, err := NewLocalStore(cfg.BasePath, cfg.BaseURL)
		if err != nil {
			return nil, fmt.Errorf("minio-fallback: secondary: %w", err)
		}
		return NewFallbackStore(primary, secondary), nil
	default:
		return nil, fmt.Errorf("unsupported storage type: %q", cfg.Type)
	}
}
