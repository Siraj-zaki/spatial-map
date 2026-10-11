package handlers

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/jackc/pgx/v5/pgtype"
)

// recordTenantFile marks a freshly stored object as uploaded by the
// request's tenant (tenant_files, migration 0043), so the Files screen
// lists it in that workspace — and only there — before, or without, any
// shape pointing at it. Call it right after every successful upload Put.
//
// Best-effort: the bytes are already stored, so a failure is logged, not
// returned; the file just stays invisible until something references it.
// No-op without a tenant (or without a DB, as in the PDF/CAD unit tests).
//
// An optional multipart `zoneId` field records the facility it was
// uploaded in (migration 0044) so the editor's upload library can offer
// "This facility" first; a zone the tenant doesn't own is stored as NULL.
func recordTenantFile(r *http.Request, q *db.Queries, key, contentType string, size int) {
	tenantID := api.TenantID(r.Context())
	if q == nil || tenantID == 0 {
		return
	}
	params := db.RecordTenantFileParams{
		TenantID:    tenantID,
		ObjectKey:   key,
		SizeBytes:   pgtype.Int8{Int64: int64(size), Valid: true},
		ContentType: pgtype.Text{String: contentType, Valid: contentType != ""},
	}
	if uid := api.UserID(r.Context()); uid != 0 {
		params.UploadedBy = pgtype.Int8{Int64: uid, Valid: true}
	}
	if zoneID, err := strconv.ParseInt(r.FormValue("zoneId"), 10, 64); err == nil && zoneID > 0 {
		params.ZoneID = pgtype.Int8{Int64: zoneID, Valid: true}
	}
	if err := q.RecordTenantFile(r.Context(), params); err != nil {
		slog.WarnContext(r.Context(), "record tenant file failed", "key", key, "tenant", tenantID, "error", err)
	}
}

// cleanupObjectURL removes the file backing `url` from the object store —
// but only after confirming no DB row still references it and no
// workspace still owns it (tenant_files).
//
// The refcount check is required because keys are content-addressed
// (`{name}-{sha256[:12]}.{ext}` via store.KeyFromData) with no nonce, so
// two users uploading identical bytes get identical keys. That means
// two `images` rows can legally point at the same file; naïvely
// deleting the file when the first row is removed would leave the
// second with a broken URL.
//
// Rules of the road for callers:
//   - Pass URLs in the same relative form the DB stores them
//     (`/files/<key>`). The helper strips the prefix itself.
//   - Call this AFTER the DB write that removed the reference has
//     committed. Otherwise the row still counts and the file is kept.
//   - Errors are returned but callers should generally log-and-continue:
//     the DB is already consistent, and an orphan file is safe for the
//     cleanup-orphans sweeper to reclaim later.
//
// Race note: between the refcount check and the physical Delete a new
// upload of the same bytes could bump refcount from 0 to 1. That would
// leave a fresh row with a dangling URL. The cleanup-orphans sweeper is
// the safety net for this — see cmd/cleanup-orphans/main.go. For the
// primary write paths (single-shape delete, warehouse delete) the race
// requires simultaneous same-byte upload during the delete handler,
// which is not a realistic pattern.
func cleanupObjectURL(ctx context.Context, q *db.Queries, s store.ObjectStore, url string) error {
	key := store.KeyFromURL(url)
	if key == "" {
		return nil
	}
	refcount, err := q.CountFileURLReferences(ctx, url)
	if err != nil {
		return err
	}
	if refcount > 0 {
		return nil
	}
	// A workspace that uploaded the file keeps it in its upload library
	// after the last shape using it is deleted — that's what lets the
	// editor reuse a floor plan / image plane / model. Physical deletion
	// happens from the Files screen (which drops the ownership row first)
	// or the catalog delete for models.
	owners, err := q.CountTenantFileOwners(ctx, key)
	if err != nil {
		return err
	}
	if owners > 0 {
		return nil
	}
	return s.Delete(ctx, key)
}

// cleanupObjectURLs is the fan-out variant for zone-delete and other
// batch flows. Each failure is logged and swallowed — a single storage
// hiccup shouldn't abort the batch, and the sweeper reclaims stragglers.
func cleanupObjectURLs(ctx context.Context, q *db.Queries, s store.ObjectStore, urls []string) {
	for _, url := range urls {
		if err := cleanupObjectURL(ctx, q, s, url); err != nil {
			slog.WarnContext(ctx, "file cleanup failed", "url", url, "error", err)
		}
	}
}
