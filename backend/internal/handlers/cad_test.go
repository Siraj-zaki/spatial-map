package handlers

import (
	"bytes"
	"encoding/json"
	"image"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/stretchr/testify/require"
)

// The CAD routes never touch the database, and the only thing they store
// is the rendered sheet — so a temp-directory store is the whole fixture
// and they can be exercised over a real HTTP round trip with nothing
// beyond the drawing itself.

// The server also serves /files/{key} out of the same store, the way
// cmd/api does, so a test can fetch a rendered sheet back at the URL the
// response gave it. Checking that the URL resolves is most of the value:
// a stored object nobody can retrieve is a broken floor plan.
func newCADTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	s, err := store.NewLocalStore(t.TempDir(), "/files")
	require.NoError(t, err)

	mux := http.NewServeMux()
	mux.Handle("/", CADRouter(nil, s))
	mux.HandleFunc("GET /files/{key}", func(w http.ResponseWriter, r *http.Request) {
		obj, err := s.Get(r.Context(), r.PathValue("key"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", obj.ContentType)
		w.Write(obj.Data)
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func cadMultipart(t *testing.T, data []byte, filename string, fields map[string]string) (string, *bytes.Buffer) {
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

func cadFixtures(t *testing.T) []string {
	t.Helper()
	dir := os.Getenv("DWG_FIXTURES")
	if dir == "" {
		t.Skip("set DWG_FIXTURES to a directory of .dwg files to run this")
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*.dwg"))
	if err != nil || len(paths) == 0 {
		t.Skipf("no .dwg files in %s", dir)
	}
	sort.Strings(paths)
	return paths
}

type cadInspectEnvelope struct {
	Data struct {
		Format         string  `json:"format"`
		Version        string  `json:"version"`
		Release        string  `json:"release"`
		Units          int     `json:"units"`
		UnitsName      string  `json:"unitsName"`
		UnitsDeclared  bool    `json:"unitsDeclared"`
		UnitsConfident bool    `json:"unitsConfident"`
		MetersPerUnit  float64 `json:"metersPerUnit"`
		WidthMeters    float64 `json:"widthMeters"`
		HeightMeters   float64 `json:"heightMeters"`
		EntityCount    int     `json:"entityCount"`
		BlockCount     int     `json:"blockCount"`
		Layers         []struct {
			Name        string `json:"name"`
			EntityCount int    `json:"entityCount"`
			Annotation  bool   `json:"annotation"`
		} `json:"layers"`
		EntityKinds map[string]int `json:"entityKinds"`
	} `json:"data"`
}

func cadInspect(t *testing.T, srv *httptest.Server, data []byte, name string) cadInspectEnvelope {
	t.Helper()
	ct, body := cadMultipart(t, data, name, nil)
	resp, err := http.Post(srv.URL+"/inspect", ct, body)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode, name)
	var env cadInspectEnvelope
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&env))
	return env
}

type cadRenderEnvelope struct {
	Data struct {
		URL            string  `json:"url"`
		MimeType       string  `json:"mimeType"`
		NaturalWidth   int     `json:"naturalWidth"`
		NaturalHeight  int     `json:"naturalHeight"`
		Bytes          int64   `json:"bytes"`
		WidthMeters    float64 `json:"widthMeters"`
		HeightMeters   float64 `json:"heightMeters"`
		PixelsPerMeter float64 `json:"pixelsPerMeter"`
		UnitsName      string  `json:"unitsName"`
		MetersPerUnit  float64 `json:"metersPerUnit"`
		EntityCount    int     `json:"entityCount"`
	} `json:"data"`
}

func cadRender(t *testing.T, srv *httptest.Server, data []byte, name string, fields map[string]string) cadRenderEnvelope {
	t.Helper()
	ct, body := cadMultipart(t, data, name, fields)
	resp, err := http.Post(srv.URL+"/render", ct, body)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusCreated, resp.StatusCode, name)
	var env cadRenderEnvelope
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&env))
	return env
}

// Render is the path a floor-plan import takes, and its response is fed
// straight into the placement draft an uploaded image already uses. So
// the contract is the five fields /images/upload returns plus the ground
// size — and a response that is missing any of them puts a floor plan on
// the map at a size nobody chose.
func TestRenderCADEndpoint(t *testing.T) {
	srv := newCADTestServer(t)
	for _, p := range cadFixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		require.NoError(t, err)

		got := cadRender(t, srv, data, name, nil).Data

		require.Equal(t, "image/png", got.MimeType, name)
		require.True(t, strings.HasPrefix(got.URL, "/files/"), "%s: url %q is not a relative /files path", name, got.URL)
		require.Positive(t, got.Bytes, name)
		require.Positive(t, got.EntityCount, name)

		// The full texture budget, spent: resolution left unused is
		// resolution the building does not get.
		require.Equal(t, 4096, max(got.NaturalWidth, got.NaturalHeight), name)

		// The client anchors the image by a corner and stretches it to the
		// reported size, so the size and the pixels have to describe the
		// same box.
		require.InDelta(t, float64(got.NaturalWidth), got.WidthMeters*got.PixelsPerMeter, 0.5, name)
		require.InDelta(t, float64(got.NaturalHeight), got.HeightMeters*got.PixelsPerMeter, 0.5, name)

		// A floor plan is tens of metres across. This is the assertion that
		// catches a drawing imported at a thousandth of its size, which is
		// what an obeyed but wrong $INSUNITS produces.
		require.Greater(t, got.WidthMeters, 1.0, "%s: %.3f m wide in %s", name, got.WidthMeters, got.UnitsName)
		require.Less(t, got.WidthMeters, 1000.0, "%s: %.1f m wide in %s", name, got.WidthMeters, got.UnitsName)

		// Retrievable at the URL it reported, and a real PNG of exactly the
		// dimensions it claimed — a response nobody can fetch, or one whose
		// pixels disagree with its own numbers, is a broken floor plan that
		// still looks like a successful import.
		res, err := http.Get(srv.URL + got.URL)
		require.NoError(t, err)
		img, format, err := image.Decode(res.Body)
		res.Body.Close()
		require.NoError(t, err, name)
		require.Equal(t, "png", format, name)
		require.Equal(t, got.NaturalWidth, img.Bounds().Dx(), name)
		require.Equal(t, got.NaturalHeight, img.Bounds().Dy(), name)

		t.Logf("%s: %d×%d px, %.2f × %.2f m (%s), %d entities, %d KB",
			name, got.NaturalWidth, got.NaturalHeight, got.WidthMeters, got.HeightMeters,
			got.UnitsName, got.EntityCount, got.Bytes/1024)
	}
}

// A layer selection has to reach the raster, or the user's only control
// over what the sheet shows does nothing.
func TestRenderCADEndpointHonoursTheLayerFilter(t *testing.T) {
	srv := newCADTestServer(t)
	for _, p := range cadFixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		require.NoError(t, err)

		full := cadRender(t, srv, data, name, nil).Data

		// The busiest layer on its own. It is a strict subset of the
		// drawing, so it can only cover less ground.
		inspect := cadInspect(t, srv, data, name)
		busiest, count := "", 0
		for _, l := range inspect.Data.Layers {
			if l.EntityCount > count {
				busiest, count = l.Name, l.EntityCount
			}
		}
		require.NotEmpty(t, busiest, name)

		one := cadRender(t, srv, data, name, map[string]string{"layers": busiest}).Data
		require.Less(t, one.EntityCount, full.EntityCount, "%s: filtering to %q changed nothing", name, busiest)
		require.LessOrEqual(t, one.WidthMeters, full.WidthMeters+1e-6, name)
		require.NotEqual(t, full.URL, one.URL, "%s: a different drawing produced the same image", name)
	}
}

// Inspect exists to let a user answer "is this the right drawing, in the
// right units" before anything is converted. Every field below is one a
// human reads to decide that, so an inspect that returns 200 with them
// empty is a worse failure than one that errors.
func TestInspectCADEndpoint(t *testing.T) {
	srv := newCADTestServer(t)
	for _, p := range cadFixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		require.NoError(t, err)

		ct, body := cadMultipart(t, data, name, nil)
		resp, err := http.Post(srv.URL+"/inspect", ct, body)
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, resp.StatusCode, name)

		var env cadInspectEnvelope
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&env))
		resp.Body.Close()

		d := env.Data
		require.Equal(t, "dwg", d.Format, name)
		require.NotEmpty(t, d.Release, name)
		require.Greater(t, d.EntityCount, 0, name)
		require.NotEmpty(t, d.Layers, name)
		require.NotEmpty(t, d.EntityKinds, name)
		require.Greater(t, d.MetersPerUnit, 0.0, name)

		// A floor plan is a building. Anything outside this range means the
		// units were resolved wrongly, which is the one mistake here that
		// produces a plausible-looking import nobody notices until they
		// measure something.
		require.Greater(t, d.WidthMeters, 1.0, "%s: %.3f m wide", name, d.WidthMeters)
		require.Less(t, d.WidthMeters, 5000.0, "%s: %.1f m wide", name, d.WidthMeters)

		// The layer counts must account for the whole drawing — an entity
		// on no layer is an entity a layer picker cannot select, so it
		// would silently be unimportable.
		total := 0
		for _, l := range d.Layers {
			total += l.EntityCount
		}
		require.Equal(t, d.EntityCount, total, "%s: layer counts do not sum to the entity count", name)

		t.Logf("%-24s %-6s %-14s %8.1f x %-8.1f m  entities=%-6d layers=%-3d blocks=%d",
			name, d.Release, d.UnitsName, d.WidthMeters, d.HeightMeters,
			d.EntityCount, len(d.Layers), d.BlockCount)
	}
}

// A user's chosen units override the file's, because the reason to ask
// was that the file's answer was missing or not trusted.
//
// The override has to reach the ground size and stop there. That size is
// the whole placement: the client drags a box on the map and the bbox is
// snapped to it, so a thousandfold error imports a building as a desk.
// The picture must not change shape — a drawing is the same drawing
// whatever unit its coordinates are read in, so the pixel dimensions hold
// and only the metres they claim to cover move. (Not the bytes: a
// thousandfold rescale perturbs the last bit of the coordinates and the
// antialiasing follows, so the PNGs differ while the image does not.)
func TestRenderCADEndpointAppliesChosenUnits(t *testing.T) {
	srv := newCADTestServer(t)
	paths := cadFixtures(t)
	data, err := os.ReadFile(paths[0])
	require.NoError(t, err)
	name := filepath.Base(paths[0])

	// 4 is $INSUNITS millimetres, 6 is metres — a factor of a thousand.
	mm := cadRender(t, srv, data, name, map[string]string{"units": "4"}).Data
	m := cadRender(t, srv, data, name, map[string]string{"units": "6"}).Data

	require.InDelta(t, mm.WidthMeters*1000, m.WidthMeters, m.WidthMeters*1e-6)
	require.InDelta(t, mm.HeightMeters*1000, m.HeightMeters, m.HeightMeters*1e-6)
	require.Equal(t, mm.NaturalWidth, m.NaturalWidth, "the unit changed the raster")
	require.Equal(t, mm.NaturalHeight, m.NaturalHeight, "the unit changed the raster")

	// The stated density has to agree with the two above, or a client that
	// places by size and a client that places by density disagree.
	require.InDelta(t, mm.PixelsPerMeter/1000, m.PixelsPerMeter, m.PixelsPerMeter*1e-6)
}

// Inspect flags the annotation layers so the import dialog opens with the
// work mostly done — the sheet border, the dimension chains and the title
// block unticked, the building ticked.
//
// The flag is a guess and is allowed to be wrong on any one layer, so the
// assertion is on the corpus rather than on a name: a guesser that flags
// nothing anywhere is broken rather than conservative, and one that flags
// everything has rendered a blank sheet. Both ends have to be checked,
// because the sound half looks identical to the failure from one side.
func TestInspectCADEndpointFlagsAnnotationLayers(t *testing.T) {
	srv := newCADTestServer(t)

	flagged, total := 0, 0
	for _, p := range cadFixtures(t) {
		name := filepath.Base(p)
		data, err := os.ReadFile(p)
		require.NoError(t, err)

		env := cadInspect(t, srv, data, name)
		var flaggedHere []string
		for _, l := range env.Data.Layers {
			total++
			if l.Annotation {
				flagged++
				flaggedHere = append(flaggedHere, l.Name)
			}
		}
		require.Less(t, len(flaggedHere), len(env.Data.Layers),
			"%s: every layer flagged as annotation — the sheet would render blank", name)
		t.Logf("%-24s %d/%d annotation: %v", name, len(flaggedHere), len(env.Data.Layers), flaggedHere)
	}
	require.Greater(t, flagged, 0, "no layer in any fixture was flagged as annotation")
	require.Greater(t, total, flagged)
}

// A file the reader cannot open is the user's problem and has to be
// reported as one. A 500 tells them to contact support about a drawing
// they could re-save themselves.
func TestCADEndpointsRejectNonDrawings(t *testing.T) {
	srv := newCADTestServer(t)
	for _, route := range []string{"/inspect", "/render"} {
		ct, body := cadMultipart(t, []byte("this is not a drawing"), "notes.txt", nil)
		resp, err := http.Post(srv.URL+route, ct, body)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusBadRequest, resp.StatusCode, route)
	}
}

// The container layer reports a bad file without reaching for a
// sentinel — "no section AcDb:Handles", "page runs past end of file" —
// so the error mapping has to hold for errors it was not written
// against. It did not: a real drawing whose container would not open
// came back as 500 "internal server error", which names the wrong party
// and hides the one sentence that says what is wrong with the file.
func TestCADEndpointsReportAnUnopenableContainerAsTheFilesFault(t *testing.T) {
	srv := newCADTestServer(t)
	// A genuine R2018 magic string over bytes that are not a DWG: past
	// version detection, into the container reader, and out with an
	// unwrapped error.
	drawing := append([]byte("AC1032"), bytes.Repeat([]byte{0}, 4096)...)

	for _, route := range []string{"/inspect", "/render"} {
		ct, body := cadMultipart(t, drawing, "plan.dwg", nil)
		resp, err := http.Post(srv.URL+route, ct, body)
		require.NoError(t, err)
		payload, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		require.NoError(t, err)

		require.Less(t, resp.StatusCode, 500, "%s: %s", route, payload)
		require.GreaterOrEqual(t, resp.StatusCode, 400, route)
		// The message is the whole point of not returning 500 — it has to
		// carry the reader's own reason, not a generic replacement.
		require.Contains(t, string(payload), "dwg:", route)
	}
}

func TestCADEndpointsRejectMissingFile(t *testing.T) {
	srv := newCADTestServer(t)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	require.NoError(t, mw.WriteField("layers", "WALLS"))
	require.NoError(t, mw.Close())

	resp, err := http.Post(srv.URL+"/inspect", mw.FormDataContentType(), &body)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
}
