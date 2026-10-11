package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DuplicateZoneRequest is the body for POST /zones/{id}/duplicate. `Name`
// and `Color` are required — everything else is copied from the source
// warehouse. The new warehouse gets a fresh (empty) share token so the
// duplicate isn't accidentally reachable via the source's /share/:token
// URL until the user explicitly re-shares it.
type DuplicateZoneRequest struct {
	Name  string `json:"name" validate:"required"`
	Color string `json:"color" validate:"required"`
}

// duplicateZone deep-copies a warehouse and every zone-scoped row that
// hangs off it: floor plans (images), grids, every shape kind, bins,
// per-warehouse attribute definitions, style rules, data sources, and
// streams. Cross-references (grids → floor-plan images, bins → grids and
// shapes, streams → data sources) are remapped to the new IDs so the
// duplicate is a fully self-contained clone. The copy runs inside a
// single transaction — either the whole warehouse duplicates or none of
// it does.
func duplicateZone(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		sourceID, err := api.IDParam(r, "id")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		src, err := q.GetZone(r.Context(), db.GetZoneParams{ID: sourceID, TenantID: tenantID})
		if err != nil {
			if err == pgx.ErrNoRows {
				api.NotFound(w, "zone not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}

		var req DuplicateZoneRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if err := api.ValidateStruct(req); err != nil {
			api.BadRequest(w, err.Error())
			return
		}

		ctx := r.Context()
		tx, err := pool.Begin(ctx)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(ctx)
		qtx := q.WithTx(tx)

		// 1. Create the new zone. Copy center, address, description,
		//    default_view, and is_public from the source. Leave
		//    share_token NULL so the duplicate isn't reachable via the
		//    source's share URL until the user re-shares it.
		newZone, err := qtx.CreateZone(ctx, db.CreateZoneParams{
			TenantID:      tenantID,
			Name:          req.Name,
			Color:         req.Color,
			Description:   src.Description,
			StMakepoint:   src.CenterLng,
			StMakepoint_2: src.CenterLat,
			Address:       src.Address,
			DefaultView:   src.DefaultView,
			ShareToken:    pgtype.Text{},
			IsPublic:      src.IsPublic,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		newZoneID := newZone.ID

		// 2. Floor plans (images). Built first so grids / shapes can
		//    remap their floor_plan_id onto the new image IDs.
		imageMap, err := copyImageRows(ctx, tx, tenantID, sourceID, newZoneID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		// 3. Grids. floor_plan_id → image map.
		gridMap, err := copyGridRows(ctx, tx, tenantID, sourceID, newZoneID, imageMap)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		// 4. Shape tables. Each builds its own old→new id map for bins
		//    to remap shape_id against.
		polygonMap, err := copyPolygons(ctx, tx, tenantID, sourceID, newZoneID, imageMap)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		circleMap, err := copyCircles(ctx, tx, tenantID, sourceID, newZoneID, imageMap)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		lineMap, err := copyLines(ctx, tx, tenantID, sourceID, newZoneID, imageMap)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		markerMap, err := copyMarkers(ctx, tx, tenantID, sourceID, newZoneID, imageMap)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		modelMap, err := copyModels(ctx, tx, tenantID, sourceID, newZoneID, imageMap)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		textLabelMap, err := copyTextLabels(ctx, tx, tenantID, sourceID, newZoneID, imageMap)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		stairMap, err := copyStairs(ctx, tx, tenantID, sourceID, newZoneID, imageMap)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		shapeMaps := map[string]map[int64]int64{
			"polygon":    polygonMap,
			"circle":     circleMap,
			"line":       lineMap,
			"marker":     markerMap,
			"image":      imageMap,
			"model":      modelMap,
			"text-label": textLabelMap,
			"stair":      stairMap,
		}

		// 5. Data sources + streams. Done before bins so bin.sync_source
		//    can be remapped onto the new data source IDs. Streams
		//    reference data_source_id, so remap.
		dataSourceMap, err := copyDataSources(ctx, tx, tenantID, sourceID, newZoneID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := copyStreams(ctx, tx, tenantID, sourceID, newZoneID, dataSourceMap); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// 6. Bins. Remap grid_id, shape_id (by target_kind),
		//    floor_plan_id, and sync_source (→ new data source).
		if err := copyBins(ctx, tx, tenantID, sourceID, newZoneID, gridMap, imageMap, shapeMaps, dataSourceMap); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// 7. Style rules. Just rebind zone_id; no cross-references.
		if err := copyStyleRules(ctx, tx, tenantID, sourceID, newZoneID); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// 8. Per-warehouse attribute definitions. Only rows with
		//    zone_id = sourceID; tenant-shared rows (zone_id NULL) are
		//    intentionally NOT duplicated — they're already visible to
		//    the new warehouse by virtue of being tenant-shared.
		if err := copyAttributeDefinitions(ctx, tx, tenantID, sourceID, newZoneID); err != nil {
			api.InternalError(w, r, err)
			return
		}

		if err := tx.Commit(ctx); err != nil {
			api.InternalError(w, r, err)
			return
		}

		createFacilityReports(r, q, tenantID, newZone.ID)
		api.JSON(w, http.StatusCreated, toZoneResponse(newZone))
		BroadcastEntityEvent("ENTITY_CREATED", "zones", newZone.ID, tenantID)
	}
}

// ----------------------- floor plans -----------------------

func copyImageRows(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64) (map[int64]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, name, start_lng, start_lat, current_lng, current_lat, rotation,
		       image_data, mime_type, natural_width, natural_height, config, unit, visible
		FROM images
		WHERE tenant_id = $1 AND zone_id = $2
		ORDER BY id`, tenantID, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[int64]int64)
	for rows.Next() {
		var (
			id                                                   int64
			name                                                 string
			startLng, startLat, currentLng, currentLat, rotation float64
			imageData, mimeType                                  string
			naturalWidth, naturalHeight                          int
			config                                               []byte
			unit                                                 string
			visible                                              bool
		)
		if err := rows.Scan(&id, &name, &startLng, &startLat, &currentLng, &currentLat, &rotation, &imageData, &mimeType, &naturalWidth, &naturalHeight, &config, &unit, &visible); err != nil {
			return nil, err
		}
		var newID int64
		err := tx.QueryRow(ctx, `
			INSERT INTO images (tenant_id, name, start_lng, start_lat, current_lng, current_lat, rotation, image_data, mime_type, natural_width, natural_height, config, zone_id, unit, visible)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
			RETURNING id`,
			tenantID, name, startLng, startLat, currentLng, currentLat, rotation, imageData, mimeType, naturalWidth, naturalHeight, config, newZoneID, unit, visible).Scan(&newID)
		if err != nil {
			return nil, err
		}
		out[id] = newID
	}
	return out, rows.Err()
}

// ----------------------- grids -----------------------

func copyGridRows(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, imageMap map[int64]int64) (map[int64]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, name, start_lng, start_lat, current_lng, current_lat, config, floor_plan_id
		FROM grids
		WHERE tenant_id = $1 AND zone_id = $2
		ORDER BY id`, tenantID, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[int64]int64)
	for rows.Next() {
		var (
			id                                         int64
			name                                       string
			startLng, startLat, currentLng, currentLat float64
			config                                     []byte
			floorPlanID                                pgtype.Int8
		)
		if err := rows.Scan(&id, &name, &startLng, &startLat, &currentLng, &currentLat, &config, &floorPlanID); err != nil {
			return nil, err
		}
		newFloorPlan := remapInt8(floorPlanID, imageMap)
		var newID int64
		err := tx.QueryRow(ctx, `
			INSERT INTO grids (tenant_id, name, start_lng, start_lat, current_lng, current_lat, config, zone_id, floor_plan_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id`,
			tenantID, name, startLng, startLat, currentLng, currentLat, config, newZoneID, newFloorPlan).Scan(&newID)
		if err != nil {
			return nil, err
		}
		out[id] = newID
	}
	return out, rows.Err()
}

// ----------------------- shapes -----------------------

func copyPolygons(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, imageMap map[int64]int64) (map[int64]int64, error) {
	return copySimpleShape(ctx, tx, "polygons", []string{"name", "vertices", "rotation", "config", "unit", "visible"}, tenantID, sourceID, newZoneID, imageMap)
}

func copyLines(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, imageMap map[int64]int64) (map[int64]int64, error) {
	return copySimpleShape(ctx, tx, "lines", []string{"name", "vertices", "rotation", "config", "unit", "visible"}, tenantID, sourceID, newZoneID, imageMap)
}

func copyStairs(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, imageMap map[int64]int64) (map[int64]int64, error) {
	return copySimpleShape(ctx, tx, "stairs", []string{"name", "vertices", "rotation", "config", "unit", "visible"}, tenantID, sourceID, newZoneID, imageMap)
}

func copyMarkers(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, imageMap map[int64]int64) (map[int64]int64, error) {
	return copySimpleShape(ctx, tx, "markers", []string{"name", "lng", "lat", "bearing", "config", "unit", "visible"}, tenantID, sourceID, newZoneID, imageMap)
}

func copyModels(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, imageMap map[int64]int64) (map[int64]int64, error) {
	return copySimpleShape(ctx, tx, "models", []string{"name", "lng", "lat", "config", "unit", "visible"}, tenantID, sourceID, newZoneID, imageMap)
}

func copyTextLabels(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, imageMap map[int64]int64) (map[int64]int64, error) {
	return copySimpleShape(ctx, tx, "text_labels", []string{"name", "lng", "lat", "config", "unit", "visible"}, tenantID, sourceID, newZoneID, imageMap)
}

func copyCircles(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, imageMap map[int64]int64) (map[int64]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, name, mode, center_lng, center_lat, radius, start_lng, start_lat,
		       current_lng, current_lat, cell_radius, cell_size, rotation, config, floor_plan_id, unit, visible
		FROM circles
		WHERE tenant_id = $1 AND zone_id = $2
		ORDER BY id`, tenantID, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[int64]int64)
	for rows.Next() {
		var (
			id                                                                       int64
			name, mode                                                               string
			centerLng, centerLat, radius, startLng, startLat, currentLng, currentLat float64
			cellRadius, cellSize, rotation                                           float64
			config                                                                   []byte
			floorPlanID                                                              pgtype.Int8
			unit                                                                     string
			visible                                                                  bool
		)
		if err := rows.Scan(&id, &name, &mode, &centerLng, &centerLat, &radius, &startLng, &startLat, &currentLng, &currentLat, &cellRadius, &cellSize, &rotation, &config, &floorPlanID, &unit, &visible); err != nil {
			return nil, err
		}
		newFloorPlan := remapInt8(floorPlanID, imageMap)
		var newID int64
		err := tx.QueryRow(ctx, `
			INSERT INTO circles (tenant_id, name, mode, center_lng, center_lat, radius, start_lng, start_lat, current_lng, current_lat, cell_radius, cell_size, rotation, config, zone_id, floor_plan_id, unit, visible)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
			RETURNING id`,
			tenantID, name, mode, centerLng, centerLat, radius, startLng, startLat, currentLng, currentLat, cellRadius, cellSize, rotation, config, newZoneID, newFloorPlan, unit, visible).Scan(&newID)
		if err != nil {
			return nil, err
		}
		out[id] = newID
	}
	return out, rows.Err()
}

// copySimpleShape handles tables whose columns are a flat
// (name, geometry..., config, unit, visible) tuple plus the standard
// zone_id and floor_plan_id. Polygons, lines, stairs, markers, models,
// and text_labels all fit this shape.
func copySimpleShape(ctx context.Context, tx pgx.Tx, table string, dataCols []string, tenantID, sourceID, newZoneID int64, imageMap map[int64]int64) (map[int64]int64, error) {
	// SELECT id, <dataCols>, floor_plan_id FROM <table>
	selectList := "id, " + strings.Join(dataCols, ", ") + ", floor_plan_id"
	rows, err := tx.Query(ctx, fmt.Sprintf(`
		SELECT %s
		FROM %s
		WHERE tenant_id = $1 AND zone_id = $2
		ORDER BY id`, selectList, table), tenantID, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// INSERT INTO <table> (tenant_id, <dataCols>, zone_id, floor_plan_id)
	// VALUES ($1, ..., $N)
	insertCols := "tenant_id, " + strings.Join(dataCols, ", ") + ", zone_id, floor_plan_id"
	placeholders := make([]string, 0, len(dataCols)+3)
	for i := 0; i < len(dataCols)+3; i++ {
		placeholders = append(placeholders, fmt.Sprintf("$%d", i+1))
	}
	insertStmt := fmt.Sprintf(`
		INSERT INTO %s (%s)
		VALUES (%s)
		RETURNING id`, table, insertCols, strings.Join(placeholders, ", "))

	out := make(map[int64]int64)
	for rows.Next() {
		// Scan into a dynamic slice. pgx populates typed pointers
		// transparently when given []any.
		raw := make([]any, len(dataCols)+2) // +id +floor_plan_id
		ptrs := make([]any, len(raw))
		for i := range raw {
			ptrs[i] = &raw[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		oldID, ok := raw[0].(int64)
		if !ok {
			return nil, fmt.Errorf("expected int64 for %s.id, got %T", table, raw[0])
		}
		floorPlanVal := raw[len(raw)-1]

		// Build INSERT args: tenantID, <dataCols verbatim>, newZoneID, remapped floor_plan_id.
		args := make([]any, 0, len(raw)+1)
		args = append(args, tenantID)
		for i := 0; i < len(dataCols); i++ {
			args = append(args, raw[i+1])
		}
		args = append(args, newZoneID)
		args = append(args, remapAnyInt8(floorPlanVal, imageMap))

		var newID int64
		if err := tx.QueryRow(ctx, insertStmt, args...).Scan(&newID); err != nil {
			return nil, err
		}
		out[oldID] = newID
	}
	return out, rows.Err()
}

// ----------------------- bins -----------------------

func copyBins(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, gridMap, imageMap map[int64]int64, shapeMaps map[string]map[int64]int64, dataSourceMap map[int64]int64) error {
	// Pull every bin row whose grid_id belongs to a grid in this
	// warehouse OR whose shape_id belongs to a shape in this warehouse.
	rows, err := tx.Query(ctx, `
		SELECT b.id, b.target_kind, b.grid_id, b.row, b.col, b.level, b.shape_id,
		       b.status, b.sku, b.capacity, b.notes, b.external_code,
		       b.custom_properties, b.last_synced_at, b.sync_source, b.floor_plan_id
		FROM bins b
		WHERE b.tenant_id = $1
		  AND (
		    (b.grid_id IS NOT NULL AND b.grid_id IN (SELECT id FROM grids WHERE zone_id = $2))
		    OR (b.target_kind = 'polygon'    AND b.shape_id IN (SELECT id FROM polygons   WHERE zone_id = $2))
		    OR (b.target_kind = 'circle'     AND b.shape_id IN (SELECT id FROM circles   WHERE zone_id = $2))
		    OR (b.target_kind = 'line'       AND b.shape_id IN (SELECT id FROM lines     WHERE zone_id = $2))
		    OR (b.target_kind = 'marker'     AND b.shape_id IN (SELECT id FROM markers   WHERE zone_id = $2))
		    OR (b.target_kind = 'image'      AND b.shape_id IN (SELECT id FROM images    WHERE zone_id = $2))
		    OR (b.target_kind = 'model'      AND b.shape_id IN (SELECT id FROM models    WHERE zone_id = $2))
		  )
		ORDER BY b.id`, tenantID, sourceID)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id               int64
			targetKind       string
			gridID           pgtype.Int8
			row, col, level  pgtype.Int4
			shapeID          pgtype.Int8
			status           pgtype.Text
			sku              pgtype.Text
			capacity         pgtype.Float8
			notes            pgtype.Text
			externalCode     pgtype.Text
			customProperties []byte
			lastSyncedAt     pgtype.Timestamptz
			syncSource       pgtype.Int8
			floorPlanID      pgtype.Int8
		)
		if err := rows.Scan(&id, &targetKind, &gridID, &row, &col, &level, &shapeID, &status, &sku, &capacity, &notes, &externalCode, &customProperties, &lastSyncedAt, &syncSource, &floorPlanID); err != nil {
			return err
		}

		var newGridID pgtype.Int8
		if gridID.Valid {
			if newID, ok := gridMap[gridID.Int64]; ok {
				newGridID = pgtype.Int8{Int64: newID, Valid: true}
			}
		}
		var newShapeID pgtype.Int8
		if shapeID.Valid {
			if m, ok := shapeMaps[targetKind]; ok {
				if newID, ok := m[shapeID.Int64]; ok {
					newShapeID = pgtype.Int8{Int64: newID, Valid: true}
				}
			}
		}
		newFloorPlan := remapInt8(floorPlanID, imageMap)
		// sync_source points at a data_source row. Data sources are
		// copied in step 5 above, so remap onto the new id; if the
		// referenced source wasn't in this warehouse, drop the link.
		newSyncSource := remapInt8(syncSource, dataSourceMap)

		if _, err := tx.Exec(ctx, `
			INSERT INTO bins (tenant_id, target_kind, grid_id, row, col, level, shape_id, status, sku, capacity, notes, external_code, custom_properties, last_synced_at, sync_source, floor_plan_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
			tenantID, targetKind, newGridID, row, col, level, newShapeID, status, sku, capacity, notes, externalCode, customProperties, lastSyncedAt, newSyncSource, newFloorPlan); err != nil {
			return err
		}
	}
	return rows.Err()
}

// ----------------------- style rules -----------------------

func copyStyleRules(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO style_rules (tenant_id, name, scope, zone_id, enabled, priority, combine, conditions, style, created_at, updated_at)
		SELECT $1, name, scope, $2, enabled, priority, combine, conditions, style, now(), now()
		FROM style_rules
		WHERE tenant_id = $1 AND zone_id = $3`,
		tenantID, newZoneID, sourceID)
	return err
}

// ----------------------- attribute definitions -----------------------

func copyAttributeDefinitions(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64) error {
	// Only per-warehouse rows (zone_id = sourceID). Tenant-shared rows
	// (zone_id NULL) are already visible to the new warehouse by
	// virtue of being tenant-shared.
	_, err := tx.Exec(ctx, `
		INSERT INTO attribute_definitions (tenant_id, scope, key, label, type, unit, enum_values, default_value, description, zone_id, created_at)
		SELECT $1, scope, key, label, type, unit, enum_values, default_value, description, $2, now()
		FROM attribute_definitions
		WHERE tenant_id = $1 AND zone_id = $3`,
		tenantID, newZoneID, sourceID)
	return err
}

// ----------------------- data sources + streams -----------------------

func copyDataSources(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64) (map[int64]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, name, kind, config, mapping, schedule, interval_seconds, last_run_at, last_result
		FROM data_sources
		WHERE tenant_id = $1 AND zone_id = $2
		ORDER BY id`, tenantID, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[int64]int64)
	for rows.Next() {
		var (
			id              int64
			name, kind      string
			config, mapping []byte
			schedule        pgtype.Text
			intervalSeconds pgtype.Int4
			lastRunAt       pgtype.Timestamptz
			lastResult      pgtype.Text
		)
		if err := rows.Scan(&id, &name, &kind, &config, &mapping, &schedule, &intervalSeconds, &lastRunAt, &lastResult); err != nil {
			return nil, err
		}
		var newID int64
		err := tx.QueryRow(ctx, `
			INSERT INTO data_sources (tenant_id, name, kind, zone_id, config, mapping, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
			RETURNING id`,
			tenantID, name, kind, newZoneID, config, mapping, schedule, intervalSeconds, lastRunAt, lastResult).Scan(&newID)
		if err != nil {
			return nil, err
		}
		out[id] = newID
	}
	return out, rows.Err()
}

func copyStreams(ctx context.Context, tx pgx.Tx, tenantID, sourceID, newZoneID int64, dataSourceMap map[int64]int64) error {
	rows, err := tx.Query(ctx, `
		SELECT id, connection_id, data_source_id, name, entity_type, kind, binding, endpoint, schedule, interval_seconds, last_run_at, last_result
		FROM streams
		WHERE tenant_id = $1 AND zone_id = $2
		ORDER BY id`, tenantID, sourceID)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id                     int64
			connectionID           int64
			dataSourceID           pgtype.Int8
			name, entityType, kind string
			binding, endpoint      []byte
			schedule               pgtype.Text
			intervalSeconds        pgtype.Int4
			lastRunAt              pgtype.Timestamptz
			lastResult             pgtype.Text
		)
		if err := rows.Scan(&id, &connectionID, &dataSourceID, &name, &entityType, &kind, &binding, &endpoint, &schedule, &intervalSeconds, &lastRunAt, &lastResult); err != nil {
			return err
		}
		// data_source_id remaps onto the new data source; if not in
		// the map (referenced a source outside this warehouse), drop
		// the link rather than carrying a dangling pointer.
		var newDataSource pgtype.Int8
		if dataSourceID.Valid {
			if newID, ok := dataSourceMap[dataSourceID.Int64]; ok {
				newDataSource = pgtype.Int8{Int64: newID, Valid: true}
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO streams (tenant_id, connection_id, data_source_id, name, entity_type, kind, binding, endpoint, zone_id, schedule, interval_seconds, last_run_at, last_result, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())`,
			tenantID, connectionID, newDataSource, name, entityType, kind, binding, endpoint, newZoneID, schedule, intervalSeconds, lastRunAt, lastResult); err != nil {
			return err
		}
	}
	return rows.Err()
}

// ----------------------- helpers -----------------------

func remapInt8(in pgtype.Int8, m map[int64]int64) pgtype.Int8 {
	if !in.Valid {
		return in
	}
	if newID, ok := m[in.Int64]; ok {
		return pgtype.Int8{Int64: newID, Valid: true}
	}
	// Reference points outside the warehouse (e.g. a floor plan that
	// was deleted from this zone but the row lingers) — drop it
	// rather than carry a dangling pointer into the duplicate.
	return pgtype.Int8{}
}

// remapAnyInt8 handles a floor_plan_id value pulled out of a dynamic
// []any scan. pgx may return it as pgtype.Int8, *pgtype.Int8, int64,
// or nil depending on the column type and driver version.
func remapAnyInt8(val any, m map[int64]int64) pgtype.Int8 {
	switch v := val.(type) {
	case pgtype.Int8:
		return remapInt8(v, m)
	case *pgtype.Int8:
		if v == nil {
			return pgtype.Int8{}
		}
		return remapInt8(*v, m)
	case int64:
		if newID, ok := m[v]; ok {
			return pgtype.Int8{Int64: newID, Valid: true}
		}
		return pgtype.Int8{}
	default:
		return pgtype.Int8{}
	}
}
