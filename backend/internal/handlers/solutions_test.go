package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// TestSolutions guards the Solutions grouping: workspace-scoped CRUD,
// role gating, foreign ids ignored, members cascading away with the
// facility / data source they point at, and the `?solution=` filter on
// the facility list and every Data-screen list.
func TestSolutions(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	ctx := context.Background()
	q, pool, _, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	var editor, viewer, mine, theirs int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (email, password_hash) VALUES ('ed@example.com', 'x') RETURNING id`).Scan(&editor))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (email, password_hash) VALUES ('vi@example.com', 'x') RETURNING id`).Scan(&viewer))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO tenants (name, color) VALUES ('Mine', '#111111') RETURNING id`).Scan(&mine))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO tenants (name, color) VALUES ('Theirs', '#222222') RETURNING id`).Scan(&theirs))
	_, err := pool.Exec(ctx, `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $3, 'editor'), ($2, $3, 'viewer')`, editor, viewer, mine)
	require.NoError(t, err)

	zone := func(tenant int64, name string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO zones (tenant_id, name, color, center) VALUES ($1, $2, '#333333', ST_SetSRID(ST_MakePoint(0,0),4326)) RETURNING id`, tenant, name).Scan(&id))
		return id
	}
	source := func(tenant int64, name string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO data_sources (tenant_id, name, kind, entity_kind, config, mapping) VALUES ($1, $2, 'table', 'asset', '{}', '{}') RETURNING id`, tenant, name).Scan(&id))
		return id
	}
	hospital, warehouse, theirZone := zone(mine, "Hospital"), zone(mine, "Warehouse"), zone(theirs, "Their site")
	beds, stock, theirSource := source(mine, "Beds"), source(mine, "Stock"), source(theirs, "Theirs")
	for i, src := range []int64{beds, beds, stock} {
		_, err := pool.Exec(ctx, `INSERT INTO data_source_rows (tenant_id, source_id, entity_key, payload) VALUES ($1, $2, $3, '{}')`, mine, src, fmt.Sprintf("k%d", i))
		require.NoError(t, err)
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			uid := editor
			if req.Header.Get("X-As") == "viewer" {
				uid = viewer
			}
			next.ServeHTTP(w, req.WithContext(api.WithUser(req.Context(), uid, "u@example.com")))
		})
	})
	r.Use(api.TenantMiddleware(q))
	r.Mount("/solutions", handlers.SolutionsRouter(q, pool))
	r.Mount("/warehouse-summaries", handlers.WarehouseSummariesRouter(pool))
	r.Mount("/data", handlers.DataScreenRouter(q, pool))
	do := func(method, path string, body any, as string) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			require.NoError(t, json.NewEncoder(&buf).Encode(body))
		}
		req := httptest.NewRequest(method, path, &buf)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", mine))
		if as != "" {
			req.Header.Set("X-As", as)
		}
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		return rr
	}
	type sol struct {
		ID            int64   `json:"id"`
		Name          string  `json:"name"`
		Icon          string  `json:"icon"`
		ZoneIDs       []int64 `json:"zoneIds"`
		ReportIDs     []int64 `json:"reportIds"`
		DataSourceIDs []int64 `json:"dataSourceIds"`
	}
	decode := func(rr *httptest.ResponseRecorder, dst any) {
		require.NoError(t, extractData(rr.Body.Bytes(), dst), rr.Body.String())
	}

	// Viewers can read but not create.
	rr := do(http.MethodPost, "/solutions", map[string]any{"name": "Nope"}, "viewer")
	require.Equal(t, http.StatusForbidden, rr.Code)

	// Create with members; another workspace's ids are dropped.
	rr = do(http.MethodPost, "/solutions", map[string]any{
		"name": "  Hospital  ", "icon": "heart-pulse", "color": "#e11d48", "template": "hospital",
		"zoneIds": []int64{hospital, theirZone}, "dataSourceIds": []int64{beds, theirSource},
	}, "")
	require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
	var h sol
	decode(rr, &h)
	require.Equal(t, "Hospital", h.Name)
	require.Equal(t, []int64{hospital}, h.ZoneIDs)
	require.Equal(t, []int64{beds}, h.DataSourceIDs)
	require.Empty(t, h.ReportIDs)

	// An item can be in several solutions.
	rr = do(http.MethodPost, "/solutions", map[string]any{"name": "Everything", "zoneIds": []int64{hospital, warehouse}, "dataSourceIds": []int64{beds, stock}}, "")
	require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
	var all sol
	decode(rr, &all)

	// Add / remove members; re-adding is a no-op.
	rr = do(http.MethodPost, fmt.Sprintf("/solutions/%d/items", h.ID), map[string]any{"zoneIds": []int64{warehouse, hospital}}, "")
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	decode(rr, &h)
	sort.Slice(h.ZoneIDs, func(a, b int) bool { return h.ZoneIDs[a] < h.ZoneIDs[b] })
	require.Equal(t, []int64{hospital, warehouse}, h.ZoneIDs)
	rr = do(http.MethodDelete, fmt.Sprintf("/solutions/%d/items", h.ID), map[string]any{"zoneIds": []int64{warehouse}}, "")
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	decode(rr, &h)
	require.Equal(t, []int64{hospital}, h.ZoneIDs)

	// Partial update keeps the other fields.
	rr = do(http.MethodPatch, fmt.Sprintf("/solutions/%d", h.ID), map[string]any{"name": "Hospital wing"}, "")
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	decode(rr, &h)
	require.Equal(t, "Hospital wing", h.Name)
	require.Equal(t, "heart-pulse", h.Icon)

	// Viewer sees the list.
	rr = do(http.MethodGet, "/solutions", nil, "viewer")
	require.Equal(t, http.StatusOK, rr.Code)
	var list []sol
	decode(rr, &list)
	require.Len(t, list, 2)

	// ?solution= on the facility list, including its KPI stats.
	var wh struct {
		Rows []struct {
			ID int64 `json:"id"`
		} `json:"rows"`
		Total int `json:"total"`
		Stats struct {
			TotalWarehouses int `json:"totalWarehouses"`
		} `json:"stats"`
	}
	rr = do(http.MethodGet, fmt.Sprintf("/warehouse-summaries?solution=%d", h.ID), nil, "")
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	decode(rr, &wh)
	require.Equal(t, 1, wh.Total)
	require.Equal(t, hospital, wh.Rows[0].ID)
	require.Equal(t, 1, wh.Stats.TotalWarehouses)
	rr = do(http.MethodGet, "/warehouse-summaries", nil, "")
	decode(rr, &wh)
	require.Equal(t, 2, wh.Total, "no filter → every facility of this workspace")

	// ?solution= on the Data screen lists.
	var rows struct {
		Total int `json:"total"`
		Stats struct {
			TotalRows     int `json:"totalRows"`
			ActiveSources int `json:"activeSources"`
		} `json:"stats"`
	}
	rr = do(http.MethodGet, fmt.Sprintf("/data/rows?solution=%d", h.ID), nil, "")
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	decode(rr, &rows)
	require.Equal(t, 2, rows.Total, "only the Beds rows")
	require.Equal(t, 2, rows.Stats.TotalRows, "the KPI totals follow the solution too")
	require.Equal(t, 1, rows.Stats.ActiveSources)
	rr = do(http.MethodGet, fmt.Sprintf("/data/rows?solution=%d", all.ID), nil, "")
	decode(rr, &rows)
	require.Equal(t, 3, rows.Total)
	for _, tab := range []string{"bins", "files", "runs", "live", "live/events"} {
		rr = do(http.MethodGet, fmt.Sprintf("/data/%s?solution=%d", tab, h.ID), nil, "")
		require.Equal(t, http.StatusOK, rr.Code, "%s: %s", tab, rr.Body.String())
	}
	var srcs []struct {
		ID int64 `json:"id"`
	}
	rr = do(http.MethodGet, fmt.Sprintf("/data/sources?solution=%d", h.ID), nil, "")
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	decode(rr, &srcs)
	require.Len(t, srcs, 1)
	require.Equal(t, beds, srcs[0].ID)

	// A foreign or unknown solution id is a 404, never a silent "show all".
	var theirSolution int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO solutions (tenant_id, name) VALUES ($1, 'Theirs') RETURNING id`, theirs).Scan(&theirSolution))
	rr = do(http.MethodGet, fmt.Sprintf("/warehouse-summaries?solution=%d", theirSolution), nil, "")
	require.Equal(t, http.StatusNotFound, rr.Code)
	rr = do(http.MethodGet, fmt.Sprintf("/solutions/%d", theirSolution), nil, "")
	require.Equal(t, http.StatusNotFound, rr.Code)

	// Overview KPIs.
	var ov struct {
		TotalRows  int64 `json:"totalRows"`
		Updated24h int64 `json:"updated24h"`
	}
	rr = do(http.MethodGet, fmt.Sprintf("/solutions/%d/overview", all.ID), nil, "viewer")
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	decode(rr, &ov)
	require.Equal(t, int64(3), ov.TotalRows)

	// Deleting a facility / data source drops it from every solution.
	_, err = pool.Exec(ctx, `DELETE FROM zones WHERE id = $1`, hospital)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM data_sources WHERE id = $1`, stock)
	require.NoError(t, err)
	rr = do(http.MethodGet, fmt.Sprintf("/solutions/%d", all.ID), nil, "")
	decode(rr, &all)
	require.Equal(t, []int64{warehouse}, all.ZoneIDs)
	require.Equal(t, []int64{beds}, all.DataSourceIDs)

	// Deleting a solution keeps the items.
	rr = do(http.MethodDelete, fmt.Sprintf("/solutions/%d", all.ID), nil, "")
	require.Equal(t, http.StatusNoContent, rr.Code, rr.Body.String())
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM zones WHERE id = $1`, warehouse).Scan(&n))
	require.Equal(t, 1, n)
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM solution_items WHERE solution_id = $1`, all.ID).Scan(&n))
	require.Equal(t, 0, n)
}
