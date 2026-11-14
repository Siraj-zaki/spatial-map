package api

import (
	"context"
	"net/http"
	"slices"
	"strings"
)

// Workspace permissions. A role is a list of permissions; reading is never
// a permission (every member sees the workspace's facilities and data) — a
// permission allows a kind of change. The four built-in roles map to the
// lists below (the SPA mirrors them in src/lib/permissions.ts); a custom
// role (handlers/roles.go) is any list of AssignablePermissions.
const (
	PermFacilitiesEdit   = "facilities.edit"   // layout editor: shapes, floors, models, imports
	PermFacilitiesManage = "facilities.manage" // create / duplicate / delete facilities
	PermDataManage       = "data.manage"       // tables, rows, integrations, data links, style rules
	PermReportsCreate    = "reports.create"    // create / delete reports, who sees them
	PermReportsEdit      = "reports.edit"      // edit the reports you can see
	PermReportsViewAll   = "reports.viewAll"   // see every report, not just shared ones
	PermReportsShare     = "reports.share"     // public links to reports and facilities
	PermAlertsRespond    = "alerts.respond"    // acknowledge / resolve alerts
	PermAlertsManage     = "alerts.manage"     // alert rules
	PermSolutionsManage  = "solutions.manage"  // create / edit solutions
	PermAIMap            = "ai.map"            // AI Map on floor plans
	PermFilesManage      = "files.manage"      // the Files page: delete stored files
	PermMembersManage    = "members.manage"    // add people, change roles, remove
	PermRolesManage      = "roles.manage"      // create / edit custom roles
	PermWorkspaceManage  = "workspace.manage"  // rename the workspace

	// PermWorkspaceOwn is the owner's alone: delete the workspace.
	PermWorkspaceOwn = "workspace.own"
)

// AssignablePermissions is every permission a custom role may hold, in
// display order (everything but owning the workspace).
var AssignablePermissions = adminPermissions

// IsAssignablePermission reports whether p can be part of a custom role.
func IsAssignablePermission(p string) bool { return slices.Contains(AssignablePermissions, p) }

// BaseRoleFor is the built-in role stored next to a custom role: 'editor'
// when it allows any change, else 'viewer'.
func BaseRoleFor(perms []string) string {
	if len(perms) > 0 {
		return "editor"
	}
	return "viewer"
}

// adminPermissions is everything but owning the workspace.
var adminPermissions = []string{
	PermFacilitiesEdit, PermFacilitiesManage, PermDataManage,
	PermReportsCreate, PermReportsEdit, PermReportsViewAll, PermReportsShare,
	PermAlertsRespond, PermAlertsManage, PermSolutionsManage,
	PermAIMap, PermFilesManage,
	PermMembersManage, PermRolesManage, PermWorkspaceManage,
}

// BuiltinPermissions is what each built-in role may do.
func BuiltinPermissions(role string) []string {
	switch role {
	case "owner":
		return append(slices.Clone(adminPermissions), PermWorkspaceOwn)
	case "admin":
		return slices.Clone(adminPermissions)
	case "editor":
		return []string{
			PermFacilitiesEdit, PermFacilitiesManage, PermDataManage, PermReportsEdit, PermReportsShare,
			PermAlertsRespond, PermAlertsManage, PermSolutionsManage, PermAIMap,
		}
	}
	// viewer (and anything unknown): read-only.
	return nil
}

// ---- request context ----

// tenantRoleKey is the context key for the signed-in caller's role on the
// current tenant. Set by TenantMiddleware.
type tenantRoleKey struct{}

// tenantPermsKey / tenantRoleNameKey hold a custom role's permissions and
// name. Set by TenantMiddleware.
type tenantPermsKey struct{}
type tenantRoleNameKey struct{}

// TenantRole returns the signed-in caller's role on the current tenant
// ("owner" / "admin" / "editor" / "viewer" — a custom role's base role), or
// "" for an API-key caller.
func TenantRole(ctx context.Context) string {
	v, _ := ctx.Value(tenantRoleKey{}).(string)
	return v
}

// TenantRoleName is the custom role's name, or "" for a built-in role.
func TenantRoleName(ctx context.Context) string {
	v, _ := ctx.Value(tenantRoleNameKey{}).(string)
	return v
}

// allPermissions marks a caller with no user: machine access with the
// configured API key (RequireUserOrAPIKey refuses anyone else first).
var allPermissions = append(slices.Clone(adminPermissions), PermWorkspaceOwn)

// Permissions returns the caller's permissions on the current workspace.
func Permissions(ctx context.Context) []string {
	if v, ok := ctx.Value(tenantPermsKey{}).([]string); ok {
		return v
	}
	if role := TenantRole(ctx); role != "" {
		return BuiltinPermissions(role)
	}
	if UserID(ctx) == 0 {
		return allPermissions
	}
	return nil
}

// HasPermission reports whether the caller may do p on the current workspace.
func HasPermission(ctx context.Context, p string) bool {
	return slices.Contains(Permissions(ctx), p)
}

// HasAllPermissions reports whether the caller holds every one of ps (used
// so nobody can grant or assign more than they have themselves).
func HasAllPermissions(ctx context.Context, ps []string) bool {
	have := Permissions(ctx)
	for _, p := range ps {
		if !slices.Contains(have, p) {
			return false
		}
	}
	return true
}

// RequirePermission writes a 403 and returns false when the caller lacks p.
func RequirePermission(w http.ResponseWriter, r *http.Request, p string) bool {
	if HasPermission(r.Context(), p) {
		return true
	}
	ErrorCode(w, http.StatusForbidden, CodePermissionDenied, "your role doesn't allow this")
	return false
}

// CodePermissionDenied is the 403 code for a missing permission.
const CodePermissionDenied = "permission_denied"

// ---- the router-level write gate ----

// writeAreas maps the first path segment under /api/v1 to the permission a
// change there needs. Areas whose handlers check more (members, reports'
// finer rules) still need the area permission here.
var writeAreas = map[string]string{
	"members": PermMembersManage,
	"roles":   PermRolesManage,
	"data":    PermDataManage,
	"zones":   PermFacilitiesEdit, "grids": PermFacilitiesEdit, "bins": PermFacilitiesEdit,
	"polygons": PermFacilitiesEdit, "circles": PermFacilitiesEdit, "lines": PermFacilitiesEdit,
	"routes": PermFacilitiesEdit, "stairs": PermFacilitiesEdit, "doors": PermFacilitiesEdit,
	"markers": PermFacilitiesEdit, "images": PermFacilitiesEdit, "pdf": PermFacilitiesEdit,
	"cad": PermFacilitiesEdit, "models": PermFacilitiesEdit, "image-planes": PermFacilitiesEdit,
	"text-labels": PermFacilitiesEdit, "attribute-definitions": PermFacilitiesEdit,
	"user-models": PermFacilitiesEdit, "library": PermFacilitiesEdit, "bulk-assign": PermFacilitiesEdit,
	"floorplans":  PermAIMap,
	"style-rules": PermDataManage, "references": PermDataManage, "connections": PermDataManage,
	"data-sources": PermDataManage, "tables": PermDataManage, "data-links": PermDataManage,
	"import-jobs": PermDataManage, "correlation-rules": PermDataManage, "streams": PermDataManage,
	"entity-states": PermDataManage, "demo": PermDataManage, "audit-log": PermDataManage,
	"files":        PermFilesManage,
	"solutions":    PermSolutionsManage,
	"reports":      PermReportsEdit,
	"alerts":       PermAlertsManage,
	"alert-rules":  PermAlertsManage,
	"alert-events": PermAlertsRespond,
	"share-links":  PermReportsShare,
	"warehouses":   PermReportsShare, // only /warehouses/{id}/share-links is mounted under it
}

// WritePermissionFor is the permission a non-read request needs, by path.
// An area missing from writeAreas needs facilities.edit — "editor or above".
func WritePermissionFor(r *http.Request) string {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 {
		return PermFacilitiesEdit
	}
	area := parts[0]
	switch area {
	case "zones":
		// Creating, duplicating or deleting a facility is more than editing it.
		if (r.Method == http.MethodPost && len(parts) == 1) ||
			(r.Method == http.MethodDelete && len(parts) == 2) ||
			(len(parts) >= 3 && parts[2] == "duplicate") {
			return PermFacilitiesManage
		}
	case "reports":
		// Report share links: /reports/{id}/share-links…
		if len(parts) >= 3 && parts[2] == "share-links" {
			return PermReportsShare
		}
		// Creating a report is reports.create (also checked in the handler).
		if r.Method == http.MethodPost && len(parts) == 1 {
			return PermReportsCreate
		}
	}
	if need, ok := writeAreas[area]; ok {
		return need
	}
	return PermFacilitiesEdit
}

// readShapedCall reports whether a request only reads: GET / HEAD /
// OPTIONS, and the POSTs that run a report or query rows (the path ends in
// /run or /query, or marks the alert bell read).
func readShapedCall(r *http.Request) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	case http.MethodPost:
		p := strings.TrimSuffix(r.URL.Path, "/")
		// …and marking the alert bell read.
		return strings.HasSuffix(p, "/run") || strings.HasSuffix(p, "/query") || strings.HasSuffix(p, "/alert-events/seen")
	}
	return false
}

// WritePermissionMiddleware runs after TenantMiddleware: a signed-in
// member's change (anything but a read-shaped call) needs the permission
// WritePermissionFor gives its area. Viewers hold none, so they stay
// read-only on the API, not just in the UI. API-key callers hold every
// permission.
func WritePermissionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserID(r.Context()) != 0 && !readShapedCall(r) {
			if !RequirePermission(w, r, WritePermissionFor(r)) {
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
