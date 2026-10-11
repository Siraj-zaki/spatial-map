package handlers_test

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
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

// TestFilesTenantScope guards the Files screen against the shared bucket.
// Every tenant's objects live in one store under content-addressed keys,
// so "whose file is this" comes only from tenant_files (uploads) and the
// tenant's own referencing rows. Before ownership was recorded, unused
// uploads had no tenant and were listed in every workspace, and a file
// another workspace used showed up as an "orphan" here.
func TestFilesTenantScope(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}

	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	var userID, mine, theirs int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash) VALUES ('admin@example.com', 'x') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO tenants (name, color) VALUES ('Mine', '#111111') RETURNING id`).Scan(&mine))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO tenants (name, color) VALUES ('Theirs', '#222222') RETURNING id`).Scan(&theirs))
	_, err := pool.Exec(ctx, `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, userID, mine)
	require.NoError(t, err)

	// Objects: one nobody owns, one only they use, one only we use, one
	// both workspaces uploaded (same bytes → same key).
	for _, key := range []string{"nobody.glb", "theirs.glb", "mine.glb", "shared.glb"} {
		require.NoError(t, s.Put(ctx, key, "model/gltf-binary", []byte("glb-"+key)))
	}
	for _, row := range []struct {
		tenant int64
		key    string
	}{{theirs, "theirs.glb"}, {mine, "mine.glb"}} {
		_, err := pool.Exec(ctx,
			`INSERT INTO user_models (tenant_id, name, mime_type, bytes, model_url) VALUES ($1, $2, 'model/gltf-binary', 3, $3)`,
			row.tenant, row.key, "/files/"+row.key)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO tenant_files (tenant_id, object_key) VALUES ($1, 'shared.glb'), ($2, 'shared.glb')`, mine, theirs)
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(api.WithUser(req.Context(), userID, "admin@example.com")))
		})
	})
	r.Use(api.TenantMiddleware(q))
	r.Mount("/files", handlers.FilesRouter(q, s))
	r.Mount("/images", handlers.ImagesRouter(q, s))

	do := func(req *http.Request) *httptest.ResponseRecorder {
		req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", mine))
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		return rr
	}
	type listResp struct {
		Rows []struct {
			Key      string `json:"key"`
			Category string `json:"category"`
			Type     string `json:"type"`
		} `json:"rows"`
		Total        int            `json:"total"`
		StatusCounts map[string]int `json:"statusCounts"`
		Stats        struct {
			Files   int `json:"files"`
			Cleanup int `json:"cleanup"`
		} `json:"stats"`
	}
	list := func(query string) listResp {
		rr := do(httptest.NewRequest(http.MethodGet, "/files"+query, nil))
		require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
		var out listResp
		require.NoError(t, extractData(rr.Body.Bytes(), &out))
		return out
	}
	keysOf := func(l listResp) []string {
		out := []string{}
		for _, row := range l.Rows {
			out = append(out, row.Key)
		}
		sort.Strings(out)
		return out
	}

	// An upload through the real endpoint is recorded as ours.
	var pngBuf bytes.Buffer
	require.NoError(t, png.Encode(&pngBuf, image.NewRGBA(image.Rect(0, 0, 4, 3))))
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", "upload.png")
	require.NoError(t, err)
	_, err = part.Write(pngBuf.Bytes())
	require.NoError(t, err)
	require.NoError(t, mw.Close())
	req := httptest.NewRequest(http.MethodPost, "/images/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := do(req)
	require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
	var uploaded struct {
		URL string `json:"url"`
	}
	require.NoError(t, extractData(rr.Body.Bytes(), &uploaded))
	uploadKey := uploaded.URL[len("/files/"):]

	want := []string{"mine.glb", "shared.glb", uploadKey}
	sort.Strings(want)
	all := list("")
	require.Equal(t, want, keysOf(all), "only files we uploaded or reference — never theirs.glb or the owner-less nobody.glb")
	require.Equal(t, 3, all.Stats.Files)
	require.Equal(t, 3, all.Stats.Cleanup) // ghost catalog model + two unused uploads

	// Server-side paging and filtering.
	page2 := list("?pageSize=2&page=2&sort=name")
	require.Equal(t, 3, page2.Total)
	require.Len(t, page2.Rows, 1)
	byOffset := list("?pageSize=2&offset=1&sort=name")
	require.Len(t, byOffset.Rows, 2)
	require.Equal(t, page2.Rows[0].Key, byOffset.Rows[1].Key)
	images := list("?type=image")
	require.Equal(t, []string{uploadKey}, keysOf(images))
	require.Equal(t, 1, images.StatusCounts["all"])

	// Not ours → 404, and the object is untouched.
	for _, key := range []string{"theirs.glb", "nobody.glb"} {
		rr = do(httptest.NewRequest(http.MethodDelete, "/files/"+key, nil))
		require.Equal(t, http.StatusNotFound, rr.Code, key)
		_, err = s.Get(ctx, key)
		require.NoError(t, err, key)
	}

	// Shared upload: leaves our list, stays in storage for them.
	rr = do(httptest.NewRequest(http.MethodDelete, "/files/shared.glb", nil))
	require.Equal(t, http.StatusNoContent, rr.Code, rr.Body.String())
	_, err = s.Get(ctx, "shared.glb")
	require.NoError(t, err)
	require.NotContains(t, keysOf(list("")), "shared.glb")

	// Our own unused upload is physically removed.
	rr = do(httptest.NewRequest(http.MethodDelete, "/files/"+uploadKey, nil))
	require.Equal(t, http.StatusNoContent, rr.Code, rr.Body.String())
	_, err = s.Get(ctx, uploadKey)
	require.Error(t, err)
}
