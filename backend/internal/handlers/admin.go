// Package handlers — admin.go
//
// Platform-admin-only surface. Currently one endpoint:
//
//	GET /api/v1/admin/metrics — signup + workspace rollups for the
//	                            main /dashboard's admin section.
//	GET /api/v1/admin/users   — paginated user list with memberships.
//
// Gated on `IsPlatformAdminEmail(api.UserEmail(ctx))` so only the
// bootstrap owner (SGV_AUTH.BOOTSTRAP_EMAIL) can hit it. Tenant-scope
// is intentionally ignored — these metrics span every tenant on the
// deployment.
package handlers

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AdminMetricsResponse — the whole /admin/metrics payload. Small
// enough to compute + return on every request without caching (a
// handful of aggregate queries).
type AdminMetricsResponse struct {
	// DailySignups is one entry per day for the last 30 days, ordered
	// oldest → newest. Days with zero signups are included with count=0
	// so the frontend chart doesn't need to fill gaps itself.
	DailySignups []DailySignupBucket `json:"dailySignups"`
	// TotalUsers is every user_id in the users table.
	TotalUsers int64 `json:"totalUsers"`
	// VerifiedUsers is users whose verified_at is set (email OTP
	// completed OR bootstrap admin).
	VerifiedUsers int64 `json:"verifiedUsers"`
	// SignupsLast7Days / SignupsLast30Days are convenience rollups so
	// the header KPIs don't need to re-sum the daily series.
	SignupsLast7Days  int64 `json:"signupsLast7Days"`
	SignupsLast30Days int64 `json:"signupsLast30Days"`
	// TenantsByPlan / TenantsByStatus are legacy fields from the hosted
	// product. Self-hosted Spatial Map has no plans, so they always hold a
	// single bucket: {"self-hosted": TotalTenants} / {"active": TotalTenants}
	// (empty maps when there are no tenants).
	TenantsByPlan   map[string]int64 `json:"tenantsByPlan"`
	TenantsByStatus map[string]int64 `json:"tenantsByStatus"`
	// TotalTenants — every tenants row.
	TotalTenants int64 `json:"totalTenants"`
	// TrialsActive / TrialsExpiringSoon / TrialsExpired are legacy fields;
	// there are no trials in self-hosted Spatial Map, so they are always 0.
	TrialsActive       int64 `json:"trialsActive"`
	TrialsExpiringSoon int64 `json:"trialsExpiringSoon"`
	TrialsExpired      int64 `json:"trialsExpired"`
}

// DailySignupBucket — one day's user-signup count for the 30-day chart.
type DailySignupBucket struct {
	Date  string `json:"date"` // YYYY-MM-DD, UTC
	Count int64  `json:"count"`
}

// AdminRouter wires GET /metrics + GET /users under /api/v1/admin.
// Platform-admin gate runs inside each handler because it depends on
// the JWT middleware having populated api.UserEmail(ctx) already,
// which is enforced at the mount site.
func AdminRouter(_ interface { /* placeholder for future services */
}, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/metrics", adminMetricsHandler(pool))
	r.Get("/users", adminUsersHandler(pool))
	return r
}

func adminMetricsHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		email := api.UserEmail(r.Context())
		if !IsPlatformAdminEmail(email) {
			api.Error(w, http.StatusForbidden, "platform admin only")
			return
		}
		out, err := computeAdminMetrics(r.Context(), pool)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// computeAdminMetrics runs the aggregate SQL and stitches the
// response. Each query is small + indexed; total round-trip should
// stay well under a hundred milliseconds even for large tenants.
func computeAdminMetrics(ctx context.Context, pool *pgxpool.Pool) (AdminMetricsResponse, error) {
	out := AdminMetricsResponse{
		TenantsByPlan:   map[string]int64{},
		TenantsByStatus: map[string]int64{},
	}

	// 1. Daily signups over the last 30 days. Generate_series produces
	//    every day in the window so gaps land as count=0 without the
	//    frontend having to pad.
	{
		const q = `
      WITH days AS (
        SELECT (CURRENT_DATE - INTERVAL '29 days' + (n || ' days')::INTERVAL)::DATE AS d
        FROM generate_series(0, 29) AS n
      ),
      counts AS (
        SELECT DATE_TRUNC('day', created_at)::DATE AS d, COUNT(*) AS c
        FROM users
        WHERE created_at >= CURRENT_DATE - INTERVAL '29 days'
        GROUP BY 1
      )
      SELECT days.d, COALESCE(counts.c, 0)::BIGINT
      FROM days LEFT JOIN counts ON counts.d = days.d
      ORDER BY days.d ASC`
		rows, err := pool.Query(ctx, q)
		if err != nil {
			return out, err
		}
		defer rows.Close()
		buckets := make([]DailySignupBucket, 0, 30)
		for rows.Next() {
			var d time.Time
			var c int64
			if err := rows.Scan(&d, &c); err != nil {
				return out, err
			}
			buckets = append(buckets, DailySignupBucket{
				Date:  d.Format("2006-01-02"),
				Count: c,
			})
		}
		out.DailySignups = buckets
	}

	// 2. User headline totals — one round-trip.
	{
		const q = `
      SELECT
        COUNT(*)::BIGINT AS total,
        COUNT(*) FILTER (WHERE verified_at IS NOT NULL)::BIGINT AS verified,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '6 days')::BIGINT AS last7,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '29 days')::BIGINT AS last30
      FROM users`
		row := pool.QueryRow(ctx, q)
		if err := row.Scan(&out.TotalUsers, &out.VerifiedUsers, &out.SignupsLast7Days, &out.SignupsLast30Days); err != nil {
			return out, err
		}
	}

	// 3. Tenant total. Every tenant is on the single self-hosted "plan".
	{
		const q = `SELECT COUNT(*)::BIGINT FROM tenants`
		if err := pool.QueryRow(ctx, q).Scan(&out.TotalTenants); err != nil {
			return out, err
		}
		if out.TotalTenants > 0 {
			out.TenantsByPlan[SelfHostedPlan] = out.TotalTenants
			out.TenantsByStatus[SelfHostedSubscriptionStatus] = out.TotalTenants
		}
	}

	return out, nil
}

// ─────────────────────────────────────────────── /admin/users

// AdminUsersResponse — paginated user list with tenant memberships so
// the admin can see who's signed up, when, whether they've verified
// their email, and which workspaces they belong to.
type AdminUsersResponse struct {
	Users      []AdminUserRow `json:"users"`
	TotalCount int64          `json:"totalCount"`
	Page       int            `json:"page"`
	PageSize   int            `json:"pageSize"`
}

// AdminUserRow — one row in the admin users table. Never carries a
// password_hash. `Memberships` is populated lazily per page (one
// query for the ids in this page).
type AdminUserRow struct {
	ID          int64             `json:"id"`
	Email       string            `json:"email"`
	DisplayName string            `json:"displayName"`
	JobTitle    string            `json:"jobTitle,omitempty"`
	CreatedAt   string            `json:"createdAt"`
	VerifiedAt  string            `json:"verifiedAt,omitempty"`
	LastLoginAt string            `json:"lastLoginAt,omitempty"`
	Memberships []AdminMembership `json:"memberships"`
}

// AdminMembership — one workspace the user belongs to. Plan /
// SubscriptionStatus / IsLocked are legacy fields that always carry the
// neutral self-hosted values ("self-hosted" / "active" / false);
// trialEndsAt is always omitted.
type AdminMembership struct {
	TenantID           int64  `json:"tenantId"`
	TenantName         string `json:"tenantName"`
	Role               string `json:"role"`
	Plan               string `json:"plan"`
	SubscriptionStatus string `json:"subscriptionStatus"`
	TrialEndsAt        string `json:"trialEndsAt,omitempty"`
	IsLocked           bool   `json:"isLocked"`
}

func adminUsersHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		email := api.UserEmail(r.Context())
		if !IsPlatformAdminEmail(email) {
			api.Error(w, http.StatusForbidden, "platform admin only")
			return
		}
		q := r.URL.Query()
		page := clampInt(parseIntDefault(q.Get("page"), 1), 1, 10_000)
		pageSize := clampInt(parseIntDefault(q.Get("pageSize"), 25), 1, 200)
		search := strings.ToLower(strings.TrimSpace(q.Get("q")))

		out, err := listAdminUsers(r.Context(), pool, page, pageSize, search)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, out)
	}
}

func listAdminUsers(
	ctx context.Context,
	pool *pgxpool.Pool,
	page, pageSize int,
	search string,
) (AdminUsersResponse, error) {
	out := AdminUsersResponse{
		Users:    []AdminUserRow{},
		Page:     page,
		PageSize: pageSize,
	}

	// Search matches lowercased email OR display_name — matches the
	// index we already have on lower(email).
	searchClause := ""
	args := []any{}
	if search != "" {
		searchClause = "WHERE lower(u.email) LIKE $1 OR lower(u.display_name) LIKE $1"
		args = append(args, "%"+search+"%")
	}

	// Total count first — cheap because the users table stays small
	// relative to data-source rows. Powers pagination.
	countSQL := "SELECT COUNT(*)::BIGINT FROM users u " + searchClause
	if err := pool.QueryRow(ctx, countSQL, args...).Scan(&out.TotalCount); err != nil {
		return out, err
	}

	// Page — newest signup first is the useful admin default.
	limit := pageSize
	offset := (page - 1) * pageSize
	pageSQL := `
    SELECT u.id, u.email, u.display_name, u.job_title,
           u.created_at, u.verified_at, u.last_login_at
    FROM users u
    ` + searchClause + `
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT $` + strconv.Itoa(len(args)+1) + ` OFFSET $` + strconv.Itoa(len(args)+2)
	pageArgs := append(append([]any{}, args...), limit, offset)
	rows, err := pool.Query(ctx, pageSQL, pageArgs...)
	if err != nil {
		return out, err
	}
	defer rows.Close()

	users := make([]AdminUserRow, 0, pageSize)
	ids := make([]int64, 0, pageSize)
	for rows.Next() {
		var (
			id                                 int64
			emailV, dispV, jobV                string
			createdAt, verifiedAt, lastLoginAt interface{}
		)
		if err := rows.Scan(&id, &emailV, &dispV, &jobV, &createdAt, &verifiedAt, &lastLoginAt); err != nil {
			return out, err
		}
		users = append(users, AdminUserRow{
			ID:          id,
			Email:       emailV,
			DisplayName: dispV,
			JobTitle:    jobV,
			CreatedAt:   tsToString(createdAt),
			VerifiedAt:  tsToString(verifiedAt),
			LastLoginAt: tsToString(lastLoginAt),
			Memberships: []AdminMembership{},
		})
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}

	// Batch-load memberships for the current page — one query,
	// bucketed into user rows by user_id.
	if len(ids) > 0 {
		memSQL := `
      SELECT ut.user_id, ut.role,
             t.id, t.name
      FROM user_tenants ut
      JOIN tenants t ON t.id = ut.tenant_id
      WHERE ut.user_id = ANY($1)
      ORDER BY t.name ASC`
		mrows, err := pool.Query(ctx, memSQL, ids)
		if err != nil {
			return out, err
		}
		defer mrows.Close()
		byUser := make(map[int64][]AdminMembership, len(ids))
		for mrows.Next() {
			var (
				userID, tenantID int64
				role, name       string
			)
			if err := mrows.Scan(&userID, &role, &tenantID, &name); err != nil {
				return out, err
			}
			byUser[userID] = append(byUser[userID], AdminMembership{
				TenantID:           tenantID,
				TenantName:         name,
				Role:               role,
				Plan:               SelfHostedPlan,
				SubscriptionStatus: SelfHostedSubscriptionStatus,
				IsLocked:           false,
			})
		}
		if err := mrows.Err(); err != nil {
			return out, err
		}
		for i := range users {
			users[i].Memberships = byUser[users[i].ID]
			if users[i].Memberships == nil {
				users[i].Memberships = []AdminMembership{}
			}
		}
	}
	out.Users = users
	return out, nil
}

// ─────────────────────────────────────────────── helpers

func parseIntDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func clampInt(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// tsToString accepts pgx's timestamptz scan target (time.Time or nil)
// and produces an RFC3339 string, or "" when null. Uses interface{}
// so the caller can share a scan var across nullable + non-nullable
// columns without twin `pgtype.Timestamptz` boilerplate.
func tsToString(v interface{}) string {
	switch t := v.(type) {
	case time.Time:
		if t.IsZero() {
			return ""
		}
		return t.UTC().Format(time.RFC3339)
	case *time.Time:
		if t == nil || t.IsZero() {
			return ""
		}
		return t.UTC().Format(time.RFC3339)
	default:
		return ""
	}
}
