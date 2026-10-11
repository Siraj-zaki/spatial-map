package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------------- Connections ----------------

type ConnectionRequest struct {
	Name      string          `json:"name" validate:"required"`
	Transport string          `json:"transport" validate:"required"`
	Auth      json.RawMessage `json:"auth"`
	Config    json.RawMessage `json:"config"`
}

type ConnectionResponse struct {
	ID        int64           `json:"id"`
	TenantID  int64           `json:"tenantId"`
	Name      string          `json:"name"`
	Transport string          `json:"transport"`
	Auth      json.RawMessage `json:"auth,omitempty"`
	Config    json.RawMessage `json:"config,omitempty"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

func toConnectionResponse(row db.Connection) ConnectionResponse {
	return ConnectionResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		Name:      row.Name,
		Transport: row.Transport,
		Auth:      row.Auth,
		Config:    row.Config,
		CreatedAt: api.FormatTime(row.CreatedAt),
		UpdatedAt: api.FormatTime(row.UpdatedAt),
	}
}

func connectionParams(req ConnectionRequest, tenantID int64) db.CreateConnectionParams {
	return db.CreateConnectionParams{
		TenantID:  tenantID,
		Name:      req.Name,
		Transport: req.Transport,
		Auth:      defaultJSONObject(req.Auth),
		Config:    defaultJSONObject(req.Config),
	}
}

func ConnectionsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("connections", q, func(ctx context.Context, tenantID int64) ([]db.Connection, error) {
		return q.ListConnections(ctx, tenantID)
	}, func(row db.Connection) any { return toConnectionResponse(row) }))
	r.Post("/", shapeCreate("connection", q, func(ctx context.Context, p db.CreateConnectionParams) (db.Connection, error) {
		return q.CreateConnection(ctx, p)
	}, connectionParams, func(row db.Connection) any { return toConnectionResponse(row) }))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("connection", q, func(ctx context.Context, id, tenantID int64) (db.Connection, error) {
			return q.GetConnection(ctx, db.GetConnectionParams{ID: id, TenantID: tenantID})
		}, func(row db.Connection) any { return toConnectionResponse(row) }))
		r.Patch("/", shapeUpdate("connection", q, func(ctx context.Context, p db.UpdateConnectionParams) (db.Connection, error) {
			return q.UpdateConnection(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.Connection, error) {
			return q.GetConnection(ctx, db.GetConnectionParams{ID: id, TenantID: tenantID})
		}, connectionParams, func(row db.Connection) any { return toConnectionResponse(row) }, func(id, tenantID int64, p db.CreateConnectionParams) db.UpdateConnectionParams {
			return db.UpdateConnectionParams{ID: id, TenantID: tenantID, Name: p.Name, Transport: p.Transport, Auth: p.Auth, Config: p.Config}
		}))
		r.Delete("/", shapeDelete("connection", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteConnection(ctx, db.DeleteConnectionParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}

// ---------------- Data Sources ----------------

type DataSourceRequest struct {
	Name string `json:"name" validate:"required"`
	Kind string `json:"kind" validate:"required"`
	// v3 addition — what kind of DATA this connection produces
	// (polygon / circle / marker / asset / camera / sensor / shipment /
	// rfid-tag / rack-cell / streaming). Steers per-kind validation +
	// default match strategy in the layer editor. See
	// DESIGN-integrations-v3.md §3.1.
	EntityKind      string          `json:"entityKind"`
	ZoneID          *int64          `json:"zoneId"`
	Config          json.RawMessage `json:"config"`
	Mapping         json.RawMessage `json:"mapping"`
	Schedule        string          `json:"schedule"`
	IntervalSeconds *int32          `json:"intervalSeconds"`
}

type DataSourceResponse struct {
	ID              int64           `json:"id"`
	TenantID        int64           `json:"tenantId"`
	Name            string          `json:"name"`
	Kind            string          `json:"kind"`
	EntityKind      string          `json:"entityKind"`
	ZoneID          *int64          `json:"zoneId,omitempty"`
	Config          json.RawMessage `json:"config,omitempty"`
	Mapping         json.RawMessage `json:"mapping,omitempty"`
	Schedule        string          `json:"schedule,omitempty"`
	IntervalSeconds *int32          `json:"intervalSeconds,omitempty"`
	LastRunAt       string          `json:"lastRunAt,omitempty"`
	LastResult      string          `json:"lastResult,omitempty"`
	CreatedAt       string          `json:"createdAt"`
	UpdatedAt       string          `json:"updatedAt"`
}

func toDataSourceResponse(row db.DataSource) DataSourceResponse {
	resp := DataSourceResponse{
		ID:         row.ID,
		TenantID:   row.TenantID,
		Name:       row.Name,
		Kind:       string(row.Kind),
		EntityKind: string(row.EntityKind),
		Config:     row.Config,
		Mapping:    row.Mapping,
		Schedule:   row.Schedule.String,
		LastResult: row.LastResult.String,
		CreatedAt:  api.FormatTime(row.CreatedAt),
		UpdatedAt:  api.FormatTime(row.UpdatedAt),
	}
	setInt64Ptr(&resp.ZoneID, row.ZoneID)
	setInt32Ptr(&resp.IntervalSeconds, row.IntervalSeconds)
	if row.LastRunAt.Valid {
		resp.LastRunAt = api.FormatTime(row.LastRunAt)
	}
	return resp
}

// Defaults to 'marker' when the caller omits entityKind — same fallback
// as the migration used on legacy rows. See DESIGN-integrations-v3.md §3.1.
func coerceEntityKind(raw string) db.DataSourceEntityKind {
	switch raw {
	case "polygon", "circle", "marker", "asset", "camera", "sensor",
		"shipment", "rfid-tag", "rack-cell", "streaming":
		return db.DataSourceEntityKind(raw)
	default:
		return db.DataSourceEntityKindMarker
	}
}

func dataSourceParams(req DataSourceRequest, tenantID int64) db.CreateDataSourceParams {
	p := db.CreateDataSourceParams{
		TenantID:   tenantID,
		Name:       req.Name,
		Kind:       db.DataSourceKind(req.Kind),
		EntityKind: coerceEntityKind(req.EntityKind),
		Config:     defaultJSONObject(req.Config),
		Mapping:    defaultJSONObject(req.Mapping),
		Schedule:   pgtype.Text{String: req.Schedule, Valid: req.Schedule != ""},
	}
	if req.ZoneID != nil {
		p.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	if req.IntervalSeconds != nil {
		p.IntervalSeconds = pgtype.Int4{Int32: *req.IntervalSeconds, Valid: true}
	}
	return p
}

func DataSourcesRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("data_sources", q, func(ctx context.Context, tenantID int64) ([]db.DataSource, error) {
		return q.ListDataSources(ctx, tenantID)
	}, func(row db.DataSource) any { return toDataSourceResponse(row) }))
	r.Post("/", shapeCreate("data_source", q, func(ctx context.Context, p db.CreateDataSourceParams) (db.DataSource, error) {
		return q.CreateDataSource(ctx, p)
	}, dataSourceParams, func(row db.DataSource) any { return toDataSourceResponse(row) }))
	r.Post("/with-mirror", func(w http.ResponseWriter, r *http.Request) {
		createDataSourceMirror(w, r, q, pool)
	})
	r.Post("/test-rest", func(w http.ResponseWriter, r *http.Request) {
		testRestSource(w, r)
	})
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("data_source", q, func(ctx context.Context, id, tenantID int64) (db.DataSource, error) {
			return q.GetDataSource(ctx, db.GetDataSourceParams{ID: id, TenantID: tenantID})
		}, func(row db.DataSource) any { return toDataSourceResponse(row) }))
		r.Post("/reimport", func(w http.ResponseWriter, r *http.Request) {
			reimportFileSource(w, r, q, pool)
		})
		r.Patch("/", shapeUpdate("data_source", q, func(ctx context.Context, p db.UpdateDataSourceParams) (db.DataSource, error) {
			return q.UpdateDataSource(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.DataSource, error) {
			return q.GetDataSource(ctx, db.GetDataSourceParams{ID: id, TenantID: tenantID})
		}, dataSourceParams, func(row db.DataSource) any { return toDataSourceResponse(row) }, func(id, tenantID int64, p db.CreateDataSourceParams) db.UpdateDataSourceParams {
			return db.UpdateDataSourceParams{
				ID:              id,
				TenantID:        tenantID,
				Name:            p.Name,
				Kind:            p.Kind,
				EntityKind:      p.EntityKind,
				ZoneID:          p.ZoneID,
				Config:          p.Config,
				Mapping:         p.Mapping,
				Schedule:        p.Schedule,
				IntervalSeconds: p.IntervalSeconds,
			}
		}))
		r.Patch("/with-mirror", func(w http.ResponseWriter, r *http.Request) {
			updateDataSourceMirror(w, r, q, pool)
		})
		r.Delete("/", shapeDelete("data_source", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteDataSource(ctx, db.DeleteDataSourceParams{ID: id, TenantID: tenantID})
		}))
		r.Delete("/with-mirror", func(w http.ResponseWriter, r *http.Request) {
			deleteDataSourceMirror(w, r, q, pool)
		})
		// v3 — reusable data pool. See DESIGN-integrations-v3.md §3.2.
		r.Get("/rows", listDataSourceRowsHandler(q))
		r.Get("/rows/{entityKey}", getDataSourceRowHandler(q))
		r.Delete("/rows", deleteDataSourceRowsHandler(q))
		// v4 — schema introspection + advanced filter query. See
		// data_source_query.go for the DSL + JSONB translation.
		r.Get("/schema", dataSourceSchemaHandler(q, pool))
		r.Post("/query", dataSourceQueryHandler(q, pool))
	})
	return r
}

// ---------------- Data Source Mirrors ----------------

type DataSourceMirrorRequest struct {
	Name            string          `json:"name" validate:"required"`
	Kind            string          `json:"kind" validate:"required"`
	EntityKind      string          `json:"entityKind"`
	ZoneID          *int64          `json:"zoneId"`
	Config          json.RawMessage `json:"config"`
	Mapping         json.RawMessage `json:"mapping"`
	Schedule        string          `json:"schedule"`
	IntervalSeconds *int32          `json:"intervalSeconds"`
	LastRunAt       string          `json:"lastRunAt"`
	LastResult      string          `json:"lastResult"`
}

type DataSourceMirrorResponse struct {
	DataSource DataSourceResponse `json:"dataSource"`
	Connection ConnectionResponse `json:"connection"`
	Stream     StreamResponse     `json:"stream"`
}

func createDataSourceMirror(w http.ResponseWriter, r *http.Request, q *db.Queries, pool *pgxpool.Pool) {
	var req DataSourceMirrorRequest
	if err := api.DecodeBody(r, &req); err != nil {
		api.BadRequest(w, "invalid request body")
		return
	}
	if err := api.ValidateStruct(req); err != nil {
		api.BadRequest(w, err.Error())
		return
	}

	tenantID := api.TenantID(r.Context())
	if tenantID == 0 {
		api.Error(w, http.StatusBadRequest, "missing tenant")
		return
	}

	tx, err := pool.Begin(r.Context())
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())

	qtx := q.WithTx(tx)

	dsParams := dataSourceParams(DataSourceRequest{
		Name:            req.Name,
		Kind:            req.Kind,
		ZoneID:          req.ZoneID,
		Config:          req.Config,
		Mapping:         req.Mapping,
		Schedule:        req.Schedule,
		IntervalSeconds: req.IntervalSeconds,
	}, tenantID)

	ds, err := qtx.CreateDataSource(r.Context(), dsParams)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}

	if req.LastRunAt != "" || req.LastResult != "" {
		ds, err = stampDataSourceRun(qtx, r.Context(), ds, req.LastRunAt, req.LastResult)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
	}

	connParams, err := mirrorConnectionParams(ds)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	conn, err := qtx.CreateConnection(r.Context(), connParams)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}

	streamParams, err := mirrorStreamParams(ds, conn.ID)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	stream, err := qtx.CreateStream(r.Context(), streamParams)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		api.InternalError(w, r, err)
		return
	}

	BroadcastEntityEvent("ENTITY_CREATED", "data-sources", ds.ID, tenantID)
	BroadcastEntityEvent("ENTITY_CREATED", "connections", conn.ID, tenantID)
	BroadcastEntityEvent("ENTITY_CREATED", "streams", stream.ID, tenantID)

	api.JSON(w, http.StatusCreated, DataSourceMirrorResponse{
		DataSource: toDataSourceResponse(ds),
		Connection: toConnectionResponse(conn),
		Stream:     toStreamResponse(stream),
	})
}

func updateDataSourceMirror(w http.ResponseWriter, r *http.Request, q *db.Queries, pool *pgxpool.Pool) {
	tenantID := api.TenantID(r.Context())
	id, err := api.IDParam(r, "id")
	if err != nil {
		api.BadRequest(w, err.Error())
		return
	}

	var req DataSourceMirrorRequest
	if err := api.DecodeBody(r, &req); err != nil {
		api.BadRequest(w, "invalid request body")
		return
	}
	if err := api.ValidateStruct(req); err != nil {
		api.BadRequest(w, err.Error())
		return
	}

	tx, err := pool.Begin(r.Context())
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())

	qtx := q.WithTx(tx)

	if _, err := qtx.GetDataSource(r.Context(), db.GetDataSourceParams{ID: id, TenantID: tenantID}); err != nil {
		if err == pgx.ErrNoRows {
			api.NotFound(w, "data_source not found")
			return
		}
		api.InternalError(w, r, err)
		return
	}

	dsParams := db.UpdateDataSourceWithRunParams{
		ID:         id,
		TenantID:   tenantID,
		Name:       req.Name,
		Kind:       db.DataSourceKind(req.Kind),
		EntityKind: coerceEntityKind(req.EntityKind),
		Config:     defaultJSONObject(req.Config),
		Mapping:    defaultJSONObject(req.Mapping),
		Schedule:   pgtype.Text{String: req.Schedule, Valid: req.Schedule != ""},
	}
	if req.ZoneID != nil {
		dsParams.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	if req.IntervalSeconds != nil {
		dsParams.IntervalSeconds = pgtype.Int4{Int32: *req.IntervalSeconds, Valid: true}
	}
	if req.LastRunAt != "" {
		if t, err := time.Parse(time.RFC3339, req.LastRunAt); err == nil {
			dsParams.LastRunAt = pgtype.Timestamptz{Time: t, Valid: true}
		}
	}
	if req.LastResult != "" {
		dsParams.LastResult = pgtype.Text{String: req.LastResult, Valid: true}
	}

	ds, err := qtx.UpdateDataSourceWithRun(r.Context(), dsParams)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}

	streams, err := qtx.ListStreams(r.Context(), tenantID)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	var mirrorStream *db.Stream
	for i := range streams {
		if streams[i].DataSourceID.Valid && streams[i].DataSourceID.Int64 == id {
			mirrorStream = &streams[i]
			break
		}
	}

	if mirrorStream == nil {
		connParams, err := mirrorConnectionParams(ds)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		conn, err := qtx.CreateConnection(r.Context(), connParams)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		streamParams, err := mirrorStreamParams(ds, conn.ID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		stream, err := qtx.CreateStream(r.Context(), streamParams)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", ds.ID, tenantID)
		BroadcastEntityEvent("ENTITY_CREATED", "connections", conn.ID, tenantID)
		BroadcastEntityEvent("ENTITY_CREATED", "streams", stream.ID, tenantID)
		api.JSON(w, http.StatusOK, DataSourceMirrorResponse{
			DataSource: toDataSourceResponse(ds),
			Connection: toConnectionResponse(conn),
			Stream:     toStreamResponse(stream),
		})
		return
	}

	auth, err := mirrorAuthFromConfig(string(ds.Kind), ds.Config)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	cfg, err := mirrorConnectionConfigFromSource(string(ds.Kind), ds.Config)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}

	conn, err := qtx.UpdateConnection(r.Context(), db.UpdateConnectionParams{
		ID:        mirrorStream.ConnectionID,
		TenantID:  tenantID,
		Name:      req.Name,
		Transport: mirrorTransportFromKind(string(ds.Kind)),
		Auth:      auth,
		Config:    cfg,
	})
	if err != nil {
		api.InternalError(w, r, err)
		return
	}

	binding, err := json.Marshal(map[string]any{
		"kind":    "bin-upsert",
		"mapping": ds.Mapping,
	})
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	endpoint, err := mirrorEndpointFromSource(string(ds.Kind), ds.Config)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}

	streamParams := db.UpdateStreamParams{
		ID:           mirrorStream.ID,
		TenantID:     tenantID,
		ConnectionID: conn.ID,
		DataSourceID: pgtype.Int8{Int64: id, Valid: true},
		Name:         req.Name,
		EntityType:   "bin",
		Kind:         "state",
		Binding:      binding,
		Endpoint:     endpoint,
		Schedule:     pgtype.Text{String: req.Schedule, Valid: req.Schedule != ""},
	}
	if req.ZoneID != nil {
		streamParams.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	if req.IntervalSeconds != nil {
		streamParams.IntervalSeconds = pgtype.Int4{Int32: *req.IntervalSeconds, Valid: true}
	}

	stream, err := qtx.UpdateStream(r.Context(), streamParams)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		api.InternalError(w, r, err)
		return
	}

	BroadcastEntityEvent("ENTITY_UPDATED", "data-sources", ds.ID, tenantID)
	BroadcastEntityEvent("ENTITY_UPDATED", "connections", conn.ID, tenantID)
	BroadcastEntityEvent("ENTITY_UPDATED", "streams", stream.ID, tenantID)

	api.JSON(w, http.StatusOK, DataSourceMirrorResponse{
		DataSource: toDataSourceResponse(ds),
		Connection: toConnectionResponse(conn),
		Stream:     toStreamResponse(stream),
	})
}

// LinkedConfigRef describes a data_link_config that would be affected
// by deleting an integration. Returned in the 409 body so the SPA can
// tell the user exactly which warehouse configs to unlink first.
type LinkedConfigRef struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	ZoneID   int64  `json:"zoneId"`
	ZoneName string `json:"zoneName"`
}

// DeleteBlockedResponse is the 409 body when an integration cannot be
// deleted because it's still wired to one or more data-link configs.
type DeleteBlockedResponse struct {
	Error         string            `json:"error"`
	Reason        string            `json:"reason"`
	LinkedConfigs []LinkedConfigRef `json:"linkedConfigs"`
}

// deleteDataSourceMirror hard-deletes an integration (data_source +
// mirror stream + mirror connection) along with everything downstream
// (source_files, data_source_rows, entity_states/events, dlc-by-source,
// dlc-by-stream — all via ON DELETE CASCADE).
//
// Guard: if any data_link_config on a warehouse still references the
// data_source (directly via source_id, or transitively via a stream
// with data_source_id = this source), we refuse with 409 and hand back
// the list of configs so the SPA can tell the user which warehouse to
// unlink from first. There's no `?force=true` override — the user has
// to remove the link explicitly. Rationale: silently cascading the
// dlc rows would erase a map visualization someone deliberately set up.
func deleteDataSourceMirror(w http.ResponseWriter, r *http.Request, q *db.Queries, pool *pgxpool.Pool) {
	tenantID := api.TenantID(r.Context())
	id, err := api.IDParam(r, "id")
	if err != nil {
		api.BadRequest(w, err.Error())
		return
	}

	// 1. Find the mirror stream/connection (may be absent for old data).
	streams, err := q.ListStreamsIncludingArchived(r.Context(), tenantID)
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	var mirrorStream *db.Stream
	for i := range streams {
		if streams[i].DataSourceID.Valid && streams[i].DataSourceID.Int64 == id {
			mirrorStream = &streams[i]
			break
		}
	}

	// 2. Guard: any dlc referencing this source (directly or via stream)?
	refs, err := q.ListDataLinkConfigRefsForSource(r.Context(), db.ListDataLinkConfigRefsForSourceParams{
		TenantID: tenantID,
		SourceID: pgtype.Int8{Int64: id, Valid: true},
	})
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	if len(refs) > 0 {
		linked := make([]LinkedConfigRef, 0, len(refs))
		for _, ref := range refs {
			linked = append(linked, LinkedConfigRef{
				ID:       ref.ID,
				Name:     ref.Name,
				ZoneID:   ref.ZoneID,
				ZoneName: ref.ZoneName,
			})
		}
		api.JSON(w, http.StatusConflict, DeleteBlockedResponse{
			Error:         "integration is linked to one or more data-link configs",
			Reason:        "linked-configs",
			LinkedConfigs: linked,
		})
		return
	}

	// 3. Hard delete inside a transaction. Delete order:
	//    - connection first (cascades streams → states/events/webhooks/dlc-by-stream)
	//    - data_source last (cascades source_files, data_source_rows, dlc-by-source)
	tx, err := pool.Begin(r.Context())
	if err != nil {
		api.InternalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())
	qtx := q.WithTx(tx)

	if mirrorStream != nil {
		if err := qtx.DeleteConnection(r.Context(), db.DeleteConnectionParams{ID: mirrorStream.ConnectionID, TenantID: tenantID}); err != nil {
			api.InternalError(w, r, err)
			return
		}
	}
	if err := qtx.DeleteDataSource(r.Context(), db.DeleteDataSourceParams{ID: id, TenantID: tenantID}); err != nil {
		api.InternalError(w, r, err)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		api.InternalError(w, r, err)
		return
	}

	BroadcastEntityEvent("ENTITY_DELETED", "data-sources", id, tenantID)
	if mirrorStream != nil {
		BroadcastEntityEvent("ENTITY_DELETED", "connections", mirrorStream.ConnectionID, tenantID)
		BroadcastEntityEvent("ENTITY_DELETED", "streams", mirrorStream.ID, tenantID)
	}

	api.JSON(w, http.StatusNoContent, nil)
}

func stampDataSourceRun(qtx *db.Queries, ctx context.Context, source db.DataSource, lastRunAt, lastResult string) (db.DataSource, error) {
	p := db.UpdateDataSourceWithRunParams{
		ID:              source.ID,
		TenantID:        source.TenantID,
		Name:            source.Name,
		Kind:            source.Kind,
		EntityKind:      source.EntityKind,
		ZoneID:          source.ZoneID,
		Config:          source.Config,
		Mapping:         source.Mapping,
		Schedule:        source.Schedule,
		IntervalSeconds: source.IntervalSeconds,
	}
	if lastRunAt != "" {
		if t, err := time.Parse(time.RFC3339, lastRunAt); err == nil {
			p.LastRunAt = pgtype.Timestamptz{Time: t, Valid: true}
		}
	}
	if lastResult != "" {
		p.LastResult = pgtype.Text{String: lastResult, Valid: true}
	}
	return qtx.UpdateDataSourceWithRun(ctx, p)
}

func mirrorTransportFromKind(kind string) string {
	if kind == "rest" {
		return "rest"
	}
	if kind == "webhook" {
		return "webhook"
	}
	return "file"
}

func mirrorConnectionParams(source db.DataSource) (db.CreateConnectionParams, error) {
	transport := mirrorTransportFromKind(string(source.Kind))
	auth, err := mirrorAuthFromConfig(string(source.Kind), source.Config)
	if err != nil {
		return db.CreateConnectionParams{}, err
	}
	cfg, err := mirrorConnectionConfigFromSource(string(source.Kind), source.Config)
	if err != nil {
		return db.CreateConnectionParams{}, err
	}

	return db.CreateConnectionParams{
		TenantID:  source.TenantID,
		Name:      source.Name,
		Transport: transport,
		Auth:      auth,
		Config:    cfg,
	}, nil
}

func mirrorAuthFromConfig(kind string, config json.RawMessage) (json.RawMessage, error) {
	cfg := map[string]any{}
	if len(config) > 0 {
		if err := json.Unmarshal(config, &cfg); err != nil {
			return nil, err
		}
	}

	switch kind {
	case "rest":
		mode := "custom"
		if m, ok := cfg["authMode"].(string); ok && m != "" {
			mode = m
		}
		switch mode {
		case "none":
			return json.Marshal(map[string]any{"mode": "none"})
		case "apiKey":
			value := ""
			if v, ok := cfg["apiKey"].(string); ok {
				value = v
			}
			return json.Marshal(map[string]any{"mode": "apiKey", "value": value})
		case "bearer":
			token := ""
			if t, ok := cfg["bearerToken"].(string); ok {
				token = t
			}
			return json.Marshal(map[string]any{"mode": "bearer", "token": token})
		default:
			headers := map[string]string{}
			if h, ok := cfg["headers"].(map[string]any); ok {
				for k, v := range h {
					if s, ok := v.(string); ok {
						headers[k] = s
					}
				}
			}
			return json.Marshal(map[string]any{"mode": "custom", "headers": headers})
		}
	case "webhook":
		secret := ""
		if s, ok := cfg["hmacSecret"].(string); ok {
			secret = s
		}
		return json.Marshal(map[string]any{"mode": "hmac", "secret": secret})
	default:
		return json.Marshal(map[string]any{"mode": "none"})
	}
}

func mirrorConnectionConfigFromSource(kind string, config json.RawMessage) (json.RawMessage, error) {
	cfg := map[string]any{}
	if len(config) > 0 {
		if err := json.Unmarshal(config, &cfg); err != nil {
			return nil, err
		}
	}

	switch kind {
	case "webhook":
		return json.Marshal(map[string]any{
			"transport":     "webhook",
			"workerBaseUrl": stringFromAnyMap(cfg, "workerBaseUrl"),
			"drainApiKey":   stringFromAnyMap(cfg, "drainApiKey"),
		})
	case "rest":
		return json.Marshal(map[string]any{"transport": "rest"})
	default:
		return json.Marshal(map[string]any{"transport": "file"})
	}
}

func mirrorEndpointFromSource(kind string, config json.RawMessage) (json.RawMessage, error) {
	cfg := map[string]any{}
	if len(config) > 0 {
		if err := json.Unmarshal(config, &cfg); err != nil {
			return nil, err
		}
	}

	switch kind {
	case "rest":
		endpoint := map[string]any{
			"transport": "rest",
			"url":       stringFromAnyMap(cfg, "url"),
		}
		if method, ok := cfg["method"].(string); ok && method != "" {
			endpoint["method"] = method
		}
		if body, ok := cfg["body"].(string); ok && body != "" {
			endpoint["body"] = body
		}
		if rootPath, ok := cfg["rootPath"].(string); ok && rootPath != "" {
			endpoint["rootPath"] = rootPath
		}
		if responseFormat, ok := cfg["responseFormat"].(string); ok && responseFormat != "" {
			endpoint["responseFormat"] = responseFormat
		}
		return json.Marshal(endpoint)
	case "webhook":
		workerBaseUrl := stringFromAnyMap(cfg, "workerBaseUrl")
		if workerBaseUrl == "" {
			workerBaseUrl = "http://localhost:8080"
		}
		workerBaseUrl = strings.TrimRight(workerBaseUrl, "/")
		sourceToken := stringFromAnyMap(cfg, "sourceToken")
		endpoint := map[string]any{
			"transport":   "webhook",
			"sourceToken": sourceToken,
			"hmacSecret":  stringFromAnyMap(cfg, "hmacSecret"),
			"url":         fmt.Sprintf("%s/api/v1/webhooks/%s", workerBaseUrl, sourceToken),
		}
		// Explicit opt-out for senders that cannot sign; absent = required.
		if req, ok := cfg["requireSignature"].(bool); ok {
			endpoint["requireSignature"] = req
		}
		if poll, ok := cfg["pollIntervalSec"].(float64); ok {
			endpoint["pollIntervalSec"] = int(poll)
		}
		if last, ok := cfg["lastEventAt"].(string); ok && last != "" {
			endpoint["lastEventAt"] = last
		}
		return json.Marshal(endpoint)
	default:
		fileCfg := map[string]any{"transport": "file"}
		for k, v := range cfg {
			if k == "transport" {
				continue
			}
			fileCfg[k] = v
		}
		return json.Marshal(fileCfg)
	}
}

func mirrorStreamParams(source db.DataSource, connectionID int64) (db.CreateStreamParams, error) {
	endpoint, err := mirrorEndpointFromSource(string(source.Kind), source.Config)
	if err != nil {
		return db.CreateStreamParams{}, err
	}
	binding, err := json.Marshal(map[string]any{
		"kind":    "bin-upsert",
		"mapping": source.Mapping,
	})
	if err != nil {
		return db.CreateStreamParams{}, err
	}

	return db.CreateStreamParams{
		TenantID:        source.TenantID,
		ConnectionID:    connectionID,
		DataSourceID:    pgtype.Int8{Int64: source.ID, Valid: true},
		Name:            source.Name,
		EntityType:      "bin",
		Kind:            "state",
		Binding:         binding,
		Endpoint:        endpoint,
		ZoneID:          source.ZoneID,
		Schedule:        source.Schedule,
		IntervalSeconds: source.IntervalSeconds,
	}, nil
}

func stringFromAnyMap(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// ---------------- Streams ----------------

type StreamRequest struct {
	ConnectionID    int64           `json:"connectionId" validate:"required"`
	DataSourceID    *int64          `json:"dataSourceId"`
	Name            string          `json:"name" validate:"required"`
	EntityType      string          `json:"entityType" validate:"required"`
	Kind            string          `json:"kind" validate:"required"`
	Binding         json.RawMessage `json:"binding"`
	Endpoint        json.RawMessage `json:"endpoint"`
	ZoneID          *int64          `json:"zoneId"`
	Schedule        string          `json:"schedule"`
	IntervalSeconds *int32          `json:"intervalSeconds"`
}

type StreamResponse struct {
	ID              int64           `json:"id"`
	TenantID        int64           `json:"tenantId"`
	ConnectionID    int64           `json:"connectionId"`
	DataSourceID    *int64          `json:"dataSourceId,omitempty"`
	Name            string          `json:"name"`
	EntityType      string          `json:"entityType"`
	Kind            string          `json:"kind"`
	Binding         json.RawMessage `json:"binding,omitempty"`
	Endpoint        json.RawMessage `json:"endpoint,omitempty"`
	ZoneID          *int64          `json:"zoneId,omitempty"`
	Schedule        string          `json:"schedule,omitempty"`
	IntervalSeconds *int32          `json:"intervalSeconds,omitempty"`
	LastRunAt       string          `json:"lastRunAt,omitempty"`
	LastResult      string          `json:"lastResult,omitempty"`
	CreatedAt       string          `json:"createdAt"`
	UpdatedAt       string          `json:"updatedAt"`
}

func toStreamResponse(row db.Stream) StreamResponse {
	resp := StreamResponse{
		ID:           row.ID,
		TenantID:     row.TenantID,
		ConnectionID: row.ConnectionID,
		Name:         row.Name,
		EntityType:   row.EntityType,
		Kind:         row.Kind,
		Binding:      row.Binding,
		Endpoint:     row.Endpoint,
		Schedule:     row.Schedule.String,
		LastResult:   row.LastResult.String,
		CreatedAt:    api.FormatTime(row.CreatedAt),
		UpdatedAt:    api.FormatTime(row.UpdatedAt),
	}
	setInt64Ptr(&resp.DataSourceID, row.DataSourceID)
	setInt64Ptr(&resp.ZoneID, row.ZoneID)
	setInt32Ptr(&resp.IntervalSeconds, row.IntervalSeconds)
	if row.LastRunAt.Valid {
		resp.LastRunAt = api.FormatTime(row.LastRunAt)
	}
	return resp
}

func streamParams(req StreamRequest, tenantID int64) db.CreateStreamParams {
	p := db.CreateStreamParams{
		TenantID:     tenantID,
		ConnectionID: req.ConnectionID,
		Name:         req.Name,
		EntityType:   req.EntityType,
		Kind:         req.Kind,
		Binding:      defaultJSONObject(req.Binding),
		Endpoint:     defaultJSONObject(req.Endpoint),
		Schedule:     pgtype.Text{String: req.Schedule, Valid: req.Schedule != ""},
	}
	if req.DataSourceID != nil {
		p.DataSourceID = pgtype.Int8{Int64: *req.DataSourceID, Valid: true}
	}
	if req.ZoneID != nil {
		p.ZoneID = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
	}
	if req.IntervalSeconds != nil {
		p.IntervalSeconds = pgtype.Int4{Int32: *req.IntervalSeconds, Valid: true}
	}
	return p
}

func StreamsRouter(q *db.Queries) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("streams", q, func(ctx context.Context, tenantID int64) ([]db.Stream, error) { return q.ListStreams(ctx, tenantID) }, func(row db.Stream) any { return toStreamResponse(row) }))
	r.Post("/", shapeCreate("stream", q, func(ctx context.Context, p db.CreateStreamParams) (db.Stream, error) { return q.CreateStream(ctx, p) }, streamParams, func(row db.Stream) any { return toStreamResponse(row) }))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("stream", q, func(ctx context.Context, id, tenantID int64) (db.Stream, error) {
			return q.GetStream(ctx, db.GetStreamParams{ID: id, TenantID: tenantID})
		}, func(row db.Stream) any { return toStreamResponse(row) }))
		r.Patch("/", shapeUpdate("stream", q, func(ctx context.Context, p db.UpdateStreamParams) (db.Stream, error) { return q.UpdateStream(ctx, p) }, func(ctx context.Context, id, tenantID int64) (db.Stream, error) {
			return q.GetStream(ctx, db.GetStreamParams{ID: id, TenantID: tenantID})
		}, streamParams, func(row db.Stream) any { return toStreamResponse(row) }, func(id, tenantID int64, p db.CreateStreamParams) db.UpdateStreamParams {
			return db.UpdateStreamParams{
				ID:              id,
				TenantID:        tenantID,
				ConnectionID:    p.ConnectionID,
				DataSourceID:    p.DataSourceID,
				Name:            p.Name,
				EntityType:      p.EntityType,
				Kind:            p.Kind,
				Binding:         p.Binding,
				Endpoint:        p.Endpoint,
				ZoneID:          p.ZoneID,
				Schedule:        p.Schedule,
				IntervalSeconds: p.IntervalSeconds,
			}
		}))
		r.Delete("/", shapeDelete("stream", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteStream(ctx, db.DeleteStreamParams{ID: id, TenantID: tenantID})
		}))
		mountStreamEntityRoutes(r, q)
	})
	return r
}

// ---------------- Import Jobs ----------------

type ImportJobRequest struct {
	SourceID    int64           `json:"sourceId" validate:"required"`
	StartedAt   string          `json:"startedAt" validate:"required"`
	FinishedAt  string          `json:"finishedAt"`
	Status      string          `json:"status" validate:"required"`
	Stats       json.RawMessage `json:"stats"`
	ErrorReport string          `json:"errorReport"`
}

type ImportJobResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	SourceID    int64           `json:"sourceId"`
	StartedAt   string          `json:"startedAt"`
	FinishedAt  string          `json:"finishedAt,omitempty"`
	Status      string          `json:"status"`
	Stats       json.RawMessage `json:"stats,omitempty"`
	ErrorReport string          `json:"errorReport,omitempty"`
	CreatedAt   string          `json:"createdAt"`
}

func toImportJobResponse(row db.ImportJob) ImportJobResponse {
	resp := ImportJobResponse{
		ID:        row.ID,
		TenantID:  row.TenantID,
		SourceID:  row.SourceID,
		Status:    string(row.Status),
		Stats:     row.Stats,
		CreatedAt: api.FormatTime(row.CreatedAt),
	}
	if row.StartedAt.Valid {
		resp.StartedAt = api.FormatTime(row.StartedAt)
	}
	if row.FinishedAt.Valid {
		resp.FinishedAt = api.FormatTime(row.FinishedAt)
	}
	if row.ErrorReport.Valid {
		resp.ErrorReport = row.ErrorReport.String
	}
	return resp
}

func ImportJobsRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", shapeList("import_jobs", q, func(ctx context.Context, tenantID int64) ([]db.ImportJob, error) {
		return q.ListImportJobs(ctx, tenantID)
	}, func(row db.ImportJob) any { return toImportJobResponse(row) }))
	r.Post("/", shapeCreate("import_job", q, func(ctx context.Context, p db.CreateImportJobParams) (db.ImportJob, error) {
		return q.CreateImportJob(ctx, p)
	}, importJobParams, func(row db.ImportJob) any { return toImportJobResponse(row) }))
	r.Post("/preview", previewImport(q))
	r.Post("/commit", commitImport(q, pool))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", shapeGet("import_job", q, func(ctx context.Context, id, tenantID int64) (db.ImportJob, error) {
			return q.GetImportJob(ctx, db.GetImportJobParams{ID: id, TenantID: tenantID})
		}, func(row db.ImportJob) any { return toImportJobResponse(row) }))
		r.Patch("/", shapeUpdate("import_job", q, func(ctx context.Context, p db.UpdateImportJobParams) (db.ImportJob, error) {
			return q.UpdateImportJob(ctx, p)
		}, func(ctx context.Context, id, tenantID int64) (db.ImportJob, error) {
			return q.GetImportJob(ctx, db.GetImportJobParams{ID: id, TenantID: tenantID})
		}, importJobParams, func(row db.ImportJob) any { return toImportJobResponse(row) }, func(id, tenantID int64, p db.CreateImportJobParams) db.UpdateImportJobParams {
			return db.UpdateImportJobParams{
				ID:          id,
				TenantID:    tenantID,
				SourceID:    p.SourceID,
				StartedAt:   p.StartedAt,
				FinishedAt:  p.FinishedAt,
				Status:      p.Status,
				Stats:       p.Stats,
				ErrorReport: p.ErrorReport,
			}
		}))
		r.Delete("/", shapeDelete("import_job", q, func(ctx context.Context, id, tenantID int64) error {
			return q.DeleteImportJob(ctx, db.DeleteImportJobParams{ID: id, TenantID: tenantID})
		}))
	})
	return r
}

func importJobParams(req ImportJobRequest, tenantID int64) db.CreateImportJobParams {
	p := db.CreateImportJobParams{
		TenantID:    tenantID,
		SourceID:    req.SourceID,
		Status:      db.ImportJobStatus(req.Status),
		Stats:       defaultJSONObject(req.Stats),
		ErrorReport: pgtype.Text{String: req.ErrorReport, Valid: req.ErrorReport != ""},
	}
	if req.StartedAt != "" {
		if t, err := time.Parse(time.RFC3339, req.StartedAt); err == nil {
			p.StartedAt = pgtype.Timestamptz{Time: t, Valid: true}
		}
	}
	if req.FinishedAt != "" {
		if t, err := time.Parse(time.RFC3339, req.FinishedAt); err == nil {
			p.FinishedAt = pgtype.Timestamptz{Time: t, Valid: true}
		}
	}
	return p
}

func setInt32Ptr(dst **int32, src pgtype.Int4) {
	if src.Valid {
		v := src.Int32
		*dst = &v
	}
}
