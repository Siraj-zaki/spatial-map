package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

// upgrader configures the WebSocket handshake. Inbound live streams only
// carry JSON text frames, so the read/write buffers stay small.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// The Vite dev server and any production origin are allowed; auth is done
	// by the API key / tenant header, not by origin.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// wsHub holds the set of client connections for a single stream token.
// Messages received from any client are broadcast to every other client so
// the SPA can invalidate caches reactively without polling the database.
type wsHub struct {
	mu       sync.RWMutex
	clients  map[*wsClient]struct{}
	streamID int64
	token    string
}

// wsMaxMessageBytes caps one inbound frame; a larger frame closes the
// socket. Batches above this should be split by the publisher.
const wsMaxMessageBytes = 1 << 20

// wsIngestTimeout bounds the database writes for one inbound message.
const wsIngestTimeout = 15 * time.Second

type wsClient struct {
	hub  *wsHub
	conn *websocket.Conn
	send chan []byte
}

var (
	streamHubs = map[string]*wsHub{}
	hubsMu     sync.RWMutex
)

// joinHub finds or creates the token's hub and registers c in it, all
// under hubsMu so it cannot race unregister removing an emptied hub.
func joinHub(token string, streamID int64, c *wsClient) {
	hubsMu.Lock()
	defer hubsMu.Unlock()
	h, ok := streamHubs[token]
	if !ok {
		h = &wsHub{clients: map[*wsClient]struct{}{}, streamID: streamID, token: token}
		streamHubs[token] = h
	}
	c.hub = h
	h.register(c)
}

func (h *wsHub) register(c *wsClient) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

// unregister drops the client and, when it was the last one, the hub
// itself. hubsMu is taken first (same order as joinHub) so a client joining
// at that moment either lands in this hub before the emptiness check or
// gets a fresh one — never a hub that was just removed from the map.
func (h *wsHub) unregister(c *wsClient) {
	hubsMu.Lock()
	defer hubsMu.Unlock()
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	empty := len(h.clients) == 0
	h.mu.Unlock()
	if empty && streamHubs[h.token] == h {
		delete(streamHubs, h.token)
	}
}

func (h *wsHub) broadcast(sender *wsClient, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c == sender {
			continue
		}
		select {
		case c.send <- msg:
		default:
			// Client is slow; drop the message rather than block the hub.
		}
	}
}

// StreamWebSocketHandler upgrades HTTP requests to a WebSocket and runs the
// live ingest loop for a single stream token. The token is looked up in the
// database; the stream's entity_type decides which tables receive parsed events.
func StreamWebSocketHandler(q *db.Queries, pool *pgxpool.Pool, apiKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := chi.URLParam(r, "token")
		if token == "" {
			api.BadRequest(w, "missing stream token")
			return
		}

		// Browsers cannot set custom headers on a WebSocket handshake, so the
		// auth surface mirrors the header path but also accepts an apiKey query
		// parameter. The API key is validated here explicitly because the route
		// needs the query-param fallback.
		if err := validateWebhookAPIKey(r, apiKey); err != nil {
			api.Error(w, http.StatusUnauthorized, err.Error())
			return
		}

		stream, err := q.GetStreamByToken(r.Context(), token)
		if err != nil {
			api.NotFound(w, "stream not found")
			return
		}

		tenantID := api.TenantID(r.Context())
		if tenantID != 0 && tenantID != stream.TenantID {
			// A tenant-scoped caller must only subscribe to its own stream.
			// When no tenant header is present (publisher without tenant context),
			// the stream itself supplies the tenant via its row.
			api.Error(w, http.StatusForbidden, "stream belongs to a different tenant")
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			slog.Warn("websocket upgrade failed", "token", token, "error", err)
			return
		}

		client := &wsClient{conn: conn, send: make(chan []byte, 256)}
		joinHub(token, stream.ID, client)

		// Start the writer goroutine first so the reader can broadcast safely.
		go client.writePump()
		// The socket outlives the router's 60s request timeout, which
		// cancels r.Context(); detach from it so writes keep working, and
		// bound each message's writes in readPump instead.
		client.readPump(context.WithoutCancel(r.Context()), q, pool, stream)
	}
}

func (c *wsClient) readPump(ctx context.Context, q *db.Queries, pool *pgxpool.Pool, stream db.Stream) {
	defer func() {
		c.hub.unregister(c)
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(wsMaxMessageBytes)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				slog.Warn("websocket read error", "stream_id", stream.ID, "error", err)
			}
			return
		}

		// Parse the message once; if it is valid, persist it and broadcast it.
		events, ok := parseStreamMessage(msg)
		if !ok {
			continue
		}

		msgCtx, cancel := context.WithTimeout(ctx, wsIngestTimeout)
		err = ingestEvents(msgCtx, q, pool, stream, events)
		cancel()
		if err != nil {
			slog.Warn("stream ingest failed", "stream_id", stream.ID, "error", err)
			continue
		}

		c.hub.broadcast(c, msg)
	}
}

func (c *wsClient) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			_ = c.conn.WriteMessage(websocket.TextMessage, msg)

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// streamMessage is the JSON envelope any publisher may send. The backend
// accepts either a single event object or a `{ type: "batch", events: [...] }`
// batch envelope. Unknown fields are ignored.
type streamMessage struct {
	Type   string            `json:"type"`
	Events []json.RawMessage `json:"events"`
}

func parseStreamMessage(msg []byte) ([]json.RawMessage, bool) {
	var single json.RawMessage
	if err := json.Unmarshal(msg, &single); err != nil {
		return nil, false
	}

	var batch streamMessage
	if err := json.Unmarshal(single, &batch); err != nil {
		return nil, false
	}
	if batch.Type == "batch" {
		return batch.Events, true
	}
	return []json.RawMessage{single}, true
}

// ingestEvents — Slice 6c2 generic writer.
//
// Every WS-transport stream (regardless of `EntityType`) now writes
// events into the same two tables the HTTP `/ingest` endpoint does:
//   - `entity_states` — upserted latest state per (streamId, entityKey)
//   - `entity_events` — append-only per-entity log for heatmap / track
//
// The per-entity ingest functions (ingestAssetEvents,
// ingestSensorEvents, …) that used to fan out to per-entity tables
// were removed alongside those tables in Slice 6c2. The publisher's
// event JSON is preserved verbatim in `payload`; downstream renderers
// use DataLinkConfig.fieldMapping to interpret it.
//
// `entityKey` is pulled from the same set of common ID fields the
// frontend live-stream client accepts:
//
//	entityKey ?? assetId ?? sensorId ?? tagId ?? shipmentId ?? cameraId ?? id
//
// `pool` is kept on the signature (was used by shipment route→line-
// string translation before). It's now unused; a follow-up can drop
// the parameter across the call chain.
func ingestEvents(ctx context.Context, q *db.Queries, pool *pgxpool.Pool, stream db.Stream, events []json.RawMessage) error {
	if len(events) == 0 {
		return nil
	}
	_ = pool // reserved for future PostGIS-heavy work; unused after Slice 6c2.
	tenantID := stream.TenantID
	streamID := stream.ID
	now := time.Now().UTC()
	for _, raw := range events {
		var rec map[string]any
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		entityKey := pickWSString(rec, "entityKey", "assetId", "sensorId", "tagId", "shipmentId", "cameraId", "id")
		if entityKey == "" {
			continue
		}
		ts, err := parseEventTime(rec["ts"], now)
		if err != nil {
			slog.Warn("ws ingest: event dropped", "stream_id", streamID, "entity_key", entityKey, "error", err)
			continue
		}
		positionWKT := ""
		if lng, latOk := numField(rec, "lng"); latOk {
			if lat, ok := numField(rec, "lat"); ok {
				positionWKT = fmt.Sprintf("POINT(%f %f)", lng, lat)
				_ = lat
			}
		}
		// Preserve the publisher payload as-is.
		payloadBytes, err := json.Marshal(rec)
		if err != nil {
			continue
		}
		if _, err := writeEntityEvent(ctx, q, tenantID, streamID, entityKey, payloadBytes, positionWKT, ts); err != nil {
			slog.Warn("ws ingest: upsert entity_state failed", "stream_id", streamID, "entity_key", entityKey, "error", err)
		}
	}
	// Broadcast a tenant-wide invalidation so viewers refetch
	// `/entity-states` immediately instead of waiting for the poll tick.
	BroadcastEntityEvent("update", "entity-states", streamID, tenantID)
	return nil
}

// pickWSString returns the first non-empty string field found on `rec`
// for the given key list. Mirrors the frontend live-stream client's
// entity_key resolution so old publishers keep working.
func pickWSString(rec map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := rec[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// numField pulls a number field off a decoded map. Returns (value, true)
// when the field is a JSON number, (0, false) otherwise.
func numField(rec map[string]any, key string) (float64, bool) {
	if v, ok := rec[key].(float64); ok {
		return v, true
	}
	return 0, false
}
