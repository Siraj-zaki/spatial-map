// Package handlers — stream_entities.go
//
// Slice 6c2 of the data-link refactor stripped this file down to the
// generic entity_states + entity_events mount points. Per-entity
// handlers (assets / sensors / rfid / shipments / cameras / cv
// detections) and their tenant-wide siblings were removed along with
// their SQL queries, migrations, and Dexie stores; every live-record
// integration now flows through `POST /streams/:id/ingest` and reads
// via `GET /streams/:id/entities`, `GET /streams/:id/events`, or the
// tenant-wide `GET /entity-states`.
//
// `mountStreamEntityRoutes` stays because the /ingest, /entities, and
// /events sub-routes still hang off the per-stream router. Everything
// else that used to live here is gone.

package handlers

import (
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
)

// mountStreamEntityRoutes wires the generic per-stream entity endpoints
// under whatever router the caller passes in (typically the streams
// router at /api/v1/streams/{id}/…). The tenant + API-key middleware is
// applied by the parent chain, so nothing extra is needed here.
func mountStreamEntityRoutes(r chi.Router, q *db.Queries) {
	// Publishers POST batched events to /ingest; the SPA polls /entities
	// to render via the generic MapDataLinkedOverlay.
	r.Post("/ingest", handleEntityIngest(q))
	r.Get("/entities", handleListEntityStates(q))
	// /events serves the append-only event log within a rolling window
	// (default 60s). Consumed by `heatmap` + `track` render modes.
	r.Get("/events", handleListEntityEvents(q))
}
