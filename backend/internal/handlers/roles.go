package handlers

// Custom roles (migration 0051, api/permissions.go). A role is a named list
// of permissions that belongs to the workspace it was made in. Nobody can
// grant or assign more than they hold themselves.

import (
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
)

const (
	codeRoleInUse     = "role_in_use"
	codeRoleNameTaken = "role_name_taken"
	codeRoleEscalates = "role_escalates"
)

// RoleView is one role as the Roles screen shows it.
type RoleView struct {
	ID          int64    `json:"id,omitempty"` // 0 for a built-in role
	Key         string   `json:"key"`          // built-in: owner/admin/editor/viewer; custom: "custom"
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
	BuiltIn     bool     `json:"builtIn"`
	MemberCount int64    `json:"memberCount"`
}

// RolesResponse is GET /roles.
type RolesResponse struct {
	Roles []RoleView `json:"roles"`
	// Assignable is every permission a custom role may hold, in display order.
	Assignable []string `json:"assignable"`
}

// RolesRouter mounts /api/v1/roles (tenant-scoped; changes need
// roles.manage, enforced by api.WritePermissionFor).
func RolesRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listRoles(q))
	r.Post("/", createRole(q))
	r.Patch("/{id}", updateRole(q))
	r.Delete("/{id}", deleteRole(q))
	return r
}

func listRoles(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tenantID := api.TenantID(ctx)
		out := RolesResponse{Assignable: api.AssignablePermissions}
		for _, key := range []string{RoleOwner, RoleAdmin, RoleEditor, RoleViewer} {
			out.Roles = append(out.Roles, RoleView{Key: key, Name: key, Permissions: api.BuiltinPermissions(key), BuiltIn: true})
		}
		// Built-in member counts (members without a custom role).
		members, err := q.ListTenantMembersWithRoles(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		for _, m := range members {
			if m.CustomRoleID.Valid {
				continue
			}
			for i := range out.Roles {
				if out.Roles[i].Key == m.Role {
					out.Roles[i].MemberCount++
				}
			}
		}
		rows, err := q.ListRolesForTenant(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		for _, row := range rows {
			out.Roles = append(out.Roles, RoleView{
				ID: row.ID, Key: "custom", Name: row.Name, Description: row.Description,
				Permissions: row.Permissions, MemberCount: row.MemberCount,
			})
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// RoleRequest is the body of POST /roles and PATCH /roles/{id}.
type RoleRequest struct {
	Name        *string  `json:"name"`
	Description *string  `json:"description"`
	Permissions []string `json:"permissions"`
}

// cleanPermissions keeps known, assignable permissions, deduplicated, in
// display order. An unknown name is an error (a typo would silently grant
// nothing).
func cleanPermissions(in []string) ([]string, error) {
	for _, p := range in {
		if !api.IsAssignablePermission(p) {
			return nil, errors.New("unknown permission: " + p)
		}
	}
	out := []string{}
	for _, p := range api.AssignablePermissions {
		if slices.Contains(in, p) {
			out = append(out, p)
		}
	}
	return out, nil
}

func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

func createRole(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var req RoleRequest
		if err := api.DecodeBody(r, &req); err != nil || req.Name == nil {
			api.BadRequest(w, "name and permissions are required")
			return
		}
		name := strings.TrimSpace(*req.Name)
		if name == "" || len([]rune(name)) > 60 {
			api.BadRequest(w, "name must be 1–60 characters")
			return
		}
		perms, err := cleanPermissions(req.Permissions)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if !api.HasAllPermissions(ctx, perms) {
			api.ErrorCode(w, http.StatusForbidden, codeRoleEscalates, "you can't grant permissions you don't have")
			return
		}
		desc := ""
		if req.Description != nil {
			desc = strings.TrimSpace(*req.Description)
		}
		params := db.CreateRoleParams{TenantID: api.TenantID(ctx), Name: name, Description: desc, Permissions: perms,
			CreatedBy: pgtype.Int8{Int64: api.UserID(ctx), Valid: api.UserID(ctx) != 0}}
		id, err := q.CreateRole(ctx, params)
		if err != nil {
			if isUniqueViolation(err) {
				api.ErrorCode(w, http.StatusConflict, codeRoleNameTaken, "a role with that name exists")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, RoleView{ID: id, Key: "custom", Name: name, Description: desc, Permissions: perms})
	}
}

func updateRole(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		role, err := q.GetRoleForTenant(ctx, db.GetRoleForTenantParams{ID: id, TenantID: api.TenantID(ctx)})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "role not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		var req RoleRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		// fetch → merge → validate → update all fields
		name, desc, perms := role.Name, role.Description, role.Permissions
		if req.Name != nil {
			name = strings.TrimSpace(*req.Name)
		}
		if req.Description != nil {
			desc = strings.TrimSpace(*req.Description)
		}
		if req.Permissions != nil {
			if perms, err = cleanPermissions(req.Permissions); err != nil {
				api.BadRequest(w, err.Error())
				return
			}
		}
		if name == "" || len([]rune(name)) > 60 {
			api.BadRequest(w, "name must be 1–60 characters")
			return
		}
		// Neither the role as it is nor as it will be may exceed the editor.
		if !api.HasAllPermissions(ctx, perms) || !api.HasAllPermissions(ctx, role.Permissions) {
			api.ErrorCode(w, http.StatusForbidden, codeRoleEscalates, "you can't change a role with permissions you don't have")
			return
		}
		if err := q.UpdateRole(ctx, db.UpdateRoleParams{Name: name, Description: desc, Permissions: perms, ID: id}); err != nil {
			if isUniqueViolation(err) {
				api.ErrorCode(w, http.StatusConflict, codeRoleNameTaken, "a role with that name exists")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		if err := q.SetMemberBaseRoleForRole(ctx, db.SetMemberBaseRoleForRoleParams{Role: api.BaseRoleFor(perms), ID: id}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, RoleView{ID: id, Key: "custom", Name: name, Description: desc, Permissions: perms})
	}
}

func deleteRole(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		role, err := q.GetRoleForTenant(ctx, db.GetRoleForTenantParams{ID: id, TenantID: api.TenantID(ctx)})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "role not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		if !api.HasAllPermissions(ctx, role.Permissions) {
			api.ErrorCode(w, http.StatusForbidden, codeRoleEscalates, "you can't delete a role with permissions you don't have")
			return
		}
		n, err := q.CountRoleMembers(ctx, pgtype.Int8{Int64: id, Valid: true})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if n > 0 {
			api.ErrorCode(w, http.StatusConflict, codeRoleInUse, "give its members another role first")
			return
		}
		if err := q.DeleteRole(ctx, id); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
	}
}

// ---- assigning roles to members ----

// memberRoleChoice is a built-in role name or a custom role id.
type memberRoleChoice struct {
	Base        string // what user_tenants.role gets
	CustomID    pgtype.Int8
	CustomName  string
	Permissions []string
}

// resolveRoleChoice turns {role, roleId} from a request into what to store,
// refusing the owner role and anything the caller doesn't hold.
func resolveRoleChoice(w http.ResponseWriter, r *http.Request, q *db.Queries, role string, roleID int64) (memberRoleChoice, bool) {
	ctx := r.Context()
	var c memberRoleChoice
	if roleID > 0 {
		row, err := q.GetRoleForTenant(ctx, db.GetRoleForTenantParams{ID: roleID, TenantID: api.TenantID(ctx)})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.BadRequest(w, "unknown role")
				return c, false
			}
			api.InternalError(w, r, err)
			return c, false
		}
		c = memberRoleChoice{Base: api.BaseRoleFor(row.Permissions), CustomID: pgtype.Int8{Int64: row.ID, Valid: true},
			CustomName: row.Name, Permissions: row.Permissions}
	} else {
		if !isValidRole(role) {
			api.BadRequest(w, "invalid role")
			return c, false
		}
		if role == RoleOwner {
			api.BadRequest(w, "cannot assign owner role")
			return c, false
		}
		c = memberRoleChoice{Base: role, Permissions: api.BuiltinPermissions(role)}
	}
	if !api.HasAllPermissions(ctx, c.Permissions) {
		api.ErrorCode(w, http.StatusForbidden, codeRoleEscalates, "you can't give a role with permissions you don't have")
		return c, false
	}
	return c, true
}

// memberPermissions is what a member of the current workspace may do now.
func memberPermissions(r *http.Request, q *db.Queries, userID int64) (role string, perms []string, err error) {
	m, err := q.GetMemberAccess(r.Context(), db.GetMemberAccessParams{UserID: userID, TenantID: api.TenantID(r.Context())})
	if err != nil {
		return "", nil, err
	}
	if m.CustomRoleID.Valid {
		return m.Role, m.CustomPermissions, nil
	}
	return m.Role, api.BuiltinPermissions(m.Role), nil
}
