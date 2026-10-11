package handlers

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// summaryQueryTimeout caps a single aggregation request. Sized for very
// large tenants — at 5s the CTE query should comfortably handle 10k+ zones
// with the existing indexes. If the timeout fires the client retries via
// the same UI flow; we don't want a single slow request to wedge the page.
const summaryQueryTimeout = 5 * time.Second

// WarehouseSummariesRouter mounts the paginated, server-aggregated warehouse
// summary endpoint. Mounted under the tenant-scoped group so the tenant id is
// already extracted into context.
//
//	GET /api/v1/warehouse-summaries?search=&emptyOnly=&sort=&dir=&page=&pageSize=
//
// Returns `{ data: { rows: [...], total: N, page: P, pageSize: S } }`.
//
// Why a dedicated endpoint instead of /zones with extra joins:
//   - Returning the per-zone aggregates (rack count, bin count, occupancy %,
//     asset count, floor count) in one round-trip is what makes the table
//     scale. The previous client-side approach pulled every zone/grid/bin/
//     marker/image row to compute the same numbers in React — fine for a
//     handful of warehouses, but O(n × #shapes) wire traffic at scale.
//   - The handler does ONE SQL query with CTE aggregates + a window function
//     for the total count, so pagination doesn't cost a second round-trip.
//   - Sort key and direction are validated against a fixed allow-list
//     (`sortColumns`) before being interpolated into ORDER BY. Search and
//     emptyOnly are parameterized.
func WarehouseSummariesRouter(pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listWarehouseSummaries(pool))
	// Stats-only sibling — the dashboard's KPI cards don't need the row
	// list, so we expose just the totals block here. Same query as the
	// listing handler's stats step.
	r.Get("/stats", warehouseSummariesStatsOnly(pool))
	return r
}

func warehouseSummariesStatsOnly(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), summaryQueryTimeout)
		defer cancel()
		var stats WarehouseSummariesStats
		const sqlText = `
SELECT
  (SELECT COUNT(*) FROM zones   WHERE tenant_id = $1)                                                          AS total_warehouses,
  (SELECT COUNT(*) FROM bins    WHERE tenant_id = $1 AND target_kind = 'grid-cell')                            AS total_bins,
  (SELECT COUNT(*) FROM bins    WHERE tenant_id = $1 AND target_kind = 'grid-cell' AND status = 'occupied')    AS occupied_bins,
  (SELECT COUNT(*) FROM markers WHERE tenant_id = $1)                                                          AS total_assets
`
		if err := pool.QueryRow(ctx, sqlText, tenantID).Scan(
			&stats.TotalWarehouses,
			&stats.TotalBins,
			&stats.OccupiedBins,
			&stats.TotalAssets,
		); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, stats)
	}
}

// sortColumns maps the public sort key to its SQL expression. The
// expressions reference columns exposed by the `joined` CTE — flat
// names, no `z.` alias. Anything not in this map is rejected; never
// interpolate user input into ORDER BY.
var sortColumns = map[string]string{
	"name":        "name",
	"binCount":    "bin_count",
	"occupiedPct": "CASE WHEN bin_count > 0 THEN (occupied_count::float / bin_count) ELSE 0 END",
	"assetCount":  "asset_count",
	"rackCount":   "rack_count",
	"floorCount":  "floor_count",
	"updatedAt":   "updated_at",
}

// WarehouseSummaryRow is what the client receives per row.
type WarehouseSummaryRow struct {
	ID            int64   `json:"id"`
	Name          string  `json:"name"`
	Color         string  `json:"color"`
	Address       string  `json:"address,omitempty"`
	ShareToken    string  `json:"shareToken,omitempty"`
	IsPublic      bool    `json:"isPublic"`
	RackCount     int64   `json:"rackCount"`
	BinCount      int64   `json:"binCount"`
	OccupiedCount int64   `json:"occupiedCount"`
	OccupiedPct   float64 `json:"occupiedPct"`
	AssetCount    int64   `json:"assetCount"`
	FloorCount    int64   `json:"floorCount"`
	// ThumbnailURL is the facility's first visible base-floor plan image
	// (a relative /files/ URL), or empty when it has none.
	ThumbnailURL string `json:"thumbnailUrl,omitempty"`
	UpdatedAt    string `json:"updatedAt"`
	// ShareLinks is the first `maxShareLinksPerRow` share links issued for
	// this warehouse, active ones first. The facilities table renders them
	// as named chips so an operator can see and copy what's already shared
	// without opening each warehouse. ShareLinkCount is the untruncated
	// total so the UI can render a "+N more" affordance.
	ShareLinks     []ShareLinkSummary `json:"shareLinks,omitempty"`
	ShareLinkCount int64              `json:"shareLinkCount"`
}

// ShareLinkSummary is the trimmed share_links row the listing endpoint
// embeds per warehouse. Deliberately narrower than ShareLinkResponse: the
// table only needs enough to label a chip, build the URL, and tone the
// status badge. The full row (settings blob, audit fields) still comes
// from GET /warehouses/{id}/share-links when the dialog opens.
type ShareLinkSummary struct {
	ID        int64  `json:"id"`
	Token     string `json:"token"`
	Label     string `json:"label"`
	Status    string `json:"status"`
	ViewCount int64  `json:"viewCount"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

// maxShareLinksPerRow caps how many links ride along per warehouse. A
// facility with 50 issued links would otherwise bloat every page of the
// listing for chips the table never renders — it shows two and collapses
// the rest behind "+N".
const maxShareLinksPerRow = 6

// WarehouseSummariesStats is the tenant-wide totals block included in every
// listing response. These are independent of filters/pagination so the KPI
// cards stay consistent even when the user is searching or paging.
type WarehouseSummariesStats struct {
	TotalWarehouses int64 `json:"totalWarehouses"`
	TotalBins       int64 `json:"totalBins"`
	OccupiedBins    int64 `json:"occupiedBins"`
	TotalAssets     int64 `json:"totalAssets"`
}

// FilteredStats aggregates the rows that MATCH the current filter (across
// all pages — not just the visible page). Drives the KPI strip on the
// warehouses page so the numbers respond to search/filter changes.
type FilteredStats struct {
	Warehouses     int64   `json:"warehouses"`
	Bins           int64   `json:"bins"`
	Occupied       int64   `json:"occupied"`
	Assets         int64   `json:"assets"`
	AvgOccupiedPct float64 `json:"avgOccupiedPct"`
}

// WarehouseSummariesResponse is the JSON envelope for this endpoint.
type WarehouseSummariesResponse struct {
	Rows          []WarehouseSummaryRow   `json:"rows"`
	Total         int64                   `json:"total"`
	Page          int                     `json:"page"`
	PageSize      int                     `json:"pageSize"`
	Stats         WarehouseSummariesStats `json:"stats"`
	FilteredStats FilteredStats           `json:"filteredStats"`
}

func listWarehouseSummaries(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}

		q := r.URL.Query()
		search := strings.TrimSpace(q.Get("search"))
		emptyOnly := q.Get("emptyOnly") == "true"

		sortKey := q.Get("sort")
		if sortKey == "" {
			sortKey = "name"
		}
		sortSQL, ok := sortColumns[sortKey]
		if !ok {
			api.BadRequest(w, "invalid sort key")
			return
		}

		dir := strings.ToLower(q.Get("dir"))
		if dir != "asc" && dir != "desc" {
			dir = "asc"
		}

		page := api.IntQuery(r, "page", 1)
		if page < 1 {
			page = 1
		}
		pageSize := api.IntQuery(r, "pageSize", 25)
		if pageSize < 1 {
			pageSize = 25
		}
		if pageSize > 200 {
			// Cap to prevent runaway requests. 200 rows covers any reasonable
			// list view; anything more and the client should refine filters.
			pageSize = 200
		}
		offset := (page - 1) * pageSize

		// Optional `?solution=<id>` → only that solution's facilities
		// (nil = no filter, empty = the solution has none).
		solutionZones, ok := solutionScope(w, r, db.New(pool), "zones")
		if !ok {
			return
		}

		// One SQL trip. CTEs build per-zone aggregates ONCE (the join keys are
		// all indexed: tenant_id + zone_id / tenant_id + grid_id). The outer
		// SELECT uses COUNT(*) OVER() to return the full filtered row count
		// alongside each paginated row — so pagination doesn't need a second
		// query.
		//
		// `sortSQL` and `dir` are pre-validated against the allow-list above —
		// safe to interpolate. `search`, `emptyOnly`, `tenant_id`, `LIMIT`,
		// `OFFSET` are parameterized.
		//
		// `idx_grids_tenant_zone`, `idx_bins_grid`, `idx_markers_tenant_zone`,
		// `idx_images_tenant_zone`, and `idx_zones_tenant_name` carry the
		// hot paths. For very large tenant catalogs (10k+ zones) we'd swap
		// the ILIKE for a pg_trgm GIN index on `(lower(z.name)||' '||
		// lower(z.address))` — not warranted yet.
		sql := fmt.Sprintf(`
WITH grid_agg AS (
  SELECT zone_id, COUNT(*) AS rack_count
  FROM grids
  WHERE tenant_id = $1 AND zone_id IS NOT NULL
  GROUP BY zone_id
),
bin_agg AS (
  SELECT g.zone_id,
         COUNT(b.*) AS bin_count,
         COUNT(*) FILTER (WHERE b.status = 'occupied') AS occupied_count
  FROM bins b
  JOIN grids g ON g.id = b.grid_id
  WHERE b.tenant_id = $1
    AND b.target_kind = 'grid-cell'
    AND g.zone_id IS NOT NULL
  GROUP BY g.zone_id
),
marker_agg AS (
  SELECT zone_id, COUNT(*) AS asset_count
  FROM markers
  WHERE tenant_id = $1 AND zone_id IS NOT NULL
  GROUP BY zone_id
),
floor_agg AS (
  SELECT zone_id, COUNT(*) AS floor_count
  FROM images
  WHERE tenant_id = $1 AND zone_id IS NOT NULL AND floor_plan_id IS NULL
  GROUP BY zone_id
),
thumb_agg AS (
  -- The facility's first visible floor plan (base floor, oldest first):
  -- the card thumbnail on /dashboard and /warehouses.
  SELECT DISTINCT ON (zone_id) zone_id, image_url AS thumbnail_url
  FROM images
  WHERE tenant_id = $1 AND zone_id IS NOT NULL AND floor_plan_id IS NULL
    AND visible AND COALESCE(image_url, '') <> ''
  ORDER BY zone_id, created_at, id
),
joined AS (
  SELECT
    z.id, z.name, z.color, z.description, z.address, z.share_token, z.is_public, z.updated_at,
    COALESCE(ga.rack_count, 0)     AS rack_count,
    COALESCE(ba.bin_count, 0)      AS bin_count,
    COALESCE(ba.occupied_count, 0) AS occupied_count,
    COALESCE(ma.asset_count, 0)    AS asset_count,
    COALESCE(fa.floor_count, 0)    AS floor_count,
    ta.thumbnail_url
  FROM zones z
  LEFT JOIN grid_agg   ga ON ga.zone_id = z.id
  LEFT JOIN bin_agg    ba ON ba.zone_id = z.id
  LEFT JOIN marker_agg ma ON ma.zone_id = z.id
  LEFT JOIN floor_agg  fa ON fa.zone_id = z.id
  LEFT JOIN thumb_agg  ta ON ta.zone_id = z.id
  WHERE z.tenant_id = $1
    AND ($2 = '' OR z.name ILIKE '%%' || $2 || '%%' OR COALESCE(z.address, '') ILIKE '%%' || $2 || '%%')
    AND (NOT $3 OR COALESCE(ba.bin_count, 0) = 0)
    AND ($6::bigint[] IS NULL OR z.id = ANY($6::bigint[]))
)
SELECT
  id, name, color, address, share_token, is_public, updated_at,
  rack_count, bin_count, occupied_count, asset_count, floor_count, thumbnail_url,
  COUNT(*) OVER() AS total_count
FROM joined
ORDER BY %s %s, id ASC
LIMIT $4 OFFSET $5
`, sortSQL, strings.ToUpper(dir))

		ctx, cancel := context.WithTimeout(r.Context(), summaryQueryTimeout)
		defer cancel()

		rows, err := pool.Query(ctx, sql, tenantID, search, emptyOnly, pageSize, offset, solutionZones)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rows.Close()

		out := WarehouseSummariesResponse{
			Rows:     []WarehouseSummaryRow{},
			Page:     page,
			PageSize: pageSize,
		}
		for rows.Next() {
			var (
				row        WarehouseSummaryRow
				address    *string
				shareToken *string
				updatedAt  pgtype.Timestamptz
				thumbnail  *string
				totalCount int64
			)
			if err := rows.Scan(
				&row.ID, &row.Name, &row.Color,
				&address, &shareToken, &row.IsPublic, &updatedAt,
				&row.RackCount, &row.BinCount, &row.OccupiedCount,
				&row.AssetCount, &row.FloorCount, &thumbnail,
				&totalCount,
			); err != nil {
				api.InternalError(w, r, err)
				return
			}
			if address != nil {
				row.Address = *address
			}
			if shareToken != nil {
				row.ShareToken = *shareToken
			}
			if thumbnail != nil {
				row.ThumbnailURL = *thumbnail
			}
			if row.BinCount > 0 {
				row.OccupiedPct = float64(row.OccupiedCount) / float64(row.BinCount)
			}
			row.UpdatedAt = api.FormatTime(updatedAt)
			out.Rows = append(out.Rows, row)
			out.Total = totalCount
		}
		if err := rows.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// Share links for the visible page only. Kept out of the CTE above
		// because it's a one-to-many that would either fan out the row set
		// or need a json_agg the scanner has to re-parse; a second indexed
		// lookup over at most `pageSize` zone ids is cheaper and keeps the
		// aggregate query readable.
		if err := attachShareLinks(ctx, pool, tenantID, out.Rows); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// Tenant-wide stats. Independent of filters/pagination so the KPI
		// cards on the dashboard stay consistent regardless of what the
		// user is searching for. One small query, all indexed.
		// Inside a solution the KPIs cover that solution's facilities.
		const statsSQL = `
SELECT
  (SELECT COUNT(*) FROM zones   WHERE tenant_id = $1 AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[])))      AS total_warehouses,
  (SELECT COUNT(*) FROM bins    WHERE tenant_id = $1 AND target_kind = 'grid-cell'
     AND ($2::bigint[] IS NULL OR grid_id IN (SELECT id FROM grids WHERE tenant_id = $1 AND zone_id = ANY($2::bigint[]))))                         AS total_bins,
  (SELECT COUNT(*) FROM bins    WHERE tenant_id = $1 AND target_kind = 'grid-cell' AND status = 'occupied'
     AND ($2::bigint[] IS NULL OR grid_id IN (SELECT id FROM grids WHERE tenant_id = $1 AND zone_id = ANY($2::bigint[]))))                         AS occupied_bins,
  (SELECT COUNT(*) FROM markers WHERE tenant_id = $1 AND ($2::bigint[] IS NULL OR zone_id = ANY($2::bigint[]))) AS total_assets
`
		if err := pool.QueryRow(ctx, statsSQL, tenantID, solutionZones).Scan(
			&out.Stats.TotalWarehouses,
			&out.Stats.TotalBins,
			&out.Stats.OccupiedBins,
			&out.Stats.TotalAssets,
		); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// Filtered stats — aggregates over the FULL filtered set (not
		// just the current page) so the warehouses-page KPI strip reflects
		// the active search/empty-only filter. Re-uses the same CTEs as
		// the listing query so the numbers are consistent.
		const filteredSQL = `
WITH grid_agg AS (
  SELECT zone_id, COUNT(*) AS rack_count
  FROM grids WHERE tenant_id = $1 AND zone_id IS NOT NULL
  GROUP BY zone_id
),
bin_agg AS (
  SELECT g.zone_id,
         COUNT(b.*) AS bin_count,
         COUNT(*) FILTER (WHERE b.status = 'occupied') AS occupied_count
  FROM bins b
  JOIN grids g ON g.id = b.grid_id
  WHERE b.tenant_id = $1 AND b.target_kind = 'grid-cell' AND g.zone_id IS NOT NULL
  GROUP BY g.zone_id
),
marker_agg AS (
  SELECT zone_id, COUNT(*) AS asset_count
  FROM markers WHERE tenant_id = $1 AND zone_id IS NOT NULL
  GROUP BY zone_id
),
filtered AS (
  SELECT z.id,
         COALESCE(ba.bin_count, 0)      AS bin_count,
         COALESCE(ba.occupied_count, 0) AS occupied_count,
         COALESCE(ma.asset_count, 0)    AS asset_count
  FROM zones z
  LEFT JOIN grid_agg   ga ON ga.zone_id = z.id
  LEFT JOIN bin_agg    ba ON ba.zone_id = z.id
  LEFT JOIN marker_agg ma ON ma.zone_id = z.id
  WHERE z.tenant_id = $1
    AND ($2 = '' OR z.name ILIKE '%' || $2 || '%' OR COALESCE(z.address, '') ILIKE '%' || $2 || '%')
    AND (NOT $3 OR COALESCE(ba.bin_count, 0) = 0)
    AND ($4::bigint[] IS NULL OR z.id = ANY($4::bigint[]))
)
SELECT
  COUNT(*)                          AS warehouses,
  COALESCE(SUM(bin_count), 0)       AS bins,
  COALESCE(SUM(occupied_count), 0)  AS occupied,
  COALESCE(SUM(asset_count), 0)     AS assets,
  CASE WHEN SUM(bin_count) > 0
       THEN SUM(occupied_count)::float / SUM(bin_count)
       ELSE 0 END                   AS avg_occupied_pct
FROM filtered
`
		if err := pool.QueryRow(ctx, filteredSQL, tenantID, search, emptyOnly, solutionZones).Scan(
			&out.FilteredStats.Warehouses,
			&out.FilteredStats.Bins,
			&out.FilteredStats.Occupied,
			&out.FilteredStats.Assets,
			&out.FilteredStats.AvgOccupiedPct,
		); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// attachShareLinks fills in the ShareLinks / ShareLinkCount fields for a
// page of summary rows. One query for the whole page — never one per row.
//
// Ordering is done in Go rather than SQL because "active" is a computed
// predicate (revoked_at, expires_at, and view_count vs max_views all feed
// it — see computeShareLinkStatus). Expressing that twice, once in SQL for
// the sort and once in Go for the badge, is how the two drift apart.
func attachShareLinks(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID int64,
	rows []WarehouseSummaryRow,
) error {
	if len(rows) == 0 {
		return nil
	}
	zoneIDs := make([]int64, 0, len(rows))
	byZone := make(map[int64][]ShareLinkSummary, len(rows))
	for _, row := range rows {
		zoneIDs = append(zoneIDs, row.ID)
	}

	// `share_links_zone_idx (zone_id, revoked_at)` carries this. Revoked
	// rows are included so the table can show a killed link still exists —
	// same rationale as ListShareLinksByZone.
	const sqlText = `
SELECT zone_id, id, token, label, expires_at, max_views, view_count, revoked_at
FROM share_links
WHERE tenant_id = $1 AND zone_id = ANY($2)
ORDER BY zone_id, created_at DESC
`
	linkRows, err := pool.Query(ctx, sqlText, tenantID, zoneIDs)
	if err != nil {
		return err
	}
	defer linkRows.Close()

	for linkRows.Next() {
		var (
			zoneID int64
			row    db.ShareLink
		)
		if err := linkRows.Scan(
			&zoneID, &row.ID, &row.Token, &row.Label,
			&row.ExpiresAt, &row.MaxViews, &row.ViewCount, &row.RevokedAt,
		); err != nil {
			return err
		}
		summary := ShareLinkSummary{
			ID:        row.ID,
			Token:     row.Token,
			Label:     row.Label,
			Status:    computeShareLinkStatus(row),
			ViewCount: row.ViewCount,
		}
		if row.ExpiresAt.Valid {
			summary.ExpiresAt = row.ExpiresAt.Time.Format(time.RFC3339)
		}
		byZone[zoneID] = append(byZone[zoneID], summary)
	}
	if err := linkRows.Err(); err != nil {
		return err
	}

	for i := range rows {
		links := byZone[rows[i].ID]
		if len(links) == 0 {
			continue
		}
		// Active links first (the ones an operator can actually hand out),
		// each group still newest-first from the SQL ORDER BY.
		slices.SortStableFunc(links, func(a, b ShareLinkSummary) int {
			switch {
			case a.Status == b.Status:
				return 0
			case a.Status == "active":
				return -1
			case b.Status == "active":
				return 1
			default:
				return 0
			}
		})
		rows[i].ShareLinkCount = int64(len(links))
		if len(links) > maxShareLinksPerRow {
			links = links[:maxShareLinksPerRow]
		}
		rows[i].ShareLinks = links
	}
	return nil
}
