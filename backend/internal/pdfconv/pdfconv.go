// Package pdfconv turns PDF floor plans into raster images the map
// editor can place, plus the sheet metadata needed to place them at a
// true real-world size.
//
// PDFium (via go-pdfium's wazero/WASM build) supplies exactly one thing:
// the page render primitive. Everything that decides what a floor plan
// import should *do* lives here — resolution policy, GPU texture limits,
// drawing-sheet recognition and plot-scale maths.
//
// The WASM build is deliberate. It keeps the dependency BSD/MIT (MuPDF,
// PyMuPDF and Ghostscript are all AGPL and unusable in a commercial
// product), it needs no CGO so `go build` stays a single static binary,
// and every document is parsed inside a wazero sandbox with no
// filesystem and no network. PDF parsers are a well-known RCE surface
// and uploads here are attacker-controlled, so that isolation is load
// bearing, not incidental.
package pdfconv

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/png"
	"math"
	"time"

	"github.com/klippa-app/go-pdfium"
	pdferrors "github.com/klippa-app/go-pdfium/errors"
	"github.com/klippa-app/go-pdfium/references"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/webassembly"
)

// Errors callers are expected to branch on. Everything else is a 500.
var (
	// ErrPasswordRequired means the file is encrypted and the supplied
	// password (possibly empty) didn't open it.
	ErrPasswordRequired = errors.New("pdf is password protected")
	// ErrNotAPDF means the bytes aren't a PDF at all, or are damaged
	// beyond PDFium's fairly generous repair tolerance.
	ErrNotAPDF = errors.New("file is not a readable pdf")
	// ErrTooLarge means the upload exceeded the configured byte cap.
	ErrTooLarge = errors.New("pdf exceeds the maximum allowed size")
	// ErrTooManyPages means the document exceeded the configured page cap.
	ErrTooManyPages = errors.New("pdf has too many pages")
	// ErrPageOutOfRange means the requested page index doesn't exist.
	ErrPageOutOfRange = errors.New("page index out of range")
)

// pointsPerInch is fixed by the PDF spec: one point is 1/72 inch.
const pointsPerInch = 72.0

// Limits are the guardrails applied to every document. They exist
// because a PDF is a program, not a picture: a 40 KB file can describe a
// page that costs gigabytes to rasterize.
type Limits struct {
	// MaxBytes rejects oversized uploads before PDFium ever sees them.
	MaxBytes int64
	// MaxPages rejects documents with an implausible page count. A floor
	// plan set is tens of sheets; tens of thousands means either an abuse
	// attempt or the wrong file.
	MaxPages int
	// MaxDimension caps the longest edge of a rendered page in pixels.
	//
	// This is a GPU limit, not a memory one. The rendered PNG becomes a
	// Mapbox `image` source, which is uploaded as a single WebGL texture.
	// MAX_TEXTURE_SIZE is 4096 on a meaningful share of the devices we
	// support, and exceeding it doesn't warn — the raster silently fails
	// to draw or is downsampled to mush. 4096 is the largest value that
	// renders everywhere.
	MaxDimension int
	// MaxPixels caps total rendered pixels (width × height), bounding
	// peak memory independently of aspect ratio. A 4096-long edge on a
	// pathological 1:50 aspect page would otherwise still be fine on
	// MaxDimension but huge in total.
	MaxPixels int
	// MinDPI / MaxDPI bound the requested resolution before the
	// dimension and pixel caps are applied.
	MinDPI, MaxDPI int
	// RenderTimeout bounds a single page render. PDFium can spend
	// unbounded time on adversarial content streams.
	RenderTimeout time.Duration
}

// DefaultLimits are tuned for architectural drawing sheets: large pages,
// few of them, line art that needs resolution more than it needs colour.
func DefaultLimits() Limits {
	return Limits{
		MaxBytes:      256 << 20, // 256 MB
		MaxPages:      2000,
		MaxDimension:  4096,
		MaxPixels:     4096 * 4096,
		MinDPI:        36,
		MaxDPI:        600,
		RenderTimeout: 90 * time.Second,
	}
}

// Config configures the renderer's worker pool.
type Config struct {
	// MaxWorkers is the number of PDFs that can be processed
	// concurrently. Each worker is a separate WASM instance with its own
	// linear memory, so this multiplies peak memory. Defaults to 2.
	MaxWorkers int
	// IdleWorkers are kept warm to avoid paying instantiation cost on
	// every upload. Defaults to 1.
	IdleWorkers int
	// AcquireTimeout bounds how long a request waits for a free worker
	// when all are busy. Defaults to 30s.
	AcquireTimeout time.Duration
	// Limits overrides DefaultLimits when non-zero fields are set.
	Limits Limits
}

// Renderer owns the PDFium WASM pool. It is safe for concurrent use and
// should be created once at startup — Init compiles a 5 MB WASM module,
// which is far too expensive to do per request.
type Renderer struct {
	pool           pdfium.Pool
	acquireTimeout time.Duration
	limits         Limits
}

// New builds a Renderer. The caller must Close it at shutdown.
func New(cfg Config) (*Renderer, error) {
	if cfg.MaxWorkers <= 0 {
		cfg.MaxWorkers = 2
	}
	if cfg.IdleWorkers < 0 || cfg.IdleWorkers > cfg.MaxWorkers {
		cfg.IdleWorkers = 1
	}
	if cfg.AcquireTimeout <= 0 {
		cfg.AcquireTimeout = 30 * time.Second
	}
	limits := cfg.Limits
	def := DefaultLimits()
	if limits.MaxBytes <= 0 {
		limits.MaxBytes = def.MaxBytes
	}
	if limits.MaxPages <= 0 {
		limits.MaxPages = def.MaxPages
	}
	if limits.MaxDimension <= 0 {
		limits.MaxDimension = def.MaxDimension
	}
	if limits.MaxPixels <= 0 {
		limits.MaxPixels = def.MaxPixels
	}
	if limits.MinDPI <= 0 {
		limits.MinDPI = def.MinDPI
	}
	if limits.MaxDPI <= 0 {
		limits.MaxDPI = def.MaxDPI
	}
	if limits.RenderTimeout <= 0 {
		limits.RenderTimeout = def.RenderTimeout
	}

	// No FSConfig is passed, so the sandbox gets no filesystem at all.
	pool, err := webassembly.Init(webassembly.Config{
		MinIdle:  0,
		MaxIdle:  cfg.IdleWorkers,
		MaxTotal: cfg.MaxWorkers,
	})
	if err != nil {
		return nil, fmt.Errorf("pdfconv: init pdfium: %w", err)
	}
	return &Renderer{pool: pool, acquireTimeout: cfg.AcquireTimeout, limits: limits}, nil
}

// Close releases the WASM pool.
func (r *Renderer) Close() error {
	if r == nil || r.pool == nil {
		return nil
	}
	return r.pool.Close()
}

// Limits exposes the active guardrails so handlers can report them.
func (r *Renderer) Limits() Limits { return r.limits }

// PageInfo describes one page's physical geometry.
//
// Sizes are reported in PDF points because that is the only
// dimensionally honest unit a PDF carries — a page is a physical sheet
// of paper, and points map to inches by a fixed constant. Pixels depend
// on render DPI and mean nothing on their own.
type PageInfo struct {
	Index        int     `json:"index"`
	WidthPoints  float64 `json:"widthPoints"`
	HeightPoints float64 `json:"heightPoints"`
	WidthMM      float64 `json:"widthMm"`
	HeightMM     float64 `json:"heightMm"`
	// Sheet is the recognised drawing sheet size ("ARCH D", "A1", …) or
	// empty when the page matches no standard. Knowing the sheet lets the
	// UI suggest the plot scales that are actually plausible for it.
	Sheet string `json:"sheet,omitempty"`
	// Orientation is "portrait", "landscape" or "square".
	Orientation string `json:"orientation"`
}

// DocumentInfo is the result of inspecting an uploaded PDF.
type DocumentInfo struct {
	PageCount int        `json:"pageCount"`
	Pages     []PageInfo `json:"pages"`
}

// Inspect reads page geometry without rasterizing anything. It is cheap
// enough to run synchronously on upload, which is what lets the UI show
// a page picker before committing to an expensive render.
func (r *Renderer) Inspect(ctx context.Context, data []byte, password string) (DocumentInfo, error) {
	if int64(len(data)) > r.limits.MaxBytes {
		return DocumentInfo{}, ErrTooLarge
	}
	var out DocumentInfo
	err := r.withDocument(ctx, data, password, func(inst pdfium.Pdfium, doc *docHandle) error {
		if doc.pageCount > r.limits.MaxPages {
			return ErrTooManyPages
		}
		out.PageCount = doc.pageCount
		out.Pages = make([]PageInfo, 0, doc.pageCount)
		for i := 0; i < doc.pageCount; i++ {
			size, err := inst.GetPageSize(&requests.GetPageSize{
				Page: requests.Page{ByIndex: &requests.PageByIndex{Document: doc.ref, Index: i}},
			})
			if err != nil {
				return fmt.Errorf("page %d size: %w", i, err)
			}
			out.Pages = append(out.Pages, newPageInfo(i, size.Width, size.Height))
		}
		return nil
	})
	if err != nil {
		return DocumentInfo{}, err
	}
	return out, nil
}

func newPageInfo(index int, wPts, hPts float64) PageInfo {
	p := PageInfo{
		Index:        index,
		WidthPoints:  wPts,
		HeightPoints: hPts,
		WidthMM:      pointsToMM(wPts),
		HeightMM:     pointsToMM(hPts),
		Sheet:        MatchSheet(pointsToMM(wPts), pointsToMM(hPts)),
	}
	switch {
	case wPts > hPts:
		p.Orientation = "landscape"
	case hPts > wPts:
		p.Orientation = "portrait"
	default:
		p.Orientation = "square"
	}
	return p
}

// RenderRequest asks for one page as a raster image.
type RenderRequest struct {
	Page     int
	DPI      int
	Password string
}

// RenderResult carries the encoded page plus the numbers the caller
// needs to reason about what it actually got. EffectiveDPI is frequently
// lower than the requested DPI — large sheets hit the texture cap first —
// and callers must surface that rather than assume the request was
// honoured.
type RenderResult struct {
	PNG          []byte
	Width        int
	Height       int
	RequestedDPI int
	EffectiveDPI int
	Page         PageInfo
}

// RenderPage rasterizes a single page to PNG.
//
// PNG rather than JPEG is a correctness choice: floor plans are thin
// black line art on white, exactly the content JPEG's chroma subsampling
// and ringing destroy. Lossless keeps hairlines legible at the zoom
// levels users actually work at.
func (r *Renderer) RenderPage(ctx context.Context, data []byte, req RenderRequest) (RenderResult, error) {
	if int64(len(data)) > r.limits.MaxBytes {
		return RenderResult{}, ErrTooLarge
	}
	ctx, cancel := context.WithTimeout(ctx, r.limits.RenderTimeout)
	defer cancel()

	var out RenderResult
	err := r.withDocument(ctx, data, req.Password, func(inst pdfium.Pdfium, doc *docHandle) error {
		if doc.pageCount > r.limits.MaxPages {
			return ErrTooManyPages
		}
		if req.Page < 0 || req.Page >= doc.pageCount {
			return ErrPageOutOfRange
		}
		page := requests.Page{ByIndex: &requests.PageByIndex{Document: doc.ref, Index: req.Page}}
		size, err := inst.GetPageSize(&requests.GetPageSize{Page: page})
		if err != nil {
			return fmt.Errorf("page size: %w", err)
		}
		info := newPageInfo(req.Page, size.Width, size.Height)

		effectiveDPI := r.clampDPI(req.DPI, size.Width, size.Height)
		rendered, err := inst.RenderPageInDPI(&requests.RenderPageInDPI{
			Page: page,
			DPI:  effectiveDPI,
			// Form fields are widget annotations, not drawing content.
			// Rendering them would stamp interactive-field chrome onto a
			// floor plan, so they stay off.
			RenderForm: false,
		})
		if err != nil {
			return fmt.Errorf("render page %d: %w", req.Page, err)
		}
		// Mandatory on the WASM runtime: the image is backed by memory
		// inside the sandbox that is only reclaimed here.
		defer rendered.Cleanup()

		if rendered.Result.Image == nil {
			return fmt.Errorf("render page %d: empty image", req.Page)
		}

		var buf bytes.Buffer
		enc := png.Encoder{CompressionLevel: png.BestSpeed}
		if err := enc.Encode(&buf, rendered.Result.Image); err != nil {
			return fmt.Errorf("encode png: %w", err)
		}

		out = RenderResult{
			PNG:          buf.Bytes(),
			Width:        rendered.Result.Width,
			Height:       rendered.Result.Height,
			RequestedDPI: req.DPI,
			EffectiveDPI: effectiveDPI,
			Page:         info,
		}
		return nil
	})
	if err != nil {
		return RenderResult{}, err
	}
	return out, nil
}

// clampDPI lowers the requested DPI until the rendered page fits both
// the texture-dimension cap and the total-pixel cap. Downscaling the
// resolution is the right failure mode: a legible whole sheet beats a
// sharp fragment, and the caller is told what it actually got.
func (r *Renderer) clampDPI(requested int, wPts, hPts float64) int {
	dpi := requested
	if dpi <= 0 {
		dpi = SuggestDPI(wPts, hPts, r.limits)
	}
	if dpi < r.limits.MinDPI {
		dpi = r.limits.MinDPI
	}
	if dpi > r.limits.MaxDPI {
		dpi = r.limits.MaxDPI
	}
	if wPts <= 0 || hPts <= 0 {
		return dpi
	}

	longestPts := math.Max(wPts, hPts)
	// pixels = points / 72 * dpi  ⇒  dpi = pixels * 72 / points
	if byDimension := int(math.Floor(float64(r.limits.MaxDimension) * pointsPerInch / longestPts)); byDimension < dpi {
		dpi = byDimension
	}
	// pixels = (w/72*dpi) * (h/72*dpi)  ⇒  dpi = sqrt(pixels * 72² / (w*h))
	if byArea := int(math.Floor(math.Sqrt(float64(r.limits.MaxPixels) * pointsPerInch * pointsPerInch / (wPts * hPts)))); byArea < dpi {
		dpi = byArea
	}
	if dpi < 1 {
		dpi = 1
	}
	return dpi
}

// SuggestDPI picks the highest resolution that still fits the caps, so
// the default import is as sharp as the device can display.
func SuggestDPI(wPts, hPts float64, limits Limits) int {
	if wPts <= 0 || hPts <= 0 {
		return 150
	}
	byDimension := float64(limits.MaxDimension) * pointsPerInch / math.Max(wPts, hPts)
	byArea := math.Sqrt(float64(limits.MaxPixels) * pointsPerInch * pointsPerInch / (wPts * hPts))
	dpi := int(math.Floor(math.Min(byDimension, byArea)))
	if dpi > limits.MaxDPI {
		dpi = limits.MaxDPI
	}
	if dpi < limits.MinDPI {
		dpi = limits.MinDPI
	}
	return dpi
}

// docHandle bundles an open document reference with its page count.
type docHandle struct {
	ref       references.FPDF_DOCUMENT
	pageCount int
}

// withDocument acquires a worker, opens the document, runs fn, and
// guarantees both are released. Every exported method funnels through
// here so there is exactly one place that can leak a WASM instance.
func (r *Renderer) withDocument(ctx context.Context, data []byte, password string, fn func(pdfium.Pdfium, *docHandle) error) error {
	if len(data) == 0 {
		return ErrNotAPDF
	}
	inst, err := r.pool.GetInstance(r.acquireTimeout)
	if err != nil {
		return fmt.Errorf("pdfconv: acquire worker: %w", err)
	}
	defer inst.Close()

	// Honour caller cancellation for the queueing that already happened;
	// PDFium itself is not cancellable mid-render, which is why
	// RenderTimeout exists as a separate backstop.
	if err := ctx.Err(); err != nil {
		return err
	}

	openReq := &requests.OpenDocument{File: &data}
	if password != "" {
		openReq.Password = &password
	}
	doc, err := inst.OpenDocument(openReq)
	if err != nil {
		switch {
		case errors.Is(err, pdferrors.ErrPassword), errors.Is(err, pdferrors.ErrSecurity):
			return ErrPasswordRequired
		case errors.Is(err, pdferrors.ErrFormat), errors.Is(err, pdferrors.ErrFile):
			return ErrNotAPDF
		}
		return fmt.Errorf("pdfconv: open document: %w", err)
	}
	defer inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})

	count, err := inst.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return fmt.Errorf("pdfconv: page count: %w", err)
	}
	return fn(inst, &docHandle{ref: doc.Document, pageCount: count.PageCount})
}
