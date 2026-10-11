package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// TestReportArchiveRestore covers the gallery's archive → Undo round trip
// (an archived report leaves the directory, restore brings it back, both
// owner/admin only) and that a workspace viewer can't edit even a report
// they created.
func TestReportArchiveRestore(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	ctx := context.Background()
	q, pool, _, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	var userID, tenantID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (email, password_hash) VALUES ('r@example.com', 'x') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO tenants (name, color) VALUES ('T', '#111111') RETURNING id`).Scan(&tenantID))
	_, err := pool.Exec(ctx, `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, userID, tenantID)
	require.NoError(t, err)
	setRole := func(role string) {
		_, err := pool.Exec(ctx, `UPDATE user_tenants SET role = $1 WHERE user_id = $2 AND tenant_id = $3`, role, userID, tenantID)
		require.NoError(t, err)
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(api.WithUser(req.Context(), userID, "r@example.com")))
		})
	})
	r.Use(api.TenantMiddleware(q))
	r.Mount("/reports", handlers.ReportsRouter(q, pool, reports.NewExecutor(pool)))
	call := func(method, path string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			require.NoError(t, json.NewEncoder(&buf).Encode(body))
		}
		req := httptest.NewRequest(method, path, &buf)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		return rr
	}
	listed := func() int {
		rr := call(http.MethodGet, "/reports", nil)
		require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
		var list []map[string]any
		require.NoError(t, extractData(rr.Body.Bytes(), &list))
		return len(list)
	}

	rr := call(http.MethodPost, "/reports", map[string]any{"name": "Weekly", "spec": map[string]any{"v": 2}, "specVersion": 2})
	require.Less(t, rr.Code, 300, rr.Body.String())
	var created struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, extractData(rr.Body.Bytes(), &created))
	require.Equal(t, 1, listed())

	require.Equal(t, http.StatusNoContent, call(http.MethodDelete, fmt.Sprintf("/reports/%d", created.ID), nil).Code)
	require.Equal(t, 0, listed(), "an archived report leaves the directory")

	setRole("editor")
	require.Equal(t, http.StatusForbidden, call(http.MethodPost, fmt.Sprintf("/reports/%d/restore", created.ID), nil).Code)

	setRole("admin")
	require.Equal(t, http.StatusNoContent, call(http.MethodPost, fmt.Sprintf("/reports/%d/restore", created.ID), nil).Code)
	require.Equal(t, 1, listed(), "restore brings it back")

	require.Equal(t, http.StatusNotFound, call(http.MethodPost, "/reports/999999/restore", nil).Code)

	// A creator demoted to viewer still sees their report but can no
	// longer edit it — the workspace role caps the report ACL.
	setRole("viewer")
	rr = call(http.MethodGet, "/reports", nil)
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	var list []struct {
		ID      int64 `json:"id"`
		CanEdit bool  `json:"canEdit"`
	}
	require.NoError(t, extractData(rr.Body.Bytes(), &list))
	require.Len(t, list, 1)
	require.False(t, list[0].CanEdit, "a viewer's own report is read-only")
	require.Equal(t, http.StatusOK, call(http.MethodGet, fmt.Sprintf("/reports/%d", created.ID), nil).Code)
	rr = call(http.MethodPut, fmt.Sprintf("/reports/%d", created.ID), map[string]any{"name": "Renamed", "spec": map[string]any{"v": 2}, "specVersion": 2})
	require.Equal(t, http.StatusForbidden, rr.Code, rr.Body.String())

	// Promoted to editor, the creator edits again — and the facility a PUT
	// omits is cleared, which is why the SPA always sends zoneId.
	setRole("editor")
	rr = call(http.MethodPut, fmt.Sprintf("/reports/%d", created.ID), map[string]any{"name": "Renamed", "spec": map[string]any{"v": 2}, "specVersion": 2})
	require.Less(t, rr.Code, 300, rr.Body.String())
}
