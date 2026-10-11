// Package handlers — entity_states.go
//
// Tenant-wide entity_states router. Mounted at
// `/api/v1/entity-states` and used by the warehouse viewer to fetch
// every live entity across every stream owned by the caller's tenant
// in a single request. Per-stream reads still live under
// `/streams/:id/entities` (see entity_ingest.go); this router exists
// only for the cross-stream aggregate view.
package handlers

import (
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
)

// EntityStatesRouter — tenant-scoped router. Auth + tenant headers
// are enforced by the parent chain in cmd/api/main.go, so no extra
// middleware is applied here.
func EntityStatesRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", handleListAllEntityStates(q))
	return r
}
