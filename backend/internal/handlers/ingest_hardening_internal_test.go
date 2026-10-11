package handlers

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/stretchr/testify/require"
)

func signForTest(secret string, ts int64, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", ts, body)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestWebhookSignatureVerification(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	body := []byte(`{"epc":"3034ABCD","rssi":-52}`)
	good := fmt.Sprintf("t=%d,v1=%s", now.Unix(), signForTest("s3cret", now.Unix(), string(body)))

	require.NoError(t, verifyWebhookSignature(good, body, "s3cret", now))
	require.ErrorIs(t, verifyWebhookSignature(good, body, "other", now), errSignatureMismatch)
	require.ErrorIs(t, verifyWebhookSignature(good, []byte(`{"epc":"tampered"}`), "s3cret", now), errSignatureMismatch)
	require.ErrorIs(t, verifyWebhookSignature(good, body, "s3cret", now.Add(301*time.Second)), errSignatureSkew)
	require.ErrorIs(t, verifyWebhookSignature(good, body, "s3cret", now.Add(-301*time.Second)), errSignatureSkew)
	require.NoError(t, verifyWebhookSignature(good, body, "s3cret", now.Add(299*time.Second)))

	// Rotation: an old and a new signature side by side; either may match.
	rotating := fmt.Sprintf("t=%d,v1=%s,v1=%s", now.Unix(), signForTest("old", now.Unix(), string(body)), signForTest("s3cret", now.Unix(), string(body)))
	require.NoError(t, verifyWebhookSignature(rotating, body, "s3cret", now))

	for _, bad := range []string{"v1=abcd", fmt.Sprintf("t=%d", now.Unix()), "t=x,v1=ab", fmt.Sprintf("t=%d,v1=zz", now.Unix()), "garbage"} {
		require.ErrorIs(t, verifyWebhookSignature(bad, body, "s3cret", now), errSignatureMissing, bad)
	}

	f := false
	tr := true
	require.NoError(t, checkWebhookSignature(webhookSigning{}, "", body, now), "no secret, nothing to verify")
	require.ErrorIs(t, checkWebhookSignature(webhookSigning{HMACSecret: "s3cret"}, "", body, now), errSignatureMissing, "absent flag means required")
	require.ErrorIs(t, checkWebhookSignature(webhookSigning{HMACSecret: "s3cret", RequireSignature: &tr}, "", body, now), errSignatureMissing)
	require.NoError(t, checkWebhookSignature(webhookSigning{HMACSecret: "s3cret", RequireSignature: &f}, "", body, now), "explicit legacy opt-out")
	require.ErrorIs(t, checkWebhookSignature(webhookSigning{HMACSecret: "s3cret", RequireSignature: &f}, "t=1,v1=00", body, now), errSignatureSkew, "a sent signature is always checked")
	require.NoError(t, checkWebhookSignature(webhookSigning{HMACSecret: "s3cret"}, good, body, now))

	s := webhookSigningFor([]byte(`{"hmacSecret":"abc","requireSignature":false}`))
	require.Equal(t, "abc", s.HMACSecret)
	require.NotNil(t, s.RequireSignature)
	require.False(t, *s.RequireSignature)
	require.Nil(t, webhookSigningFor([]byte(`{"hmacSecret":"abc"}`)).RequireSignature)
}

func TestParseEventTime(t *testing.T) {
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		in   any
		want time.Time
	}{
		{"absent", nil, now},
		{"empty string", "", now},
		{"rfc3339", "2026-10-05T11:59:00Z", time.Date(2026, 10, 5, 11, 59, 0, 0, time.UTC)},
		{"rfc3339 offset + nanos", "2026-10-05T13:59:00.5+02:00", time.Date(2026, 10, 5, 11, 59, 0, 500_000_000, time.UTC)},
		{"epoch seconds", float64(now.Add(-time.Minute).Unix()), now.Add(-time.Minute)},
		{"epoch seconds fractional", float64(now.Unix()) - 0.25, now.Add(-250 * time.Millisecond)},
		{"epoch ms", float64(now.Add(-time.Minute).UnixMilli()), now.Add(-time.Minute)},
		{"epoch ms as string", fmt.Sprint(now.Add(-time.Minute).UnixMilli()), now.Add(-time.Minute)},
		{"small clock drift ahead", now.Add(4 * time.Minute).Format(time.RFC3339), now.Add(4 * time.Minute)},
	}
	for _, c := range cases {
		got, err := parseEventTime(c.in, now)
		require.NoError(t, err, c.name)
		require.True(t, c.want.Equal(got), "%s: got %s want %s", c.name, got, c.want)
	}
	for name, in := range map[string]any{
		"words":      "yesterday",
		"loose date": "2026-10-05 11:59",
		"bool":       true,
		"object":     map[string]any{"t": 1},
		"far future": now.Add(10 * time.Minute).Format(time.RFC3339),
		"future ms":  float64(now.Add(time.Hour).UnixMilli()),
	} {
		_, err := parseEventTime(in, now)
		require.Error(t, err, name)
	}
}

// TestSSETenantIsolation: each stream only carries its own tenant's events.
func TestSSETenantIsolation(t *testing.T) {
	b := NewSSEBroadcaster()
	go b.Run()
	srv := httptest.NewServer(api.TenantMiddleware(nil)(b))
	defer srv.Close()

	open := func(tenant string) (*bufio.Reader, func()) {
		req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
		if tenant != "" {
			req.Header.Set("X-Tenant-Id", tenant)
		}
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			return nil, func() {}
		}
		require.Equal(t, "no", res.Header.Get("X-Accel-Buffering"))
		rd := bufio.NewReader(res.Body)
		line, err := rd.ReadString('\n')
		require.NoError(t, err)
		require.Equal(t, ": connected\n", line)
		return rd, func() { res.Body.Close() }
	}

	// Without a tenant the stream is refused rather than opened unfiltered.
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	res.Body.Close()
	require.Equal(t, http.StatusBadRequest, res.StatusCode)

	one, close1 := open("1")
	defer close1()
	two, close2 := open("2")
	defer close2()
	require.Eventually(t, func() bool {
		b.mu.RLock()
		defer b.mu.RUnlock()
		return len(b.clients) == 2
	}, 2*time.Second, 10*time.Millisecond)

	b.Broadcast(SSEEvent{Type: "ENTITY_UPDATED", Entity: "zones", ID: "7", TenantID: 1})
	b.Broadcast(SSEEvent{Type: "ENTITY_UPDATED", Entity: "zones", ID: "8", TenantID: 2})

	nextData := func(rd *bufio.Reader) string {
		got := make(chan string, 1)
		go func() {
			for {
				line, err := rd.ReadString('\n')
				if err != nil {
					got <- "ERR " + err.Error()
					return
				}
				if strings.HasPrefix(line, "data: ") {
					got <- line
					return
				}
			}
		}()
		select {
		case l := <-got:
			return l
		case <-time.After(2 * time.Second):
			return "TIMEOUT"
		}
	}
	l1 := nextData(one)
	require.Contains(t, l1, `"id":"7"`)
	require.Contains(t, l1, `"tenantId":1`)
	l2 := nextData(two)
	require.Contains(t, l2, `"id":"8"`, "tenant 2 must not see tenant 1's event first")
}

// TestWSHubRemovedWhenEmpty guards the old leak: removeHub("") never
// matched a real token, so every stream token ever used kept a hub.
func TestWSHubRemovedWhenEmpty(t *testing.T) {
	a := &wsClient{send: make(chan []byte, 1)}
	b := &wsClient{send: make(chan []byte, 1)}
	joinHub("tok-hub-test", 1, a)
	joinHub("tok-hub-test", 1, b)
	require.Same(t, a.hub, b.hub)

	a.hub.unregister(a)
	hubsMu.RLock()
	_, still := streamHubs["tok-hub-test"]
	hubsMu.RUnlock()
	require.True(t, still, "hub stays while a client is connected")

	b.hub.unregister(b)
	hubsMu.RLock()
	_, still = streamHubs["tok-hub-test"]
	hubsMu.RUnlock()
	require.False(t, still, "last client leaving removes the hub")

	// A later subscriber gets a fresh hub.
	c := &wsClient{send: make(chan []byte, 1)}
	joinHub("tok-hub-test", 1, c)
	require.NotSame(t, a.hub, c.hub)
	c.hub.unregister(c)
}
