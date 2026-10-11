package handlers

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/pdfconv"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
)

// PDF floor-plan import.
//
// Two endpoints, both multipart, and the source PDF is deliberately
// never persisted:
//
//	POST /api/v1/pdf/inspect  → page inventory + thumbnails + scale hints
//	POST /api/v1/pdf/render   → one page rasterized into the object store
//
// Storing the uploaded PDF would create a file with no DB row pointing
// at it, which cmd/cleanup-orphans would correctly reclaim out from
// under us. The browser already holds the File object, so re-sending it
// for the render step costs upload bandwidth and nothing else. Only the
// rendered PNG is stored, and it lands on an image row exactly like a
// direct upload — so the existing refcount/cleanup path needs no
// changes at all.

// pdfMemoryBudget is how much of a multipart upload is buffered in RAM
// before net/http spills the remainder to a temp file. Drawing PDFs are
// routinely tens of megabytes, so spilling is the expected path.
const pdfMemoryBudget = 16 << 20

// thumbnailDPI renders page previews just large enough to recognise a
// floor plan by shape. Users pick a sheet by looking at it; a page
// number alone is unusable in a 40-sheet drawing set.
const thumbnailDPI = 24

// maxThumbnailPages bounds the work an inspect call can trigger. Beyond
// this the picker falls back to a plain page-number entry.
const maxThumbnailPages = 24

type pdfPageResponse struct {
	pdfconv.PageInfo
	// Thumbnail is a self-contained data URL, not a stored object —
	// previews are throwaway and must not enter the object store.
	Thumbnail string `json:"thumbnail,omitempty"`
	// SuggestedWidthMeters is the real-world width this page would cover
	// at the top-ranked plot scale. It seeds the placement UI so the
	// first thing the user sees is approximately correct.
	SuggestedWidthMeters float64 `json:"suggestedWidthMeters,omitempty"`
}

type pdfInspectResponse struct {
	PageCount        int                 `json:"pageCount"`
	Pages            []pdfPageResponse   `json:"pages"`
	SuggestedScales  []pdfconv.PlotScale `json:"suggestedScales"`
	SuggestedDPI     int                 `json:"suggestedDpi"`
	MaxDimensionPx   int                 `json:"maxDimensionPx"`
	HasThumbnails    bool                `json:"hasThumbnails"`
	ThumbnailPageCap int                 `json:"thumbnailPageCap"`
}

// writePDFError maps the package's sentinel errors onto status codes the
// SPA can branch on. Everything unrecognised is a genuine 500.
func writePDFError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, pdfconv.ErrPasswordRequired):
		// 422 rather than 401: the request authenticated fine, it's the
		// document that needs a secret.
		api.Error(w, http.StatusUnprocessableEntity, "pdf is password protected")
	case errors.Is(err, pdfconv.ErrNotAPDF):
		api.BadRequest(w, "file is not a readable pdf")
	case errors.Is(err, pdfconv.ErrTooLarge):
		api.Error(w, http.StatusRequestEntityTooLarge, "pdf exceeds the maximum allowed size")
	case errors.Is(err, pdfconv.ErrTooManyPages):
		api.BadRequest(w, "pdf has too many pages")
	case errors.Is(err, pdfconv.ErrPageOutOfRange):
		api.BadRequest(w, "requested page does not exist in this pdf")
	default:
		api.InternalError(w, r, err)
	}
}

// readPDFUpload pulls the PDF bytes and optional password off a
// multipart request.
func readPDFUpload(r *http.Request) (data []byte, filename, password string, err error) {
	if err := r.ParseMultipartForm(pdfMemoryBudget); err != nil {
		return nil, "", "", fmt.Errorf("parse multipart: %w", err)
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, "", "", fmt.Errorf("missing file: %w", err)
	}
	defer file.Close()

	data, err = store.ReadAll(file)
	if err != nil {
		return nil, "", "", err
	}
	return data, header.Filename, r.FormValue("password"), nil
}

func inspectPDF(renderer *pdfconv.Renderer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, _, password, err := readPDFUpload(r)
		if err != nil {
			api.BadRequest(w, "invalid pdf upload")
			return
		}

		info, err := renderer.Inspect(r.Context(), data, password)
		if err != nil {
			writePDFError(w, r, err)
			return
		}

		limits := renderer.Limits()
		resp := pdfInspectResponse{
			PageCount:        info.PageCount,
			Pages:            make([]pdfPageResponse, 0, len(info.Pages)),
			MaxDimensionPx:   limits.MaxDimension,
			ThumbnailPageCap: maxThumbnailPages,
			HasThumbnails:    info.PageCount <= maxThumbnailPages,
		}
		if len(info.Pages) > 0 {
			resp.SuggestedScales = pdfconv.SuggestScales(info.Pages[0], "")
			resp.SuggestedDPI = pdfconv.SuggestDPI(info.Pages[0].WidthPoints, info.Pages[0].HeightPoints, limits)
		}

		for _, page := range info.Pages {
			out := pdfPageResponse{PageInfo: page}
			if scales := pdfconv.SuggestScales(page, ""); len(scales) > 0 {
				out.SuggestedWidthMeters, _ = pdfconv.RealWorldSize(page, scales[0].Denominator)
			}
			if resp.HasThumbnails {
				// A thumbnail failure must not fail the whole inspect —
				// a page that won't preview can still be rendered, and
				// the picker degrades to a page number.
				thumb, err := renderer.RenderPage(r.Context(), data, pdfconv.RenderRequest{
					Page: page.Index, DPI: thumbnailDPI, Password: password,
				})
				if err == nil {
					out.Thumbnail = pngDataURL(thumb.PNG)
				}
			}
			resp.Pages = append(resp.Pages, out)
		}

		api.JSON(w, http.StatusOK, resp)
	}
}

func renderPDFPage(renderer *pdfconv.Renderer, q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, filename, password, err := readPDFUpload(r)
		if err != nil {
			api.BadRequest(w, "invalid pdf upload")
			return
		}

		page, err := strconv.Atoi(r.FormValue("page"))
		if err != nil || page < 0 {
			api.BadRequest(w, "page must be a non-negative integer")
			return
		}
		// An absent or unparseable dpi means "pick the best that fits",
		// which pdfconv resolves from the page geometry.
		dpi, _ := strconv.Atoi(r.FormValue("dpi"))

		result, err := renderer.RenderPage(r.Context(), data, pdfconv.RenderRequest{
			Page: page, DPI: dpi, Password: password,
		})
		if err != nil {
			writePDFError(w, r, err)
			return
		}

		key := store.KeyFromData(pdfPageFilename(filename, page), result.PNG)
		if err := s.Put(r.Context(), key, "image/png", result.PNG); err != nil {
			api.InternalError(w, r, err)
			return
		}
		recordTenantFile(r, q, key, "image/png", len(result.PNG))

		// The first six fields mirror POST /images/upload exactly, so the
		// SPA can feed this straight into the existing placement draft
		// without a second code path.
		api.JSON(w, http.StatusCreated, map[string]any{
			"url":           store.NormalizeAssetURL(s.URL(key)),
			"mimeType":      "image/png",
			"naturalWidth":  result.Width,
			"naturalHeight": result.Height,
			"bytes":         int64(len(result.PNG)),
			"page":          result.Page,
			"requestedDpi":  result.RequestedDPI,
			// Frequently lower than requested — large sheets hit the GPU
			// texture cap. The UI surfaces this so a user who asked for
			// 300 DPI isn't misled about the detail they received.
			"effectiveDpi": result.EffectiveDPI,
		})
	}
}

// pdfPageFilename gives the rendered page a name that still identifies
// its origin once it is sitting in the object store.
func pdfPageFilename(original string, page int) string {
	base := original
	if base == "" {
		base = "document.pdf"
	}
	if ext := len(base) - 4; ext > 0 && (base[ext:] == ".pdf" || base[ext:] == ".PDF") {
		base = base[:ext]
	}
	return fmt.Sprintf("%s-p%d.png", base, page+1)
}

func pngDataURL(png []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
}

// PDFRouter exposes the floor-plan PDF import endpoints.
//
// A nil renderer means PDFium failed to initialise at boot. The rest of
// the API still serves — PDF import is one feature, not a reason to
// refuse every request — so the routes stay mounted and answer 503.
// Returning 404 instead would be indistinguishable from a client typo.
func PDFRouter(renderer *pdfconv.Renderer, q *db.Queries, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	if renderer == nil {
		r.HandleFunc("/*", func(w http.ResponseWriter, _ *http.Request) {
			api.Error(w, http.StatusServiceUnavailable, "pdf conversion is unavailable on this server")
		})
		return r
	}
	r.Post("/inspect", inspectPDF(renderer))
	r.Post("/render", renderPDFPage(renderer, q, s))
	return r
}
