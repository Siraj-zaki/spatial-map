package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// BulkAssignRequest is the body for POST /api/v1/bulk-assign. It moves
// N shapes across many kinds to a target warehouse and/or floor plan in
// a single round trip. The frontend previously fired one PATCH per shape
// per kind serially (`for (const id of ids) await apiDb.X.update(id, …)`),
// so a 200-item selection generated 200 sequential HTTP calls — long
// wall-clock, SSE storm, and heavy server load. This endpoint collapses
// that to one round trip per kind.
//
// Each field can be:
//
//   - **missing** — leave the column untouched on every listed row.
//   - **null** — clear the column (write NULL).
//   - **number** — assign the column to that id.
//
// This maps 1:1 to the tri-state UI the bulk-assign dialog exposes
// (Skip / Unassign / Assign to X). We can't collapse it into a single
// nullable field because `null` collides with the "clear" semantic —
// hence `json.RawMessage` on the two write-fields, so we can distinguish
// "absent" from "explicit null".
type BulkAssignRequest struct {
	ZoneID      json.RawMessage    `json:"zoneId,omitempty"`
	FloorPlanID json.RawMessage    `json:"floorPlanId,omitempty"`
	Kinds       map[string][]int64 `json:"kinds"`
}

// BulkAssignResponse reports how many rows were touched per kind. The
// value is the count of ids that actually existed AND belonged to the
// caller's tenant — anything else silently drops out of the UPDATE, so
// the caller can compare against the ids they sent to detect misses.
type BulkAssignResponse struct {
	Updated map[string]int `json:"updated"`
}

// Parse one of the two nullable write-fields into (set, value). See the
// struct-level comment above for the tri-state semantics.
func parseBulkAssignField(raw json.RawMessage) (set bool, value pgtype.Int8, err error) {
	if len(raw) == 0 {
		return false, pgtype.Int8{}, nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return true, pgtype.Int8{Valid: false}, nil
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil {
		return false, pgtype.Int8{}, err
	}
	return true, pgtype.Int8{Int64: n, Valid: true}, nil
}

// BulkAssignRouter mounts POST / on the /bulk-assign path.
func BulkAssignRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Post("/", bulkAssignHandler(q))
	return r
}

func bulkAssignHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var req BulkAssignRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		setZone, zoneID, err := parseBulkAssignField(req.ZoneID)
		if err != nil {
			api.BadRequest(w, "zoneId must be null or an integer")
			return
		}
		setFloor, floorPlanID, err := parseBulkAssignField(req.FloorPlanID)
		if err != nil {
			api.BadRequest(w, "floorPlanId must be null or an integer")
			return
		}
		if !setZone && !setFloor {
			// Nothing to do — reject rather than silently succeed so a
			// buggy client can surface the mistake instead of hanging
			// on a spinner that never resolves anything.
			api.BadRequest(w, "at least one of zoneId or floorPlanId must be present")
			return
		}
		if len(req.Kinds) == 0 {
			api.JSON(w, http.StatusOK, BulkAssignResponse{Updated: map[string]int{}})
			return
		}

		updated := make(map[string]int, len(req.Kinds))
		// One dispatch table keeps this handler flat instead of a
		// giant switch — each entry names the kind (both for the
		// request map key and the SSE broadcast) and the query that
		// runs the batched UPDATE. sqlc types diverge slightly per
		// table (different Params type) so we can't collapse into a
		// single function pointer, but a small closure per kind is
		// mechanical.
		ctx := r.Context()
		type kindEntry struct {
			name string
			run  func(ids []int64) ([]int64, error)
		}
		kinds := []kindEntry{
			{"polygon", func(ids []int64) ([]int64, error) {
				return q.BulkAssignPolygons(ctx, db.BulkAssignPolygonsParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"grid", func(ids []int64) ([]int64, error) {
				return q.BulkAssignGrids(ctx, db.BulkAssignGridsParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"marker", func(ids []int64) ([]int64, error) {
				return q.BulkAssignMarkers(ctx, db.BulkAssignMarkersParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"circle", func(ids []int64) ([]int64, error) {
				return q.BulkAssignCircles(ctx, db.BulkAssignCirclesParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"line", func(ids []int64) ([]int64, error) {
				return q.BulkAssignLines(ctx, db.BulkAssignLinesParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"model", func(ids []int64) ([]int64, error) {
				return q.BulkAssignModels(ctx, db.BulkAssignModelsParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"stair", func(ids []int64) ([]int64, error) {
				return q.BulkAssignStairs(ctx, db.BulkAssignStairsParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"text_label", func(ids []int64) ([]int64, error) {
				return q.BulkAssignTextLabels(ctx, db.BulkAssignTextLabelsParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"image", func(ids []int64) ([]int64, error) {
				return q.BulkAssignImages(ctx, db.BulkAssignImagesParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"door", func(ids []int64) ([]int64, error) {
				return q.BulkAssignDoors(ctx, db.BulkAssignDoorsParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
			{"image_plane", func(ids []int64) ([]int64, error) {
				return q.BulkAssignImagePlanes(ctx, db.BulkAssignImagePlanesParams{
					SetZone: setZone, ZoneID: zoneID,
					SetFloor: setFloor, FloorPlanID: floorPlanID,
					TenantID: tenantID, Ids: ids,
				})
			}},
		}

		// The client passes plural, hyphenated kind keys ("text-labels",
		// "image-planes") in some places and singular internal keys
		// elsewhere. Accept the plural form here (that's what the
		// dialog sends) and normalise to the singular used by
		// `sseEntityKind`.
		normalise := func(k string) string {
			switch k {
			case "polygons":
				return "polygon"
			case "grids":
				return "grid"
			case "markers":
				return "marker"
			case "circles":
				return "circle"
			case "lines":
				return "line"
			case "models":
				return "model"
			case "stairs":
				return "stair"
			case "text-labels", "text_labels":
				return "text_label"
			case "images":
				return "image"
			case "doors":
				return "door"
			case "image-planes", "image_planes", "image_plane":
				return "image_plane"
			}
			return k
		}

		for _, entry := range kinds {
			// Try both the singular kind name AND its plural (`kind + "s"`
			// or the dialog's exact wire key) so the endpoint accepts
			// either without requiring the client to match perfectly.
			var ids []int64
			for reqKind, reqIds := range req.Kinds {
				if normalise(reqKind) == entry.name {
					ids = append(ids, reqIds...)
				}
			}
			if len(ids) == 0 {
				continue
			}
			touched, err := entry.run(ids)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			updated[entry.name] = len(touched)
			// Broadcast one SSE event per updated row so any other
			// signed-in client picks up the changes. The SPA's SSE
			// handler just reloads the whole kind on any event, so
			// even one event per kind would be enough — but keeping
			// per-row events preserves the observability of exactly
			// which rows moved (visible in server logs / SSE inspector).
			//
			// Cheap: BroadcastEntityEvent is a non-blocking channel
			// send; slow subscribers just drop.
			kindPlural := sseEntityKind(entry.name)
			for _, id := range touched {
				BroadcastEntityEvent("ENTITY_UPDATED", kindPlural, id, tenantID)
			}
		}

		api.JSON(w, http.StatusOK, BulkAssignResponse{Updated: updated})
	}
}
