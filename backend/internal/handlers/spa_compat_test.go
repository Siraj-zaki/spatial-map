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

	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/stretchr/testify/require"
)

// TestSPAPayloadCompatibility sends SPA-style camelCase JSON payloads to every
// major catalog endpoint and verifies the round-trip responses expose the same
// camelCase field names and value shapes the SPA expects from Dexie.
func TestSPAPayloadCompatibility(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	apiKey := "test-api-key"
	router := testRouter(q, pool, s, apiKey)

	// Tenant
	body, _ := json.Marshal(map[string]string{"name": "SPA Tenant", "color": "#000000"})
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

	// Zone with center array
	body, _ = json.Marshal(map[string]any{
		"name":        "Zone A",
		"color":       "#ff0000",
		"description": "",
		"center":      []float64{-122.4194, 37.7749},
	})
	req = newRequest(http.MethodPost, "/api/v1/zones", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var zone handlers.ZoneResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &zone))
	require.NotNil(t, zone.Center)
	require.InDelta(t, -122.4194, zone.Center[0], 0.0001)
	require.InDelta(t, 37.7749, zone.Center[1], 0.0001)
	require.Equal(t, tenantID, zone.TenantID)

	// Grid with start/current arrays
	body, _ = json.Marshal(map[string]any{
		"name":    "Grid A",
		"start":   []float64{-122.0, 37.0},
		"current": []float64{-122.0, 37.0},
		"config":  map[string]any{"rows": 5, "cols": 5},
	})
	req = newRequest(http.MethodPost, "/api/v1/grids", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var grid handlers.GridResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &grid))
	require.Len(t, grid.Start, 2)
	require.InDelta(t, -122.0, grid.Start[0], 0.0001)
	require.InDelta(t, 37.0, grid.Start[1], 0.0001)
	require.Len(t, grid.Current, 2)

	// Polygon with vertices array
	body, _ = json.Marshal(map[string]any{
		"name":     "Building A",
		"vertices": []any{[]float64{-122.0, 37.0}, []float64{-121.9, 37.0}, []float64{-121.9, 37.1}},
		"rotation": 0,
		"unit":     "m",
		"visible":  true,
	})
	req = newRequest(http.MethodPost, "/api/v1/polygons", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var polygon handlers.PolygonResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &polygon))
	require.NotZero(t, polygon.ID)
	require.NotNil(t, polygon.Vertices)

	// Circle with center/start/current arrays
	body, _ = json.Marshal(map[string]any{
		"name":     "Circle A",
		"mode":     "single",
		"center":   []float64{-122.1, 37.1},
		"radius":   100.0,
		"rotation": 0,
		"unit":     "m",
		"visible":  true,
	})
	req = newRequest(http.MethodPost, "/api/v1/circles", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var circle handlers.CircleResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &circle))
	require.NotNil(t, circle.Center)
	require.InDelta(t, -122.1, circle.Center[0], 0.0001)
	require.InDelta(t, 37.1, circle.Center[1], 0.0001)
	require.NotNil(t, circle.Radius)
	require.InDelta(t, 100.0, *circle.Radius, 0.0001)

	// Line with vertices array
	body, _ = json.Marshal(map[string]any{
		"name":     "Line A",
		"vertices": []any{[]float64{-122.0, 37.0}, []float64{-121.9, 37.0}},
		"rotation": 0,
		"unit":     "m",
		"visible":  true,
	})
	req = newRequest(http.MethodPost, "/api/v1/lines", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var line handlers.LineResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &line))
	require.NotNil(t, line.Vertices)

	// Marker with position array
	body, _ = json.Marshal(map[string]any{
		"name":     "Marker A",
		"position": []float64{-122.2, 37.2},
		"bearing":  90,
		"config":   map[string]any{},
		"unit":     "m",
		"visible":  true,
	})
	req = newRequest(http.MethodPost, "/api/v1/markers", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var marker handlers.MarkerResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &marker))
	require.Len(t, marker.Position, 2)
	require.InDelta(t, -122.2, marker.Position[0], 0.0001)
	require.InDelta(t, 37.2, marker.Position[1], 0.0001)

	// Model with position array
	body, _ = json.Marshal(map[string]any{
		"name":     "Model A",
		"position": []float64{-122.3, 37.3},
		"config":   map[string]any{},
		"unit":     "m",
		"visible":  true,
	})
	req = newRequest(http.MethodPost, "/api/v1/models", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var model handlers.ModelResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &model))
	require.Len(t, model.Position, 2)
	require.InDelta(t, -122.3, model.Position[0], 0.0001)

	// Text label with position array
	body, _ = json.Marshal(map[string]any{
		"name":     "Label A",
		"position": []float64{-122.4, 37.4},
		"rotation": 30,
		"config":   map[string]any{"text": "Hello"},
		"unit":     "m",
		"visible":  true,
	})
	req = newRequest(http.MethodPost, "/api/v1/text-labels", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var label handlers.TextLabelResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &label))
	require.Len(t, label.Position, 2)
	require.InDelta(t, 30, label.Rotation, 0.0001)

	// Image with start/current arrays and inline imageData
	body, _ = json.Marshal(map[string]any{
		"name":          "Image A",
		"start":         []float64{-122.0, 37.0},
		"current":       []float64{-121.9, 37.1},
		"rotation":      15,
		"imageData":     "data:image/png;base64,iVBORw0KGgo=",
		"mimeType":      "image/png",
		"naturalWidth":  100,
		"naturalHeight": 100,
		"unit":          "m",
		"visible":       true,
	})
	req = newRequest(http.MethodPost, "/api/v1/images", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var image handlers.ImageResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &image))
	require.Equal(t, "data:image/png;base64,iVBORw0KGgo=", image.ImageData)
	require.Equal(t, "image/png", image.MimeType)
	require.Len(t, image.Start, 2)
	require.InDelta(t, -122.0, image.Start[0], 0.0001)
	require.InDelta(t, 37.0, image.Start[1], 0.0001)
	require.InDelta(t, 15, image.Rotation, 0.0001)

	// Bin with camelCase keys
	body, _ = json.Marshal(map[string]any{
		"targetKind": "grid-cell",
		"gridId":     grid.ID,
		"row":        1,
		"col":        2,
		"level":      0,
		"status":     "empty",
		"sku":        "SKU-SPA",
	})
	req = newRequest(http.MethodPost, "/api/v1/bins", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var bin handlers.BinResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &bin))
	require.Equal(t, "grid-cell", bin.TargetKind)
	require.NotNil(t, bin.GridID)
	require.Equal(t, grid.ID, *bin.GridID)
	require.Equal(t, "SKU-SPA", bin.Sku)

	// Attribute definition with enumValues/defaultValue
	body, _ = json.Marshal(map[string]any{
		"scope":        "marker",
		"key":          "material",
		"label":        "Material",
		"type":         "enum",
		"unit":         "",
		"enumValues":   []string{"steel", "plastic"},
		"defaultValue": json.RawMessage(`"steel"`),
		"description":  "Material type",
	})
	req = newRequest(http.MethodPost, "/api/v1/attribute-definitions", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var attr handlers.AttributeDefinitionResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &attr))
	require.Equal(t, "marker", attr.Scope)
	require.Equal(t, "material", attr.Key)
	require.Equal(t, []string{"steel", "plastic"}, attr.EnumValues)
	require.Equal(t, tenantID, attr.TenantID)

	// Style rule with zoneId
	body, _ = json.Marshal(map[string]any{
		"name":       "Rule A",
		"scope":      "marker",
		"zoneId":     zone.ID,
		"enabled":    true,
		"priority":   1,
		"combine":    "and",
		"conditions": map[string]any{},
		"style":      map[string]any{"color": "#ff0000"},
	})
	req = newRequest(http.MethodPost, "/api/v1/style-rules", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var rule handlers.StyleRuleResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &rule))
	require.Equal(t, "Rule A", rule.Name)
	require.NotNil(t, rule.ZoneID)
	require.Equal(t, zone.ID, *rule.ZoneID)

	// Connection
	body, _ = json.Marshal(map[string]any{
		"name":      "Conn A",
		"transport": "rest",
		"auth":      map[string]any{},
		"config":    map[string]any{},
	})
	req = newRequest(http.MethodPost, "/api/v1/connections", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var conn handlers.ConnectionResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &conn))
	require.Equal(t, "Conn A", conn.Name)
	require.Equal(t, tenantID, conn.TenantID)

	// Data source with intervalSeconds
	body, _ = json.Marshal(map[string]any{
		"name":            "DS A",
		"kind":            "csv",
		"config":          map[string]any{},
		"mapping":         map[string]any{},
		"schedule":        "manual",
		"intervalSeconds": 60,
	})
	req = newRequest(http.MethodPost, "/api/v1/data-sources", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var ds handlers.DataSourceResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &ds))
	require.Equal(t, "DS A", ds.Name)
	require.NotNil(t, ds.IntervalSeconds)
	require.Equal(t, int32(60), *ds.IntervalSeconds)

	// Stream with connectionId/dataSourceId/entityType/intervalSeconds
	body, _ = json.Marshal(map[string]any{
		"connectionId":    conn.ID,
		"dataSourceId":    ds.ID,
		"name":            "Stream A",
		"entityType":      "asset",
		"kind":            "event",
		"binding":         map[string]any{},
		"endpoint":        map[string]any{},
		"schedule":        "manual",
		"intervalSeconds": 30,
	})
	req = newRequest(http.MethodPost, "/api/v1/streams", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var stream handlers.StreamResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &stream))
	require.Equal(t, conn.ID, stream.ConnectionID)
	require.NotNil(t, stream.DataSourceID)
	require.Equal(t, ds.ID, *stream.DataSourceID)
	require.Equal(t, "asset", stream.EntityType)

	// Import job with sourceId/startedAt/errorReport
	body, _ = json.Marshal(map[string]any{
		"sourceId":    ds.ID,
		"startedAt":   "2026-06-17T00:00:00Z",
		"status":      "running",
		"stats":       map[string]any{},
		"errorReport": "",
	})
	req = newRequest(http.MethodPost, "/api/v1/import-jobs", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var job handlers.ImportJobResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &job))
	require.Equal(t, ds.ID, job.SourceID)
	require.Equal(t, "running", job.Status)

	// Entity reference with sourceKey/targetKey/sourceStreamId
	body, _ = json.Marshal(map[string]any{
		"type":           "link",
		"sourceKey":      "sku-1",
		"targetKey":      "bin-1",
		"label":          "Link",
		"payload":        map[string]any{},
		"sourceStreamId": stream.ID,
	})
	req = newRequest(http.MethodPost, "/api/v1/references", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var ref handlers.EntityReferenceResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &ref))
	require.Equal(t, "sku-1", ref.SourceKey)
	require.Equal(t, "bin-1", ref.TargetKey)
	require.NotNil(t, ref.SourceStreamID)
	require.Equal(t, stream.ID, *ref.SourceStreamID)

	// App setting with value/updatedAt
	body, _ = json.Marshal(map[string]any{"value": map[string]any{"theme": "dark"}})
	req = newRequest(http.MethodPut, "/api/v1/settings/theme", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	var setting handlers.AppSettingResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &setting))
	require.Equal(t, "theme", setting.Key)
	require.NotEmpty(t, setting.UpdatedAt)

	// User model with mimeType and base64 data
	body, _ = json.Marshal(map[string]any{
		"name":     "Model Upload",
		"mimeType": "model/gltf-binary",
		"data":     "Z0xURg==",
		"bytes":    4,
	})
	req = newRequest(http.MethodPost, "/api/v1/user-models", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var um handlers.UserModelResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &um))
	require.Equal(t, "Model Upload", um.Name)
	require.Equal(t, "model/gltf-binary", um.MimeType)
	require.Equal(t, "Z0xURg==", um.Data)
	require.Equal(t, int64(4), um.Bytes)

	// Correlation rule with trigger/action JSON and cooldownMs
	body, _ = json.Marshal(map[string]any{
		"name":       "Rule SPA",
		"enabled":    true,
		"trigger":    map[string]any{"kind": "sensor-reading", "op": ">", "threshold": 30},
		"action":     map[string]any{"kind": "emit-alert", "level": "warn", "messageTemplate": "hot"},
		"cooldownMs": 1000,
	})
	req = newRequest(http.MethodPost, "/api/v1/correlation-rules", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var corrRule handlers.CorrelationRuleResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &corrRule))
	require.Equal(t, "Rule SPA", corrRule.Name)
	require.Equal(t, int64(1000), corrRule.CooldownMs)
	require.Equal(t, int64(0), corrRule.FireCount)

	// Alert with ruleId, level, entityRef, ts
	body, _ = json.Marshal(map[string]any{
		"ruleId":    corrRule.ID,
		"ruleName":  "Rule SPA",
		"level":     "warn",
		"message":   "Temperature high",
		"entityRef": "TEMP-SPA",
		"ts":        "2026-06-17T00:00:00Z",
	})
	req = newRequest(http.MethodPost, "/api/v1/alerts", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var alert handlers.AlertResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &alert))
	require.Equal(t, "warn", alert.Level)
	require.Equal(t, "Temperature high", alert.Message)
	require.NotNil(t, alert.RuleID)
	require.Equal(t, corrRule.ID, *alert.RuleID)
	require.False(t, alert.Acknowledged)

	// Acknowledge alert
	req = newRequest(http.MethodPost, fmt.Sprintf("/api/v1/alerts/%d/acknowledge", alert.ID), nil, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	var ack handlers.AlertResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &ack))
	require.True(t, ack.Acknowledged)
	require.NotEmpty(t, ack.AcknowledgedAt)

	// Audit log entry
	body, _ = json.Marshal(map[string]any{
		"entityType": "bin",
		"entityKey":  "BIN-SPA",
		"url":        "https://example.com/bins/BIN-SPA",
		"method":     "PATCH",
		"before":     map[string]any{"status": "empty"},
		"after":      map[string]any{"status": "occupied"},
		"status":     "ok",
		"httpStatus": 200,
		"message":    "accepted",
	})
	req = newRequest(http.MethodPost, "/api/v1/audit-log", body, apiKey, tenantID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var entry handlers.AuditLogResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &entry))
	require.Equal(t, "bin", entry.EntityType)
	require.Equal(t, "BIN-SPA", entry.EntityKey)
	require.Equal(t, "PATCH", entry.Method)
	require.NotNil(t, entry.HTTPStatus)
	require.Equal(t, int32(200), *entry.HTTPStatus)
}

func newRequest(method, path string, body []byte, apiKey string, tenantID int64) *http.Request {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	if tenantID != 0 {
		req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
	}
	return req
}
