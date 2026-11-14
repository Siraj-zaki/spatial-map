package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The Data screen surfaces every ingested record, independent of whether
// the source integration is still active. All list endpoints follow the
// warehouse_summaries envelope: { rows, total, page, pageSize, stats,
// filteredStats } — total via COUNT(*) OVER(), stats tenant-wide, and
// filteredStats aggregating over the current predicate set.
//
// SoftDelete on data_sources/streams/connections means every list query
// here must LEFT JOIN the source table and expose an `archived` flag so
// the UI can badge rows whose integration has been retired.

const dataScreenQueryTimeout = 5 * time.Second

// bulkDeleteMax caps a single bulk delete so a runaway request cannot
// drop millions of rows in one go. Purge endpoints (per-source or
// per-date) don't need this cap — they're deliberate wholesale deletes.
const bulkDeleteMax = 500

// DataScreenRouter mounts every read + delete endpoint under /api/v1/data/*.
// Tenant is already extracted by the parent TenantMiddleware group.
//
// Reads are open to every member; deletes and purges need editor or above
// — the same bar as deleting a row in a table's grid. (Purges stay at
// editor because scheduled "replace-all" REST syncs purge before they
// re-import, and those run in editors' tabs.) Before this gate any member,
// viewers included, could wipe a source's data from the Data screen.
func DataScreenRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	edit := dataPermissionGate(api.PermDataManage)

	// Filter dropdown — every source the tenant has ever created, active
	// or archived. Sorted archived-first-null so active ones surface at top.
	r.Get("/sources", listDataSources(pool))

	// Rows tab — data_source_rows joined with data_sources.
	r.Get("/rows", listDataRows(pool))
	r.With(edit).Delete("/rows/{id}", deleteDataRow(pool))
	r.With(edit).Post("/rows/bulk-delete", bulkDeleteDataRows(pool))
	r.With(edit).Post("/rows/purge", purgeDataRows(pool))

	// Rooms & Bins tab — legacy bins whose sync_source is populated.
	r.Get("/bins", listDataBins(pool))
	r.With(edit).Delete("/bins/{id}", deleteDataBin(pool))
	r.With(edit).Post("/bins/bulk-delete", bulkDeleteDataBins(pool))
	r.With(edit).Post("/bins/purge", purgeDataBins(pool))

	// Live tab — entity_states + drill into entity_events.
	r.Get("/live", listDataLive(pool))
	r.Get("/live/events", listDataLiveEvents(pool))
	r.With(edit).Delete("/live/state/{id}", deleteEntityStateRow(pool))
	r.With(edit).Post("/live/state/bulk-delete", bulkDeleteEntityStates(pool))
	r.With(edit).Post("/live/state/purge", purgeEntityStates(pool))
	r.With(edit).Delete("/live/events/{id}", deleteEntityEventRow(pool))
	r.With(edit).Post("/live/events/bulk-delete", bulkDeleteEntityEvents(pool))
	r.With(edit).Post("/live/events/purge", purgeEntityEvents(pool))

	// Files tab — source_files.
	r.Get("/files", listDataFiles(pool))
	r.With(edit).Delete("/files/{id}", deleteDataFile(pool))
	r.With(edit).Post("/files/bulk-delete", bulkDeleteDataFiles(pool))
	r.With(edit).Post("/files/purge", purgeDataFiles(pool))

	// Runs tab — import_jobs history.
	r.Get("/runs", listDataRuns(pool))
	r.With(edit).Delete("/runs/{id}", deleteDataRun(pool))
	r.With(edit).Post("/runs/bulk-delete", bulkDeleteDataRuns(pool))
	r.With(edit).Post("/runs/purge", purgeDataRuns(pool))

	return r
}

// dataPermissionGate lets the request through only with the permission
// (api.RequirePermission writes the 403).
func dataPermissionGate(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !api.RequirePermission(w, r, perm) {
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

// DataScreenStats is the tenant-wide totals block returned by every list
// endpoint's `stats` field. It doesn't respond to filters — the UI uses
// it for the four header KPI cards.
type DataScreenStats struct {
	TotalRows       int64 `json:"totalRows"`
	TotalBins       int64 `json:"totalBins"`
	TotalStates     int64 `json:"totalStates"`
	TotalEvents     int64 `json:"totalEvents"`
	TotalFiles      int64 `json:"totalFiles"`
	TotalRuns       int64 `json:"totalRuns"`
	ActiveSources   int64 `json:"activeSources"`
	ArchivedSources int64 `json:"archivedSources"`
}

// DataScreenSourceRef is the dropdown-friendly shape returned by /data/sources.
type DataScreenSourceRef struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	EntityKind string `json:"entityKind,omitempty"`
	Archived   bool   `json:"archived"`
	DeletedAt  string `json:"deletedAt,omitempty"`
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

func parseTime(v string) pgtype.Timestamptz {
	if v == "" {
		return pgtype.Timestamptz{Valid: false}
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return pgtype.Timestamptz{Time: t, Valid: true}
	}
	return pgtype.Timestamptz{Valid: false}
}

func nullableTime(t pgtype.Timestamptz) string {
	if !t.Valid {
		return ""
	}
	return api.FormatTime(t)
}

func nullableInt64Query(r *http.Request, key string) pgtype.Int8 {
	v := r.URL.Query().Get(key)
	if v == "" {
		return pgtype.Int8{Valid: false}
	}
	n := api.Int64Query(r, key, 0)
	if n == 0 && v != "0" {
		return pgtype.Int8{Valid: false}
	}
	return pgtype.Int8{Int64: n, Valid: true}
}

func clampPageSize(v int) int {
	if v < 1 {
		return 25
	}
	if v > 200 {
		return 200
	}
	return v
}

func decodeIDList(r *http.Request) ([]int64, error) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := api.DecodeBody(r, &body); err != nil {
		return nil, err
	}
	if len(body.IDs) == 0 {
		return nil, fmt.Errorf("ids required")
	}
	if len(body.IDs) > bulkDeleteMax {
		return nil, fmt.Errorf("at most %d ids per call", bulkDeleteMax)
	}
	return body.IDs, nil
}

type purgeBody struct {
	SourceID int64  `json:"sourceId,omitempty"`
	StreamID int64  `json:"streamId,omitempty"`
	Before   string `json:"before,omitempty"`
}

// ---------------------------------------------------------------------------
// GET /data/sources — filter dropdown
// ---------------------------------------------------------------------------

func listDataSources(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		solutionSources, solOK := solutionScope(w, r, db.New(pool), "data_sources")
		if !solOK {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		const sqlText = `
SELECT id, name, kind::text, COALESCE(entity_kind::text, ''), deleted_at
  FROM data_sources
 WHERE tenant_id = $1
   AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))
 ORDER BY deleted_at NULLS FIRST, name`
		rows, err := pool.Query(ctx, sqlText, tenantID, solutionSources)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rows.Close()
		out := []DataScreenSourceRef{}
		for rows.Next() {
			var ref DataScreenSourceRef
			var deletedAt pgtype.Timestamptz
			if err := rows.Scan(&ref.ID, &ref.Name, &ref.Kind, &ref.EntityKind, &deletedAt); err != nil {
				api.InternalError(w, r, err)
				return
			}
			ref.Archived = deletedAt.Valid
			ref.DeletedAt = nullableTime(deletedAt)
			out = append(out, ref)
		}
		if err := rows.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// dataScreenStats runs one small round-trip for the tenant-wide totals
// block. Every list handler calls this so the header KPI cards stay
// consistent regardless of what filters are active.
func dataScreenStats(ctx context.Context, pool *pgxpool.Pool, tenantID int64, sources []int64) (DataScreenStats, error) {
	// Inside a solution (`sources` non-nil) the totals cover its data
	// sources only; nil keeps them workspace-wide.
	const sqlText = `
SELECT
  (SELECT COUNT(*) FROM data_source_rows WHERE tenant_id = $1 AND ($2::bigint[] IS NULL OR source_id = ANY($2::bigint[])))   AS total_rows,
  (SELECT COUNT(*) FROM bins             WHERE tenant_id = $1 AND sync_source IS NOT NULL
     AND ($2::bigint[] IS NULL OR sync_source = ANY($2::bigint[])))                                                       AS total_bins,
  (SELECT COUNT(*) FROM entity_states    WHERE tenant_id = $1
     AND ($2::bigint[] IS NULL OR stream_id IN (SELECT st.id FROM streams st WHERE st.data_source_id = ANY($2::bigint[])))) AS total_states,
  (SELECT COUNT(*) FROM entity_events    WHERE tenant_id = $1
     AND ($2::bigint[] IS NULL OR stream_id IN (SELECT st.id FROM streams st WHERE st.data_source_id = ANY($2::bigint[])))) AS total_events,
  (SELECT COUNT(*) FROM source_files     WHERE tenant_id = $1 AND ($2::bigint[] IS NULL OR source_id = ANY($2::bigint[])))   AS total_files,
  (SELECT COUNT(*) FROM import_jobs      WHERE tenant_id = $1 AND ($2::bigint[] IS NULL OR source_id = ANY($2::bigint[])))   AS total_runs,
  (SELECT COUNT(*) FROM data_sources     WHERE tenant_id = $1 AND deleted_at IS NULL
     AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[])))                                                                AS active_sources,
  (SELECT COUNT(*) FROM data_sources     WHERE tenant_id = $1 AND deleted_at IS NOT NULL
     AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[])))                                                                AS archived_sources`
	var s DataScreenStats
	err := pool.QueryRow(ctx, sqlText, tenantID, sources).Scan(
		&s.TotalRows, &s.TotalBins, &s.TotalStates, &s.TotalEvents,
		&s.TotalFiles, &s.TotalRuns, &s.ActiveSources, &s.ArchivedSources,
	)
	return s, err
}

// ---------------------------------------------------------------------------
// Rows tab — data_source_rows
// ---------------------------------------------------------------------------

var rowsSortColumns = map[string]string{
	"ts":         "r.ts",
	"updatedAt":  "r.updated_at",
	"sourceName": "s.name",
	"entityKey":  "r.entity_key",
}

// DataRowResponse mirrors one row on the Rows tab.
type DataRowResponse struct {
	ID             int64  `json:"id"`
	SourceID       int64  `json:"sourceId"`
	SourceName     string `json:"sourceName"`
	SourceKind     string `json:"sourceKind"`
	SourceArchived bool   `json:"sourceArchived"`
	EntityKey      string `json:"entityKey"`
	Payload        any    `json:"payload"`
	LinkedShape    string `json:"linkedShape,omitempty"`
	PositionWKT    string `json:"positionWkt,omitempty"`
	Ts             string `json:"ts"`
	UpdatedAt      string `json:"updatedAt"`
}

// DataRowsFilteredStats is the aggregate over the current predicate set
// (not just the current page). Drives the "in filter" KPI card.
type DataRowsFilteredStats struct {
	Rows     int64  `json:"rows"`
	Sources  int64  `json:"sources"`
	Earliest string `json:"earliest,omitempty"`
	Latest   string `json:"latest,omitempty"`
}

// DataRowsResponse is the JSON envelope for /data/rows.
type DataRowsResponse struct {
	Rows          []DataRowResponse     `json:"rows"`
	Total         int64                 `json:"total"`
	Page          int                   `json:"page"`
	PageSize      int                   `json:"pageSize"`
	Stats         DataScreenStats       `json:"stats"`
	FilteredStats DataRowsFilteredStats `json:"filteredStats"`
}

func listDataRows(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		q := r.URL.Query()
		sourceID := nullableInt64Query(r, "sourceId")
		// Optional ?solution=<id>: only that solution's data sources.
		solutionSources, solOK := solutionScope(w, r, db.New(pool), "data_sources")
		if !solOK {
			return
		}
		entityKey := strings.TrimSpace(q.Get("entityKey"))
		search := strings.TrimSpace(q.Get("search"))
		from := parseTime(q.Get("from"))
		to := parseTime(q.Get("to"))
		archived := strings.ToLower(strings.TrimSpace(q.Get("archived")))
		if archived == "" {
			archived = "all"
		}
		if archived != "all" && archived != "active" && archived != "archived" {
			api.BadRequest(w, "invalid archived filter")
			return
		}

		sortKey := q.Get("sort")
		if sortKey == "" {
			sortKey = "ts"
		}
		sortSQL, ok := rowsSortColumns[sortKey]
		if !ok {
			api.BadRequest(w, "invalid sort key")
			return
		}
		dir := strings.ToLower(q.Get("dir"))
		if dir != "asc" && dir != "desc" {
			dir = "desc"
		}
		page := api.IntQuery(r, "page", 1)
		if page < 1 {
			page = 1
		}
		pageSize := clampPageSize(api.IntQuery(r, "pageSize", 25))
		offset := (page - 1) * pageSize

		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()

		sqlText := fmt.Sprintf(`
SELECT r.id, r.source_id, s.name AS source_name, s.kind::text AS source_kind,
       (s.deleted_at IS NOT NULL) AS source_archived,
       r.entity_key, r.payload,
       COALESCE(r.linked_shape_name, '') AS linked_shape,
       COALESCE(ST_AsText(r.position)::text, '') AS position_wkt,
       r.ts, r.updated_at,
       COUNT(*) OVER() AS total_count
  FROM data_source_rows r
  JOIN data_sources s ON s.id = r.source_id
 WHERE r.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR r.source_id  = $2)
   AND ($10::bigint[] IS NULL OR r.source_id = ANY($10::bigint[]))
   AND ($3::TEXT         = ''    OR r.entity_key ILIKE '%%' || $3 || '%%')
   AND ($4::TIMESTAMPTZ  IS NULL OR r.ts >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR r.ts <  $5)
   AND ($6::TEXT         = ''    OR r.payload::text ILIKE '%%' || $6 || '%%')
   AND ($7::TEXT = 'all'
        OR ($7 = 'active'   AND s.deleted_at IS NULL)
        OR ($7 = 'archived' AND s.deleted_at IS NOT NULL))
 ORDER BY %s %s, r.id ASC
 LIMIT $8 OFFSET $9`, sortSQL, strings.ToUpper(dir))

		rows, err := pool.Query(ctx, sqlText,
			tenantID, sourceID, entityKey, from, to, search, archived, pageSize, offset, solutionSources,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rows.Close()

		out := DataRowsResponse{
			Rows:     []DataRowResponse{},
			Page:     page,
			PageSize: pageSize,
		}
		for rows.Next() {
			var (
				row        DataRowResponse
				payloadRaw json.RawMessage
				ts, upAt   pgtype.Timestamptz
				total      int64
			)
			if err := rows.Scan(
				&row.ID, &row.SourceID, &row.SourceName, &row.SourceKind,
				&row.SourceArchived, &row.EntityKey, &payloadRaw,
				&row.LinkedShape, &row.PositionWKT, &ts, &upAt, &total,
			); err != nil {
				api.InternalError(w, r, err)
				return
			}
			row.Ts = api.FormatTime(ts)
			row.UpdatedAt = api.FormatTime(upAt)
			if len(payloadRaw) > 0 {
				var parsed any
				if err := json.Unmarshal(payloadRaw, &parsed); err == nil {
					row.Payload = parsed
				} else {
					row.Payload = string(payloadRaw)
				}
			}
			out.Rows = append(out.Rows, row)
			out.Total = total
		}
		if err := rows.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		stats, err := dataScreenStats(ctx, pool, tenantID, solutionSources)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.Stats = stats

		// Filtered aggregate — one small trip, same predicates.
		const filteredSQL = `
SELECT COUNT(*)::BIGINT,
       COUNT(DISTINCT r.source_id)::BIGINT,
       MIN(r.ts), MAX(r.ts)
  FROM data_source_rows r
  JOIN data_sources s ON s.id = r.source_id
 WHERE r.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR r.source_id  = $2)
   AND ($8::bigint[] IS NULL OR r.source_id = ANY($8::bigint[]))
   AND ($3::TEXT         = ''    OR r.entity_key ILIKE '%' || $3 || '%')
   AND ($4::TIMESTAMPTZ  IS NULL OR r.ts >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR r.ts <  $5)
   AND ($6::TEXT         = ''    OR r.payload::text ILIKE '%' || $6 || '%')
   AND ($7::TEXT = 'all'
        OR ($7 = 'active'   AND s.deleted_at IS NULL)
        OR ($7 = 'archived' AND s.deleted_at IS NOT NULL))`
		var earliest, latest pgtype.Timestamptz
		if err := pool.QueryRow(ctx, filteredSQL,
			tenantID, sourceID, entityKey, from, to, search, archived, solutionSources,
		).Scan(
			&out.FilteredStats.Rows, &out.FilteredStats.Sources, &earliest, &latest,
		); err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.FilteredStats.Earliest = nullableTime(earliest)
		out.FilteredStats.Latest = nullableTime(latest)

		api.JSON(w, http.StatusOK, out)
	}
}

func deleteDataRow(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx,
			`DELETE FROM data_source_rows WHERE id = $1 AND tenant_id = $2`,
			id, tenantID,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if res.RowsAffected() == 0 {
			api.NotFound(w, "row not found")
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", 0, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}

func bulkDeleteDataRows(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		ids, err := decodeIDList(r)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx,
			`DELETE FROM data_source_rows WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
			tenantID, ids,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", 0, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}

func purgeDataRows(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var body purgeBody
		if err := api.DecodeBody(r, &body); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if body.SourceID == 0 {
			api.BadRequest(w, "sourceId required")
			return
		}
		before := parseTime(body.Before)
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx, `
DELETE FROM data_source_rows
 WHERE tenant_id = $1
   AND source_id = $2
   AND ($3::TIMESTAMPTZ IS NULL OR ts < $3)`,
			tenantID, body.SourceID, before,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", body.SourceID, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}

// ---------------------------------------------------------------------------
// Rooms & Bins tab — bins with sync_source
// ---------------------------------------------------------------------------

var binsSortColumns = map[string]string{
	"lastSyncedAt": "b.last_synced_at",
	"externalCode": "b.external_code",
	"status":       "b.status",
	"sourceName":   "s.name",
}

// DataBinResponse mirrors one row on the Rooms & Bins tab.
type DataBinResponse struct {
	ID             int64  `json:"id"`
	SourceID       int64  `json:"sourceId"`
	SourceName     string `json:"sourceName"`
	SourceArchived bool   `json:"sourceArchived"`
	TargetKind     string `json:"targetKind"`
	Status         string `json:"status"`
	ExternalCode   string `json:"externalCode,omitempty"`
	SKU            string `json:"sku,omitempty"`
	Notes          string `json:"notes,omitempty"`
	Capacity       int64  `json:"capacity"`
	Custom         any    `json:"custom,omitempty"`
	LastSyncedAt   string `json:"lastSyncedAt,omitempty"`
	UpdatedAt      string `json:"updatedAt"`
}

type DataBinsFilteredStats struct {
	Bins     int64  `json:"bins"`
	Sources  int64  `json:"sources"`
	Earliest string `json:"earliest,omitempty"`
	Latest   string `json:"latest,omitempty"`
}

type DataBinsResponse struct {
	Rows          []DataBinResponse     `json:"rows"`
	Total         int64                 `json:"total"`
	Page          int                   `json:"page"`
	PageSize      int                   `json:"pageSize"`
	Stats         DataScreenStats       `json:"stats"`
	FilteredStats DataBinsFilteredStats `json:"filteredStats"`
}

func listDataBins(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		q := r.URL.Query()
		sourceID := nullableInt64Query(r, "sourceId")
		// Optional ?solution=<id>: only that solution's data sources.
		solutionSources, solOK := solutionScope(w, r, db.New(pool), "data_sources")
		if !solOK {
			return
		}
		search := strings.TrimSpace(q.Get("search"))
		from := parseTime(q.Get("from"))
		to := parseTime(q.Get("to"))
		sortKey := q.Get("sort")
		if sortKey == "" {
			sortKey = "lastSyncedAt"
		}
		sortSQL, ok := binsSortColumns[sortKey]
		if !ok {
			api.BadRequest(w, "invalid sort key")
			return
		}
		dir := strings.ToLower(q.Get("dir"))
		if dir != "asc" && dir != "desc" {
			dir = "desc"
		}
		page := api.IntQuery(r, "page", 1)
		if page < 1 {
			page = 1
		}
		pageSize := clampPageSize(api.IntQuery(r, "pageSize", 25))
		offset := (page - 1) * pageSize

		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()

		sqlText := fmt.Sprintf(`
SELECT b.id, b.sync_source,
       COALESCE(s.name, '') AS source_name,
       COALESCE(s.deleted_at IS NOT NULL, false) AS source_archived,
       COALESCE(b.target_kind::text, '') AS target_kind,
       COALESCE(b.status::text, '') AS status,
       COALESCE(b.external_code, '') AS external_code,
       COALESCE(b.sku, '') AS sku,
       COALESCE(b.notes, '') AS notes,
       COALESCE(b.capacity, 0) AS capacity,
       b.custom_properties, b.last_synced_at, b.updated_at,
       COUNT(*) OVER() AS total_count
  FROM bins b
  LEFT JOIN data_sources s ON s.id = b.sync_source
 WHERE b.tenant_id = $1
   AND b.sync_source IS NOT NULL
   AND ($2::BIGINT       IS NULL OR b.sync_source = $2)
   AND ($8::bigint[] IS NULL OR b.sync_source = ANY($8::bigint[]))
   AND ($3::TEXT         = ''    OR
        COALESCE(b.external_code, '') ILIKE '%%' || $3 || '%%' OR
        COALESCE(b.sku, '')           ILIKE '%%' || $3 || '%%' OR
        COALESCE(b.notes, '')         ILIKE '%%' || $3 || '%%')
   AND ($4::TIMESTAMPTZ  IS NULL OR b.last_synced_at >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR b.last_synced_at <  $5)
 ORDER BY %s %s NULLS LAST, b.id ASC
 LIMIT $6 OFFSET $7`, sortSQL, strings.ToUpper(dir))

		rows, err := pool.Query(ctx, sqlText,
			tenantID, sourceID, search, from, to, pageSize, offset, solutionSources,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rows.Close()

		out := DataBinsResponse{
			Rows:     []DataBinResponse{},
			Page:     page,
			PageSize: pageSize,
		}
		for rows.Next() {
			var (
				row       DataBinResponse
				syncSrc   pgtype.Int8
				customRaw json.RawMessage
				lastSync  pgtype.Timestamptz
				upAt      pgtype.Timestamptz
				total     int64
			)
			if err := rows.Scan(
				&row.ID, &syncSrc, &row.SourceName, &row.SourceArchived,
				&row.TargetKind, &row.Status, &row.ExternalCode, &row.SKU, &row.Notes,
				&row.Capacity, &customRaw, &lastSync, &upAt, &total,
			); err != nil {
				api.InternalError(w, r, err)
				return
			}
			if syncSrc.Valid {
				row.SourceID = syncSrc.Int64
			}
			if len(customRaw) > 0 {
				var parsed any
				if err := json.Unmarshal(customRaw, &parsed); err == nil {
					row.Custom = parsed
				}
			}
			row.LastSyncedAt = nullableTime(lastSync)
			row.UpdatedAt = api.FormatTime(upAt)
			out.Rows = append(out.Rows, row)
			out.Total = total
		}
		if err := rows.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		stats, err := dataScreenStats(ctx, pool, tenantID, solutionSources)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.Stats = stats

		const filteredSQL = `
SELECT COUNT(*)::BIGINT,
       COUNT(DISTINCT b.sync_source)::BIGINT,
       MIN(b.last_synced_at), MAX(b.last_synced_at)
  FROM bins b
  LEFT JOIN data_sources s ON s.id = b.sync_source
 WHERE b.tenant_id = $1
   AND b.sync_source IS NOT NULL
   AND ($2::BIGINT       IS NULL OR b.sync_source = $2)
   AND ($6::bigint[] IS NULL OR b.sync_source = ANY($6::bigint[]))
   AND ($3::TEXT         = ''    OR
        COALESCE(b.external_code, '') ILIKE '%' || $3 || '%' OR
        COALESCE(b.sku, '')           ILIKE '%' || $3 || '%' OR
        COALESCE(b.notes, '')         ILIKE '%' || $3 || '%')
   AND ($4::TIMESTAMPTZ  IS NULL OR b.last_synced_at >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR b.last_synced_at <  $5)`
		var earliest, latest pgtype.Timestamptz
		if err := pool.QueryRow(ctx, filteredSQL,
			tenantID, sourceID, search, from, to, solutionSources,
		).Scan(
			&out.FilteredStats.Bins, &out.FilteredStats.Sources, &earliest, &latest,
		); err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.FilteredStats.Earliest = nullableTime(earliest)
		out.FilteredStats.Latest = nullableTime(latest)

		api.JSON(w, http.StatusOK, out)
	}
}

func deleteDataBin(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleDelete(pool, "bins")
}
func bulkDeleteDataBins(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleBulkDelete(pool, "bins")
}
func purgeDataBins(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var body purgeBody
		if err := api.DecodeBody(r, &body); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if body.SourceID == 0 {
			api.BadRequest(w, "sourceId required")
			return
		}
		before := parseTime(body.Before)
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx, `
DELETE FROM bins
 WHERE tenant_id = $1
   AND sync_source = $2
   AND ($3::TIMESTAMPTZ IS NULL OR last_synced_at < $3)`,
			tenantID, body.SourceID, before,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", body.SourceID, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}

// ---------------------------------------------------------------------------
// Live tab — entity_states + entity_events
// ---------------------------------------------------------------------------

var liveStatesSortColumns = map[string]string{
	"lastSeenAt": "s.last_seen_at",
	"streamName": "st.name",
	"entityKey":  "s.entity_key",
}

var liveEventsSortColumns = map[string]string{
	"ts":         "e.ts",
	"streamName": "st.name",
	"entityKey":  "e.entity_key",
}

type DataLiveStateResponse struct {
	ID             int64  `json:"id"`
	StreamID       int64  `json:"streamId"`
	StreamName     string `json:"streamName"`
	StreamArchived bool   `json:"streamArchived"`
	EntityType     string `json:"entityType"`
	EntityKey      string `json:"entityKey"`
	Payload        any    `json:"payload"`
	PositionWKT    string `json:"positionWkt,omitempty"`
	LastSeenAt     string `json:"lastSeenAt"`
	UpdatedAt      string `json:"updatedAt"`
}

type DataLiveEventResponse struct {
	ID             int64  `json:"id"`
	StreamID       int64  `json:"streamId"`
	StreamName     string `json:"streamName"`
	StreamArchived bool   `json:"streamArchived"`
	EntityKey      string `json:"entityKey"`
	Payload        any    `json:"payload"`
	Ts             string `json:"ts"`
}

type DataLiveFilteredStats struct {
	Count    int64  `json:"count"`
	Streams  int64  `json:"streams"`
	Earliest string `json:"earliest,omitempty"`
	Latest   string `json:"latest,omitempty"`
}

type DataLiveStatesResponse struct {
	Rows          []DataLiveStateResponse `json:"rows"`
	Total         int64                   `json:"total"`
	Page          int                     `json:"page"`
	PageSize      int                     `json:"pageSize"`
	Stats         DataScreenStats         `json:"stats"`
	FilteredStats DataLiveFilteredStats   `json:"filteredStats"`
}

type DataLiveEventsResponse struct {
	Rows          []DataLiveEventResponse `json:"rows"`
	Total         int64                   `json:"total"`
	Page          int                     `json:"page"`
	PageSize      int                     `json:"pageSize"`
	Stats         DataScreenStats         `json:"stats"`
	FilteredStats DataLiveFilteredStats   `json:"filteredStats"`
}

func listDataLive(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		q := r.URL.Query()
		streamID := nullableInt64Query(r, "streamId")
		// Optional ?solution=<id>: only that solution's data sources.
		solutionSources, solOK := solutionScope(w, r, db.New(pool), "data_sources")
		if !solOK {
			return
		}
		entityType := strings.TrimSpace(q.Get("entityType"))
		entityKey := strings.TrimSpace(q.Get("entityKey"))
		from := parseTime(q.Get("from"))
		to := parseTime(q.Get("to"))
		sortKey := q.Get("sort")
		if sortKey == "" {
			sortKey = "lastSeenAt"
		}
		sortSQL, ok := liveStatesSortColumns[sortKey]
		if !ok {
			api.BadRequest(w, "invalid sort key")
			return
		}
		dir := strings.ToLower(q.Get("dir"))
		if dir != "asc" && dir != "desc" {
			dir = "desc"
		}
		page := api.IntQuery(r, "page", 1)
		if page < 1 {
			page = 1
		}
		pageSize := clampPageSize(api.IntQuery(r, "pageSize", 25))
		offset := (page - 1) * pageSize

		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()

		sqlText := fmt.Sprintf(`
SELECT s.id, s.stream_id, st.name AS stream_name,
       (st.deleted_at IS NOT NULL) AS stream_archived,
       st.entity_type, s.entity_key, s.payload,
       COALESCE(ST_AsText(s.position)::text, '') AS position_wkt,
       s.last_seen_at, s.updated_at,
       COUNT(*) OVER() AS total_count
  FROM entity_states s
  JOIN streams st ON st.id = s.stream_id
 WHERE s.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR s.stream_id = $2)
   AND ($9::bigint[] IS NULL OR s.stream_id IN (SELECT st.id FROM streams st WHERE st.data_source_id = ANY($9::bigint[])))
   AND ($3::TEXT         = ''    OR st.entity_type = $3)
   AND ($4::TEXT         = ''    OR s.entity_key ILIKE '%%' || $4 || '%%')
   AND ($5::TIMESTAMPTZ  IS NULL OR s.last_seen_at >= $5)
   AND ($6::TIMESTAMPTZ  IS NULL OR s.last_seen_at <  $6)
 ORDER BY %s %s, s.id ASC
 LIMIT $7 OFFSET $8`, sortSQL, strings.ToUpper(dir))

		rows, err := pool.Query(ctx, sqlText,
			tenantID, streamID, entityType, entityKey, from, to, pageSize, offset, solutionSources,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rows.Close()

		out := DataLiveStatesResponse{
			Rows:     []DataLiveStateResponse{},
			Page:     page,
			PageSize: pageSize,
		}
		for rows.Next() {
			var (
				row        DataLiveStateResponse
				payloadRaw json.RawMessage
				lastSeen   pgtype.Timestamptz
				upAt       pgtype.Timestamptz
				total      int64
			)
			if err := rows.Scan(
				&row.ID, &row.StreamID, &row.StreamName, &row.StreamArchived,
				&row.EntityType, &row.EntityKey, &payloadRaw, &row.PositionWKT,
				&lastSeen, &upAt, &total,
			); err != nil {
				api.InternalError(w, r, err)
				return
			}
			row.LastSeenAt = api.FormatTime(lastSeen)
			row.UpdatedAt = api.FormatTime(upAt)
			if len(payloadRaw) > 0 {
				var parsed any
				if err := json.Unmarshal(payloadRaw, &parsed); err == nil {
					row.Payload = parsed
				}
			}
			out.Rows = append(out.Rows, row)
			out.Total = total
		}
		if err := rows.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		stats, err := dataScreenStats(ctx, pool, tenantID, solutionSources)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.Stats = stats

		const filteredSQL = `
SELECT COUNT(*)::BIGINT,
       COUNT(DISTINCT s.stream_id)::BIGINT,
       MIN(s.last_seen_at), MAX(s.last_seen_at)
  FROM entity_states s
  JOIN streams st ON st.id = s.stream_id
 WHERE s.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR s.stream_id = $2)
   AND ($7::bigint[] IS NULL OR s.stream_id IN (SELECT st.id FROM streams st WHERE st.data_source_id = ANY($7::bigint[])))
   AND ($3::TEXT         = ''    OR st.entity_type = $3)
   AND ($4::TEXT         = ''    OR s.entity_key ILIKE '%' || $4 || '%')
   AND ($5::TIMESTAMPTZ  IS NULL OR s.last_seen_at >= $5)
   AND ($6::TIMESTAMPTZ  IS NULL OR s.last_seen_at <  $6)`
		var earliest, latest pgtype.Timestamptz
		if err := pool.QueryRow(ctx, filteredSQL,
			tenantID, streamID, entityType, entityKey, from, to, solutionSources,
		).Scan(
			&out.FilteredStats.Count, &out.FilteredStats.Streams, &earliest, &latest,
		); err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.FilteredStats.Earliest = nullableTime(earliest)
		out.FilteredStats.Latest = nullableTime(latest)

		api.JSON(w, http.StatusOK, out)
	}
}

func listDataLiveEvents(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		q := r.URL.Query()
		streamID := nullableInt64Query(r, "streamId")
		// Optional ?solution=<id>: only that solution's data sources.
		solutionSources, solOK := solutionScope(w, r, db.New(pool), "data_sources")
		if !solOK {
			return
		}
		entityKey := strings.TrimSpace(q.Get("entityKey"))
		from := parseTime(q.Get("from"))
		to := parseTime(q.Get("to"))
		sortKey := q.Get("sort")
		if sortKey == "" {
			sortKey = "ts"
		}
		sortSQL, ok := liveEventsSortColumns[sortKey]
		if !ok {
			api.BadRequest(w, "invalid sort key")
			return
		}
		dir := strings.ToLower(q.Get("dir"))
		if dir != "asc" && dir != "desc" {
			dir = "desc"
		}
		page := api.IntQuery(r, "page", 1)
		if page < 1 {
			page = 1
		}
		pageSize := clampPageSize(api.IntQuery(r, "pageSize", 25))
		offset := (page - 1) * pageSize

		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()

		sqlText := fmt.Sprintf(`
SELECT e.id, e.stream_id, st.name AS stream_name,
       (st.deleted_at IS NOT NULL) AS stream_archived,
       e.entity_key, e.payload, e.ts,
       COUNT(*) OVER() AS total_count
  FROM entity_events e
  JOIN streams st ON st.id = e.stream_id
 WHERE e.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR e.stream_id = $2)
   AND ($8::bigint[] IS NULL OR e.stream_id IN (SELECT st.id FROM streams st WHERE st.data_source_id = ANY($8::bigint[])))
   AND ($3::TEXT         = ''    OR e.entity_key ILIKE '%%' || $3 || '%%')
   AND ($4::TIMESTAMPTZ  IS NULL OR e.ts >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR e.ts <  $5)
 ORDER BY %s %s, e.id DESC
 LIMIT $6 OFFSET $7`, sortSQL, strings.ToUpper(dir))

		rows, err := pool.Query(ctx, sqlText,
			tenantID, streamID, entityKey, from, to, pageSize, offset, solutionSources,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rows.Close()

		out := DataLiveEventsResponse{
			Rows:     []DataLiveEventResponse{},
			Page:     page,
			PageSize: pageSize,
		}
		for rows.Next() {
			var (
				row        DataLiveEventResponse
				payloadRaw json.RawMessage
				ts         pgtype.Timestamptz
				total      int64
			)
			if err := rows.Scan(
				&row.ID, &row.StreamID, &row.StreamName, &row.StreamArchived,
				&row.EntityKey, &payloadRaw, &ts, &total,
			); err != nil {
				api.InternalError(w, r, err)
				return
			}
			row.Ts = api.FormatTime(ts)
			if len(payloadRaw) > 0 {
				var parsed any
				if err := json.Unmarshal(payloadRaw, &parsed); err == nil {
					row.Payload = parsed
				}
			}
			out.Rows = append(out.Rows, row)
			out.Total = total
		}
		if err := rows.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		stats, err := dataScreenStats(ctx, pool, tenantID, solutionSources)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.Stats = stats

		const filteredSQL = `
SELECT COUNT(*)::BIGINT,
       COUNT(DISTINCT e.stream_id)::BIGINT,
       MIN(e.ts), MAX(e.ts)
  FROM entity_events e
 WHERE e.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR e.stream_id = $2)
   AND ($6::bigint[] IS NULL OR e.stream_id IN (SELECT st.id FROM streams st WHERE st.data_source_id = ANY($6::bigint[])))
   AND ($3::TEXT         = ''    OR e.entity_key ILIKE '%' || $3 || '%')
   AND ($4::TIMESTAMPTZ  IS NULL OR e.ts >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR e.ts <  $5)`
		var earliest, latest pgtype.Timestamptz
		if err := pool.QueryRow(ctx, filteredSQL,
			tenantID, streamID, entityKey, from, to, solutionSources,
		).Scan(
			&out.FilteredStats.Count, &out.FilteredStats.Streams, &earliest, &latest,
		); err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.FilteredStats.Earliest = nullableTime(earliest)
		out.FilteredStats.Latest = nullableTime(latest)

		api.JSON(w, http.StatusOK, out)
	}
}

func deleteEntityStateRow(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleDelete(pool, "entity_states")
}
func bulkDeleteEntityStates(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleBulkDelete(pool, "entity_states")
}
func purgeEntityStates(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var body purgeBody
		if err := api.DecodeBody(r, &body); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if body.StreamID == 0 {
			api.BadRequest(w, "streamId required")
			return
		}
		before := parseTime(body.Before)
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx, `
DELETE FROM entity_states
 WHERE tenant_id = $1
   AND stream_id = $2
   AND ($3::TIMESTAMPTZ IS NULL OR last_seen_at < $3)`,
			tenantID, body.StreamID, before,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", body.StreamID, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}

func deleteEntityEventRow(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleDelete(pool, "entity_events")
}
func bulkDeleteEntityEvents(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleBulkDelete(pool, "entity_events")
}
func purgeEntityEvents(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var body purgeBody
		if err := api.DecodeBody(r, &body); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if body.StreamID == 0 {
			api.BadRequest(w, "streamId required")
			return
		}
		before := parseTime(body.Before)
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx, `
DELETE FROM entity_events
 WHERE tenant_id = $1
   AND stream_id = $2
   AND ($3::TIMESTAMPTZ IS NULL OR ts < $3)`,
			tenantID, body.StreamID, before,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", body.StreamID, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}

// ---------------------------------------------------------------------------
// Files tab — source_files
// ---------------------------------------------------------------------------

var filesSortColumns = map[string]string{
	"createdAt":  "f.created_at",
	"updatedAt":  "f.updated_at",
	"filename":   "f.filename",
	"bytesSize":  "f.bytes_size",
	"sourceName": "s.name",
}

type DataFileResponse struct {
	ID             int64  `json:"id"`
	SourceID       int64  `json:"sourceId"`
	SourceName     string `json:"sourceName"`
	SourceArchived bool   `json:"sourceArchived"`
	Filename       string `json:"filename"`
	SourceKind     string `json:"sourceKind"`
	SheetName      string `json:"sheetName,omitempty"`
	JSONRootPath   string `json:"jsonRootPath,omitempty"`
	BytesSize      int64  `json:"bytesSize"`
	SHA256         string `json:"sha256,omitempty"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

type DataFilesFilteredStats struct {
	Files     int64  `json:"files"`
	Sources   int64  `json:"sources"`
	BytesSize int64  `json:"bytesSize"`
	Earliest  string `json:"earliest,omitempty"`
	Latest    string `json:"latest,omitempty"`
}

type DataFilesResponse struct {
	Rows          []DataFileResponse     `json:"rows"`
	Total         int64                  `json:"total"`
	Page          int                    `json:"page"`
	PageSize      int                    `json:"pageSize"`
	Stats         DataScreenStats        `json:"stats"`
	FilteredStats DataFilesFilteredStats `json:"filteredStats"`
}

func listDataFiles(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		q := r.URL.Query()
		sourceID := nullableInt64Query(r, "sourceId")
		// Optional ?solution=<id>: only that solution's data sources.
		solutionSources, solOK := solutionScope(w, r, db.New(pool), "data_sources")
		if !solOK {
			return
		}
		search := strings.TrimSpace(q.Get("search"))
		from := parseTime(q.Get("from"))
		to := parseTime(q.Get("to"))
		sortKey := q.Get("sort")
		if sortKey == "" {
			sortKey = "createdAt"
		}
		sortSQL, ok := filesSortColumns[sortKey]
		if !ok {
			api.BadRequest(w, "invalid sort key")
			return
		}
		dir := strings.ToLower(q.Get("dir"))
		if dir != "asc" && dir != "desc" {
			dir = "desc"
		}
		page := api.IntQuery(r, "page", 1)
		if page < 1 {
			page = 1
		}
		pageSize := clampPageSize(api.IntQuery(r, "pageSize", 25))
		offset := (page - 1) * pageSize

		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()

		sqlText := fmt.Sprintf(`
SELECT f.id, f.source_id, s.name AS source_name,
       (s.deleted_at IS NOT NULL) AS source_archived,
       f.filename, f.source_kind::text AS source_kind,
       COALESCE(f.sheet_name, '') AS sheet_name,
       COALESCE(f.json_root_path, '') AS json_root_path,
       f.bytes_size,
       COALESCE(f.content_sha256, '') AS sha256,
       f.created_at, f.updated_at,
       COUNT(*) OVER() AS total_count
  FROM source_files f
  JOIN data_sources s ON s.id = f.source_id
 WHERE f.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR f.source_id = $2)
   AND ($8::bigint[] IS NULL OR f.source_id = ANY($8::bigint[]))
   AND ($3::TEXT         = ''    OR f.filename ILIKE '%%' || $3 || '%%')
   AND ($4::TIMESTAMPTZ  IS NULL OR f.created_at >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR f.created_at <  $5)
 ORDER BY %s %s, f.id ASC
 LIMIT $6 OFFSET $7`, sortSQL, strings.ToUpper(dir))

		rows, err := pool.Query(ctx, sqlText,
			tenantID, sourceID, search, from, to, pageSize, offset, solutionSources,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rows.Close()

		out := DataFilesResponse{
			Rows:     []DataFileResponse{},
			Page:     page,
			PageSize: pageSize,
		}
		for rows.Next() {
			var (
				row       DataFileResponse
				createdAt pgtype.Timestamptz
				updatedAt pgtype.Timestamptz
				total     int64
			)
			if err := rows.Scan(
				&row.ID, &row.SourceID, &row.SourceName, &row.SourceArchived,
				&row.Filename, &row.SourceKind, &row.SheetName, &row.JSONRootPath,
				&row.BytesSize, &row.SHA256, &createdAt, &updatedAt, &total,
			); err != nil {
				api.InternalError(w, r, err)
				return
			}
			row.CreatedAt = api.FormatTime(createdAt)
			row.UpdatedAt = api.FormatTime(updatedAt)
			out.Rows = append(out.Rows, row)
			out.Total = total
		}
		if err := rows.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		stats, err := dataScreenStats(ctx, pool, tenantID, solutionSources)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.Stats = stats

		const filteredSQL = `
SELECT COUNT(*)::BIGINT,
       COUNT(DISTINCT f.source_id)::BIGINT,
       COALESCE(SUM(f.bytes_size), 0)::BIGINT,
       MIN(f.created_at), MAX(f.created_at)
  FROM source_files f
 WHERE f.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR f.source_id = $2)
   AND ($6::bigint[] IS NULL OR f.source_id = ANY($6::bigint[]))
   AND ($3::TEXT         = ''    OR f.filename ILIKE '%' || $3 || '%')
   AND ($4::TIMESTAMPTZ  IS NULL OR f.created_at >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR f.created_at <  $5)`
		var earliest, latest pgtype.Timestamptz
		if err := pool.QueryRow(ctx, filteredSQL,
			tenantID, sourceID, search, from, to, solutionSources,
		).Scan(
			&out.FilteredStats.Files, &out.FilteredStats.Sources,
			&out.FilteredStats.BytesSize, &earliest, &latest,
		); err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.FilteredStats.Earliest = nullableTime(earliest)
		out.FilteredStats.Latest = nullableTime(latest)

		api.JSON(w, http.StatusOK, out)
	}
}

func deleteDataFile(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleDelete(pool, "source_files")
}
func bulkDeleteDataFiles(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleBulkDelete(pool, "source_files")
}
func purgeDataFiles(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var body purgeBody
		if err := api.DecodeBody(r, &body); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if body.SourceID == 0 {
			api.BadRequest(w, "sourceId required")
			return
		}
		before := parseTime(body.Before)
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx, `
DELETE FROM source_files
 WHERE tenant_id = $1
   AND source_id = $2
   AND ($3::TIMESTAMPTZ IS NULL OR created_at < $3)`,
			tenantID, body.SourceID, before,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", body.SourceID, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}

// ---------------------------------------------------------------------------
// Runs tab — import_jobs
// ---------------------------------------------------------------------------

var runsSortColumns = map[string]string{
	"startedAt":  "j.started_at",
	"finishedAt": "j.finished_at",
	"createdAt":  "j.created_at",
	"status":     "j.status",
	"sourceName": "s.name",
}

type DataRunResponse struct {
	ID             int64  `json:"id"`
	SourceID       int64  `json:"sourceId"`
	SourceName     string `json:"sourceName"`
	SourceArchived bool   `json:"sourceArchived"`
	Status         string `json:"status"`
	Stats          any    `json:"stats,omitempty"`
	ErrorReport    string `json:"errorReport,omitempty"`
	StartedAt      string `json:"startedAt,omitempty"`
	FinishedAt     string `json:"finishedAt,omitempty"`
	CreatedAt      string `json:"createdAt"`
}

type DataRunsFilteredStats struct {
	Runs     int64  `json:"runs"`
	Sources  int64  `json:"sources"`
	Failures int64  `json:"failures"`
	Earliest string `json:"earliest,omitempty"`
	Latest   string `json:"latest,omitempty"`
}

type DataRunsResponse struct {
	Rows          []DataRunResponse     `json:"rows"`
	Total         int64                 `json:"total"`
	Page          int                   `json:"page"`
	PageSize      int                   `json:"pageSize"`
	Stats         DataScreenStats       `json:"stats"`
	FilteredStats DataRunsFilteredStats `json:"filteredStats"`
}

func listDataRuns(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		q := r.URL.Query()
		sourceID := nullableInt64Query(r, "sourceId")
		// Optional ?solution=<id>: only that solution's data sources.
		solutionSources, solOK := solutionScope(w, r, db.New(pool), "data_sources")
		if !solOK {
			return
		}
		status := strings.TrimSpace(q.Get("status"))
		from := parseTime(q.Get("from"))
		to := parseTime(q.Get("to"))
		sortKey := q.Get("sort")
		if sortKey == "" {
			sortKey = "createdAt"
		}
		sortSQL, ok := runsSortColumns[sortKey]
		if !ok {
			api.BadRequest(w, "invalid sort key")
			return
		}
		dir := strings.ToLower(q.Get("dir"))
		if dir != "asc" && dir != "desc" {
			dir = "desc"
		}
		page := api.IntQuery(r, "page", 1)
		if page < 1 {
			page = 1
		}
		pageSize := clampPageSize(api.IntQuery(r, "pageSize", 25))
		offset := (page - 1) * pageSize

		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()

		sqlText := fmt.Sprintf(`
SELECT j.id, j.source_id,
       COALESCE(s.name, '') AS source_name,
       COALESCE(s.deleted_at IS NOT NULL, false) AS source_archived,
       j.status, j.stats,
       COALESCE(j.error_report, '') AS error_report,
       j.started_at, j.finished_at, j.created_at,
       COUNT(*) OVER() AS total_count
  FROM import_jobs j
  LEFT JOIN data_sources s ON s.id = j.source_id
 WHERE j.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR j.source_id = $2)
   AND ($8::bigint[] IS NULL OR j.source_id = ANY($8::bigint[]))
   AND ($3::TEXT         = ''    OR j.status::text = $3)
   AND ($4::TIMESTAMPTZ  IS NULL OR j.created_at >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR j.created_at <  $5)
 ORDER BY %s %s NULLS LAST, j.id DESC
 LIMIT $6 OFFSET $7`, sortSQL, strings.ToUpper(dir))

		rows, err := pool.Query(ctx, sqlText,
			tenantID, sourceID, status, from, to, pageSize, offset, solutionSources,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rows.Close()

		out := DataRunsResponse{
			Rows:     []DataRunResponse{},
			Page:     page,
			PageSize: pageSize,
		}
		for rows.Next() {
			var (
				row        DataRunResponse
				statsRaw   json.RawMessage
				startedAt  pgtype.Timestamptz
				finishedAt pgtype.Timestamptz
				createdAt  pgtype.Timestamptz
				total      int64
			)
			if err := rows.Scan(
				&row.ID, &row.SourceID, &row.SourceName, &row.SourceArchived,
				&row.Status, &statsRaw, &row.ErrorReport,
				&startedAt, &finishedAt, &createdAt, &total,
			); err != nil {
				api.InternalError(w, r, err)
				return
			}
			if len(statsRaw) > 0 {
				var parsed any
				if err := json.Unmarshal(statsRaw, &parsed); err == nil {
					row.Stats = parsed
				}
			}
			row.StartedAt = nullableTime(startedAt)
			row.FinishedAt = nullableTime(finishedAt)
			row.CreatedAt = api.FormatTime(createdAt)
			out.Rows = append(out.Rows, row)
			out.Total = total
		}
		if err := rows.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		stats, err := dataScreenStats(ctx, pool, tenantID, solutionSources)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.Stats = stats

		const filteredSQL = `
SELECT COUNT(*)::BIGINT,
       COUNT(DISTINCT j.source_id)::BIGINT,
       COUNT(*) FILTER (WHERE j.status::text IN ('error','failed','partial'))::BIGINT,
       MIN(j.created_at), MAX(j.created_at)
  FROM import_jobs j
 WHERE j.tenant_id = $1
   AND ($2::BIGINT       IS NULL OR j.source_id = $2)
   AND ($6::bigint[] IS NULL OR j.source_id = ANY($6::bigint[]))
   AND ($3::TEXT         = ''    OR j.status::text = $3)
   AND ($4::TIMESTAMPTZ  IS NULL OR j.created_at >= $4)
   AND ($5::TIMESTAMPTZ  IS NULL OR j.created_at <  $5)`
		var earliest, latest pgtype.Timestamptz
		if err := pool.QueryRow(ctx, filteredSQL,
			tenantID, sourceID, status, from, to, solutionSources,
		).Scan(
			&out.FilteredStats.Runs, &out.FilteredStats.Sources,
			&out.FilteredStats.Failures, &earliest, &latest,
		); err != nil {
			api.InternalError(w, r, err)
			return
		}
		out.FilteredStats.Earliest = nullableTime(earliest)
		out.FilteredStats.Latest = nullableTime(latest)

		api.JSON(w, http.StatusOK, out)
	}
}

func deleteDataRun(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleDelete(pool, "import_jobs")
}
func bulkDeleteDataRuns(pool *pgxpool.Pool) http.HandlerFunc {
	return simpleBulkDelete(pool, "import_jobs")
}
func purgeDataRuns(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		var body purgeBody
		if err := api.DecodeBody(r, &body); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if body.SourceID == 0 {
			api.BadRequest(w, "sourceId required")
			return
		}
		before := parseTime(body.Before)
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx, `
DELETE FROM import_jobs
 WHERE tenant_id = $1
   AND source_id = $2
   AND ($3::TIMESTAMPTZ IS NULL OR created_at < $3)`,
			tenantID, body.SourceID, before,
		)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", body.SourceID, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}

// ---------------------------------------------------------------------------
// Simple delete generators — table name is a hard-coded literal (not user
// input) so it's safe to interpolate. Every table involved has (id,
// tenant_id) columns for the WHERE clause.
// ---------------------------------------------------------------------------

func simpleDelete(pool *pgxpool.Pool, table string) http.HandlerFunc {
	sqlText := fmt.Sprintf(`DELETE FROM %s WHERE id = $1 AND tenant_id = $2`, table)
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx, sqlText, id, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if res.RowsAffected() == 0 {
			api.NotFound(w, "row not found")
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", id, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}

func simpleBulkDelete(pool *pgxpool.Pool, table string) http.HandlerFunc {
	sqlText := fmt.Sprintf(`DELETE FROM %s WHERE tenant_id = $1 AND id = ANY($2::bigint[])`, table)
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		ids, err := decodeIDList(r)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), dataScreenQueryTimeout)
		defer cancel()
		res, err := pool.Exec(ctx, sqlText, tenantID, ids)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("ENTITY_DELETED", "data-events", 0, tenantID)
		api.JSON(w, http.StatusOK, map[string]int64{"deleted": res.RowsAffected()})
	}
}
