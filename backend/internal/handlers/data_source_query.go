// Package handlers — v4 data-source schema + advanced filter query.
//
// Two endpoints:
//
//	GET  /api/v1/data-sources/:id/schema
//	     Returns detected payload fields with inferred types, distinct
//	     value counts, numeric min/max, and (for low-cardinality
//	     fields) sample distinct values. Feeds the filter widget's
//	     type-aware controls without shipping all rows to the client.
//
//	POST /api/v1/data-sources/:id/query
//	     Executes a filter DSL against `data_source_rows.payload` via
//	     parameterized PostgreSQL JSONB queries. Supports AND/OR
//	     trees, all the operators declared on the FE, limit/offset,
//	     and a floor filter that reads `payload->>'floorPlanId'` or
//	     `floorId` or `floor`. Only reads the tenant-scoped source's
//	     rows (checked before executing the filter).
//
// Both endpoints are safe against SQL injection: field paths and
// operators are validated against an allow-list; values go through
// $-parameters only.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
	"github.com/jackc/pgx/v5/pgxpool"
)

// -------------------------------------------- schema

// FieldSchema describes one detected payload field. `type` is inferred
// from the value observed across all sampled rows; if the sampled rows
// disagree (some strings, some numbers) we fall through to `string`.
type FieldSchema struct {
	// Top-level key on the payload object. Nested paths are not
	// enumerated here — the filter widget accepts a raw path in the
	// custom-input escape.
	Field         string   `json:"field"`
	Type          string   `json:"type"` // string | number | boolean | date | unknown
	NonNullCount  int64    `json:"nonNullCount"`
	DistinctCount int64    `json:"distinctCount"`
	Sample        []string `json:"sample,omitempty"` // up to 20 distinct string reps
	NumericMin    *float64 `json:"numericMin,omitempty"`
	NumericMax    *float64 `json:"numericMax,omitempty"`
}

// DataSourceSchemaResponse is what the SPA sees.
type DataSourceSchemaResponse struct {
	Fields   []FieldSchema `json:"fields"`
	RowCount int64         `json:"rowCount"`
}

func dataSourceSchemaHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.Error(w, http.StatusUnauthorized, "tenant scope required")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid data-source id")
			return
		}
		if _, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		}); err != nil {
			api.NotFound(w, "data_source not found")
			return
		}

		// One-shot introspection using two aggregation queries. The
		// first counts rows so we have a denominator; the second
		// enumerates every top-level key across the payload JSONB and
		// derives its type + min/max + sample.
		var rowCount int64
		if err := pool.QueryRow(r.Context(),
			`SELECT COUNT(*) FROM data_source_rows WHERE tenant_id = $1 AND source_id = $2`,
			tenantID, sourceID,
		).Scan(&rowCount); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// Per-key aggregation. `jsonb_each` explodes the object; we
		// group by key and derive per-column stats. `sample` is capped
		// at 20 distinct string representations (excludes NULLs).
		rows, err := pool.Query(r.Context(), `
			WITH exploded AS (
				SELECT key,
				       value,
				       jsonb_typeof(value) AS jtype
				FROM data_source_rows,
				     LATERAL jsonb_each(payload)
				WHERE tenant_id = $1 AND source_id = $2
			)
			SELECT
				key,
				COUNT(*) FILTER (WHERE value IS NOT NULL AND jtype != 'null') AS non_null_count,
				COUNT(DISTINCT value) AS distinct_count,
				-- Numeric bounds (only rows where jtype = 'number')
				MIN(CASE WHEN jtype = 'number' THEN (value #>> '{}')::numeric END) AS num_min,
				MAX(CASE WHEN jtype = 'number' THEN (value #>> '{}')::numeric END) AS num_max,
				-- Sample: up to 20 distinct string reps
				(
					SELECT array_agg(DISTINCT (s.v)::text ORDER BY (s.v)::text)
					FROM (
						SELECT (value #>> '{}') AS v FROM exploded e2 WHERE e2.key = exploded.key AND value IS NOT NULL AND jtype != 'null' LIMIT 500
					) s
				) AS sample_raw,
				-- Type inference — the majority jtype (number > date-shape > bool > string).
				MODE() WITHIN GROUP (ORDER BY jtype) AS majority_type
			FROM exploded
			GROUP BY key
			ORDER BY non_null_count DESC, key
			LIMIT 200
		`, tenantID, sourceID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rows.Close()

		out := DataSourceSchemaResponse{RowCount: rowCount, Fields: []FieldSchema{}}
		for rows.Next() {
			var (
				field          string
				nonNull        int64
				distinct       int64
				numMin, numMax *float64
				sampleRaw      []string
				majorityType   *string
			)
			if err := rows.Scan(&field, &nonNull, &distinct, &numMin, &numMax, &sampleRaw, &majorityType); err != nil {
				api.InternalError(w, r, err)
				return
			}
			inferred := inferFieldType(majorityType, sampleRaw)
			// Cap sample to 20 to keep the response light.
			sample := sampleRaw
			if len(sample) > 20 {
				sample = sample[:20]
			}
			out.Fields = append(out.Fields, FieldSchema{
				Field:         field,
				Type:          inferred,
				NonNullCount:  nonNull,
				DistinctCount: distinct,
				Sample:        sample,
				NumericMin:    numMin,
				NumericMax:    numMax,
			})
		}
		if err := rows.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// inferFieldType maps Postgres jsonb_typeof + a value sample to the
// FE's DataLinkFieldType vocabulary.
func inferFieldType(majorityType *string, sample []string) string {
	if majorityType == nil {
		return "unknown"
	}
	switch *majorityType {
	case "number":
		return "number"
	case "boolean":
		return "boolean"
	case "string":
		// Try date-shape detection on the sample. If most values parse
		// as RFC3339 or ISO-8601, mark as date. Cheap and covers most
		// real-world "timestamp in JSON" cases.
		if looksLikeDates(sample) {
			return "date"
		}
		return "string"
	default:
		return "unknown"
	}
}

func looksLikeDates(sample []string) bool {
	if len(sample) == 0 {
		return false
	}
	hits := 0
	limit := len(sample)
	if limit > 10 {
		limit = 10
	}
	for _, s := range sample[:limit] {
		if s == "" {
			continue
		}
		if _, err := time.Parse(time.RFC3339, s); err == nil {
			hits++
			continue
		}
		if _, err := time.Parse("2006-01-02", s); err == nil {
			hits++
			continue
		}
		if _, err := time.Parse("2006-01-02 15:04:05", s); err == nil {
			hits++
		}
	}
	return hits*2 >= limit // majority of the sample
}

// -------------------------------------------- query DSL

// FilterOp is validated against a static allow-list before we build
// any SQL. Anything else is rejected with 400.
type FilterOp string

const (
	OpEq         FilterOp = "eq"
	OpNeq        FilterOp = "neq"
	OpGt         FilterOp = "gt"
	OpGte        FilterOp = "gte"
	OpLt         FilterOp = "lt"
	OpLte        FilterOp = "lte"
	OpBetween    FilterOp = "between"
	OpContains   FilterOp = "contains"
	OpStartsWith FilterOp = "startsWith"
	OpEndsWith   FilterOp = "endsWith"
	OpRegex      FilterOp = "regex"
	OpIn         FilterOp = "in"
	OpNotIn      FilterOp = "notIn"
	OpExists     FilterOp = "exists"
	OpMissing    FilterOp = "missing"
	OpBefore     FilterOp = "before"
	OpAfter      FilterOp = "after"
	OpLastNDays  FilterOp = "lastNDays"
	OpNextNDays  FilterOp = "nextNDays"
)

var validOps = map[FilterOp]bool{
	OpEq: true, OpNeq: true, OpGt: true, OpGte: true, OpLt: true, OpLte: true,
	OpBetween: true, OpContains: true, OpStartsWith: true, OpEndsWith: true,
	OpRegex: true, OpIn: true, OpNotIn: true, OpExists: true, OpMissing: true,
	OpBefore: true, OpAfter: true, OpLastNDays: true, OpNextNDays: true,
}

// FilterNode is either a condition (leaf) or a group. Discriminated
// by `Kind`. Recursion depth is enforced during compile (see
// compileNode).
type FilterNode struct {
	Kind       string          `json:"kind"`              // "condition" | "group"
	Combine    string          `json:"combine,omitempty"` // "and" | "or"
	Conditions []FilterNode    `json:"conditions,omitempty"`
	Field      string          `json:"field,omitempty"`
	Type       string          `json:"type,omitempty"`
	Op         FilterOp        `json:"op,omitempty"`
	Value      json.RawMessage `json:"value,omitempty"`
}

// QueryRequest is the /query endpoint body.
type QueryRequest struct {
	Filter       *FilterNode `json:"filter,omitempty"`
	FloorPlanID  *int64      `json:"floorPlanId,omitempty"`
	Limit        int         `json:"limit,omitempty"`
	Offset       int         `json:"offset,omitempty"`
	IncludeCount bool        `json:"includeCount,omitempty"`
}

// QueryResponse is what the SPA sees.
type QueryResponse struct {
	Rows       []DataSourceRowResponse `json:"rows"`
	TotalCount *int64                  `json:"totalCount,omitempty"`
	Truncated  bool                    `json:"truncated"`
}

const (
	defaultQueryLimit = 500
	maxQueryLimit     = 5000
	maxFilterDepth    = 8
	maxFilterNodes    = 64
)

func dataSourceQueryHandler(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		if tenantID == 0 {
			api.Error(w, http.StatusUnauthorized, "tenant scope required")
			return
		}
		sourceID, err := parseIDFromPath(r, "id")
		if err != nil {
			api.BadRequest(w, "invalid data-source id")
			return
		}
		if _, err := q.GetDataSource(r.Context(), db.GetDataSourceParams{
			ID: sourceID, TenantID: tenantID,
		}); err != nil {
			api.NotFound(w, "data_source not found")
			return
		}

		var req QueryRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		if req.Limit <= 0 {
			req.Limit = defaultQueryLimit
		}
		if req.Limit > maxQueryLimit {
			req.Limit = maxQueryLimit
		}
		if req.Offset < 0 {
			req.Offset = 0
		}

		// Compile the filter tree into an SQL fragment + arg list.
		compiler := NewFilterCompiler(tenantID, sourceID)
		if err := compiler.PushBase(); err != nil {
			api.InternalError(w, r, err)
			return
		}
		if req.Filter != nil {
			if err := compiler.PushFilter(req.Filter, 0, 0); err != nil {
				api.BadRequest(w, err.Error())
				return
			}
		}
		if req.FloorPlanID != nil {
			compiler.PushFloor(*req.FloorPlanID)
		}

		whereSQL := strings.Join(compiler.wheres, " AND ")
		listSQL := fmt.Sprintf(`
			SELECT id, source_id, entity_key, payload,
			       ST_AsText(position) AS position_wkt,
			       COALESCE(linked_shape_name, '') AS linked_shape_name,
			       ts, updated_at
			FROM data_source_rows
			WHERE %s
			ORDER BY ts DESC
			LIMIT $%d OFFSET $%d
		`, whereSQL, len(compiler.args)+1, len(compiler.args)+2)
		listArgs := append(append([]any{}, compiler.args...), req.Limit, req.Offset)

		rowsQ, err := pool.Query(r.Context(), listSQL, listArgs...)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer rowsQ.Close()

		out := QueryResponse{Rows: []DataSourceRowResponse{}}
		for rowsQ.Next() {
			var (
				id, sid                int64
				entityKey, linkedShape string
				payload                []byte
				wkt                    *string
				ts, updatedAt          time.Time
			)
			if err := rowsQ.Scan(&id, &sid, &entityKey, &payload, &wkt, &linkedShape, &ts, &updatedAt); err != nil {
				api.InternalError(w, r, err)
				return
			}
			var wktStr string
			if wkt != nil {
				wktStr = *wkt
			}
			out.Rows = append(out.Rows, DataSourceRowResponse{
				ID:              id,
				SourceID:        sid,
				EntityKey:       entityKey,
				Payload:         json.RawMessage(payload),
				Position:        parseWktPoint(wktStr),
				LinkedShapeName: linkedShape,
				TS:              ts.Format(time.RFC3339),
				UpdatedAt:       updatedAt.Format(time.RFC3339),
			})
		}
		if err := rowsQ.Err(); err != nil {
			api.InternalError(w, r, err)
			return
		}

		if len(out.Rows) == req.Limit {
			out.Truncated = true
		}

		if req.IncludeCount {
			countSQL := fmt.Sprintf(
				`SELECT COUNT(*) FROM data_source_rows WHERE %s`, whereSQL,
			)
			var total int64
			if err := pool.QueryRow(r.Context(), countSQL, compiler.args...).Scan(&total); err != nil {
				api.InternalError(w, r, err)
				return
			}
			out.TotalCount = &total
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// -------------------------------------------- compiler

// FilterCompiler accumulates WHERE fragments + $-args. Every value goes
// through the args slot; no client-supplied string is ever spliced into
// SQL text. Field names ARE spliced but only after the whitelist check
// via `sanitiseField`, and even then they are quoted inside JSON path
// text (payload->>'field') where escaping is via replace().
type FilterCompiler struct {
	args      []any
	wheres    []string
	nodeCount int
}

func NewFilterCompiler(tenantID, sourceID int64) *FilterCompiler {
	return &FilterCompiler{args: []any{tenantID, sourceID}}
}

// PushBase seeds the tenant + source scope. Always $1 + $2.
func (c *FilterCompiler) PushBase() error {
	c.wheres = append(c.wheres, "tenant_id = $1", "source_id = $2")
	return nil
}

// PushFloor appends a payload-side floor gate. Reads three commonly-used
// keys via a coalesce so publishers can use whichever they prefer.
//
// The value goes to Postgres as a string, NOT an int, because
// `payload->>'x'` returns text — mixing an int64 arg with a text-typed
// column would leave pgx without an encode plan ("cannot find encode
// plan for OID 25"). Publishers routinely emit floor ids as either
// numbers or strings in JSON; the extra ::int cast on the LHS lets
// the numeric-JSON case match too.
func (c *FilterCompiler) PushFloor(floorID int64) {
	c.args = append(c.args, fmt.Sprint(floorID))
	idx := len(c.args)
	c.wheres = append(c.wheres, fmt.Sprintf(
		`(COALESCE(payload->>'floorPlanId', payload->>'floorId', payload->>'floor') = $%d)`,
		idx,
	))
}

// PushFilter recursively compiles a filter tree.
func (c *FilterCompiler) PushFilter(n *FilterNode, depth, siblingIdx int) error {
	if depth > maxFilterDepth {
		return errors.New("filter tree too deep")
	}
	c.nodeCount++
	if c.nodeCount > maxFilterNodes {
		return errors.New("filter has too many nodes")
	}
	switch n.Kind {
	case "group":
		if len(n.Conditions) == 0 {
			return nil // empty group is a no-op
		}
		combine := "AND"
		if strings.EqualFold(n.Combine, "or") {
			combine = "OR"
		}
		var parts []string
		child := &FilterCompiler{args: c.args, nodeCount: c.nodeCount}
		for i := range n.Conditions {
			before := len(child.wheres)
			if err := child.PushFilter(&n.Conditions[i], depth+1, i); err != nil {
				return err
			}
			// Everything added by this child becomes ONE parenthesised
			// clause so combine semantics compose cleanly.
			added := child.wheres[before:]
			if len(added) == 0 {
				continue
			}
			parts = append(parts, "("+strings.Join(added, " AND ")+")")
			child.wheres = child.wheres[:before]
		}
		c.args = child.args
		c.nodeCount = child.nodeCount
		if len(parts) == 0 {
			return nil
		}
		c.wheres = append(c.wheres, "("+strings.Join(parts, " "+combine+" ")+")")
		return nil
	case "condition", "":
		return c.pushLeaf(n)
	default:
		return fmt.Errorf("unknown filter node kind %q", n.Kind)
	}
}

// typedCompareExpr maps a field-type hint onto the cast the comparison
// needs, reporting false when the type says nothing useful and the
// caller should fall back to its value heuristic.
//
// Two vocabularies arrive here: `inferFieldType`'s inferred set
// (number/boolean/date/string) and the declared `data_type` of a
// user-defined table's field (see `src/lib/table-field-types.ts`). They
// disagree on the temporal names — a declared `datetime` used to miss
// the `date` branch and silently compare as text — so both are listed.
func typedCompareExpr(fieldType, numExpr, tsExpr string) (string, bool) {
	switch fieldType {
	case "number", "integer":
		return numExpr, true
	case "date", "datetime", "time":
		return tsExpr, true
	default:
		return "", false
	}
}

// pushLeaf compiles one condition against the JSONB payload.
func (c *FilterCompiler) pushLeaf(n *FilterNode) error {
	if n.Field == "" {
		return errors.New("filter condition missing field")
	}
	if !validOps[n.Op] {
		return fmt.Errorf("unsupported operator %q", n.Op)
	}
	field, err := queryx.SanitiseField(n.Field)
	if err != nil {
		return err
	}
	// Text extraction (payload->>'field'). We only support top-level
	// keys for now; nested paths would need `#>>` syntax. Escape
	// single quotes to prevent breaking the SQL string.
	textExpr := fmt.Sprintf(`payload->>'%s'`, strings.ReplaceAll(field, "'", "''"))
	numExpr := fmt.Sprintf(`(%s)::numeric`, textExpr)
	tsExpr := fmt.Sprintf(`(%s)::timestamptz`, textExpr)

	switch n.Op {
	case OpExists:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s IS NOT NULL AND %s != '')`, textExpr, textExpr))
		return nil
	case OpMissing:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s IS NULL OR %s = '')`, textExpr, textExpr))
		return nil
	case OpBetween:
		var pair [2]json.RawMessage
		if err := json.Unmarshal(n.Value, &pair); err != nil {
			return fmt.Errorf("between requires [lo, hi]: %w", err)
		}
		lo, err := jsonToNumberOrString(pair[0])
		if err != nil {
			return err
		}
		hi, err := jsonToNumberOrString(pair[1])
		if err != nil {
			return err
		}
		c.args = append(c.args, lo, hi)
		iLo, iHi := len(c.args)-1, len(c.args)
		// Pick the LHS expression based on the field type hint the FE
		// sent alongside the condition (populated by the schema call).
		// Fall back to numeric if the bounds parse as numbers,
		// otherwise text compare.
		expr, ok := typedCompareExpr(n.Type, numExpr, tsExpr)
		if !ok {
			expr = textExpr
			if _, err := strconv.ParseFloat(lo, 64); err == nil {
				if _, err := strconv.ParseFloat(hi, 64); err == nil {
					expr = numExpr
				}
			}
		}
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s BETWEEN $%d AND $%d)`, expr, iLo, iHi))
		return nil
	case OpIn, OpNotIn:
		var arr []json.RawMessage
		if err := json.Unmarshal(n.Value, &arr); err != nil {
			return fmt.Errorf("in/notIn requires an array: %w", err)
		}
		if len(arr) == 0 {
			// Empty in → nothing matches; empty notIn → everything.
			if n.Op == OpIn {
				c.wheres = append(c.wheres, "FALSE")
			}
			return nil
		}
		placeholders := make([]string, 0, len(arr))
		for _, raw := range arr {
			v, err := jsonToNumberOrString(raw)
			if err != nil {
				return err
			}
			c.args = append(c.args, fmt.Sprint(v))
			placeholders = append(placeholders, fmt.Sprintf("$%d", len(c.args)))
		}
		notPrefix := ""
		if n.Op == OpNotIn {
			notPrefix = "NOT "
		}
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s %sIN (%s))`, textExpr, notPrefix, strings.Join(placeholders, ", ")))
		return nil
	case OpLastNDays, OpNextNDays:
		var days int
		if err := json.Unmarshal(n.Value, &days); err != nil {
			return fmt.Errorf("%s requires integer days: %w", n.Op, err)
		}
		if days < 0 {
			return fmt.Errorf("%s days must be non-negative", n.Op)
		}
		interval := fmt.Sprintf("%d days", days)
		c.args = append(c.args, interval)
		if n.Op == OpLastNDays {
			c.wheres = append(c.wheres, fmt.Sprintf(
				`(%s >= now() - ($%d)::interval AND %s <= now())`,
				tsExpr, len(c.args), tsExpr,
			))
		} else {
			c.wheres = append(c.wheres, fmt.Sprintf(
				`(%s <= now() + ($%d)::interval AND %s >= now())`,
				tsExpr, len(c.args), tsExpr,
			))
		}
		return nil
	}

	// Single-value comparisons. Coerce to appropriate type based on
	// hint (`n.Type`) OR fall through to text.
	raw, err := jsonToNumberOrString(n.Value)
	if err != nil {
		return err
	}
	c.args = append(c.args, raw)
	i := len(c.args)

	switch n.Op {
	case OpEq:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s = $%d::text)`, textExpr, i))
	case OpNeq:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s IS DISTINCT FROM $%d::text)`, textExpr, i))
	case OpGt, OpGte, OpLt, OpLte:
		cmp := map[FilterOp]string{OpGt: ">", OpGte: ">=", OpLt: "<", OpLte: "<="}[n.Op]
		// Pick the LHS expression on n.Type first (comes from the
		// schema), then heuristic: if the value parses as a number,
		// numeric compare; otherwise text.
		expr, ok := typedCompareExpr(n.Type, numExpr, tsExpr)
		if !ok {
			expr = textExpr
			if _, err := strconv.ParseFloat(raw, 64); err == nil {
				expr = numExpr
			}
		}
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s %s $%d)`, expr, cmp, i))
	case OpContains:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s ILIKE '%%' || $%d || '%%')`, textExpr, i))
	case OpStartsWith:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s ILIKE $%d || '%%')`, textExpr, i))
	case OpEndsWith:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s ILIKE '%%' || $%d)`, textExpr, i))
	case OpRegex:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s ~ $%d)`, textExpr, i))
	case OpBefore:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s < $%d::timestamptz)`, tsExpr, i))
	case OpAfter:
		c.wheres = append(c.wheres, fmt.Sprintf(`(%s > $%d::timestamptz)`, tsExpr, i))
	default:
		return fmt.Errorf("operator %q not implemented", n.Op)
	}
	return nil
}

// jsonToNumberOrString accepts any JSON scalar and returns its text
// representation. Every arg goes to Postgres as a string because
// `payload->>'field'` returns text — mixing typed args with text-typed
// columns leaves pgx without a stable encode plan ("cannot find encode
// plan for OID 25"). Numeric / date operators cast on the SQL side
// (`::numeric`, `::timestamptz`) which accept string input just fine.
func jsonToNumberOrString(raw json.RawMessage) (string, error) {
	// Numbers first — normalise integers to their unquoted form so
	// ::numeric casts get the tightest lexical rep.
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		if f == float64(int64(f)) {
			return strconv.FormatInt(int64(f), 10), nil
		}
		return strconv.FormatFloat(f, 'f', -1, 64), nil
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err == nil {
		if b {
			return "true", nil
		}
		return "false", nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s, nil
	}
	return "", errors.New("value must be number, boolean, or string")
}

// -------------------------------------------- context helper

// Ensure context param is imported cleanly.
var _ = context.Background
