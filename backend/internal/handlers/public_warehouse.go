package handlers

import (
	"net/http"
	"sync"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// WarehouseView is the public, read-only envelope returned by the
// shareable presentation view. It bundles a zone with every child shape
// and grid-attached bin so the viewer can render the full layout in one
// round-trip without an API key.
//
// Slice 6c2 of the data-link refactor removed the per-entity live-data
// rosters (assets / sensors / cameras / shipments) from the envelope
// alongside the deletion of the per-entity handlers + tables. Public
// visitors no longer see live records; authenticated viewers fetch
// them via the tenant-wide `GET /api/v1/entity-states` endpoint.
type WarehouseView struct {
	Zone        ZoneResponse  `json:"zone"`
	Grids       []any         `json:"grids"`
	Polygons    []any         `json:"polygons"`
	Circles     []any         `json:"circles"`
	Lines       []any         `json:"lines"`
	Routes      []any         `json:"routes"`
	Markers     []any         `json:"markers"`
	Images      []any         `json:"images"`
	Models      []any         `json:"models"`
	ImagePlanes []any         `json:"imagePlanes"`
	TextLabels  []any         `json:"textLabels"`
	Stairs      []any         `json:"stairs"`
	Doors       []any         `json:"doors"`
	Bins        []BinResponse `json:"bins"`
	// Data-link configs and style rules scoped to this warehouse. Added
	// so the shareable-presentation viewer can render the same live-data
	// overlays and per-shape style resolutions the authed viewer would.
	// Without them, a shared link would show geometry but no data widgets
	// even when the configs were toggled ON in the share dialog.
	DataLinkConfigs []any `json:"dataLinkConfigs"`
	StyleRules      []any `json:"styleRules"`
}

// buildWarehouseView assembles the full public envelope from a resolved
// zone row. Shared by the ID-based and token-based handlers so both paths
// return identical payloads. Returns 404 when the warehouse is private —
// callers should treat that as "act as if the warehouse doesn't exist"
// so an unauthenticated visitor can't distinguish a private warehouse
// from a missing one.
func buildWarehouseView(q *db.Queries, w http.ResponseWriter, r *http.Request, zone db.CreateZoneRow, ok bool) {
	view, valid := buildWarehouseViewPayload(q, r, zone, ok)
	if !valid {
		api.NotFound(w, "warehouse not found")
		return
	}
	api.JSON(w, http.StatusOK, view)
}

// buildWarehouseViewPayload is the response-less variant. Callers that
// need to nest the WarehouseView inside a richer envelope (e.g. the
// share_links public endpoint) use this to skip the JSON write.
// Returns (view, true) on success or (zero, false) when the warehouse
// is private / any child query failed — the caller should treat both
// failure modes as 404 so an unauthenticated visitor can't tell them
// apart.
func buildWarehouseViewPayload(q *db.Queries, r *http.Request, zone db.CreateZoneRow, ok bool) (WarehouseView, bool) {
	if !ok {
		return WarehouseView{}, false
	}

	zoneID := pgtype.Int8{Int64: zone.ID, Valid: true}
	ctx := r.Context()

	var (
		grids           []db.Grid
		polygons        []db.Polygon
		circles         []db.Circle
		lines           []db.Line
		routes          []db.Route
		markers         []db.Marker
		images          []db.Image
		models          []db.Model
		imagePlanes     []db.ImagePlane
		textLabels      []db.TextLabel
		stairs          []db.Stair
		doors           []db.Door
		bins            []db.Bin
		dataLinkConfigs []db.DataLinkConfig
		styleRules      []db.StyleRule
	)

	var (
		gErr, pErr, cErr, lErr, rErr, mErr, iErr, moErr, ipErr, tErr, sErr, dErr, bErr, dlErr, srErr error
	)

	var wg sync.WaitGroup
	wg.Add(15)
	go func() { defer wg.Done(); grids, gErr = q.ListGridsByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); polygons, pErr = q.ListPolygonsByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); circles, cErr = q.ListCirclesByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); lines, lErr = q.ListLinesByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); routes, rErr = q.ListRoutesByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); markers, mErr = q.ListMarkersByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); images, iErr = q.ListImagesByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); models, moErr = q.ListModelsByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); imagePlanes, ipErr = q.ListImagePlanesByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); textLabels, tErr = q.ListTextLabelsByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); stairs, sErr = q.ListStairsByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); doors, dErr = q.ListDoorsByZone(ctx, zoneID) }()
	go func() { defer wg.Done(); bins, bErr = q.ListBinsByGridZone(ctx, zoneID) }()
	// Data-link configs use `zone_id BIGINT` (not nullable) so the sqlc
	// signature is plain int64 — pass zone.ID directly rather than the
	// pgtype.Int8 the shape queries use.
	go func() { defer wg.Done(); dataLinkConfigs, dlErr = q.ListDataLinkConfigsByZone(ctx, zone.ID) }()
	go func() {
		defer wg.Done()
		styleRules, srErr = q.ListStyleRulesByZone(ctx, db.ListStyleRulesByZoneParams{
			TenantID: zone.TenantID,
			ZoneID:   zoneID,
		})
	}()
	wg.Wait()

	// Surface the first query failure. Empty results are fine; errors are not.
	for _, e := range []error{gErr, pErr, cErr, lErr, rErr, mErr, iErr, moErr, ipErr, tErr, sErr, dErr, bErr, dlErr, srErr} {
		if e != nil {
			// The caller decides how to surface the error — the JSON-writing
			// path (buildWarehouseView) already logs via api.InternalError
			// before responding. The payload-only path returns a 404 through
			// the second return value so the /share/{token} endpoint stays
			// leak-free.
			return WarehouseView{}, false
		}
	}

	view := WarehouseView{
		Zone:            zoneRowToResponse(zone.ID, zone.TenantID, zone.Name, zone.Color, zone.Description, zone.CenterLng, zone.CenterLat, zone.Address, zone.DefaultView, zone.ShareToken, zone.IsPublic, zone.CreatedAt, zone.UpdatedAt),
		Grids:           make([]any, 0, len(grids)),
		Polygons:        make([]any, 0, len(polygons)),
		Circles:         make([]any, 0, len(circles)),
		Lines:           make([]any, 0, len(lines)),
		Routes:          make([]any, 0, len(routes)),
		Markers:         make([]any, 0, len(markers)),
		Images:          make([]any, 0, len(images)),
		Models:          make([]any, 0, len(models)),
		ImagePlanes:     make([]any, 0, len(imagePlanes)),
		TextLabels:      make([]any, 0, len(textLabels)),
		Stairs:          make([]any, 0, len(stairs)),
		Doors:           make([]any, 0, len(doors)),
		Bins:            make([]BinResponse, 0, len(bins)),
		DataLinkConfigs: make([]any, 0, len(dataLinkConfigs)),
		StyleRules:      make([]any, 0, len(styleRules)),
	}
	for _, row := range grids {
		view.Grids = append(view.Grids, toGridResponse(row))
	}
	for _, row := range polygons {
		view.Polygons = append(view.Polygons, toPolygonResponse(row))
	}
	for _, row := range circles {
		view.Circles = append(view.Circles, toCircleResponse(row))
	}
	for _, row := range lines {
		view.Lines = append(view.Lines, toLineResponse(row))
	}
	for _, row := range routes {
		view.Routes = append(view.Routes, toRouteResponse(row))
	}
	for _, m := range markers {
		view.Markers = append(view.Markers, toMarkerResponse(m))
	}
	for _, row := range images {
		view.Images = append(view.Images, toImageResponse(row))
	}
	for _, row := range models {
		view.Models = append(view.Models, toModelResponse(row))
	}
	for _, row := range imagePlanes {
		view.ImagePlanes = append(view.ImagePlanes, toImagePlaneResponse(row))
	}
	for _, row := range textLabels {
		view.TextLabels = append(view.TextLabels, toTextLabelResponse(row))
	}
	for _, row := range stairs {
		view.Stairs = append(view.Stairs, toStairResponse(row))
	}
	for _, row := range doors {
		view.Doors = append(view.Doors, toDoorResponse(row))
	}
	for _, row := range bins {
		view.Bins = append(view.Bins, toBinResponse(row))
	}
	for _, row := range dataLinkConfigs {
		view.DataLinkConfigs = append(view.DataLinkConfigs, toDataLinkConfigResponse(row))
	}
	for _, row := range styleRules {
		view.StyleRules = append(view.StyleRules, toStyleRuleResponse(row))
	}

	// Slice 6c2 removed the live-data fan-out (assets / sensors /
	// cameras / shipments) from this envelope; authenticated viewers
	// hit `/api/v1/entity-states` instead.

	return view, true
}

// GetPublicWarehouse returns the full, shareable presentation envelope for a
// zone identified by its numeric ID. Mounted outside the APIKeyMiddleware
// group so anyone with the warehouse ID can open the view; the SPA's public
// client sends no auth headers. Returns 404 when `is_public = false` so a
// leaked numeric link can be killed without rotating the ID.
func GetPublicWarehouse(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		zoneRow, err := q.GetZoneByID(r.Context(), id)
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "warehouse not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}

		buildWarehouseView(q, w, r, db.CreateZoneRow(zoneRow), zoneRow.IsPublic)
	}
}

// GetPublicWarehouseByToken resolves a warehouse by its unguessable share
// token. This is the primary share-link target: the dashboard hands out
// `/share/<token>` URLs instead of numeric IDs so links can be rotated
// without changing the warehouse ID, and so a leaked token can be killed
// by either toggling `is_public` to false or regenerating the token.
func GetPublicWarehouseByToken(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := chi.URLParam(r, "token")
		if token == "" {
			api.BadRequest(w, "missing token")
			return
		}

		zoneRow, err := q.GetZoneByShareToken(r.Context(), pgtype.Text{String: token, Valid: true})
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "warehouse not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}

		buildWarehouseView(q, w, r, db.CreateZoneRow(zoneRow), zoneRow.IsPublic)
	}
}
