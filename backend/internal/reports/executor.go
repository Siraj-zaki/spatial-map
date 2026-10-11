// Package reports implements the Report Builder query executor —
// the pipeline that translates a user-authored JSON spec into a safe
// parameterized SQL query over `data_source_rows` (the shared JSONB
// pool that user-defined tables, REST integrations, file imports, and
// webhook sinks all write into).
//
// The heavy lifting — argument binding, JSONB payload accessors, the
// identifier allow-list, per-op SQL emitters, and the filter-tree
// walker — lives in the shared kernel package [queryx]. This package
// wires those primitives into the report-shaped concerns: metric
// aggregation, GROUP BY / ORDER BY validation, source resolution,
// and the SELECT projection.
//
// Safety model (see queryx/doc.go for the shared invariants):
//
//  1. **Field allow-list from the source's own schema.** Every
//     `field` referenced by a filter, groupBy, metric, or sort is
//     verified to exist in `Source.Fields` before compilation. Table-
//     kind sources take the schema from `table_field_definitions`;
//     REST/file/webhook take it from `SampleDataSourceRowFields`.
//  2. **Identifier syntax lock at every emit site.** [queryx.SanitiseField]
//     re-checks every field name before it reaches SQL text, so a
//     compromised schema still can't smuggle a fragment through.
//  3. **Values ride in `$N` parameters, always.** No literal values
//     touch the SQL builder — every value goes through a positional
//     arg via [queryx.ArgBuilder].
//  4. **Hard row / LIMIT caps.** `Executor.MaxRows` clamps whatever
//     the caller (or the spec) asked for.
//  5. **Read-only intent.** The compiler only ever emits SELECT.
package reports

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ------------------------------------------------------------ types

// Spec is the JSON-shaped report spec persisted in `reports.spec` for
// v1 (single-query) reports. v2 (multi-query dashboards) lives in
// package [github.com/Siraj-zaki/spatial-map/backend/internal/reports/v2].
// This is intentionally permissive at the type layer — the compiler
// checks for internal consistency at execution time and returns a
// typed error the handler translates to 400.
type Spec struct {
	Sources []SourceRef `json:"sources"`
	Filters *Node       `json:"filters,omitempty"`
	GroupBy []string    `json:"groupBy,omitempty"`
	Metrics []Metric    `json:"metrics,omitempty"`
	Sort    []SortKey   `json:"sort,omitempty"`
	Limit   int         `json:"limit,omitempty"`
	Offset  int         `json:"offset,omitempty"`
}

// SourceRef points at a `data_sources` row. v1 supports one source
// per report; the shape is a slice so a future join spec can extend
// without breaking existing rows.
type SourceRef struct {
	Kind string `json:"kind"` // "table" | "dataSource"
	ID   int64  `json:"id"`
}

// Node and Cond are shared with [queryx] — the filter tree shape is
// the canonical representation both callers of the query kernel use.
type (
	Node = queryx.Node
	Cond = queryx.Cond
)

// Metric is one aggregation column in the SELECT list. `As` is the
// output column name — required so the widget bindings can address it
// without depending on the fn/field pair.
type Metric struct {
	Fn    string `json:"fn"` // count | countDistinct | sum | avg | min | max
	Field string `json:"field,omitempty"`
	As    string `json:"as"`
}

// SortKey is one column in the ORDER BY clause. `Field` may be either
// a payload field name (raw select) OR a metric `as` name (aggregated
// select). Direction is normalised to "asc" | "desc".
type SortKey struct {
	Field string `json:"field"`
	Dir   string `json:"dir"`
}

// ------------------------------------------------------------ source schema

// FieldType and Field are shared with [queryx] — the schema shape is
// common to every consumer of the query kernel.
type (
	FieldType = queryx.FieldType
	Field     = queryx.Field
)

// Re-export the FieldType constants so downstream packages that
// import `reports` can address them without an extra queryx import.
const (
	FieldText     = queryx.FieldText
	FieldNumber   = queryx.FieldNumber
	FieldBoolean  = queryx.FieldBoolean
	FieldDate     = queryx.FieldDate
	FieldDatetime = queryx.FieldDatetime
)

// Source is a resolved data source ready for execution: its identity,
// the schema the compiler uses as the field allow-list, and the
// display label the run-time surface shows.
type Source struct {
	ID     int64
	Kind   db.DataSourceKind
	Name   string
	Fields []Field
	// Facility is set for a built-in facility source (kind 'facility'):
	// rows come from the shape table, not data_source_rows.
	Facility *FacilityEntity
}

// from returns the FROM target, shaped like data_source_rows either way
// so the rest of the compiled query is the same for every source.
func (s *Source) from(tenantPh, sourcePh string) string {
	if s.Facility != nil {
		return "(\n" + s.Facility.fromSQL(tenantPh, sourcePh) + "\n) data_source_rows"
	}
	return "data_source_rows"
}

// schema returns the source's field set in queryx's canonical form.
func (s *Source) schema() queryx.FieldSet {
	return queryx.FieldSet(s.Fields)
}

// ResolveSource loads a source's schema. For kind='table' the field
// set is authoritative (from `table_field_definitions`); for
// kind='rest' | 'webhook' | 'file' the field set is inferred from the
// most recent 500 rows via `SampleDataSourceRowFields`. An empty
// inferred set is not an error — the report still runs; it just has
// nothing meaningful to filter on until at least one row lands.
func ResolveSource(ctx context.Context, q *db.Queries, tenantID int64, ref SourceRef) (*Source, error) {
	// v1 only supports source-backed reports — a `table:` ref is just a
	// convenience alias since a table IS a data_sources row with
	// kind='table'.
	src, err := q.GetDataSource(ctx, db.GetDataSourceParams{
		ID: ref.ID, TenantID: tenantID,
	})
	if err != nil {
		return nil, fmt.Errorf("source %d not found: %w", ref.ID, err)
	}
	out := &Source{
		ID:   src.ID,
		Kind: src.Kind,
		Name: src.Name,
	}
	if src.Kind == db.DataSourceKindFacility {
		e, ok := FacilityEntityByKey(FacilityEntityKey(src.Config))
		if !ok {
			return nil, fmt.Errorf("source %d: unknown facility entity", src.ID)
		}
		out.Facility = e
		out.Fields = append(out.Fields, e.Fields...)
	} else if src.Kind == db.DataSourceKindTable {
		defs, err := q.ListTableFieldDefinitions(ctx, db.ListTableFieldDefinitionsParams{
			TenantID: tenantID, SourceID: src.ID,
		})
		if err != nil {
			return nil, err
		}
		for _, d := range defs {
			out.Fields = append(out.Fields, Field{
				Key:   d.FieldKey,
				Label: d.FieldLabel,
				Type:  mapDataType(d.DataType),
			})
		}
	} else {
		// Sample-based schema — text type for everything, since we
		// have no declared types. Users can still filter on numeric
		// values by choosing a numeric operator; the compiler will
		// cast the payload accessor at that site.
		rows, err := q.SampleDataSourceRowFields(ctx, db.SampleDataSourceRowFieldsParams{
			SourceID: src.ID, TenantID: tenantID, Limit: 500,
		})
		if err != nil {
			return nil, err
		}
		for _, k := range rows {
			if k == "" {
				continue
			}
			out.Fields = append(out.Fields, Field{
				Key: k, Label: k, Type: FieldText,
			})
		}
		sort.Slice(out.Fields, func(i, j int) bool {
			return out.Fields[i].Key < out.Fields[j].Key
		})
	}
	return out, nil
}

// mapDataType translates the string data_type on
// `table_field_definitions` into the coarse compiler classification.
// Unknown types default to text — the executor still runs, just with
// text semantics for anything it can't classify.
func mapDataType(dt string) FieldType {
	switch dt {
	case "number", "integer":
		return FieldNumber
	case "boolean":
		return FieldBoolean
	case "date":
		return FieldDate
	case "datetime", "time":
		return FieldDatetime
	default:
		return FieldText
	}
}

// ------------------------------------------------------------ result shape

// Result is what `Executor.Run` returns to the handler. Columns are
// the shaped column set (payload-projected or aggregate); Rows carry
// one value per column in the same order. All values are pgx-decoded
// natives (string / float64 / bool / time.Time / nil).
type Result struct {
	Columns []Column `json:"columns"`
	Rows    [][]any  `json:"rows"`
}

// Column is one column in the result set.
type Column struct {
	Name string    `json:"name"`
	Type FieldType `json:"type"`
}

// ------------------------------------------------------------ executor

// Executor holds the read pool + a few knobs the handler can override.
// A single instance is safe for concurrent use.
type Executor struct {
	Pool    *pgxpool.Pool
	MaxRows int // hard cap on the number of rows returned; clamped in Run
}

// NewExecutor builds an executor with sane defaults.
func NewExecutor(pool *pgxpool.Pool) *Executor {
	return &Executor{Pool: pool, MaxRows: 10_000}
}

// Run compiles a spec against a resolved source and executes it. The
// tenant id is passed explicitly (not derived from the spec) so the
// compiler can bind it to a dedicated positional arg and the WHERE
// clause always includes it first.
func (e *Executor) Run(ctx context.Context, tenantID int64, src *Source, spec Spec) (Result, error) {
	if src == nil {
		return Result{}, errors.New("no source")
	}
	limit := spec.Limit
	if limit <= 0 || limit > e.MaxRows {
		limit = e.MaxRows
	}
	sqlText, args, cols, err := compile(tenantID, src, spec, limit)
	if err != nil {
		return Result{}, err
	}
	// Statement timeout: 30s. A long-running report is almost always
	// misconfigured — either the LIMIT is missing or the filter is too
	// broad — and holding a pool connection open past that hurts every
	// other user of the API.
	execCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	rows, err := e.Pool.Query(execCtx, sqlText, args...)
	if err != nil {
		return Result{}, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()
	// Always ship `Rows` as an initialized slice so the JSON response
	// is `[]` (never `null`) when the query has zero results — the
	// SPA calls `.length` on it in several places and a null slice
	// crashes the viewer.
	out := Result{Columns: cols, Rows: [][]any{}}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return Result{}, fmt.Errorf("scan: %w", err)
		}
		out.Rows = append(out.Rows, vals)
	}
	if err := rows.Err(); err != nil {
		return Result{}, fmt.Errorf("rows: %w", err)
	}
	return out, nil
}

// ------------------------------------------------------------ compiler

// compile turns a validated spec into (sqlText, args, columns, err).
// Args are ordered so `$1 = tenantID, $2 = sourceID`, then filter
// values in tree order, then paging.
func compile(tenantID int64, src *Source, spec Spec, limit int) (string, []any, []Column, error) {
	ab := &queryx.ArgBuilder{}
	tenantPh := ab.Add(tenantID)
	sourcePh := ab.Add(src.ID)

	// SELECT + column set.
	selectParts, columns, err := compileSelect(src, spec)
	if err != nil {
		return "", nil, nil, err
	}
	sqlText := "SELECT " + strings.Join(selectParts, ", ") + "\nFROM " + src.from(tenantPh, sourcePh) + "\n"
	sqlText += "WHERE tenant_id = " + tenantPh + " AND source_id = " + sourcePh

	// Filters — delegate the whole tree walk to the shared kernel.
	if spec.Filters != nil {
		clause, err := queryx.CompileNode(*spec.Filters, src.schema(), ab)
		if err != nil {
			return "", nil, nil, err
		}
		if clause != "" {
			sqlText += "\n  AND " + clause
		}
	}

	// GROUP BY — only when aggregations are present. GroupBy without
	// metrics reduces to DISTINCT via the SELECT list itself.
	//
	// The GROUP BY expression MUST match the SELECT expression exactly:
	// if `status` is a number-typed column we project it as
	// `(payload->>'status')::numeric` in the SELECT, so GROUP BY has to
	// use the same casted expression. Grouping on the bare
	// `payload->>'status'` (text) leaves Postgres unable to match the
	// numeric-cast projection to any GROUP BY term, and it reports
	// "column data_source_rows.payload must appear in the GROUP BY
	// clause" — pointing at the base JSONB column, not the accessor.
	if len(spec.Metrics) > 0 && len(spec.GroupBy) > 0 {
		groups := make([]string, 0, len(spec.GroupBy))
		for _, g := range spec.GroupBy {
			f, ok := src.schema().ByKey(g)
			if !ok {
				return "", nil, nil, fmt.Errorf("groupBy field not in schema: %q", g)
			}
			groups = append(groups, queryx.NativeAccessor(f))
		}
		sqlText += "\nGROUP BY " + strings.Join(groups, ", ")
	}

	// ORDER BY. `field` may be either a schema field key or a metric
	// `as` name — BUT when the query is aggregated (any metric present),
	// Postgres treats every non-aggregate reference in ORDER BY the same
	// way it treats one in SELECT: it must be either an aggregate or an
	// expression that appears in GROUP BY. A sort on a schema field that
	// isn't in `groupBy` produces exactly the reported error message
	// ("column data_source_rows.payload must appear in the GROUP BY
	// clause") because Postgres traces the bare `payload->>'field'`
	// accessor back to the base column when it can't match it. We reject
	// that shape here with a 400-friendly message so the builder can
	// steer the user to a legal sort target.
	aggregated := len(spec.Metrics) > 0
	metricNames := map[string]bool{}
	for _, m := range spec.Metrics {
		metricNames[m.As] = true
	}
	groupByNames := map[string]bool{}
	for _, g := range spec.GroupBy {
		groupByNames[g] = true
	}
	if len(spec.Sort) > 0 {
		orderParts := make([]string, 0, len(spec.Sort))
		for _, s := range spec.Sort {
			if _, err := queryx.SanitiseField(s.Field); err != nil {
				return "", nil, nil, fmt.Errorf("sort field: %w", err)
			}
			dir := "ASC"
			if strings.EqualFold(s.Dir, "desc") {
				dir = "DESC"
			}
			if metricNames[s.Field] {
				// Aggregates are already in the SELECT list under a
				// legal identifier; ORDER BY can reference them by
				// name. Quote the identifier to survive case sensitivity.
				orderParts = append(orderParts, fmt.Sprintf("%q %s NULLS LAST", s.Field, dir))
				continue
			}
			f, ok := src.schema().ByKey(s.Field)
			if !ok {
				return "", nil, nil, fmt.Errorf("sort field not in schema: %q", s.Field)
			}
			if aggregated && !groupByNames[s.Field] {
				return "", nil, nil, fmt.Errorf(
					"sort field %q is not aggregated and not in groupBy — pick a metric alias or a groupBy field",
					s.Field,
				)
			}
			orderParts = append(orderParts, queryx.NativeAccessor(f)+" "+dir+" NULLS LAST")
		}
		sqlText += "\nORDER BY " + strings.Join(orderParts, ", ")
	}

	sqlText += "\nLIMIT " + strconv.Itoa(limit)
	if spec.Offset > 0 {
		sqlText += " OFFSET " + strconv.Itoa(spec.Offset)
	}
	return sqlText, ab.Values(), columns, nil
}

// compileSelect builds the SELECT list based on whether metrics /
// groupBy are set. Three modes:
//   - No metrics, no groupBy → raw payload projection (all schema fields).
//   - No metrics, groupBy present → DISTINCT projection of the group fields.
//   - Metrics present → group fields + aggregates.
func compileSelect(src *Source, spec Spec) ([]string, []Column, error) {
	if len(spec.Metrics) == 0 && len(spec.GroupBy) == 0 {
		parts := make([]string, 0, len(src.Fields)+1)
		cols := make([]Column, 0, len(src.Fields)+1)
		// entity_key first — every widget wants a stable row id.
		parts = append(parts, `entity_key AS "entity_key"`)
		cols = append(cols, Column{Name: "entity_key", Type: FieldText})
		for _, f := range src.Fields {
			if !queryx.IsValidIdentifier(f.Key) {
				continue
			}
			parts = append(parts, queryx.NativeAccessor(f)+" AS "+strconv.Quote(f.Key))
			cols = append(cols, Column{Name: f.Key, Type: f.Type})
		}
		return parts, cols, nil
	}

	if len(spec.Metrics) == 0 {
		// GroupBy without metrics = DISTINCT projection.
		parts := make([]string, 0, len(spec.GroupBy))
		cols := make([]Column, 0, len(spec.GroupBy))
		parts = append(parts, "DISTINCT")
		for _, g := range spec.GroupBy {
			f, ok := src.schema().ByKey(g)
			if !ok {
				return nil, nil, fmt.Errorf("groupBy field not in schema: %q", g)
			}
			parts = append(parts, queryx.NativeAccessor(f)+" AS "+strconv.Quote(g))
			cols = append(cols, Column{Name: g, Type: f.Type})
		}
		// Compact the DISTINCT + list into one comma-separated element.
		combined := parts[0] + " " + strings.Join(parts[1:], ", ")
		return []string{combined}, cols, nil
	}

	// Aggregates.
	parts := make([]string, 0, len(spec.GroupBy)+len(spec.Metrics))
	cols := make([]Column, 0, len(spec.GroupBy)+len(spec.Metrics))
	for _, g := range spec.GroupBy {
		f, ok := src.schema().ByKey(g)
		if !ok {
			return nil, nil, fmt.Errorf("groupBy field not in schema: %q", g)
		}
		parts = append(parts, queryx.NativeAccessor(f)+" AS "+strconv.Quote(g))
		cols = append(cols, Column{Name: g, Type: f.Type})
	}
	for _, m := range spec.Metrics {
		if _, err := queryx.SanitiseField(m.As); err != nil {
			return nil, nil, fmt.Errorf("metric `as`: %w", err)
		}
		agg, colType, err := compileMetric(m, src)
		if err != nil {
			return nil, nil, err
		}
		parts = append(parts, agg+" AS "+strconv.Quote(m.As))
		cols = append(cols, Column{Name: m.As, Type: colType})
	}
	return parts, cols, nil
}

// compileMetric emits the aggregation expression for one metric. The
// returned FieldType is what the shaped column will hold (count →
// number always; sum/avg/etc → number; min/max → carry the source
// column's type).
func compileMetric(m Metric, src *Source) (string, FieldType, error) {
	switch m.Fn {
	case "count":
		if m.Field == "" {
			return "COUNT(*)::bigint", FieldNumber, nil
		}
		f, ok := src.schema().ByKey(m.Field)
		if !ok {
			return "", "", fmt.Errorf("count field not in schema: %q", m.Field)
		}
		return "COUNT(" + queryx.TextAccessor(f) + ")::bigint", FieldNumber, nil
	case "countDistinct":
		if m.Field == "" {
			return "", "", errors.New("countDistinct requires a field")
		}
		f, ok := src.schema().ByKey(m.Field)
		if !ok {
			return "", "", fmt.Errorf("countDistinct field not in schema: %q", m.Field)
		}
		return "COUNT(DISTINCT " + queryx.TextAccessor(f) + ")::bigint", FieldNumber, nil
	case "sum", "avg", "min", "max":
		if m.Field == "" {
			return "", "", fmt.Errorf("%s requires a field", m.Fn)
		}
		f, ok := src.schema().ByKey(m.Field)
		if !ok {
			return "", "", fmt.Errorf("%s field not in schema: %q", m.Fn, m.Field)
		}
		// Numeric aggregates always cast to numeric so the compiler
		// doesn't have to trust the declared type — a text-typed
		// column that happens to hold digits still aggregates.
		expr := "(" + queryx.TextAccessor(f) + ")::numeric"
		fn := strings.ToUpper(m.Fn)
		agg := fn + "(" + expr + ")::float8"
		outType := FieldNumber
		if m.Fn == "min" || m.Fn == "max" {
			outType = f.Type
		}
		return agg, outType, nil
	default:
		return "", "", fmt.Errorf("unknown metric fn: %q", m.Fn)
	}
}
