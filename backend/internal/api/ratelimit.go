package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// KeyedLimiter is a bag of rate.Limiters, one per string key (typically an
// IP or an email). New keys get a fresh Limiter on demand; idle keys are
// evicted after `ttl` so the map can't grow unbounded from spam or a
// cycling-IP attacker.
//
// Chose x/time/rate.Limiter over a hand-rolled sliding-window because it
// already handles bursts + smooth refill and is a battle-tested std-adjacent
// dep. In-memory only — restarting the server resets counters. Good enough
// for a single-process deploy; if we ever scale horizontally the same knob
// belongs in Redis.
type KeyedLimiter struct {
	mu      sync.Mutex
	entries map[string]*keyedEntry
	rate    rate.Limit
	burst   int
	ttl     time.Duration
}

type keyedEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

// NewKeyedLimiter returns a limiter that refills at `perSecond` tokens per
// second, allows short bursts up to `burst`, and forgets keys idle longer
// than `ttl`.
func NewKeyedLimiter(perSecond float64, burst int, ttl time.Duration) *KeyedLimiter {
	kl := &KeyedLimiter{
		entries: make(map[string]*keyedEntry),
		rate:    rate.Limit(perSecond),
		burst:   burst,
		ttl:     ttl,
	}
	go kl.reap()
	return kl
}

func (k *KeyedLimiter) reap() {
	for {
		time.Sleep(5 * time.Minute)
		cutoff := time.Now().Add(-k.ttl)
		k.mu.Lock()
		for key, e := range k.entries {
			if e.seen.Before(cutoff) {
				delete(k.entries, key)
			}
		}
		k.mu.Unlock()
	}
}

// Allow returns true if the key has a token available. False means the
// caller has been throttled — the response should be 429.
func (k *KeyedLimiter) Allow(key string) bool {
	ok, _ := k.Check(key)
	return ok
}

// Check is Allow plus, when the key is throttled, how long until its next
// token refills. That wait is what a 429 advertises in Retry-After.
func (k *KeyedLimiter) Check(key string) (bool, time.Duration) {
	if key == "" {
		return true, 0
	}
	k.mu.Lock()
	entry, ok := k.entries[key]
	if !ok {
		entry = &keyedEntry{lim: rate.NewLimiter(k.rate, k.burst)}
		k.entries[key] = entry
	}
	entry.seen = time.Now()
	k.mu.Unlock()
	if entry.lim.Allow() {
		return true, 0
	}
	if k.rate <= 0 {
		return false, k.ttl
	}
	missing := 1 - entry.lim.Tokens()
	if missing < 0 {
		missing = 0
	}
	return false, time.Duration(missing / float64(k.rate) * float64(time.Second))
}

// RateLimitByIP throttles requests keyed by client IP. Returns a chi
// middleware that responds 429 with `message` when the key is starved.
func RateLimitByIP(k *KeyedLimiter, message string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if ok, wait := k.Check(ClientIP(r)); !ok {
				TooManyRequests(w, wait, message)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// trustedProxies holds the parsed CIDR list configured at startup via
// SetTrustedProxies. Reads are lock-free after startup because the slice
// is set once at boot and never mutated — a copy-on-write swap would be
// needed if that ever changes.
var trustedProxies []*net.IPNet

// SetTrustedProxies configures the CIDRs whose X-Forwarded-For /
// X-Real-IP headers ClientIP is allowed to trust. Parses each entry as
// a CIDR; bare IPs are auto-widened to /32 (v4) or /128 (v6). Bad entries
// are skipped and returned as errors so the caller can fail-fast on boot.
// Passing an empty list disables trust entirely (safe default).
func SetTrustedProxies(cidrs []string) []error {
	var out []*net.IPNet
	var errs []error
	for _, raw := range cidrs {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		if !strings.Contains(s, "/") {
			if ip := net.ParseIP(s); ip != nil {
				if ip.To4() != nil {
					s += "/32"
				} else {
					s += "/128"
				}
			}
		}
		_, network, err := net.ParseCIDR(s)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		out = append(out, network)
	}
	trustedProxies = out
	return errs
}

// IsTrustedProxyRemote reports whether `addr` (typically r.RemoteAddr)
// is inside the configured trusted-proxy allow-list. Exported so
// non-rate-limit callers (e.g. country-header extraction) can gate on
// the same trust boundary.
func IsTrustedProxyRemote(addr string) bool {
	return isTrustedProxy(addr)
}

func isTrustedProxy(addr string) bool {
	if len(trustedProxies) == 0 {
		return false
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, net := range trustedProxies {
		if net.Contains(ip) {
			return true
		}
	}
	return false
}

// ClientIP extracts the caller's address. If (and only if) the immediate
// connection RemoteAddr matches a configured trusted-proxy CIDR, the
// X-Forwarded-For (left-most) then X-Real-IP headers are honoured.
// Otherwise those headers are ignored to prevent rate-limit bypass by
// arbitrary internet callers who can set them freely.
func ClientIP(r *http.Request) string {
	if isTrustedProxy(r.RemoteAddr) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if comma := strings.Index(xff, ","); comma > 0 {
				return strings.TrimSpace(xff[:comma])
			}
			return strings.TrimSpace(xff)
		}
		if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
			return strings.TrimSpace(xrip)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
