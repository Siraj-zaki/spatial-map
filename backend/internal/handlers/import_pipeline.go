package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xuri/excelize/v2"
)

// --------------- request / response shapes (mirror the SPA types) ---------------

type ImportPreviewRequest struct {
	// Multipart: "file" holds the CSV/XLSX/JSON bytes, and "plan" holds a JSON-encoded ImportPlan.
	// This struct is only used for the JSON part after parsing.
	Plan ImportPlan `json:"plan" validate:"required"`
}

type ImportPlan struct {
	Columns              []string               `json:"columns"`
	Match                MatchStrategy          `json:"match" validate:"required"`
	FieldMapping         map[string]FieldTarget `json:"fieldMapping" validate:"required"`
	ZoneID               *int64                 `json:"zoneId"`
	AutoDefineAttributes bool                   `json:"autoDefineAttributes"`
	SourceKind           string                 `json:"sourceKind" validate:"required,oneof=csv xlsx json"`
	SheetName            string                 `json:"sheetName"`
	JsonRootPath         string                 `json:"jsonRootPath"`
}

type MatchStrategy struct {
	Mode            string `json:"mode" validate:"required,oneof=externalCode gridCellAddress shapeName binLabel"`
	Column          string `json:"column"`
	GridColumn      string `json:"gridColumn"`
	GridColumnIs    string `json:"gridColumnIs"`
	RowColumn       string `json:"rowColumn"`
	ColColumn       string `json:"colColumn"`
	LevelColumn     string `json:"levelColumn"`
	ShapeNameColumn string `json:"shapeNameColumn"`
	ShapeKind       string `json:"shapeKind"`
	// Frontend wire shape uses `kind` for shapeName matches; the
	// saved-source adapter at parseSourceMappingWire uses `shapeKind`.
	// Both populate the same logical field; `normalize()` collapses them.
	Kind string `json:"kind"`
}

// normalize folds the two wire-format conventions for shapeName matches
// (`column` + `kind` from the import-dialog vs. `shapeNameColumn` +
// `shapeKind` from the saved-source adapter) into a single canonical
// shape so resolvers can read one set of fields.
func (m *MatchStrategy) normalize() {
	if m.Mode == "shapeName" {
		if m.ShapeNameColumn == "" {
			m.ShapeNameColumn = m.Column
		}
		if m.ShapeKind == "" {
			m.ShapeKind = m.Kind
		}
	}
}

type FieldTarget struct {
	Kind  string `json:"kind" validate:"required,oneof=builtin custom ignore"`
	Field string `json:"field"`
	Key   string `json:"key"`
}

type PreviewRow struct {
	RowIndex int                    `json:"rowIndex"`
	Raw      map[string]string      `json:"raw"`
	Resolved ResolvedTarget         `json:"resolved"`
	Patch    map[string]interface{} `json:"patch"`
	Warnings []string               `json:"warnings"`
}

type ResolvedTarget struct {
	Status       string `json:"status"` // matched-grid | matched-shape | will-create | unmatched
	Reason       string `json:"reason,omitempty"`
	GridID       int64  `json:"gridId,omitempty"`
	Row          int32  `json:"row,omitempty"`
	Col          int32  `json:"col,omitempty"`
	Level        int32  `json:"level,omitempty"`
	TargetKind   string `json:"targetKind,omitempty"`
	ShapeID      int64  `json:"shapeId,omitempty"`
	ExternalCode string `json:"externalCode,omitempty"`
	ExistingID   int64  `json:"existingId,omitempty"`
}

type PreviewResponse struct {
	Rows                 []PreviewRow `json:"rows"`
	Totals               Totals       `json:"totals"`
	UnknownAttributeKeys []string     `json:"unknownAttributeKeys"`
	Errors               []string     `json:"errors"`
}

type Totals struct {
	RowsRead         int `json:"rowsRead"`
	RowsMatchedGrid  int `json:"rowsMatchedGrid"`
	RowsMatchedShape int `json:"rowsMatchedShape"`
	RowsWillCreate   int `json:"rowsWillCreate"`
	RowsUnmatched    int `json:"rowsUnmatched"`
	RowsWithWarnings int `json:"rowsWithWarnings"`
}

type ImportCommitRequest struct {
	Plan ImportPlan `json:"plan" validate:"required"`
}

type ImportCommitResponse struct {
	RowsRead     int      `json:"rowsRead"`
	RowsMatched  int      `json:"rowsMatched"`
	RowsImported int      `json:"rowsImported"`
	RowsSkipped  int      `json:"rowsSkipped"`
	RowsErrored  int      `json:"rowsErrored"`
	Errors       []string `json:"errors"`
}

// --------------- pipeline handlers (wired into ImportJobsRouter) ---------------

func previewImport(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			api.BadRequest(w, "could not parse multipart form")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			api.BadRequest(w, "missing file field")
			return
		}
		defer file.Close()

		var plan ImportPlan
		if err := json.Unmarshal([]byte(r.FormValue("plan")), &plan); err != nil {
			api.BadRequest(w, "invalid plan json")
			return
		}
		plan.Match.normalize()
		if err := api.ValidateStruct(plan); err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		tenantID := api.TenantID(r.Context())
		columns, rows, parseErrors, err := parseImportFile(file, header.Filename, plan.SourceKind, plan.SheetName, plan.JsonRootPath)
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		for col := range plan.FieldMapping {
			if !sliceContains(columns, col) {
				api.BadRequest(w, fmt.Sprintf(`column "%s" not found in file`, col))
				return
			}
		}

		knownKeys, err := loadKnownAttributeKeys(r.Context(), q, tenantID, plan.ZoneID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		grids, shapes, err := loadCatalogForResolve(r.Context(), q, tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		previewRows := make([]PreviewRow, 0, len(rows))
		unknown := map[string]struct{}{}
		totals := Totals{RowsRead: len(rows)}
		for i, raw := range rows {
			resolved, reason := resolveRow(raw, plan, tenantID, grids, shapes, q, r.Context())
			if resolved.Status == "unmatched" {
				resolved.Reason = reason
				totals.RowsUnmatched++
			} else if resolved.Status == "will-create" {
				totals.RowsWillCreate++
			} else if resolved.Status == "matched-grid" {
				totals.RowsMatchedGrid++
			} else if resolved.Status == "matched-shape" {
				totals.RowsMatchedShape++
			}
			patch, warnings := buildPatch(raw, plan, resolved, knownKeys, unknown)
			if len(warnings) > 0 {
				totals.RowsWithWarnings++
			}
			previewRows = append(previewRows, PreviewRow{
				RowIndex: i,
				Raw:      raw,
				Resolved: resolved,
				Patch:    patch,
				Warnings: warnings,
			})
		}

		unknownKeys := make([]string, 0, len(unknown))
		for k := range unknown {
			unknownKeys = append(unknownKeys, k)
		}

		// The parser returns a nil slice for the no-errors case; Go marshals
		// that as JSON `null`, and the SPA reads `res.errors.length` on this
		// field. Normalize to an empty slice so the wire contract matches
		// `errors: string[]`.
		if parseErrors == nil {
			parseErrors = []string{}
		}

		api.JSON(w, http.StatusOK, PreviewResponse{
			Rows:                 previewRows,
			Totals:               totals,
			UnknownAttributeKeys: unknownKeys,
			Errors:               parseErrors,
		})
	}
}

func commitImport(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			api.BadRequest(w, "could not parse multipart form")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			api.BadRequest(w, "missing file field")
			return
		}
		defer file.Close()

		var plan ImportPlan
		if err := json.Unmarshal([]byte(r.FormValue("plan")), &plan); err != nil {
			api.BadRequest(w, "invalid plan json")
			return
		}
		plan.Match.normalize()
		if err := api.ValidateStruct(plan); err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		tenantID := api.TenantID(r.Context())
		sourceIDStr := r.FormValue("sourceId")
		sourceID, err := strconv.ParseInt(sourceIDStr, 10, 64)
		if err != nil {
			api.BadRequest(w, "invalid sourceId")
			return
		}

		// Read the file bytes once so we can both parse them and persist
		// them to source_files for later re-import from the integrations
		// page. Failing to persist bytes is non-fatal — the import still
		// lands — but we surface the failure so the operator knows the
		// re-import button won't be available for this run.
		fileBytes, err := io.ReadAll(file)
		if err != nil {
			api.BadRequest(w, fmt.Sprintf("could not read file: %v", err))
			return
		}

		summary, status, errMsg := executeImport(r.Context(), q, pool, tenantID, sourceID, plan, fileBytes, header.Filename, true)
		if errMsg != "" {
			if status == http.StatusBadRequest {
				api.BadRequest(w, errMsg)
			} else {
				api.Error(w, status, errMsg)
			}
			return
		}

		// Bulk bins invalidation so other clients reload the whole table.
		BroadcastEntityEvent("ENTITY_UPDATED", "bins", 0, tenantID)

		api.JSON(w, http.StatusOK, summary)
	}
}

// executeImport runs the parse → resolve → write pipeline against the
// supplied file bytes. Shared by `commitImport` (fresh upload) and
// `reimportFileSource` (re-run from saved bytes). When `persistBytes`
// is true, the bytes are upserted into source_files so the next
// re-import works without re-uploading.
//
// Returns (summary, httpStatus, errMsg). httpStatus=0 and errMsg="" on
// success; httpStatus=400 + errMsg on a parse / validation failure;
// httpStatus=500 + errMsg on an internal error.
func executeImport(
	ctx context.Context,
	q *db.Queries,
	pool *pgxpool.Pool,
	tenantID, sourceID int64,
	plan ImportPlan,
	fileBytes []byte,
	filename string,
	persistBytes bool,
) (ImportCommitResponse, int, string) {
	summary := ImportCommitResponse{Errors: []string{}}

	columns, rows, _, err := parseImportFile(bytes.NewReader(fileBytes), filename, plan.SourceKind, plan.SheetName, plan.JsonRootPath)
	if err != nil {
		return summary, http.StatusBadRequest, err.Error()
	}
	_ = columns

	knownKeys, err := loadKnownAttributeKeys(ctx, q, tenantID, plan.ZoneID)
	if err != nil {
		return summary, http.StatusInternalServerError, err.Error()
	}

	grids, shapes, err := loadCatalogForResolve(ctx, q, tenantID)
	if err != nil {
		return summary, http.StatusInternalServerError, err.Error()
	}

	summary.RowsRead = len(rows)

	if plan.AutoDefineAttributes {
		unknown := map[string]struct{}{}
		for _, raw := range rows {
			resolved, _ := resolveRow(raw, plan, tenantID, grids, shapes, q, ctx)
			_, _ = buildPatch(raw, plan, resolved, knownKeys, unknown)
		}
		if len(unknown) > 0 {
			for key := range unknown {
				if _, err := q.CreateAttributeDefinition(ctx, db.CreateAttributeDefinitionParams{
					TenantID: tenantID,
					Scope:    "any",
					Key:      key,
					Label:    humanize(key),
					Type:     "text",
				}); err != nil {
					summary.Errors = append(summary.Errors, fmt.Sprintf("auto-define %s: %v", key, err))
				}
			}
			knownKeys, _ = loadKnownAttributeKeys(ctx, q, tenantID, plan.ZoneID)
		}
	}

	// V3 routing: the source's entity_kind picks the write path.
	//   - 'rack-cell'  → legacy bin.custom_properties (map-grid-overlay
	//                    reads bins directly for occupancy tinting).
	//   - anything else → data_source_rows (reusable pool, layers query it).
	// See DESIGN-integrations-v3.md §3 and §4.1.
	source, err := q.GetDataSource(ctx, db.GetDataSourceParams{ID: sourceID, TenantID: tenantID})
	if err != nil {
		return summary, http.StatusInternalServerError, fmt.Errorf("load source: %w", err).Error()
	}
	writesToBins := source.EntityKind == db.DataSourceEntityKindRackCell

	tx, err := pool.Begin(ctx)
	if err != nil {
		return summary, http.StatusInternalServerError, err.Error()
	}
	defer tx.Rollback(ctx)
	qtx := q.WithTx(tx)

	// Per-row SAVEPOINT so one bad row doesn't abort the whole tx
	// (SQLSTATE 25P02). Each row gets a nested subtransaction; a failure
	// rolls back that row only and the loop continues.
	for i, raw := range rows {
		spName := fmt.Sprintf("row_%d", i)
		if _, spErr := tx.Exec(ctx, "SAVEPOINT "+spName); spErr != nil {
			summary.RowsErrored++
			summary.Errors = append(summary.Errors, spErr.Error())
			break
		}
		resolved, _ := resolveRow(raw, plan, tenantID, grids, shapes, qtx, ctx)
		var writeErr error
		if writesToBins {
			// Rack path — unchanged from v2.
			patch, _ := buildPatch(raw, plan, resolved, knownKeys, nil)
			imported, reason, err := writeOne(ctx, qtx, tenantID, sourceID, resolved, patch)
			writeErr = err
			summarizeWrite(&summary, resolved, imported, reason, err)
		} else {
			// v3 path — write to data_source_rows.
			imported, reason, err := writeOneRow(ctx, qtx, tenantID, sourceID, raw, plan, resolved)
			writeErr = err
			summarizeWrite(&summary, resolved, imported, reason, err)
		}
		if writeErr != nil {
			_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+spName)
		} else {
			_, _ = tx.Exec(ctx, "RELEASE SAVEPOINT "+spName)
		}
	}

	status := "ok"
	if summary.RowsErrored > 0 && summary.RowsImported > 0 {
		status = "partial"
	} else if summary.RowsErrored > 0 && summary.RowsImported == 0 {
		status = "error"
	}

	statsJSON, _ := json.Marshal(map[string]int{
		"rowsRead":     summary.RowsRead,
		"rowsMatched":  summary.RowsMatched,
		"rowsImported": summary.RowsImported,
		"rowsSkipped":  summary.RowsSkipped,
		"rowsErrored":  summary.RowsErrored,
	})
	_, err = qtx.CreateImportJob(ctx, db.CreateImportJobParams{
		TenantID:    tenantID,
		SourceID:    sourceID,
		StartedAt:   pgtype.Timestamptz{Time: now(), Valid: true},
		FinishedAt:  pgtype.Timestamptz{Time: now(), Valid: true},
		Status:      db.ImportJobStatus(status),
		Stats:       statsJSON,
		ErrorReport: pgtype.Text{String: strings.Join(summary.Errors, "\n"), Valid: len(summary.Errors) > 0},
	})
	if err != nil {
		return summary, http.StatusInternalServerError, err.Error()
	}

	if err := tx.Commit(ctx); err != nil {
		return summary, http.StatusInternalServerError, err.Error()
	}

	if persistBytes {
		if persistErr := persistSourceFile(ctx, q, tenantID, sourceID, filename, plan, fileBytes); persistErr != nil {
			fmt.Printf("[executeImport] warning: could not persist source file bytes for source %d: %v\n", sourceID, persistErr)
		}
	}

	return summary, 0, ""
}

// persistSourceFile upserts the original file bytes into source_files so
// the integrations page can offer a "Re-import" button. Idempotent —
// re-uploading the same source's file replaces the previous bytes.
func persistSourceFile(ctx context.Context, q *db.Queries, tenantID, sourceID int64, filename string, plan ImportPlan, fileBytes []byte) error {
	sum := sha256.Sum256(fileBytes)
	sheetName := pgtype.Text{String: plan.SheetName, Valid: plan.SheetName != ""}
	jsonRootPath := pgtype.Text{String: plan.JsonRootPath, Valid: plan.JsonRootPath != ""}
	_, err := q.UpsertSourceFile(ctx, db.UpsertSourceFileParams{
		TenantID:      tenantID,
		SourceID:      sourceID,
		Filename:      filename,
		SourceKind:    plan.SourceKind,
		SheetName:     sheetName,
		JsonRootPath:  jsonRootPath,
		Bytes:         fileBytes,
		BytesSize:     int32(len(fileBytes)),
		ContentSha256: hex.EncodeToString(sum[:]),
	})
	return err
}

// reimportFileSource loads the previously-stored file bytes for a
// file-backed data source and re-runs the import pipeline with the
// saved field mapping. Exposed at POST /data-sources/{id}/reimport.
//
// Returns 400 if the source isn't file-backed (rest / webhook sources
// have their own rerun path), 404 if no stored file exists for the
// source, 200 with the import summary on success.
func reimportFileSource(w http.ResponseWriter, r *http.Request, q *db.Queries, pool *pgxpool.Pool) {
	id, err := api.IDParam(r, "id")
	if err != nil {
		api.BadRequest(w, err.Error())
		return
	}
	tenantID := api.TenantID(r.Context())

	source, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{ID: id, TenantID: tenantID})
	if err != nil {
		api.NotFound(w, "data source not found")
		return
	}
	if source.Kind == db.DataSourceKindRest || source.Kind == db.DataSourceKindWebhook {
		api.BadRequest(w, "only file-backed sources can be re-imported via this endpoint — use the source's rerun action instead")
		return
	}

	stored, err := q.GetSourceFileBySource(r.Context(), db.GetSourceFileBySourceParams{SourceID: id, TenantID: tenantID})
	if err != nil {
		api.NotFound(w, "no stored file for this source — re-upload from the import wizard to enable re-import")
		return
	}

	plan, perr := planFromStoredMapping(source, stored)
	if perr != nil {
		api.BadRequest(w, perr.Error())
		return
	}

	summary, status, errMsg := executeImport(r.Context(), q, pool, tenantID, id, plan, stored.Bytes, stored.Filename, false)
	if errMsg != "" {
		if status == http.StatusBadRequest {
			api.BadRequest(w, errMsg)
		} else {
			api.Error(w, status, errMsg)
		}
		return
	}

	BroadcastEntityEvent("ENTITY_UPDATED", "bins", 0, tenantID)
	api.JSON(w, http.StatusOK, summary)
}

// planFromStoredMapping rebuilds an ImportPlan from the wire-format
// mapping stored on the data source row plus the file metadata saved
// in source_files. Mirrors the frontend's `planFromMapping` (rerun.ts)
// — the wire format uses prefixed strings (`match.externalCode`,
// `bin.sku`, `prop.batch`) that we convert back to the typed
// MatchStrategy + FieldTarget shape the resolver expects.
func planFromStoredMapping(source db.DataSource, stored db.SourceFile) (ImportPlan, error) {
	var wire struct {
		Fields map[string]string `json:"fields"`
		ZoneID *int64            `json:"zoneId"`
	}
	if err := json.Unmarshal(source.Mapping, &wire); err != nil {
		return ImportPlan{}, fmt.Errorf("decode saved mapping: %w", err)
	}

	sheetName := ""
	if stored.SheetName.Valid {
		sheetName = stored.SheetName.String
	}
	jsonRootPath := ""
	if stored.JsonRootPath.Valid {
		jsonRootPath = stored.JsonRootPath.String
	}
	plan := ImportPlan{
		SourceKind:           stored.SourceKind,
		SheetName:            sheetName,
		JsonRootPath:         jsonRootPath,
		ZoneID:               wire.ZoneID,
		AutoDefineAttributes: false,
		FieldMapping:         map[string]FieldTarget{},
	}

	// Default to json for the column source kind since the wire format
	// is generic — the parser picks csv/xlsx/json off the SourceKind
	// field; the file source's kind tells us which.
	if plan.SourceKind == "" {
		plan.SourceKind = string(source.Kind)
	}

	match := MatchStrategy{}
	matchSet := false
	for column, target := range wire.Fields {
		switch {
		case target == "match.externalCode":
			match.Mode = "externalCode"
			match.Column = column
			matchSet = true
		case target == "match.binLabel":
			match.Mode = "binLabel"
			match.Column = column
			matchSet = true
		case strings.HasPrefix(target, "match.shapeName:"):
			match.Mode = "shapeName"
			match.ShapeNameColumn = column
			match.ShapeKind = strings.TrimPrefix(target, "match.shapeName:")
			matchSet = true
		case strings.HasPrefix(target, "match.gridCell:"):
			match.Mode = "gridCellAddress"
			match.GridColumn = column
			match.GridColumnIs = strings.TrimPrefix(target, "match.gridCell:")
			matchSet = true
		case target == "match.gridCell.row":
			match.RowColumn = column
		case target == "match.gridCell.col":
			match.ColColumn = column
		case target == "match.gridCell.level":
			match.LevelColumn = column
		case strings.HasPrefix(target, "bin."):
			plan.FieldMapping[column] = FieldTarget{Kind: "builtin", Field: strings.TrimPrefix(target, "bin.")}
		case strings.HasPrefix(target, "prop."):
			plan.FieldMapping[column] = FieldTarget{Kind: "custom", Key: strings.TrimPrefix(target, "prop.")}
		default:
			plan.FieldMapping[column] = FieldTarget{Kind: "ignore"}
		}
	}

	if !matchSet {
		return ImportPlan{}, fmt.Errorf("saved mapping has no match column — can't re-run automatically")
	}
	plan.Match = match

	// Columns is informational — the parser doesn't use it. Mirror the
	// frontend behaviour by stashing the mapping keys.
	plan.Columns = make([]string, 0, len(wire.Fields))
	for col := range wire.Fields {
		plan.Columns = append(plan.Columns, col)
	}
	return plan, nil
}

// --------------- file parsing ---------------

func parseImportFile(r io.Reader, filename, kind, sheetName, jsonRootPath string) (columns []string, rows []map[string]string, errors []string, err error) {
	switch kind {
	case "csv":
		return parseCsvImport(r)
	case "xlsx":
		return parseXlsxImport(r, sheetName)
	case "json":
		return parseJsonImport(r, jsonRootPath)
	default:
		return nil, nil, nil, fmt.Errorf("unsupported import kind: %s", kind)
	}
}

func parseCsvImport(r io.Reader) (columns []string, rows []map[string]string, errors []string, err error) {
	reader := csv.NewReader(r)
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1
	reader.ReuseRecord = false
	allRows, err := reader.ReadAll()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("csv parse: %w", err)
	}
	if len(allRows) == 0 {
		return nil, nil, nil, fmt.Errorf("csv file is empty")
	}
	columns = make([]string, 0, len(allRows[0]))
	for _, c := range allRows[0] {
		columns = append(columns, strings.TrimSpace(c))
	}
	for i := 1; i < len(allRows); i++ {
		row := map[string]string{}
		hasValue := false
		for j, c := range columns {
			v := ""
			if j < len(allRows[i]) {
				v = strings.TrimSpace(allRows[i][j])
			}
			row[c] = v
			if v != "" {
				hasValue = true
			}
		}
		if hasValue {
			rows = append(rows, row)
		}
	}
	return columns, rows, nil, nil
}

func parseXlsxImport(r io.Reader, sheetName string) (columns []string, rows []map[string]string, errors []string, err error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read xlsx: %w", err)
	}
	f, err := excelize.OpenReader(strings.NewReader(string(data)), excelize.Options{})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("xlsx open: %w", err)
	}
	defer f.Close()

	name := sheetName
	if name == "" {
		for _, s := range f.GetSheetList() {
			if ref, _ := f.GetCellValue(s, "A1"); ref != "" || hasAnyCell(f, s) {
				name = s
				break
			}
		}
	}
	if name == "" {
		return nil, nil, nil, fmt.Errorf("no sheet found")
	}

	allRows, err := f.GetRows(name, excelize.Options{RawCellValue: false})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("xlsx read sheet: %w", err)
	}
	if len(allRows) == 0 {
		return nil, nil, nil, fmt.Errorf("xlsx sheet is empty")
	}
	columns = make([]string, 0, len(allRows[0]))
	for _, c := range allRows[0] {
		trimmed := strings.TrimSpace(c)
		if trimmed != "" {
			columns = append(columns, trimmed)
		}
	}
	if len(columns) == 0 {
		return nil, nil, nil, fmt.Errorf("xlsx sheet has no header row")
	}
	for i := 1; i < len(allRows); i++ {
		row := map[string]string{}
		hasValue := false
		for j, c := range columns {
			v := ""
			if j < len(allRows[i]) {
				v = strings.TrimSpace(allRows[i][j])
			}
			row[c] = v
			if v != "" {
				hasValue = true
			}
		}
		if hasValue {
			rows = append(rows, row)
		}
	}
	return columns, rows, nil, nil
}

func hasAnyCell(f *excelize.File, sheet string) bool {
	rows, _ := f.GetRows(sheet, excelize.Options{})
	for _, row := range rows {
		for _, cell := range row {
			if strings.TrimSpace(cell) != "" {
				return true
			}
		}
	}
	return false
}

func parseJsonImport(r io.Reader, rootPath string) (columns []string, rows []map[string]string, errors []string, err error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read json: %w", err)
	}
	var payload any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, nil, nil, fmt.Errorf("json parse: %w", err)
	}
	arr, found := pickRowArray(payload, rootPath)
	if !found {
		return nil, nil, nil, fmt.Errorf("no array of objects found at root path %q", rootPath)
	}
	seen := map[string]struct{}{}
	flatRows := make([]map[string]string, 0, len(arr))
	for _, obj := range arr {
		flat := flattenRow(obj)
		for k := range flat {
			if _, ok := seen[k]; !ok {
				seen[k] = struct{}{}
				columns = append(columns, k)
			}
		}
		flatRows = append(flatRows, flat)
	}
	for _, flat := range flatRows {
		dense := map[string]string{}
		for _, c := range columns {
			if v, ok := flat[c]; ok {
				dense[c] = v
			} else {
				dense[c] = ""
			}
		}
		rows = append(rows, dense)
	}
	return columns, rows, nil, nil
}

func pickRowArray(payload any, rootPath string) ([]map[string]any, bool) {
	if rootPath != "" {
		node := followPath(payload, rootPath)
		return asArrayOfObjects(node)
	}
	if arr, ok := asArrayOfObjects(payload); ok {
		return arr, true
	}
	if m, ok := payload.(map[string]any); ok {
		for _, k := range []string{"data", "items", "results", "rows", "records", "bins", "payload", "response", "list", "entries"} {
			if arr, ok := asArrayOfObjects(m[k]); ok {
				return arr, true
			}
		}
		type entry struct {
			node  any
			depth int
		}
		queue := []entry{{node: payload, depth: 0}}
		for len(queue) > 0 {
			e := queue[0]
			queue = queue[1:]
			if e.depth > 6 {
				continue
			}
			if m2, ok := e.node.(map[string]any); ok {
				for _, v := range m2 {
					if arr, ok := asArrayOfObjects(v); ok {
						return arr, true
					}
					queue = append(queue, entry{node: v, depth: e.depth + 1})
				}
			}
		}
	}
	return nil, false
}

func followPath(payload any, path string) any {
	if path == "" {
		return payload
	}
	cur := payload
	for _, seg := range strings.Split(path, ".") {
		if cur == nil {
			return nil
		}
		switch v := cur.(type) {
		case map[string]any:
			cur = v[seg]
		case []any:
			idx, err := strconv.Atoi(seg)
			if err != nil || idx < 0 || idx >= len(v) {
				return nil
			}
			cur = v[idx]
		default:
			return nil
		}
	}
	return cur
}

func asArrayOfObjects(v any) ([]map[string]any, bool) {
	arr, ok := v.([]any)
	if !ok || len(arr) == 0 {
		return nil, false
	}
	out := make([]map[string]any, 0, len(arr))
	for _, item := range arr {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

func flattenRow(row map[string]any) map[string]string {
	out := map[string]string{}
	for key, value := range row {
		if value == nil {
			out[key] = ""
			continue
		}
		switch v := value.(type) {
		case string:
			out[key] = strings.TrimSpace(v)
		case float64:
			out[key] = strconv.FormatFloat(v, 'f', -1, 64)
		case bool:
			out[key] = strconv.FormatBool(v)
		case map[string]any:
			for k2, v2 := range v {
				flatKey := key + "." + k2
				if v2 == nil {
					out[flatKey] = ""
				} else if _, isObj := v2.(map[string]any); isObj || isArray(v2) {
					b, _ := json.Marshal(v2)
					out[flatKey] = string(b)
				} else {
					out[flatKey] = fmt.Sprintf("%v", v2)
				}
			}
		case []any:
			b, _ := json.Marshal(v)
			out[key] = string(b)
		default:
			out[key] = fmt.Sprintf("%v", value)
		}
	}
	return out
}

func isArray(v any) bool {
	_, ok := v.([]any)
	return ok
}

// --------------- resolution ---------------

type catalogGrid struct {
	ID         int64
	TenantID   int64
	Name       string
	StartLng   float64
	StartLat   float64
	CurrentLng float64
	CurrentLat float64
	Config     json.RawMessage
	ZoneID     pgtype.Int8
}

type catalogShape struct {
	ID       int64
	TenantID int64
	Kind     string
	Name     string
	ZoneID   pgtype.Int8
}

func loadCatalogForResolve(ctx context.Context, q *db.Queries, tenantID int64) ([]catalogGrid, []catalogShape, error) {
	grids, err := q.ListGrids(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	cg := make([]catalogGrid, len(grids))
	for i, g := range grids {
		cg[i] = catalogGrid{
			ID:         g.ID,
			TenantID:   g.TenantID,
			Name:       g.Name,
			StartLng:   g.StartLng,
			StartLat:   g.StartLat,
			CurrentLng: g.CurrentLng,
			CurrentLat: g.CurrentLat,
			Config:     g.Config,
			ZoneID:     g.ZoneID,
		}
	}

	shapes := []catalogShape{}
	polygons, err := q.ListPolygons(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	for _, s := range polygons {
		shapes = append(shapes, catalogShape{ID: s.ID, TenantID: s.TenantID, Kind: "polygon", Name: s.Name, ZoneID: s.ZoneID})
	}
	circles, err := q.ListCircles(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	for _, s := range circles {
		shapes = append(shapes, catalogShape{ID: s.ID, TenantID: s.TenantID, Kind: "circle", Name: s.Name, ZoneID: s.ZoneID})
	}
	lines, err := q.ListLines(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	for _, s := range lines {
		shapes = append(shapes, catalogShape{ID: s.ID, TenantID: s.TenantID, Kind: "line", Name: s.Name, ZoneID: s.ZoneID})
	}
	markers, err := q.ListMarkers(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	for _, s := range markers {
		shapes = append(shapes, catalogShape{ID: s.ID, TenantID: s.TenantID, Kind: "marker", Name: s.Name, ZoneID: s.ZoneID})
	}
	images, err := q.ListImages(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	for _, s := range images {
		shapes = append(shapes, catalogShape{ID: s.ID, TenantID: s.TenantID, Kind: "image", Name: s.Name, ZoneID: s.ZoneID})
	}
	models, err := q.ListModels(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	for _, s := range models {
		shapes = append(shapes, catalogShape{ID: s.ID, TenantID: s.TenantID, Kind: "model", Name: s.Name, ZoneID: s.ZoneID})
	}

	return cg, shapes, nil
}

func resolveRow(raw map[string]string, plan ImportPlan, tenantID int64, grids []catalogGrid, shapes []catalogShape, q *db.Queries, ctx context.Context) (ResolvedTarget, string) {
	switch plan.Match.Mode {
	case "externalCode":
		return resolveByExternalCode(ctx, q, tenantID, raw, plan.Match.Column, plan.ZoneID)
	case "gridCellAddress":
		return resolveByGridCellAddress(raw, plan.Match, plan.ZoneID, grids)
	case "shapeName":
		return resolveByShapeName(raw, plan.Match, plan.ZoneID, shapes)
	case "binLabel":
		return resolveByBinLabel(raw, plan.Match, plan.ZoneID, grids)
	}
	return ResolvedTarget{Status: "unmatched"}, "unknown match mode"
}

func resolveByExternalCode(ctx context.Context, q *db.Queries, tenantID int64, raw map[string]string, column string, zoneID *int64) (ResolvedTarget, string) {
	code := strings.TrimSpace(raw[column])
	if code == "" {
		return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("empty externalCode in column %q", column)
	}
	bin, err := q.GetBinByExternalCode(ctx, db.GetBinByExternalCodeParams{
		TenantID:     tenantID,
		ExternalCode: pgtype.Text{String: code, Valid: true},
	})
	if err != nil && err != pgx.ErrNoRows {
		return ResolvedTarget{Status: "unmatched"}, err.Error()
	}
	if err == pgx.ErrNoRows {
		return ResolvedTarget{Status: "will-create", ExternalCode: code}, ""
	}
	if bin.TargetKind == db.BindingKindGridCell && bin.GridID.Valid && bin.Row.Valid && bin.Col.Valid {
		return ResolvedTarget{
			Status:     "matched-grid",
			GridID:     bin.GridID.Int64,
			Row:        bin.Row.Int32,
			Col:        bin.Col.Int32,
			Level:      bin.Level.Int32,
			ExistingID: bin.ID,
		}, ""
	}
	if bin.TargetKind != db.BindingKindGridCell && bin.ShapeID.Valid {
		return ResolvedTarget{
			Status:     "matched-shape",
			TargetKind: string(bin.TargetKind),
			ShapeID:    bin.ShapeID.Int64,
			ExistingID: bin.ID,
		}, ""
	}
	return ResolvedTarget{Status: "will-create", ExternalCode: code, ExistingID: bin.ID}, ""
}

func resolveByGridCellAddress(raw map[string]string, spec MatchStrategy, zoneID *int64, grids []catalogGrid) (ResolvedTarget, string) {
	gridRef := strings.TrimSpace(raw[spec.GridColumn])
	if gridRef == "" {
		return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("empty grid identifier in column %q", spec.GridColumn)
	}
	var grid *catalogGrid
	if spec.GridColumnIs == "id" {
		id, err := strconv.ParseInt(gridRef, 10, 64)
		if err != nil || id <= 0 {
			return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("invalid numeric gridId %q", gridRef)
		}
		for i := range grids {
			if grids[i].ID == id {
				grid = &grids[i]
				break
			}
		}
	} else {
		var candidates []*catalogGrid
		for i := range grids {
			if grids[i].Name == gridRef {
				candidates = append(candidates, &grids[i])
			}
		}
		if zoneID != nil {
			for _, c := range candidates {
				if c.ZoneID.Valid && c.ZoneID.Int64 == *zoneID {
					grid = c
					break
				}
			}
		} else if len(candidates) > 0 {
			grid = candidates[0]
		}
	}
	if grid == nil {
		return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("no grid %q", gridRef)
	}
	if zoneID != nil && (!grid.ZoneID.Valid || grid.ZoneID.Int64 != *zoneID) {
		return ResolvedTarget{Status: "unmatched"}, "grid belongs to a different zone"
	}
	rowIdx, err := toNonNegInt(raw[spec.RowColumn])
	if err != nil {
		return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("invalid row %q", raw[spec.RowColumn])
	}
	colIdx, err := toNonNegInt(raw[spec.ColColumn])
	if err != nil {
		return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("invalid col %q", raw[spec.ColColumn])
	}
	level := int32(0)
	if spec.LevelColumn != "" {
		l, err := toNonNegInt(raw[spec.LevelColumn])
		if err != nil {
			return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("invalid level %q", raw[spec.LevelColumn])
		}
		level = l
	}
	return ResolvedTarget{
		Status: "matched-grid",
		GridID: grid.ID,
		Row:    rowIdx,
		Col:    colIdx,
		Level:  level,
	}, ""
}

func resolveByShapeName(raw map[string]string, spec MatchStrategy, zoneID *int64, shapes []catalogShape) (ResolvedTarget, string) {
	name := strings.TrimSpace(raw[spec.ShapeNameColumn])
	if name == "" {
		return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("empty shape name in column %q", spec.ShapeNameColumn)
	}
	var found *catalogShape
	for i := range shapes {
		if shapes[i].Kind == spec.ShapeKind && shapes[i].Name == name {
			if zoneID == nil || (shapes[i].ZoneID.Valid && shapes[i].ZoneID.Int64 == *zoneID) {
				found = &shapes[i]
				break
			}
		}
	}
	if found == nil {
		return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("no %s named %q", spec.ShapeKind, name)
	}
	return ResolvedTarget{
		Status:     "matched-shape",
		TargetKind: spec.ShapeKind,
		ShapeID:    found.ID,
	}, ""
}

func resolveByBinLabel(raw map[string]string, spec MatchStrategy, zoneID *int64, grids []catalogGrid) (ResolvedTarget, string) {
	label := strings.TrimSpace(raw[spec.Column])
	if label == "" {
		return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("empty bin label in column %q", spec.Column)
	}
	parsed := parseLabelString(label)
	if parsed == nil {
		return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("couldn't parse bin label %q", label)
	}
	for _, grid := range grids {
		cfg := gridConfig(grid.Config)
		if cfg.LabelPrefix != parsed.Prefix {
			continue
		}
		if zoneID != nil && (!grid.ZoneID.Valid || grid.ZoneID.Int64 != *zoneID) {
			continue
		}
		dims := estimateGridDimensions(grid.StartLng, grid.StartLat, grid.CurrentLng, grid.CurrentLat, cfg)
		if dims == nil {
			continue
		}
		addr := cellAddressFromLabel(parsed, cfg, dims.Rows, dims.Cols)
		if addr == nil {
			continue
		}
		return ResolvedTarget{
			Status: "matched-grid",
			GridID: grid.ID,
			Row:    addr.Row,
			Col:    addr.Col,
			Level:  addr.Level,
		}, ""
	}
	return ResolvedTarget{Status: "unmatched"}, fmt.Sprintf("no rack matches label %q", label)
}

func toNonNegInt(s string) (int32, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 || n > math.MaxInt32 {
		return 0, fmt.Errorf("invalid")
	}
	return int32(n), nil
}

// --------------- patch construction ---------------

func buildPatch(raw map[string]string, plan ImportPlan, resolved ResolvedTarget, knownKeys map[string]struct{}, unknown map[string]struct{}) (map[string]any, []string) {
	warnings := []string{}
	patch := map[string]any{}
	custom := map[string]any{}
	customDirty := false

	for column, target := range plan.FieldMapping {
		value := raw[column]
		if value == "" {
			continue
		}
		applyOne(patch, custom, column, value, target, &warnings)
		if target.Kind == "custom" {
			customDirty = true
			if unknown != nil && !known(target.Key, knownKeys) {
				unknown[target.Key] = struct{}{}
			}
		}
	}

	if resolved.Status == "will-create" && plan.Match.Mode == "externalCode" {
		patch["externalCode"] = resolved.ExternalCode
	}

	if customDirty {
		patch["customProperties"] = custom
	}
	return patch, warnings
}

func applyOne(patch map[string]any, custom map[string]any, column, value string, target FieldTarget, warnings *[]string) {
	switch target.Kind {
	case "ignore":
		return
	case "builtin":
		switch target.Field {
		case "externalCode":
			patch["externalCode"] = value
		case "sku":
			patch["sku"] = value
		case "notes":
			patch["notes"] = value
		case "capacity":
			n, err := strconv.ParseFloat(value, 64)
			if err != nil {
				*warnings = append(*warnings, fmt.Sprintf("Column %q: %q is not a number, capacity skipped", column, value))
				return
			}
			patch["capacity"] = n
		case "status":
			s := coerceBinStatus(value)
			if s == "" {
				*warnings = append(*warnings, fmt.Sprintf("Column %q: %q is not a valid status (empty/occupied/reserved)", column, value))
				return
			}
			patch["status"] = s
		}
	case "custom":
		custom[target.Key] = recoverNative(value)
	}
}

func coerceBinStatus(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "empty":
		return "empty"
	case "occupied":
		return "occupied"
	case "reserved":
		return "reserved"
	}
	return ""
}

func recoverNative(raw string) any {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) == 0 {
		return raw
	}
	first := trimmed[0]
	if first != '{' && first != '[' {
		return raw
	}
	var parsed any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return raw
	}
	if parsed != nil && reflectKind(parsed) == "object" {
		return parsed
	}
	return raw
}

func reflectKind(v any) string {
	if _, ok := v.(map[string]any); ok {
		return "object"
	}
	if _, ok := v.([]any); ok {
		return "array"
	}
	return "primitive"
}

func known(key string, knownKeys map[string]struct{}) bool {
	_, ok := knownKeys[key]
	return ok
}

// --------------- bin writes ---------------

// summarizeWrite folds a single-row write result into the running
// import summary. Shared between the legacy bin path and the v3
// data_source_rows path.
func summarizeWrite(summary *ImportCommitResponse, resolved ResolvedTarget, imported bool, reason string, err error) {
	if err != nil {
		summary.RowsErrored++
		summary.Errors = append(summary.Errors, err.Error())
		return
	}
	if imported {
		summary.RowsImported++
		if resolved.Status == "matched-grid" || resolved.Status == "matched-shape" {
			summary.RowsMatched++
		}
	} else {
		summary.RowsSkipped++
		if reason != "" {
			summary.Errors = append(summary.Errors, reason)
		}
	}
}

// writeOneRow — v3 write path for non-rack sources. See
// DESIGN-integrations-v3.md §4.1.
//
// Every row lands in data_source_rows regardless of whether the plan's
// match strategy found a shape. Sub-renderers (Slice 6) use their own
// resolver against the row payload. `resolved` is only used to
// populate `RowsMatched` in the summary so users still see how many
// rows had a preexisting shape target.
func writeOneRow(
	ctx context.Context,
	q *db.Queries,
	tenantID, sourceID int64,
	raw map[string]string,
	plan ImportPlan,
	resolved ResolvedTarget,
) (bool, string, error) {
	entityKey := rowEntityKey(raw, plan)
	if entityKey == "" {
		return false, "row has no external_code / match key — skipped", nil
	}

	// The payload is the raw row unmodified — un-slugged keys so the
	// SPA can attribute-join on natural user-facing column names.
	payloadObj := make(map[string]any, len(raw))
	for k, v := range raw {
		payloadObj[k] = v
	}
	payloadJSON, err := json.Marshal(payloadObj)
	if err != nil {
		return false, "", fmt.Errorf("marshal payload: %w", err)
	}

	// Position — pull from any of the common coord field names. We do
	// this here so the resolver's coord match mode has a fast index
	// (position column) rather than JSON scanning on every read.
	var positionWKT string
	if lng, lat, ok := rowCoord(raw); ok {
		positionWKT = fmt.Sprintf("POINT(%g %g)", lng, lat)
	}

	// linked_shape_name — surface it as its own column for attribute
	// joins that fan out to many polygons (the hot path for v2 match).
	linked := pgtype.Text{}
	if v, ok := raw["linked_shape_name"]; ok && v != "" {
		linked = pgtype.Text{String: v, Valid: true}
	}

	_, err = q.UpsertDataSourceRow(ctx, db.UpsertDataSourceRowParams{
		TenantID:        tenantID,
		SourceID:        sourceID,
		EntityKey:       entityKey,
		Payload:         payloadJSON,
		PositionWkt:     positionWKT,
		LinkedShapeName: linked,
		Ts:              pgtype.Timestamptz{Time: now(), Valid: true},
	})
	if err != nil {
		return false, "", err
	}
	return true, "", nil
}

// rowEntityKey extracts the row's identifier from the plan's match spec.
// external_code / shapeName both use `plan.Match.Column`. Grid modes are
// rack-only so they never hit this path.
//
// When the plan-driven lookup returns an empty value (e.g. the REST
// scheduler auto-created the source with no saved mapping), we fall
// through to well-known column names. This keeps the v3 flow ("Run now"
// on a fresh REST source with no mapping) working without forcing the
// user to open the file wizard first.
func rowEntityKey(raw map[string]string, plan ImportPlan) string {
	planPick := ""
	switch plan.Match.Mode {
	case "externalCode", "shapeName":
		planPick = raw[plan.Match.Column]
	case "binLabel", "gridCellAddress":
		// Not applicable to the v3 row path — rack-only.
		return ""
	}
	if planPick != "" {
		return planPick
	}
	// Fallback: try well-known keys so a source with no saved mapping
	// still produces sensible entity keys.
	for _, k := range []string{"external_code", "externalCode", "id", "name"} {
		if v, ok := raw[k]; ok && v != "" {
			return v
		}
	}
	return ""
}

// rowCoord finds lng/lat in a raw row using the common column names
// publishers emit. Returns (0, 0, false) when neither is parseable.
func rowCoord(raw map[string]string) (float64, float64, bool) {
	getNum := func(keys ...string) (float64, bool) {
		for _, k := range keys {
			if v, ok := raw[k]; ok && v != "" {
				if f, err := strconv.ParseFloat(v, 64); err == nil {
					return f, true
				}
			}
		}
		return 0, false
	}
	lng, okLng := getNum("lng", "longitude", "long", "x")
	lat, okLat := getNum("lat", "latitude", "y")
	if !okLng || !okLat {
		return 0, 0, false
	}
	return lng, lat, true
}

func writeOne(ctx context.Context, q *db.Queries, tenantID, sourceID int64, resolved ResolvedTarget, patch map[string]any) (bool, string, error) {
	switch resolved.Status {
	case "unmatched":
		return false, "", nil
	case "matched-grid":
		existing, err := q.GetBinByGridCell(ctx, db.GetBinByGridCellParams{
			TenantID: tenantID,
			GridID:   pgtype.Int8{Int64: resolved.GridID, Valid: true},
			Row:      pgtype.Int4{Int32: resolved.Row, Valid: true},
			Col:      pgtype.Int4{Int32: resolved.Col, Valid: true},
			Level:    pgtype.Int4{Int32: resolved.Level, Valid: true},
		})
		p := binRequestFromPatch(patch, tenantID)
		p.SyncSource = pgtype.Int8{Int64: sourceID, Valid: true}
		if err != nil && err != pgx.ErrNoRows {
			return false, "", err
		}
		if err == pgx.ErrNoRows {
			p.TargetKind = db.BindingKindGridCell
			p.GridID = pgtype.Int8{Int64: resolved.GridID, Valid: true}
			p.Row = pgtype.Int4{Int32: resolved.Row, Valid: true}
			p.Col = pgtype.Int4{Int32: resolved.Col, Valid: true}
			p.Level = pgtype.Int4{Int32: resolved.Level, Valid: true}
			if !p.Status.Valid {
				p.Status = db.NullBinStatus{BinStatus: db.BinStatusEmpty, Valid: true}
			}
			_, err = q.CreateBin(ctx, p)
			return err == nil, "", err
		}
		_, err = q.UpdateBin(ctx, db.UpdateBinParams{
			ID:               existing.ID,
			TenantID:         tenantID,
			TargetKind:       existing.TargetKind,
			GridID:           existing.GridID,
			Row:              existing.Row,
			Col:              existing.Col,
			Level:            existing.Level,
			ShapeID:          existing.ShapeID,
			Status:           p.Status,
			Sku:              p.Sku,
			Capacity:         p.Capacity,
			Notes:            p.Notes,
			ExternalCode:     p.ExternalCode,
			CustomProperties: p.CustomProperties,
			SyncSource:       p.SyncSource,
			FloorPlanID:      existing.FloorPlanID,
		})
		return err == nil, "", err
	case "matched-shape":
		existing, err := q.GetBinByShape(ctx, db.GetBinByShapeParams{
			TenantID:   tenantID,
			TargetKind: db.BindingKind(resolved.TargetKind),
			ShapeID:    pgtype.Int8{Int64: resolved.ShapeID, Valid: true},
		})
		p := binRequestFromPatch(patch, tenantID)
		p.SyncSource = pgtype.Int8{Int64: sourceID, Valid: true}
		if err != nil && err != pgx.ErrNoRows {
			return false, "", err
		}
		if err == pgx.ErrNoRows {
			p.TargetKind = db.BindingKind(resolved.TargetKind)
			p.ShapeID = pgtype.Int8{Int64: resolved.ShapeID, Valid: true}
			if !p.Status.Valid {
				p.Status = db.NullBinStatus{BinStatus: db.BinStatusEmpty, Valid: true}
			}
			_, err = q.CreateBin(ctx, p)
			return err == nil, "", err
		}
		_, err = q.UpdateBin(ctx, db.UpdateBinParams{
			ID:               existing.ID,
			TenantID:         tenantID,
			TargetKind:       existing.TargetKind,
			GridID:           existing.GridID,
			Row:              existing.Row,
			Col:              existing.Col,
			Level:            existing.Level,
			ShapeID:          existing.ShapeID,
			Status:           p.Status,
			Sku:              p.Sku,
			Capacity:         p.Capacity,
			Notes:            p.Notes,
			ExternalCode:     p.ExternalCode,
			CustomProperties: p.CustomProperties,
			SyncSource:       p.SyncSource,
			FloorPlanID:      existing.FloorPlanID,
		})
		return err == nil, "", err
	case "will-create":
		p := binRequestFromPatch(patch, tenantID)
		p.ExternalCode = pgtype.Text{String: resolved.ExternalCode, Valid: resolved.ExternalCode != ""}
		p.SyncSource = pgtype.Int8{Int64: sourceID, Valid: true}
		if resolved.ExistingID > 0 {
			existing, err := q.GetBin(ctx, db.GetBinParams{ID: resolved.ExistingID, TenantID: tenantID})
			if err != nil {
				return false, "", err
			}
			_, err = q.UpdateBin(ctx, db.UpdateBinParams{
				ID:               existing.ID,
				TenantID:         tenantID,
				TargetKind:       existing.TargetKind,
				GridID:           existing.GridID,
				Row:              existing.Row,
				Col:              existing.Col,
				Level:            existing.Level,
				ShapeID:          existing.ShapeID,
				Status:           p.Status,
				Sku:              p.Sku,
				Capacity:         p.Capacity,
				Notes:            p.Notes,
				ExternalCode:     p.ExternalCode,
				CustomProperties: p.CustomProperties,
				SyncSource:       p.SyncSource,
				FloorPlanID:      existing.FloorPlanID,
			})
			return err == nil, "", err
		}
		p.TargetKind = db.BindingKindGridCell
		if !p.Status.Valid {
			p.Status = db.NullBinStatus{BinStatus: db.BinStatusEmpty, Valid: true}
		}
		_, err := q.CreateBin(ctx, p)
		return err == nil, "", err
	}
	return false, "", nil
}

func binRequestFromPatch(patch map[string]any, tenantID int64) db.CreateBinParams {
	p := db.CreateBinParams{TenantID: tenantID}
	if v, ok := patch["sku"].(string); ok && v != "" {
		p.Sku = pgtype.Text{String: v, Valid: true}
	}
	if v, ok := patch["notes"].(string); ok && v != "" {
		p.Notes = pgtype.Text{String: v, Valid: true}
	}
	if v, ok := patch["externalCode"].(string); ok && v != "" {
		p.ExternalCode = pgtype.Text{String: v, Valid: true}
	}
	if v, ok := patch["capacity"].(float64); ok {
		p.Capacity = pgtype.Float8{Float64: v, Valid: true}
	}
	if v, ok := patch["status"].(string); ok && v != "" {
		p.Status = db.NullBinStatus{BinStatus: db.BinStatus(v), Valid: true}
	}
	if v, ok := patch["customProperties"]; ok {
		b, _ := json.Marshal(v)
		if len(b) == 0 {
			b = []byte("{}")
		}
		p.CustomProperties = b
	} else {
		p.CustomProperties = json.RawMessage("{}")
	}
	return p
}

// --------------- helpers ---------------

func loadKnownAttributeKeys(ctx context.Context, q *db.Queries, tenantID int64, zoneID *int64) (map[string]struct{}, error) {
	var z pgtype.Int8
	if zoneID != nil && *zoneID > 0 {
		z = pgtype.Int8{Int64: *zoneID, Valid: true}
	}
	defs, err := q.ListAttributeDefinitions(ctx, db.ListAttributeDefinitionsParams{
		TenantID: tenantID,
		ZoneID:   z,
	})
	if err != nil {
		return nil, err
	}
	m := map[string]struct{}{}
	for _, d := range defs {
		m[d.Key] = struct{}{}
	}
	return m, nil
}

func sliceContains(sl []string, s string) bool {
	for _, v := range sl {
		if v == s {
			return true
		}
	}
	return false
}

func humanize(key string) string {
	s := strings.ReplaceAll(key, "_", " ")
	s = strings.ReplaceAll(s, "-", " ")
	words := strings.Fields(s)
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + strings.ToLower(w[1:])
		}
	}
	return strings.Join(words, " ")
}

func now() time.Time {
	return time.Now().UTC()
}

// --------------- label / grid math ported from src/lib/grid-generators.ts ---------------

const metersPerDegLat = 111_320.0

func metersToLngDelta(meters, lat float64) float64 {
	return meters / (metersPerDegLat * math.Cos(lat*math.Pi/180))
}

func metersToLatDelta(meters float64) float64 {
	return meters / metersPerDegLat
}

// Haversine distance in meters, accurate enough for warehouse-scale grids.
func distanceMeters(a, b [2]float64) float64 {
	const earthRadius = 6_371_000.0
	lat1 := a[1] * math.Pi / 180
	lat2 := b[1] * math.Pi / 180
	dLat := (b[1] - a[1]) * math.Pi / 180
	dLng := (b[0] - a[0]) * math.Pi / 180
	x := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(lat1)*math.Cos(lat2)*math.Sin(dLng/2)*math.Sin(dLng/2)
	c := 2 * math.Atan2(math.Sqrt(x), math.Sqrt(1-x))
	return earthRadius * c
}

type parsedBinLabel struct {
	Prefix string
	Number int
	Level  int
}

var (
	levelSuffixRe = regexp.MustCompile(`^(.+?)-L(\d+)$`)
	bodyRe        = regexp.MustCompile(`^(?:(.+)-)?(\d+)$`)
)

func parseLabelString(label string) *parsedBinLabel {
	trimmed := strings.TrimSpace(label)
	if trimmed == "" {
		return nil
	}
	body := trimmed
	level := 0
	if m := levelSuffixRe.FindStringSubmatch(trimmed); m != nil {
		body = m[1]
		l, err := strconv.Atoi(m[2])
		if err != nil || l < 1 {
			return nil
		}
		level = l - 1
	}
	m := bodyRe.FindStringSubmatch(body)
	if m == nil {
		return nil
	}
	prefix := ""
	if m[1] != "" {
		prefix = m[1]
	}
	n, err := strconv.Atoi(m[2])
	if err != nil || n < 0 {
		return nil
	}
	return &parsedBinLabel{Prefix: prefix, Number: n, Level: level}
}

type gridConfigShape struct {
	Type           string  `json:"type"`
	XSize          float64 `json:"xSize"`
	YSize          float64 `json:"ySize"`
	LabelPrefix    string  `json:"labelPrefix"`
	LabelDirection string  `json:"labelDirection"`
	LabelStart     float64 `json:"labelStart"`
	Levels         float64 `json:"levels"`
}

func gridConfig(raw json.RawMessage) gridConfigShape {
	cfg := gridConfigShape{
		Type:           "square",
		XSize:          1,
		YSize:          1,
		LabelPrefix:    "",
		LabelDirection: "x",
		LabelStart:     1,
		Levels:         1,
	}
	if len(raw) == 0 {
		return cfg
	}
	var parsed gridConfigShape
	if err := json.Unmarshal(raw, &parsed); err == nil {
		cfg = parsed
	}
	if cfg.XSize <= 0 {
		cfg.XSize = 1
	}
	if cfg.YSize <= 0 {
		cfg.YSize = 1
	}
	if cfg.Levels < 1 {
		cfg.Levels = 1
	}
	return cfg
}

type gridDims struct {
	Rows int
	Cols int
}

func estimateGridDimensions(startLng, startLat, currentLng, currentLat float64, cfg gridConfigShape) *gridDims {
	if cfg.Type != "square" {
		return nil
	}
	if cfg.XSize <= 0 || cfg.YSize <= 0 {
		return nil
	}
	widthM := distanceMeters([2]float64{startLng, startLat}, [2]float64{currentLng, startLat})
	heightM := distanceMeters([2]float64{startLng, startLat}, [2]float64{startLng, currentLat})
	return &gridDims{
		Cols: int(math.Max(0, math.Floor(widthM/cfg.XSize))),
		Rows: int(math.Max(0, math.Floor(heightM/cfg.YSize))),
	}
}

type cellAddr struct {
	Row   int32
	Col   int32
	Level int32
}

func cellAddressFromLabel(parsed *parsedBinLabel, cfg gridConfigShape, totalRows, totalCols int) *cellAddr {
	if cfg.LabelPrefix != parsed.Prefix {
		return nil
	}
	labelStart := int(cfg.LabelStart)
	index := parsed.Number - labelStart
	if index < 0 {
		return nil
	}
	totalLevels := int(math.Max(1, math.Floor(cfg.Levels)))
	if parsed.Level >= totalLevels {
		return nil
	}
	var row, col int
	if cfg.LabelDirection == "y" {
		col = index / totalRows
		row = index % totalRows
	} else {
		row = index / totalCols
		col = index % totalCols
	}
	if row < 0 || row >= totalRows || col < 0 || col >= totalCols {
		return nil
	}
	return &cellAddr{Row: int32(row), Col: int32(col), Level: int32(parsed.Level)}
}
