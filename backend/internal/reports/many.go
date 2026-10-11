package reports

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports/interpolate"
	v2 "github.com/Siraj-zaki/spatial-map/backend/internal/reports/v2"
	"golang.org/x/sync/errgroup"
)

// runManyConcurrency caps how many query goroutines the executor lets
// run in parallel per dashboard invocation. Each query has its own 30s
// statement timeout — a semaphore prevents N parallel queries from
// pinning N connections for the full 30s worst-case. Chosen to match
// the pool's warm-connection default; tune together if the pool
// changes.
const runManyConcurrency = 8

// QueryResult is one named query's outcome inside a dashboard run.
type QueryResult struct {
	Name      string `json:"name"`
	Result    Result `json:"result"`
	Err       string `json:"error,omitempty"`
	MsElapsed int    `json:"msElapsed"`
	RowCount  int    `json:"rowCount"`

	// SQL is the compiled SQL text for debugging / auditing. Not
	// serialised in production responses (the handler drops it before
	// echoing back).
	SQL string `json:"-"`
}

// ManyResult aggregates every query's outcome under one dashboard run.
type ManyResult struct {
	Queries   map[string]QueryResult `json:"queries"`
	MsElapsed int                    `json:"msElapsed"`
}

// RunMany executes every named query in the spec concurrently, keyed
// by query name. `sources` must map each query's Name to the resolved
// source it operates on — the handler does the ResolveSource walk so
// the executor doesn't need db.Queries.
//
// Per-query safety:
//   - Runs in its own goroutine with a per-query 30s statement timeout.
//   - Row cap defaults to Executor.MaxRows.
//   - Interpolation applies params to filter values (as $N binds) and
//     to any [v2.Query.ExtraFilter] (as a rendered fragment).
//   - A query that errors does NOT abort the group — its QueryResult
//     carries the error string; sibling queries proceed. The handler
//     decides the HTTP status.
func (e *Executor) RunMany(
	ctx context.Context,
	tenantID int64,
	sources map[string]*Source,
	spec v2.Spec,
	params map[string]interpolate.ParamValue,
) (ManyResult, error) {
	if len(spec.Queries) == 0 {
		return ManyResult{Queries: map[string]QueryResult{}}, nil
	}

	sema := make(chan struct{}, runManyConcurrency)
	group, groupCtx := errgroup.WithContext(ctx)

	var mu sync.Mutex
	out := ManyResult{Queries: make(map[string]QueryResult, len(spec.Queries))}

	overallStart := time.Now()

	for _, q := range spec.Queries {
		q := q // capture
		src, ok := sources[q.Name]
		if !ok {
			mu.Lock()
			out.Queries[q.Name] = QueryResult{Name: q.Name, Err: "source not resolved"}
			mu.Unlock()
			continue
		}
		group.Go(func() error {
			select {
			case sema <- struct{}{}:
			case <-groupCtx.Done():
				return nil
			}
			defer func() { <-sema }()

			qr := e.runOneQuery(groupCtx, tenantID, src, q, params)
			mu.Lock()
			out.Queries[q.Name] = qr
			mu.Unlock()
			// Never propagate — partial failure is a first-class outcome.
			return nil
		})
	}

	if err := group.Wait(); err != nil {
		return out, err
	}
	out.MsElapsed = int(time.Since(overallStart).Milliseconds())
	return out, nil
}

// runOneQuery compiles + executes a single named query. Wraps errors
// into the QueryResult so the caller (RunMany) can proceed with the
// rest of the dashboard.
func (e *Executor) runOneQuery(
	ctx context.Context,
	tenantID int64,
	src *Source,
	q v2.Query,
	params map[string]interpolate.ParamValue,
) QueryResult {
	qr := QueryResult{Name: q.Name}
	start := time.Now()

	limit := q.Limit
	if limit <= 0 || limit > e.MaxRows {
		limit = e.MaxRows
	}

	sqlText, args, cols, err := compileV2Query(tenantID, src, q, limit, params)
	if err != nil {
		qr.Err = err.Error()
		qr.MsElapsed = int(time.Since(start).Milliseconds())
		return qr
	}
	qr.SQL = sqlText

	execCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	rows, err := e.Pool.Query(execCtx, sqlText, args...)
	if err != nil {
		qr.Err = fmt.Errorf("query: %w", err).Error()
		qr.MsElapsed = int(time.Since(start).Milliseconds())
		return qr
	}
	defer rows.Close()

	qr.Result = Result{Columns: cols, Rows: [][]any{}}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			qr.Err = fmt.Errorf("scan: %w", err).Error()
			qr.MsElapsed = int(time.Since(start).Milliseconds())
			return qr
		}
		qr.Result.Rows = append(qr.Result.Rows, vals)
	}
	if err := rows.Err(); err != nil {
		qr.Err = fmt.Errorf("rows: %w", err).Error()
		qr.MsElapsed = int(time.Since(start).Milliseconds())
		return qr
	}

	qr.RowCount = len(qr.Result.Rows)
	qr.MsElapsed = int(time.Since(start).Milliseconds())
	return qr
}

// compileV2Query is the v2 sibling of [compile]. Structural difference
// from v1: filter values may embed `{{param.x}}` markers (resolved to
// bound args before compilation), and there is an optional
// [v2.Query.ExtraFilter] SQL-template slot.
func compileV2Query(
	tenantID int64,
	src *Source,
	q v2.Query,
	limit int,
	params map[string]interpolate.ParamValue,
) (string, []any, []Column, error) {
	if src == nil {
		return "", nil, nil, errors.New("no source")
	}

	ab := &queryx.ArgBuilder{}
	tenantPh := ab.Add(tenantID)
	sourcePh := ab.Add(src.ID)

	// Wrap the v1 Spec projection helpers by converting the query to
	// an equivalent Spec — same fields, same semantics.
	shim := Spec{
		Sources: []SourceRef{{Kind: q.SourceRef.Kind, ID: q.SourceRef.ID}},
		GroupBy: q.GroupBy,
		Metrics: convertMetrics(q.Metrics),
		Sort:    convertSort(q.Sort),
		Limit:   q.Limit,
		Offset:  q.Offset,
	}

	selectParts, columns, err := compileSelect(src, shim)
	if err != nil {
		return "", nil, nil, err
	}
	sqlText := "SELECT " + strings.Join(selectParts, ", ") + "\nFROM " + src.from(tenantPh, sourcePh) + "\n"
	sqlText += "WHERE tenant_id = " + tenantPh + " AND source_id = " + sourcePh

	// Filters — resolve template markers in each leaf value first, then
	// compile via the shared kernel. ResolveScalarJSON returns raw
	// unchanged when a value slot isn't a template.
	if q.Filters != nil {
		resolved, err := resolveFilterTemplates(*q.Filters, params)
		if err != nil {
			return "", nil, nil, err
		}
		clause, err := queryx.CompileNode(resolved, src.schema(), ab)
		if err != nil {
			return "", nil, nil, err
		}
		if clause != "" {
			sqlText += "\n  AND " + clause
		}
	}

	// ExtraFilter — the SQL-template slot for KindPredicate params.
	// The interpolate engine masks comments + strips zero-width chars,
	// then renders each `{{param.x}}` marker either as a bound `$N` or
	// as a server-produced predicate fragment.
	if strings.TrimSpace(q.ExtraFilter) != "" {
		frag, _, err := interpolate.CompileText(q.ExtraFilter, params, src.schema(), ab)
		if err != nil {
			return "", nil, nil, fmt.Errorf("extraFilter: %w", err)
		}
		if s := strings.TrimSpace(frag); s != "" {
			sqlText += "\n  AND (" + s + ")"
		}
	}

	// GROUP BY (identical semantics to v1).
	if len(q.Metrics) > 0 && len(q.GroupBy) > 0 {
		groups := make([]string, 0, len(q.GroupBy))
		for _, g := range q.GroupBy {
			f, ok := src.schema().ByKey(g)
			if !ok {
				return "", nil, nil, fmt.Errorf("groupBy field not in schema: %q", g)
			}
			groups = append(groups, queryx.NativeAccessor(f))
		}
		sqlText += "\nGROUP BY " + strings.Join(groups, ", ")
	}

	// ORDER BY (identical semantics to v1).
	aggregated := len(q.Metrics) > 0
	metricNames := map[string]bool{}
	for _, m := range q.Metrics {
		metricNames[m.As] = true
	}
	groupByNames := map[string]bool{}
	for _, g := range q.GroupBy {
		groupByNames[g] = true
	}
	if len(q.Sort) > 0 {
		orderParts := make([]string, 0, len(q.Sort))
		for _, s := range q.Sort {
			if _, err := queryx.SanitiseField(s.Field); err != nil {
				return "", nil, nil, fmt.Errorf("sort field: %w", err)
			}
			dir := "ASC"
			if strings.EqualFold(s.Dir, "desc") {
				dir = "DESC"
			}
			if metricNames[s.Field] {
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
	if q.Offset > 0 {
		sqlText += " OFFSET " + strconv.Itoa(q.Offset)
	}
	return sqlText, ab.Values(), columns, nil
}

// resolveFilterTemplates walks the tree and substitutes any leaf
// value that is a single `{{param.x}}` marker with the referenced
// param's JSON encoding. Runs before compilation so the compiler
// treats resolved values as literal client input.
func resolveFilterTemplates(root queryx.Node, params map[string]interpolate.ParamValue) (queryx.Node, error) {
	var walk func(n queryx.Node) (queryx.Node, error)
	walk = func(n queryx.Node) (queryx.Node, error) {
		out := queryx.Node{}
		if len(n.And) > 0 {
			out.And = make([]queryx.Node, len(n.And))
			for i, c := range n.And {
				child, err := walk(c)
				if err != nil {
					return queryx.Node{}, err
				}
				out.And[i] = child
			}
			return out, nil
		}
		if len(n.Or) > 0 {
			out.Or = make([]queryx.Node, len(n.Or))
			for i, c := range n.Or {
				child, err := walk(c)
				if err != nil {
					return queryx.Node{}, err
				}
				out.Or[i] = child
			}
			return out, nil
		}
		if n.Cond != nil {
			resolved, _, err := interpolate.ResolveScalarJSON(n.Cond.Value, params)
			if err != nil {
				return queryx.Node{}, err
			}
			out.Cond = &queryx.Cond{Field: n.Cond.Field, Op: n.Cond.Op, Value: resolved}
		}
		return out, nil
	}
	return walk(root)
}

// convertMetrics / convertSort bridge v2 <-> v1 shapes for the shared
// compileSelect helper. Field-for-field identical today; declared
// explicitly so future divergence stays honest.
func convertMetrics(ms []v2.Metric) []Metric {
	out := make([]Metric, len(ms))
	for i, m := range ms {
		out[i] = Metric{Fn: m.Fn, Field: m.Field, As: m.As}
	}
	return out
}

func convertSort(ss []v2.SortKey) []SortKey {
	out := make([]SortKey, len(ss))
	for i, s := range ss {
		out[i] = SortKey{Field: s.Field, Dir: s.Dir}
	}
	return out
}
