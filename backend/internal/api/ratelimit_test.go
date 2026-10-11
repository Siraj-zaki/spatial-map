package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestKeyedLimiter_Burst_Allows exercises the burst budget for a single key.
// Requests up to `burst` should pass immediately; the next one should be
// throttled because the refill rate is deliberately slow enough that no
// tokens accrue during the test.
func TestKeyedLimiter_Burst_Allows(t *testing.T) {
	// Refill 1 token per hour so we never see a mid-test top-up.
	kl := NewKeyedLimiter(1.0/3600.0, 3, time.Hour)

	for i := range 3 {
		if !kl.Allow("k") {
			t.Fatalf("burst token %d should have been allowed", i+1)
		}
	}
	if kl.Allow("k") {
		t.Fatal("burst exhausted, next call should have been denied")
	}
}

// TestKeyedLimiter_SeparateKeys confirms keys don't share the same bucket —
// exhausting one must not throttle the other.
func TestKeyedLimiter_SeparateKeys(t *testing.T) {
	kl := NewKeyedLimiter(1.0/3600.0, 2, time.Hour)

	if !kl.Allow("a") || !kl.Allow("a") {
		t.Fatal("burst for key a should have been allowed")
	}
	if kl.Allow("a") {
		t.Fatal("key a burst exhausted, next call should have been denied")
	}
	if !kl.Allow("b") {
		t.Fatal("key b should be independent of key a and get its own burst")
	}
}

// TestKeyedLimiter_EmptyKey documents the deliberate no-op for empty keys.
// The middleware would rather let a request through than block it because
// we failed to extract an IP — throttling on "" would bunch every anonymous
// caller into the same bucket.
func TestKeyedLimiter_EmptyKey(t *testing.T) {
	kl := NewKeyedLimiter(1.0/3600.0, 1, time.Hour)
	for i := range 100 {
		if !kl.Allow("") {
			t.Fatalf("empty key should always be allowed, denied at %d", i)
		}
	}
}

// TestKeyedLimiter_Refill checks that tokens actually replenish over time.
// Uses a very fast refill (100/sec) so the test finishes in under 20 ms.
func TestKeyedLimiter_Refill(t *testing.T) {
	kl := NewKeyedLimiter(100.0, 1, time.Hour) // 100 tokens/sec, burst 1

	if !kl.Allow("k") {
		t.Fatal("first call should consume the burst token")
	}
	if kl.Allow("k") {
		t.Fatal("second immediate call should be denied (bucket empty)")
	}
	// One token accrues every 10 ms; give it 25 ms to be safe.
	time.Sleep(25 * time.Millisecond)
	if !kl.Allow("k") {
		t.Fatal("bucket should have refilled after 25ms at 100/sec")
	}
}

// TestRateLimitByIP_Middleware checks the chi-facing wrapper: the handler
// runs while the bucket has tokens, and short-circuits with 429 once it
// doesn't.
func TestRateLimitByIP_Middleware(t *testing.T) {
	kl := NewKeyedLimiter(1.0/3600.0, 2, time.Hour)
	called := 0
	handler := RateLimitByIP(kl, "slow down")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("POST", "/x", nil)
	req.RemoteAddr = "192.0.2.1:1234"

	for i := range 2 {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("burst call %d: want 200, got %d", i+1, rr.Code)
		}
	}
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("third call: want 429, got %d", rr.Code)
	}
	if called != 2 {
		t.Fatalf("handler should have run 2 times before throttling, got %d", called)
	}
}

// TestClientIP_NoTrustedProxies is the safe default: XFF / X-Real-IP are
// IGNORED. This is critical — trusting them by default would let any
// internet caller spoof the header and bypass the rate limiter. The
// previous implementation had exactly this bug (verified by a live curl
// exploit that reached the handler at every rotated XFF value).
func TestClientIP_NoTrustedProxies(t *testing.T) {
	// Reset to safe default for this test.
	SetTrustedProxies(nil)
	cases := []struct {
		name       string
		remoteAddr string
		xff        string
		xrip       string
		want       string
	}{
		{"remote-addr only", "10.0.0.1:5555", "", "", "10.0.0.1"},
		{"xff IGNORED when proxy not trusted", "10.0.0.1:5555", "203.0.113.4", "", "10.0.0.1"},
		{"xrip IGNORED when proxy not trusted", "10.0.0.1:5555", "", "198.51.100.7", "10.0.0.1"},
		{"remote without port", "10.0.0.1", "", "", "10.0.0.1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			req.RemoteAddr = c.remoteAddr
			if c.xff != "" {
				req.Header.Set("X-Forwarded-For", c.xff)
			}
			if c.xrip != "" {
				req.Header.Set("X-Real-IP", c.xrip)
			}
			if got := ClientIP(req); got != c.want {
				t.Errorf("want %q, got %q", c.want, got)
			}
		})
	}
}

// TestClientIP_TrustedProxy exercises the happy path: when the connection
// is from an allow-listed proxy, X-Forwarded-For / X-Real-IP are honoured
// so the real client IP surfaces for rate limiting.
func TestClientIP_TrustedProxy(t *testing.T) {
	if errs := SetTrustedProxies([]string{"10.0.0.0/8", "192.168.1.1"}); errs != nil {
		t.Fatalf("SetTrustedProxies: %v", errs)
	}
	t.Cleanup(func() { SetTrustedProxies(nil) })

	cases := []struct {
		name       string
		remoteAddr string
		xff        string
		xrip       string
		want       string
	}{
		{"trusted proxy CIDR + xff", "10.0.0.42:5555", "203.0.113.4", "", "203.0.113.4"},
		{"trusted proxy CIDR + xff chain", "10.0.0.42:5555", "203.0.113.4, 10.0.0.5", "", "203.0.113.4"},
		{"trusted proxy CIDR + xff beats xrip", "10.0.0.42:5555", "203.0.113.4", "198.51.100.7", "203.0.113.4"},
		{"trusted proxy CIDR + xrip only", "10.0.0.42:5555", "", "198.51.100.7", "198.51.100.7"},
		{"trusted single IP", "192.168.1.1:5555", "203.0.113.4", "", "203.0.113.4"},
		{"untrusted IP just outside CIDR", "11.0.0.1:5555", "203.0.113.4", "", "11.0.0.1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			req.RemoteAddr = c.remoteAddr
			if c.xff != "" {
				req.Header.Set("X-Forwarded-For", c.xff)
			}
			if c.xrip != "" {
				req.Header.Set("X-Real-IP", c.xrip)
			}
			if got := ClientIP(req); got != c.want {
				t.Errorf("want %q, got %q", c.want, got)
			}
		})
	}
}

// TestSetTrustedProxies_BadCIDR verifies invalid entries surface as errors
// so the caller can fail-fast on boot instead of silently running with a
// broken allow-list (which would then either trust nothing when a proxy
// existed, or trust everything if the fallback were permissive).
func TestSetTrustedProxies_BadCIDR(t *testing.T) {
	errs := SetTrustedProxies([]string{"not-an-ip", "10.0.0.0/8", "999.999.999.999"})
	if len(errs) != 2 {
		t.Fatalf("expected 2 parse errors, got %d: %v", len(errs), errs)
	}
	// Cleanup for other tests.
	SetTrustedProxies(nil)
}

// TestKeyedLimiter_CheckReportsWait confirms a throttled key reports how
// long until its next token — the value 429s advertise in Retry-After.
func TestKeyedLimiter_CheckReportsWait(t *testing.T) {
	kl := NewKeyedLimiter(1.0/60.0, 1, time.Hour) // 1 token per minute

	if ok, wait := kl.Check("k"); !ok || wait != 0 {
		t.Fatalf("first call: got ok=%v wait=%v, want ok=true wait=0", ok, wait)
	}
	ok, wait := kl.Check("k")
	if ok {
		t.Fatal("second call should be throttled")
	}
	if wait <= 50*time.Second || wait > 60*time.Second {
		t.Fatalf("wait = %v, want just under 60s", wait)
	}
}

// TestRateLimitByIP_RetryAfter confirms the middleware's 429 carries a
// Retry-After header and the rate_limited code the SPA branches on.
func TestRateLimitByIP_RetryAfter(t *testing.T) {
	kl := NewKeyedLimiter(1.0/60.0, 1, time.Hour)
	h := RateLimitByIP(kl, "slow down")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest("POST", "/x", nil)
	req.RemoteAddr = "203.0.113.9:1234"

	h.ServeHTTP(httptest.NewRecorder(), req)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rr.Code)
	}
	if got := rr.Header().Get("Retry-After"); got == "" || got == "0" {
		t.Fatalf("Retry-After = %q, want a positive number of seconds", got)
	}
	if !strings.Contains(rr.Body.String(), `"code":"rate_limited"`) {
		t.Fatalf("body %s is missing the rate_limited code", rr.Body.String())
	}
}
