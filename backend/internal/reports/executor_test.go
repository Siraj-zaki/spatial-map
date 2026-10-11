package reports

import (
	"strings"
	"testing"
)

// Regression tests for the compile step. The executor talks to Postgres,
// so these tests only cover the compiler — they inspect the produced
// SQL text without running it against a database.

func mockSource(fields ...Field) *Source {
	return &Source{ID: 42, Name: "test", Fields: fields}
}

// TestCompile_GroupBySelectAndGroupExpressionsMatch guards against the
// regression that shipped as part of Phase 2 and blew up on the first
// real report:
//
//	ERROR: column "data_source_rows.payload" must appear in the GROUP
//	BY clause or be used in an aggregate function
//
// The compiler used to emit `(payload->>'x')::numeric` in the SELECT
// list for a number-typed groupBy field but the untyped
// `payload->>'x'` in the GROUP BY clause. Postgres cannot match the
// two expressions and complains about the base column. Fix: the GROUP
// BY expression uses the same cast as the SELECT projection.
func TestCompile_GroupBySelectAndGroupExpressionsMatch(t *testing.T) {
	cases := []struct {
		name       string
		fieldType  FieldType
		wantSelect string
		wantGroup  string
	}{
		{
			name:       "text",
			fieldType:  FieldText,
			wantSelect: `payload ->> 'status' AS "status"`,
			wantGroup:  "GROUP BY payload ->> 'status'",
		},
		{
			name:       "number",
			fieldType:  FieldNumber,
			wantSelect: `(payload ->> 'status')::numeric AS "status"`,
			wantGroup:  "GROUP BY (payload ->> 'status')::numeric",
		},
		{
			name:       "boolean",
			fieldType:  FieldBoolean,
			wantSelect: `(payload ->> 'status')::boolean AS "status"`,
			wantGroup:  "GROUP BY (payload ->> 'status')::boolean",
		},
		{
			name:       "date",
			fieldType:  FieldDate,
			wantSelect: `(payload ->> 'status')::date AS "status"`,
			wantGroup:  "GROUP BY (payload ->> 'status')::date",
		},
		{
			name:       "datetime",
			fieldType:  FieldDatetime,
			wantSelect: `(payload ->> 'status')::timestamptz AS "status"`,
			wantGroup:  "GROUP BY (payload ->> 'status')::timestamptz",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := mockSource(Field{Key: "status", Label: "status", Type: tc.fieldType})
			spec := Spec{
				Sources: []SourceRef{{Kind: "dataSource", ID: src.ID}},
				GroupBy: []string{"status"},
				Metrics: []Metric{{Fn: "count", As: "total"}},
			}
			sqlText, _, _, err := compile(1, src, spec, 100)
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			if !strings.Contains(sqlText, tc.wantSelect) {
				t.Errorf("SELECT missing expected projection\n want: %s\n got:  %s", tc.wantSelect, sqlText)
			}
			if !strings.Contains(sqlText, tc.wantGroup) {
				t.Errorf("GROUP BY does not match SELECT expression\n want: %s\n got:  %s", tc.wantGroup, sqlText)
			}
		})
	}
}

// TestCompile_GroupByWithoutMetricsUsesDistinct verifies the DISTINCT
// path fires when groupBy is set but no metrics are — the same shape
// makes semantic sense (unique combinations of the grouped fields).
func TestCompile_GroupByWithoutMetricsUsesDistinct(t *testing.T) {
	src := mockSource(Field{Key: "status", Type: FieldText})
	spec := Spec{
		Sources: []SourceRef{{Kind: "dataSource", ID: src.ID}},
		GroupBy: []string{"status"},
	}
	sqlText, _, _, err := compile(1, src, spec, 100)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(sqlText, "DISTINCT") {
		t.Errorf("expected DISTINCT for groupBy-without-metrics\n got: %s", sqlText)
	}
	if strings.Contains(sqlText, "GROUP BY") {
		t.Errorf("did not expect GROUP BY when metrics are empty\n got: %s", sqlText)
	}
}

// TestCompile_FilterFieldMustBeInSchema is a small sanity check that
// the field allow-list is doing its job — the executor's first safety
// layer. A caller-supplied field the source doesn't declare is a hard
// error, not a silent no-op.
func TestCompile_FilterFieldMustBeInSchema(t *testing.T) {
	src := mockSource(Field{Key: "known", Type: FieldText})
	spec := Spec{
		Sources: []SourceRef{{Kind: "dataSource", ID: src.ID}},
		Filters: &Node{Cond: &Cond{Field: "unknown", Op: "eq", Value: []byte(`"x"`)}},
	}
	if _, _, _, err := compile(1, src, spec, 100); err == nil {
		t.Fatalf("expected error for filter on unknown field")
	}
}

// TestCompile_SortInAggregateContextRejectsUngroupedField locks in the
// second regression from the same bug report: when the query is
// aggregated (any metric present), an ORDER BY on a schema field that
// isn't in GROUP BY produces exactly the reported error at the
// database ("column data_source_rows.payload must appear in the GROUP
// BY clause"), because Postgres treats the ORDER BY expression as
// requiring aggregation or grouping just like SELECT does. The
// compiler now rejects that shape up front with a builder-friendly
// message, and the frontend sort picker filters accordingly.
func TestCompile_SortInAggregateContextRejectsUngroupedField(t *testing.T) {
	src := mockSource(
		Field{Key: "status", Type: FieldText},
		Field{Key: "created_at", Type: FieldDatetime},
	)
	spec := Spec{
		Sources: []SourceRef{{Kind: "dataSource", ID: src.ID}},
		GroupBy: []string{"status"},
		Metrics: []Metric{{Fn: "count", As: "total"}},
		// created_at is a valid schema field but is NEITHER in
		// groupBy NOR a metric alias — this is the shape the bug
		// report hit.
		Sort: []SortKey{{Field: "created_at", Dir: "desc"}},
	}
	_, _, _, err := compile(1, src, spec, 100)
	if err == nil {
		t.Fatalf("expected compile error for sort on ungrouped field in aggregate context")
	}
	if !strings.Contains(err.Error(), "groupBy") && !strings.Contains(err.Error(), "aggregated") {
		t.Errorf("error message should steer the caller to a legal sort target: %v", err)
	}
}

// TestCompile_EmptyValueFilterIsSkipped locks in the runtime-prompt
// behavior: a filter with an empty value on a value-required op does
// NOT appear in the WHERE clause. This is what makes empty-slot
// filters in the builder function as viewer-side runtime prompts.
// The corresponding bug it defends against: a filter of `status = ""`
// used to match rows whose status was literally the empty string,
// which surprised users who left the value blank thinking "no filter".
func TestCompile_EmptyValueFilterIsSkipped(t *testing.T) {
	src := mockSource(Field{Key: "status", Type: FieldText})
	cases := []struct {
		name  string
		value []byte
	}{
		{"missing", nil},
		{"empty-string-literal", []byte(`""`)},
		{"null-literal", []byte("null")},
		{"empty-array", []byte("[]")},
		{"whitespace-only", []byte("   ")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spec := Spec{
				Sources: []SourceRef{{Kind: "dataSource", ID: src.ID}},
				Filters: &Node{Cond: &Cond{Field: "status", Op: "eq", Value: tc.value}},
			}
			sqlText, args, _, err := compile(1, src, spec, 100)
			if err != nil {
				t.Fatalf("empty-value filter should compile: %v", err)
			}
			// A skipped filter emits NO `AND` clause after the base
			// `WHERE tenant_id / source_id` and adds NO extra positional
			// args beyond the two fixed ones ($1 tenant, $2 source).
			if strings.Contains(sqlText, " AND payload") || strings.Contains(sqlText, " AND (") {
				t.Errorf("empty-value filter should have been skipped, but WHERE has extra clauses:\n%s", sqlText)
			}
			if len(args) != 2 {
				t.Errorf("empty-value filter should add no positional args; got %d args", len(args))
			}
		})
	}
}

// TestCompile_ValuelessOpStaysActive verifies that `isnull` / `notnull`
// don't get silently dropped when they have no value — those ops are
// value-free by design.
func TestCompile_ValuelessOpStaysActive(t *testing.T) {
	src := mockSource(Field{Key: "status", Type: FieldText})
	for _, op := range []string{"isnull", "notnull"} {
		t.Run(op, func(t *testing.T) {
			spec := Spec{
				Sources: []SourceRef{{Kind: "dataSource", ID: src.ID}},
				Filters: &Node{Cond: &Cond{Field: "status", Op: op}},
			}
			sqlText, _, _, err := compile(1, src, spec, 100)
			if err != nil {
				t.Fatalf("%s should compile: %v", op, err)
			}
			if !strings.Contains(sqlText, "payload") {
				t.Errorf("%s should have generated a WHERE clause referencing payload:\n%s", op, sqlText)
			}
		})
	}
}

// TestCompile_SortInAggregateContextAllowsGroupByAndMetric verifies
// the two shapes that ARE legal in an aggregated query still compile:
// sorting on a groupBy field, or sorting on a metric alias.
func TestCompile_SortInAggregateContextAllowsGroupByAndMetric(t *testing.T) {
	src := mockSource(Field{Key: "status", Type: FieldText})
	base := Spec{
		Sources: []SourceRef{{Kind: "dataSource", ID: src.ID}},
		GroupBy: []string{"status"},
		Metrics: []Metric{{Fn: "count", As: "total"}},
	}
	byGroup := base
	byGroup.Sort = []SortKey{{Field: "status", Dir: "asc"}}
	if _, _, _, err := compile(1, src, byGroup, 100); err != nil {
		t.Fatalf("sort on groupBy field should compile: %v", err)
	}
	byMetric := base
	byMetric.Sort = []SortKey{{Field: "total", Dir: "desc"}}
	sqlText, _, _, err := compile(1, src, byMetric, 100)
	if err != nil {
		t.Fatalf("sort on metric alias should compile: %v", err)
	}
	if !strings.Contains(sqlText, `"total" DESC`) {
		t.Errorf("metric-alias sort should be quoted-identifier ORDER BY, got:\n%s", sqlText)
	}
}
