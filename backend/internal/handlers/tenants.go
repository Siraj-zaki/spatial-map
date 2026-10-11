package handlers

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// TenantRequest is the body for POST / PATCH tenants. `color` is required by
// the DB schema; if the client sends "" we substitute a sensible default so
// the create flow doesn't 400 on an empty picker state.
type TenantRequest struct {
	Name  string `json:"name" validate:"required"`
	Color string `json:"color"`
}

// TenantResponse is kept as a compat alias for pre-workspace test code and
// any external caller that decoded the old handler's response. The old shape
// carried `id`, `name`, `color`, `createdAt`; AuthTenant keeps the first
// three field names (plus role and the neutral legacy plan fields), which is
// all the tests actually read.
type TenantResponse = AuthTenant

// TenantsRouter exposes workspace CRUD to the SPA. Mounted OUTSIDE
// TenantMiddleware (see cmd/api/main.go) because creating / listing
// workspaces cannot itself require an active tenant header — the user
// may be picking their first one, or deleting the current one. Auth is
// still enforced: every handler here demands a JWT userID.
func TenantsRouter(q *db.Queries, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listTenants(q))
	r.Post("/", createTenant(q))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", getTenant(q))
		r.Patch("/", updateTenant(q))
		r.Delete("/", deleteTenant(q, s))
		r.Post("/leave", leaveTenant(q))
	})
	return r
}

// ---- Helpers ---------------------------------------------------------------

// requireMembershipOn resolves the caller's role on `tenantID`, returning
// (role, ok). If ok is false the response has already been written (401 or
// 403). Analogous to `requireRole` in auth.go but reads the tenant id from
// the URL param instead of TenantMiddleware — since this router is mounted
// outside that middleware.
func requireMembershipOn(w http.ResponseWriter, r *http.Request, q *db.Queries, tenantID int64) (string, bool) {
	userID := api.UserID(r.Context())
	if userID == 0 {
		api.Error(w, http.StatusUnauthorized, "not authenticated")
		return "", false
	}
	m, err := q.GetUserTenantMembership(r.Context(), db.GetUserTenantMembershipParams{
		UserID:   userID,
		TenantID: tenantID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			api.Error(w, http.StatusForbidden, "not a member of this workspace")
			return "", false
		}
		api.InternalError(w, r, err)
		return "", false
	}
	return m.Role, true
}

// requireRoleOn is the role-restricted variant of requireMembershipOn.
func requireRoleOn(w http.ResponseWriter, r *http.Request, q *db.Queries, tenantID int64, allowed ...string) bool {
	role, ok := requireMembershipOn(w, r, q, tenantID)
	if !ok {
		return false
	}
	for _, a := range allowed {
		if role == a {
			return true
		}
	}
	api.Error(w, http.StatusForbidden, "insufficient permissions")
	return false
}

// ---- Handlers --------------------------------------------------------------

// listTenants returns the caller's own workspaces. Anonymous / API-key-only
// requests fall back to the legacy behaviour of returning every tenant in
// the DB — required by the pre-JWT integration tests and by dev tools that
// use the API key. Once JWT rollout is complete this fallback should be
// removed.
func listTenants(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := api.UserID(r.Context())
		if userID == 0 {
			// Legacy path — return every tenant. Kept for API-key callers.
			items, err := q.ListTenants(r.Context())
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			resp := make([]AuthTenant, len(items))
			for i, t := range items {
				// API-key callers have no membership, so role stays empty.
				resp[i] = newAuthTenant(t.ID, t.Name, t.Color, "")
			}
			api.JSON(w, http.StatusOK, resp)
			return
		}
		rows, err := q.ListUserTenants(r.Context(), userID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, toAuthTenants(rows))
	}
}

// createTenant creates a new workspace. The caller is added as the owner.
// Any signed-in user can create one — self-hosted Spatial Map has no plan
// gating or workspace limits. When the caller is API-key-only (no JWT), the
// tenant is created without an owner link, matching the legacy dev-tools
// behaviour.
func createTenant(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req TenantRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		name := strings.TrimSpace(req.Name)
		if name == "" {
			api.BadRequest(w, "name is required")
			return
		}
		color := strings.TrimSpace(req.Color)
		if color == "" {
			color = "#3b82f6"
		}

		userID := api.UserID(r.Context())

		// JWT callers are stamped as owner of the new workspace. API-key
		// callers get a bare tenant with no owner link (seed scripts).
		if userID != 0 {
			row, err := q.CreateTenant(r.Context(), db.CreateTenantParams{
				Name:  name,
				Color: color,
			})
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			if _, err := q.AddUserTenant(r.Context(), db.AddUserTenantParams{
				UserID:   userID,
				TenantID: row.ID,
				Role:     RoleOwner,
			}); err != nil {
				// Roll back the tenant so we don't leak an ownerless workspace.
				_ = q.DeleteTenant(r.Context(), row.ID)
				api.InternalError(w, r, err)
				return
			}
			api.JSON(w, http.StatusCreated, newAuthTenant(row.ID, row.Name, row.Color, RoleOwner))
			return
		}

		t, err := q.CreateTenant(r.Context(), db.CreateTenantParams{Name: name, Color: color})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, newAuthTenant(t.ID, t.Name, t.Color, ""))
	}
}

// getTenant returns a single workspace. JWT callers must
// be a member; API-key callers get the legacy behaviour.
func getTenant(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		userID := api.UserID(r.Context())
		if userID != 0 {
			role, ok := requireMembershipOn(w, r, q, id)
			if !ok {
				return
			}
			row, err := q.GetTenant(r.Context(), id)
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					api.NotFound(w, "workspace not found")
					return
				}
				api.InternalError(w, r, err)
				return
			}
			api.JSON(w, http.StatusOK, newAuthTenant(row.ID, row.Name, row.Color, role))
			return
		}
		t, err := q.GetTenant(r.Context(), id)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "workspace not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, newAuthTenant(t.ID, t.Name, t.Color, ""))
	}
}

// updateTenant renames + recolors a workspace. Owner or admin only when
// the caller is JWT-authenticated. API-key callers keep the ungated legacy
// behaviour used by seed / migration tools.
func updateTenant(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		var req TenantRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		userID := api.UserID(r.Context())
		var role string
		if userID != 0 {
			var ok bool
			if !requireRoleOn(w, r, q, id, RoleOwner, RoleAdmin) {
				return
			}
			// Re-fetch the caller's role so we can build the response with
			// an accurate role. The requireRoleOn check above already
			// verified it's owner or admin.
			role, ok = requireMembershipOn(w, r, q, id)
			if !ok {
				return
			}
		}
		color := strings.TrimSpace(req.Color)
		if color == "" {
			color = "#3b82f6"
		}
		if err := q.UpdateTenant(r.Context(), db.UpdateTenantParams{
			ID:    id,
			Name:  strings.TrimSpace(req.Name),
			Color: color,
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "workspace not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		if userID != 0 {
			row, err := q.GetTenant(r.Context(), id)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			api.JSON(w, http.StatusOK, newAuthTenant(row.ID, row.Name, row.Color, role))
			return
		}
		t, err := q.GetTenant(r.Context(), id)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, newAuthTenant(t.ID, t.Name, t.Color, ""))
	}
}

// deleteTenant hard-removes a workspace. Owner only. Refuses if this is
// the caller's ONLY workspace — the SPA always needs one to render, and
// re-creating one at signup is more graceful than being stuck in a
// no-workspace state. Object-store files owned by images / image_planes /
// user_models across every zone in the workspace are reclaimed post-commit.
//
// Order matches deleteZone:
//  1. Collect file URLs BEFORE the DELETE (CASCADE would erase the rows).
//  2. Run the DELETE. Postgres cascades every tenant_id child.
//  3. AFTER commit, reclaim each file (refcount-checked in cleanupObjectURL).
func deleteTenant(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		userID := api.UserID(r.Context())
		if userID != 0 {
			if !requireRoleOn(w, r, q, id, RoleOwner) {
				return
			}
			// Refuse if this is the caller's ONLY workspace. Losing the
			// last workspace would leave the SPA with no tenant scope to
			// render and no obvious way to recover without going through
			// the signup flow again.
			memberships, err := q.ListUserTenants(r.Context(), userID)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			if len(memberships) <= 1 {
				api.Error(w, http.StatusConflict, "cannot delete your only workspace")
				return
			}
		}

		imageURLs, err := q.ListImageURLsByTenant(r.Context(), id)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		planeURLs, err := q.ListImagePlaneURLsByTenant(r.Context(), id)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		modelURLs, err := q.ListUserModelURLsByTenant(r.Context(), id)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		if err := q.DeleteTenant(r.Context(), id); err != nil {
			api.InternalError(w, r, err)
			return
		}

		all := append(imageURLs, planeURLs...)
		all = append(all, modelURLs...)
		cleanupObjectURLs(r.Context(), q, s, all)

		api.JSON(w, http.StatusNoContent, nil)
	}
}

// leaveTenant removes the caller from a workspace without deleting the
// workspace itself. Guards:
//   - must be a member
//   - must have at least one other workspace to fall back to
//   - if the caller is the sole owner, refuse (the workspace would end up
//     with no owner and nobody could manage billing / delete)
func leaveTenant(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		userID := api.UserID(r.Context())
		if userID == 0 {
			api.Error(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		role, ok := requireMembershipOn(w, r, q, id)
		if !ok {
			return
		}
		memberships, err := q.ListUserTenants(r.Context(), userID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if len(memberships) <= 1 {
			api.Error(w, http.StatusConflict, "cannot leave your only workspace")
			return
		}
		if role == RoleOwner {
			owners, err := q.CountTenantOwners(r.Context(), id)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			if owners <= 1 {
				api.Error(w, http.StatusConflict, "cannot leave: you are the sole owner — transfer ownership first")
				return
			}
		}
		if err := q.RemoveUserTenant(r.Context(), db.RemoveUserTenantParams{
			UserID:   userID,
			TenantID: id,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
	}
}

// _ prevents unused import lint for pgtype if needed later.
var _ = pgtype.Text{}
var _ = time.Now
