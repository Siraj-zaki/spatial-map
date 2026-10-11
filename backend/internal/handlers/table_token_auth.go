// Package handlers — table_token_auth.go
//
// Middleware that authenticates public per-table CRUD requests via a
// scoped `table_api_tokens` bearer token. The plaintext token is never
// stored — we SHA-256 it and look the hash up in `table_api_tokens`. On
// a hit, the resolved (tenant_id, source_id, token_id) is stuffed into
// the request context so the public row handlers can scope every read
// and write without re-resolving.
//
// Auth surface: `Authorization: Bearer sgv_tbl_<...>` on the request
// header. Revoked tokens (revoked_at IS NOT NULL) and tokens on
// soft-deleted sources are filtered out by `GetTableByToken` so the
// middleware returns 401 in either case without distinguishing them —
// a revoked token and a never-existed token look identical to a caller.
//
// Rate limiting: per-token `api.KeyedLimiter` keyed on token_id. Default
// 60 req/min, burst 30, configurable via SGV_TABLES.RATE_LIMIT_PER_MIN
// (0 = unlimited). Per-token (not per-IP) because one IP may legitimately
// run many tokens (CI, fleet agents) and one token shouldn't be able to
// DOS the table for everyone else. Process-local — a horizontally-scaled
// deploy would need Redis for accurate cross-instance throttling, same
// caveat as the auth limiter.
package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
)

type tableTokenContextKey struct{}

type tableTokenInfo struct {
	TokenID  int64
	TenantID int64
	SourceID int64
}

// tableTokenFromContext returns the resolved token info, or zero if
// the request did not pass through TableTokenMiddleware. Public row
// handlers should call this and refuse to operate if it's zero — every
// query they run is scoped by (source_id, tenant_id) from this struct.
func tableTokenFromContext(ctx context.Context) tableTokenInfo {
	v, _ := ctx.Value(tableTokenContextKey{}).(tableTokenInfo)
	return v
}

// hashTableToken returns the lowercase SHA-256 hex of the plaintext
// token. Used both at mint time (store the hash) and at auth time
// (look the hash up) so the two sides provably share a single
// canonicalisation.
func hashTableToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// tableTokenRateLimiter is the package-singleton per-token limiter.
// Initialised by `InitTableTokenRateLimiter` (called from main.go on
// boot). When `rateLimitPerMin` is 0 the limiter is nil and the
// middleware short-circuits — every request is allowed through.
var tableTokenRateLimiter *api.KeyedLimiter

// InitTableTokenRateLimiter configures the per-token rate limiter.
// Call once at boot from main.go. Pass `rateLimitPerMin=0` to disable
// throttling entirely (the middleware will skip the Allow() call).
// Burst is set to half the per-minute rate (min 1) so a short ETL
// burst can exceed the steady-state rate without tripping 429s.
func InitTableTokenRateLimiter(rateLimitPerMin int) {
	if rateLimitPerMin <= 0 {
		tableTokenRateLimiter = nil
		return
	}
	burst := rateLimitPerMin / 2
	if burst < 1 {
		burst = 1
	}
	perSecond := float64(rateLimitPerMin) / 60.0
	tableTokenRateLimiter = api.NewKeyedLimiter(perSecond, burst, 30*time.Minute)
}

// TableTokenMiddleware validates the bearer token and stamps the
// resolved (tenant_id, source_id, token_id) into the request context.
// Mounted on `/api/v1/public/tables/*` only — never on the authed
// `/api/v1/tables/*` routes, those use JWT + TenantMiddleware.
func TableTokenMiddleware(q *db.Queries) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authz := r.Header.Get("Authorization")
			if !strings.HasPrefix(authz, "Bearer ") {
				api.Error(w, http.StatusUnauthorized, "missing bearer token")
				return
			}
			plaintext := strings.TrimPrefix(authz, "Bearer ")
			if plaintext == "" {
				api.Error(w, http.StatusUnauthorized, "empty bearer token")
				return
			}
			row, err := q.GetTableByToken(r.Context(), hashTableToken(plaintext))
			if err != nil {
				// Revoked, never-existed, or source soft-deleted — all 401.
				api.Error(w, http.StatusUnauthorized, "invalid token")
				return
			}
			// Per-token rate limit. Keyed on token_id (not the plaintext
			// — the hash is already the canonical key and avoids leaking
			// the plaintext into the limiter's map keys).
			if tableTokenRateLimiter != nil {
				if !tableTokenRateLimiter.Allow(strconv.FormatInt(row.TokenID, 10)) {
					api.Error(w, http.StatusTooManyRequests,
						"rate limit exceeded for this token")
					return
				}
			}
			ctx := context.WithValue(r.Context(), tableTokenContextKey{}, tableTokenInfo{
				TokenID:  row.TokenID,
				TenantID: row.TenantID,
				SourceID: row.SourceID,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// touchTableToken is the best-effort `last_used_at` bump called after
// a successful authenticated write. Caller swallows the error so a
// stale timestamp never blocks a legitimate row write — the audit
// trail in `data_source_row_events` is the authoritative record.
func touchTableToken(ctx context.Context, q *db.Queries, tokenID int64) {
	if tokenID == 0 {
		return
	}
	_ = q.TouchTableAPIToken(ctx, tokenID)
}

// Ensure fmt is used (rate-limit message above is the only consumer
// today; kept here so the import stays clean if future callers drop
// the format call).
var _ = fmt.Sprintf
