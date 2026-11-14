package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports/specmigrate"
	v2 "github.com/Siraj-zaki/spatial-map/backend/internal/reports/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------------------------------------------------------------------------
// Report share links — a public, read-only link to one report
//
// Signed in (tenant group, under /api/v1/reports):
//
//   * GET  /reports/{id}/share-links      → the report's links
//   * POST /reports/{id}/share-links      → issue a link
//
// Editing, revoking and deleting reuse /api/v1/share-links/{id}.
//
// Public (no auth, /api/v1/public/report-share/{token}):
//
//   * GET  /                                → { link, report, facility } (counts a view)
//   * POST /run                             → the report's queries
//   * GET  /history?sourceId=               → a History widget
//   * GET  /sources/{sourceId}/rows         → a map layer's rows
//   * POST /sources/{sourceId}/query        → a map layer's rows, filtered
//   * GET  /sources/{sourceId}/events       → the history player
//   * GET  /sources/{sourceId}/events/{key} → one row's trail
//   * GET  /sources/{sourceId}/fields       → a source's fields
//
// The token stands in for a signed-in user: it resolves the tenant and the
// report, and the source routes answer only for sources the report itself
// reads (its queries, History widgets and map layers). Every failure is a
// 404, as with facility links. Anonymous runs are not written to
// report_runs, and events leave out who wrote them.
// ---------------------------------------------------------------------------

// PublicReportShareResponse is what GET /public/report-share/{token} returns.
type PublicReportShareResponse struct {
	Link   PublicShareLink `json:"link"`
	Report ReportResponse  `json:"report"`
	// Facility is the map the report's facility explorer draws on — its
	// shapes, floors, the report's data layers and the 3D models placed
	// there. Omitted for a report with no map.
	Facility *PublicReportFacility `json:"facility,omitempty"`
}

// PublicReportFacility is a facility trimmed to what a shared report shows.
type PublicReportFacility struct {
	Warehouse  WarehouseView       `json:"warehouse"`
	UserModels []UserModelResponse `json:"userModels"`
}

// reportShare is a resolved, live report link.
type reportShare struct {
	link   db.ShareLink
	report db.Report
	spec   v2.Spec
	// sources the report reads; dataLinks its explorer's map layers.
	sources   map[int64]bool
	dataLinks map[int64]bool
	// mapZoneID is the facility the explorer draws (0 = no map).
	mapZoneID int64
}

// shareWidgetBindings is the part of a widget's bindings that names data:
// a History widget's source, a facility explorer's facility and tabs.
type shareWidgetBindings struct {
	SourceID int64 `json:"sourceId"`
	ZoneID   int64 `json:"zoneId"`
	Tabs     []struct {
		SourceID   int64 `json:"sourceId"`
		DataLinkID int64 `json:"dataLinkId"`
	} `json:"tabs"`
}

// resolveReportShare loads the link, its report and what the report reads.
// `opening` = the page load (the view cap applies strictly); otherwise a
// data call from a page already open. Writes the 404 itself.
func resolveReportShare(w http.ResponseWriter, r *http.Request, q *db.Queries, opening bool) (reportShare, bool) {
	token := chi.URLParam(r, "token")
	if token == "" {
		api.NotFound(w, "share link not found")
		return reportShare{}, false
	}
	var link db.ShareLink
	var err error
	if opening {
		link, err = q.GetReportShareLinkByToken(r.Context(), token)
	} else {
		link, err = q.GetReportShareLinkForData(r.Context(), token)
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			api.NotFound(w, "share link not found")
			return reportShare{}, false
		}
		api.InternalError(w, r, err)
		return reportShare{}, false
	}
	row, err := q.GetReport(r.Context(), db.GetReportParams{ID: link.ReportID.Int64, TenantID: link.TenantID})
	if err != nil || row.IsArchived {
		api.NotFound(w, "share link not found")
		return reportShare{}, false
	}
	mig, err := specmigrate.FromRaw(row.Spec, row.SpecVersion)
	if err != nil {
		api.NotFound(w, "share link not found")
		return reportShare{}, false
	}
	sh := reportShare{link: link, report: row, spec: mig.Spec, sources: map[int64]bool{}, dataLinks: map[int64]bool{}}
	if err := sh.collectSources(r.Context(), q); err != nil {
		api.InternalError(w, r, err)
		return reportShare{}, false
	}
	return sh, true
}

// collectSources fills sources / dataLinks / mapZoneID from the spec.
func (sh *reportShare) collectSources(ctx context.Context, q *db.Queries) error {
	for _, s := range sh.spec.Sources {
		sh.sources[s.ID] = true
	}
	for _, qq := range sh.spec.Queries {
		sh.sources[qq.SourceRef.ID] = true
	}
	for _, wd := range sh.spec.Widgets {
		if len(wd.Bindings) == 0 {
			continue
		}
		var b shareWidgetBindings
		// A binding of another type (some widget kinds use the same keys
		// differently) just leaves that field unset.
		_ = json.Unmarshal(wd.Bindings, &b)
		switch wd.Kind {
		case "history":
			if b.SourceID > 0 {
				sh.sources[b.SourceID] = true
			}
		case "facilityExplorer":
			if sh.mapZoneID == 0 && b.ZoneID > 0 {
				sh.mapZoneID = b.ZoneID
			}
			for _, tab := range b.Tabs {
				if tab.SourceID > 0 {
					sh.sources[tab.SourceID] = true
				}
				if tab.DataLinkID > 0 {
					sh.dataLinks[tab.DataLinkID] = true
				}
			}
		}
	}
	if sh.mapZoneID == 0 && sh.report.ZoneID.Valid && len(sh.dataLinks) > 0 {
		sh.mapZoneID = sh.report.ZoneID.Int64
	}
	// A map layer reads its data link's source.
	for id := range sh.dataLinks {
		cfg, err := q.GetDataLinkConfig(ctx, db.GetDataLinkConfigParams{ID: id, TenantID: sh.link.TenantID})
		if errors.Is(err, pgx.ErrNoRows) {
			delete(sh.dataLinks, id)
			continue
		}
		if err != nil {
			return err
		}
		if cfg.SourceID.Valid {
			sh.sources[cfg.SourceID.Int64] = true
		}
	}
	return nil
}

// toPublicShareLink is the visitor-safe part of a link row.
func toPublicShareLink(link db.ShareLink, viewCount int64) PublicShareLink {
	out := PublicShareLink{
		Label:     link.Label,
		Settings:  defaultJSONObject(link.Settings),
		ViewCount: viewCount,
		IssuedAt:  api.FormatTime(link.CreatedAt),
	}
	if link.ExpiresAt.Valid {
		out.ExpiresAt = link.ExpiresAt.Time.Format(time.RFC3339)
	}
	if link.MaxViews.Valid {
		v := link.MaxViews.Int64
		out.MaxViews = &v
	}
	return out
}

// publicReportShareHandler — GET /public/report-share/{token}.
func publicReportShareHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sh, ok := resolveReportShare(w, r, q, true)
		if !ok {
			return
		}
		// Counted before the body is built, as facility links do; a failure
		// here only loses the count.
		_ = q.IncrementShareLinkView(r.Context(), sh.link.ID)

		report := toReportResponse(sh.report, false)
		report.CreatedBy = 0
		resp := PublicReportShareResponse{
			Link:   toPublicShareLink(sh.link, sh.link.ViewCount+1),
			Report: report,
		}
		if sh.mapZoneID != 0 {
			facility, err := reportShareFacility(r, q, sh)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			resp.Facility = facility
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

// reportShareFacility builds the explorer's map: the facility's shapes and
// floors, only the report's own data layers, and the uploaded 3D models
// placed there. Nil when the facility is gone.
func reportShareFacility(r *http.Request, q *db.Queries, sh reportShare) (*PublicReportFacility, error) {
	zoneRow, err := q.GetZone(r.Context(), db.GetZoneParams{ID: sh.mapZoneID, TenantID: sh.link.TenantID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// A report link doesn't depend on the facility being public: the
	// report's editor chose to share this view.
	view, ok := buildWarehouseViewPayload(q, r, db.CreateZoneRow(zoneRow), true)
	if !ok {
		return nil, errors.New("facility view failed")
	}
	// The facility's own share token would open the whole facility.
	view.Zone.ShareToken = ""
	links := make([]any, 0, len(sh.dataLinks))
	for _, l := range view.DataLinkConfigs {
		if c, ok := l.(DataLinkConfigResponse); ok && sh.dataLinks[c.ID] {
			links = append(links, l)
		}
	}
	view.DataLinkConfigs = links

	models, err := q.ListModelsByZone(r.Context(), pgtype.Int8{Int64: sh.mapZoneID, Valid: true})
	if err != nil {
		return nil, err
	}
	used := map[string]bool{}
	for _, m := range models {
		var cfg struct {
			ModelAssetID string `json:"modelAssetId"`
		}
		if json.Unmarshal(m.Config, &cfg) == nil && strings.HasPrefix(cfg.ModelAssetID, "user_") {
			used[cfg.ModelAssetID] = true
		}
	}
	userModels := []UserModelResponse{}
	if len(used) > 0 {
		all, err := q.ListUserModels(r.Context(), sh.link.TenantID)
		if err != nil {
			return nil, err
		}
		for _, um := range all {
			if !used["user_"+strconv.FormatInt(um.ID, 10)] {
				continue
			}
			resp := toUserModelResponse(um)
			resp.Data = "" // legacy inline bytes stay private; the file URL serves it
			userModels = append(userModels, resp)
		}
	}
	return &PublicReportFacility{Warehouse: view, UserModels: userModels}, nil
}

// publicReportShareRunHandler — POST /public/report-share/{token}/run.
func publicReportShareRunHandler(q *db.Queries, executor *reports.Executor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sh, ok := resolveReportShare(w, r, q, false)
		if !ok {
			return
		}
		var req RunReportRequest
		_ = api.DecodeBody(r, &req) // body optional
		runStoredReport(w, r, q, executor, sh.link.TenantID, sh.report, 0, req, false)
	}
}

// publicReportShareHistoryHandler — GET /public/report-share/{token}/history.
func publicReportShareHistoryHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sh, ok := resolveReportShare(w, r, q, false)
		if !ok {
			return
		}
		sourceID := int64(api.Int64Query(r, "sourceId", 0))
		if !sh.sources[sourceID] {
			api.NotFound(w, "source not found")
			return
		}
		serveReportHistory(w, r, q, sh.link.TenantID, sourceID)
	}
}

// reportShareSource guards /sources/{sourceId}/…: a live link, and a source
// the report reads.
func reportShareSource(q *db.Queries, serve func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sh, ok := resolveReportShare(w, r, q, false)
		if !ok {
			return
		}
		sourceID, err := parseIDFromPath(r, "sourceId")
		if err != nil || !sh.sources[sourceID] {
			api.NotFound(w, "source not found")
			return
		}
		serve(w, r, sh.link.TenantID, sourceID)
	}
}

// PublicReportShareRouter mounts on /api/v1/public/report-share.
func PublicReportShareRouter(q *db.Queries, pool *pgxpool.Pool, executor *reports.Executor) chi.Router {
	r := chi.NewRouter()
	r.Route("/{token}", func(r chi.Router) {
		r.Get("/", publicReportShareHandler(q))
		r.Post("/run", publicReportShareRunHandler(q, executor))
		r.Get("/history", publicReportShareHistoryHandler(q))
		r.Route("/sources/{sourceId}", func(r chi.Router) {
			r.Get("/rows", reportShareSource(q, func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64) {
				serveDataSourceRows(w, r, q, tenantID, sourceID)
			}))
			r.Post("/query", reportShareSource(q, func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64) {
				serveDataSourceQuery(w, r, pool, q, tenantID, sourceID)
			}))
			r.Get("/events", reportShareSource(q, func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64) {
				serveTableEvents(w, r, q, tenantID, sourceID, true)
			}))
			r.Get("/events/{key}", reportShareSource(q, func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64) {
				serveTableRowEvents(w, r, q, tenantID, sourceID, true)
			}))
			r.Get("/fields", reportShareSource(q, func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64) {
				serveReportSourceFields(w, r, q, tenantID, sourceID)
			}))
		})
	})
	return r
}

// ---------------------------------------------------------------- signed in

// editableReport loads the URL's report for a caller who may share it (can
// edit it). Writes the error itself.
func editableReport(w http.ResponseWriter, r *http.Request, q *db.Queries) (db.Report, bool) {
	tenantID := api.TenantID(r.Context())
	role, ok := callerRole(w, r, q)
	if !ok {
		return db.Report{}, false
	}
	id, err := api.IDParam(r, "id")
	if err != nil {
		api.BadRequest(w, "invalid report id")
		return db.Report{}, false
	}
	row, err := q.GetReport(r.Context(), db.GetReportParams{ID: id, TenantID: tenantID})
	if err != nil {
		api.NotFound(w, "report not found")
		return db.Report{}, false
	}
	access, err := resolveReportAccess(r.Context(), q, row, api.UserID(r.Context()), role)
	if err != nil {
		api.InternalError(w, r, err)
		return db.Report{}, false
	}
	if !access.CanView {
		api.NotFound(w, "report not found")
		return db.Report{}, false
	}
	if !access.CanEdit {
		api.Error(w, http.StatusForbidden, "only people who can edit this report can share it")
		return db.Report{}, false
	}
	return row, true
}

// listReportShareLinksHandler — GET /reports/{id}/share-links.
func listReportShareLinksHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		row, ok := editableReport(w, r, q)
		if !ok {
			return
		}
		rows, err := q.ListShareLinksByReport(r.Context(), db.ListShareLinksByReportParams{
			TenantID: row.TenantID,
			ReportID: pgtype.Int8{Int64: row.ID, Valid: true},
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]ShareLinkResponse, 0, len(rows))
		for _, l := range rows {
			out = append(out, buildShareLinkResponse(l))
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// createReportShareLinkHandler — POST /reports/{id}/share-links. Same body
// as a facility link; the token is minted here.
func createReportShareLinkHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		row, ok := editableReport(w, r, q)
		if !ok {
			return
		}
		if row.IsArchived {
			api.BadRequest(w, "an archived report can't be shared")
			return
		}
		var req ShareLinkRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		expiry, err := parseExpiry(req.ExpiresAt, req.ExpirySeconds)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		token, err := generateShareToken()
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		var maxViews pgtype.Int8
		if req.MaxViews != nil && *req.MaxViews > 0 {
			maxViews = pgtype.Int8{Int64: *req.MaxViews, Valid: true}
		}
		var createdBy pgtype.Int8
		if userID := api.UserID(r.Context()); userID != 0 {
			createdBy = pgtype.Int8{Int64: userID, Valid: true}
		}
		link, err := q.CreateReportShareLink(r.Context(), db.CreateReportShareLinkParams{
			TenantID:  row.TenantID,
			ZoneID:    row.ZoneID,
			ReportID:  pgtype.Int8{Int64: row.ID, Valid: true},
			Token:     token,
			Label:     strings.TrimSpace(req.Label),
			Settings:  defaultJSONObject(req.Settings),
			ExpiresAt: expiry,
			MaxViews:  maxViews,
			CreatedBy: createdBy,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, buildShareLinkResponse(link))
	}
}
