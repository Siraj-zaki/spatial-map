package pdfconv

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

// buildTestPDF emits a minimal but structurally valid single-page PDF
// with the given MediaBox, so renderer tests need no fixture files and
// can assert on an exactly-known page geometry.
//
// The xref offsets are computed as the objects are written — PDFium will
// repair a broken xref, and a test that silently exercised the repair
// path instead of the normal one would be measuring the wrong thing.
func buildTestPDF(widthPts, heightPts float64) []byte {
	var buf bytes.Buffer
	offsets := make([]int, 0, 5)

	buf.WriteString("%PDF-1.7\n")
	obj := func(body string) {
		offsets = append(offsets, buf.Len())
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", len(offsets), body)
	}

	// A diagonal stroke plus a filled square give the rasterizer real
	// content, so a blank-page regression can't pass the pixel assertions.
	content := fmt.Sprintf("2 w 0 0 0 RG 0 0 m %.2f %.2f l S 0 0 0 rg 10 10 %.2f %.2f re f",
		widthPts, heightPts, widthPts/4, heightPts/4)

	obj("<< /Type /Catalog /Pages 2 0 R >>")
	obj("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
	obj(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Contents 4 0 R /Resources << >> >>", widthPts, heightPts))
	obj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))

	xrefPos := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, off := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xrefPos)
	return buf.Bytes()
}

// archDLandscape is 36 × 24 inches, the sheet most floor plans arrive on.
const (
	archDWidthPts  = 36 * 72
	archDHeightPts = 24 * 72
)

func newTestRenderer(t *testing.T) *Renderer {
	t.Helper()
	r, err := New(Config{MaxWorkers: 1, IdleWorkers: 1})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, r.Close()) })
	return r
}

func TestInspectReportsSheetGeometry(t *testing.T) {
	r := newTestRenderer(t)
	info, err := r.Inspect(context.Background(), buildTestPDF(archDWidthPts, archDHeightPts), "")
	require.NoError(t, err)

	require.Equal(t, 1, info.PageCount)
	require.Len(t, info.Pages, 1)

	p := info.Pages[0]
	require.InDelta(t, float64(archDWidthPts), p.WidthPoints, 0.5)
	require.InDelta(t, float64(archDHeightPts), p.HeightPoints, 0.5)
	// 36 in × 25.4 = 914.4 mm
	require.InDelta(t, 914.4, p.WidthMM, 0.5)
	require.InDelta(t, 609.6, p.HeightMM, 0.5)
	require.Equal(t, "ARCH D", p.Sheet)
	require.Equal(t, "landscape", p.Orientation)
}

func TestRenderPageProducesDecodablePNG(t *testing.T) {
	r := newTestRenderer(t)
	res, err := r.RenderPage(context.Background(), buildTestPDF(archDWidthPts, archDHeightPts), RenderRequest{Page: 0, DPI: 100})
	require.NoError(t, err)

	require.Equal(t, 100, res.EffectiveDPI, "100 DPI on ARCH D is 3600px, inside the 4096 cap")
	require.Equal(t, 3600, res.Width)
	require.Equal(t, 2400, res.Height)

	img, err := png.Decode(bytes.NewReader(res.PNG))
	require.NoError(t, err)
	require.Equal(t, res.Width, img.Bounds().Dx())
	require.Equal(t, res.Height, img.Bounds().Dy())
}

// The texture cap is the constraint that actually bites in production:
// asking for print resolution on a large sheet must quietly degrade to
// something WebGL can upload, and must report that it did so.
func TestRenderClampsDPIToTextureLimit(t *testing.T) {
	r := newTestRenderer(t)
	res, err := r.RenderPage(context.Background(), buildTestPDF(archDWidthPts, archDHeightPts), RenderRequest{Page: 0, DPI: 300})
	require.NoError(t, err)

	require.Equal(t, 300, res.RequestedDPI)
	require.Less(t, res.EffectiveDPI, 300, "300 DPI would be 10800px wide")
	require.LessOrEqual(t, res.Width, 4096)
	require.LessOrEqual(t, res.Height, 4096)
	require.LessOrEqual(t, res.Width*res.Height, 4096*4096)
}

func TestRenderRejectsOutOfRangePage(t *testing.T) {
	r := newTestRenderer(t)
	_, err := r.RenderPage(context.Background(), buildTestPDF(612, 792), RenderRequest{Page: 7, DPI: 96})
	require.ErrorIs(t, err, ErrPageOutOfRange)
}

func TestInspectRejectsNonPDF(t *testing.T) {
	r := newTestRenderer(t)
	_, err := r.Inspect(context.Background(), []byte("this is plainly not a pdf"), "")
	require.ErrorIs(t, err, ErrNotAPDF)
}

func TestInspectRejectsOversizedUpload(t *testing.T) {
	r, err := New(Config{MaxWorkers: 1, Limits: Limits{MaxBytes: 512}})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, r.Close()) })

	_, err = r.Inspect(context.Background(), make([]byte, 1024), "")
	require.ErrorIs(t, err, ErrTooLarge)
}

func TestMatchSheet(t *testing.T) {
	require.Equal(t, "A1", MatchSheet(594, 841))
	require.Equal(t, "A1", MatchSheet(841, 594), "orientation must not matter")
	require.Equal(t, "ARCH D", MatchSheet(914.4, 609.6))
	require.Equal(t, "ANSI D", MatchSheet(558.8, 863.6))
	require.Equal(t, "A1", MatchSheet(594.8, 840.3), "real exports miss nominal by a fraction")
	require.Equal(t, "", MatchSheet(1000, 1000))
}

func TestRealWorldSize(t *testing.T) {
	// ARCH D landscape at 1/8" = 1'-0" (1:96).
	// 914.4 mm ÷ 1000 × 96 = 87.78 m
	page := newPageInfo(0, archDWidthPts, archDHeightPts)
	w, h := RealWorldSize(page, 96)
	require.InDelta(t, 87.78, w, 0.01)
	require.InDelta(t, 58.52, h, 0.01)
}

func TestScaleForRealWorldWidthRoundTrips(t *testing.T) {
	page := newPageInfo(0, archDWidthPts, archDHeightPts)
	w, _ := RealWorldSize(page, 96)
	require.InDelta(t, 96, ScaleForRealWorldWidth(page, w), 0.001)
}

// A 1:100 plan on ARCH D is a 91 m building; 1:1000 would be 914 m and
// 1:20 would be 18 m. The ranking should put the believable ones first.
func TestSuggestScalesPrefersPlausibleFootprints(t *testing.T) {
	page := newPageInfo(0, archDWidthPts, archDHeightPts)
	got := SuggestScales(page, "metric")
	require.NotEmpty(t, got)

	for _, s := range got[:3] {
		w, _ := RealWorldSize(page, s.Denominator)
		require.Greater(t, w, 5.0)
		require.Less(t, w, 500.0)
	}

	last := got[len(got)-1]
	w, _ := RealWorldSize(page, last.Denominator)
	require.True(t, w < 5 || w > 500, "implausible scales sort last, got %.1fm", w)
}

func TestSuggestDPIFillsTheTextureBudget(t *testing.T) {
	limits := DefaultLimits()
	dpi := SuggestDPI(archDWidthPts, archDHeightPts, limits)

	longestPx := float64(archDWidthPts) / 72 * float64(dpi)
	require.LessOrEqual(t, longestPx, float64(limits.MaxDimension))
	// Should land close to the cap rather than leaving resolution unused.
	require.Greater(t, longestPx, float64(limits.MaxDimension)*0.95)
}

func TestSuggestDPIHandlesDegeneratePage(t *testing.T) {
	require.Equal(t, 150, SuggestDPI(0, 0, DefaultLimits()))
}

func TestClampDPIRespectsPixelBudgetOnExtremeAspect(t *testing.T) {
	r := newTestRenderer(t)
	// A very long, thin page: the dimension cap binds long before area.
	dpi := r.clampDPI(600, 20000, 200)
	require.LessOrEqual(t, math.Round(20000/72*float64(dpi)), 4096.0)
	require.GreaterOrEqual(t, dpi, 1)
}
