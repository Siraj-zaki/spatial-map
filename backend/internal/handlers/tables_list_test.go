package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// TestTablesStatsAndRowSearch guards two things the Tables screen
// depends on:
//
//   - GET /tables carries per-table stats. It once returned no tokens and
//     no counts, so the list derived "no write token" from an absent
//     array and flagged every table as unable to receive data.
//   - GET /tables/{id}/rows supports ?q= (row key or any value, LIKE
//     wildcards literal) and ?sortBy=field:<key> (numeric fields sorted
//     as numbers, unknown keys rejected).
func TestTablesStatsAndRowSearch(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, _, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	var userID, tenantID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash) VALUES ('admin@example.com', 'x') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO tenants (name, color) VALUES ('T', '#111111') RETURNING id`).Scan(&tenantID))
	_, err := pool.Exec(ctx, `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, userID, tenantID)
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(api.WithUser(req.Context(), userID, "admin@example.com")))
		})
	})
	r.Use(api.TenantMiddleware(q))
	r.Mount("/tables", handlers.TablesRouter(q, pool))

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
	type table struct {
		DataSource struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"dataSource"`
		Stats *struct {
			Rows        int64  `json:"rows"`
			LastWriteAt string `json:"lastWriteAt"`
			ActiveKeys  int64  `json:"activeKeys"`
			Polling     bool   `json:"polling"`
		} `json:"stats"`
	}
	create := func(name string) int64 {
		rr := call(http.MethodPost, "/tables", map[string]any{
			"name": name, "entityKind": "asset",
			"fields": []map[string]any{
				{"fieldKey": "name", "fieldLabel": "Name", "dataType": "text"},
				{"fieldKey": "qty", "fieldLabel": "Qty", "dataType": "integer"},
			},
		})
		require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
		var out table
		require.NoError(t, extractData(rr.Body.Bytes(), &out))
		return out.DataSource.ID
	}
	stocked := create("Stocked")
	empty := create("Empty")

	for _, row := range []struct {
		key  string
		name string
		qty  int
	}{{"A-1", "Alpha", 10}, {"B-2", "beta 50% off", 9}, {"C-3", "Gamma", 100}} {
		rr := call(http.MethodPost, fmt.Sprintf("/tables/%d/rows", stocked), map[string]any{
			"entityKey": row.key, "payload": map[string]any{"name": row.name, "qty": row.qty},
		})
		require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	}

	// Stats on the list: rows, last write, the auto-minted key.
	rr := call(http.MethodGet, "/tables", nil)
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	var tables []table
	require.NoError(t, extractData(rr.Body.Bytes(), &tables))
	byID := map[int64]table{}
	for _, tb := range tables {
		require.NotNil(t, tb.Stats, tb.DataSource.Name)
		byID[tb.DataSource.ID] = tb
	}
	require.EqualValues(t, 3, byID[stocked].Stats.Rows)
	require.NotEmpty(t, byID[stocked].Stats.LastWriteAt)
	require.EqualValues(t, 1, byID[stocked].Stats.ActiveKeys, "create mints a default key")
	require.EqualValues(t, 0, byID[empty].Stats.Rows)
	require.Empty(t, byID[empty].Stats.LastWriteAt)

	type rowsResp struct {
		Rows []struct {
			EntityKey string `json:"entityKey"`
		} `json:"rows"`
		TotalCount int `json:"totalCount"`
	}
	keys := func(query string) []string {
		rr := call(http.MethodGet, fmt.Sprintf("/tables/%d/rows?%s", stocked, query), nil)
		require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
		var out rowsResp
		require.NoError(t, extractData(rr.Body.Bytes(), &out))
		ks := []string{}
		for _, row := range out.Rows {
			ks = append(ks, row.EntityKey)
		}
		return ks
	}

	require.Equal(t, []string{"C-3"}, keys("q=gam"), "matches a payload value, case-insensitively")
	require.Equal(t, []string{"B-2"}, keys("q=b-2"), "matches the row key")
	require.Equal(t, []string{"B-2"}, keys("q="+url.QueryEscape("%")), "% is literal, not a wildcard")
	require.Empty(t, keys("q=qty"), "field names are not values")

	require.Equal(t, []string{"B-2", "A-1", "C-3"}, keys("sortBy=field:qty&sortDir=asc"), "numeric, not 10 < 100 < 9")
	require.Equal(t, []string{"A-1", "B-2", "C-3"}, keys("sortBy=field:name&sortDir=asc"))

	rr = call(http.MethodGet, fmt.Sprintf("/tables/%d/rows?sortBy=field:nope", stocked), nil)
	require.Equal(t, http.StatusBadRequest, rr.Code)
}
