package handlers

// Facility / workspace clone.
//
// One engine for copying facilities:
//   - POST /zones/{id}/duplicate (zone_duplicate.go): one facility, same
//     workspace. Workspace-level rows (user models, workspace data sources,
//     style rules without a facility, the built-in facility sources,
//     streams of other facilities) are shared, so references to them keep
//     their id.
//   - Across workspaces (DstTenant != SrcTenant): chosen facilities or a
//     whole workspace into another workspace; workspace-level rows the copy
//     needs come along. Supported by the engine; no route uses it yet.
//
// How it works, all inside the caller's transaction:
//  1. allocate: for every table whose ids are referenced, the rows to copy
//     get a fresh id from the table's own sequence, recorded in the temp
//     table clone_map (kind = table, old_id → new_id, copy = true). Rows
//     that are *mapped* but not copied (the target's facility sources, a
//     same-name solution in the target, workspace rows in a same-workspace
//     duplicate) are recorded with copy = false.
//  2. insert: INSERT … SELECT per table. The column list is read from
//     information_schema, so a column added by a later migration is copied
//     as-is; a column that holds a row id must get an override below.
//     Id columns are rewritten through clone_map; an id that has no mapping
//     becomes NULL (it pointed outside what was copied).
//  3. JSON: ids inside JSONB are rewritten in Go (rewriteCloneJSON) —
//     door → line, model → user model, stair / data-link / data-source
//     floor ids, every report-spec reference. Row payloads (millions of
//     rows) are rewritten in SQL (floorPlanId / floorId only). An id with
//     no mapping is removed, never left pointing at the source workspace.
//
// Never copied: share_links, report_permissions, report_runs, ai_jobs,
// alert_seen, alert_rule_state, table_api_tokens (secrets),
// import_jobs, audit_log, legacy alerts / correlation_rules / entity_* /
// webhook_events, user_tenants, roles. Across workspaces also connections
// and streams (outbound credentials; a JSON / REST source rebuilds its
// mirror stream on its next edit).

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
)

type cloneOptions struct {
	SrcTenant int64
	DstTenant int64
	// Whole copies every facility of the source plus the rows that belong
	// to no facility; otherwise ZoneIDs (all of the source workspace).
	Whole   bool
	ZoneIDs []int64
	// ZoneName / ZoneColor rename the copy (only with exactly one zone).
	ZoneName  string
	ZoneColor string

	IncludeData         bool // data_source_rows + source_files
	IncludeHistory      bool // data_source_row_events (needs IncludeData)
	IncludeAlertHistory bool // alert_events (needs AlertRules)
	Reports             bool
	Solutions           bool // across workspaces only
	AlertRules          bool

	// ActorID is the user doing the copy: created_by / uploaded_by of the
	// copied rows across workspaces (0 = NULL).
	ActorID int64
}

type cloneResult struct {
	ZoneMap map[int64]int64  `json:"-"`
	Counts  map[string]int64 `json:"counts"`
}

type cloner struct {
	ctx    context.Context
	tx     pgx.Tx
	q      *db.Queries
	o      cloneOptions
	same   bool
	cols   map[string][]string
	counts map[string]int64
	rep    *strings.Replacer
}

// cloneShapeTables are the facility-scoped layout tables (zone_id +
// floor_plan_id), in insert order. images first: everything else points at
// floor plans.
var cloneShapeTables = []string{
	"images", "grids", "polygons", "circles", "lines", "markers", "models",
	"stairs", "text_labels", "doors", "image_planes", "routes",
}

var cloneAllTables = append(append([]string{"zones"}, cloneShapeTables...),
	"bins", "user_models", "tenant_files", "attribute_definitions", "data_sources",
	"streams", "table_field_definitions", "data_source_rows", "data_source_row_events",
	"source_files", "style_rules", "data_link_configs", "reports", "solutions",
	"solution_items", "alert_rules", "alert_events")

// cloneFacilities copies per cloneOptions inside tx. q must be bound to tx.
func cloneFacilities(ctx context.Context, tx pgx.Tx, q *db.Queries, o cloneOptions) (cloneResult, error) {
	c := &cloner{ctx: ctx, tx: tx, q: q, o: o, same: o.SrcTenant == o.DstTenant, counts: map[string]int64{}}
	if c.same {
		o.Solutions = false
		c.o.Solutions = false
	}
	zones := "ARRAY[]::bigint[]"
	if len(o.ZoneIDs) > 0 {
		parts := make([]string, len(o.ZoneIDs))
		for i, id := range o.ZoneIDs {
			parts[i] = strconv.FormatInt(id, 10)
		}
		zones = "ARRAY[" + strings.Join(parts, ",") + "]::bigint[]"
	}
	actor := "NULL::bigint"
	if o.ActorID > 0 {
		actor = strconv.FormatInt(o.ActorID, 10)
	}
	// Only server-side integers are inlined; user text goes in as $n.
	c.rep = strings.NewReplacer("{src}", strconv.FormatInt(o.SrcTenant, 10),
		"{dst}", strconv.FormatInt(o.DstTenant, 10), "{zones}", zones, "{actor}", actor)

	if err := c.prepare(); err != nil {
		return cloneResult{}, err
	}
	if err := c.allocate(); err != nil {
		return cloneResult{}, err
	}
	if err := c.insert(); err != nil {
		return cloneResult{}, err
	}
	maps, err := c.loadMaps()
	if err != nil {
		return cloneResult{}, err
	}
	if err := c.rewriteJSON(maps); err != nil {
		return cloneResult{}, err
	}
	zm := map[int64]int64{}
	for old, nu := range maps["zones"] {
		zm[old] = nu
	}
	return cloneResult{ZoneMap: zm, Counts: c.counts}, nil
}

func (c *cloner) exec(sql string, args ...any) (int64, error) {
	tag, err := c.tx.Exec(c.ctx, c.rep.Replace(sql), args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (c *cloner) prepare() error {
	if _, err := c.tx.Exec(c.ctx, `
		CREATE TEMP TABLE IF NOT EXISTS clone_map (
			kind text NOT NULL, old_id bigint NOT NULL, new_id bigint NOT NULL, copy boolean NOT NULL,
			PRIMARY KEY (kind, old_id)
		) ON COMMIT DROP`); err != nil {
		return err
	}
	if _, err := c.tx.Exec(c.ctx, `TRUNCATE clone_map`); err != nil {
		return err
	}
	rows, err := c.tx.Query(c.ctx, `
		SELECT table_name::text, column_name::text FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = ANY($1::text[]) AND is_generated = 'NEVER'
		ORDER BY table_name, ordinal_position`, cloneAllTables)
	if err != nil {
		return err
	}
	defer rows.Close()
	c.cols = map[string][]string{}
	for rows.Next() {
		var t, col string
		if err := rows.Scan(&t, &col); err != nil {
			return err
		}
		if col != "id" {
			c.cols[t] = append(c.cols[t], col)
		}
	}
	return rows.Err()
}

// cm is the new id of `expr` in `kind`, NULL when it has none.
func cm(kind, expr string) string {
	return fmt.Sprintf("(SELECT m.new_id FROM clone_map m WHERE m.kind = '%s' AND m.old_id = %s)", kind, expr)
}

// mapped is true when `expr` has a mapping in `kind` (copied or kept).
func mapped(kind, expr string) string {
	return fmt.Sprintf("EXISTS (SELECT 1 FROM clone_map m WHERE m.kind = '%s' AND m.old_id = %s)", kind, expr)
}

// copied is true when `expr` was copied in `kind`.
func copied(kind, expr string) string {
	return fmt.Sprintf("EXISTS (SELECT 1 FROM clone_map m WHERE m.kind = '%s' AND m.old_id = %s AND m.copy)", kind, expr)
}

// kindTable maps a binding kind (bins.target_kind, data_link_configs.target_kind) to its table.
func kindTable(col string) string {
	return fmt.Sprintf(`(CASE %s::text WHEN 'grid-cell' THEN 'grids' WHEN 'polygon' THEN 'polygons'
		WHEN 'circle' THEN 'circles' WHEN 'line' THEN 'lines' WHEN 'marker' THEN 'markers'
		WHEN 'image' THEN 'images' WHEN 'model' THEN 'models' END)`, col)
}

// shapeRef is the new id of a shape referenced by (kind column, id column).
func shapeRef(kindCol, idCol string) string {
	return fmt.Sprintf("(SELECT m.new_id FROM clone_map m WHERE m.kind = %s AND m.old_id = %s)", kindTable(kindCol), idCol)
}

// zoneSel / wholeSel select a table's rows for a facility copy or a whole one.
func (c *cloner) sel() string {
	if c.o.Whole {
		return "t.tenant_id = {src}"
	}
	return "t.tenant_id = {src} AND t.zone_id = ANY({zones})"
}

func (c *cloner) alloc(table, where string) error {
	_, err := c.exec(fmt.Sprintf(`
		INSERT INTO clone_map (kind, old_id, new_id, copy)
		SELECT '%[1]s', s.id, nextval(pg_get_serial_sequence('%[1]s', 'id')), true
		FROM (SELECT t.id FROM %[1]s t WHERE %[2]s ORDER BY t.id) s
		ON CONFLICT DO NOTHING`, table, where))
	return err
}

// keep maps every remaining row of the source workspace in `table` to itself
// (same-workspace duplicate: the row is shared, not copied).
func (c *cloner) keep(table string) error {
	_, err := c.exec(fmt.Sprintf(`
		INSERT INTO clone_map (kind, old_id, new_id, copy)
		SELECT '%[1]s', t.id, t.id, false FROM %[1]s t WHERE t.tenant_id = {src}
		ON CONFLICT DO NOTHING`, table))
	return err
}

// reportSourceRefs are the data-source ids the copied facilities' reports read.
const reportSourceRefs = `
	SELECT (v #>> '{}')::bigint FROM reports x,
	  LATERAL (SELECT jsonb_path_query(x.spec, 'lax $.**.sourceId') v
	           UNION ALL SELECT jsonb_path_query(x.spec, 'lax $.**.sourceIds[*]')
	           UNION ALL SELECT jsonb_path_query(x.spec, 'lax $.** ? (@.kind == "dataSource").id')) j
	WHERE x.tenant_id = {src} AND x.zone_id = ANY({zones}) AND jsonb_typeof(v) = 'number'`

func (c *cloner) binsWhere(alias string) string {
	return fmt.Sprintf(`%[1]s.tenant_id = {src} AND EXISTS (SELECT 1 FROM clone_map m WHERE m.copy
		AND m.kind = %[2]s AND m.old_id = CASE WHEN %[1]s.target_kind = 'grid-cell' THEN %[1]s.grid_id ELSE %[1]s.shape_id END)`,
		alias, kindTable(alias+".target_kind"))
}

func (c *cloner) allocate() error {
	if err := c.alloc("zones", "t.tenant_id = {src} AND (t.id = ANY({zones}) OR "+strconv.FormatBool(c.o.Whole)+")"); err != nil {
		return err
	}
	for _, t := range cloneShapeTables {
		if err := c.alloc(t, c.sel()); err != nil {
			return err
		}
	}

	// User models: shared within a workspace; across, the ones the copy
	// places (models.config.modelAssetId = "user_<id>") or uploaded for it.
	if c.same {
		if err := c.keep("user_models"); err != nil {
			return err
		}
	} else {
		where := "t.tenant_id = {src}"
		if !c.o.Whole {
			where += ` AND (t.zone_id = ANY({zones}) OR t.id IN (
				SELECT substring(x.config->>'modelAssetId' from '^user_([0-9]+)$')::bigint
				FROM models x WHERE ` + copied("models", "x.id") + `))`
		}
		if err := c.alloc("user_models", where); err != nil {
			return err
		}
	}

	// Data sources. The built-in facility sources (kind 'facility') are one
	// per workspace and entity: across workspaces they map onto the
	// target's own (created if missing), never copied.
	if c.same {
		if err := c.alloc("data_sources", "t.tenant_id = {src} AND t.kind <> 'facility' AND t.zone_id = ANY({zones})"); err != nil {
			return err
		}
		if err := c.keep("data_sources"); err != nil {
			return err
		}
	} else {
		if err := reports.EnsureFacilitySources(c.ctx, c.q, c.o.DstTenant); err != nil {
			return err
		}
		if _, err := c.exec(`
			INSERT INTO clone_map (kind, old_id, new_id, copy)
			SELECT 'data_sources', s.id, d.id, false
			FROM data_sources s JOIN data_sources d
			  ON d.tenant_id = {dst} AND d.config->>'facilityEntity' = s.config->>'facilityEntity'
			WHERE s.tenant_id = {src} AND s.config->>'facilityEntity' IS NOT NULL
			ON CONFLICT DO NOTHING`); err != nil {
			return err
		}
		where := "t.tenant_id = {src} AND t.kind <> 'facility'"
		if !c.o.Whole {
			// Facility sources plus the workspace sources the copy reads.
			refs := `SELECT x.source_id FROM data_link_configs x WHERE x.tenant_id = {src} AND x.zone_id = ANY({zones})
				UNION SELECT x.sync_source FROM bins x WHERE ` + c.binsWhere("x")
			if c.o.AlertRules {
				refs += ` UNION SELECT x.source_id FROM alert_rules x WHERE x.tenant_id = {src} AND x.zone_id = ANY({zones})`
			}
			if c.o.Reports {
				refs += " UNION " + reportSourceRefs
			}
			where += " AND (t.zone_id = ANY({zones}) OR (t.zone_id IS NULL AND t.id IN (" + refs + ")))"
		}
		if err := c.alloc("data_sources", where); err != nil {
			return err
		}
	}

	// Streams: only within a workspace (they carry the connection).
	if c.same {
		if err := c.alloc("streams", "t.tenant_id = {src} AND t.zone_id = ANY({zones})"); err != nil {
			return err
		}
		if err := c.keep("streams"); err != nil {
			return err
		}
	}

	// Style rules: the facilities' own; across workspaces also the
	// workspace-wide ones a copied data link uses.
	switch {
	case c.same:
		if err := c.alloc("style_rules", c.sel()); err != nil {
			return err
		}
		if err := c.keep("style_rules"); err != nil {
			return err
		}
	case c.o.Whole:
		if err := c.alloc("style_rules", "t.tenant_id = {src}"); err != nil {
			return err
		}
	default:
		if err := c.alloc("style_rules", `t.tenant_id = {src} AND (t.zone_id = ANY({zones}) OR (t.zone_id IS NULL AND t.id IN (
			SELECT unnest(x.style_rule_ids) FROM data_link_configs x WHERE x.tenant_id = {src} AND x.zone_id = ANY({zones}))))`); err != nil {
			return err
		}
	}

	dlc := c.sel()
	if !c.same {
		dlc += " AND t.source_id IS NOT NULL" // a stream-only link has nothing to read in the target
	}
	if err := c.alloc("data_link_configs", dlc); err != nil {
		return err
	}

	if c.o.Reports {
		if err := c.alloc("reports", c.sel()); err != nil {
			return err
		}
	}

	if c.o.Solutions {
		where := "t.tenant_id = {src}"
		if !c.o.Whole {
			where += " AND t.id IN (SELECT x.solution_id FROM solution_items x WHERE x.tenant_id = {src} AND x.zone_id = ANY({zones}))"
		}
		// A solution with the same name in the target takes the items.
		if _, err := c.exec(`
			INSERT INTO clone_map (kind, old_id, new_id, copy)
			SELECT 'solutions', t.id, d.id, false FROM solutions t
			JOIN LATERAL (SELECT d.id FROM solutions d WHERE d.tenant_id = {dst} AND lower(d.name) = lower(t.name) ORDER BY d.id LIMIT 1) d ON true
			WHERE ` + where + `
			ON CONFLICT DO NOTHING`); err != nil {
			return err
		}
		if err := c.alloc("solutions", where); err != nil {
			return err
		}
	}

	if c.o.AlertRules {
		if err := c.alloc("alert_rules", c.sel()+" AND "+mapped("data_sources", "t.source_id")); err != nil {
			return err
		}
	}
	return nil
}

// overrides common to every table (when the column exists).
func (c *cloner) generic(col string) (string, bool) {
	switch col {
	case "tenant_id":
		return "{dst}", true
	case "zone_id":
		return cm("zones", "t.zone_id"), true
	case "floor_plan_id":
		return cm("images", "t.floor_plan_id"), true
	case "created_by", "uploaded_by":
		if !c.same {
			return "{actor}", true
		}
	}
	return "", false
}

func (c *cloner) selectList(table string, set map[string]string) (cols []string, exprs []string, err error) {
	cols = c.cols[table]
	if len(cols) == 0 {
		return nil, nil, fmt.Errorf("clone: no columns for %s", table)
	}
	exprs = make([]string, len(cols))
	for i, col := range cols {
		if v, ok := set[col]; ok {
			exprs[i] = v
		} else if v, ok := c.generic(col); ok {
			exprs[i] = v
		} else {
			exprs[i] = "t." + col
		}
	}
	return cols, exprs, nil
}

// copyMapped inserts the rows allocated in clone_map under their new ids.
func (c *cloner) copyMapped(table string, set map[string]string, args ...any) error {
	cols, exprs, err := c.selectList(table, set)
	if err != nil {
		return err
	}
	n, err := c.exec(fmt.Sprintf(`
		INSERT INTO %[1]s (id, %[2]s)
		SELECT m.new_id, %[3]s
		FROM %[1]s t JOIN clone_map m ON m.kind = '%[1]s' AND m.old_id = t.id AND m.copy
		ORDER BY m.new_id`, table, strings.Join(cols, ", "), strings.Join(exprs, ", ")), args...)
	if err != nil {
		return fmt.Errorf("clone %s: %w", table, err)
	}
	c.counts[table] += n
	return nil
}

// copyRows inserts rows nothing references by id (fresh ids from the default).
func (c *cloner) copyRows(table, where string, set map[string]string, onConflictNothing bool) error {
	cols, exprs, err := c.selectList(table, set)
	if err != nil {
		return err
	}
	conflict := ""
	if onConflictNothing {
		conflict = " ON CONFLICT DO NOTHING"
	}
	order := ""
	if table != "tenant_files" { // the only table without an id
		order = " ORDER BY t.id"
	}
	n, err := c.exec(fmt.Sprintf(`
		INSERT INTO %[1]s (%[2]s)
		SELECT %[3]s FROM %[1]s t WHERE %[4]s%[5]s%[6]s`,
		table, strings.Join(cols, ", "), strings.Join(exprs, ", "), where, order, conflict))
	if err != nil {
		return fmt.Errorf("clone %s: %w", table, err)
	}
	c.counts[table] += n
	return nil
}

// payloadFloorExpr rewrites a row payload's floor-plan ids (the keys the map
// reads a row's floor from: floorPlanId, floorId) in SQL.
func payloadFloorExpr(col string) string {
	e := col
	for _, key := range []string{"floorPlanId", "floorId"} {
		v := fmt.Sprintf("(%s->>'%s')", e, key)
		newID := fmt.Sprintf("(SELECT m.new_id FROM clone_map m WHERE m.kind = 'images' AND m.old_id = %s::bigint)", v)
		e = fmt.Sprintf(`(CASE WHEN jsonb_typeof(%[1]s->'%[2]s') IN ('number', 'string') AND %[3]s ~ '^[0-9]{1,18}$' THEN
			CASE WHEN %[4]s IS NULL THEN %[1]s - '%[2]s'
			     WHEN jsonb_typeof(%[1]s->'%[2]s') = 'number' THEN jsonb_set(%[1]s, '{%[2]s}', to_jsonb(%[4]s))
			     ELSE jsonb_set(%[1]s, '{%[2]s}', to_jsonb(%[4]s::text)) END
			ELSE %[1]s END)`, e, key, v, newID)
	}
	return fmt.Sprintf("(CASE WHEN %[1]s ?| ARRAY['floorPlanId', 'floorId'] THEN %[2]s ELSE %[1]s END)", col, e)
}

// memberOrNull keeps a user id only when that user is a member of the target.
func (c *cloner) memberOrNull(col string) string {
	if c.same {
		return "t." + col
	}
	return fmt.Sprintf("(CASE WHEN EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.tenant_id = {dst} AND ut.user_id = t.%[1]s) THEN t.%[1]s END)", col)
}

func (c *cloner) insert() error {
	zoneSet := map[string]string{
		"share_token": "NULL",
		"created_at":  "now()",
		"updated_at":  "now()",
	}
	var zoneArgs []any
	if len(c.o.ZoneIDs) == 1 && !c.o.Whole {
		if c.o.ZoneName != "" {
			zoneArgs = append(zoneArgs, c.o.ZoneName)
			zoneSet["name"] = fmt.Sprintf("$%d::text", len(zoneArgs))
		}
		if c.o.ZoneColor != "" {
			zoneArgs = append(zoneArgs, c.o.ZoneColor)
			zoneSet["color"] = fmt.Sprintf("$%d::text", len(zoneArgs))
		}
	}
	if !c.same {
		// A copy into another workspace starts private.
		zoneSet["is_public"] = "false"
	}
	if err := c.copyMapped("zones", zoneSet, zoneArgs...); err != nil {
		return err
	}
	for _, t := range cloneShapeTables {
		if err := c.copyMapped(t, nil); err != nil {
			return err
		}
	}
	if !c.same {
		if err := c.copyMapped("user_models", nil); err != nil {
			return err
		}
	}
	if err := c.copyMapped("data_sources", nil); err != nil {
		return err
	}
	if c.same {
		if err := c.copyMapped("streams", map[string]string{"data_source_id": cm("data_sources", "t.data_source_id")}); err != nil {
			return err
		}
	}
	if err := c.copyRows("bins", c.binsWhere("t"), map[string]string{
		"grid_id":     cm("grids", "t.grid_id"),
		"shape_id":    shapeRef("t.target_kind", "t.shape_id"),
		"sync_source": cm("data_sources", "t.sync_source"),
	}, false); err != nil {
		return err
	}

	// Files: the copy reuses the stored objects (cleanup refcounts them), and
	// the target owns them too so they show in its Files screen / library.
	if !c.same {
		where := "t.tenant_id = {src}"
		if !c.o.Whole {
			where += ` AND (t.zone_id = ANY({zones}) OR '/files/' || t.object_key IN (
				SELECT x.image_url FROM images x WHERE ` + copied("images", "x.id") + `
				UNION ALL SELECT x.image_url FROM image_planes x WHERE ` + copied("image_planes", "x.id") + `
				UNION ALL SELECT x.model_url FROM user_models x WHERE ` + copied("user_models", "x.id") + `))`
		}
		if err := c.copyRows("tenant_files", where, nil, true); err != nil {
			return err
		}
	}

	attr := "t.tenant_id = {src} AND t.zone_id = ANY({zones})"
	if !c.same {
		attr = "t.tenant_id = {src} AND (t.zone_id = ANY({zones}) OR t.zone_id IS NULL)"
	}
	if c.o.Whole {
		attr = "t.tenant_id = {src}"
	}
	if err := c.copyRows("attribute_definitions", attr, nil, true); err != nil {
		return err
	}

	srcWhere := "t.tenant_id = {src} AND " + copied("data_sources", "t.source_id")
	srcSet := map[string]string{"source_id": cm("data_sources", "t.source_id")}
	if err := c.copyRows("table_field_definitions", srcWhere, srcSet, false); err != nil {
		return err
	}
	if c.o.IncludeData {
		if err := c.copyRows("data_source_rows", srcWhere, map[string]string{
			"source_id": cm("data_sources", "t.source_id"),
			"payload":   payloadFloorExpr("t.payload"),
		}, false); err != nil {
			return err
		}
		if err := c.copyRows("source_files", srcWhere, srcSet, false); err != nil {
			return err
		}
		if c.o.IncludeHistory {
			ev := map[string]string{
				"source_id": cm("data_sources", "t.source_id"),
				"payload":   payloadFloorExpr("t.payload"),
			}
			if !c.same {
				ev["auth_token_id"] = "NULL" // tokens are not copied
			}
			if err := c.copyRows("data_source_row_events", srcWhere, ev, false); err != nil {
				return err
			}
		}
	}

	if err := c.copyMapped("style_rules", nil); err != nil {
		return err
	}
	if err := c.copyMapped("data_link_configs", map[string]string{
		"source_id":       cm("data_sources", "t.source_id"),
		"stream_id":       cm("streams", "t.stream_id"),
		"target_shape_id": shapeRef("t.target_kind", "t.target_shape_id"),
		"style_rule_ids": `ARRAY(SELECT m.new_id FROM unnest(t.style_rule_ids) WITH ORDINALITY u(v, i)
			JOIN clone_map m ON m.kind = 'style_rules' AND m.old_id = u.v ORDER BY u.i)`,
	}); err != nil {
		return err
	}

	if c.o.Reports {
		if err := c.copyMapped("reports", map[string]string{"created_at": "now()", "updated_at": "now()"}); err != nil {
			return err
		}
	}
	if c.o.Solutions {
		if err := c.copyMapped("solutions", map[string]string{"created_at": "now()", "updated_at": "now()"}); err != nil {
			return err
		}
		if err := c.copyRows("solution_items",
			"t.tenant_id = {src} AND "+mapped("solutions", "t.solution_id")+
				" AND (t.zone_id IS NULL OR "+copied("zones", "t.zone_id")+")"+
				" AND (t.report_id IS NULL OR "+copied("reports", "t.report_id")+")"+
				" AND (t.data_source_id IS NULL OR "+mapped("data_sources", "t.data_source_id")+")",
			map[string]string{
				"solution_id":    cm("solutions", "t.solution_id"),
				"report_id":      cm("reports", "t.report_id"),
				"data_source_id": cm("data_sources", "t.data_source_id"),
				"added_at":       "now()",
			}, true); err != nil {
			return err
		}
	}
	if c.o.AlertRules {
		set := map[string]string{
			"source_id":         cm("data_sources", "t.source_id"),
			"last_evaluated_at": "NULL",
			"last_error":        "''",
		}
		if !c.same {
			set["recipient_user_ids"] = `ARRAY(SELECT u FROM unnest(t.recipient_user_ids) u
				WHERE EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.tenant_id = {dst} AND ut.user_id = u))`
		}
		if err := c.copyMapped("alert_rules", set); err != nil {
			return err
		}
		if c.o.IncludeAlertHistory {
			if err := c.copyRows("alert_events", "t.tenant_id = {src} AND "+copied("alert_rules", "t.rule_id"), map[string]string{
				"rule_id":         cm("alert_rules", "t.rule_id"),
				"source_id":       cm("data_sources", "t.source_id"),
				"acknowledged_by": c.memberOrNull("acknowledged_by"),
				"resolved_by":     c.memberOrNull("resolved_by"),
			}, false); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *cloner) loadMaps() (map[string]map[int64]int64, error) {
	rows, err := c.tx.Query(c.ctx, `
		SELECT kind, old_id, new_id FROM clone_map
		WHERE kind = ANY(ARRAY['zones', 'images', 'lines', 'user_models', 'data_sources', 'data_link_configs'])`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[int64]int64{}
	for rows.Next() {
		var kind string
		var o, n int64
		if err := rows.Scan(&kind, &o, &n); err != nil {
			return nil, err
		}
		if out[kind] == nil {
			out[kind] = map[int64]int64{}
		}
		out[kind][o] = n
	}
	return out, rows.Err()
}

// ---- JSON references ---------------------------------------------------------

// cloneJSONColumns are the JSONB columns that hold row ids, with the keys
// that do. Keys match at any depth.
var cloneJSONColumns = []struct {
	table, col string
	keys       map[string]string // key → map kind
}{
	{"doors", "config", withFloorKeys(map[string]string{"attachedToLineId": "lines"})},
	{"models", "config", withFloorKeys(map[string]string{"modelAssetId": "user_models"})},
	{"stairs", "config", withFloorKeys(nil)},
	{"data_sources", "config", withFloorKeys(nil)},
	{"data_link_configs", "field_mapping", withFloorKeys(nil)},
	{"reports", "spec", withFloorKeys(map[string]string{
		"sourceId": "data_sources", "sourceIds": "data_sources",
		"dataLinkId": "data_link_configs", "dataLinkIds": "data_link_configs",
		"linkId": "data_link_configs", "known": "data_link_configs",
		"zoneId": "zones", "zoneIds": "zones",
	})},
}

func withFloorKeys(m map[string]string) map[string]string {
	out := map[string]string{
		"floorPlanId": "images", "fromFloorPlanId": "images", "toFloorPlanId": "images",
		"defaultFloorPlanId": "images", "floorPlanIds": "images", "servedFloorPlanIds": "images",
	}
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (c *cloner) rewriteJSON(maps map[string]map[int64]int64) error {
	for _, jc := range cloneJSONColumns {
		if jc.table == "reports" && !c.o.Reports {
			continue
		}
		rows, err := c.tx.Query(c.ctx, fmt.Sprintf(`
			SELECT t.id, t.%[2]s::text FROM %[1]s t
			JOIN clone_map m ON m.kind = '%[1]s' AND m.new_id = t.id AND m.copy
			WHERE t.%[2]s IS NOT NULL`, jc.table, jc.col))
		if err != nil {
			return err
		}
		var ids []int64
		var vals []string
		for rows.Next() {
			var id int64
			var raw string
			if err := rows.Scan(&id, &raw); err != nil {
				rows.Close()
				return err
			}
			out, changed, err := rewriteCloneJSON([]byte(raw), jc.keys, maps, jc.table == "reports")
			if err != nil {
				rows.Close()
				return fmt.Errorf("clone %s.%s %d: %w", jc.table, jc.col, id, err)
			}
			if changed {
				ids = append(ids, id)
				vals = append(vals, string(out))
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(ids) == 0 {
			continue
		}
		if _, err := c.tx.Exec(c.ctx, fmt.Sprintf(`
			UPDATE %[1]s SET %[2]s = v.c::jsonb
			FROM unnest($1::bigint[], $2::text[]) AS v(id, c)
			WHERE %[1]s.id = v.id`, jc.table, jc.col), ids, vals); err != nil {
			return err
		}
	}
	return nil
}

var reportOriginKeyRe = regexp.MustCompile(`^(source|master|ops):([0-9]+)(.*)$`)

// rewriteCloneJSON rewrites the ids under `keys` (at any depth) through
// maps. An id with no mapping is dropped. report=true also rewrites
// {kind:"dataSource", id} objects and the report origin key
// ("source:<id>", "master:<zone>", "ops:<zone>:…").
func rewriteCloneJSON(raw []byte, keys map[string]string, maps map[string]map[int64]int64, report bool) ([]byte, bool, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false, err
	}
	w := &jsonRewriter{keys: keys, maps: maps, report: report}
	v = w.walk(v)
	if report {
		if root, ok := v.(map[string]any); ok {
			if origin, ok := root["origin"].(map[string]any); ok {
				if key, ok := origin["key"].(string); ok {
					if m := reportOriginKeyRe.FindStringSubmatch(key); m != nil {
						kind := "zones"
						if m[1] == "source" {
							kind = "data_sources"
						}
						old, _ := strconv.ParseInt(m[2], 10, 64)
						if nu, ok := maps[kind][old]; ok && nu != old {
							origin["key"] = m[1] + ":" + strconv.FormatInt(nu, 10) + m[3]
							w.changed = true
						}
					}
				}
			}
		}
	}
	if !w.changed {
		return raw, false, nil
	}
	out, err := json.Marshal(v)
	return out, true, err
}

type jsonRewriter struct {
	keys    map[string]string
	maps    map[string]map[int64]int64
	report  bool
	changed bool
}

// remapNumber returns the new id for a JSON number, ok=false when unmapped.
func (w *jsonRewriter) remapNumber(kind string, v any) (any, bool) {
	n, isNum := v.(json.Number)
	if !isNum {
		return v, true // not an id: leave it
	}
	old, err := n.Int64()
	if err != nil {
		return v, true
	}
	nu, ok := w.maps[kind][old]
	if !ok {
		w.changed = true
		return nil, false
	}
	if nu != old {
		w.changed = true
	}
	return json.Number(strconv.FormatInt(nu, 10)), true
}

func (w *jsonRewriter) walk(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			kind, ok := w.keys[k]
			switch {
			case ok && k == "modelAssetId":
				s, isStr := val.(string)
				if !isStr || !strings.HasPrefix(s, "user_") {
					continue
				}
				old, err := strconv.ParseInt(strings.TrimPrefix(s, "user_"), 10, 64)
				if err != nil {
					continue
				}
				if nu, ok := w.maps[kind][old]; ok {
					if nu != old {
						t[k] = "user_" + strconv.FormatInt(nu, 10)
						w.changed = true
					}
				} else {
					delete(t, k)
					w.changed = true
				}
			case ok:
				if arr, isArr := val.([]any); isArr {
					out := make([]any, 0, len(arr))
					for _, el := range arr {
						if nv, keep := w.remapNumber(kind, el); keep {
							out = append(out, nv)
						}
					}
					t[k] = out
				} else if _, isNum := val.(json.Number); isNum {
					if nv, keep := w.remapNumber(kind, val); keep {
						t[k] = nv
					} else {
						delete(t, k)
					}
				} else {
					t[k] = w.walk(val)
				}
			default:
				t[k] = w.walk(val)
			}
		}
		if w.report && t["kind"] == "dataSource" {
			if id, isNum := t["id"].(json.Number); isNum {
				if nv, keep := w.remapNumber("data_sources", id); keep {
					t["id"] = nv
				} else {
					delete(t, "id")
				}
			}
		}
		return t
	case []any:
		for i := range t {
			t[i] = w.walk(t[i])
		}
		return t
	}
	return v
}
