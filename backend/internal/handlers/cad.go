package handlers

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/cad"
	"github.com/Siraj-zaki/spatial-map/backend/internal/cad/dwg"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
)

// CAD drawing import.
//
// Two endpoints, both multipart, and the source drawing is deliberately
// never persisted — the same reasoning as PDF import in pdf.go: a stored
// file with no DB row pointing at it is indistinguishable from an orphan
// and cmd/cleanup-orphans would correctly reclaim it. The browser still
// holds the File, so the second call re-sends the bytes.
//
//	POST /api/v1/cad/inspect  → what the drawing is: units, extents, layers
//	POST /api/v1/cad/render   → the chosen layers drawn onto a stored PNG
//
// The split is not arbitrary. Inspect answers a question the user must
// settle before anything else means anything — what unit is this drawing
// in, and which layers are wanted — because $INSUNITS is unset in a
// large minority of files and getting it wrong imports the building at a
// thousandth of its size. Rendering first and asking later would mean
// re-rendering.
//
// Render is the path a floor-plan import takes, and it is a raster only
// at the very end: the reader still decodes entities, layers and
// real-world coordinates, and the layer filter and the resolved scale
// both depend on that. What the drawing gains by arriving as one image
// is every floor-plan behaviour the app already has — crop, transform
// handles, elevation, the default-floor-plan pin — for no new shape
// kind and no migration. See docs/cad-import.md.

// cadMemoryBudget is how much of the upload net/http keeps in RAM before
// spilling to a temp file. Drawings run to tens of megabytes.
const cadMemoryBudget = 16 << 20

// cadColorResponse is a colour as the file stated it, unresolved.
//
// An index is only meaningful against a palette, and every CAD viewer
// ships a different one, so the resolution is left to the client — which
// is also where the map's theme lives.
type cadColorResponse struct {
	Index int16  `json:"index"`
	RGB   string `json:"rgb,omitempty"`
}

func colorResponse(c cad.Color) cadColorResponse {
	out := cadColorResponse{Index: c.Index}
	if c.HasRGB {
		out.RGB = fmt.Sprintf("#%06x", c.RGB&0xFFFFFF)
	}
	return out
}

type cadLayerResponse struct {
	Name      string           `json:"name"`
	Color     cadColorResponse `json:"color"`
	Visible   bool             `json:"visible"`
	Locked    bool             `json:"locked"`
	Plottable bool             `json:"plottable"`
	// EntityCount is how much of the flattened drawing lands on this
	// layer. It is the number that makes a layer list usable: a plan has
	// thirty layers and the four that matter are the four with content.
	EntityCount int `json:"entityCount"`

	// Annotation marks a layer that describes the drawing rather than the
	// building — dimension runs, hatching, the title block. It is a
	// proposal, never a decision: layer naming is a standard half the
	// world follows loosely, so the guess is right often enough to save
	// the user most of the work and wrong often enough that the UI must
	// let them change it. All it decides is which boxes open unticked.
	Annotation bool `json:"annotation,omitempty"`
}

type cadPointResponse struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type cadInspectResponse struct {
	Format   string `json:"format"`
	Version  string `json:"version"`
	Release  string `json:"release"`
	Producer string `json:"producer,omitempty"`

	// Units is what the file declared, or the best guess when it declared
	// nothing. UnitsDeclared says which, and UnitsConfident says whether a
	// guess is safe to apply without asking — see cad.Confident.
	Units          cad.Units       `json:"units"`
	UnitsName      string          `json:"unitsName"`
	UnitsDeclared  bool            `json:"unitsDeclared"`
	UnitsConfident bool            `json:"unitsConfident"`
	MetersPerUnit  float64         `json:"metersPerUnit"`
	UnitGuesses    []cad.UnitGuess `json:"unitGuesses,omitempty"`

	// Width/HeightMeters are the geometry's own extents under the units
	// above — the number that tells a human at a glance whether the units
	// are right, because a floor plan is tens of metres across and
	// nothing else.
	WidthMeters  float64 `json:"widthMeters"`
	HeightMeters float64 `json:"heightMeters"`

	// Min/Max are the drawing's extents in its own units, recomputed from
	// geometry rather than read from the header. The header's copy is a
	// stale hint; HeaderMin/Max carry it anyway so a mismatch is visible.
	Min       cadPointResponse  `json:"min"`
	Max       cadPointResponse  `json:"max"`
	HeaderMin *cadPointResponse `json:"headerMin,omitempty"`
	HeaderMax *cadPointResponse `json:"headerMax,omitempty"`

	// EntityCount and Layers describe the geometry that will be drawn, so
	// they exclude anything cad.TrimOutliers found detached from the
	// drawing. DetachedEntities is how many that was — a drawing that
	// silently loses part of itself is the failure mode this whole path
	// is guarding against, so the number travels with the result.
	EntityCount      int                `json:"entityCount"`
	DetachedEntities int                `json:"detachedEntities,omitempty"`
	EntityKinds      map[string]int     `json:"entityKinds"`
	BlockCount       int                `json:"blockCount"`
	Layers           []cadLayerResponse `json:"layers"`

	// What the drawing referenced and this reader could not supply. These
	// are the answer to the only complaint a CAD import ever gets, so they
	// travel with the result rather than being logged and forgotten.
	MissingBlocks []string `json:"missingBlocks,omitempty"`
	MissingXrefs  []string `json:"missingXrefs,omitempty"`
	Truncated     bool     `json:"truncated"`
}

// writeCADError maps the reader's sentinels onto statuses the SPA can
// branch on. A malformed drawing is the client's problem, not the
// server's, so it must not become a 500 — an import that reports "server
// error" for a file the user could fix themselves sends them to support
// instead of to Save As.
func writeCADError(w http.ResponseWriter, r *http.Request, err error) {
	var unsupported *dwg.ErrUnsupportedVersion
	switch {
	case errors.Is(err, dwg.ErrNotDWG):
		api.BadRequest(w, "file is not a readable DWG drawing")
	case errors.As(err, &unsupported):
		// The user's move is Save As, so name the release rather than
		// saying "unsupported".
		api.Error(w, http.StatusUnprocessableEntity, unsupported.Error())
	case errors.Is(err, dwg.ErrNoGeometry), errors.Is(err, cad.ErrNothingToDraw):
		api.Error(w, http.StatusUnprocessableEntity, "drawing contains no drawable geometry")
	case errors.Is(err, dwg.ErrMalformed), errors.Is(err, dwg.ErrTruncated):
		api.BadRequest(w, "drawing could not be read: "+err.Error())
	// The size caps are deliberately not here: both come back as a partial
	// result with truncated set, because a drawing too big to import whole
	// is still worth importing in part.
	default:
		// Everything that reaches here still came out of the reader, so it
		// is still a statement about the file — the container layer reports
		// a missing section or a corrupt page without reaching for a
		// sentinel. Returning 500 would tell the user the server broke on a
		// file only they can see, and the message they need is the one they
		// would then not be shown. Logged at warn so an unmapped case is
		// still visible to us without being paged on.
		slog.WarnContext(r.Context(), "cad: unreadable drawing",
			"path", r.URL.Path, "error", err)
		api.Error(w, http.StatusUnprocessableEntity, "drawing could not be read: "+err.Error())
	}
}

// readDrawing turns uploaded bytes into a document.
//
// Format is chosen by content, not by the filename: an extension is a
// user's claim and a magic string is the file's own. The switch is where
// a DXF reader joins — see docs/cad-import.md — and nothing above this
// function knows which format it got.
func readDrawing(data []byte) (*cad.Document, string, error) {
	doc, err := dwg.Read(data)
	if err != nil {
		return nil, "", err
	}
	return doc, "dwg", nil
}

func readCADUpload(r *http.Request) ([]byte, string, error) {
	if err := r.ParseMultipartForm(cadMemoryBudget); err != nil {
		return nil, "", fmt.Errorf("parse multipart: %w", err)
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, "", fmt.Errorf("missing file: %w", err)
	}
	defer file.Close()
	data, err := store.ReadAll(file)
	return data, header.Filename, err
}

// parseLayerFilter reads the caller's layer selection.
//
// An absent field means the whole drawing. An empty one would mean
// nothing at all, which no caller wants and which would come back as
// ErrNoGeometry — so it is treated as absent.
func parseLayerFilter(raw string) map[string]bool {
	if raw = strings.TrimSpace(raw); raw == "" {
		return nil
	}
	keep := make(map[string]bool)
	for name := range strings.SplitSeq(raw, "\n") {
		if name = strings.TrimSpace(name); name != "" {
			keep[name] = true
		}
	}
	if len(keep) == 0 {
		return nil
	}
	return keep
}

// overrideUnits applies an explicit units field over the resolved answer.
//
// It is the user answering the question inspect asked, so it wins: the
// reason to ask was that the file's own answer was absent or not trusted.
// Writes the error response and returns false, the same shape as
// requireRole.
func overrideUnits(w http.ResponseWriter, r *http.Request, units cad.Units, mpu float64) (cad.Units, float64, bool) {
	v := r.FormValue("units")
	if v == "" {
		return units, mpu, true
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		api.BadRequest(w, "units must be an INSUNITS code")
		return units, mpu, false
	}
	chosen := cad.Units(n)
	m, ok := chosen.MetersPerUnit()
	if !ok {
		api.BadRequest(w, "units is not a scale this server can apply")
		return units, mpu, false
	}
	return chosen, m, true
}

// flattenForImport expands blocks with the drawing's own layer
// visibility honoured and an optional caller filter on top.
//
// A nil keep means the whole drawing. Materialising that from doc.Layers
// instead would quietly lose the entities on layers the table never
// declared — which layerResponses goes out of its way to preserve.
//
// Filtering here rather than after the paths are built is what makes the
// layer choice honest: the drawing's measured size comes from the
// geometry that survives, so leaving a title block unticked shrinks the
// placement box to the building instead of sizing it around a sheet
// border nobody can see.
//
// Truncation is reported rather than returned as an error: a partial
// drawing is worth showing, and the response says so. Anything else that
// goes wrong is fatal.
func flattenForImport(doc *cad.Document, keep map[string]bool) (cad.FlattenResult, error) {
	opts := cad.DefaultFlattenOptions()
	if keep != nil {
		opts.LayerFilter = func(layer string) bool {
			// An entity with no layer is on "0", which is the name the
			// caller saw in the layer list and therefore the name it sends
			// back. Normalising here is what lets either spelling match.
			if layer == "" {
				layer = "0"
			}
			return keep[layer]
		}
	}
	res, err := doc.Flatten(opts)
	if err != nil && !errors.Is(err, cad.ErrTooManyEntities) {
		return res, err
	}
	return res, nil
}

// layerResponses lists the drawing's layers with their share of the
// flattened geometry.
//
// Entities on a layer the table never declared are appended at the end
// rather than dropped. A purged layer entry is normal in the wild, and
// silently hiding its content would make a layer picker that cannot
// select part of the drawing.
func layerResponses(doc *cad.Document, entities []cad.Entity) []cadLayerResponse {
	counts := make(map[string]int, len(doc.Layers))
	for _, e := range entities {
		name := e.Base().Layer
		if name == "" {
			name = "0"
		}
		counts[name]++
	}

	out := make([]cadLayerResponse, 0, len(doc.Layers))
	seen := make(map[string]bool, len(doc.Layers))
	for _, l := range doc.Layers {
		seen[l.Name] = true
		out = append(out, cadLayerResponse{
			Name:        l.Name,
			Color:       colorResponse(l.Color),
			Visible:     l.Visible(),
			Locked:      l.Locked,
			Plottable:   l.Plottable,
			EntityCount: counts[l.Name],
			Annotation:  cad.IsAnnotationLayer(l.Name),
		})
	}
	for name, n := range counts {
		if !seen[name] {
			out = append(out, cadLayerResponse{
				Name:        name,
				Visible:     true,
				Plottable:   true,
				EntityCount: n,
				Annotation:  cad.IsAnnotationLayer(name),
			})
		}
	}
	return out
}

func inspectCAD() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, _, err := readCADUpload(r)
		if err != nil {
			api.BadRequest(w, "invalid drawing upload")
			return
		}
		doc, format, err := readDrawing(data)
		if err != nil {
			writeCADError(w, r, err)
			return
		}
		// Inspect never discards: its whole job is to report what the file
		// holds so the user can decide what to drop.
		res, err := flattenForImport(doc, nil)
		if err != nil {
			writeCADError(w, r, err)
			return
		}

		// Debris is discarded before anything is measured. It does not
		// merely widen the reported extent — ResolveUnits reads that extent
		// to judge the declared unit, so a stray entity off the sheet can
		// change the scale of the whole drawing. See cad.TrimOutliers.
		entities, detached := cad.TrimOutliers(res.Entities)

		box := cad.Bounds(entities)
		size := box.Size()
		units, mpu, confident := cad.ResolveUnits(doc.Header, size)
		// ResolveUnits sets a declaration aside when the geometry
		// contradicts it, so "declared" has to mean the answer came from
		// the file — not merely that the file said something.
		_, stated := doc.Header.Units.MetersPerUnit()
		declared := stated && units == doc.Header.Units

		kinds := make(map[string]int)
		for _, e := range entities {
			kinds[string(e.Kind())]++
		}

		resp := cadInspectResponse{
			Format:           format,
			Version:          doc.Header.Version,
			Release:          dwg.Version(doc.Header.Version).Name(),
			Producer:         doc.Header.Producer,
			Units:            units,
			UnitsName:        units.String(),
			UnitsDeclared:    declared,
			UnitsConfident:   confident,
			MetersPerUnit:    mpu,
			WidthMeters:      size.X * mpu,
			HeightMeters:     size.Y * mpu,
			Min:              cadPointResponse{X: box.Min.X, Y: box.Min.Y},
			Max:              cadPointResponse{X: box.Max.X, Y: box.Max.Y},
			EntityCount:      len(entities),
			DetachedEntities: detached,
			EntityKinds:      kinds,
			BlockCount:       len(doc.Blocks),
			Layers:           layerResponses(doc, entities),
			MissingBlocks:    res.MissingBlocks,
			MissingXrefs:     res.MissingXrefs,
			Truncated:        res.Truncated,
		}
		// The guesses are worth showing when the file left the question
		// open, and when it answered it in a way the geometry disagrees
		// with; an accepted $INSUNITS is not a ranking.
		if !declared {
			resp.UnitGuesses = cad.GuessUnits(size, doc.Header.Measurement)
		}
		if doc.Header.HasExtents {
			resp.HeaderMin = &cadPointResponse{X: doc.Header.ExtMin.X, Y: doc.Header.ExtMin.Y}
			resp.HeaderMax = &cadPointResponse{X: doc.Header.ExtMax.X, Y: doc.Header.ExtMax.Y}
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

// cadRenderResponse is a rendered drawing on its way to an images row.
//
// The first five fields mirror POST /images/upload exactly, so the SPA
// feeds this straight into the placement draft a PDF page or a photo
// already goes through — that shared shape is what makes a CAD floor plan
// cost no new shape kind, no migration and no second placement path.
type cadRenderResponse struct {
	URL           string `json:"url"`
	MimeType      string `json:"mimeType"`
	NaturalWidth  int    `json:"naturalWidth"`
	NaturalHeight int    `json:"naturalHeight"`
	Bytes         int64  `json:"bytes"`

	// What the image covers on the ground. A PDF cannot say this — its
	// scale is inferred from a sheet size — but a drawing is authored in
	// real-world coordinates, so the placement can start out correct
	// rather than approximately correct.
	WidthMeters    float64 `json:"widthMeters"`
	HeightMeters   float64 `json:"heightMeters"`
	PixelsPerMeter float64 `json:"pixelsPerMeter"`

	// The units the size above is stated in, so the UI can show what it
	// assumed and the user can re-render under a different answer.
	Units         cad.Units `json:"units"`
	UnitsName     string    `json:"unitsName"`
	MetersPerUnit float64   `json:"metersPerUnit"`

	EntityCount      int  `json:"entityCount"`
	DetachedEntities int  `json:"detachedEntities,omitempty"`
	Truncated        bool `json:"truncated"`
}

// renderCAD draws the chosen layers onto a sheet and stores the PNG.
//
// Only the rendered image is persisted, never the drawing: a stored file
// with no DB row pointing at it is indistinguishable from an orphan and
// cmd/cleanup-orphans would correctly reclaim it. The PNG lands on an
// images row exactly like a direct upload, so the existing refcount and
// cleanup paths need no changes at all.
func renderCAD(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, filename, err := readCADUpload(r)
		if err != nil {
			api.BadRequest(w, "invalid drawing upload")
			return
		}
		doc, _, err := readDrawing(data)
		if err != nil {
			writeCADError(w, r, err)
			return
		}

		res, err := flattenForImport(doc, parseLayerFilter(r.FormValue("layers")))
		if err != nil {
			writeCADError(w, r, err)
			return
		}
		if len(res.Entities) == 0 {
			api.Error(w, http.StatusUnprocessableEntity, "the selected layers contain no geometry")
			return
		}
		// Debris is discarded before the scale is chosen, and that ordering
		// is load-bearing twice over: ResolveUnits judges the declared unit
		// by the extent it implies, and the raster spends a fixed pixel
		// budget across whatever box it is given. A drawing whose extent is
		// eight times its geometry renders the building at an eighth of the
		// resolution it could have had. See cad.TrimOutliers.
		entities, detached := cad.TrimOutliers(res.Entities)

		box := cad.Bounds(entities)
		units, mpu, _ := cad.ResolveUnits(doc.Header, box.Size())
		units, mpu, ok := overrideUnits(w, r, units, mpu)
		if !ok {
			return
		}

		paths, err := cad.Paths(entities, cad.PathOptions{MetersPerUnit: mpu, Origin: box.Min})
		truncated := res.Truncated
		if err != nil {
			if !errors.Is(err, cad.ErrTooManyPoints) {
				writeCADError(w, r, err)
				return
			}
			truncated = true
		}

		raster, err := cad.Rasterize(paths, cad.RasterOptions{})
		if err != nil {
			writeCADError(w, r, err)
			return
		}

		key := store.KeyFromData(cadRasterFilename(filename), raster.PNG)
		if err := s.Put(r.Context(), key, "image/png", raster.PNG); err != nil {
			api.InternalError(w, r, err)
			return
		}
		recordTenantFile(r, q, key, "image/png", len(raster.PNG))

		api.JSON(w, http.StatusCreated, cadRenderResponse{
			URL:              store.NormalizeAssetURL(s.URL(key)),
			MimeType:         "image/png",
			NaturalWidth:     raster.Width,
			NaturalHeight:    raster.Height,
			Bytes:            int64(len(raster.PNG)),
			WidthMeters:      raster.WidthMeters,
			HeightMeters:     raster.HeightMeters,
			PixelsPerMeter:   raster.PixelsPerMeter,
			Units:            units,
			UnitsName:        units.String(),
			MetersPerUnit:    mpu,
			EntityCount:      len(entities),
			DetachedEntities: detached,
			Truncated:        truncated,
		})
	}
}

// cadRasterFilename gives the rendered sheet a name that still identifies
// its origin once it is sitting in the object store.
func cadRasterFilename(original string) string {
	base := strings.TrimSpace(original)
	if base == "" {
		base = "drawing.dwg"
	}
	if ext := strings.LastIndex(base, "."); ext > 0 {
		base = base[:ext]
	}
	return base + ".png"
}

// CADRouter exposes the drawing import endpoints.
func CADRouter(q *db.Queries, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Post("/inspect", inspectCAD())
	r.Post("/render", renderCAD(q, s))
	return r
}
