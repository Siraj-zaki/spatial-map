package handlers_test

// The bulk create exists so a CAD import can land a thousand walls in one
// round trip instead of a thousand. What has to be proved is not that it is
// fast — that follows from the shape — but that it is *all or nothing*. A
// half-landed import is the expensive failure: the user cannot tell it apart
// from a clean one, so they have to audit a floor plan by hand to find which
// walls are missing.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/stretchr/testify/require"
)

type bulkCreateEnvelope struct {
	Created int                          `json:"created"`
	Items   []handlers.BaseShapeResponse `json:"items"`
}

func TestBulkCreateShapes(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	apiKey := "test-api-key"
	router := testRouter(q, pool, s, apiKey)

	post := func(path string, body any, tenantID int64) *httptest.ResponseRecorder {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Api-Key", apiKey)
		if tenantID != 0 {
			req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
		}
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr
	}

	countLines := func(tenantID int64) int {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/lines", nil)
		req.Header.Set("X-Api-Key", apiKey)
		req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		require.Equal(t, http.StatusOK, rr.Code)
		var rows []handlers.BaseShapeResponse
		require.NoError(t, extractData(rr.Body.Bytes(), &rows))
		return len(rows)
	}

	rr := post("/api/v1/tenants", map[string]string{"name": "Bulk Co", "color": "#123456"}, 0)
	require.Equal(t, http.StatusCreated, rr.Code)
	var tenant handlers.TenantResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &tenant))

	wall := func(name string) map[string]any {
		return map[string]any{
			"name":     name,
			"vertices": [][]float64{{-122.4, 37.7}, {-122.3, 37.8}},
			"config":   map[string]any{"wallThickness": 0.2},
			"unit":     "m",
			"visible":  true,
		}
	}

	t.Run("creates every item and reports them back", func(t *testing.T) {
		const n = 25
		items := make([]map[string]any, n)
		for i := range items {
			items[i] = wall(fmt.Sprintf("Wall %d", i))
		}
		rr := post("/api/v1/lines/bulk", map[string]any{"items": items}, tenant.ID)
		require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())

		var env bulkCreateEnvelope
		require.NoError(t, extractData(rr.Body.Bytes(), &env))
		require.Equal(t, n, env.Created)
		require.Len(t, env.Items, n)
		// The ids are the point of the response: the caller has optimistic
		// rows to reconcile against, and cannot do that from a count.
		for i, row := range env.Items {
			require.NotZero(t, row.ID, "item %d came back without an id", i)
			require.Equal(t, tenant.ID, row.TenantID)
			require.Equal(t, fmt.Sprintf("Wall %d", i), row.Name)
		}
		require.Equal(t, n, countLines(tenant.ID))
	})

	t.Run("one invalid item writes none of them", func(t *testing.T) {
		before := countLines(tenant.ID)
		items := []map[string]any{wall("Good A"), wall("Good B"), {"vertices": [][]float64{}}}
		rr := post("/api/v1/lines/bulk", map[string]any{"items": items}, tenant.ID)
		require.Equal(t, http.StatusBadRequest, rr.Code)
		// Naming the index is what makes a thousand-row failure actionable.
		require.Contains(t, rr.Body.String(), "items[2]")
		require.Equal(t, before, countLines(tenant.ID), "a rejected batch left rows behind")
	})

	t.Run("rejects an empty batch", func(t *testing.T) {
		rr := post("/api/v1/lines/bulk", map[string]any{"items": []any{}}, tenant.ID)
		require.Equal(t, http.StatusBadRequest, rr.Code)
	})

	t.Run("bulk is reachable on every kind a drawing produces", func(t *testing.T) {
		for _, path := range []string{"/api/v1/polygons/bulk", "/api/v1/lines/bulk"} {
			rr := post(path, map[string]any{"items": []any{}}, tenant.ID)
			require.Equal(t, http.StatusBadRequest, rr.Code, "%s is not mounted", path)
		}
	})
}
