// Command demo-export builds the demo-workspace pack that internal/demo
// loads into an empty database on first start (see internal/demo/demo.go).
//
// It reads a running Spatial Map database (SELECTs only) and the files its
// API serves under /files/, and writes one JSON file per table plus the
// referenced floor-plan images into internal/demo/pack/. Row ids are kept:
// ids are global per table, so facilities from several workspaces merge
// into one demo workspace without collisions. Tenant ids are written as 0
// and replaced with the demo workspace's id at load time.
//
// What is exported for the given facilities (zones): the zones, every
// shape table, bins, attribute definitions, style rules, data links and
// the streams / tables they read (with field definitions, rows, row
// history and the streams' connections), non-archived reports, solutions that point at any of it, and
// the uploaded files those rows reference.
//
// What never is: users, memberships, API / table tokens, share links,
// connection credentials, alerts, audit and event logs, report runs, uploaded 3D
// models (licences unknown — map them to bundled models with -model-map
// or their placements are dropped).
//
// Usage (from backend/) — the command that built the shipped pack:
//
//	go run ./cmd/demo-export \
//	  -db postgres://spatial:spatial@localhost:5432/spatial \
//	  -files http://localhost:8080 \
//	  -zones 58,61,65,66,71 \
//	  -model-map user_21=industrial_forklift_pnuematic_tire:1 \
//	  -skip image_planes \
//	  -blank-images 23,25 \
//	  -set "images:48:name=Ground Floor,images:49:name=Ground Floor,images:67:name=Retail Ground Floor,images:25:name=Ground Floor,images:11:name=First Floor,images:16:name=Rooftop,images:26:name=Parking,reports:31:name=Weekly report,reports:31:description=Weekly sensor and asset summary for the hospital." \
//	  -rewrite cmd/demo-export/rewrites.json
//
// The ids are the source instance's; after loading the pack into a fresh
// database they are the same ids, so the command re-exports it as is.
//
// -rewrite is an optional JSON list of {"find": "<regexp>", "replace": "…"}
// applied to every string value — use it to scrub real names out of a
// workspace before publishing it. -blank-images swaps the pictures of the
// given floor-plan images for a plain sheet of the same size (the floor
// and every shape on it stay), for plans that show third-party logos.
// -set overrides single values, as table:id:column=value pairs.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Row is one exported table row, column name → JSON value.
type Row = map[string]any

// Manifest is pack/manifest.json. Tables are listed in load order
// (parents before children).
type Manifest struct {
	Version    int             `json:"version"`
	ExportedAt time.Time       `json:"exportedAt"`
	Tables     []ManifestTable `json:"tables"`
	Files      []ManifestFile  `json:"files"`
}

type ManifestTable struct {
	Name string `json:"name"`
	Rows int    `json:"rows"`
}

type ManifestFile struct {
	Key         string `json:"key"`
	ContentType string `json:"contentType"`
	Size        int    `json:"size"`
}

type rewrite struct {
	Find    string `json:"find"`
	Replace string `json:"replace"`
	re      *regexp.Regexp
}

type modelMapping struct {
	asset string
	scale float64
}

// shapeTables are the zone-scoped tables copied whole for each facility.
var shapeTables = []string{
	"polygons", "circles", "lines", "markers", "doors", "stairs",
	"text_labels", "images", "image_planes", "models", "grids", "routes",
}

var filesRef = regexp.MustCompile(`/files/([^"\s,?#]+)`)

func main() {
	dsn := flag.String("db", "postgres://spatial:spatial@localhost:5432/spatial", "source database URL (read only)")
	filesBase := flag.String("files", "http://localhost:8080", "base URL that serves /files/<key>")
	zonesFlag := flag.String("zones", "", "comma-separated facility (zone) ids to export")
	out := flag.String("out", "internal/demo/pack", "output directory (replaced)")
	modelMap := flag.String("model-map", "", "comma-separated uploaded→bundled model mappings, e.g. user_21=industrial_forklift_pnuematic_tire:1 (asset:scale)")
	skip := flag.String("skip", "", "comma-separated shape tables to leave out")
	rewriteFile := flag.String("rewrite", "", "optional JSON file of string rewrites")
	blankFlag := flag.String("blank-images", "", "comma-separated image ids whose picture is replaced by a plain sheet")
	setFlag := flag.String("set", "", "comma-separated table:id:column=value overrides")
	flag.Parse()

	zoneIDs, err := parseIDs(*zonesFlag)
	if err != nil || len(zoneIDs) == 0 {
		log.Fatalf("-zones: need a comma-separated list of ids (%v)", err)
	}
	models, err := parseModelMap(*modelMap)
	if err != nil {
		log.Fatalf("-model-map: %v", err)
	}
	var rewrites []rewrite
	if *rewriteFile != "" {
		b, err := os.ReadFile(*rewriteFile)
		if err != nil {
			log.Fatal(err)
		}
		if err := json.Unmarshal(b, &rewrites); err != nil {
			log.Fatalf("-rewrite: %v", err)
		}
		for i := range rewrites {
			rewrites[i].re = regexp.MustCompile(rewrites[i].Find)
		}
	}
	skipped := map[string]bool{}
	for _, s := range strings.Split(*skip, ",") {
		if s = strings.TrimSpace(s); s != "" {
			skipped[s] = true
		}
	}

	ctx := context.Background()
	pcfg, err := pgxpool.ParseConfig(*dsn)
	if err != nil {
		log.Fatal(err)
	}
	// Belt and braces: the exporter never writes.
	pcfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	x := &exporter{ctx: ctx, pool: pool, tables: map[string][]Row{}}
	x.run(zoneIDs, skipped, models)
	if err := x.applySets(*setFlag); err != nil {
		log.Fatalf("-set: %v", err)
	}
	blankIDs, err := parseIDs(*blankFlag)
	if err != nil {
		log.Fatalf("-blank-images: %v", err)
	}
	// Uploads referenced by the blanked images, by their original key.
	blank := map[string]bool{}
	for _, img := range x.tables["images"] {
		for _, id := range blankIDs {
			if num(img["id"]) == id {
				_ = walkStrings(img, func(s string) string {
					for _, m := range filesRef.FindAllStringSubmatch(s, -1) {
						k := m[1]
						if dec, err := url.PathUnescape(k); err == nil {
							k = dec
						}
						blank[k] = true
					}
					return s
				})
			}
		}
	}

	// Rewrite every row; each upload a row references is fetched (and
	// shrunk) the first time it is seen, and the reference re-pointed.
	files := map[string]*packedFile{}
	for _, name := range x.order {
		for _, r := range x.tables[name] {
			scrubRow(name, r)
			for k, v := range r {
				r[k] = walkStrings(v, func(s string) string {
					for _, rw := range rewrites {
						s = rw.re.ReplaceAllString(s, rw.Replace)
					}
					return filesRef.ReplaceAllStringFunc(s, func(m string) string {
						old := filesRef.FindStringSubmatch(m)[1]
						if dec, err := url.PathUnescape(old); err == nil {
							old = dec
						}
						f, ok := files[old]
						if !ok {
							f = packFile(*filesBase, old, blank[old])
							files[old] = f
						}
						return "/files/" + f.key
					})
				})
			}
		}
	}
	// tenant_files rows describe the uploads; keep the ones still referenced.
	x.tenantFiles(files)

	if err := os.RemoveAll(*out); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(*out, "files"), 0o755); err != nil {
		log.Fatal(err)
	}
	man := Manifest{Version: 1, ExportedAt: time.Now().UTC().Truncate(time.Second)}
	for _, name := range x.order {
		rows := x.tables[name]
		if len(rows) == 0 {
			continue
		}
		writeRows(filepath.Join(*out, name+".json"), rows)
		man.Tables = append(man.Tables, ManifestTable{Name: name, Rows: len(rows)})
	}

	olds := make([]string, 0, len(files))
	for old := range files {
		olds = append(olds, old)
	}
	sort.Strings(olds)
	for _, old := range olds {
		f := files[old]
		if err := os.WriteFile(filepath.Join(*out, "files", f.key), f.data, 0o644); err != nil {
			log.Fatal(err)
		}
		man.Files = append(man.Files, ManifestFile{Key: f.key, ContentType: f.contentType, Size: len(f.data)})
	}

	b, _ := json.MarshalIndent(man, "", "  ")
	if err := os.WriteFile(filepath.Join(*out, "manifest.json"), append(b, '\n'), 0o644); err != nil {
		log.Fatal(err)
	}
	for _, t := range man.Tables {
		fmt.Printf("%-24s %6d\n", t.Name, t.Rows)
	}
	fmt.Printf("%-24s %6d\n", "files", len(man.Files))
}

type exporter struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	tables map[string][]Row
	order  []string
}

func (x *exporter) add(table string, rows []Row) {
	if _, ok := x.tables[table]; !ok {
		x.order = append(x.order, table)
	}
	x.tables[table] = append(x.tables[table], rows...)
}

// query selects whole rows as JSON. Geometry columns are re-encoded as
// EWKT, which PostGIS parses back on load (to_jsonb would emit GeoJSON).
func (x *exporter) query(table, where string, args ...any) []Row {
	var geoCols []string
	rows, err := x.pool.Query(x.ctx, `
		SELECT column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = $1 AND udt_name = 'geometry'`, table)
	if err != nil {
		log.Fatal(err)
	}
	for rows.Next() {
		var c string
		_ = rows.Scan(&c)
		geoCols = append(geoCols, c)
	}
	rows.Close()

	sel := "to_jsonb(t)"
	for _, c := range geoCols {
		sel += fmt.Sprintf(" || jsonb_build_object(%s, ST_AsEWKT(t.%s))", quoteLit(c), pgx.Identifier{c}.Sanitize())
	}
	q := fmt.Sprintf("SELECT %s FROM %s t WHERE %s ORDER BY 1", sel, pgx.Identifier{table}.Sanitize(), where)
	if hasColumn(x, table, "id") {
		q = fmt.Sprintf("SELECT %s FROM %s t WHERE %s ORDER BY t.id", sel, pgx.Identifier{table}.Sanitize(), where)
	}
	rs, err := x.pool.Query(x.ctx, q, args...)
	if err != nil {
		log.Fatalf("%s: %v", table, err)
	}
	defer rs.Close()
	var out []Row
	for rs.Next() {
		var r Row
		if err := rs.Scan(&r); err != nil {
			log.Fatalf("%s: %v", table, err)
		}
		out = append(out, r)
	}
	if err := rs.Err(); err != nil {
		log.Fatalf("%s: %v", table, err)
	}
	return out
}

func hasColumn(x *exporter, table, col string) bool {
	var ok bool
	_ = x.pool.QueryRow(x.ctx, `
		SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2)`, table, col).Scan(&ok)
	return ok
}

func (x *exporter) run(zoneIDs []int64, skipped map[string]bool, models map[string]modelMapping) {
	zones := x.query("zones", "t.id = ANY($1)", zoneIDs)
	if len(zones) != len(zoneIDs) {
		log.Fatalf("found %d of %d zones", len(zones), len(zoneIDs))
	}
	tenantSet := map[int64]bool{}
	for _, z := range zones {
		tenantSet[num(z["tenant_id"])] = true
	}
	tenantIDs := keys(tenantSet)

	shapes := map[string][]Row{}
	for _, t := range shapeTables {
		if skipped[t] {
			continue
		}
		shapes[t] = x.query(t, "t.zone_id = ANY($1)", zoneIDs)
	}
	// Uploaded 3D models: remap to a bundled asset or drop the placement.
	var keptModels []Row
	for _, m := range shapes["models"] {
		cfg, _ := m["config"].(map[string]any)
		asset, _ := cfg["modelAssetId"].(string)
		if strings.HasPrefix(asset, "user_") {
			mm, ok := models[asset]
			if !ok {
				continue
			}
			cfg["modelAssetId"] = mm.asset
			cfg["scale"] = []any{mm.scale, mm.scale, mm.scale}
		}
		keptModels = append(keptModels, m)
	}
	if _, ok := shapes["models"]; ok {
		shapes["models"] = keptModels
	}

	links := x.query("data_link_configs", "t.zone_id = ANY($1)", zoneIDs)
	reports := x.query("reports", "t.zone_id = ANY($1) AND NOT t.is_archived", zoneIDs)

	// Built-in facility sources are one set per workspace; keep the first
	// tenant's set and point the others' references at it.
	facility := x.query("data_sources", "t.tenant_id = ANY($1) AND t.config->>'facilityEntity' IS NOT NULL", tenantIDs)
	canonTenant := tenantIDs[0]
	byEntity := map[string]int64{}
	for _, s := range facility {
		if num(s["tenant_id"]) == canonTenant {
			byEntity[facilityEntity(s)] = num(s["id"])
		}
	}
	remap := map[int64]int64{}
	var keptFacility []Row
	for _, s := range facility {
		id := num(s["id"])
		if num(s["tenant_id"]) == canonTenant {
			keptFacility = append(keptFacility, s)
			continue
		}
		if to, ok := byEntity[facilityEntity(s)]; ok {
			remap[id] = to
		}
	}
	for _, r := range reports {
		r["spec"] = remapSpecSources(r["spec"], remap)
	}

	// Every table a link or report reads, plus the facilities' own tables.
	sourceSet := map[int64]bool{}
	for _, l := range links {
		if id := num(l["source_id"]); id != 0 {
			sourceSet[id] = true
		}
	}
	for _, r := range reports {
		collectSpecSources(r["spec"], sourceSet)
	}
	for _, s := range keptFacility {
		delete(sourceSet, num(s["id"]))
	}
	for from := range remap {
		delete(sourceSet, from)
	}
	// Unreferenced tables of the facilities come along only with data.
	sources := x.query("data_sources", `t.deleted_at IS NULL AND t.config->>'facilityEntity' IS NULL AND (
		t.id = ANY($2) OR (t.zone_id = ANY($1) AND EXISTS (SELECT 1 FROM data_source_rows r WHERE r.source_id = t.id)))`,
		zoneIDs, keys(sourceSet))
	sourceIDs := []int64{}
	for _, s := range sources {
		sourceIDs = append(sourceIDs, num(s["id"]))
	}
	for _, s := range keptFacility {
		sourceIDs = append(sourceIDs, num(s["id"]))
	}

	streamSet := map[int64]bool{}
	styleSet := map[int64]bool{}
	for _, l := range links {
		if id := num(l["stream_id"]); id != 0 {
			streamSet[id] = true
		}
		if ids, ok := l["style_rule_ids"].([]any); ok {
			for _, v := range ids {
				styleSet[num(v)] = true
			}
		}
	}

	x.add("zones", zones)
	x.add("data_sources", sources)
	x.add("data_sources", keptFacility)
	x.add("table_field_definitions", x.query("table_field_definitions", "t.source_id = ANY($1)", sourceIDs))
	x.add("data_source_rows", x.query("data_source_rows", "t.source_id = ANY($1)", sourceIDs))
	x.add("data_source_row_events", x.query("data_source_row_events", "t.source_id = ANY($1)", sourceIDs))
	streams := x.query("streams", "t.id = ANY($1)", keys(streamSet))
	connSet := map[int64]bool{}
	for _, st := range streams {
		connSet[num(st["connection_id"])] = true
	}
	conns := x.query("connections", "t.id = ANY($1)", keys(connSet))
	for _, c := range conns {
		// Credentials never leave the source instance.
		c["auth"] = map[string]any{"mode": "none"}
	}
	x.add("connections", conns)
	x.add("streams", streams)
	x.add("entity_states", x.query("entity_states", "t.stream_id = ANY($1)", keys(streamSet)))
	x.add("attribute_definitions", dedupeAttributes(x.query("attribute_definitions",
		"t.zone_id = ANY($1) OR (t.zone_id IS NULL AND t.tenant_id = ANY($2))", zoneIDs, tenantIDs)))
	for _, t := range shapeTables {
		if rows, ok := shapes[t]; ok {
			x.add(t, rows)
		}
	}
	gridIDs := []int64{}
	for _, g := range shapes["grids"] {
		gridIDs = append(gridIDs, num(g["id"]))
	}
	x.add("bins", x.query("bins", "t.grid_id = ANY($1)", gridIDs))
	x.add("style_rules", x.query("style_rules", "t.zone_id = ANY($1) OR t.id = ANY($2)", zoneIDs, keys(styleSet)))
	for _, l := range links {
		if to, ok := remap[num(l["source_id"])]; ok {
			l["source_id"] = to
		}
	}
	x.add("data_link_configs", links)
	x.add("reports", reports)

	// Solutions: keep items that point at exported things.
	reportSet := map[int64]bool{}
	for _, r := range reports {
		reportSet[num(r["id"])] = true
	}
	srcSet := map[int64]bool{}
	for _, id := range sourceIDs {
		srcSet[id] = true
	}
	zoneSet := map[int64]bool{}
	for _, id := range zoneIDs {
		zoneSet[id] = true
	}
	var items []Row
	solSet := map[int64]bool{}
	for _, it := range x.query("solution_items", "t.tenant_id = ANY($1)", tenantIDs) {
		if to, ok := remap[num(it["data_source_id"])]; ok {
			it["data_source_id"] = to
		}
		if zoneSet[num(it["zone_id"])] || reportSet[num(it["report_id"])] || srcSet[num(it["data_source_id"])] {
			items = append(items, it)
			solSet[num(it["solution_id"])] = true
		}
	}
	x.add("solutions", x.query("solutions", "t.id = ANY($1)", keys(solSet)))
	x.add("solution_items", items)
}

// applySets applies -set overrides: table:id:column=value, comma-separated.
func (x *exporter) applySets(spec string) error {
	for _, p := range strings.Split(spec, ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		target, value, ok := strings.Cut(p, "=")
		parts := strings.Split(target, ":")
		if !ok || len(parts) != 3 {
			return fmt.Errorf("%q: want table:id:column=value", p)
		}
		id, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return fmt.Errorf("%q: %v", p, err)
		}
		found := false
		for _, r := range x.tables[parts[0]] {
			if num(r["id"]) == id {
				r[parts[2]] = value
				found = true
			}
		}
		if !found {
			return fmt.Errorf("%q: no such row", p)
		}
	}
	return nil
}

// tenantFiles adds the tenant_files rows of the packed uploads, with
// their new keys, types and sizes.
func (x *exporter) tenantFiles(files map[string]*packedFile) {
	olds := make([]string, 0, len(files))
	for k := range files {
		olds = append(olds, k)
	}
	rows := x.query("tenant_files", "t.object_key = ANY($1)", olds)
	seen := map[string]bool{}
	var kept []Row
	for _, r := range rows {
		old, _ := r["object_key"].(string)
		if seen[old] {
			continue
		}
		seen[old] = true
		f := files[old]
		r["object_key"] = f.key
		r["content_type"] = f.contentType
		r["size_bytes"] = len(f.data)
		scrubRow("tenant_files", r)
		kept = append(kept, r)
	}
	x.add("tenant_files", kept)
}

// scrubRow strips everything that ties a row to a real workspace or person.
func scrubRow(table string, r Row) {
	if _, ok := r["tenant_id"]; ok {
		r["tenant_id"] = 0
	}
	for _, c := range []string{"created_by", "uploaded_by", "auth_token_id", "source_ip"} {
		if _, ok := r[c]; ok {
			r[c] = nil
		}
	}
	if table == "zones" {
		// Legacy share URLs embed the token; a fresh install mints its own.
		// is_public stays: the signed-in viewer reads through the public
		// endpoint too, so a private facility would not open in Preview.
		r["share_token"] = nil
	}
}

func facilityEntity(s Row) string {
	cfg, _ := s["config"].(map[string]any)
	e, _ := cfg["facilityEntity"].(string)
	return e
}

// specSourceKeys are the report-spec keys whose value is a data-source id.
var specSourceKeys = map[string]bool{"sourceId": true, "source_id": true, "dataSourceId": true}

var originSource = regexp.MustCompile(`^source:(\d+)$`)

func remapSpecSources(v any, remap map[int64]int64) any {
	switch t := v.(type) {
	case map[string]any:
		isSourceRef := t["kind"] == "dataSource"
		for k, child := range t {
			if (specSourceKeys[k] || (isSourceRef && k == "id")) && isNum(child) {
				if to, ok := remap[num(child)]; ok {
					t[k] = to
				}
				continue
			}
			t[k] = remapSpecSources(child, remap)
		}
		return t
	case []any:
		for i := range t {
			t[i] = remapSpecSources(t[i], remap)
		}
		return t
	case string:
		if m := originSource.FindStringSubmatch(t); m != nil {
			id, _ := strconv.ParseInt(m[1], 10, 64)
			if to, ok := remap[id]; ok {
				return fmt.Sprintf("source:%d", to)
			}
		}
		return t
	default:
		return v
	}
}

func collectSpecSources(v any, into map[int64]bool) {
	switch t := v.(type) {
	case map[string]any:
		isSourceRef := t["kind"] == "dataSource"
		for k, child := range t {
			if (specSourceKeys[k] || (isSourceRef && k == "id")) && isNum(child) {
				into[num(child)] = true
				continue
			}
			collectSpecSources(child, into)
		}
	case []any:
		for _, c := range t {
			collectSpecSources(c, into)
		}
	case string:
		if m := originSource.FindStringSubmatch(t); m != nil {
			id, _ := strconv.ParseInt(m[1], 10, 64)
			into[id] = true
		}
	}
}

// dedupeAttributes keeps the first definition per (zone, scope, key):
// workspace-wide definitions of several source workspaces would collide
// on the unique index once merged into one.
func dedupeAttributes(rows []Row) []Row {
	seen := map[string]bool{}
	var out []Row
	for _, r := range rows {
		k := fmt.Sprintf("%d|%v|%v", num(r["zone_id"]), r["scope"], r["key"])
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, r)
	}
	return out
}

func walkStrings(v any, fn func(string) string) any {
	switch t := v.(type) {
	case string:
		return fn(t)
	case map[string]any:
		for k, c := range t {
			t[k] = walkStrings(c, fn)
		}
		return t
	case []any:
		for i := range t {
			t[i] = walkStrings(t[i], fn)
		}
		return t
	default:
		return v
	}
}

// packKey turns an upload key into a portable one: ASCII only (go:embed
// rejects names like "…"), never starting with "_" or ".", and prefixed
// so demo uploads are recognisable in the bucket.
func packKey(old string) string {
	var b strings.Builder
	for _, r := range old {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	s := regexp.MustCompile(`-{2,}`).ReplaceAllString(b.String(), "-")
	return "demo-" + strings.TrimLeft(s, "-_.")
}

type packedFile struct {
	key         string
	contentType string
	data        []byte
}

// packFile downloads an upload and gives it a portable key. Floor-plan
// images are re-encoded as JPEG when that saves at least a third — an
// opaque PNG (most plans, even with an alpha channel) or a JPEG saved at
// a needlessly high quality.
func packFile(base, old string, blank bool) *packedFile {
	data, ctype, err := fetch(base, old)
	if err != nil {
		log.Fatalf("file %q: %v", old, err)
	}
	f := &packedFile{key: packKey(old), contentType: ctype, data: data}
	if blank {
		cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			log.Fatalf("blank %q: %v", old, err)
		}
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, plainSheet(cfg.Width, cfg.Height), &jpeg.Options{Quality: 85}); err != nil {
			log.Fatal(err)
		}
		f.key = strings.TrimSuffix(f.key, filepath.Ext(f.key)) + "-plain.jpeg"
		f.contentType = "image/jpeg"
		f.data = buf.Bytes()
		return f
	}
	var img image.Image
	switch {
	case strings.HasPrefix(ctype, "image/png"):
		img, err = png.Decode(bytes.NewReader(data))
		if o, ok := img.(interface{ Opaque() bool }); err != nil || !ok || !o.Opaque() {
			return f
		}
	case strings.HasPrefix(ctype, "image/jpeg"):
		if img, err = jpeg.Decode(bytes.NewReader(data)); err != nil {
			return f
		}
	default:
		return f
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 82}); err != nil || buf.Len()*3 > len(data)*2 {
		return f
	}
	f.key = strings.TrimSuffix(f.key, filepath.Ext(f.key)) + ".jpeg"
	f.contentType = "image/jpeg"
	f.data = buf.Bytes()
	return f
}

// plainSheet is an off-white drawing sheet with a faint 1:50 grid.
func plainSheet(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	paper := color.RGBA{248, 248, 246, 255}
	line := color.RGBA{228, 228, 224, 255}
	step := max(w, h) / 50
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if step > 0 && (x%step == 0 || y%step == 0) {
				img.SetRGBA(x, y, line)
			} else {
				img.SetRGBA(x, y, paper)
			}
		}
	}
	return img
}

func fetch(base, key string) ([]byte, string, error) {
	u := strings.TrimRight(base, "/") + "/files/" + url.PathEscape(key)
	res, err := http.Get(u)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("GET %s: %s", u, res.Status)
	}
	b, err := io.ReadAll(res.Body)
	return b, res.Header.Get("Content-Type"), err
}

// writeRows writes a JSON array with one row per line, so a regenerated
// pack diffs row by row.
func writeRows(path string, rows []Row) {
	f, err := os.Create(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	_, _ = f.WriteString("[\n")
	for i, r := range rows {
		b, err := json.Marshal(r)
		if err != nil {
			log.Fatal(err)
		}
		_, _ = f.Write(b)
		if i < len(rows)-1 {
			_, _ = f.WriteString(",")
		}
		_, _ = f.WriteString("\n")
	}
	_, _ = f.WriteString("]\n")
}

func parseIDs(s string) ([]int64, error) {
	var out []int64
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		id, err := strconv.ParseInt(p, 10, 64)
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
}

func parseModelMap(s string) (map[string]modelMapping, error) {
	out := map[string]modelMapping{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		from, to, ok := strings.Cut(p, "=")
		if !ok {
			return nil, fmt.Errorf("%q: want from=asset[:scale]", p)
		}
		asset, scaleStr, hasScale := strings.Cut(to, ":")
		scale := 1.0
		if hasScale {
			v, err := strconv.ParseFloat(scaleStr, 64)
			if err != nil {
				return nil, fmt.Errorf("%q: %v", p, err)
			}
			scale = v
		}
		out[from] = modelMapping{asset: asset, scale: scale}
	}
	return out, nil
}

func isNum(v any) bool {
	_, ok := v.(float64)
	return ok
}

func num(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int64:
		return t
	case json.Number:
		n, _ := t.Int64()
		return n
	}
	return 0
}

func keys(m map[int64]bool) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func quoteLit(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
