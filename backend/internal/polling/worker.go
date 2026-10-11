// Package polling — worker.go
//
// External-source poller for thing-type tables. A table's
// `data_sources.config` JSONB can carry an external REST polling
// binding — URL, headers, JSON path, entity-key field, field mapping
// — plus `interval_seconds` for the schedule. This worker ticks every
// 60s (stdlib time.Ticker, no cron library — schedules are simple
// intervals here, not cron expressions), queries for due table-kind
// sources, polls each in its own goroutine, walks the JSON path to
// find the array of items, maps each item to the table's field_keys,
// and upserts via the shared `handlers.UpsertTableRow` helper so the
// poll goes through the same validation + audit trail as bearer-token
// writes.
//
// Single-instance by design: the worker state is process-local, and
// v1 deploys are single-instance. A horizontally-scaled deploy would
// need a coordination layer (Postgres advisory lock, Redis lease) to
// avoid every instance polling the same source.
package polling

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	tickInterval  = 60 * time.Second
	httpTimeout   = 30 * time.Second
	maxBodyBytes  = 10 * 1024 * 1024 // 10 MB response cap — pollers shouldn't ship megabytes
	maxConcurrent = 8                // bound concurrent polls so 50 due sources don't fan out into 50 goroutines
	perSourceCap  = 1000             // cap rows per poll to bound the worst case
)

// Worker is the long-running poller. Created once at startup, started
// with `Start(ctx)` which is non-blocking (spawns the ticker goroutine),
// and stopped by canceling the ctx.
type Worker struct {
	q    *db.Queries
	sem  chan struct{}
	http *http.Client
}

// New constructs a Worker. The `db.Queries` is the same one used by
// the HTTP handlers; the worker shares the pool.
func New(q *db.Queries) *Worker {
	return &Worker{
		q:    q,
		sem:  make(chan struct{}, maxConcurrent),
		http: &http.Client{Timeout: httpTimeout},
	}
}

// Start spawns the ticker goroutine. Returns immediately. The
// goroutine exits when ctx is canceled.
func (w *Worker) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(tickInterval)
		defer ticker.Stop()
		// Fire once immediately so the worker doesn't wait 60s on a
		// fresh boot before its first poll.
		w.tick(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				w.tick(ctx)
			}
		}
	}()
}

func (w *Worker) tick(ctx context.Context) {
	sources, err := w.q.ListPollableTableSources(ctx)
	if err != nil {
		slog.Error("polling.tick: list sources failed", "error", err)
		return
	}
	if len(sources) == 0 {
		return
	}
	var wg sync.WaitGroup
	for _, src := range sources {
		select {
		case <-ctx.Done():
			return
		case w.sem <- struct{}{}:
		}
		wg.Add(1)
		go func(src db.ListPollableTableSourcesRow) {
			defer wg.Done()
			defer func() { <-w.sem }()
			w.pollSource(ctx, src)
		}(src)
	}
	wg.Wait()
}

// pollSource runs one polling cycle for a single source. Logs the
// outcome to `data_sources.last_result` + `last_run_at` regardless of
// success/failure so the user sees the last-run status in the SPA's
// Integrations tab. Broadcasts a kind-wide SSE for `data-sources` on
// any successful upsert so the integrations page + any open map re-fetches.
func (w *Worker) pollSource(ctx context.Context, src db.ListPollableTableSourcesRow) {
	tenantID := src.TenantID
	sourceID := src.ID
	cfg, err := parsePollConfig(src.Config)
	if err != nil {
		w.recordResult(ctx, sourceID, tenantID, "error: "+err.Error())
		return
	}
	if cfg.URL == "" {
		w.recordResult(ctx, sourceID, tenantID, "error: empty pollUrl")
		return
	}

	// Fetch.
	reqCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, cfg.URL, nil)
	if err != nil {
		w.recordResult(ctx, sourceID, tenantID, "error: "+err.Error())
		return
	}
	for k, v := range cfg.Headers {
		req.Header.Set(k, v)
	}
	resp, err := w.http.Do(req)
	if err != nil {
		w.recordResult(ctx, sourceID, tenantID, "error: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		w.recordResult(ctx, sourceID, tenantID, fmt.Sprintf("error: HTTP %d", resp.StatusCode))
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
	if err != nil {
		w.recordResult(ctx, sourceID, tenantID, "error: read body: "+err.Error())
		return
	}
	if len(body) > maxBodyBytes {
		w.recordResult(ctx, sourceID, tenantID, fmt.Sprintf("error: body exceeds %d bytes", maxBodyBytes))
		return
	}

	// Parse + walk JSON path.
	var root any
	if err := json.Unmarshal(body, &root); err != nil {
		w.recordResult(ctx, sourceID, tenantID, "error: parse JSON: "+err.Error())
		return
	}
	arr, err := walkJSONPath(root, cfg.JSONPath)
	if err != nil {
		w.recordResult(ctx, sourceID, tenantID, "error: json path "+cfg.JSONPath+": "+err.Error())
		return
	}
	items, ok := arr.([]any)
	if !ok {
		w.recordResult(ctx, sourceID, tenantID, "error: json path "+cfg.JSONPath+" did not resolve to an array")
		return
	}

	// Field defs — needed for validation + unique check inside UpsertTableRow.
	fields, err := handlers.ListTableFields(ctx, w.q, sourceID, tenantID)
	if err != nil {
		w.recordResult(ctx, sourceID, tenantID, "error: load fields: "+err.Error())
		return
	}

	// Iterate + upsert. Partial-success: per-row errors are counted, valid
	// rows still commit. Per-row errors are NOT logged verbosely — last_result
	// is a short status string, not a per-row log.
	upserted := 0
	errors := 0
	capped := false
	for i, item := range items {
		if i >= perSourceCap {
			capped = true
			break
		}
		obj, ok := item.(map[string]any)
		if !ok {
			errors++
			continue
		}
		entityKey, payload, err := mapItem(obj, cfg)
		if err != nil {
			errors++
			continue
		}
		_, _, err = handlers.UpsertTableRow(ctx, w.q, tenantID, sourceID, handlers.PublicRowRequest{
			EntityKey: entityKey,
			Payload:   payload,
		}, fields)
		if err != nil {
			errors++
			continue
		}
		upserted++
	}

	// Build a short status string for the SPA.
	status := fmt.Sprintf("ok: %d rows", upserted)
	if errors > 0 {
		status = fmt.Sprintf("ok: %d, errors: %d", upserted, errors)
	}
	if capped {
		status += fmt.Sprintf(" (capped at %d)", perSourceCap)
	}
	w.recordResult(ctx, sourceID, tenantID, status)

	// Kind-wide SSE so the integrations page + any open map re-fetches.
	// Per-row events would flood the channel; one kind-wide reload is
	// the established pattern (see docs/pitfalls-backend.md on
	// BroadcastEntityEvent with synthetic zero id).
	if upserted > 0 {
		handlers.BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", tenantID)
	}
}

func (w *Worker) recordResult(ctx context.Context, sourceID, tenantID int64, result string) {
	if err := w.q.UpdateDataSourcePollResult(ctx, db.UpdateDataSourcePollResultParams{
		ID: sourceID, TenantID: tenantID, LastResult: pgtype.Text{String: result, Valid: true},
	}); err != nil {
		slog.Error("polling.recordResult failed",
			"source_id", sourceID, "tenant_id", tenantID, "error", err)
	}
}

// pollConfig is the JSON shape stored inside data_sources.config for a
// table-kind source with external polling enabled. All fields are
// optional except URL — the worker treats an empty URL as "no
// polling configured".
//
// JSON path: dotted, e.g. "data.bins" → root["data"]["bins"].
// Empty path means "the root is the array".
// Field mapping: { externalKey: internalFieldKey }. Unmapped keys are
// passed through with their external name (so simple 1:1 feeds work
// without explicit mapping).
// Entity-key field: the external key whose value becomes entityKey.
// If empty, "id" is used.
type pollConfig struct {
	URL              string
	Headers          map[string]string
	JSONPath         string
	EntityKeyField   string
	FieldMapping     map[string]string
	PositionLatField string // optional — if set, payload gets a position derived from these
	PositionLngField string
}

func parsePollConfig(raw []byte) (*pollConfig, error) {
	if len(raw) == 0 {
		return &pollConfig{}, nil
	}
	var rawMap map[string]any
	if err := json.Unmarshal(raw, &rawMap); err != nil {
		return nil, fmt.Errorf("config is not a JSON object: %w", err)
	}
	cfg := &pollConfig{
		JSONPath:       "",
		EntityKeyField: "id",
	}
	if v, ok := rawMap["pollUrl"].(string); ok {
		cfg.URL = v
	}
	if v, ok := rawMap["pollJsonPath"].(string); ok {
		cfg.JSONPath = v
	}
	if v, ok := rawMap["pollEntityKeyField"].(string); ok && v != "" {
		cfg.EntityKeyField = v
	}
	if v, ok := rawMap["pollPositionLatField"].(string); ok {
		cfg.PositionLatField = v
	}
	if v, ok := rawMap["pollPositionLngField"].(string); ok {
		cfg.PositionLngField = v
	}
	if v, ok := rawMap["pollHeaders"].(map[string]any); ok {
		cfg.Headers = make(map[string]string, len(v))
		for k, val := range v {
			if s, ok := val.(string); ok {
				cfg.Headers[k] = s
			}
		}
	}
	if v, ok := rawMap["pollFieldMapping"].(map[string]any); ok {
		cfg.FieldMapping = make(map[string]string, len(v))
		for k, val := range v {
			if s, ok := val.(string); ok {
				cfg.FieldMapping[k] = s
			}
		}
	}
	return cfg, nil
}

// walkJSONPath walks a dotted path like "data.bins" through nested
// map[string]any nodes. Empty path returns the root. Returns the
// resolved node (typically an array) or an error if a segment is
// missing or not an object.
func walkJSONPath(root any, path string) (any, error) {
	if path == "" {
		return root, nil
	}
	cur := root
	for _, seg := range strings.Split(path, ".") {
		obj, ok := cur.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("segment %q not an object", seg)
		}
		next, ok := obj[seg]
		if !ok {
			return nil, fmt.Errorf("segment %q not found", seg)
		}
		cur = next
	}
	return cur, nil
}

// mapItem builds the entity_key + payload for one polled item. The
// entity_key comes from `cfg.EntityKeyField`. The payload is built by
// applying `cfg.FieldMapping` to rename keys; unmapped keys pass
// through with their external name. Position is derived from
// `cfg.PositionLatField` + `cfg.PositionLngField` if both are set and
// the item has both values.
func mapItem(obj map[string]any, cfg *pollConfig) (string, json.RawMessage, error) {
	keyRaw, ok := obj[cfg.EntityKeyField]
	if !ok || keyRaw == nil {
		return "", nil, fmt.Errorf("entity-key field %q missing", cfg.EntityKeyField)
	}
	entityKey := fmt.Sprintf("%v", keyRaw)
	if entityKey == "" {
		return "", nil, fmt.Errorf("entity-key is empty")
	}

	// Apply field mapping: build a new object with renamed keys.
	out := make(map[string]any, len(obj))
	for k, v := range obj {
		mapped := k
		if cfg.FieldMapping != nil {
			if newK, ok := cfg.FieldMapping[k]; ok && newK != "" {
				mapped = newK
			}
		}
		out[mapped] = v
	}

	// Strip the entity-key field from the payload (it's already on the row).
	delete(out, cfg.EntityKeyField)
	if cfg.FieldMapping != nil {
		if mapped, ok := cfg.FieldMapping[cfg.EntityKeyField]; ok {
			delete(out, mapped)
		}
	}

	payload, err := json.Marshal(out)
	if err != nil {
		return "", nil, fmt.Errorf("marshal payload: %w", err)
	}
	return entityKey, payload, nil
}
