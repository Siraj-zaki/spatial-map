package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

// TestBuiltinPermissions pins what the four built-in roles may do. A change
// here changes every member's access — the SPA mirrors the lists in
// src/lib/permissions.ts.
func TestBuiltinPermissions(t *testing.T) {
	if got := BuiltinPermissions("viewer"); len(got) != 0 {
		t.Errorf("viewer = %v, want none (read-only)", got)
	}
	editor := BuiltinPermissions("editor")
	for _, p := range []string{PermFacilitiesEdit, PermDataManage, PermReportsShare, PermSolutionsManage, PermAlertsManage} {
		if !slices.Contains(editor, p) {
			t.Errorf("editor lacks %s", p)
		}
	}
	for _, p := range []string{PermReportsCreate, PermFilesManage, PermMembersManage, PermRolesManage, PermWorkspaceManage, PermWorkspaceOwn} {
		if slices.Contains(editor, p) {
			t.Errorf("editor has %s", p)
		}
	}
	if slices.Contains(BuiltinPermissions("admin"), PermWorkspaceOwn) {
		t.Error("admin must not own the workspace")
	}
	if !slices.Contains(BuiltinPermissions("owner"), PermWorkspaceOwn) {
		t.Error("owner must own the workspace")
	}
}

func TestWritePermissionFor(t *testing.T) {
	cases := []struct{ method, path, want string }{
		{"POST", "/api/v1/polygons", PermFacilitiesEdit},
		{"POST", "/api/v1/zones", PermFacilitiesManage},
		{"DELETE", "/api/v1/zones/4", PermFacilitiesManage},
		{"POST", "/api/v1/zones/4/duplicate", PermFacilitiesManage},
		{"PATCH", "/api/v1/zones/4", PermFacilitiesEdit},
		{"POST", "/api/v1/tables", PermDataManage},
		{"POST", "/api/v1/reports", PermReportsCreate},
		{"PATCH", "/api/v1/reports/3", PermReportsEdit},
		{"POST", "/api/v1/reports/3/share-links", PermReportsShare},
		{"POST", "/api/v1/alert-rules", PermAlertsManage},
		{"POST", "/api/v1/alert-events/9/ack", PermAlertsRespond},
		{"POST", "/api/v1/roles", PermRolesManage},
		{"POST", "/api/v1/members", PermMembersManage},
		{"POST", "/api/v1/somewhere-new", PermFacilitiesEdit},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, c.path, nil)
		if got := WritePermissionFor(r); got != c.want {
			t.Errorf("%s %s = %q, want %q", c.method, c.path, got, c.want)
		}
	}
}

func TestBaseRoleFor(t *testing.T) {
	if BaseRoleFor(nil) != "viewer" {
		t.Error("no permissions → viewer")
	}
	if BaseRoleFor([]string{PermAlertsRespond}) != "editor" {
		t.Error("any permission → editor")
	}
}

// TestWritePermissionMiddleware: a viewer reads but can't change anything; a
// custom role's list replaces its base role's.
func TestWritePermissionMiddleware(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	h := WritePermissionMiddleware(ok)
	run := func(method, path string, ctx context.Context) int {
		r := httptest.NewRequest(method, path, nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec.Code
	}

	viewer := context.WithValue(WithUser(context.Background(), 7, "v@example.com"), tenantRoleKey{}, "viewer")
	if run("GET", "/api/v1/polygons", viewer) != 200 {
		t.Error("viewer must read")
	}
	if run("POST", "/api/v1/reports/3/run", viewer) != 200 {
		t.Error("running a report is a read")
	}
	if run("POST", "/api/v1/alert-events/seen", viewer) != 200 {
		t.Error("marking the bell read is a read")
	}
	if run("POST", "/api/v1/polygons", viewer) != 403 {
		t.Error("viewer must not draw")
	}

	guard := context.WithValue(viewer, tenantPermsKey{}, []string{PermAlertsRespond})
	if run("POST", "/api/v1/alert-events/9/ack", guard) != 200 {
		t.Error("custom role with alerts.respond acks alerts")
	}
	if run("POST", "/api/v1/polygons", guard) != 403 {
		t.Error("custom role without facilities.edit must not draw")
	}

	// API-key caller (no user): every permission.
	if run("DELETE", "/api/v1/zones/4", context.Background()) != 200 {
		t.Error("API-key caller holds every permission")
	}
}
