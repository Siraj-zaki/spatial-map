package handlers

import (
	"errors"
	"net/http"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Facility share data: a signed-out visitor of `/share/:token` reads the
// facility's data-layer rows, queries and history through
// /api/v1/public/share/{token}/sources/{sourceId}/… — limited to the
// sources the facility's data links read, on a live public facility.

// facilityShare is a resolved facility share link for a data call.
type facilityShare struct {
	tenantID, zoneID int64
	sources          map[int64]bool
}

// resolveFacilityShare accepts a share-link token (strict data variant)
// or a facility's legacy share token, and loads the sources its layers
// read. Writes the 404 itself.
func resolveFacilityShare(w http.ResponseWriter, r *http.Request, q *db.Queries) (facilityShare, bool) {
	token := chi.URLParam(r, "token")
	var fs facilityShare
	link, err := q.GetShareLinkForData(r.Context(), token)
	switch {
	case err == nil && link.ZoneID.Valid:
		fs.tenantID, fs.zoneID = link.TenantID, link.ZoneID.Int64
	case errors.Is(err, pgx.ErrNoRows) || (err == nil && !link.ZoneID.Valid):
		z, zerr := q.GetZoneByShareToken(r.Context(), pgtypeText(token))
		if zerr != nil {
			api.NotFound(w, "share link not found")
			return fs, false
		}
		fs.tenantID, fs.zoneID = z.TenantID, z.ID
	default:
		api.InternalError(w, r, err)
		return fs, false
	}
	zone, err := q.GetZoneByID(r.Context(), fs.zoneID)
	if err != nil || !zone.IsPublic {
		api.NotFound(w, "share link not found")
		return fs, false
	}
	links, err := q.ListDataLinkConfigsByZone(r.Context(), fs.zoneID)
	if err != nil {
		api.InternalError(w, r, err)
		return fs, false
	}
	fs.sources = map[int64]bool{}
	for _, l := range links {
		if l.TenantID == fs.tenantID && l.SourceID.Valid {
			fs.sources[l.SourceID.Int64] = true
		}
	}
	return fs, true
}

func pgtypeText(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }

func facilityShareSource(q *db.Queries, serve func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fs, ok := resolveFacilityShare(w, r, q)
		if !ok {
			return
		}
		sourceID, err := parseIDFromPath(r, "sourceId")
		if err != nil || !fs.sources[sourceID] {
			api.NotFound(w, "source not found")
			return
		}
		serve(w, r, fs.tenantID, sourceID)
	}
}

// PublicFacilityShareRouter mounts on /api/v1/public/share/{token}: the
// page itself and its layers' rows, queries and history.
func PublicFacilityShareRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", PublicShareHandler(q))
	r.Route("/sources/{sourceId}", func(r chi.Router) {
		r.Get("/rows", facilityShareSource(q, func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64) {
			serveDataSourceRows(w, r, q, tenantID, sourceID)
		}))
		r.Post("/query", facilityShareSource(q, func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64) {
			serveDataSourceQuery(w, r, pool, q, tenantID, sourceID)
		}))
		r.Get("/events", facilityShareSource(q, func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64) {
			serveTableEvents(w, r, q, tenantID, sourceID, true)
		}))
		r.Get("/events/{key}", facilityShareSource(q, func(w http.ResponseWriter, r *http.Request, tenantID, sourceID int64) {
			serveTableRowEvents(w, r, q, tenantID, sourceID, true)
		}))
	})
	return r
}
