package handlers_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/Siraj-zaki/spatial-map/backend/internal/migrate"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func extractData(body []byte, dst any) error {
	var wrap struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &wrap); err != nil {
		return err
	}
	return json.Unmarshal(wrap.Data, dst)
}

func TestDataLinkCRUD(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	apiKey := "test-api-key"
	router := testRouter(q, pool, s, apiKey)

	// Create tenant
	body, _ := json.Marshal(map[string]string{"name": "DataLink Tenant", "color": "#111111"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/tenants", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var tenant handlers.TenantResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &tenant))
	require.NotZero(t, tenant.ID)

	tenantID := tenant.ID

	// Create connection
	connBody, _ := json.Marshal(map[string]any{
		"name":      "Warehouse API",
		"transport": "rest",
		"auth":      map[string]any{"type": "bearer"},
		"config":    map[string]any{"base_url": "https://example.com"},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/connections", bytes.NewReader(connBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var conn handlers.ConnectionResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &conn))
	require.NotZero(t, conn.ID)
	require.Equal(t, "Warehouse API", conn.Name)
	require.Equal(t, "rest", conn.Transport)

	// Create data source
	dsBody, _ := json.Marshal(map[string]any{
		"name":            "Inventory CSV",
		"kind":            "csv",
		"config":          map[string]any{"delimiter": ","},
		"mapping":         map[string]any{"sku": "sku"},
		"schedule":        "manual",
		"intervalSeconds": 60,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/data-sources", bytes.NewReader(dsBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var ds handlers.DataSourceResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &ds))
	require.NotZero(t, ds.ID)
	require.Equal(t, "Inventory CSV", ds.Name)
	require.Equal(t, "csv", ds.Kind)
	require.NotNil(t, ds.IntervalSeconds)
	require.Equal(t, int32(60), *ds.IntervalSeconds)

	// Create stream
	streamBody, _ := json.Marshal(map[string]any{
		"connectionId":    conn.ID,
		"dataSourceId":    ds.ID,
		"name":            "Live Inventory",
		"entityType":      "bin",
		"kind":            "event",
		"binding":         map[string]any{"kind": "grid-cell", "gridId": 1},
		"endpoint":        map[string]any{"path": "/inventory"},
		"schedule":        "interval",
		"intervalSeconds": 30,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/streams", bytes.NewReader(streamBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var stream handlers.StreamResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &stream))
	require.NotZero(t, stream.ID)
	require.Equal(t, conn.ID, stream.ConnectionID)
	require.NotNil(t, stream.DataSourceID)
	require.Equal(t, ds.ID, *stream.DataSourceID)
	require.Equal(t, "Live Inventory", stream.Name)

	// Create import job
	jobBody, _ := json.Marshal(map[string]any{
		"sourceId":    ds.ID,
		"startedAt":   time.Now().UTC().Format(time.RFC3339),
		"status":      "running",
		"stats":       map[string]any{"rows": 100},
		"errorReport": "",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/import-jobs", bytes.NewReader(jobBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Logf("import job create failed: %s", rr.Body.String())
	}
	require.Equal(t, http.StatusCreated, rr.Code)

	var job handlers.ImportJobResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &job))
	require.NotZero(t, job.ID)
	require.Equal(t, ds.ID, job.SourceID)
	require.Equal(t, "running", job.Status)

	// List connections
	req = httptest.NewRequest(http.MethodGet, "/api/v1/connections", nil)
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	var conns []handlers.ConnectionResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &conns))
	require.Len(t, conns, 1)

	// Update stream (PATCH currently requires the full request shape)
	updateBody, _ := json.Marshal(map[string]any{
		"connectionId":    conn.ID,
		"dataSourceId":    ds.ID,
		"name":            "Live Inventory",
		"entityType":      "bin",
		"kind":            "event",
		"binding":         map[string]any{"kind": "grid-cell", "gridId": 1},
		"endpoint":        map[string]any{"path": "/inventory/v2"},
		"schedule":        "interval",
		"intervalSeconds": 30,
	})
	req = httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/v1/streams/%d", stream.ID), bytes.NewReader(updateBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	var updatedStream handlers.StreamResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &updatedStream))
	require.Equal(t, stream.ID, updatedStream.ID)
}

func TestWebhookIngestAndDrain(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	apiKey := "test-api-key"
	router := testRouter(q, pool, s, apiKey)

	// Create tenant
	body, _ := json.Marshal(map[string]string{"name": "Webhook Tenant", "color": "#000000"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/tenants", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var tenant handlers.TenantResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &tenant))
	require.NotZero(t, tenant.ID)
	tenantID := tenant.ID

	// Create connection for webhook stream
	connBody, _ := json.Marshal(map[string]any{
		"name":      "Webhook Connection",
		"transport": "webhook",
		"auth":      map[string]any{"mode": "hmac", "secret": "super-secret-32"},
		"config":    map[string]any{"transport": "webhook", "workerBaseUrl": "http://localhost:8080", "drainApiKey": apiKey},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/connections", bytes.NewReader(connBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var conn handlers.ConnectionResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &conn))
	require.NotZero(t, conn.ID)

	// Create stream with token in endpoint
	token := "test-webhook-token-01"
	streamBody, _ := json.Marshal(map[string]any{
		"connectionId": conn.ID,
		"name":         "Webhook Inventory",
		"entityType":   "bin",
		"kind":         "state",
		"binding":      map[string]any{"kind": "bin-upsert", "mapping": map[string]any{"fields": map[string]any{}}},
		"endpoint": map[string]any{
			"transport":   "webhook",
			"sourceToken": token,
			"hmacSecret":  "super-secret-32",
		},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/streams", bytes.NewReader(streamBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var stream handlers.StreamResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &stream))
	require.NotZero(t, stream.ID)

	// Verify registration health endpoint
	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/webhooks/%s", token), nil)
	req.Header.Set("X-Api-Key", apiKey)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	// The stream has an hmacSecret, so unsigned and wrongly signed
	// posts are refused (401) and nothing is queued.
	eventBody, _ := json.Marshal(map[string]any{"sku": "ABC-123", "qty": 5})
	for _, sig := range []string{"", signWebhook("wrong-secret", eventBody)} {
		req = httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/v1/webhooks/%s?apiKey=%s", token, apiKey), bytes.NewReader(eventBody))
		req.Header.Set("Content-Type", "application/json")
		if sig != "" {
			req.Header.Set("X-Webhook-Signature", sig)
		}
		rr = httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		require.Equal(t, http.StatusUnauthorized, rr.Code, rr.Body.String())
	}

	// POST a single signed event (publisher may use query param for API key)
	req = httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/v1/webhooks/%s?apiKey=%s", token, apiKey), bytes.NewReader(eventBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Webhook-Signature", signWebhook("super-secret-32", eventBody))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusAccepted, rr.Code)
	var ingestResp map[string]any
	require.NoError(t, extractData(rr.Body.Bytes(), &ingestResp))
	require.Equal(t, float64(1), ingestResp["received"])

	// POST a batch of events
	batch, _ := json.Marshal([]map[string]any{
		{"sku": "DEF-456", "qty": 1},
		{"sku": "GHI-789", "qty": 3},
	})
	req = httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/v1/webhooks/%s", token), bytes.NewReader(batch))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Webhook-Signature", signWebhook("super-secret-32", batch))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusAccepted, rr.Code)
	require.NoError(t, extractData(rr.Body.Bytes(), &ingestResp))
	require.Equal(t, float64(2), ingestResp["received"])

	// Drain events
	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/webhooks/%s/drain?max=10", token), nil)
	req.Header.Set("X-Api-Key", apiKey)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	var drainResp struct {
		Events    []map[string]any `json:"events"`
		Remaining int64            `json:"remaining"`
	}
	require.NoError(t, extractData(rr.Body.Bytes(), &drainResp))
	require.Len(t, drainResp.Events, 3)
	require.Zero(t, drainResp.Remaining)

	// Second drain is empty
	var secondDrain struct {
		Events    []map[string]any `json:"events"`
		Remaining int64            `json:"remaining"`
	}
	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/webhooks/%s/drain", token), nil)
	req.Header.Set("X-Api-Key", apiKey)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.NoError(t, extractData(rr.Body.Bytes(), &secondDrain))
	require.Empty(t, secondDrain.Events)
	require.Zero(t, secondDrain.Remaining)
}

// signWebhook builds an X-Webhook-Signature value the way a sender
// would: HMAC-SHA256 over "<unix>.<body>".
func signWebhook(secret string, body []byte) string {
	ts := time.Now().Unix()
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", ts, body)
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}

func TestTenantAndZoneCRUD(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	apiKey := "test-api-key"
	router := testRouter(q, pool, s, apiKey)

	// Create tenant
	body, _ := json.Marshal(map[string]string{"name": "Warehouse A", "color": "#ff0000"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/tenants", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var tenant handlers.TenantResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &tenant))
	require.NotZero(t, tenant.ID)
	require.Equal(t, "Warehouse A", tenant.Name)

	// Create zone under tenant
	zoneBody, _ := json.Marshal(map[string]any{
		"name":        "Zone 1",
		"color":       "#00ff00",
		"description": "",
		"center":      []float64{-122.4194, 37.7749},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/zones", bytes.NewReader(zoneBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var zone handlers.ZoneResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &zone))
	require.NotZero(t, zone.ID)
	require.Equal(t, tenant.ID, zone.TenantID)
	require.NotNil(t, zone.Center)
	require.InDelta(t, -122.4194, zone.Center[0], 0.0001)
	require.InDelta(t, 37.7749, zone.Center[1], 0.0001)

	// A new facility gets the facility report set (Overview, Floors, …).
	var setCount int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM reports WHERE tenant_id = $1 AND zone_id = $2 AND spec->'origin'->>'kind' = 'facility-set'`, tenant.ID, zone.ID,
	).Scan(&setCount))
	require.Equal(t, 8, setCount)

	// List zones
	req = httptest.NewRequest(http.MethodGet, "/api/v1/zones", nil)
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	var zones []handlers.ZoneResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &zones))
	require.Len(t, zones, 1)

	// Get zone
	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/zones/%d", zone.ID), nil)
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	// Update zone
	updateBody, _ := json.Marshal(map[string]any{
		"name":        "Zone 1 Updated",
		"color":       "#0000ff",
		"description": "updated description",
		"center":      []float64{-122.5, 37.8},
	})
	req = httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/v1/zones/%d", zone.ID), bytes.NewReader(updateBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.NoError(t, extractData(rr.Body.Bytes(), &zone))
	require.Equal(t, "Zone 1 Updated", zone.Name)

	// Delete zone
	req = httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/v1/zones/%d", zone.ID), nil)
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusNoContent, rr.Code)

	// Create polygon
	polygonBody, _ := json.Marshal(map[string]any{
		"name":     "Building A",
		"vertices": []any{[]float64{-122.0, 37.0}, []float64{-121.9, 37.0}, []float64{-121.9, 37.1}},
		"rotation": 0,
		"unit":     "m",
		"visible":  true,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/polygons", bytes.NewReader(polygonBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var polygon handlers.PolygonResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &polygon))
	require.NotZero(t, polygon.ID)
	require.Equal(t, "Building A", polygon.Name)

	// Create grid
	gridBody, _ := json.Marshal(map[string]any{
		"name":    "Grid A",
		"start":   []float64{-122.0, 37.0},
		"current": []float64{-122.0, 37.0},
		"config":  map[string]any{"rows": 10, "cols": 10},
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/grids", bytes.NewReader(gridBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var grid handlers.GridResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &grid))
	require.NotZero(t, grid.ID)
	require.Equal(t, "Grid A", grid.Name)

	// Create bin under grid
	binBody, _ := json.Marshal(map[string]any{
		"targetKind": "grid-cell",
		"gridId":     grid.ID,
		"row":        1,
		"col":        2,
		"level":      0,
		"status":     "empty",
		"sku":        "SKU-123",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/bins", bytes.NewReader(binBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var bin handlers.BinResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &bin))
	require.NotZero(t, bin.ID)
	require.Equal(t, "grid-cell", bin.TargetKind)
	require.Equal(t, "empty", bin.Status)
	require.Equal(t, "SKU-123", bin.Sku)
}

// TestStreamEntityQueries was removed in Slice 6c2 of the data-link
// refactor: the per-entity handlers (/streams/:id/assets, /sensors,
// /rfid, /shipments, /cameras, /detections) and their backing tables
// (assets, asset_positions, sensors, sensor_readings, rfid_tags,
// rfid_reads, shipments, cameras, cv_detections) were deleted. The
// generic /streams/:id/ingest + /streams/:id/entities +
// /streams/:id/events endpoints replace them. A future test should
// cover round-tripping through those; the old per-entity coverage is
// no longer meaningful.

func TestDataSourceMirrorCRUD(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	apiKey := "test-api-key"
	router := testRouter(q, pool, s, apiKey)

	// Create tenant
	body, _ := json.Marshal(map[string]string{"name": "Mirror Tenant", "color": "#222222"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/tenants", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var tenant handlers.TenantResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &tenant))
	tenantID := tenant.ID

	// Create mirrored data source
	body, _ = json.Marshal(map[string]any{
		"name":            "Inventory CSV",
		"kind":            "csv",
		"config":          map[string]any{"delimiter": ","},
		"mapping":         map[string]any{"fields": map[string]string{"sku": "sku"}},
		"schedule":        "manual",
		"intervalSeconds": 60,
	})
	req = newRequest(http.MethodPost, "/api/v1/data-sources/with-mirror", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var mirror handlers.DataSourceMirrorResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &mirror))
	require.NotZero(t, mirror.DataSource.ID)
	require.Equal(t, "Inventory CSV", mirror.DataSource.Name)
	require.NotZero(t, mirror.Connection.ID)
	require.Equal(t, "file", mirror.Connection.Transport)
	require.NotZero(t, mirror.Stream.ID)
	require.Equal(t, mirror.Connection.ID, mirror.Stream.ConnectionID)
	require.NotNil(t, mirror.Stream.DataSourceID)
	require.Equal(t, mirror.DataSource.ID, *mirror.Stream.DataSourceID)
	require.Equal(t, "bin", mirror.Stream.EntityType)
	require.Equal(t, "state", mirror.Stream.Kind)

	dsID := mirror.DataSource.ID

	// Update via mirror
	body, _ = json.Marshal(map[string]any{
		"name":            "Inventory CSV Updated",
		"kind":            "csv",
		"config":          map[string]any{"delimiter": ";"},
		"mapping":         map[string]any{"fields": map[string]string{"sku": "sku", "capacity": "cap"}},
		"schedule":        "interval",
		"intervalSeconds": 120,
	})
	req = newRequest(http.MethodPatch, fmt.Sprintf("/api/v1/data-sources/%d/with-mirror", dsID), body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	var updated handlers.DataSourceMirrorResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &updated))
	require.Equal(t, dsID, updated.DataSource.ID)
	require.Equal(t, "Inventory CSV Updated", updated.DataSource.Name)
	require.Equal(t, "Inventory CSV Updated", updated.Connection.Name)
	require.Equal(t, "Inventory CSV Updated", updated.Stream.Name)
	require.Equal(t, "interval", updated.Stream.Schedule)
	require.Equal(t, int32(120), *updated.Stream.IntervalSeconds)

	// Delete via mirror
	req = newRequest(http.MethodDelete, fmt.Sprintf("/api/v1/data-sources/%d/with-mirror", dsID), nil, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusNoContent, rr.Code)

	// Verify data source is gone
	req = newRequest(http.MethodGet, fmt.Sprintf("/api/v1/data-sources/%d", dsID), nil, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusNotFound, rr.Code)

	// Verify connection is gone
	req = newRequest(http.MethodGet, fmt.Sprintf("/api/v1/connections/%d", mirror.Connection.ID), nil, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusNotFound, rr.Code)

	// Verify stream is gone
	req = newRequest(http.MethodGet, fmt.Sprintf("/api/v1/streams/%d", mirror.Stream.ID), nil, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusNotFound, rr.Code)
}

// TestDataRunsList guards the /data/runs SQL against the import_job_status
// enum: comparing the enum column with a TEXT parameter (the status
// filter) or with a literal the enum doesn't define ('failed') is a
// runtime Postgres error that compiles fine — both broke the endpoint
// (500 on every call, so the Data page Runs tab and the Integrations
// run history never loaded).
func TestDataRunsList(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	apiKey := "test-api-key"
	router := testRouter(q, pool, s, apiKey)

	body, _ := json.Marshal(map[string]string{"name": "Runs Tenant", "color": "#333333"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/tenants", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var tenant handlers.TenantResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &tenant))

	body, _ = json.Marshal(map[string]any{
		"name": "Feed", "kind": "rest", "config": map[string]any{"url": "https://example.com"},
		"mapping": map[string]any{"fields": map[string]string{}}, "schedule": "manual",
	})
	req = newRequest(http.MethodPost, "/api/v1/data-sources/with-mirror", body, apiKey, tenant.ID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var mirror handlers.DataSourceMirrorResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &mirror))
	sourceID := mirror.DataSource.ID

	for _, st := range []string{"ok", "partial", "error"} {
		_, err := pool.Exec(ctx,
			`INSERT INTO import_jobs (tenant_id, source_id, started_at, finished_at, status, stats)
			 VALUES ($1, $2, now(), now(), $3::import_job_status, '{"rowsImported": 3}'::jsonb)`,
			tenant.ID, sourceID, st)
		require.NoError(t, err)
	}

	type runsResp struct {
		Rows          []map[string]any `json:"rows"`
		Total         int              `json:"total"`
		FilteredStats struct {
			Runs     int `json:"runs"`
			Failures int `json:"failures"`
		} `json:"filteredStats"`
	}

	// Unfiltered, per source, newest first.
	req = newRequest(http.MethodGet, fmt.Sprintf("/api/v1/data/runs?sourceId=%d&sort=createdAt&dir=desc", sourceID), nil, apiKey, tenant.ID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	var all runsResp
	require.NoError(t, extractData(rr.Body.Bytes(), &all))
	require.Len(t, all.Rows, 3)
	require.Equal(t, 3, all.FilteredStats.Runs)
	require.Equal(t, 2, all.FilteredStats.Failures)

	// Status filter (TEXT param against the enum column).
	req = newRequest(http.MethodGet, fmt.Sprintf("/api/v1/data/runs?sourceId=%d&status=partial", sourceID), nil, apiKey, tenant.ID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	var partial runsResp
	require.NoError(t, extractData(rr.Body.Bytes(), &partial))
	require.Len(t, partial.Rows, 1)
	require.Equal(t, "partial", partial.Rows[0]["status"])
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func setupTestDB(t *testing.T, ctx context.Context) (*db.Queries, *pgxpool.Pool, store.ObjectStore, func()) {
	cwd, err := os.Getwd()
	require.NoError(t, err)
	repoRoot := filepath.Join(cwd, "..", "..")
	migrationsPath := filepath.Join(repoRoot, "migrations")

	pgContainer, err := postgres.Run(ctx,
		"postgis/postgis:16-3.4",
		postgres.WithDatabase("spatial"),
		postgres.WithUsername("spatial"),
		postgres.WithPassword("spatial"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	require.NoError(t, err)

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	require.NoError(t, migrate.Up(connStr, migrationsPath))

	pool, err := db.NewPool(ctx, connStr, 5, 5, 30*time.Minute)
	require.NoError(t, err)

	tmpDir := t.TempDir()
	objectStore, err := store.New(store.Config{Type: "local", BasePath: tmpDir, BaseURL: "http://localhost/files"})
	require.NoError(t, err)

	return db.New(pool), pool, objectStore, func() {
		pool.Close()
		_ = pgContainer.Terminate(ctx)
	}
}

func testRouter(q *db.Queries, pool *pgxpool.Pool, s store.ObjectStore, apiKey string) chi.Router {
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(api.APIKeyMiddleware(apiKey))
		r.Mount("/tenants", handlers.TenantsRouter(q, s))
		r.Mount("/webhooks", handlers.WebhookEventsRouter(q, apiKey))
		r.Group(func(r chi.Router) {
			r.Use(api.TenantMiddleware(q))
			r.Mount("/zones", handlers.ZonesRouter(q, pool, s))
			r.Mount("/grids", handlers.GridsRouter(q, pool))
			r.Mount("/bins", handlers.BinsRouter(q))
			r.Mount("/polygons", handlers.PolygonsRouter(q, pool))
			r.Mount("/circles", handlers.CirclesRouter(q, pool))
			r.Mount("/lines", handlers.LinesRouter(q, pool))
			r.Mount("/markers", handlers.MarkersRouter(q))
			r.Mount("/images", handlers.ImagesRouter(q, s))
			r.Mount("/models", handlers.ModelsRouter(q))
			r.Mount("/text-labels", handlers.TextLabelsRouter(q))
			r.Mount("/attribute-definitions", handlers.AttributeDefinitionsRouter(q))
			r.Mount("/style-rules", handlers.StyleRulesRouter(q))
			r.Mount("/references", handlers.EntityReferencesRouter(q))
			r.Mount("/user-models", handlers.UserModelsRouter(q, s))
			r.Mount("/connections", handlers.ConnectionsRouter(q))
			r.Mount("/data-sources", handlers.DataSourcesRouter(q, pool))
			r.Mount("/streams", handlers.StreamsRouter(q))
			r.Mount("/import-jobs", handlers.ImportJobsRouter(q, pool))
			r.Mount("/correlation-rules", handlers.CorrelationRulesRouter(q))
			r.Mount("/alerts", handlers.AlertsRouter(q))
			r.Mount("/audit-log", handlers.AuditLogRouter(q))
			r.Mount("/data", handlers.DataScreenRouter(q, pool))
		})
		r.Mount("/settings", handlers.AppSettingsRouter(q))
	})
	return r
}
