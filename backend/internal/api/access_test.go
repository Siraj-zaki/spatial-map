package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestRequireUserOrAPIKey pins who may reach workspace routes: a signed-in
// user, or a caller presenting the configured API key. With no key
// configured (the docker-compose default) an anonymous request must still
// be refused — that was the hole: APIKeyMiddleware let it through and any
// X-Tenant-Id was served.
func TestRequireUserOrAPIKey(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	cases := []struct {
		name       string
		configured string // auth.api_key
		sentKey    string // X-Api-Key
		signedIn   bool
		want       int
	}{
		{"no key configured, anonymous", "", "", false, http.StatusUnauthorized},
		{"no key configured, any key sent", "", "anything", false, http.StatusUnauthorized},
		{"no key configured, signed in", "", "", true, http.StatusOK},
		{"key configured, right key", "secret", "secret", false, http.StatusOK},
		{"key configured, wrong key", "secret", "nope", false, http.StatusUnauthorized},
		{"key configured, no key", "secret", "", false, http.StatusUnauthorized},
		{"key configured, signed in", "secret", "", true, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := APIKeyMiddleware(tc.configured)(RequireUserOrAPIKey(ok))
			req := httptest.NewRequest(http.MethodGet, "/api/v1/markers", nil)
			req.Header.Set("X-Tenant-Id", "1")
			if tc.sentKey != "" {
				req.Header.Set("X-Api-Key", tc.sentKey)
			}
			if tc.signedIn {
				req = req.WithContext(WithUser(req.Context(), 7, "member@example.com"))
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}
