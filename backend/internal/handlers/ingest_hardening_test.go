package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// TestEntityIngestHardening covers POST /streams/{id}/ingest: per-event
// errors, timestamp formats, the far-future and out-of-order guards, and
// the batch limits. Also the webhook signing opt-out for legacy senders.
func TestEntityIngestHardening(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	ctx := context.Background()
	q, pool, s, cleanup := setupTestDB(t, ctx)
	defer cleanup()
	apiKey := "test-api-key"
	router := testRouter(q, pool, s, apiKey)

	body, _ := json.Marshal(map[string]string{"name": "Ingest Tenant", "color": "#000000"})
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, newRequest(http.MethodPost, "/api/v1/tenants", body, apiKey, 0))
	require.Equal(t, http.StatusCreated, rr.Code)
	var tenant handlers.TenantResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &tenant))

	call := func(method, path string, v any) *httptest.ResponseRecorder {
		var b []byte
		if v != nil {
			b, _ = json.Marshal(v)
		}
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, newRequest(method, path, b, apiKey, tenant.ID))
		return rr
	}
	rr = call(http.MethodPost, "/api/v1/connections", map[string]any{
		"name": "Readers", "transport": "ws", "auth": map[string]any{"mode": "none"}, "config": map[string]any{"transport": "ws"},
	})
	require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
	var conn handlers.ConnectionResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &conn))
	newStream := func(name string, endpoint map[string]any) handlers.StreamResponse {
		rr := call(http.MethodPost, "/api/v1/streams", map[string]any{
			"connectionId": conn.ID, "name": name, "entityType": "rfid-tag", "kind": "state",
			"binding": map[string]any{"kind": "generic"}, "endpoint": endpoint,
		})
		require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
		var st handlers.StreamResponse
		require.NoError(t, extractData(rr.Body.Bytes(), &st))
		return st
	}
	stream := newStream("Dock door reads", map[string]any{"transport": "ws"})
	ingestPath := fmt.Sprintf("/api/v1/streams/%d/ingest", stream.ID)

	type ingestResp struct {
		Accepted int `json:"accepted"`
		Rejected int `json:"rejected"`
		Stale    int `json:"stale"`
		Errors   []struct {
			Index int    `json:"index"`
			Error string `json:"error"`
		} `json:"errors"`
	}
	ingest := func(events ...map[string]any) ingestResp {
		rr := call(http.MethodPost, ingestPath, map[string]any{"events": events})
		require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
		var out ingestResp
		require.NoError(t, extractData(rr.Body.Bytes(), &out))
		return out
	}

	now := time.Now().UTC().Truncate(time.Second)
	t2 := now.Add(-1 * time.Minute)
	t1 := now.Add(-2 * time.Minute)

	out := ingest(
		map[string]any{"entityKey": "EPC-1", "payload": map[string]any{"zone": "dock-2"}, "ts": t2.Format(time.RFC3339)},
		map[string]any{"entityKey": "EPC-2", "payload": map[string]any{"zone": "aisle-4"}, "ts": t1.UnixMilli()},
		map[string]any{"entityKey": "EPC-3", "payload": map[string]any{}, "ts": "yesterday"},
		map[string]any{"entityKey": "EPC-4", "payload": map[string]any{}, "ts": now.Add(time.Hour).Format(time.RFC3339)},
		map[string]any{"payload": map[string]any{"zone": "nowhere"}},
		map[string]any{"entityKey": "EPC-5", "payload": map[string]any{"zone": "gate"}, "ts": float64(t1.Unix())},
	)
	require.Equal(t, 3, out.Accepted)
	require.Equal(t, 3, out.Rejected)
	require.Zero(t, out.Stale)
	require.Len(t, out.Errors, 3)
	byIndex := map[int]string{}
	for _, e := range out.Errors {
		byIndex[e.Index] = e.Error
	}
	require.Contains(t, byIndex[2], "not RFC 3339")
	require.Contains(t, byIndex[3], "ahead of server time")
	require.Contains(t, byIndex[4], "entityKey is required")

	// An older read arriving late is logged but does not roll the state back.
	out = ingest(map[string]any{"entityKey": "EPC-1", "payload": map[string]any{"zone": "receiving"}, "ts": t1.Format(time.RFC3339)})
	require.Equal(t, 1, out.Accepted)
	require.Equal(t, 1, out.Stale)

	var zone string
	var seen time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload->>'zone', last_seen_at FROM entity_states WHERE stream_id = $1 AND entity_key = 'EPC-1'`, stream.ID).Scan(&zone, &seen))
	require.Equal(t, "dock-2", zone)
	require.True(t, t2.Equal(seen.UTC()), "state keeps the newer time, got %s", seen)
	var history int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM entity_events WHERE stream_id = $1 AND entity_key = 'EPC-1'`, stream.ID).Scan(&history))
	require.Equal(t, 2, history, "both reads are in the history")

	// A newer read moves it forward; epoch-seconds time landed exactly.
	out = ingest(map[string]any{"entityKey": "EPC-1", "payload": map[string]any{"zone": "shipping"}, "ts": now.Format(time.RFC3339)})
	require.Zero(t, out.Stale)
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload->>'zone' FROM entity_states WHERE stream_id = $1 AND entity_key = 'EPC-1'`, stream.ID).Scan(&zone))
	require.Equal(t, "shipping", zone)
	require.NoError(t, pool.QueryRow(ctx, `SELECT last_seen_at FROM entity_states WHERE stream_id = $1 AND entity_key = 'EPC-5'`, stream.ID).Scan(&seen))
	require.True(t, t1.Equal(seen.UTC()))

	// Limits: too many events, and an oversized body.
	many := make([]map[string]any, 5001)
	for i := range many {
		many[i] = map[string]any{"entityKey": fmt.Sprintf("K-%d", i)}
	}
	rr = call(http.MethodPost, ingestPath, map[string]any{"events": many})
	require.Equal(t, http.StatusRequestEntityTooLarge, rr.Code)
	big := `{"events":[{"entityKey":"X","payload":{"blob":"` + strings.Repeat("a", 9<<20) + `"}}]}`
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, newRequest(http.MethodPost, ingestPath, []byte(big), apiKey, tenant.ID))
	require.Equal(t, http.StatusRequestEntityTooLarge, rr.Code)

	// A stream from another tenant cannot be written through this one.
	body, _ = json.Marshal(map[string]string{"name": "Other Tenant", "color": "#111111"})
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, newRequest(http.MethodPost, "/api/v1/tenants", body, apiKey, 0))
	var other handlers.TenantResponse
	require.NoError(t, extractData(rr.Body.Bytes(), &other))
	b, _ := json.Marshal(map[string]any{"events": []map[string]any{{"entityKey": "EPC-9"}}})
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, newRequest(http.MethodPost, ingestPath, b, apiKey, other.ID))
	require.Equal(t, http.StatusNotFound, rr.Code)

	// Webhook signing opt-out: requireSignature=false lets an unsigned
	// legacy sender through, but a bad signature is still refused.
	legacy := newStream("Legacy sender", map[string]any{
		"transport": "webhook", "sourceToken": "legacy-token-01", "hmacSecret": "s3cret", "requireSignature": false,
	})
	require.NotZero(t, legacy.ID)
	post := func(sig string) int {
		payload := []byte(`{"epc":"3034"}`)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/legacy-token-01", bytes.NewReader(payload))
		req.Header.Set("X-Api-Key", apiKey)
		if sig != "" {
			req.Header.Set("X-Webhook-Signature", sig)
		}
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr.Code
	}
	require.Equal(t, http.StatusAccepted, post(""))
	require.Equal(t, http.StatusUnauthorized, post(signWebhook("wrong", []byte(`{"epc":"3034"}`))))
	require.Equal(t, http.StatusAccepted, post(signWebhook("s3cret", []byte(`{"epc":"3034"}`))))
}

// TestBulkUpsertSavepoints: one row failing in the database no longer
// aborts the transaction (partial success really is partial), and the
// audit trail records insert vs update correctly.
func TestBulkUpsertSavepoints(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	ctx := context.Background()
	q, pool, _, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	var userID, tenantID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (email, password_hash) VALUES ('bulk@example.com', 'x') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO tenants (name, color) VALUES ('Bulk', '#111111') RETURNING id`).Scan(&tenantID))
	_, err := pool.Exec(ctx, `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, userID, tenantID)
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(api.WithUser(req.Context(), userID, "bulk@example.com")))
		})
	})
	r.Use(api.TenantMiddleware(q))
	r.Mount("/tables", handlers.TablesRouter(q, pool))
	call := func(method, path string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		require.NoError(t, json.NewEncoder(&buf).Encode(body))
		req := httptest.NewRequest(method, path, &buf)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Tenant-Id", fmt.Sprintf("%d", tenantID))
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		return rr
	}
	rr := call(http.MethodPost, "/tables", map[string]any{
		"name": "Tags", "entityKind": "asset",
		"fields": []map[string]any{{"fieldKey": "name", "fieldLabel": "Name", "dataType": "text"}},
	})
	require.Equal(t, http.StatusCreated, rr.Code, rr.Body.String())
	var created struct {
		DataSource struct {
			ID int64 `json:"id"`
		} `json:"dataSource"`
	}
	require.NoError(t, extractData(rr.Body.Bytes(), &created))
	path := fmt.Sprintf("/tables/%d/rows/bulk", created.DataSource.ID)

	type bulkResp struct {
		Upserted int                 `json:"upserted"`
		Errors   []map[string]string `json:"errors"`
	}
	// Row 1 carries a NUL character, which Postgres jsonb rejects — a
	// database error, not a validation one.
	rr = call(http.MethodPost, path, map[string]any{"rows": []map[string]any{
		{"entityKey": "A-1", "payload": map[string]any{"name": "Alpha"}},
		{"entityKey": "B-2", "payload": map[string]any{"name": "bad\u0000name"}},
		{"entityKey": "C-3", "payload": map[string]any{"name": "Gamma"}},
	}})
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
	var out bulkResp
	require.NoError(t, extractData(rr.Body.Bytes(), &out))
	require.Equal(t, 2, out.Upserted, rr.Body.String())
	require.Len(t, out.Errors, 1)
	require.Equal(t, "1", out.Errors[0]["index"])

	rr = call(http.MethodPost, path, map[string]any{"rows": []map[string]any{
		{"entityKey": "A-1", "payload": map[string]any{"name": "Alpha 2"}},
	}})
	require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())

	rows, err := pool.Query(ctx, `SELECT entity_key, operation FROM data_source_row_events WHERE source_id = $1 ORDER BY id`, created.DataSource.ID)
	require.NoError(t, err)
	var ops []string
	for rows.Next() {
		var k, op string
		require.NoError(t, rows.Scan(&k, &op))
		ops = append(ops, k+":"+op)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []string{"A-1:insert", "C-3:insert", "A-1:update"}, ops)

	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM data_source_rows WHERE source_id = $1`, created.DataSource.ID).Scan(&count))
	require.Equal(t, 2, count)
}
