package handlers

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/errgroup"
)

// DashboardOverviewRouter mounts the workspace-overview endpoint.
//
//	GET /api/v1/dashboard-overview
//
// The dashboard was redesigned in 2026-07-20 from an operational KPI
// board (racks / occupancy / assets / top-N) into a workspace overview:
// counts of what exists in the current tenant (warehouses, members,
// integrations, active streams, files, bytes stored), a 30-day activity
// chart showing workspace growth (new warehouses, new members, new
// integrations per day), and a short list of the most recently created
// warehouses. Operational metrics belong on `/warehouses` where they
// respond to filters.
//
// Every branch of the response runs concurrently inside an errgroup —
// the SQL branches are cheap enough on their own but the storage-bytes
// branch enumerates the object store, so parallelising costs nothing
// and shortens the p99 tail.
func DashboardOverviewRouter(pool *pgxpool.Pool, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Get("/", dashboardOverview(pool, s))
	return r
}

// DashboardCounts is the tile grid on the dashboard. Every field is a
// tenant-scoped total; the `*Last30d` fields are the 30-day deltas
// rendered as "+N new in 30d" hints on the matching tile.
//
// `activeStreams` uses `streams.deleted_at IS NULL` to exclude
// soft-deleted rows — matches how the /data screen surfaces them. Same
// convention for `totalIntegrations` on `data_sources`.
//
// `totalStorageBytes` is the sum of bucket-object sizes for keys that
// resolve back to a URL currently stored on this tenant's image /
// image_plane / user_model rows. Avatars are intentionally excluded
// (they're profile data, not workspace assets — same rule as the
// Files admin gallery).
type DashboardCounts struct {
	TotalWarehouses     int64 `json:"totalWarehouses"`
	WarehousesLast30d   int64 `json:"warehousesLast30d"`
	TotalMembers        int64 `json:"totalMembers"`
	MembersLast30d      int64 `json:"membersLast30d"`
	TotalIntegrations   int64 `json:"totalIntegrations"`
	IntegrationsLast30d int64 `json:"integrationsLast30d"`
	ActiveStreams       int64 `json:"activeStreams"`
	TotalFiles          int64 `json:"totalFiles"`
	TotalStorageBytes   int64 `json:"totalStorageBytes"`
}

// DashboardTimelinePoint is one day in the 30-day activity chart.
// Warehouses / members / integrations mirror the create-flow signals
// the dashboard's admin audience actually cares about; the previous
// rack + bin layers were removed as part of the reframe.
type DashboardTimelinePoint struct {
	Date         string `json:"date"` // YYYY-MM-DD
	Warehouses   int64  `json:"warehouses"`
	Members      int64  `json:"members"`
	Integrations int64  `json:"integrations"`
}

// DashboardRecentRow is one of the "recently added warehouses" entries.
type DashboardRecentRow struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	CreatedAt string `json:"createdAt"`
}

// DashboardOverviewResponse is the JSON envelope returned to the client.
type DashboardOverviewResponse struct {
	Counts           DashboardCounts          `json:"counts"`
	Timeline         []DashboardTimelinePoint `json:"timeline"`
	RecentWarehouses []DashboardRecentRow     `json:"recentWarehouses"`
}

const dashboardQueryTimeout = 8 * time.Second

func dashboardOverview(pool *pgxpool.Pool, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), dashboardQueryTimeout)
		defer cancel()

		out := DashboardOverviewResponse{
			Timeline:         []DashboardTimelinePoint{},
			RecentWarehouses: []DashboardRecentRow{},
		}

		// Four parallel branches. Each writes into its own field on `out`
		// so no coordination beyond the errgroup is needed. If any
		// branch errors the whole response is aborted with 500 — the
		// dashboard is meant to be atomic (all-or-nothing) so partial
		// data doesn't confuse the UI.
		g, gctx := errgroup.WithContext(ctx)

		g.Go(func() error {
			return loadDashboardCounts(gctx, pool, tenantID, &out.Counts)
		})
		g.Go(func() error {
			return loadDashboardTimeline(gctx, pool, tenantID, &out.Timeline)
		})
		g.Go(func() error {
			return loadRecentWarehouses(gctx, pool, tenantID, &out.RecentWarehouses)
		})
		g.Go(func() error {
			return loadStorageStats(gctx, pool, s, tenantID, &out.Counts.TotalFiles, &out.Counts.TotalStorageBytes)
		})

		if err := g.Wait(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		api.JSON(w, http.StatusOK, out)
	}
}

// loadDashboardCounts pulls every scalar tile in one round-trip via a
// stack of subselects. Each subselect is an indexed COUNT on a
// tenant-scoped column, so this is bounded work regardless of tenant
// size.
func loadDashboardCounts(ctx context.Context, pool *pgxpool.Pool, tenantID int64, out *DashboardCounts) error {
	const sql = `
SELECT
  (SELECT COUNT(*) FROM zones          WHERE tenant_id = $1)                                                                    AS total_warehouses,
  (SELECT COUNT(*) FROM zones          WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '30 days')                       AS warehouses_30d,
  (SELECT COUNT(*) FROM user_tenants   WHERE tenant_id = $1)                                                                    AS total_members,
  (SELECT COUNT(*) FROM user_tenants   WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '30 days')                       AS members_30d,
  (SELECT COUNT(*) FROM data_sources   WHERE tenant_id = $1 AND deleted_at IS NULL)                                             AS total_integrations,
  (SELECT COUNT(*) FROM data_sources   WHERE tenant_id = $1 AND deleted_at IS NULL AND created_at >= NOW() - INTERVAL '30 days') AS integrations_30d,
  (SELECT COUNT(*) FROM streams        WHERE tenant_id = $1 AND deleted_at IS NULL)                                             AS active_streams
`
	return pool.QueryRow(ctx, sql, tenantID).Scan(
		&out.TotalWarehouses,
		&out.WarehousesLast30d,
		&out.TotalMembers,
		&out.MembersLast30d,
		&out.TotalIntegrations,
		&out.IntegrationsLast30d,
		&out.ActiveStreams,
	)
}

// loadDashboardTimeline builds a 30-day dense series (zero-days
// included) of workspace growth signals. `generate_series` supplies the
// axis so gaps become explicit zero-height bars in the chart.
func loadDashboardTimeline(ctx context.Context, pool *pgxpool.Pool, tenantID int64, out *[]DashboardTimelinePoint) error {
	const sql = `
WITH days AS (
  SELECT generate_series(
    (NOW() - INTERVAL '29 days')::date,
    NOW()::date,
    INTERVAL '1 day'
  )::date AS d
),
w AS (
  SELECT created_at::date AS d, COUNT(*) AS n
  FROM zones WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
  GROUP BY created_at::date
),
m AS (
  SELECT created_at::date AS d, COUNT(*) AS n
  FROM user_tenants WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
  GROUP BY created_at::date
),
i AS (
  SELECT created_at::date AS d, COUNT(*) AS n
  FROM data_sources WHERE tenant_id = $1 AND deleted_at IS NULL AND created_at >= NOW() - INTERVAL '30 days'
  GROUP BY created_at::date
)
SELECT d.d,
       COALESCE(w.n, 0) AS warehouses,
       COALESCE(m.n, 0) AS members,
       COALESCE(i.n, 0) AS integrations
FROM days d
LEFT JOIN w ON w.d = d.d
LEFT JOIN m ON m.d = d.d
LEFT JOIN i ON i.d = d.d
ORDER BY d.d ASC
`
	rows, err := pool.Query(ctx, sql, tenantID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			day                               pgtype.Date
			warehouses, members, integrations int64
		)
		if err := rows.Scan(&day, &warehouses, &members, &integrations); err != nil {
			return err
		}
		*out = append(*out, DashboardTimelinePoint{
			Date:         day.Time.Format("2006-01-02"),
			Warehouses:   warehouses,
			Members:      members,
			Integrations: integrations,
		})
	}
	return rows.Err()
}

// loadRecentWarehouses is the tail list of the 5 most recently created
// warehouses. Powers the "quick jump" list at the bottom of the page.
func loadRecentWarehouses(ctx context.Context, pool *pgxpool.Pool, tenantID int64, out *[]DashboardRecentRow) error {
	const sql = `
SELECT id, name, color, created_at
FROM zones
WHERE tenant_id = $1
ORDER BY created_at DESC
LIMIT 5
`
	rows, err := pool.Query(ctx, sql, tenantID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id        int64
			name      string
			color     string
			createdAt pgtype.Timestamptz
		)
		if err := rows.Scan(&id, &name, &color, &createdAt); err != nil {
			return err
		}
		*out = append(*out, DashboardRecentRow{
			ID:        id,
			Name:      name,
			Color:     color,
			CreatedAt: api.FormatTime(createdAt),
		})
	}
	return rows.Err()
}

// loadStorageStats computes `totalFiles` + `totalStorageBytes` for the
// current tenant. Approach:
//  1. Gather every URL persisted on this tenant's file-holding tables
//     (images, image_planes, user_models). Avatars are excluded per
//     the /files admin convention — they're profile data, not
//     workspace assets.
//  2. Enumerate the bucket via ObjectStore.ListObjects. Sum sizes of
//     the intersection.
//
// Two files can legitimately share the same object key (content-
// addressed hashing; identical bytes collide by design). `totalFiles`
// counts distinct file KEYS, which matches how the Files gallery
// renders them; `totalStorageBytes` sums each key's size ONCE for the
// same reason — a file uploaded three times still costs one file's
// worth of bytes on disk.
//
// Cost: O(tenant_urls + bucket_objects). This is the same enumeration
// the /files admin page runs on every request, so no new scaling
// concern — the Files gallery is the natural upper bound.
func loadStorageStats(
	ctx context.Context,
	pool *pgxpool.Pool,
	s store.ObjectStore,
	tenantID int64,
	totalFiles *int64,
	totalBytes *int64,
) error {
	// Deduplicate URL strings up-front. Same reasoning as above: two
	// rows pointing at the same key must not double-count.
	tenantURLs := map[string]struct{}{}

	const sql = `
SELECT image_url FROM images        WHERE tenant_id = $1 AND image_url <> ''
UNION
SELECT image_url FROM image_planes  WHERE tenant_id = $1 AND image_url <> ''
UNION
SELECT model_url FROM user_models   WHERE tenant_id = $1 AND model_url <> ''
`
	rows, err := pool.Query(ctx, sql, tenantID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			rows.Close()
			return err
		}
		tenantURLs[url] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	if len(tenantURLs) == 0 {
		return nil
	}

	objects, err := s.ListObjects(ctx)
	if err != nil {
		return err
	}
	for _, obj := range objects {
		// Reconstruct the URL exactly the way NormalizeAssetURL /
		// KeyFromURL round-trip it: `/files/<key>`. Anything else in
		// the DB wouldn't match this bucket key anyway.
		url := "/files/" + obj.Key
		if _, ok := tenantURLs[url]; !ok {
			continue
		}
		*totalFiles++
		*totalBytes += obj.Size
	}
	return nil
}

// Keep the strings import from becoming dead if the file ever loses
// its only user. Not currently needed but cheap to keep.
var _ = strings.TrimSpace
