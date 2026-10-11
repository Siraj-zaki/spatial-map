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
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// TestDataScreenDeleteRoles guards /data deletes and purges by workspace
// role. They had no check at all, so a viewer could purge every record a
// source had ever ingested.
func TestDataScreenDeleteRoles(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	ctx := context.Background()
	q, pool, _, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	var userID, tenantID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (email, password_hash) VALUES ('m@example.com', 'x') RETURNING id`).Scan(&userID))
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
			next.ServeHTTP(w, req.WithContext(api.WithUser(req.Context(), userID, "m@example.com")))
		})
	})
	r.Use(api.TenantMiddleware(q))
	r.Mount("/tables", handlers.TablesRouter(q, pool))
	r.Mount("/data", handlers.DataScreenRouter(q, pool))
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

	// A table with two records, created as owner.
	rr := call(http.MethodPost, "/tables", map[string]any{"name": "T", "fields": []map[string]any{{"fieldKey": "n", "fieldLabel": "N", "dataType": "text"}}})
	require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
	var created struct {
		DataSource struct {
			ID int64 `json:"id"`
		} `json:"dataSource"`
	}
	require.NoError(t, extractData(rr.Body.Bytes(), &created))
	sourceID := created.DataSource.ID
	for _, k := range []string{"a", "b"} {
		rr = call(http.MethodPost, fmt.Sprintf("/tables/%d/rows", sourceID), map[string]any{"entityKey": k, "payload": map[string]any{"n": k}})
		require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	}
	var rowIDs []int64
	rows, err := pool.Query(ctx, `SELECT id FROM data_source_rows WHERE source_id = $1 ORDER BY entity_key`, sourceID)
	require.NoError(t, err)
	for rows.Next() {
		var id int64
		require.NoError(t, rows.Scan(&id))
		rowIDs = append(rowIDs, id)
	}
	rows.Close()
	require.Len(t, rowIDs, 2)

	// Viewer: reads fine, every destructive call refused.
	setRole("viewer")
	require.Equal(t, http.StatusOK, call(http.MethodGet, "/data/rows", nil).Code)
	require.Equal(t, http.StatusForbidden, call(http.MethodDelete, fmt.Sprintf("/data/rows/%d", rowIDs[0]), nil).Code)
	require.Equal(t, http.StatusForbidden, call(http.MethodPost, "/data/rows/bulk-delete", map[string]any{"ids": rowIDs}).Code)
	require.Equal(t, http.StatusForbidden, call(http.MethodPost, "/data/rows/purge", map[string]any{"sourceId": sourceID}).Code)
	var left int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM data_source_rows WHERE source_id = $1`, sourceID).Scan(&left))
	require.Equal(t, 2, left, "a viewer must not be able to delete anything")

	// Editor: can delete one, and purge the rest.
	setRole("editor")
	rr = call(http.MethodDelete, fmt.Sprintf("/data/rows/%d", rowIDs[0]), nil)
	require.Less(t, rr.Code, 300, rr.Body.String())
	rr = call(http.MethodPost, "/data/rows/purge", map[string]any{"sourceId": sourceID})
	require.Less(t, rr.Code, 300, rr.Body.String())
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM data_source_rows WHERE source_id = $1`, sourceID).Scan(&left))
	require.Equal(t, 0, left)
}
