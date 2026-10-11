package cad_test

// What a raster has to get right.
//
// Two of these tests exist because the rasterizer's failure modes are
// invisible in a thumbnail. A winding mistake does not produce a wrong
// picture, it produces a correct picture with white pinholes wherever two
// strokes cross — and a floor plan is mostly crossings, so the drawing
// still reads as a drawing. And a texture over the GPU's cap does not
// warn, it silently fails to draw on the devices that have that cap,
// which is a bug nobody sees until a user on other hardware reports a
// blank map.
//
// So both are asserted on pixels and on numbers rather than looked at.

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
	"github.com/Siraj-zaki/spatial-map/backend/internal/cad/dwg"
)

// sheet is a rendered raster that can be sampled in the drawing's own
// coordinates, which is the only way to write an assertion about a
// specific piece of geometry.
type sheet struct {
	cad.Raster
	img        image.Image
	min        cad.Vec3
	mx, my     float64
	pixelsPerM float64
}

func render(t *testing.T, paths []cad.Path, opts cad.RasterOptions) sheet {
	t.Helper()
	r, err := cad.Rasterize(paths, opts)
	if err != nil {
		t.Fatalf("Rasterize: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(r.PNG))
	if err != nil {
		t.Fatalf("decode the PNG we just wrote: %v", err)
	}
	box := cad.PathBounds(paths)
	size := box.Size()
	return sheet{
		Raster:     r,
		img:        img,
		min:        box.Min,
		mx:         (float64(r.Width) - size.X*r.PixelsPerMeter) / 2,
		my:         (float64(r.Height) - size.Y*r.PixelsPerMeter) / 2,
		pixelsPerM: r.PixelsPerMeter,
	}
}

// inked reports whether the pixel covering a point in the drawing is
// substantially ink. Anti-aliasing means a partly covered pixel is a
// blend, so this asks "dark", not "the ink colour".
func (s sheet) inked(x, y float64) bool {
	px := int(s.mx + (x-s.min.X)*s.pixelsPerM)
	py := int(float64(s.Height) - s.my - (y-s.min.Y)*s.pixelsPerM)
	r, _, _, _ := s.img.At(px, py).RGBA()
	return r>>8 < 0x80
}

// Two strokes crossing must stay solid where they meet. The rasterizer
// sums signed area, so contours of opposite handedness cancel — and the
// two strokes here run in opposite directions on purpose, which is what a
// wall and the wall it tees into look like in a real drawing.
func TestRasterizeKeepsCrossingsSolid(t *testing.T) {
	s := render(t, []cad.Path{
		{Points: []float64{0, 5, 10, 5}},
		{Points: []float64{5, 10, 5, 0}},
	}, cad.RasterOptions{})

	if !s.inked(5, 5) {
		t.Error("the junction of two crossing strokes is not ink — windings cancelled")
	}
	if !s.inked(2, 5) || !s.inked(5, 8) {
		t.Error("a stroke is missing away from the junction")
	}
	if s.inked(2, 8) {
		t.Error("empty paper is inked")
	}
}

// A SOLID's winding comes from the file, so both handednesses arrive and
// both have to fill.
func TestRasterizeFillsEitherWinding(t *testing.T) {
	for _, tc := range []struct {
		name   string
		points []float64
	}{
		{"anticlockwise", []float64{0, 0, 10, 0, 10, 10, 0, 10}},
		{"clockwise", []float64{0, 0, 0, 10, 10, 10, 10, 0}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := render(t, []cad.Path{{Points: tc.points, Filled: true, Closed: true}}, cad.RasterOptions{})
			if !s.inked(5, 5) {
				t.Error("the middle of a filled quad is paper")
			}
		})
	}
}

// A lone Point is a dot, not nothing.
func TestRasterizeDrawsASinglePoint(t *testing.T) {
	s := render(t, []cad.Path{
		{Points: []float64{0, 0}},
		{Points: []float64{10, 10}},
	}, cad.RasterOptions{})
	if !s.inked(0, 0) || !s.inked(10, 10) {
		t.Error("a Point rendered as nothing")
	}
}

// The caps are the GPU's, and exceeding either produces a texture some
// devices refuse without saying so. A square drawing must also *reach*
// the edge cap: resolution left unspent is resolution the building does
// not get.
func TestRasterizeFitsTheTextureBudget(t *testing.T) {
	const maxEdge, maxPixels = 4096, 4096 * 4096

	for _, tc := range []struct{ w, h float64 }{
		{100, 100},  // square: the edge cap binds on both sides
		{500, 10},   // a site plan: the edge cap binds on one
		{120, 90},   // an ordinary sheet
		{0.5, 0.02}, // a detail, small enough that ppm is enormous
	} {
		s := render(t, []cad.Path{{Points: []float64{0, 0, tc.w, 0, tc.w, tc.h, 0, tc.h}, Closed: true}}, cad.RasterOptions{})
		if s.Width > maxEdge || s.Height > maxEdge {
			t.Errorf("%.0f×%.0f m rendered %d×%d px, over the %d px edge cap", tc.w, tc.h, s.Width, s.Height, maxEdge)
		}
		if s.Width*s.Height > maxPixels {
			t.Errorf("%.0f×%.0f m rendered %d px, over the %d px area cap", tc.w, tc.h, s.Width*s.Height, maxPixels)
		}
		if longest := max(s.Width, s.Height); longest != maxEdge {
			t.Errorf("%.0f×%.0f m rendered %d px on its long edge, leaving %d unspent", tc.w, tc.h, longest, maxEdge-longest)
		}
	}

	// The area cap has to bind on its own, or a 1:1 drawing at a raised
	// MaxEdge would pass every check above and still be unuploadable.
	s := render(t, []cad.Path{{Points: []float64{0, 0, 100, 0, 100, 100, 0, 100}, Closed: true}},
		cad.RasterOptions{MaxPixels: 1000 * 1000})
	if s.Width*s.Height > 1000*1000 {
		t.Errorf("MaxPixels ignored: %d×%d = %d px", s.Width, s.Height, s.Width*s.Height)
	}
}

// The caller places the image by its corner and stretches it to the
// reported size, so that size has to describe the box the pixels cover —
// margin included. Reporting the geometry's extent instead lands every
// import fractionally small, which reads as a bad drawing rather than a
// bad number.
func TestRasterizeFootprintDescribesThePixels(t *testing.T) {
	const w, h = 120, 90
	s := render(t, []cad.Path{{Points: []float64{0, 0, w, 0, w, h, 0, h}, Closed: true}}, cad.RasterOptions{})

	if got := s.WidthMeters * s.PixelsPerMeter; math.Abs(got-float64(s.Width)) > 0.5 {
		t.Errorf("WidthMeters × PixelsPerMeter = %.2f, want the %d px rendered", got, s.Width)
	}
	if got := s.HeightMeters * s.PixelsPerMeter; math.Abs(got-float64(s.Height)) > 0.5 {
		t.Errorf("HeightMeters × PixelsPerMeter = %.2f, want the %d px rendered", got, s.Height)
	}
	// Bigger than the geometry, by a margin measured in a few pixels.
	if s.WidthMeters <= w || s.WidthMeters-w > 10/s.PixelsPerMeter {
		t.Errorf("footprint %.4f m for %d m of geometry: margin is wrong", s.WidthMeters, w)
	}
	if s.HeightMeters <= h || s.HeightMeters-h > 10/s.PixelsPerMeter {
		t.Errorf("footprint %.4f m for %d m of geometry: margin is wrong", s.HeightMeters, h)
	}
}

// Nothing to draw is a refusal, not a blank sheet at an invented scale: a
// caller that placed one would be putting an empty image on the map at a
// size it made up.
func TestRasterizeRefusesADrawingWithNoExtent(t *testing.T) {
	for _, tc := range []struct {
		name  string
		paths []cad.Path
	}{
		{"no paths", nil},
		{"no points", []cad.Path{{}}},
		{"every point at one coordinate", []cad.Path{{Points: []float64{7, 3, 7, 3, 7, 3}}}},
	} {
		if _, err := cad.Rasterize(tc.paths, cad.RasterOptions{}); !errors.Is(err, cad.ErrNothingToDraw) {
			t.Errorf("%s: err = %v, want ErrNothingToDraw", tc.name, err)
		}
	}
}

// The corpus, rendered. The assertions here are the ones that hold for
// any drawing; the PNGs are written out because the thing this package
// produces is a picture and the only real check on a picture is looking
// at it.
//
//	DWG_FIXTURES=/path/to/dwgs go test ./internal/cad/ -run Raster -v
func TestRasterizeTheCorpus(t *testing.T) {
	out := filepath.Join(os.TempDir(), "cad-raster")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}

	for _, path := range dwgFixtures(t) {
		name := filepath.Base(path)
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			doc, err := dwg.Read(data)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			flat, err := doc.Flatten(cad.DefaultFlattenOptions())
			if err != nil && !errors.Is(err, cad.ErrTooManyEntities) {
				t.Fatalf("flatten: %v", err)
			}

			entities, detached := cad.TrimOutliers(flat.Entities)
			box := cad.Bounds(entities)
			_, mpu, _ := cad.ResolveUnits(doc.Header, box.Size())

			paths, err := cad.Paths(entities, cad.PathOptions{MetersPerUnit: mpu, Origin: box.Min})
			if err != nil && !errors.Is(err, cad.ErrTooManyPoints) {
				t.Fatalf("paths: %v", err)
			}

			r, err := cad.Rasterize(paths, cad.RasterOptions{})
			if err != nil {
				t.Fatalf("rasterize: %v", err)
			}
			if longest := max(r.Width, r.Height); longest != 4096 {
				t.Errorf("long edge %d px, want the full 4096 budget", longest)
			}
			if r.WidthMeters <= 0 || r.HeightMeters <= 0 {
				t.Errorf("footprint %.2f × %.2f m", r.WidthMeters, r.HeightMeters)
			}

			dst := filepath.Join(out, name+".png")
			if err := os.WriteFile(dst, r.PNG, 0o644); err != nil {
				t.Fatal(err)
			}
			t.Logf("%d entities (-%d detached), %d paths → %d×%d px, %.2f × %.2f m, %.1f px/m, %d KB → %s",
				len(entities), detached, len(paths), r.Width, r.Height,
				r.WidthMeters, r.HeightMeters, r.PixelsPerMeter, len(r.PNG)/1024, dst)
		})
	}
}

// dwgFixtures lists the corpus, or skips. The drawings are real customer
// files and are deliberately not in the repository, so a checkout without
// them still runs a green suite — the price is that the tests keyed on
// them prove nothing until someone points DWG_FIXTURES at a directory.
func dwgFixtures(t *testing.T) []string {
	t.Helper()
	dir := os.Getenv("DWG_FIXTURES")
	if dir == "" {
		t.Skip("set DWG_FIXTURES to a directory of .dwg files to run this")
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*.dwg"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatalf("no .dwg files in %s", dir)
	}
	return paths
}
