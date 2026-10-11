package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// TestUploadLibrary guards the editor's reuse pickers: uploads belong to a
// workspace and remember their facility, the library never shows another
// workspace's files, deleting the last shape keeps the file reusable, and
// identical model uploads collapse into one entry.
func TestUploadLibrary(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	var userID, mine, theirs, zoneA, zoneB, theirZone int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash) VALUES ('editor@example.com', 'x') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO tenants (name, color) VALUES ('Mine', '#111111') RETURNING id`).Scan(&mine))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO tenants (name, color) VALUES ('Theirs', '#222222') RETURNING id`).Scan(&theirs))
	// An editor, not an admin: the picker must work for people who edit layouts.
	_, err := pool.Exec(ctx, `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, 'editor')`, userID, mine)
	require.NoError(t, err)
	for _, z := range []struct {
		tenant int64
		name   string
		out    *int64
	}{{mine, "Warehouse A", &zoneA}, {mine, "Warehouse B", &zoneB}, {theirs, "Their site", &theirZone}} {
		require.NoError(t, pool.QueryRow(ctx,
			`INSERT INTO zones (tenant_id, name, color, center) VALUES ($1, $2, '#333333', ST_SetSRID(ST_MakePoint(0, 0), 4326)) RETURNING id`,
			z.tenant, z.name).Scan(z.out))
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(api.WithUser(req.Context(), userID, "editor@example.com")))
		})
	})
	r.Use(api.TenantMiddleware(q))
	r.Mount("/images", handlers.ImagesRouter(q, s))
	r.Mount("/user-models", handlers.UserModelsRouter(q, s))
	r.Mount("/library", handlers.LibraryRouter(q, s))
	do := func(req *http.Request) *httptest.ResponseRecorder {
		req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", mine))
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		return rr
	}
	upload := func(path, name string, data []byte, zoneID int64) string {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		part, err := mw.CreateFormFile("file", name)
		require.NoError(t, err)
		_, err = part.Write(data)
		require.NoError(t, err)
		require.NoError(t, mw.WriteField("zoneId", fmt.Sprintf("%d", zoneID)))
		require.NoError(t, mw.Close())
		req := httptest.NewRequest(http.MethodPost, path, &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		rr := do(req)
		require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
		var out struct {
			URL string `json:"url"`
		}
		require.NoError(t, extractData(rr.Body.Bytes(), &out))
		return out.URL
	}
	pngOf := func(w, h int) []byte {
		var buf bytes.Buffer
		require.NoError(t, png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))))
		return buf.Bytes()
	}

	// Two floor plans uploaded in A; one uploaded with someone else's zone id.
	planURL := upload("/images/upload", "plan.png", pngOf(8, 6), zoneA)
	spareURL := upload("/images/upload", "spare.png", pngOf(5, 5), zoneA)
	sneakyURL := upload("/images/upload", "sneaky.png", pngOf(3, 3), theirZone)
	// Re-uploading the same bytes from B keeps the first facility.
	require.Equal(t, planURL, upload("/images/upload", "plan.png", pngOf(8, 6), zoneB))

	// Their workspace has an image too — must never appear in ours.
	require.NoError(t, s.Put(ctx, "theirs.png", "image/png", pngOf(2, 2)))
	_, err = pool.Exec(ctx, `INSERT INTO tenant_files (tenant_id, object_key, content_type) VALUES ($1, 'theirs.png', 'image/png')`, theirs)
	require.NoError(t, err)

	// The plan is used as a floor plan in A and an image plane in B.
	var imageID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO images (tenant_id, name, start_lng, start_lat, current_lng, current_lat, mime_type, natural_width, natural_height, zone_id, image_url, config, unit)
		VALUES ($1, 'Plan', 0, 0, 1, 1, 'image/png', 8, 6, $2, $3, '{}', 'm') RETURNING id`, mine, zoneA, planURL).Scan(&imageID))
	_, err = pool.Exec(ctx, `INSERT INTO image_planes (tenant_id, name, lng, lat, image_url, mime_type, natural_width, natural_height, zone_id, config, unit)
		VALUES ($1, 'Plane', 0, 0, $2, 'image/png', 8, 6, $3, '{}', 'm')`, mine, planURL, zoneB)
	require.NoError(t, err)

	type libImage struct {
		Key            string `json:"key"`
		URL            string `json:"url"`
		NaturalWidth   int    `json:"naturalWidth"`
		UploadedZoneID *int64 `json:"uploadedZoneId"`
		Uses           []struct {
			ZoneID *int64 `json:"zoneId"`
			Kind   string `json:"kind"`
			Count  int    `json:"count"`
		} `json:"uses"`
	}
	listImages := func() map[string]libImage {
		rr := do(httptest.NewRequest(http.MethodGet, "/library/images", nil))
		require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
		var rows []libImage
		require.NoError(t, extractData(rr.Body.Bytes(), &rows))
		out := map[string]libImage{}
		for _, row := range rows {
			out[row.URL] = row
		}
		return out
	}
	lib := listImages()
	require.Len(t, lib, 3, "plan, spare, sneaky — never theirs.png")
	require.NotContains(t, lib, "/files/theirs.png")
	require.Equal(t, zoneA, *lib[planURL].UploadedZoneID)
	require.Nil(t, lib[sneakyURL].UploadedZoneID, "a zone from another workspace is not recorded")
	require.Equal(t, 8, lib[planURL].NaturalWidth)
	uses := map[string]int64{}
	for _, u := range lib[planURL].Uses {
		uses[u.Kind] = *u.ZoneID
	}
	require.Equal(t, map[string]int64{"floorplan": zoneA, "plane": zoneB}, uses)
	require.Empty(t, lib[spareURL].Uses)

	// Deleting the floor plan keeps the file: it's still in the library and in storage.
	rr := do(httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/images/%d", imageID), nil))
	require.Equal(t, http.StatusNoContent, rr.Code, rr.Body.String())
	_, err = pool.Exec(ctx, `DELETE FROM image_planes WHERE tenant_id = $1`, mine)
	require.NoError(t, err)
	planKey := strings.TrimPrefix(planURL, "/files/")
	_, err = s.Get(ctx, planKey)
	require.NoError(t, err, "an owned upload outlives its last shape")
	require.Contains(t, listImages(), planURL)

	// Models: the same bytes uploaded twice → one library entry with both ids.
	glb := []byte("glTF-fake-model")
	modelURL := upload("/user-models/upload", "forklift.glb", glb, zoneA)
	createModel := func(name string) int64 {
		body, _ := json.Marshal(map[string]any{
			"name": name, "mimeType": "model/gltf-binary", "modelUrl": modelURL, "bytes": len(glb),
			"zoneId": zoneA, "thumbnail": "data:image/webp;base64,AAAA",
		})
		rr := do(httptest.NewRequest(http.MethodPost, "/user-models", bytes.NewReader(body)))
		require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
		var out struct {
			ID     int64  `json:"id"`
			ZoneID *int64 `json:"zoneId"`
		}
		require.NoError(t, extractData(rr.Body.Bytes(), &out))
		require.Equal(t, zoneA, *out.ZoneID)
		return out.ID
	}
	first, second := createModel("Forklift"), createModel("Forklift again")
	_, err = pool.Exec(ctx, `INSERT INTO models (tenant_id, name, lng, lat, zone_id, config, unit) VALUES ($1, 'f', 0, 0, $2, $3, 'm')`,
		mine, zoneB, fmt.Sprintf(`{"modelAssetId":"user_%d"}`, second))
	require.NoError(t, err)

	rr = do(httptest.NewRequest(http.MethodGet, "/library/models", nil))
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	var models []struct {
		ID             int64   `json:"id"`
		IDs            []int64 `json:"ids"`
		Thumbnail      string  `json:"thumbnail"`
		UploadedZoneID *int64  `json:"uploadedZoneId"`
		Uses           []struct {
			ZoneID *int64 `json:"zoneId"`
			Count  int    `json:"count"`
		} `json:"uses"`
	}
	require.NoError(t, extractData(rr.Body.Bytes(), &models))
	require.Len(t, models, 1)
	require.Equal(t, first, models[0].ID)
	require.Equal(t, []int64{first, second}, models[0].IDs)
	require.Equal(t, "data:image/webp;base64,AAAA", models[0].Thumbnail)
	require.Equal(t, zoneA, *models[0].UploadedZoneID)
	require.Len(t, models[0].Uses, 1)
	require.Equal(t, zoneB, *models[0].Uses[0].ZoneID)

	// Removing the model from the library (both rows) removes the file.
	rr = do(httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/user-models/%d", first), nil))
	require.Equal(t, http.StatusNoContent, rr.Code, rr.Body.String())
	modelKey := strings.TrimPrefix(modelURL, "/files/")
	_, err = s.Get(ctx, modelKey)
	require.NoError(t, err, "another catalog row still uses the file")
	rr = do(httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/user-models/%d?force=true", second), nil))
	require.Equal(t, http.StatusNoContent, rr.Code, rr.Body.String())
	_, err = s.Get(ctx, modelKey)
	require.Error(t, err, "last catalog row gone → ownership dropped → object deleted")
}
