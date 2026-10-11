package api

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/auth"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5"
)

// tenantKey is the context key for the current tenant ID.
type tenantKey struct{}

// userIDKey is the context key for the authenticated user's ID.
type userIDKey struct{}

// userEmailKey is the context key for the authenticated user's email.
type userEmailKey struct{}

// TenantID returns the tenant ID stored in the request context, or 0 if absent.
func TenantID(ctx context.Context) int64 {
	v, _ := ctx.Value(tenantKey{}).(int64)
	return v
}

// UserID returns the authenticated user's ID, or 0 if the request was not
// authenticated via JWT.
func UserID(ctx context.Context) int64 {
	v, _ := ctx.Value(userIDKey{}).(int64)
	return v
}

// UserEmail returns the authenticated user's email, or "" if the request was
// not authenticated via JWT.
func UserEmail(ctx context.Context) string {
	v, _ := ctx.Value(userEmailKey{}).(string)
	return v
}

// WithUser attaches the user ID and email to the context. Exported so the
// auth handlers can populate it on their own responses.
func WithUser(ctx context.Context, userID int64, email string) context.Context {
	ctx = context.WithValue(ctx, userIDKey{}, userID)
	ctx = context.WithValue(ctx, userEmailKey{}, email)
	return ctx
}

// OptionalJWTMiddleware parses Authorization: Bearer <jwt> if present and
// populates user_id + email in the request context.
//
// Distinguishing JWTs from API keys: a JWT always has exactly three
// dot-separated base64 segments. Anything else passes through unchanged so
// APIKeyMiddleware can handle it as an opaque API key. A malformed JWT
// (three segments but bad sig or expired) is rejected with 401 — having
// a present-but-broken token is an active signal worth surfacing.
func OptionalJWTMiddleware(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authz := r.Header.Get("Authorization")
			if !strings.HasPrefix(authz, "Bearer ") {
				next.ServeHTTP(w, r)
				return
			}
			token := strings.TrimPrefix(authz, "Bearer ")
			// Only attempt JWT parse if the value looks like one.
			if strings.Count(token, ".") != 2 {
				next.ServeHTTP(w, r)
				return
			}
			if secret == "" {
				// No secret configured but a JWT was sent — fall through.
				// Lets dev flow with empty SGV_AUTH.JWT_SECRET keep working.
				next.ServeHTTP(w, r)
				return
			}
			claims, err := auth.ParseToken(secret, token)
			if err != nil {
				Error(w, http.StatusUnauthorized, "invalid or expired token")
				return
			}
			// Tokens minted before the user's last password change are
			// dead — that's how a password reset signs out every session.
			revoked, err := tokenRevoked(r.Context(), claims.UserID, claims.IssuedAt)
			if err != nil {
				InternalError(w, r, err)
				return
			}
			if revoked {
				ErrorCode(w, http.StatusUnauthorized, "session_revoked", "session ended because the password was changed — please sign in again")
				return
			}
			ctx := WithUser(r.Context(), claims.UserID, claims.Email)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// TenantMiddleware extracts the tenant ID from the X-Tenant-Id header. When
// a JWT-authenticated user is in context, it also verifies the user is a
// member of that tenant — preventing cross-tenant access by a logged-in user
// who simply swaps the X-Tenant-Id header.
func TenantMiddleware(q *db.Queries) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("X-Tenant-Id")
			if header == "" {
				Error(w, http.StatusBadRequest, "missing X-Tenant-Id header")
				return
			}
			tenantID, err := strconv.ParseInt(header, 10, 64)
			if err != nil {
				Error(w, http.StatusBadRequest, "invalid X-Tenant-Id header")
				return
			}
			if userID := UserID(r.Context()); userID != 0 {
				_, err := q.GetUserTenantMembership(r.Context(), db.GetUserTenantMembershipParams{
					UserID:   userID,
					TenantID: tenantID,
				})
				if err != nil {
					if errors.Is(err, pgx.ErrNoRows) {
						Error(w, http.StatusForbidden, "not a member of this tenant")
						return
					}
					InternalError(w, r, err)
					return
				}
			}
			ctx := context.WithValue(r.Context(), tenantKey{}, tenantID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequestAPIKey reads the shared API key from X-Api-Key, then
// Authorization: Bearer, then the apiKey query parameter. The query
// fallback exists because WebSocket handshakes and plain device POSTs
// often cannot set headers.
func RequestAPIKey(r *http.Request) string {
	if key := r.Header.Get("X-Api-Key"); key != "" {
		return key
	}
	if authz := r.Header.Get("Authorization"); strings.HasPrefix(authz, "Bearer ") {
		return strings.TrimPrefix(authz, "Bearer ")
	}
	return r.URL.Query().Get("apiKey")
}

// APIKeyMatches compares in constant time so the key cannot be guessed
// byte by byte from response timing. An empty presented key never matches.
func APIKeyMatches(got, want string) bool {
	return got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// APIKeyMiddleware validates the Authorization: Bearer <key> header or x-api-key header.
// When apiKey is empty, validation is skipped so local dev works before a login flow exists.
//
// This runs AFTER OptionalJWTMiddleware. If the request already carries a
// valid JWT (user_id populated in context), we skip the API key check —
// JWT auth supersedes the shared key. Legacy API-key-only callers (e2e
// tests, dev tools) continue to work because they have no JWT to parse.
func APIKeyMiddleware(apiKey string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if apiKey == "" {
				next.ServeHTTP(w, r)
				return
			}
			if UserID(r.Context()) != 0 {
				// JWT already authenticated this request.
				next.ServeHTTP(w, r)
				return
			}
			if !APIKeyMatches(RequestAPIKey(r), apiKey) {
				Error(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
