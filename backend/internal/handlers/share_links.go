package handlers

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// ---------------------------------------------------------------------------
// Share links — schemaful CRUD + public consumption
//
// The editor mounts three groups:
//
//   * GET  /api/v1/warehouses/{id}/share-links      → list per warehouse
//   * POST /api/v1/warehouses/{id}/share-links      → issue a new link
//   * PATCH /api/v1/share-links/{id}                → edit label/settings/expiry
//   * POST  /api/v1/share-links/{id}/revoke         → soft-delete
//   * DELETE /api/v1/share-links/{id}               → hard-delete (owner-only)
//
// And the public consumption path (no auth, no tenant, no api key):
//
//   * GET  /api/v1/share/{token}                    → { link, warehouse }
//
// The public endpoint enforces expiry + max_views + revocation ENTIRELY
// server-side; the SPA is never trusted with those checks. Any failure
// returns 404 so the exact reason a link doesn't work is not leaked.
// ---------------------------------------------------------------------------

// ShareLinkRequest is the JSON body accepted by POST and PATCH.
//
//   - `settings` is intentionally schemaless (json.RawMessage). The SPA
//     controls what lives inside — map style, palette, floor plan, layer
//     visibility, data-link filters, chrome flags. The backend never
//     parses it; it just persists + returns.
//
//   - `expiresAt` accepts RFC3339. NULL / omitted = never expires.
//     `expirySeconds` is an ergonomic alternative: the client sends the
//     TTL in seconds ("7 days = 604800") and the server computes the
//     absolute timestamp. Both accepted; if both present, `expiresAt`
//     wins so a user-typed absolute date always beats a preset TTL.
//
// * `maxViews` NULL / omitted = unlimited.
type ShareLinkRequest struct {
	Label         string          `json:"label"`
	Settings      json.RawMessage `json:"settings"`
	ExpiresAt     *string         `json:"expiresAt"`
	ExpirySeconds *int64          `json:"expirySeconds"`
	MaxViews      *int64          `json:"maxViews"`
}

// ShareLinkResponse is the row envelope returned to the editor. Fields
// use camelCase to match the rest of the JSON API.
type ShareLinkResponse struct {
	ID       int64 `json:"id"`
	TenantID int64 `json:"tenantId"`
	// ZoneID is the facility; a report link carries ReportID (and its
	// report's facility, or none for a workspace-wide report).
	ZoneID         int64           `json:"zoneId,omitempty"`
	ReportID       int64           `json:"reportId,omitempty"`
	Token          string          `json:"token"`
	Label          string          `json:"label"`
	Settings       json.RawMessage `json:"settings"`
	ExpiresAt      string          `json:"expiresAt,omitempty"`
	MaxViews       *int64          `json:"maxViews,omitempty"`
	ViewCount      int64           `json:"viewCount"`
	LastAccessedAt string          `json:"lastAccessedAt,omitempty"`
	CreatedBy      *int64          `json:"createdBy,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
	RevokedAt      string          `json:"revokedAt,omitempty"`
	RevokedBy      *int64          `json:"revokedBy,omitempty"`
	// Status is a computed convenience the SPA renders as a badge.
	// One of: "active" | "expired" | "capped" | "revoked".
	Status string `json:"status"`
}

// PublicShareResponse is the payload returned by GET /api/v1/share/{token}.
// It bundles the link's presentation settings with the full WarehouseView
// so the SPA can hydrate the viewer in a single round-trip.
type PublicShareResponse struct {
	Link      PublicShareLink `json:"link"`
	Warehouse WarehouseView   `json:"warehouse"`
}

// PublicShareLink is the redacted subset of a share_links row that's safe
// to expose to unauthenticated visitors. It intentionally omits tenant_id,
// created_by, revoked_by, and the raw expires_at DB timestamp — those are
// audit fields.
type PublicShareLink struct {
	Label     string          `json:"label"`
	Settings  json.RawMessage `json:"settings"`
	ExpiresAt string          `json:"expiresAt,omitempty"`
	MaxViews  *int64          `json:"maxViews,omitempty"`
	ViewCount int64           `json:"viewCount"`
	IssuedAt  string          `json:"issuedAt"`
}

// generateToken returns a 32-byte cryptographically-random token, URL-safe
// base64 encoded (43 chars, no padding). Uses crypto/rand — never math/rand.
// Collisions across 2^256 space are astronomically unlikely so we do not
// retry on unique-constraint violation.
func generateShareToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// buildShareLinkResponse converts a share_links row into the JSON envelope
// the editor consumes. Handles nullable columns and the computed status.
func buildShareLinkResponse(row db.ShareLink) ShareLinkResponse {
	resp := ShareLinkResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		ZoneID:    row.ZoneID.Int64,
		ReportID:  row.ReportID.Int64,
		Token:     row.Token,
		Label:     row.Label,
		Settings:  defaultJSONObject(row.Settings),
		ViewCount: row.ViewCount,
		CreatedAt: api.FormatTime(row.CreatedAt),
		UpdatedAt: api.FormatTime(row.UpdatedAt),
	}
	if row.ExpiresAt.Valid {
		resp.ExpiresAt = row.ExpiresAt.Time.Format(time.RFC3339)
	}
	if row.MaxViews.Valid {
		v := row.MaxViews.Int64
		resp.MaxViews = &v
	}
	if row.LastAccessedAt.Valid {
		resp.LastAccessedAt = row.LastAccessedAt.Time.Format(time.RFC3339)
	}
	if row.CreatedBy.Valid {
		v := row.CreatedBy.Int64
		resp.CreatedBy = &v
	}
	if row.RevokedAt.Valid {
		resp.RevokedAt = row.RevokedAt.Time.Format(time.RFC3339)
	}
	if row.RevokedBy.Valid {
		v := row.RevokedBy.Int64
		resp.RevokedBy = &v
	}
	resp.Status = computeShareLinkStatus(row)
	return resp
}

// computeShareLinkStatus is what the UI renders as a badge — the ordering
// matters (revoked wins over expired wins over capped) so an admin can
// tell the difference between "I killed this" and "it aged out".
func computeShareLinkStatus(row db.ShareLink) string {
	if row.RevokedAt.Valid {
		return "revoked"
	}
	if row.ExpiresAt.Valid && !row.ExpiresAt.Time.After(time.Now()) {
		return "expired"
	}
	if row.MaxViews.Valid && row.ViewCount >= row.MaxViews.Int64 {
		return "capped"
	}
	return "active"
}

// parseExpiry resolves the two accepted forms (absolute RFC3339 or
// seconds-from-now) into a pgtype.Timestamptz. Explicit null clears
// the expiry; a missing field also clears (both mean "unlimited").
// Called by create + update, so it must be robust to bad input.
func parseExpiry(expiresAt *string, expirySeconds *int64) (pgtype.Timestamptz, error) {
	if expiresAt != nil {
		s := strings.TrimSpace(*expiresAt)
		if s == "" {
			return pgtype.Timestamptz{}, nil
		}
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return pgtype.Timestamptz{}, errors.New("expiresAt must be RFC3339")
		}
		return pgtype.Timestamptz{Time: t, Valid: true}, nil
	}
	if expirySeconds != nil {
		if *expirySeconds <= 0 {
			// A non-positive TTL is the client's way of asking for "no expiry".
			// Reject 0 explicitly rather than silently treating it as "never"
			// because 0 is more often a bug than a deliberate choice.
			return pgtype.Timestamptz{}, nil
		}
		return pgtype.Timestamptz{Time: time.Now().Add(time.Duration(*expirySeconds) * time.Second), Valid: true}, nil
	}
	return pgtype.Timestamptz{}, nil
}

// ListShareLinksHandler mounts on /api/v1/warehouses/{id}/share-links.
// Editor + admin only — viewers cannot see who else has been given
// share links. The route is nested under warehouses/{id} so the caller
// never has to send zoneID in the body; we always trust the URL param.
func ListShareLinksHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermReportsShare) {
			return
		}
		tenantID := api.TenantID(r.Context())
		zoneID, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		// Verify zone belongs to tenant before listing links. Prevents a
		// cross-tenant admin from probing "does zone 42 exist?" via the
		// share-links list endpoint.
		if _, err := q.GetZone(r.Context(), db.GetZoneParams{ID: zoneID, TenantID: tenantID}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "warehouse not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		rows, err := q.ListShareLinksByZone(r.Context(), db.ListShareLinksByZoneParams{
			TenantID: tenantID,
			ZoneID:   pgtype.Int8{Int64: zoneID, Valid: true},
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]ShareLinkResponse, 0, len(rows))
		for _, row := range rows {
			out = append(out, buildShareLinkResponse(row))
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// CreateShareLinkHandler mounts on POST /api/v1/warehouses/{id}/share-links.
// The token is minted server-side — the client can never pick its own token.
func CreateShareLinkHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermReportsShare) {
			return
		}
		tenantID := api.TenantID(r.Context())
		userID := api.UserID(r.Context())
		zoneID, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if _, err := q.GetZone(r.Context(), db.GetZoneParams{ID: zoneID, TenantID: tenantID}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "warehouse not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}

		var req ShareLinkRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		expiry, err := parseExpiry(req.ExpiresAt, req.ExpirySeconds)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		token, err := generateShareToken()
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		var maxViews pgtype.Int8
		if req.MaxViews != nil && *req.MaxViews > 0 {
			maxViews = pgtype.Int8{Int64: *req.MaxViews, Valid: true}
		}
		var createdBy pgtype.Int8
		if userID != 0 {
			createdBy = pgtype.Int8{Int64: userID, Valid: true}
		}
		row, err := q.CreateShareLink(r.Context(), db.CreateShareLinkParams{
			TenantID:  tenantID,
			ZoneID:    pgtype.Int8{Int64: zoneID, Valid: true},
			Token:     token,
			Label:     strings.TrimSpace(req.Label),
			Settings:  defaultJSONObject(req.Settings),
			ExpiresAt: expiry,
			MaxViews:  maxViews,
			CreatedBy: createdBy,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, buildShareLinkResponse(row))
	}
}

// UpdateShareLinkHandler mounts on PATCH /api/v1/share-links/{id}.
// Accepts the same body as create; the token/zone/tenant/audit fields
// stay immutable. A revoked link can still be edited (label + settings),
// but the update does NOT un-revoke it — use a fresh create for that.
func UpdateShareLinkHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermReportsShare) {
			return
		}
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		var req ShareLinkRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		expiry, err := parseExpiry(req.ExpiresAt, req.ExpirySeconds)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		var maxViews pgtype.Int8
		if req.MaxViews != nil && *req.MaxViews > 0 {
			maxViews = pgtype.Int8{Int64: *req.MaxViews, Valid: true}
		}
		row, err := q.UpdateShareLink(r.Context(), db.UpdateShareLinkParams{
			ID:        id,
			TenantID:  tenantID,
			Label:     strings.TrimSpace(req.Label),
			Settings:  defaultJSONObject(req.Settings),
			ExpiresAt: expiry,
			MaxViews:  maxViews,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "share link not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, buildShareLinkResponse(row))
	}
}

// RevokeShareLinkHandler mounts on POST /api/v1/share-links/{id}/revoke.
// Idempotent — if the link is already revoked the DB returns no rows and
// the handler responds 404 rather than resurrecting the row.
func RevokeShareLinkHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermReportsShare) {
			return
		}
		tenantID := api.TenantID(r.Context())
		userID := api.UserID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		var revokedBy pgtype.Int8
		if userID != 0 {
			revokedBy = pgtype.Int8{Int64: userID, Valid: true}
		}
		row, err := q.RevokeShareLink(r.Context(), db.RevokeShareLinkParams{
			ID:        id,
			TenantID:  tenantID,
			RevokedBy: revokedBy,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "share link not found or already revoked")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, buildShareLinkResponse(row))
	}
}

// DeleteShareLinkHandler mounts on DELETE /api/v1/share-links/{id}.
// Hard-delete — the row is gone and the audit trail is lost. Restricted
// to owners to keep this from being a foot-gun.
func DeleteShareLinkHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermWorkspaceManage) {
			return
		}
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := q.DeleteShareLink(r.Context(), db.DeleteShareLinkParams{
			ID:       id,
			TenantID: tenantID,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// PublicShareHandler mounts on GET /api/v1/share/{token}. Unauthenticated,
// unaware of any tenant header. Enforces every share-link gate (revoke,
// expiry, max_views) in the SQL WHERE clause. Bumps view_count on success.
// Always returns 404 for any failure — never leaks WHY the link doesn't
// work, so a probe can't distinguish "expired" from "wrong token".
func PublicShareHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := chi.URLParam(r, "token")
		if token == "" {
			api.NotFound(w, "share link not found")
			return
		}
		link, err := q.GetShareLinkByToken(r.Context(), token)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "share link not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		zoneRow, err := q.GetZoneByID(r.Context(), link.ZoneID.Int64)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "share link not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		// zones.is_public is still respected — turning the whole warehouse
		// private kills every share link at once. Individual per-link
		// revocation is handled by the SQL clause above.
		if !zoneRow.IsPublic {
			api.NotFound(w, "share link not found")
			return
		}

		// Bump the view counter first so a client that crashes on parse
		// still counted against max_views. Failure here is non-fatal —
		// telemetry only.
		if err := q.IncrementShareLinkView(r.Context(), link.ID); err != nil {
			// Log-only; do not fail the request.
			_ = err
		}

		// Build the WarehouseView using the same builder the /public/
		// path uses. We reuse buildWarehouseView so /share/{token}
		// stays byte-compatible with /public/warehouses/by-token/{token}.
		//
		// Because buildWarehouseView already writes the whole HTTP
		// response, we need to intercept it and package it inside our
		// PublicShareResponse envelope. We do that by first fetching
		// the WarehouseView payload inline via a helper.
		view, ok := buildWarehouseViewPayload(q, r, db.CreateZoneRow(zoneRow), zoneRow.IsPublic)
		if !ok {
			api.NotFound(w, "share link not found")
			return
		}

		api.JSON(w, http.StatusOK, PublicShareResponse{
			// Reflect the increment we just did.
			Link:      toPublicShareLink(link, link.ViewCount+1),
			Warehouse: view,
		})
	}
}

// tenantScopedShareLinksRouter is what main.go mounts under /api/v1
// (inside the tenant middleware group). It handles the /warehouses/{id}/share-links
// nested list+create pair.
func TenantWarehouseShareLinksRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", ListShareLinksHandler(q))
	r.Post("/", CreateShareLinkHandler(q))
	return r
}

// ShareLinksRouter mounts on /api/v1/share-links for the update/revoke/delete
// operations that already know their link id.
func ShareLinksRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Route("/{id}", func(r chi.Router) {
		r.Patch("/", UpdateShareLinkHandler(q))
		r.Post("/revoke", RevokeShareLinkHandler(q))
		r.Delete("/", DeleteShareLinkHandler(q))
	})
	return r
}
