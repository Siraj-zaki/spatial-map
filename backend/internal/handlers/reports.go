// Package handlers — reports.go
//
// CRUD + ACL + execution history for the Report Builder. A Report is
// a user-composed JSON spec that references user-defined tables and
// data-source rows (REST/file/webhook) and describes filters,
// aggregations, and an ordered list of widgets (KPI, table, chart,
// map, markdown, ...).
//
// This file only handles PERSISTENCE + PERMISSIONS. The Phase 2
// executor (`POST /reports/{id}/run`) translates the spec to safe
// parameterized SQL — it lives in `internal/reports/executor.go` and is
// wired here as a stub that returns 501 until Phase 2 lands.
//
// Permission model (v1):
//   - Only owner/admin tenant members can CREATE, UPDATE, ARCHIVE, or
//     DELETE reports (enforced via requireRole).
//   - A report is VISIBLE to: (a) tenant owners/admins always, (b) the
//     creator always, (c) any tenant member listed in
//     `report_permissions` for that report.
//   - A report is EDITABLE by: (a) tenant owners/admins, (b) the
//     creator, (c) members with `can_edit = true` in
//     `report_permissions`.
//
// The visibility filter is done in Go (not in SQL) — a broad
// ListReportsForTenant + a `ListReportIDsVisibleToUser` join in the
// handler keeps the SQL side small and lets us reuse the same
// per-report check on the CRUD endpoints without duplicating the
// predicate. For a tenant with hundreds of reports and thousands of
// members this would need revisiting; for the shipped scale it's the
// simpler path.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports/interpolate"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports/specmigrate"
	v2 "github.com/Siraj-zaki/spatial-map/backend/internal/reports/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// --------------------------- wire types -----------------------------

// ReportPermissionRequest — one ACL entry in the create/update body.
// `userId` must be a member of the same tenant; otherwise the handler
// returns 400 with a per-entry index in the message.
type ReportPermissionRequest struct {
	UserID  int64 `json:"userId" validate:"required"`
	CanEdit bool  `json:"canEdit"`
}

// CreateReportRequest — POST /reports body. `spec` is opaque JSONB at
// this layer; the Phase 2 executor validates shape at run time. The
// builder UI is the current source of truth for the spec schema.
//
// `zoneId` scopes the report to a facility (migration 0040). Pointer +
// omitempty so callers can send null / omit for "cross-facility". The
// handler passes it through as pgtype.Int8 with Valid=false when nil.
type CreateReportRequest struct {
	Name        string                    `json:"name" validate:"required,min=1,max=128"`
	Description string                    `json:"description" validate:"max=1024"`
	Icon        string                    `json:"icon" validate:"max=64"`
	Color       string                    `json:"color" validate:"max=64"`
	Spec        json.RawMessage           `json:"spec"`
	SpecVersion int32                     `json:"specVersion"`
	ZoneID      *int64                    `json:"zoneId"`
	Permissions []ReportPermissionRequest `json:"permissions"`
}

// UpdateReportRequest — PUT /reports/{id} body. Full replace of every
// updatable field. Patch semantics happen in the SPA before the write.
type UpdateReportRequest struct {
	Name        string                    `json:"name" validate:"required,min=1,max=128"`
	Description string                    `json:"description" validate:"max=1024"`
	Icon        string                    `json:"icon" validate:"max=64"`
	Color       string                    `json:"color" validate:"max=64"`
	Spec        json.RawMessage           `json:"spec"`
	SpecVersion int32                     `json:"specVersion"`
	ZoneID      *int64                    `json:"zoneId"`
	Permissions []ReportPermissionRequest `json:"permissions"`
}

// ReportPermissionResponse — enriched ACL entry (includes email so the
// SPA can render the user-picker without a second lookup).
type ReportPermissionResponse struct {
	UserID    int64  `json:"userId"`
	UserEmail string `json:"userEmail"`
	CanEdit   bool   `json:"canEdit"`
	GrantedAt string `json:"grantedAt"`
	GrantedBy int64  `json:"grantedBy,omitempty"`
}

// ReportResponse — wire shape for a saved report.
type ReportResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Icon        string          `json:"icon"`
	Color       string          `json:"color"`
	Spec        json.RawMessage `json:"spec"`
	SpecVersion int32           `json:"specVersion"`
	IsArchived  bool            `json:"isArchived"`
	CreatedBy   int64           `json:"createdBy,omitempty"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
	// ZoneID pins the report to a facility. Nil / omitted = "cross-facility"
	// (visible under the All-facilities tab; hidden from single-zone views).
	ZoneID *int64 `json:"zoneId,omitempty"`
	// CanEdit is filled per-caller — the same report row shows CanEdit=true
	// for the creator and false for a view-only member.
	CanEdit     bool                       `json:"canEdit"`
	Permissions []ReportPermissionResponse `json:"permissions,omitempty"`
}

// ReportRunResponse — wire shape for one row of the run history.
type ReportRunResponse struct {
	ID             int64           `json:"id"`
	ReportID       int64           `json:"reportId"`
	SpecSnapshot   json.RawMessage `json:"specSnapshot"`
	FiltersApplied json.RawMessage `json:"filtersApplied"`
	RowCount       int32           `json:"rowCount"`
	MsElapsed      int32           `json:"msElapsed"`
	Status         string          `json:"status"`
	Error          string          `json:"error,omitempty"`
	RanBy          int64           `json:"ranBy,omitempty"`
	RanAt          string          `json:"ranAt"`
}

// --------------------------- conversions -----------------------------

func toReportResponse(row db.Report, canEdit bool) ReportResponse {
	spec := row.Spec
	if len(spec) == 0 {
		spec = json.RawMessage("{}")
	}
	resp := ReportResponse{
		ID:          row.ID,
		TenantID:    row.TenantID,
		Name:        row.Name,
		Description: row.Description,
		Icon:        row.Icon,
		Color:       row.Color,
		Spec:        spec,
		SpecVersion: row.SpecVersion,
		IsArchived:  row.IsArchived,
		CreatedAt:   api.FormatTime(row.CreatedAt),
		UpdatedAt:   api.FormatTime(row.UpdatedAt),
		CanEdit:     canEdit,
	}
	if row.CreatedBy.Valid {
		resp.CreatedBy = row.CreatedBy.Int64
	}
	if row.ZoneID.Valid {
		z := row.ZoneID.Int64
		resp.ZoneID = &z
	}
	return resp
}

func toReportPermissionResponse(row db.ListReportPermissionsRow) ReportPermissionResponse {
	resp := ReportPermissionResponse{
		UserID:    row.UserID,
		UserEmail: row.UserEmail,
		CanEdit:   row.CanEdit,
		GrantedAt: api.FormatTime(row.GrantedAt),
	}
	if row.GrantedBy.Valid {
		resp.GrantedBy = row.GrantedBy.Int64
	}
	return resp
}

func toReportRunResponse(row db.ReportRun) ReportRunResponse {
	resp := ReportRunResponse{
		ID:             row.ID,
		ReportID:       row.ReportID,
		SpecSnapshot:   row.SpecSnapshot,
		FiltersApplied: row.FiltersApplied,
		RowCount:       row.RowCount,
		MsElapsed:      row.MsElapsed,
		Status:         row.Status,
		Error:          row.Error,
		RanAt:          api.FormatTime(row.RanAt),
	}
	if row.RanBy.Valid {
		resp.RanBy = row.RanBy.Int64
	}
	return resp
}

// --------------------------- ACL resolution -------------------------

// reportAccess bundles the two access decisions for a single report:
// can the caller SEE it, and can they EDIT it. Both are computed from
// the same inputs so the caller doesn't have to re-derive them.
type reportAccess struct {
	CanView bool
	CanEdit bool
}

// resolveReportAccess computes visibility + edit rights for the caller.
// The rules:
//   - Owner / admin on the tenant → view + edit anything.
//   - The report's creator → view + edit.
//   - Otherwise, look up `report_permissions` for (report_id, user_id):
//     present → view; can_edit=true → edit as well.
//   - A workspace viewer never edits, even a report they created or were
//     granted edit on: the role is read-only, and a member demoted to
//     viewer kept editing their old reports through the API.
//
// A missing row is a hard "no" for non-admins — that's what makes the
// admin-created report invisible to unlisted members.
func resolveReportAccess(ctx context.Context, q *db.Queries, r db.Report, userID int64, role string) (reportAccess, error) {
	// Owners / admins — or any role with reports.viewAll — see every report.
	if api.HasPermission(ctx, api.PermReportsViewAll) {
		return reportAccess{CanView: true, CanEdit: roleCanEditReports(ctx)}, nil
	}
	if r.CreatedBy.Valid && r.CreatedBy.Int64 == userID {
		return reportAccess{CanView: true, CanEdit: roleCanEditReports(ctx)}, nil
	}
	perms, err := q.ListReportIDsVisibleToUser(ctx, userID)
	if err != nil {
		return reportAccess{}, err
	}
	for _, p := range perms {
		if p.ReportID == r.ID {
			return reportAccess{CanView: true, CanEdit: p.CanEdit && roleCanEditReports(ctx)}, nil
		}
	}
	return reportAccess{}, nil
}

// roleCanEditReports — without reports.edit (viewers, and custom roles
// without it) nobody edits, whatever the report ACL says.
func roleCanEditReports(ctx context.Context) bool {
	return api.HasPermission(ctx, api.PermReportsEdit)
}

// callerRole fetches the caller's role on the current tenant. Returns
// ("", false) with a 401/403 already written to the response when the
// caller is not authenticated or not a tenant member.
func callerRole(w http.ResponseWriter, r *http.Request, q *db.Queries) (string, bool) {
	userID := api.UserID(r.Context())
	tenantID := api.TenantID(r.Context())
	if userID == 0 || tenantID == 0 {
		api.Error(w, http.StatusUnauthorized, "not authenticated")
		return "", false
	}
	m, err := q.GetUserTenantMembership(r.Context(), db.GetUserTenantMembershipParams{
		UserID: userID, TenantID: tenantID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			api.Error(w, http.StatusForbidden, "not a member of this tenant")
			return "", false
		}
		api.InternalError(w, r, err)
		return "", false
	}
	return m.Role, true
}

// validatePermissionRequests ensures every referenced user is a member
// of the current tenant. Cross-tenant leakage would otherwise be
// possible via a hand-crafted request body.
func validatePermissionRequests(ctx context.Context, q *db.Queries, tenantID int64, perms []ReportPermissionRequest) error {
	if len(perms) == 0 {
		return nil
	}
	members, err := q.ListTenantMembers(ctx, tenantID)
	if err != nil {
		return err
	}
	memberSet := make(map[int64]struct{}, len(members))
	for _, m := range members {
		memberSet[m.UserID] = struct{}{}
	}
	for _, p := range perms {
		if _, ok := memberSet[p.UserID]; !ok {
			return errors.New("permission entry references a user outside this tenant")
		}
	}
	return nil
}

// --------------------------- list / get -----------------------------

// listReportsHandler — GET /reports. Returns every non-archived report
// the caller is allowed to see. Admins get the full set; non-admins
// get creator-of + explicitly-granted.
func listReportsHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		userID := api.UserID(r.Context())
		// Membership check (401/403); visibility comes from the permissions.
		if _, ok := callerRole(w, r, q); !ok {
			return
		}
		// Optional facility filter: `?zoneId=<n>` narrows the list to that
		// zone + cross-facility (zone_id IS NULL) reports. Anything else
		// (missing, 0, non-numeric) → full tenant list. Matches the
		// `activeZoneId` handling in the shape catalog handlers.
		var (
			rows    []db.Report
			listErr error
		)
		if raw := r.URL.Query().Get("zoneId"); raw != "" {
			if zoneID, perr := strconv.ParseInt(raw, 10, 64); perr == nil && zoneID > 0 {
				rows, listErr = q.ListReportsForTenantByZone(r.Context(), db.ListReportsForTenantByZoneParams{
					TenantID: tenantID,
					ZoneID:   pgtype.Int8{Int64: zoneID, Valid: true},
				})
			} else {
				rows, listErr = q.ListReportsForTenant(r.Context(), tenantID)
			}
		} else {
			rows, listErr = q.ListReportsForTenant(r.Context(), tenantID)
		}
		if listErr != nil {
			api.InternalError(w, r, listErr)
			return
		}
		// Non-admins: prefetch the caller's permission grants once so we
		// don't re-query per report.
		grantMap := map[int64]bool{}
		seeAll := api.HasPermission(r.Context(), api.PermReportsViewAll)
		if !seeAll {
			perms, err := q.ListReportIDsVisibleToUser(r.Context(), userID)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			for _, p := range perms {
				grantMap[p.ReportID] = p.CanEdit
			}
		}
		out := make([]ReportResponse, 0, len(rows))
		for _, row := range rows {
			var canView, canEdit bool
			switch {
			case seeAll:
				canView, canEdit = true, roleCanEditReports(r.Context())
			case row.CreatedBy.Valid && row.CreatedBy.Int64 == userID:
				canView, canEdit = true, roleCanEditReports(r.Context())
			default:
				if editable, ok := grantMap[row.ID]; ok {
					canView, canEdit = true, editable && roleCanEditReports(r.Context())
				}
			}
			if !canView {
				continue
			}
			out = append(out, toReportResponse(row, canEdit))
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// getReportHandler — GET /reports/{id}. Returns the report + ACL rows
// (ACL only shown to editors — a plain viewer doesn't need to see who
// else has access).
func getReportHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		userID := api.UserID(r.Context())
		role, ok := callerRole(w, r, q)
		if !ok {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid report id")
			return
		}
		row, err := q.GetReport(r.Context(), db.GetReportParams{ID: id, TenantID: tenantID})
		if err != nil {
			api.NotFound(w, "report not found")
			return
		}
		access, err := resolveReportAccess(r.Context(), q, row, userID, role)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if !access.CanView {
			api.NotFound(w, "report not found") // do not leak existence
			return
		}
		resp := toReportResponse(row, access.CanEdit)
		if access.CanEdit {
			perms, err := q.ListReportPermissions(r.Context(), row.ID)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			resp.Permissions = make([]ReportPermissionResponse, 0, len(perms))
			for _, p := range perms {
				resp.Permissions = append(resp.Permissions, toReportPermissionResponse(p))
			}
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

// --------------------------- create / update ------------------------

func createReportHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		userID := api.UserID(r.Context())
		if !api.RequirePermission(w, r, api.PermReportsCreate) {
			return
		}
		var req CreateReportRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := validatePermissionRequests(r.Context(), q, tenantID, req.Permissions); err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		spec := defaultJSONObject(req.Spec)
		version := req.SpecVersion
		if version <= 0 {
			version = 1
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		qtx := q.WithTx(tx)

		zone := pgtype.Int8{}
		if req.ZoneID != nil {
			zone = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
		}
		row, err := qtx.CreateReport(r.Context(), db.CreateReportParams{
			TenantID:    tenantID,
			Name:        req.Name,
			Description: req.Description,
			Icon:        req.Icon,
			Color:       req.Color,
			Spec:        spec,
			SpecVersion: version,
			CreatedBy:   pgtype.Int8{Int64: userID, Valid: userID != 0},
			ZoneID:      zone,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := writePermissions(r.Context(), qtx, row.ID, userID, req.Permissions); err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}

		resp := toReportResponse(row, true)
		perms, _ := q.ListReportPermissions(r.Context(), row.ID)
		resp.Permissions = make([]ReportPermissionResponse, 0, len(perms))
		for _, p := range perms {
			resp.Permissions = append(resp.Permissions, toReportPermissionResponse(p))
		}
		api.JSON(w, http.StatusCreated, resp)
	}
}

func updateReportHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		userID := api.UserID(r.Context())
		role, ok := callerRole(w, r, q)
		if !ok {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid report id")
			return
		}
		row, err := q.GetReport(r.Context(), db.GetReportParams{ID: id, TenantID: tenantID})
		if err != nil {
			api.NotFound(w, "report not found")
			return
		}
		access, err := resolveReportAccess(r.Context(), q, row, userID, role)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if !access.CanView {
			api.NotFound(w, "report not found")
			return
		}
		if !access.CanEdit {
			api.Error(w, http.StatusForbidden, "insufficient permissions to edit this report")
			return
		}
		var req UpdateReportRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		if err := validatePermissionRequests(r.Context(), q, tenantID, req.Permissions); err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		spec := defaultJSONObject(req.Spec)
		version := req.SpecVersion
		if version <= 0 {
			version = row.SpecVersion
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		qtx := q.WithTx(tx)

		// PUT is full-replace (see struct doc). If the client explicitly omits
		// `zoneId`, the pointer arrives as nil and we set the column to NULL.
		// Every UI path that persists a report is expected to load the current
		// row first and echo `zoneId` back, so this preserves the value in the
		// normal case. Scripts that write PUTs without zoneId will null it —
		// same trade-off `Name` / `Spec` already accept.
		zone := pgtype.Int8{}
		if req.ZoneID != nil {
			zone = pgtype.Int8{Int64: *req.ZoneID, Valid: true}
		}
		updated, err := qtx.UpdateReport(r.Context(), db.UpdateReportParams{
			ID:          id,
			TenantID:    tenantID,
			Name:        req.Name,
			Description: req.Description,
			Icon:        req.Icon,
			Color:       req.Color,
			Spec:        spec,
			SpecVersion: version,
			ZoneID:      zone,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		// ACL: only editors can rewrite ACL; only ADMINS can persist changes
		// that remove themselves from editability (a creator who ISN'T an
		// admin cannot lock themselves out — the write is allowed, but a
		// non-admin creator always retains view+edit via the creator rule
		// anyway).
		if err := writePermissions(r.Context(), qtx, id, userID, req.Permissions); err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}
		resp := toReportResponse(updated, true)
		perms, _ := q.ListReportPermissions(r.Context(), id)
		resp.Permissions = make([]ReportPermissionResponse, 0, len(perms))
		for _, p := range perms {
			resp.Permissions = append(resp.Permissions, toReportPermissionResponse(p))
		}
		api.JSON(w, http.StatusOK, resp)
	}
}

// writePermissions replaces the ACL set for a report. Delete-all +
// re-insert keeps the code short — the alternative diff-and-patch
// approach would need two extra passes to detect adds vs. removes and
// buys nothing at v1 scale.
func writePermissions(ctx context.Context, q *db.Queries, reportID, grantedByUserID int64, perms []ReportPermissionRequest) error {
	if err := q.DeleteAllReportPermissions(ctx, reportID); err != nil {
		return err
	}
	for _, p := range perms {
		if err := q.UpsertReportPermission(ctx, db.UpsertReportPermissionParams{
			ReportID:  reportID,
			UserID:    p.UserID,
			CanEdit:   p.CanEdit,
			GrantedBy: pgtype.Int8{Int64: grantedByUserID, Valid: grantedByUserID != 0},
		}); err != nil {
			return err
		}
	}
	return nil
}

// --------------------------- archive / delete -----------------------

// archiveReportHandler — DELETE /reports/{id}. Soft delete (sets
// is_archived=true). Restrict to owner/admin — a non-admin creator
// hides a report by editing it, not by archiving it.
func archiveReportHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		if !api.RequirePermission(w, r, api.PermReportsCreate) {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid report id")
			return
		}
		if _, err := q.GetReport(r.Context(), db.GetReportParams{ID: id, TenantID: tenantID}); err != nil {
			api.NotFound(w, "report not found")
			return
		}
		if err := q.SetReportArchived(r.Context(), db.SetReportArchivedParams{
			ID: id, TenantID: tenantID, IsArchived: true,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
	}
}

// restoreReportHandler — POST /reports/{id}/restore. Undoes an archive
// (the gallery's "Archived · Undo" toast). Same owner/admin gate as the
// archive itself.
func restoreReportHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		if !api.RequirePermission(w, r, api.PermReportsCreate) {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid report id")
			return
		}
		if _, err := q.GetReport(r.Context(), db.GetReportParams{ID: id, TenantID: tenantID}); err != nil {
			api.NotFound(w, "report not found")
			return
		}
		if err := q.SetReportArchived(r.Context(), db.SetReportArchivedParams{
			ID: id, TenantID: tenantID, IsArchived: false,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
	}
}

// --------------------------- run / history --------------------------

// RunReportRequest — POST /reports/{id}/run body (v2 shape).
//
//   - `params` maps each parameter's id to its client-provided value.
//     Shape depends on the param's input kind: scalar for
//     dropdown/textInput, array for multi-select, {start,end} for
//     dateRange, and a typed Predicate for dimensionGrid.
//   - `queryNames` optionally restricts execution to a subset — omit
//     to run every query in the dashboard.
//
// Both fields are optional; a nil body runs every query with unset
// params (equivalent to a fresh viewer load).
type RunReportRequest struct {
	Params     map[string]json.RawMessage `json:"params,omitempty"`
	QueryNames []string                   `json:"queryNames,omitempty"`
}

// QueryRunResult is one query's outcome under the dashboard run.
type QueryRunResult struct {
	Columns   []reports.Column `json:"columns"`
	Rows      [][]any          `json:"rows"`
	RowCount  int              `json:"rowCount"`
	MsElapsed int              `json:"msElapsed"`
	Error     string           `json:"error,omitempty"`
}

// RunReportResponse — POST /reports/{id}/run response (v2 shape).
// `queries` is keyed by query name; missing keys mean the query was
// excluded via `queryNames`. `spec` echoes the stored spec so the SPA
// can render widget bindings against exactly what was executed.
type RunReportResponse struct {
	RunID     int64                     `json:"runId"`
	MsElapsed int                       `json:"msElapsed"`
	Queries   map[string]QueryRunResult `json:"queries"`
	Spec      json.RawMessage           `json:"spec"`
}

// runReportHandler — POST /reports/{id}/run (v2).
//
// Loads the stored spec, migrates to v2 in-memory if the row is still
// v1, resolves per-query sources, applies runtime params, and runs
// every query concurrently via [reports.Executor.RunMany]. Writes one
// header row + one child row per executed query to `report_runs`.
func runReportHandler(q *db.Queries, executor *reports.Executor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		userID := api.UserID(r.Context())
		role, ok := callerRole(w, r, q)
		if !ok {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid report id")
			return
		}
		row, err := q.GetReport(r.Context(), db.GetReportParams{ID: id, TenantID: tenantID})
		if err != nil {
			api.NotFound(w, "report not found")
			return
		}
		access, err := resolveReportAccess(r.Context(), q, row, userID, role)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if !access.CanView {
			api.NotFound(w, "report not found")
			return
		}

		var req RunReportRequest
		_ = api.DecodeBody(r, &req) // body optional
		runStoredReport(w, r, q, executor, tenantID, row, userID, req, true)
	}
}

// runStoredReport runs a stored report for a caller already cleared to see
// it and writes the response. Shared by the signed-in run route and the
// public report-share run route; `logRun` false (a share-link visitor)
// leaves report_runs alone, so anonymous visits can't grow the history.
func runStoredReport(w http.ResponseWriter, r *http.Request, q *db.Queries, executor *reports.Executor, tenantID int64, row db.Report, userID int64, req RunReportRequest, logRun bool) {
	id := row.ID
	mig, err := specmigrate.FromRaw(row.Spec, row.SpecVersion)
	if err != nil {
		api.BadRequest(w, "spec parse: "+err.Error())
		return
	}
	spec := mig.Spec

	if len(spec.Queries) == 0 {
		api.BadRequest(w, "report has no queries configured")
		return
	}

	// Resolve params — one entry per declared param. Unknown params
	// in the request body are dropped silently (extra fields never
	// influence execution).
	params, err := resolveParamValues(spec, req.Params)
	if err != nil {
		api.BadRequest(w, "params: "+err.Error())
		return
	}

	// Resolve sources — one entry per query. Queries the caller
	// excluded via QueryNames are skipped (RunMany treats missing
	// entries as "source not resolved" which we turn into an
	// empty result rather than an error).
	queryFilter := stringSet(req.QueryNames)
	sources := make(map[string]*reports.Source, len(spec.Queries))
	selectedQueries := make([]v2.Query, 0, len(spec.Queries))
	for _, q2 := range spec.Queries {
		if len(queryFilter) > 0 && !queryFilter[q2.Name] {
			continue
		}
		src, err := reports.ResolveSource(r.Context(), q, tenantID, reports.SourceRef{
			Kind: q2.SourceRef.Kind, ID: q2.SourceRef.ID,
		})
		if err != nil {
			api.BadRequest(w, fmt.Sprintf("query %q: cannot resolve source: %s", q2.Name, err.Error()))
			return
		}
		sources[q2.Name] = src
		selectedQueries = append(selectedQueries, q2)
	}

	runSpec := spec
	runSpec.Queries = selectedQueries

	started := time.Now()
	many, err := executor.RunMany(r.Context(), tenantID, sources, runSpec, params)
	elapsed := int(time.Since(started).Milliseconds())
	if err != nil {
		if logRun {
			logDashboardRun(r.Context(), q, id, tenantID, row.Spec, req, userID, "error", 0, elapsed, err.Error(), nil)
		}
		api.Error(w, http.StatusUnprocessableEntity, "dashboard failed: "+err.Error())
		return
	}

	// Aggregate stats + persist header + child rows.
	aggRowCount := 0
	aggErrs := 0
	for _, qr := range many.Queries {
		aggRowCount += qr.RowCount
		if qr.Err != "" {
			aggErrs++
		}
	}
	status := "ok"
	if aggErrs > 0 && aggErrs == len(many.Queries) {
		status = "error"
	}
	var runID int64
	if logRun {
		runID = logDashboardRun(r.Context(), q, id, tenantID, row.Spec, req, userID, status, aggRowCount, elapsed, "", many.Queries)
	}

	out := RunReportResponse{
		RunID:     runID,
		MsElapsed: elapsed,
		Queries:   make(map[string]QueryRunResult, len(many.Queries)),
		Spec:      row.Spec,
	}
	for name, qr := range many.Queries {
		out.Queries[name] = QueryRunResult{
			Columns:   qr.Result.Columns,
			Rows:      qr.Result.Rows,
			RowCount:  qr.RowCount,
			MsElapsed: qr.MsElapsed,
			Error:     qr.Err,
		}
	}
	api.JSON(w, http.StatusOK, out)
}

// stringSet turns a slice of names into a set for O(1) membership.
func stringSet(in []string) map[string]bool {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]bool, len(in))
	for _, s := range in {
		if s != "" {
			out[s] = true
		}
	}
	return out
}

// resolveParamValues walks the declared params and decodes each
// client-provided raw value into a typed [interpolate.ParamValue].
// Params the client didn't send are left absent from the returned
// map — the interpolator treats them as empty.
func resolveParamValues(spec v2.Spec, raw map[string]json.RawMessage) (map[string]interpolate.ParamValue, error) {
	out := make(map[string]interpolate.ParamValue, len(spec.Params))
	for _, p := range spec.Params {
		rawVal, has := raw[p.ID]
		if !has || len(rawVal) == 0 || string(rawVal) == "null" {
			continue
		}
		pv, err := decodeParamValue(p, rawVal)
		if err != nil {
			return nil, fmt.Errorf("param %q: %w", p.ID, err)
		}
		out[p.ID] = pv
	}
	return out, nil
}

// decodeParamValue turns one raw JSON value into a typed
// [interpolate.ParamValue] based on the declared input kind.
func decodeParamValue(p v2.Param, raw json.RawMessage) (interpolate.ParamValue, error) {
	pv := interpolate.ParamValue{Raw: raw}
	switch p.Input.Kind {
	case "dropdown":
		if p.Input.Multi {
			pv.Kind = interpolate.KindMulti
			var arr []any
			if err := json.Unmarshal(raw, &arr); err != nil {
				return pv, fmt.Errorf("expected array: %s", string(raw))
			}
			pv.Array = arr
			return pv, nil
		}
		pv.Kind = interpolate.KindSingle
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return pv, err
		}
		pv.Scalar = v
		return pv, nil
	case "buttonGroup", "textInput", "checkbox":
		pv.Kind = interpolate.KindSingle
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return pv, err
		}
		pv.Scalar = v
		return pv, nil
	case "dateInput":
		pv.Kind = interpolate.KindDate
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return pv, fmt.Errorf("expected date string: %s", string(raw))
		}
		pv.Scalar = s
		return pv, nil
	case "dateRange":
		pv.Kind = interpolate.KindDateRange
		var obj struct {
			Start any `json:"start"`
			End   any `json:"end"`
		}
		if err := json.Unmarshal(raw, &obj); err != nil {
			return pv, fmt.Errorf("expected {start, end}: %s", string(raw))
		}
		pv.Range.Start = obj.Start
		pv.Range.End = obj.End
		return pv, nil
	case "slider":
		pv.Kind = interpolate.KindNumberRange
		// Slider value can be a single number OR a {low, high} range.
		var single float64
		if err := json.Unmarshal(raw, &single); err == nil {
			pv.Kind = interpolate.KindSingle
			pv.Scalar = single
			return pv, nil
		}
		var obj struct {
			Low  float64 `json:"low"`
			High float64 `json:"high"`
		}
		if err := json.Unmarshal(raw, &obj); err != nil {
			return pv, fmt.Errorf("slider value must be a number or {low, high}: %s", string(raw))
		}
		pv.Range.Start = obj.Low
		pv.Range.End = obj.High
		return pv, nil
	case "dimensionGrid":
		pv.Kind = interpolate.KindPredicate
		var pred queryx.Predicate
		if err := json.Unmarshal(raw, &pred); err != nil {
			return pv, fmt.Errorf("expected predicate: %s", string(raw))
		}
		pv.Predicate = &pred
		return pv, nil
	default:
		return pv, fmt.Errorf("unknown input kind %q", p.Input.Kind)
	}
}

// logDashboardRun writes the header row + one child row per executed
// query into `report_runs`. Failures are swallowed — history is
// best-effort; a failed history write shouldn't hide a successful
// dashboard from the user.
func logDashboardRun(
	ctx context.Context,
	q *db.Queries,
	reportID, tenantID int64,
	specSnapshot json.RawMessage,
	req RunReportRequest,
	userID int64,
	status string,
	rowCount, msElapsed int,
	errMsg string,
	children map[string]reports.QueryResult,
) int64 {
	if len(specSnapshot) == 0 {
		specSnapshot = json.RawMessage("{}")
	}
	// Filters column stores the params object wrapped in the same
	// legacy `filters_applied` slot — kept for schema stability.
	filtersApplied := json.RawMessage("{}")
	if req.Params != nil {
		if b, err := json.Marshal(map[string]any{"params": req.Params, "queryNames": req.QueryNames}); err == nil {
			filtersApplied = b
		}
	}
	header, err := q.CreateReportRunHeader(ctx, db.CreateReportRunHeaderParams{
		ReportID:       reportID,
		TenantID:       tenantID,
		SpecSnapshot:   specSnapshot,
		FiltersApplied: filtersApplied,
		RowCount:       int32(rowCount),
		MsElapsed:      int32(msElapsed),
		Status:         status,
		Error:          errMsg,
		RanBy:          pgtype.Int8{Int64: userID, Valid: userID != 0},
	})
	if err != nil {
		return 0
	}
	// Per-query child rows. Ignore individual failures — the header is
	// what the history drawer lists.
	for name, qr := range children {
		childStatus := "ok"
		if qr.Err != "" {
			childStatus = "error"
		}
		_ = q.CreateReportRunChild(ctx, db.CreateReportRunChildParams{
			ReportID:    reportID,
			TenantID:    tenantID,
			RowCount:    int32(qr.RowCount),
			MsElapsed:   int32(qr.MsElapsed),
			Status:      childStatus,
			Error:       qr.Err,
			RanBy:       pgtype.Int8{Int64: userID, Valid: userID != 0},
			ParentRunID: pgtype.Int8{Int64: header.ID, Valid: true},
			QueryName:   name,
		})
	}
	return header.ID
}

// -------------------------- history widget --------------------------

// HistoryBucket — one row of the change-over-time chart. `Ts` is the
// bucket start (already truncated to `bucket_unit`); the three counts
// are the number of inserts / updates / deletes that fell in the
// bucket. Operations with zero events in a bucket surface as 0 so
// the chart doesn't need to handle sparse rows.
type HistoryBucket struct {
	Ts     string `json:"ts"`
	Insert int64  `json:"insert"`
	Update int64  `json:"update"`
	Delete int64  `json:"delete"`
}

// HistoryEvent — one row of the "recent changes" list. `Payload` is
// the full row snapshot at event time (from `data_source_row_events`).
type HistoryEvent struct {
	ID        int64           `json:"id"`
	EntityKey string          `json:"entityKey"`
	Operation string          `json:"operation"`
	Ts        string          `json:"ts"`
	Payload   json.RawMessage `json:"payload"`
}

// HistoryResponse is what the History widget renders. Two axes:
// bucketed counts for the chart, recent events for the tail list.
type HistoryResponse struct {
	Buckets     []HistoryBucket `json:"buckets"`
	Recent      []HistoryEvent  `json:"recent"`
	SourceID    int64           `json:"sourceId"`
	WindowDays  int             `json:"windowDays"`
	BucketUnit  string          `json:"bucketUnit"`
	TotalEvents int64           `json:"totalEvents"`
}

// reportHistoryHandler — GET /reports/history?sourceId=X&windowDays=N&bucket=day&recent=20.
// Aggregates events on `data_source_row_events` for one source over a
// bounded time window. Not tied to a specific report id — a report
// can have multiple History widgets over different sources, and this
// endpoint serves any of them. Access is by tenant membership +
// visibility of the underlying source (reuses the source-exists check).
func reportHistoryHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		if _, ok := callerRole(w, r, q); !ok {
			return
		}
		sourceID := int64(api.Int64Query(r, "sourceId", 0))
		if sourceID <= 0 {
			api.BadRequest(w, "sourceId is required")
			return
		}
		serveReportHistory(w, r, q, tenantID, sourceID)
	}
}

// serveReportHistory writes the History widget's buckets + recent events
// for a source. Shared by the signed-in route and the report share-link
// route.
func serveReportHistory(w http.ResponseWriter, r *http.Request, q *db.Queries, tenantID, sourceID int64) {
	// Verify the source belongs to the tenant. Any authed member
	// with source access can pull history — no per-report ACL
	// check because history is a source-level concept.
	histSrc, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
		ID: sourceID, TenantID: tenantID,
	})
	if err != nil {
		api.NotFound(w, "source not found")
		return
	}
	// Shapes keep no change trail, so a built-in facility source has
	// no history to show.
	if histSrc.Kind == db.DataSourceKindFacility {
		api.BadRequest(w, "facility sources have no history")
		return
	}
	windowDays := api.IntQuery(r, "windowDays", 7)
	if windowDays <= 0 {
		windowDays = 7
	}
	if windowDays > 365 {
		windowDays = 365
	}
	bucketUnit, err := normalizeBucketUnit(r.URL.Query().Get("bucket"))
	if err != nil {
		api.BadRequest(w, err.Error())
		return
	}
	recent := api.IntQuery(r, "recent", 20)
	if recent < 0 {
		recent = 0
	}
	if recent > 500 {
		recent = 500
	}
	since := time.Now().UTC().Add(-time.Duration(windowDays) * 24 * time.Hour)

	bucketRows, err := q.BucketDataSourceRowEvents(r.Context(), db.BucketDataSourceRowEventsParams{
		SourceID:   sourceID,
		TenantID:   tenantID,
		Ts:         pgtype.Timestamptz{Time: since, Valid: true},
		BucketUnit: bucketUnit,
	})
	if err != nil {
		api.InternalError(w, r, err)
		return
	}

	// Fold the per-operation rows into one row per bucket.
	byTs := map[time.Time]*HistoryBucket{}
	var order []time.Time
	var total int64
	for _, br := range bucketRows {
		ts := br.BucketTs.Time
		b, ok := byTs[ts]
		if !ok {
			b = &HistoryBucket{Ts: api.FormatTime(br.BucketTs)}
			byTs[ts] = b
			order = append(order, ts)
		}
		switch br.Operation {
		case "insert":
			b.Insert = br.EventCount
		case "update":
			b.Update = br.EventCount
		case "delete":
			b.Delete = br.EventCount
		}
		total += br.EventCount
	}
	buckets := make([]HistoryBucket, 0, len(order))
	for _, ts := range order {
		buckets = append(buckets, *byTs[ts])
	}

	// Initialize as empty slice (not nil) so the JSON response is
	// always `"recent": []`, never `"recent": null`. The SPA
	// widget treats the two the same after this response passes
	// through its optional-chain guard, but keeping the wire
	// shape consistent avoids one class of bug at every consumer.
	recentEvents := []HistoryEvent{}
	if recent > 0 {
		rows, err := q.RecentDataSourceRowEvents(r.Context(), db.RecentDataSourceRowEventsParams{
			SourceID: sourceID, TenantID: tenantID,
			Ts:    pgtype.Timestamptz{Time: since, Valid: true},
			Limit: int32(recent),
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		for _, e := range rows {
			recentEvents = append(recentEvents, HistoryEvent{
				ID:        e.ID,
				EntityKey: e.EntityKey,
				Operation: e.Operation,
				Ts:        api.FormatTime(e.Ts),
				Payload:   e.Payload,
			})
		}
	}

	api.JSON(w, http.StatusOK, HistoryResponse{
		Buckets:     buckets,
		Recent:      recentEvents,
		SourceID:    sourceID,
		WindowDays:  windowDays,
		BucketUnit:  bucketUnit,
		TotalEvents: total,
	})
}

// normalizeBucketUnit maps the user-facing bucket string onto the
// Postgres date_trunc unit. Only four values are accepted — anything
// else is a 400. `date_trunc` accepts more (microseconds, quarter,
// decade, etc.), but the History widget's chart is only useful in
// hour / day / week / month buckets.
func normalizeBucketUnit(raw string) (string, error) {
	if raw == "" {
		return "day", nil
	}
	switch raw {
	case "hour", "day", "week", "month":
		return raw, nil
	}
	return "", fmt.Errorf("bucket must be one of hour/day/week/month, got %q", raw)
}

// listReportRunsHandler — GET /reports/{id}/runs?limit=50.
func listReportRunsHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		userID := api.UserID(r.Context())
		role, ok := callerRole(w, r, q)
		if !ok {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid report id")
			return
		}
		row, err := q.GetReport(r.Context(), db.GetReportParams{ID: id, TenantID: tenantID})
		if err != nil {
			api.NotFound(w, "report not found")
			return
		}
		access, err := resolveReportAccess(r.Context(), q, row, userID, role)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if !access.CanView {
			api.NotFound(w, "report not found")
			return
		}
		limit := int32(api.IntQuery(r, "limit", 50))
		if limit <= 0 {
			limit = 50
		}
		if limit > 500 {
			limit = 500
		}
		runs, err := q.ListReportRuns(r.Context(), db.ListReportRunsParams{
			ReportID: id, TenantID: tenantID, Limit: limit,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]ReportRunResponse, 0, len(runs))
		for _, run := range runs {
			out = append(out, toReportRunResponse(run))
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// paramOptionsHandler — GET /reports/{id}/param-options/{paramId}.
// Returns the option universe for a dropdown / buttonGroup /
// dimensionGrid param. Static option sets are echoed verbatim; query-
// sourced ones execute the referenced query with no runtime params
// and map its rows to {value, label} pairs.
//
// Access model: report-level view only — no source-level check.
// Rationale: if the caller can view the report, they can already
// trigger it via POST /run and see the same data indirectly. A
// tighter check would require duplicating the source-membership
// probe on every options call.
func paramOptionsHandler(q *db.Queries, executor *reports.Executor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		userID := api.UserID(r.Context())
		role, ok := callerRole(w, r, q)
		if !ok {
			return
		}
		id, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid report id")
			return
		}
		paramID := chi.URLParam(r, "paramId")
		if paramID == "" {
			api.BadRequest(w, "missing paramId")
			return
		}
		row, err := q.GetReport(r.Context(), db.GetReportParams{ID: id, TenantID: tenantID})
		if err != nil {
			api.NotFound(w, "report not found")
			return
		}
		access, err := resolveReportAccess(r.Context(), q, row, userID, role)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if !access.CanView {
			api.NotFound(w, "report not found")
			return
		}
		mig, err := specmigrate.FromRaw(row.Spec, row.SpecVersion)
		if err != nil {
			api.BadRequest(w, "spec parse: "+err.Error())
			return
		}
		var param *v2.Param
		for i := range mig.Spec.Params {
			if mig.Spec.Params[i].ID == paramID {
				param = &mig.Spec.Params[i]
				break
			}
		}
		if param == nil {
			api.NotFound(w, "param not found")
			return
		}
		options, err := resolveParamOptions(r.Context(), q, executor, tenantID, mig.Spec, param)
		if err != nil {
			api.BadRequest(w, "options: "+err.Error())
			return
		}
		api.JSON(w, http.StatusOK, map[string]any{
			"paramId": paramID,
			"options": options,
		})
	}
}

// paramOption is one entry in a param-options response.
type paramOption struct {
	Value any    `json:"value"`
	Label string `json:"label"`
}

// resolveParamOptions returns the option universe for a param.
// Static sources are echoed; query-sourced ones execute the
// referenced query with an empty params map. Deduplicated by value.
func resolveParamOptions(
	ctx context.Context,
	q *db.Queries,
	executor *reports.Executor,
	tenantID int64,
	spec v2.Spec,
	param *v2.Param,
) ([]paramOption, error) {
	if param.Input.Options == nil {
		return []paramOption{}, nil
	}
	src := param.Input.Options
	if len(src.Static) > 0 {
		out := make([]paramOption, 0, len(src.Static))
		for _, o := range src.Static {
			var v any
			_ = json.Unmarshal(o.Value, &v)
			out = append(out, paramOption{Value: v, Label: o.Label})
		}
		return out, nil
	}
	if src.FromQuery == "" || src.ValueColumn == "" {
		return []paramOption{}, nil
	}
	// Find the referenced query.
	var refQuery *v2.Query
	for i := range spec.Queries {
		if spec.Queries[i].Name == src.FromQuery {
			refQuery = &spec.Queries[i]
			break
		}
	}
	if refQuery == nil {
		return nil, fmt.Errorf("options query %q not found", src.FromQuery)
	}
	resolved, err := reports.ResolveSource(ctx, q, tenantID, reports.SourceRef{
		Kind: refQuery.SourceRef.Kind, ID: refQuery.SourceRef.ID,
	})
	if err != nil {
		return nil, fmt.Errorf("resolve source: %w", err)
	}
	runSpec := v2.Spec{V: v2.SpecVersion, Queries: []v2.Query{*refQuery}}
	sources := map[string]*reports.Source{refQuery.Name: resolved}
	many, err := executor.RunMany(ctx, tenantID, sources, runSpec, nil)
	if err != nil {
		return nil, err
	}
	qr, ok := many.Queries[refQuery.Name]
	if !ok || qr.Err != "" {
		msg := "query failed"
		if ok {
			msg = qr.Err
		}
		return nil, errors.New(msg)
	}
	valueIdx, labelIdx := -1, -1
	for i, c := range qr.Result.Columns {
		if c.Name == src.ValueColumn {
			valueIdx = i
		}
		if c.Name == src.LabelColumn {
			labelIdx = i
		}
	}
	if valueIdx == -1 {
		return nil, fmt.Errorf("value column %q not in query result", src.ValueColumn)
	}
	seen := map[string]bool{}
	out := make([]paramOption, 0, len(qr.Result.Rows))
	for _, row := range qr.Result.Rows {
		if valueIdx >= len(row) {
			continue
		}
		v := row[valueIdx]
		if v == nil {
			continue
		}
		key := fmt.Sprintf("%v", v)
		if seen[key] {
			continue
		}
		seen[key] = true
		opt := paramOption{Value: v, Label: key}
		if labelIdx >= 0 && labelIdx < len(row) && row[labelIdx] != nil {
			opt.Label = fmt.Sprintf("%v", row[labelIdx])
		}
		out = append(out, opt)
	}
	return out, nil
}

// --------------------------- members helper -------------------------

// listReportMemberCandidatesHandler — GET /reports/_/members. Returns
// the list of tenant members the current caller can grant access to
// when building the ACL picker. Admin-only — non-admins can't create
// reports and so don't need this list.
func listReportMemberCandidatesHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		if !api.RequirePermission(w, r, api.PermReportsCreate) {
			return
		}
		members, err := q.ListTenantMembers(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		type memberCandidate struct {
			UserID    int64  `json:"userId"`
			UserEmail string `json:"userEmail"`
			Role      string `json:"role"`
		}
		out := make([]memberCandidate, 0, len(members))
		for _, m := range members {
			out = append(out, memberCandidate{
				UserID:    m.UserID,
				UserEmail: m.UserEmail,
				Role:      m.Role,
			})
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// --------------------------- router --------------------------------

// ReportsRouter wires the CRUD + run + history + source-hints
// endpoints. Mounted at `/api/v1/reports` inside the tenant-scoped
// group. The executor is passed in so the run path can share one
// instance across requests (it holds the pool + tuned limits).
func ReportsRouter(q *db.Queries, pool *pgxpool.Pool, executor *reports.Executor) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listReportsHandler(q))
	r.Post("/", createReportHandler(q, pool))
	// Literal member-candidates route mounted BEFORE the {id} group so
	// chi doesn't route "/_" into the numeric id branch. Same trick for
	// schema-hints.
	r.Get("/_/members", listReportMemberCandidatesHandler(q))
	r.Get("/_/sources", listReportSourcesHandler(q))
	r.Get("/_/sources/{sourceId}/fields", getReportSourceFieldsHandler(q))
	// History widget uses a shared endpoint (not tied to a specific
	// report id) — a report can have several History widgets over
	// different sources, and each fetches independently.
	r.Get("/_/history", reportHistoryHandler(q))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", getReportHandler(q))
		r.Put("/", updateReportHandler(q, pool))
		r.Delete("/", archiveReportHandler(q))
		r.Post("/restore", restoreReportHandler(q))
		r.Post("/run", runReportHandler(q, executor))
		r.Get("/runs", listReportRunsHandler(q))
		r.Get("/param-options/{paramId}", paramOptionsHandler(q, executor))
		// Public links to this report (report_share_links.go).
		r.Get("/share-links", listReportShareLinksHandler(q))
		r.Post("/share-links", createReportShareLinkHandler(q))
	})
	return r
}

// listReportSourcesHandler — GET /reports/_/sources. Returns every
// data-source the tenant can build a report over: user-defined tables
// (kind=table), REST integrations, webhook sinks, and file imports.
// The builder's source picker calls this once per open.
func listReportSourcesHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		if _, ok := callerRole(w, r, q); !ok {
			return
		}
		sources, err := q.ListDataSources(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		type sourceHint struct {
			ID         int64  `json:"id"`
			Kind       string `json:"kind"`
			Name       string `json:"name"`
			EntityKind string `json:"entityKind,omitempty"`
			// Built-in facility sources only: the catalog key ("areas")
			// and the shape API kind rows are written back through.
			FacilityEntity string `json:"facilityEntity,omitempty"`
			APIKind        string `json:"apiKind,omitempty"`
		}
		out := make([]sourceHint, 0, len(sources)+len(reports.FacilityEntities))
		for _, s := range sources {
			out = append(out, sourceHint{
				ID:         s.ID,
				Kind:       string(s.Kind),
				Name:       s.Name,
				EntityKind: string(s.EntityKind),
			})
		}
		// Built-in facility sources, created on first use, in catalog order.
		facilityIDs, err := reports.FacilitySourceIDs(r.Context(), q, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		for _, e := range reports.FacilityEntities {
			id, ok := facilityIDs[e.Key]
			if !ok {
				continue
			}
			out = append(out, sourceHint{
				ID:             id,
				Kind:           string(db.DataSourceKindFacility),
				Name:           e.Name,
				EntityKind:     string(e.EntityKind),
				FacilityEntity: e.Key,
				APIKind:        e.APIKind,
			})
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// getReportSourceFieldsHandler — GET /reports/_/sources/{sourceId}/fields.
// Returns the field schema for a source: authoritative for kind='table'
// (via table_field_definitions), sample-inferred for the others (via
// SampleDataSourceRowFields). Reuses `reports.ResolveSource` so the
// builder + executor always see the same schema.
func getReportSourceFieldsHandler(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.BadRequest(w, "missing tenant")
			return
		}
		if _, ok := callerRole(w, r, q); !ok {
			return
		}
		sourceID, err := parseIDFromPath(r, "sourceId")
		if err != nil {
			api.BadRequest(w, "invalid source id")
			return
		}
		serveReportSourceFields(w, r, q, tenantID, sourceID)
	}
}

// serveReportSourceFields writes a source's field schema. Shared by the
// signed-in route and the report share-link route.
func serveReportSourceFields(w http.ResponseWriter, r *http.Request, q *db.Queries, tenantID, sourceID int64) {
	src, err := reports.ResolveSource(r.Context(), q, tenantID, reports.SourceRef{
		Kind: "dataSource", ID: sourceID,
	})
	if err != nil {
		api.NotFound(w, "source not found")
		return
	}
	type fieldHint struct {
		Key   string `json:"key"`
		Label string `json:"label"`
		Type  string `json:"type"`
	}
	out := make([]fieldHint, 0, len(src.Fields))
	for _, f := range src.Fields {
		out = append(out, fieldHint{Key: f.Key, Label: f.Label, Type: string(f.Type)})
	}
	resp := map[string]any{
		"id":     src.ID,
		"kind":   string(src.Kind),
		"name":   src.Name,
		"fields": out,
	}
	if src.Facility != nil {
		resp["facilityEntity"] = src.Facility.Key
		resp["apiKind"] = src.Facility.APIKind
	}
	api.JSON(w, http.StatusOK, resp)
}
