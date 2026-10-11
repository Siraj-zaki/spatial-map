package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
)

type SSEEvent struct {
	Type     string `json:"type"`
	Entity   string `json:"entity"`
	ID       string `json:"id"`
	TenantID int64  `json:"tenantId"`
}

// sseClient is one open /events stream. Each client sees only its own
// tenant's events — the stream is mounted behind TenantMiddleware, which
// has already checked the caller belongs to that tenant.
type sseClient struct {
	tenantID int64
	ch       chan SSEEvent
}

type SSEBroadcaster struct {
	mu       sync.RWMutex
	clients  map[*sseClient]struct{}
	register chan *sseClient
	remove   chan *sseClient
	events   chan SSEEvent
}

func NewSSEBroadcaster() *SSEBroadcaster {
	return &SSEBroadcaster{
		clients:  make(map[*sseClient]struct{}),
		register: make(chan *sseClient),
		remove:   make(chan *sseClient),
		events:   make(chan SSEEvent, 256),
	}
}

func (b *SSEBroadcaster) Run() {
	for {
		select {
		case c := <-b.register:
			b.mu.Lock()
			b.clients[c] = struct{}{}
			b.mu.Unlock()
		case c := <-b.remove:
			b.mu.Lock()
			delete(b.clients, c)
			b.mu.Unlock()
			close(c.ch)
		case ev := <-b.events:
			b.mu.RLock()
			clients := make([]*sseClient, 0, len(b.clients))
			for c := range b.clients {
				if c.tenantID == ev.TenantID {
					clients = append(clients, c)
				}
			}
			b.mu.RUnlock()
			for _, c := range clients {
				select {
				case c.ch <- ev:
				default:
					// Drop event for slow clients.
				}
			}
		}
	}
}

// defaultBroadcaster is the process-wide SSE broadcaster installed by main.go.
// It lets mutation handlers emit invalidation events without threading the
// broadcaster through every router constructor.
var defaultBroadcaster *SSEBroadcaster

// SetDefaultBroadcaster installs the broadcaster used by BroadcastEntityEvent.
func SetDefaultBroadcaster(b *SSEBroadcaster) {
	defaultBroadcaster = b
}

// BroadcastEntityEvent emits an SSE invalidation event for a catalog mutation.
// It is a no-op when no broadcaster is installed or when the id/tenant are zero.
func BroadcastEntityEvent(evType string, entity string, id int64, tenantID int64) {
	if defaultBroadcaster == nil || id == 0 || tenantID == 0 {
		return
	}
	defaultBroadcaster.Broadcast(SSEEvent{
		Type:     evType,
		Entity:   entity,
		ID:       strconv.FormatInt(id, 10),
		TenantID: tenantID,
	})
}

// BroadcastEntityKindEvent tells listeners to reload an entire entity kind,
// which the SPA does when it sees id 0.
//
// Separate from BroadcastEntityEvent because that function's zero-id guard is
// load-bearing: entityID reads the row's ID by reflection and returns 0 when it
// can't, so a zero there means "we don't know what changed" rather than "reload
// everything". A bulk write does know, and reloading once beats emitting a
// thousand per-row events that every client would answer with a thousand
// invalidations.
func BroadcastEntityKindEvent(evType string, entity string, tenantID int64) {
	if defaultBroadcaster == nil || tenantID == 0 {
		return
	}
	defaultBroadcaster.Broadcast(SSEEvent{
		Type:     evType,
		Entity:   entity,
		ID:       "0",
		TenantID: tenantID,
	})
}

func (b *SSEBroadcaster) Broadcast(ev SSEEvent) {
	select {
	case b.events <- ev:
	default:
		// Drop event if broadcaster is saturated.
	}
}

const (
	// sseHeartbeat keeps proxies (nginx's 60s proxy_read_timeout) from
	// closing a quiet stream.
	sseHeartbeat = 20 * time.Second
	// sseMaxLifetime ends each stream cleanly before the router-wide
	// middleware.Timeout(60s) cancels it mid-write. The SPA reconnects at
	// once, so a stream is really a series of ~50s connections.
	sseMaxLifetime = 50 * time.Second
	// sseWriteWindow is pushed forward before every write so the server's
	// WriteTimeout (30s) does not cut a healthy stream.
	sseWriteWindow = 15 * time.Second
)

func (b *SSEBroadcaster) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	tenantID := api.TenantID(r.Context())
	if tenantID == 0 {
		api.BadRequest(w, "missing tenant")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	rc := http.NewResponseController(w)
	write := func(chunk string) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(sseWriteWindow))
		if _, err := w.Write([]byte(chunk)); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// nginx buffers proxied responses by default, which would hold events
	// back until a buffer fills.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if !write(": connected\n\n") {
		return
	}

	c := &sseClient{tenantID: tenantID, ch: make(chan SSEEvent, 8)}
	b.register <- c
	defer func() { b.remove <- c }()

	heartbeat := time.NewTicker(sseHeartbeat)
	defer heartbeat.Stop()
	lifetime := time.NewTimer(sseMaxLifetime)
	defer lifetime.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-lifetime.C:
			return
		case <-heartbeat.C:
			if !write(": ping\n\n") {
				return
			}
		case ev := <-c.ch:
			data, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			if !write("data: " + string(data) + "\n\n") {
				return
			}
		}
	}
}
