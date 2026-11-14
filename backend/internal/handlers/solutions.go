package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Solutions (migration 0045) are named groups inside a workspace —
// "Hospital", "Anti-theft" — that collect the facilities, reports and data
// sources (user tables, integrations, files) for one use case. Not a tenant
// layer: every member of the workspace sees them, owners/admins/editors
// change them, and a solution only points at items (an item can be in
// several), so deleting one never deletes data.

// SolutionResponse is one solution with its members' ids.
type SolutionResponse struct {
	ID            int64   `json:"id"`
	Name          string  `json:"name"`
	Description   string  `json:"description"`
	Icon          string  `json:"icon"`
	Color         string  `json:"color"`
	Template      string  `json:"template"`
	Position      int32   `json:"position"`
	ZoneIDs       []int64 `json:"zoneIds"`
	ReportIDs     []int64 `json:"reportIds"`
	DataSourceIDs []int64 `json:"dataSourceIds"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt"`
}

// SolutionRequest creates or (merged over the current row) updates one.
type SolutionRequest struct {
	Name        string `json:"name" validate:"required,max=80"`
	Description string `json:"description" validate:"max=500"`
	Icon        string `json:"icon" validate:"max=64"`
	Color       string `json:"color" validate:"max=32"`
	Template    string `json:"template" validate:"max=32"`
	Position    *int32 `json:"position"`
	// Initial members (create only).
	ZoneIDs       []int64 `json:"zoneIds"`
	ReportIDs     []int64 `json:"reportIds"`
	DataSourceIDs []int64 `json:"dataSourceIds"`
}

// SolutionItemsRequest adds or removes members; ids the tenant doesn't own
// are ignored.
type SolutionItemsRequest struct {
	ZoneIDs       []int64 `json:"zoneIds"`
	ReportIDs     []int64 `json:"reportIds"`
	DataSourceIDs []int64 `json:"dataSourceIds"`
}

func toSolutionResponse(s db.Solution) SolutionResponse {
	return SolutionResponse{
		ID: s.ID, Name: s.Name, Description: s.Description, Icon: s.Icon, Color: s.Color,
		Template: s.Template, Position: s.Position,
		ZoneIDs: []int64{}, ReportIDs: []int64{}, DataSourceIDs: []int64{},
		CreatedAt: api.FormatTime(s.CreatedAt), UpdatedAt: api.FormatTime(s.UpdatedAt),
	}
}

func listSolutions(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		rows, err := q.ListSolutions(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		items, err := q.ListSolutionItemsByTenant(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]SolutionResponse, len(rows))
		index := make(map[int64]int, len(rows))
		for i, s := range rows {
			out[i] = toSolutionResponse(s)
			index[s.ID] = i
		}
		for _, it := range items {
			i, ok := index[it.SolutionID]
			if !ok {
				continue
			}
			switch {
			case it.ZoneID.Valid:
				out[i].ZoneIDs = append(out[i].ZoneIDs, it.ZoneID.Int64)
			case it.ReportID.Valid:
				out[i].ReportIDs = append(out[i].ReportIDs, it.ReportID.Int64)
			case it.DataSourceID.Valid:
				out[i].DataSourceIDs = append(out[i].DataSourceIDs, it.DataSourceID.Int64)
			}
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// loadSolution returns the solution with its members, or writes 404.
func loadSolution(w http.ResponseWriter, r *http.Request, q *db.Queries) (SolutionResponse, bool) {
	tenantID := api.TenantID(r.Context())
	id, err := api.IDParam(r, "id")
	if err != nil {
		api.BadRequest(w, err.Error())
		return SolutionResponse{}, false
	}
	s, err := q.GetSolution(r.Context(), db.GetSolutionParams{ID: id, TenantID: tenantID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			api.NotFound(w, "solution not found")
			return SolutionResponse{}, false
		}
		api.InternalError(w, r, err)
		return SolutionResponse{}, false
	}
	resp := toSolutionResponse(s)
	if err := fillSolutionItems(r, q, &resp); err != nil {
		api.InternalError(w, r, err)
		return SolutionResponse{}, false
	}
	return resp, true
}

func fillSolutionItems(r *http.Request, q *db.Queries, resp *SolutionResponse) error {
	items, err := q.ListSolutionItemsByTenant(r.Context(), api.TenantID(r.Context()))
	if err != nil {
		return err
	}
	for _, it := range items {
		if it.SolutionID != resp.ID {
			continue
		}
		switch {
		case it.ZoneID.Valid:
			resp.ZoneIDs = append(resp.ZoneIDs, it.ZoneID.Int64)
		case it.ReportID.Valid:
			resp.ReportIDs = append(resp.ReportIDs, it.ReportID.Int64)
		case it.DataSourceID.Valid:
			resp.DataSourceIDs = append(resp.DataSourceIDs, it.DataSourceID.Int64)
		}
	}
	return nil
}

func getSolution(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s, ok := loadSolution(w, r, q); ok {
			api.JSON(w, http.StatusOK, s)
		}
	}
}

func addSolutionItems(r *http.Request, qtx *db.Queries, solutionID, tenantID int64, req SolutionItemsRequest) error {
	ctx := r.Context()
	if len(req.ZoneIDs) > 0 {
		if err := qtx.AddSolutionZones(ctx, db.AddSolutionZonesParams{SolutionID: solutionID, TenantID: tenantID, Ids: req.ZoneIDs}); err != nil {
			return err
		}
	}
	if len(req.ReportIDs) > 0 {
		if err := qtx.AddSolutionReports(ctx, db.AddSolutionReportsParams{SolutionID: solutionID, TenantID: tenantID, Ids: req.ReportIDs}); err != nil {
			return err
		}
	}
	if len(req.DataSourceIDs) > 0 {
		if err := qtx.AddSolutionDataSources(ctx, db.AddSolutionDataSourcesParams{SolutionID: solutionID, TenantID: tenantID, Ids: req.DataSourceIDs}); err != nil {
			return err
		}
	}
	return nil
}

func createSolution(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermSolutionsManage) {
			return
		}
		var req SolutionRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		req.Name = strings.TrimSpace(req.Name)
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		tenantID := api.TenantID(r.Context())
		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context()) //nolint:errcheck
		qtx := q.WithTx(tx)
		params := db.CreateSolutionParams{
			TenantID: tenantID, Name: req.Name, Description: strings.TrimSpace(req.Description),
			Icon: req.Icon, Color: req.Color, Template: req.Template,
		}
		if uid := api.UserID(r.Context()); uid != 0 {
			params.CreatedBy = pgtype.Int8{Int64: uid, Valid: true}
		}
		s, err := qtx.CreateSolution(r.Context(), params)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := addSolutionItems(r, qtx, s.ID, tenantID, SolutionItemsRequest{ZoneIDs: req.ZoneIDs, ReportIDs: req.ReportIDs, DataSourceIDs: req.DataSourceIDs}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp := toSolutionResponse(s)
		if err := fillSolutionItems(r, q, &resp); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusCreated, resp)
		BroadcastEntityEvent("ENTITY_CREATED", "solutions", s.ID, tenantID)
	}
}

func updateSolution(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermSolutionsManage) {
			return
		}
		current, ok := loadSolution(w, r, q)
		if !ok {
			return
		}
		// Merge the patch over the current row so a partial body keeps the rest.
		req := SolutionRequest{Name: current.Name, Description: current.Description, Icon: current.Icon, Color: current.Color}
		pos := current.Position
		req.Position = &pos
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		req.Name = strings.TrimSpace(req.Name)
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		tenantID := api.TenantID(r.Context())
		if req.Position == nil {
			req.Position = &pos
		}
		if _, err := q.UpdateSolution(r.Context(), db.UpdateSolutionParams{
			ID: current.ID, TenantID: tenantID, Name: req.Name, Description: strings.TrimSpace(req.Description),
			Icon: req.Icon, Color: req.Color, Position: *req.Position,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp, ok := loadSolution(w, r, q)
		if !ok {
			return
		}
		api.JSON(w, http.StatusOK, resp)
		BroadcastEntityEvent("ENTITY_UPDATED", "solutions", current.ID, tenantID)
	}
}

func deleteSolution(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermSolutionsManage) {
			return
		}
		current, ok := loadSolution(w, r, q)
		if !ok {
			return
		}
		tenantID := api.TenantID(r.Context())
		// Members cascade; the facilities, reports and data stay.
		if err := q.DeleteSolution(r.Context(), db.DeleteSolutionParams{ID: current.ID, TenantID: tenantID}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
		BroadcastEntityEvent("ENTITY_DELETED", "solutions", current.ID, tenantID)
	}
}

// changeSolutionItems adds (POST) or removes (DELETE) members, or replaces
// the whole set (PUT).
func changeSolutionItems(q *db.Queries, pool *pgxpool.Pool, mode string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermSolutionsManage) {
			return
		}
		current, ok := loadSolution(w, r, q)
		if !ok {
			return
		}
		var req SolutionItemsRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		tenantID := api.TenantID(r.Context())
		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context()) //nolint:errcheck
		qtx := q.WithTx(tx)
		ctx := r.Context()
		switch mode {
		case "replace":
			if err = qtx.ClearSolutionItems(ctx, db.ClearSolutionItemsParams{SolutionID: current.ID, TenantID: tenantID}); err == nil {
				err = addSolutionItems(r, qtx, current.ID, tenantID, req)
			}
		case "add":
			err = addSolutionItems(r, qtx, current.ID, tenantID, req)
		case "remove":
			if len(req.ZoneIDs) > 0 && err == nil {
				err = qtx.RemoveSolutionZones(ctx, db.RemoveSolutionZonesParams{SolutionID: current.ID, TenantID: tenantID, Ids: req.ZoneIDs})
			}
			if len(req.ReportIDs) > 0 && err == nil {
				err = qtx.RemoveSolutionReports(ctx, db.RemoveSolutionReportsParams{SolutionID: current.ID, TenantID: tenantID, Ids: req.ReportIDs})
			}
			if len(req.DataSourceIDs) > 0 && err == nil {
				err = qtx.RemoveSolutionDataSources(ctx, db.RemoveSolutionDataSourcesParams{SolutionID: current.ID, TenantID: tenantID, Ids: req.DataSourceIDs})
			}
		}
		if err == nil {
			err = qtx.TouchSolution(ctx, db.TouchSolutionParams{ID: current.ID, TenantID: tenantID})
		}
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp, ok := loadSolution(w, r, q)
		if !ok {
			return
		}
		api.JSON(w, http.StatusOK, resp)
		BroadcastEntityEvent("ENTITY_UPDATED", "solutions", current.ID, tenantID)
	}
}

// SolutionOverviewResponse carries the live-data KPIs the client can't
// derive from the lists it already loads.
type SolutionOverviewResponse struct {
	TotalRows  int64                 `json:"totalRows"`
	Updated24h int64                 `json:"updated24h"`
	LastUpdate string                `json:"lastUpdate,omitempty"`
	RecentRuns []SolutionRunResponse `json:"recentRuns"`
}

type SolutionRunResponse struct {
	ID         int64  `json:"id"`
	SourceID   int64  `json:"sourceId"`
	SourceName string `json:"sourceName"`
	Status     string `json:"status"`
	StartedAt  string `json:"startedAt,omitempty"`
	FinishedAt string `json:"finishedAt,omitempty"`
	CreatedAt  string `json:"createdAt"`
}

func solutionOverview(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, ok := loadSolution(w, r, q)
		if !ok {
			return
		}
		tenantID := api.TenantID(r.Context())
		out := SolutionOverviewResponse{RecentRuns: []SolutionRunResponse{}}
		if len(s.DataSourceIDs) > 0 {
			stats, err := q.SolutionRowStats(r.Context(), db.SolutionRowStatsParams{TenantID: tenantID, SourceIds: s.DataSourceIDs})
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			out.TotalRows, out.Updated24h = stats.TotalRows, stats.Updated24h
			if stats.LastUpdate.Valid {
				out.LastUpdate = api.FormatTime(stats.LastUpdate)
			}
			runs, err := q.SolutionRecentRuns(r.Context(), db.SolutionRecentRunsParams{TenantID: tenantID, SourceIds: s.DataSourceIDs})
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			for _, run := range runs {
				item := SolutionRunResponse{ID: run.ID, SourceID: run.SourceID, SourceName: run.SourceName, Status: run.Status, CreatedAt: api.FormatTime(run.CreatedAt)}
				if run.StartedAt.Valid {
					item.StartedAt = api.FormatTime(run.StartedAt)
				}
				if run.FinishedAt.Valid {
					item.FinishedAt = api.FormatTime(run.FinishedAt)
				}
				out.RecentRuns = append(out.RecentRuns, item)
			}
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// solutionScope resolves an optional `?solution=<id>` on a list endpoint to
// the member ids of one kind. ok=false means a response was written (bad
// or foreign id → 400/404); a nil slice with ok=true means "no filter".
func solutionScope(w http.ResponseWriter, r *http.Request, q *db.Queries, kind string) ([]int64, bool) {
	raw := r.URL.Query().Get("solution")
	if raw == "" {
		return nil, true
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		api.BadRequest(w, "invalid solution")
		return nil, false
	}
	tenantID := api.TenantID(r.Context())
	if _, err := q.GetSolution(r.Context(), db.GetSolutionParams{ID: id, TenantID: tenantID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			api.NotFound(w, "solution not found")
			return nil, false
		}
		api.InternalError(w, r, err)
		return nil, false
	}
	var ids []int64
	switch kind {
	case "zones":
		ids, err = q.SolutionZoneIDs(r.Context(), db.SolutionZoneIDsParams{SolutionID: id, TenantID: tenantID})
	case "data_sources":
		ids, err = q.SolutionDataSourceIDs(r.Context(), db.SolutionDataSourceIDsParams{SolutionID: id, TenantID: tenantID})
	}
	if err != nil {
		api.InternalError(w, r, err)
		return nil, false
	}
	if ids == nil {
		ids = []int64{} // a solution with no members of this kind matches nothing
	}
	return ids, true
}

// SolutionsRouter is mounted at /api/v1/solutions.
func SolutionsRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listSolutions(q))
	r.Post("/", createSolution(q, pool))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", getSolution(q))
		r.Patch("/", updateSolution(q))
		r.Delete("/", deleteSolution(q))
		r.Get("/overview", solutionOverview(q))
		r.Put("/items", changeSolutionItems(q, pool, "replace"))
		r.Post("/items", changeSolutionItems(q, pool, "add"))
		r.Delete("/items", changeSolutionItems(q, pool, "remove"))
	})
	return r
}
