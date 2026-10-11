package cad

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"

	"golang.org/x/image/vector"
)

// Drawing a plan as pixels.
//
// This is the last step of the import, not a shortcut around the rest of
// it. The reader still decodes entities, layers and real-world
// coordinates, and everything upstream depends on that: the layer filter
// is a choice about entities, and the scale comes from the drawing's own
// units. What a raster adds is a floor plan that behaves like every other
// floor plan in the app — one image on one images row, with the crop,
// transform handles, elevation and floor-plan role it already has — and
// an artifact a downstream reader can look at.
//
// Two things about the output are decided here rather than left to the
// client.
//
// The size is bounded by the GPU, not by memory. The PNG becomes a
// Mapbox `image` source and is uploaded as a single WebGL texture, and
// MAX_TEXTURE_SIZE is 4096 on a meaningful share of supported devices —
// exceeding it does not warn, the raster simply fails to draw. That cap
// is also why TrimOutliers has to run first: pixels spent on empty paper
// are pixels the building does not get, and a drawing whose extent is
// eight times its geometry renders the building at an eighth of the
// resolution it could have had.
//
// And the ink is black on white rather than the drawing's own palette. A
// CAD layer's colour is chosen to be legible against a black modelspace
// background, so a drawing full of dark blues and greys is nearly
// invisible reproduced faithfully on a white sheet — and a plotted sheet
// is monochrome anyway, which is what makes a PDF floor plan readable.
// Contrast is worth more here than fidelity, both to a person squinting
// at a map and to anything reading the image afterwards.

// ErrNothingToDraw means the paths enclose no area at all: an empty set,
// or every point at one coordinate. There is no image to make and no
// scale to place it at.
var ErrNothingToDraw = errors.New("cad: drawing has no extent to render")

const (
	// rasterMaxEdge is the longest edge of the rendered image, and it is
	// the GPU's number rather than one of ours. See the note above.
	rasterMaxEdge = 4096

	// rasterMaxPixels bounds total pixels independently of aspect ratio.
	// A 1:50 site plan satisfies rasterMaxEdge on its long side and is
	// still enormous in area.
	rasterMaxPixels = 4096 * 4096

	// rasterLineWidth is the stroke width in **pixels**, not metres.
	//
	// A CAD entity carries no width worth drawing — lineweight is usually
	// unset and means "hairline" when it is — so the width is a
	// legibility choice, and legibility is a property of the output
	// image. Held in metres instead, a 5 cm line would be a third of a
	// pixel on a site plan and invisible.
	rasterLineWidth = 1.6
)

var (
	rasterPaper = color.RGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}
	rasterInk   = color.RGBA{R: 0x1a, G: 0x1a, B: 0x1a, A: 0xff}
)

// RasterOptions tune the render. The zero value is the default for each.
type RasterOptions struct {
	// MaxEdge and MaxPixels cap the image. Raising either past the
	// defaults produces a texture some devices cannot upload.
	MaxEdge   int
	MaxPixels int

	// LineWidth is the stroke width in pixels.
	LineWidth float64
}

// Raster is a rendered drawing and the ground it covers.
type Raster struct {
	PNG           []byte
	Width, Height int

	// WidthMeters and HeightMeters are the image's own footprint, margin
	// included. The caller places the image by its corner and stretches
	// it to this size, so it has to describe the same box the pixels do —
	// the geometry's extent alone would be short by the margin and every
	// import would land fractionally small.
	WidthMeters, HeightMeters float64

	PixelsPerMeter float64
}

// Rasterize draws paths, which are already in metres, onto a white
// sheet.
//
// The frame comes from PathBounds rather than from the entities that
// produced the paths: a chord sags inside the curve it replaces and an
// entity with no drawable geometry has extents but emits no points, so
// the two boxes differ, and only the emitted one is guaranteed to hold
// every pixel that gets drawn.
func Rasterize(paths []Path, opts RasterOptions) (Raster, error) {
	if opts.MaxEdge <= 0 {
		opts.MaxEdge = rasterMaxEdge
	}
	if opts.MaxPixels <= 0 {
		opts.MaxPixels = rasterMaxPixels
	}
	if opts.LineWidth <= 0 {
		opts.LineWidth = rasterLineWidth
	}

	box := PathBounds(paths)
	size := box.Size()
	if !box.Valid || !(size.X > 0 || size.Y > 0) {
		return Raster{}, ErrNothingToDraw
	}

	// A stroke straddles the point it is drawn through, so geometry on the
	// extreme edge would lose its outer half without a margin to sit in.
	margin := int(math.Ceil(opts.LineWidth/2)) + 1
	usable := float64(opts.MaxEdge - 2*margin)

	ppm := usable / math.Max(size.X, size.Y)
	// Solved rather than iterated, the same way pdfconv resolves DPI.
	// Both margins count against the budget — the cap is on the texture,
	// and the texture includes them — so this is the positive root of
	// (Xp+2m)(Yp+2m) = MaxPixels rather than a plain square root. The
	// constant term is always negative, so that root always exists.
	if size.X > 0 && size.Y > 0 {
		a := size.X * size.Y
		b := 2 * float64(margin) * (size.X + size.Y)
		c := 4*float64(margin*margin) - float64(opts.MaxPixels)
		if area := (math.Sqrt(b*b-4*a*c) - b) / (2 * a); area < ppm {
			ppm = area
		}
	}

	w := min(int(math.Round(size.X*ppm))+2*margin, opts.MaxEdge)
	h := min(int(math.Round(size.Y*ppm))+2*margin, opts.MaxEdge)

	z := vector.NewRasterizer(w, h)
	hw := float32(opts.LineWidth / 2)
	// Reused across paths: a large plan is hundreds of thousands of
	// points, and a fresh slice per path is the whole cost of the render.
	var xs, ys []float32

	for _, p := range paths {
		n := len(p.Points) / 2
		if n == 0 {
			continue
		}
		xs, ys = xs[:0], ys[:0]
		for i := range n {
			xs = append(xs, float32(margin)+float32((p.Points[2*i]-box.Min.X)*ppm))
			ys = append(ys, float32(h-margin)-float32((p.Points[2*i+1]-box.Min.Y)*ppm))
		}

		if p.Filled && n >= 3 {
			rasterFill(z, xs, ys)
			continue
		}
		for i := 0; i+1 < n; i++ {
			rasterSegment(z, xs[i], ys[i], xs[i+1], ys[i+1], hw)
		}
		if p.Closed && n > 2 {
			rasterSegment(z, xs[n-1], ys[n-1], xs[0], ys[0], hw)
		}
		// A square at every vertex fills the wedge two segments leave on
		// the outside of a turn, and draws a lone Point as a dot.
		for i := range n {
			rasterDot(z, xs[i], ys[i], hw)
		}
	}

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), image.NewUniform(rasterPaper), image.Point{}, draw.Src)
	z.Draw(img, img.Bounds(), image.NewUniform(rasterInk), image.Point{})

	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.DefaultCompression}).Encode(&buf, img); err != nil {
		return Raster{}, err
	}
	return Raster{
		PNG:            buf.Bytes(),
		Width:          w,
		Height:         h,
		WidthMeters:    float64(w) / ppm,
		HeightMeters:   float64(h) / ppm,
		PixelsPerMeter: ppm,
	}, nil
}

// Every contour below is wound the same way on purpose. The rasterizer
// accumulates signed area and takes the magnitude, so shapes that agree
// add and clamp — while a clockwise stroke crossing an anticlockwise one
// would cancel to nothing and punch a hole at the junction. A plan is
// mostly junctions.

// rasterSegment strokes one segment as a quad. Its winding is fixed by
// construction: the quad is built in the segment's own frame, so
// reversing the segment reverses the normal with it.
func rasterSegment(z *vector.Rasterizer, x0, y0, x1, y1, hw float32) {
	dx, dy := x1-x0, y1-y0
	l := float32(math.Hypot(float64(dx), float64(dy)))
	if l == 0 {
		return
	}
	nx, ny := -dy/l*hw, dx/l*hw
	z.MoveTo(x0+nx, y0+ny)
	z.LineTo(x1+nx, y1+ny)
	z.LineTo(x1-nx, y1-ny)
	z.LineTo(x0-nx, y0-ny)
	z.ClosePath()
}

func rasterDot(z *vector.Rasterizer, x, y, hw float32) {
	z.MoveTo(x-hw, y-hw)
	z.LineTo(x-hw, y+hw)
	z.LineTo(x+hw, y+hw)
	z.LineTo(x+hw, y-hw)
	z.ClosePath()
}

// rasterFill emits a filled polygon, reversing it when needed: a SOLID's
// winding comes from the file and is the one contour here whose direction
// is not ours to choose.
func rasterFill(z *vector.Rasterizer, xs, ys []float32) {
	var twice float32
	for i := range xs {
		j := (i + 1) % len(xs)
		twice += xs[i]*ys[j] - xs[j]*ys[i]
	}
	if twice > 0 {
		z.MoveTo(xs[0], ys[0])
		for i := len(xs) - 1; i > 0; i-- {
			z.LineTo(xs[i], ys[i])
		}
	} else {
		z.MoveTo(xs[0], ys[0])
		for i := 1; i < len(xs); i++ {
			z.LineTo(xs[i], ys[i])
		}
	}
	z.ClosePath()
}
