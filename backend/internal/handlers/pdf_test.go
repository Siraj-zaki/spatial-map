package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/Siraj-zaki/spatial-map/backend/internal/pdfconv"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
)

// The PDF routes touch no database, so they can be exercised over a real
// HTTP round trip with just an object store.

func buildPDFFixture(widthPts, heightPts float64, pages int) []byte {
	var buf bytes.Buffer
	offsets := make([]int, 0, pages+3)

	buf.WriteString("%PDF-1.7\n")
	obj := func(body string) int {
		offsets = append(offsets, buf.Len())
		id := len(offsets)
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", id, body)
		return id
	}

	kids := make([]string, 0, pages)
	for i := range pages {
		kids = append(kids, fmt.Sprintf("%d 0 R", 3+i*2))
	}

	obj("<< /Type /Catalog /Pages 2 0 R >>")
	obj(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pages))
	for i := range pages {
		content := fmt.Sprintf("3 w 0 0 0 RG 0 0 m %.2f %.2f l S", widthPts, heightPts)
		pageObj := 3 + i*2
		contentObj := pageObj + 1
		obj(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Contents %d 0 R /Resources << >> >>",
			widthPts, heightPts, contentObj))
		obj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))
	}

	xrefPos := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, off := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xrefPos)
	return buf.Bytes()
}

func newPDFTestServer(t *testing.T) (*httptest.Server, store.ObjectStore) {
	t.Helper()
	renderer, err := pdfconv.New(pdfconv.Config{MaxWorkers: 1, IdleWorkers: 1})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, renderer.Close()) })

	objectStore, err := store.NewLocalStore(t.TempDir(), "/files")
	require.NoError(t, err)

	srv := httptest.NewServer(PDFRouter(renderer, nil, objectStore))
	t.Cleanup(srv.Close)
	return srv, objectStore
}

func pdfMultipart(t *testing.T, data []byte, filename string, fields map[string]string) (string, *bytes.Buffer) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", filename)
	require.NoError(t, err)
	_, err = part.Write(data)
	require.NoError(t, err)
	for k, v := range fields {
		require.NoError(t, mw.WriteField(k, v))
	}
	require.NoError(t, mw.Close())
	return mw.FormDataContentType(), &body
}

func TestInspectPDFEndpoint(t *testing.T) {
	srv, _ := newPDFTestServer(t)
	// ARCH D landscape, three sheets.
	ct, body := pdfMultipart(t, buildPDFFixture(36*72, 24*72, 3), "site-plan.pdf", nil)

	resp, err := http.Post(srv.URL+"/inspect", ct, body)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var env struct {
		Data struct {
			PageCount     int  `json:"pageCount"`
			HasThumbnails bool `json:"hasThumbnails"`
			SuggestedDPI  int  `json:"suggestedDpi"`
			Pages         []struct {
				Index                int     `json:"index"`
				Sheet                string  `json:"sheet"`
				WidthMM              float64 `json:"widthMm"`
				Orientation          string  `json:"orientation"`
				Thumbnail            string  `json:"thumbnail"`
				SuggestedWidthMeters float64 `json:"suggestedWidthMeters"`
			} `json:"pages"`
			SuggestedScales []struct {
				Label       string  `json:"label"`
				Denominator float64 `json:"denominator"`
			} `json:"suggestedScales"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&env))

	require.Equal(t, 3, env.Data.PageCount)
	require.Len(t, env.Data.Pages, 3)
	require.True(t, env.Data.HasThumbnails)
	require.NotEmpty(t, env.Data.SuggestedScales)
	require.Greater(t, env.Data.SuggestedDPI, 0)

	for i, p := range env.Data.Pages {
		require.Equal(t, i, p.Index)
		require.Equal(t, "ARCH D", p.Sheet)
		require.Equal(t, "landscape", p.Orientation)
		require.InDelta(t, 914.4, p.WidthMM, 0.5)

		// Thumbnails must be inline data URLs, never stored objects.
		require.True(t, strings.HasPrefix(p.Thumbnail, "data:image/png;base64,"))
		raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(p.Thumbnail, "data:image/png;base64,"))
		require.NoError(t, err)
		_, err = png.Decode(bytes.NewReader(raw))
		require.NoError(t, err, "thumbnail must be a decodable png")

		// A plausible building, not a 900 m one.
		require.Greater(t, p.SuggestedWidthMeters, 5.0)
		require.Less(t, p.SuggestedWidthMeters, 500.0)
	}
}

func TestRenderPDFEndpointStoresPageAndMirrorsUploadEnvelope(t *testing.T) {
	srv, objectStore := newPDFTestServer(t)
	ct, body := pdfMultipart(t, buildPDFFixture(36*72, 24*72, 3), "site-plan.pdf",
		map[string]string{"page": "1", "dpi": "150"})

	resp, err := http.Post(srv.URL+"/render", ct, body)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	var env struct {
		Data struct {
			URL           string `json:"url"`
			MimeType      string `json:"mimeType"`
			NaturalWidth  int    `json:"naturalWidth"`
			NaturalHeight int    `json:"naturalHeight"`
			Bytes         int64  `json:"bytes"`
			RequestedDPI  int    `json:"requestedDpi"`
			EffectiveDPI  int    `json:"effectiveDpi"`
			Page          struct {
				Index int    `json:"index"`
				Sheet string `json:"sheet"`
			} `json:"page"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&env))

	// The envelope has to match POST /images/upload field-for-field or
	// the SPA needs a second code path to consume it.
	require.Equal(t, "image/png", env.Data.MimeType)
	require.Greater(t, env.Data.NaturalWidth, 0)
	require.Greater(t, env.Data.NaturalHeight, 0)
	require.Greater(t, env.Data.Bytes, int64(0))
	require.True(t, strings.HasPrefix(env.Data.URL, "/files/"), "url must be relative, got %q", env.Data.URL)

	require.Equal(t, 1, env.Data.Page.Index)
	require.Equal(t, "ARCH D", env.Data.Page.Sheet)
	require.Equal(t, 150, env.Data.RequestedDPI)
	// 150 DPI on a 36in sheet is 5400px — above the 4096 texture cap, so
	// it must have been clamped down and reported honestly.
	require.Less(t, env.Data.EffectiveDPI, 150)
	require.LessOrEqual(t, env.Data.NaturalWidth, 4096)

	// The rendered page really landed in the store and is a valid PNG.
	obj, err := objectStore.Get(t.Context(), store.KeyFromURL(env.Data.URL))
	require.NoError(t, err)
	img, err := png.Decode(bytes.NewReader(obj.Data))
	require.NoError(t, err)
	require.Equal(t, env.Data.NaturalWidth, img.Bounds().Dx())
	require.Equal(t, env.Data.NaturalHeight, img.Bounds().Dy())
}

func TestRenderPDFEndpointRejectsBadPage(t *testing.T) {
	srv, _ := newPDFTestServer(t)
	ct, body := pdfMultipart(t, buildPDFFixture(612, 792, 1), "one.pdf", map[string]string{"page": "9"})

	resp, err := http.Post(srv.URL+"/render", ct, body)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestInspectPDFEndpointRejectsNonPDF(t *testing.T) {
	srv, _ := newPDFTestServer(t)
	ct, body := pdfMultipart(t, []byte("definitely not a pdf"), "notes.txt", nil)

	resp, err := http.Post(srv.URL+"/inspect", ct, body)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// A nil renderer means PDFium failed at boot. The routes must still
// answer, and must say so rather than 404.
func TestPDFRouterReportsUnavailableWithoutRenderer(t *testing.T) {
	objectStore, err := store.NewLocalStore(t.TempDir(), "/files")
	require.NoError(t, err)
	srv := httptest.NewServer(PDFRouter(nil, nil, objectStore))
	defer srv.Close()

	ct, body := pdfMultipart(t, buildPDFFixture(612, 792, 1), "x.pdf", nil)
	resp, err := http.Post(srv.URL+"/inspect", ct, body)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
}
