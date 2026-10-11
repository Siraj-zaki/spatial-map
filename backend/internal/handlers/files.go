package handlers

import (
	"context"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
)

// decodedFileKey pulls the `{key}` URL param and PathUnescape-s it so
// files whose names include spaces or other percent-encoded characters
// resolve correctly. chi.URLParam returns the raw path segment (never
// decodes), so `elevator%20(1).glb` would otherwise stay as-is and
// fail every downstream lookup — DB URL comparison AND object store
// Get/Delete both key on the ACTUAL bytes (with a literal space).
// Wrapping every extraction in this helper keeps the trap in one
// place.
func decodedFileKey(r *http.Request) string {
	raw := chi.URLParam(r, "key")
	dec, err := url.PathUnescape(raw)
	if err != nil {
		return raw
	}
	return dec
}

// FileReferenceResponse describes a DB row that references a stored
// file — one entry per row, so a file with two shape references gets
// two entries in the parent card's `referencedBy` list.
//
// `zoneId` / `zoneName` are set for shape kinds that have a warehouse
// (image, image_plane). `usedInZones` is populated only for
// kind === 'user_model' when the catalog entry has placements — a
// single catalog GLB placed in Hospital + Airport lists both, so the
// warehouse sidebar filter picks it up from either.
type FileReferenceResponse struct {
	Kind        string    `json:"kind"`
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	ZoneID      *int64    `json:"zoneId,omitempty"`
	ZoneName    string    `json:"zoneName,omitempty"`
	IsGhost     bool      `json:"isGhost"`
	UsedInZones []ZoneRef `json:"usedInZones,omitempty"`
}

// ZoneRef is a compact warehouse identifier used by UsedInZones on
// user_model references. Kept small because a popular catalog entry
// can be placed across many warehouses.
type ZoneRef struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// FileCardResponse is one entry in the Files gallery. Type is the
// filter bucket (fileType). Category is derived from the reference list
// ("missing" when referenced but gone from storage):
//   - "attached" — at least one reference where isGhost is false
//   - "ghost"    — all references are ghosts (no live warehouse binding)
//   - "orphan"   — no DB references at all
type FileCardResponse struct {
	Key          string                  `json:"key"`
	URL          string                  `json:"url"`
	Size         int64                   `json:"size"`
	ContentType  string                  `json:"contentType"`
	UploadedAt   string                  `json:"uploadedAt"`
	Category     string                  `json:"category"`
	Type         string                  `json:"type"`
	ReferencedBy []FileReferenceResponse `json:"referencedBy"`
}

// FilesRouter mounts the Files admin screen endpoints. Gated to
// owners/admins in the caller (see main.go's requireRole wrap).
func FilesRouter(q *db.Queries, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listFiles(q, s))
	r.Delete("/{key}", deleteFile(q, s))
	return r
}

// FilesListResponse is one page of the Files screen plus everything the
// header needs, so the client never has to load the full set to show
// totals. Mirrors the Data screen envelope ({rows,total,page,pageSize,
// stats}) with per-filter counts added.
//
//   - Stats        the whole tenant, ignoring every filter (KPIs, notices).
//   - StatusCounts each status tab under the current facility/q/type.
//   - TypeCounts   each type under the current facility/q/status.
//   - Facilities   every facility any of the tenant's files is used on.
type FilesListResponse struct {
	Rows         []FileCardResponse  `json:"rows"`
	Total        int                 `json:"total"`
	Page         int                 `json:"page"`
	PageSize     int                 `json:"pageSize"`
	Stats        FilesStats          `json:"stats"`
	StatusCounts map[string]int      `json:"statusCounts"`
	TypeCounts   map[string]int      `json:"typeCounts"`
	Facilities   []FacilityFileCount `json:"facilities"`
}

type FilesStats struct {
	Files        int   `json:"files"`
	Bytes        int64 `json:"bytes"`
	InUse        int   `json:"inUse"`
	InUseBytes   int64 `json:"inUseBytes"`
	Cleanup      int   `json:"cleanup"`
	CleanupBytes int64 `json:"cleanupBytes"`
	Leftovers    int   `json:"leftovers"`
	Missing      int   `json:"missing"`
	Models       int   `json:"models"`
	Facilities   int   `json:"facilities"`
}

type FacilityFileCount struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

var (
	fileStatuses = []string{"all", "inUse", "cleanup", "missing"}
	fileTypes    = []string{"floorplan", "plane", "model", "image", "other"}
	fileSorts    = map[string]bool{"newest": true, "oldest": true, "largest": true, "name": true}
)

// fileType classifies a card for the type filter. Reference kind wins (a
// PNG used as an image plane is an image plane); unreferenced files fall
// back to their content type. Mirrored by the card's `type` field so the
// client never re-derives it.
func fileType(card FileCardResponse) string {
	kinds := map[string]bool{}
	for _, r := range card.ReferencedBy {
		kinds[r.Kind] = true
	}
	switch {
	case kinds["image"]:
		return "floorplan"
	case kinds["image_plane"]:
		return "plane"
	case kinds["user_model"] || card.ContentType == "model/gltf-binary" || card.ContentType == "model/gltf+json":
		return "model"
	case strings.HasPrefix(card.ContentType, "image/"):
		return "image"
	default:
		return "other"
	}
}

func fileMatchesStatus(card FileCardResponse, status string) bool {
	switch status {
	case "inUse":
		return card.Category == "attached"
	case "cleanup":
		return card.Category == "ghost" || card.Category == "orphan"
	case "missing":
		return card.Category == "missing"
	default:
		return true
	}
}

// fileFacilities lists the warehouses a file appears on: the zone of an
// image / image plane, or every zone a catalog model is placed in.
func fileFacilities(card FileCardResponse) []ZoneRef {
	var out []ZoneRef
	seen := map[int64]bool{}
	add := func(id int64, name string) {
		if !seen[id] {
			seen[id] = true
			out = append(out, ZoneRef{ID: id, Name: name})
		}
	}
	for _, r := range card.ReferencedBy {
		if r.ZoneID != nil {
			add(*r.ZoneID, r.ZoneName)
		}
		for _, z := range r.UsedInZones {
			add(z.ID, z.Name)
		}
	}
	return out
}

func fileMatchesQuery(card FileCardResponse, needle string) bool {
	if needle == "" || strings.Contains(strings.ToLower(card.Key), needle) {
		return true
	}
	for _, r := range card.ReferencedBy {
		if strings.Contains(strings.ToLower(r.Name), needle) || strings.Contains(strings.ToLower(r.ZoneName), needle) {
			return true
		}
		for _, z := range r.UsedInZones {
			if strings.Contains(strings.ToLower(z.Name), needle) {
				return true
			}
		}
	}
	return false
}

// displayName drops the content-hash suffix(es) from a storage key so the
// "name" sort orders by what people see (`plan-1a2b…c3.png` → `plan.png`).
var hashSuffix = regexp.MustCompile(`(?i)(-[0-9a-f]{12,})+(\.[a-z0-9]+)$`)

func displayName(key string) string {
	return strings.ToLower(hashSuffix.ReplaceAllString(key, "$2"))
}

// listFiles returns one page of the tenant's files. A file is the
// tenant's when the tenant uploaded it (tenant_files) or one of its rows
// references it — nothing else. Objects nobody owns or references (old
// uploads from before ownership was recorded) are visible to no tenant;
// cmd/cleanup-orphans sweeps them.
//
// Query: status=all|inUse|cleanup|missing, type=floorplan|plane|model|
// image|other, facility=<zoneId>, q=<search>, sort=newest|oldest|
// largest|name, page (1-based) or offset, pageSize (≤ 200, default 24).
func listFiles(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireRole(w, r, q, RoleOwner, RoleAdmin) {
			return
		}
		ctx := r.Context()
		tenantID := api.TenantID(ctx)

		refs, err := q.ListFileReferencesByTenant(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		placements, err := q.ListUserModelPlacementsByTenant(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		owned, err := q.ListTenantFiles(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		// Avatars are profile data, not warehouse assets — never listed
		// (deleting one here used to be a silent no-op; see deleteFile).
		avatarURLs, err := q.ListAvatarURLsByTenant(ctx, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		avatarKeys := make(map[string]bool, len(avatarURLs))
		for _, u := range avatarURLs {
			avatarKeys[store.KeyFromURL(u)] = true
		}

		// user_model id → deduped warehouses the model is placed in.
		userModelZones := make(map[int64][]ZoneRef, len(placements))
		userModelSeen := make(map[int64]map[int64]bool, len(placements))
		for _, p := range placements {
			if !p.ZoneID.Valid {
				continue
			}
			if userModelSeen[p.UserModelID] == nil {
				userModelSeen[p.UserModelID] = map[int64]bool{}
			}
			if userModelSeen[p.UserModelID][p.ZoneID.Int64] {
				continue
			}
			userModelSeen[p.UserModelID][p.ZoneID.Int64] = true
			userModelZones[p.UserModelID] = append(userModelZones[p.UserModelID], ZoneRef{ID: p.ZoneID.Int64, Name: p.ZoneName.String})
		}

		byKey := make(map[string][]FileReferenceResponse, len(refs))
		for _, ref := range refs {
			key := store.KeyFromURL(ref.FileUrl)
			if key == "" {
				continue
			}
			entry := FileReferenceResponse{Kind: ref.Kind, ID: ref.RefID, Name: ref.RefName, IsGhost: ref.IsGhost}
			if ref.ZoneID.Valid {
				zid := ref.ZoneID.Int64
				entry.ZoneID = &zid
			}
			if ref.ZoneName.Valid {
				entry.ZoneName = ref.ZoneName.String
			}
			if ref.Kind == "user_model" {
				entry.UsedInZones = userModelZones[ref.RefID]
			}
			byKey[key] = append(byKey[key], entry)
		}

		ownedByKey := make(map[string]db.ListTenantFilesRow, len(owned))
		for _, o := range owned {
			ownedByKey[o.ObjectKey] = o
		}

		objects, err := s.ListObjects(ctx)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		objByKey := make(map[string]store.ObjectInfo, len(objects))
		for _, o := range objects {
			objByKey[o.Key] = o
		}

		// The tenant's file set: owned ∪ referenced.
		keys := make(map[string]bool, len(ownedByKey)+len(byKey))
		for k := range ownedByKey {
			keys[k] = true
		}
		for k := range byKey {
			keys[k] = true
		}

		all := make([]FileCardResponse, 0, len(keys))
		for key := range keys {
			if avatarKeys[key] {
				continue
			}
			fileRefs := byKey[key]
			if fileRefs == nil {
				fileRefs = []FileReferenceResponse{}
			}
			card := FileCardResponse{
				Key:          key,
				URL:          "/files/" + key,
				ContentType:  guessContentType(key),
				ReferencedBy: fileRefs,
			}
			if obj, ok := objByKey[key]; ok {
				card.Size = obj.Size
				card.UploadedAt = obj.UploadedAt.UTC().Format(time.RFC3339)
				card.Category = categorizeFile(fileRefs)
			} else if len(fileRefs) > 0 {
				// Referenced but gone from storage: shows blank on the map.
				card.Category = "missing"
			} else {
				// Owned upload whose object has since been reclaimed. Not
				// pruned here: a store that lists only partially (the
				// MinIO→disk fallback when one side errors) would drop
				// live rows.
				continue
			}
			card.Type = fileType(card)
			all = append(all, card)
		}

		// ---- stats over the whole tenant -------------------------------
		var stats FilesStats
		inUseFacilities := map[int64]bool{}
		facilityCounts := map[int64]*FacilityFileCount{}
		for _, c := range all {
			stats.Files++
			stats.Bytes += c.Size
			if c.Type == "model" {
				stats.Models++
			}
			switch c.Category {
			case "attached":
				stats.InUse++
				stats.InUseBytes += c.Size
			case "ghost":
				stats.Cleanup++
				stats.CleanupBytes += c.Size
				stats.Leftovers++
			case "orphan":
				stats.Cleanup++
				stats.CleanupBytes += c.Size
			case "missing":
				stats.Missing++
			}
			for _, z := range fileFacilities(c) {
				if c.Category == "attached" {
					inUseFacilities[z.ID] = true
				}
				if fc := facilityCounts[z.ID]; fc != nil {
					fc.Count++
				} else {
					facilityCounts[z.ID] = &FacilityFileCount{ID: z.ID, Name: z.Name, Count: 1}
				}
			}
		}
		stats.Facilities = len(inUseFacilities)
		facilities := make([]FacilityFileCount, 0, len(facilityCounts))
		for _, fc := range facilityCounts {
			facilities = append(facilities, *fc)
		}
		sort.Slice(facilities, func(i, j int) bool { return strings.ToLower(facilities[i].Name) < strings.ToLower(facilities[j].Name) })

		// ---- filters ----------------------------------------------------
		qs := r.URL.Query()
		status := qs.Get("status")
		if !slices.Contains(fileStatuses, status) {
			status = "all"
		}
		typ := qs.Get("type")
		if !slices.Contains(fileTypes, typ) {
			typ = ""
		}
		var facility int64
		if v, err := strconv.ParseInt(qs.Get("facility"), 10, 64); err == nil {
			facility = v
		}
		needle := strings.ToLower(strings.TrimSpace(qs.Get("q")))
		sortBy := qs.Get("sort")
		if !fileSorts[sortBy] {
			sortBy = "newest"
		}

		base := make([]FileCardResponse, 0, len(all))
		for _, c := range all {
			if facility != 0 && !slices.ContainsFunc(fileFacilities(c), func(z ZoneRef) bool { return z.ID == facility }) {
				continue
			}
			if !fileMatchesQuery(c, needle) {
				continue
			}
			base = append(base, c)
		}
		statusCounts := make(map[string]int, len(fileStatuses))
		typeCounts := make(map[string]int, len(fileTypes))
		var rows []FileCardResponse
		for _, c := range base {
			typeOK := typ == "" || c.Type == typ
			statusOK := fileMatchesStatus(c, status)
			if typeOK {
				for _, st := range fileStatuses {
					if fileMatchesStatus(c, st) {
						statusCounts[st]++
					}
				}
			}
			if statusOK {
				typeCounts[c.Type]++
			}
			if typeOK && statusOK {
				rows = append(rows, c)
			}
		}

		// ---- sort + page ------------------------------------------------
		sort.SliceStable(rows, func(i, j int) bool {
			a, b := rows[i], rows[j]
			switch sortBy {
			case "oldest":
				// Missing files have no upload time — last either way.
				if (a.UploadedAt == "") != (b.UploadedAt == "") {
					return b.UploadedAt == ""
				}
				if a.UploadedAt != b.UploadedAt {
					return a.UploadedAt < b.UploadedAt
				}
			case "largest":
				if a.Size != b.Size {
					return a.Size > b.Size
				}
			case "name":
				if an, bn := displayName(a.Key), displayName(b.Key); an != bn {
					return an < bn
				}
			default:
				if a.UploadedAt != b.UploadedAt {
					return a.UploadedAt > b.UploadedAt
				}
			}
			return a.Key < b.Key
		})
		page := api.IntQuery(r, "page", 1)
		if page < 1 {
			page = 1
		}
		pageSize := api.IntQuery(r, "pageSize", 24)
		if pageSize < 1 {
			pageSize = 24
		}
		pageSize = clampPageSize(pageSize)
		total := len(rows)
		start := min((page-1)*pageSize, total)
		// `offset` wins over `page`: the client's "Load more" asks for the
		// rows after the ones it holds, which stays correct after a delete
		// shifts every page boundary.
		if off := api.IntQuery(r, "offset", -1); off >= 0 {
			start = min(off, total)
			page = off/pageSize + 1
		}
		end := min(start+pageSize, total)
		pageRows := rows[start:end]
		if pageRows == nil {
			pageRows = []FileCardResponse{}
		}

		api.JSON(w, http.StatusOK, FilesListResponse{
			Rows:         pageRows,
			Total:        total,
			Page:         page,
			PageSize:     pageSize,
			Stats:        stats,
			StatusCounts: statusCounts,
			TypeCounts:   typeCounts,
			Facilities:   facilities,
		})
	}
}

// deleteFile removes an object-store file. Semantics:
//   - "attached" (any live reference): refuses with 409, so the UI
//     redirects the admin to delete the shape/warehouse instead.
//   - "ghost" (all references are ghost rows): deletes the ghost rows
//     from the DB, then the file. The rows are gone so the file's
//     refcount hits zero.
//   - "orphan" (no references): deletes the file only.
//   - not the tenant's (neither owned nor referenced by it): 404.
//
// The tenant's ownership row goes either way; the object itself is only
// removed when no other tenant owns it and no row anywhere references it.
func deleteFile(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireRole(w, r, q, RoleOwner, RoleAdmin) {
			return
		}
		tenantID := api.TenantID(r.Context())
		key := decodedFileKey(r)
		if key == "" {
			api.BadRequest(w, "missing key")
			return
		}
		fileURL := "/files/" + key

		// Belt-and-braces: even though the gallery excludes avatar
		// URLs, a stale client (or a direct API call) could still
		// aim DELETE at one. cleanupObjectURL would silently no-op
		// (refcount > 0) and the caller would see 204 with no
		// effect. Refuse explicitly so the user gets an actionable
		// error.
		avatarURLs, err := q.ListAvatarURLsByTenant(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		for _, av := range avatarURLs {
			if av == fileURL {
				api.Error(w, http.StatusConflict, "file is a user avatar — delete from the Profile screen instead")
				return
			}
		}

		refs, err := q.ListFileReferencesByTenant(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		var forFile []db.ListFileReferencesByTenantRow
		for _, ref := range refs {
			if ref.FileUrl == fileURL {
				forFile = append(forFile, ref)
			}
		}

		// Only the tenant's own files: uploaded by it, or referenced by
		// its rows. Anything else is another workspace's (or nobody's) —
		// answer as if it doesn't exist rather than revealing it does.
		owned, err := q.TenantOwnsFile(r.Context(), db.TenantOwnsFileParams{TenantID: tenantID, ObjectKey: key})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if len(forFile) == 0 && !owned {
			api.NotFound(w, "file not found")
			return
		}

		hasLive := false
		for _, ref := range forFile {
			if !ref.IsGhost {
				hasLive = true
				break
			}
		}
		if hasLive {
			api.Error(w, http.StatusConflict, "file is attached to a live warehouse — delete the shape or warehouse first")
			return
		}

		// Delete any ghost rows pointing at the file so the refcount
		// hits zero. Each kind has its own DELETE query keyed on the
		// tenant + URL. Errors don't abort — the primary intent is
		// reclaiming the file, and the sweeper will catch stragglers.
		if err := deleteGhostRowsForFile(r.Context(), q, tenantID, fileURL); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// Drop this tenant's ownership. If another workspace uploaded the
		// same bytes (keys are content-addressed, so it's the same object),
		// the object stays for them — it has only left this tenant's list.
		if err := q.DeleteTenantFile(r.Context(), db.DeleteTenantFileParams{TenantID: tenantID, ObjectKey: key}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		otherOwners, err := q.CountTenantFileOwners(r.Context(), key)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if otherOwners == 0 {
			// cleanupObjectURL refcount-checks every URL column, so it's
			// the right primitive even though our ghost rows are gone —
			// a row in another tenant still keeps the object.
			if err := cleanupObjectURL(r.Context(), q, s, fileURL); err != nil {
				api.InternalError(w, r, err)
				return
			}
		}
		// Broadcast so other open tabs / windows re-fetch the Files
		// screen without needing a manual refresh. Kind is synthetic —
		// the Files screen listens for the "files" kind specifically
		// (see src/routes/files.tsx SSE subscription).
		BroadcastEntityEvent("ENTITY_DELETED", "files", 0, tenantID)
		api.JSON(w, http.StatusNoContent, nil)
	}
}

// deleteGhostRowsForFile removes every ghost DB row that references
// the given URL — image_url with zone_id NULL, image_planes.image_url
// with zone_id NULL, or user_models.model_url with zero placements.
func deleteGhostRowsForFile(ctx context.Context, q *db.Queries, tenantID int64, url string) error {
	imageIDs, err := q.ListGhostImageIDsByTenant(ctx, db.ListGhostImageIDsByTenantParams{TenantID: tenantID, FileUrl: url})
	if err != nil {
		return err
	}
	if len(imageIDs) > 0 {
		if err := q.DeleteImagesByIDs(ctx, db.DeleteImagesByIDsParams{TenantID: tenantID, Ids: imageIDs}); err != nil {
			return err
		}
	}
	planeIDs, err := q.ListGhostImagePlaneIDsByTenant(ctx, db.ListGhostImagePlaneIDsByTenantParams{TenantID: tenantID, FileUrl: url})
	if err != nil {
		return err
	}
	if len(planeIDs) > 0 {
		if err := q.DeleteImagePlanesByIDs(ctx, db.DeleteImagePlanesByIDsParams{TenantID: tenantID, Ids: planeIDs}); err != nil {
			return err
		}
	}
	modelIDs, err := q.ListGhostUserModelIDsByTenant(ctx, db.ListGhostUserModelIDsByTenantParams{TenantID: tenantID, FileUrl: url})
	if err != nil {
		return err
	}
	if len(modelIDs) > 0 {
		if err := q.DeleteUserModelsByIDs(ctx, db.DeleteUserModelsByIDsParams{TenantID: tenantID, Ids: modelIDs}); err != nil {
			return err
		}
	}
	return nil
}

func categorizeFile(refs []FileReferenceResponse) string {
	if len(refs) == 0 {
		return "orphan"
	}
	for _, ref := range refs {
		if !ref.IsGhost {
			return "attached"
		}
	}
	return "ghost"
}

// guessContentType maps common extensions to a MIME type. mime.TypeByExtension
// covers most cases from the OS registry; the fallback branch handles GLB
// which isn't in every registry by default.
func guessContentType(key string) string {
	ext := strings.ToLower(filepath.Ext(key))
	if ext == "" {
		return "application/octet-stream"
	}
	ct := mime.TypeByExtension(ext)
	if ct != "" {
		return ct
	}
	switch ext {
	case ".glb":
		return "model/gltf-binary"
	case ".gltf":
		return "model/gltf+json"
	default:
		return "application/octet-stream"
	}
}
