package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/stretchr/testify/require"
)

func TestImageAndModelUploadEndpoints(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	apiKey := "test-api-key"
	router := testRouter(q, pool, s, apiKey)

	// Create tenant first so we have a scoped upload context.
	body, _ := json.Marshal(map[string]string{"name": "Upload Tenant", "color": "#000000"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/tenants", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var tenant handlers.TenantResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &tenant))

	// Upload an image.
	var b bytes.Buffer
	writer := multipart.NewWriter(&b)
	part, err := writer.CreateFormFile("file", "test.png")
	require.NoError(t, err)
	_, err = part.Write([]byte("fake-png-data"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	req = httptest.NewRequest(http.MethodPost, "/api/v1/images/upload", &b)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var uploadResp struct {
		URL           string `json:"url"`
		MimeType      string `json:"mimeType"`
		NaturalWidth  int32  `json:"naturalWidth"`
		NaturalHeight int32  `json:"naturalHeight"`
		Bytes         int64  `json:"bytes"`
	}
	require.NoError(t, extractData(rr.Body.Bytes(), &uploadResp))
	require.NotEmpty(t, uploadResp.URL)
	require.Equal(t, int64(len("fake-png-data")), uploadResp.Bytes)

	// Create an image row using the uploaded URL.
	body, _ = json.Marshal(map[string]any{
		"name":     "Uploaded Image",
		"start":    []float64{-122.0, 37.0},
		"current":  []float64{-121.9, 37.1},
		"rotation": 0,
		"imageUrl": uploadResp.URL,
		"mimeType": "image/png",
		"unit":     "m",
		"visible":  true,
	})
	req = newRequest(http.MethodPost, "/api/v1/images", body, apiKey, tenant.ID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var image handlers.ImageResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &image))
	require.Equal(t, uploadResp.URL, image.ImageUrl)

	// Upload a model.
	b.Reset()
	writer = multipart.NewWriter(&b)
	part, err = writer.CreateFormFile("file", "test.glb")
	require.NoError(t, err)
	_, err = part.Write([]byte("fake-glb-data"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	req = httptest.NewRequest(http.MethodPost, "/api/v1/user-models/upload", &b)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenant.ID))
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var modelUploadResp struct {
		URL      string `json:"url"`
		MimeType string `json:"mimeType"`
		Bytes    int64  `json:"bytes"`
	}
	require.NoError(t, extractData(rr.Body.Bytes(), &modelUploadResp))
	require.NotEmpty(t, modelUploadResp.URL)

	body, _ = json.Marshal(map[string]any{
		"name":     "Uploaded Model",
		"mimeType": "model/gltf-binary",
		"modelUrl": modelUploadResp.URL,
		"bytes":    modelUploadResp.Bytes,
	})
	req = newRequest(http.MethodPost, "/api/v1/user-models", body, apiKey, tenant.ID)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var um handlers.UserModelResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &um))
	require.Equal(t, modelUploadResp.URL, um.ModelUrl)
}
