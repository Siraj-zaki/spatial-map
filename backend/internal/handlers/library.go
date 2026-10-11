package handlers

import (
	"mime"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
)

// The editor's upload library: what this workspace already uploaded, so
// "Add floor plan", "Add image plane" and "Add 3D model" can reuse a file
// instead of uploading it again.
//
// Unlike the Files screen (owner/admin, paged, every file kind) this is
// read-only and open to every member of the workspace — it's a picker
// for people who edit layouts. Strictly tenant-scoped; the client splits
// "This facility" from "Whole workspace" with `uploadedZoneId` + `uses`.

// LibraryUse is one facility where a file / model is used.
type LibraryUse struct {
	ZoneID *int64 `json:"zoneId"`
	// floorplan | plane | model
	Kind  string `json:"kind"`
	Count int64  `json:"count"`
}

// LibraryImage is one image file in the workspace's library.
type LibraryImage struct {
	Key            string       `json:"key"`
	URL            string       `json:"url"`
	Name           string       `json:"name"`
	Size           int64        `json:"size"`
	MimeType       string       `json:"mimeType"`
	NaturalWidth   int32        `json:"naturalWidth"`
	NaturalHeight  int32        `json:"naturalHeight"`
	UploadedAt     string       `json:"uploadedAt,omitempty"`
	UploadedZoneID *int64       `json:"uploadedZoneId"`
	Uses           []LibraryUse `json:"uses"`
}

// LibraryModel is one uploaded 3D model. Catalog rows pointing at the same
// file (identical bytes uploaded twice) collapse into one entry; `id` is
// the oldest row, the one new placements reference.
type LibraryModel struct {
	ID             int64        `json:"id"`
	IDs            []int64      `json:"ids"`
	Name           string       `json:"name"`
	ModelURL       string       `json:"modelUrl"`
	Bytes          int64        `json:"bytes"`
	Thumbnail      string       `json:"thumbnail,omitempty"`
	UploadedAt     string       `json:"uploadedAt"`
	UploadedZoneID *int64       `json:"uploadedZoneId"`
	Uses           []LibraryUse `json:"uses"`
}

var libraryImageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true}

func isLibraryImage(key, contentType string) bool {
	if strings.HasPrefix(contentType, "image/") && contentType != "image/svg+xml" {
		return true
	}
	return libraryImageExts[strings.ToLower(path.Ext(key))]
}

func int64Ptr(v int64) *int64 { return &v }

var (
	libraryNameSeparators = strings.NewReplacer("_", " ", "-", " ")
	fileExtSuffix         = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp|glb|gltf|pdf|dwg)$`)
)

// libraryName turns a storage key ("Warehouse_ground_floor_plan-4110e4…f381.jpeg")
// into a readable label ("Warehouse ground floor plan") for files no shape names.
func libraryName(key string) string {
	base := fileExtSuffix.ReplaceAllString(hashSuffix.ReplaceAllString(key, ""), "")
	name := strings.Join(strings.Fields(libraryNameSeparators.Replace(base)), " ")
	if name == "" {
		return key
	}
	return name
}

func listLibraryImages(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tenantID := api.TenantID(ctx)

		owned, err := q.ListLibraryFiles(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		uses, err := q.ListLibraryImageUses(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		// Objects already gone from storage (removed before uploads were
		// kept for reuse) would only render as broken tiles.
		objects, err := s.ListObjects(ctx)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		present := make(map[string]int64, len(objects))
		for _, o := range objects {
			present[o.Key] = o.Size
		}

		byKey := map[string]*LibraryImage{}
		get := func(key string) *LibraryImage {
			if it, ok := byKey[key]; ok {
				return it
			}
			it := &LibraryImage{Key: key, URL: "/files/" + key, Name: libraryName(key), Uses: []LibraryUse{}}
			byKey[key] = it
			return it
		}
		for _, o := range owned {
			ct := o.ContentType.String
			if !isLibraryImage(o.ObjectKey, ct) {
				continue
			}
			it := get(o.ObjectKey)
			it.MimeType = ct
			if o.SizeBytes.Valid {
				it.Size = o.SizeBytes.Int64
			}
			if o.CreatedAt.Valid {
				it.UploadedAt = api.FormatTime(o.CreatedAt)
			}
			if o.ZoneID.Valid {
				it.UploadedZoneID = int64Ptr(o.ZoneID.Int64)
			}
		}
		// Rows using an image the workspace never recorded as an upload
		// (pre-0043 data) still belong in its library.
		type useKey struct {
			zone int64
			kind string
		}
		counts := map[string]map[useKey]int64{}
		named := map[string]bool{}
		for _, u := range uses {
			key := store.KeyFromURL(u.FileUrl)
			if key == "" || !isLibraryImage(key, u.MimeType) {
				continue
			}
			it := get(key)
			// The oldest shape's name is what people called it (often renamed
			// from the filename); rows arrive oldest first.
			if name := strings.TrimSpace(u.Name); !named[key] && name != "" {
				// A name still shaped like a filename gets the same tidy-up.
				if !strings.Contains(name, " ") {
					name = libraryName(name)
				}
				it.Name = name
				named[key] = true
			}
			if it.NaturalWidth == 0 && u.NaturalWidth > 0 {
				it.NaturalWidth, it.NaturalHeight = u.NaturalWidth, u.NaturalHeight
			}
			if it.MimeType == "" {
				it.MimeType = u.MimeType
			}
			var zone int64
			if u.ZoneID.Valid {
				zone = u.ZoneID.Int64
			}
			if counts[key] == nil {
				counts[key] = map[useKey]int64{}
			}
			counts[key][useKey{zone, u.Kind}]++
		}

		out := make([]LibraryImage, 0, len(byKey))
		for key, it := range byKey {
			size, ok := present[key]
			if !ok {
				continue
			}
			if it.Size == 0 {
				it.Size = size
			}
			if it.MimeType == "" {
				it.MimeType = mime.TypeByExtension(path.Ext(key))
			}
			for k, n := range counts[key] {
				use := LibraryUse{Kind: k.kind, Count: n}
				if k.zone != 0 {
					use.ZoneID = int64Ptr(k.zone)
				}
				it.Uses = append(it.Uses, use)
			}
			sort.Slice(it.Uses, func(a, b int) bool { return it.Uses[a].Count > it.Uses[b].Count })
			out = append(out, *it)
		}
		// Newest first; files with no upload record (legacy) last, by name.
		sort.Slice(out, func(a, b int) bool {
			if out[a].UploadedAt != out[b].UploadedAt {
				return out[a].UploadedAt > out[b].UploadedAt
			}
			return out[a].Name < out[b].Name
		})
		api.JSON(w, http.StatusOK, out)
	}
}

func listLibraryModels(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tenantID := api.TenantID(ctx)

		rows, err := q.ListUserModels(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		uses, err := q.ListUserModelUses(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		usesByID := map[int64][]db.ListUserModelUsesRow{}
		for _, u := range uses {
			id, err := strconv.ParseInt(strings.TrimPrefix(u.AssetID, "user_"), 10, 64)
			if err == nil {
				usesByID[id] = append(usesByID[id], u)
			}
		}

		// Oldest row first so the canonical id is stable.
		sort.Slice(rows, func(a, b int) bool { return rows[a].ID < rows[b].ID })
		byURL := map[string]*LibraryModel{}
		order := []string{}
		zoneCounts := map[string]map[int64]int64{}
		for _, row := range rows {
			if row.ModelUrl == "" {
				continue
			}
			m, ok := byURL[row.ModelUrl]
			if !ok {
				name := strings.TrimSpace(row.Name)
				if name != "" && !strings.Contains(name, " ") {
					name = libraryName(name)
				}
				m = &LibraryModel{
					ID:         row.ID,
					Name:       name,
					ModelURL:   row.ModelUrl,
					Bytes:      row.Bytes,
					UploadedAt: api.FormatTime(row.CreatedAt),
					Uses:       []LibraryUse{},
				}
				byURL[row.ModelUrl] = m
				order = append(order, row.ModelUrl)
				zoneCounts[row.ModelUrl] = map[int64]int64{}
			}
			m.IDs = append(m.IDs, row.ID)
			if m.Thumbnail == "" {
				m.Thumbnail = row.Thumbnail
			}
			if m.UploadedZoneID == nil && row.ZoneID.Valid {
				m.UploadedZoneID = int64Ptr(row.ZoneID.Int64)
			}
			for _, u := range usesByID[row.ID] {
				var zone int64
				if u.ZoneID.Valid {
					zone = u.ZoneID.Int64
				}
				zoneCounts[row.ModelUrl][zone] += u.Cnt
			}
		}

		out := make([]LibraryModel, 0, len(order))
		for _, url := range order {
			m := byURL[url]
			for zone, n := range zoneCounts[url] {
				use := LibraryUse{Kind: "model", Count: n}
				if zone != 0 {
					use.ZoneID = int64Ptr(zone)
				}
				m.Uses = append(m.Uses, use)
			}
			sort.Slice(m.Uses, func(a, b int) bool { return m.Uses[a].Count > m.Uses[b].Count })
			out = append(out, *m)
		}
		sort.SliceStable(out, func(a, b int) bool { return out[a].UploadedAt > out[b].UploadedAt })
		api.JSON(w, http.StatusOK, out)
	}
}

// LibraryRouter is mounted at /api/v1/library.
func LibraryRouter(q *db.Queries, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Get("/images", listLibraryImages(q, s))
	r.Get("/models", listLibraryModels(q))
	return r
}
