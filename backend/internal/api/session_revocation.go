package api

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5"
)

// Session revocation for stateless JWTs.
//
// A JWT can't be recalled once issued, so "sign out everywhere after a
// password reset" is implemented as a cut-off instead: users.password_changed_at
// is stamped on every password change, and OptionalJWTMiddleware rejects any
// token whose `iat` predates it. Tokens issued afterwards (the next login)
// pass normally.
//
// The lookup runs on every JWT-authenticated request, so results are cached
// per user for revocationCacheTTL. The instance that performs a reset primes
// its own cache via NoteSessionRevocation, so the cut-off is immediate there;
// other instances of a horizontally-scaled deploy pick it up within the TTL.

const (
	revocationCacheTTL = 30 * time.Second
	// revocationCacheMax bounds the map; past it, stale entries are pruned
	// on insert. One entry per active user, so this is rarely reached.
	revocationCacheMax = 10000
)

type revocationEntry struct {
	changedAt int64 // unix seconds; 0 = password never changed
	fetched   time.Time
}

var revocation = struct {
	mu    sync.Mutex
	q     *db.Queries
	cache map[int64]revocationEntry
}{cache: make(map[int64]revocationEntry)}

// EnableSessionRevocation turns the password_changed_at check on. Called
// once from main() at boot; until then (and in tests that never call it)
// every signature-valid token is accepted, as before.
func EnableSessionRevocation(q *db.Queries) {
	revocation.mu.Lock()
	revocation.q = q
	revocation.mu.Unlock()
}

// NoteSessionRevocation records a fresh password change so this process
// rejects older tokens immediately rather than after the cache TTL.
func NoteSessionRevocation(userID int64, changedAt time.Time) {
	revocation.mu.Lock()
	defer revocation.mu.Unlock()
	storeRevocationLocked(userID, revocationEntry{changedAt: changedAt.Unix(), fetched: time.Now()})
}

func storeRevocationLocked(userID int64, e revocationEntry) {
	if len(revocation.cache) >= revocationCacheMax {
		cutoff := time.Now().Add(-revocationCacheTTL)
		for id, old := range revocation.cache {
			if old.fetched.Before(cutoff) {
				delete(revocation.cache, id)
			}
		}
	}
	revocation.cache[userID] = e
}

// tokenRevoked reports whether a token issued at `issuedAt` (unix seconds)
// for `userID` predates that user's last password change.
func tokenRevoked(ctx context.Context, userID, issuedAt int64) (bool, error) {
	revocation.mu.Lock()
	q := revocation.q
	entry, ok := revocation.cache[userID]
	revocation.mu.Unlock()
	if q == nil {
		return false, nil
	}
	if !ok || time.Since(entry.fetched) > revocationCacheTTL {
		changed, err := q.GetUserPasswordChangedAt(ctx, userID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		// A missing user is not this check's call — handlers that load the
		// user (e.g. /auth/me) already answer 401 for it.
		entry = revocationEntry{fetched: time.Now()}
		if changed.Valid {
			entry.changedAt = changed.Time.Unix()
		}
		revocation.mu.Lock()
		storeRevocationLocked(userID, entry)
		revocation.mu.Unlock()
	}
	return entry.changedAt != 0 && issuedAt < entry.changedAt, nil
}
