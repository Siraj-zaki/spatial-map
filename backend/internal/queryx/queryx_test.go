package queryx

import (
	"encoding/json"
	"strings"
	"testing"
)

var demoSchema = FieldSet{
	{Key: "status", Type: FieldText},
	{Key: "qty", Type: FieldNumber},
	{Key: "created", Type: FieldDatetime},
	{Key: "active", Type: FieldBoolean},
}

func TestSanitiseField(t *testing.T) {
	good := []string{"status", "customer_id", "field.nested", "a-b_c.d", strings.Repeat("x", 128)}
	for _, g := range good {
		if _, err := SanitiseField(g); err != nil {
			t.Errorf("SanitiseField(%q) unexpected err: %v", g, err)
		}
	}
	bad := []string{"", "1; DROP TABLE reports", "status'; --", "a b", "a\nb", strings.Repeat("x", 129)}
	for _, b := range bad {
		if _, err := SanitiseField(b); err == nil {
			t.Errorf("SanitiseField(%q) should have failed", b)
		}
	}
}

func TestArgBuilder(t *testing.T) {
	ab := &ArgBuilder{}
	if got := ab.Add("a"); got != "$1" {
		t.Errorf("first placeholder = %q, want $1", got)
	}
	if got := ab.Add(42); got != "$2" {
		t.Errorf("second placeholder = %q, want $2", got)
	}
	if got := ab.Len(); got != 2 {
		t.Errorf("Len = %d, want 2", got)
	}
	vals := ab.Values()
	if len(vals) != 2 || vals[0] != "a" || vals[1] != 42 {
		t.Errorf("Values = %#v, want [a 42]", vals)
	}
}

func TestPayloadAccessor(t *testing.T) {
	cases := []struct {
		field Field
		as    FieldType
		want  string
	}{
		{Field{Key: "status", Type: FieldText}, FieldText, `payload ->> 'status'`},
		{Field{Key: "qty", Type: FieldNumber}, FieldNumber, `(payload ->> 'qty')::numeric`},
		{Field{Key: "active", Type: FieldBoolean}, FieldBoolean, `(payload ->> 'active')::boolean`},
		{Field{Key: "d", Type: FieldDate}, FieldDate, `(payload ->> 'd')::date`},
		{Field{Key: "ts", Type: FieldDatetime}, FieldDatetime, `(payload ->> 'ts')::timestamptz`},
		// text projection of a numeric field
		{Field{Key: "qty", Type: FieldNumber}, FieldText, `payload ->> 'qty'`},
	}
	for _, c := range cases {
		got := PayloadAccessor(c.field, c.as)
		if got != c.want {
			t.Errorf("PayloadAccessor(%v, %v) = %q, want %q", c.field, c.as, got, c.want)
		}
	}
}

func TestPgLitEscaping(t *testing.T) {
	if got := PgLit(`o'brien`); got != `'o''brien'` {
		t.Errorf("PgLit escape wrong: %q", got)
	}
}

func TestResolveOpAliases(t *testing.T) {
	cases := map[string]Op{
		"eq":         OpEq,
		"starts":     OpStartsWith,
		"startsWith": OpStartsWith,
		"ends":       OpEndsWith,
		"endsWith":   OpEndsWith,
		"in":         OpIn,
		"nin":        OpNin,
		"notIn":      OpNin,
		"isnull":     OpIsNull,
		"missing":    OpIsNull,
		"notnull":    OpNotNull,
		"exists":     OpNotNull,
	}
	for in, want := range cases {
		got, ok := ResolveOp(in)
		if !ok || got != want {
			t.Errorf("ResolveOp(%q) = %q,%v, want %q", in, got, ok, want)
		}
	}
	if _, ok := ResolveOp("mystery"); ok {
		t.Error("mystery op should not resolve")
	}
}

// Every canonical op must be in the registry with a non-nil emitter.
func TestRegistryComplete(t *testing.T) {
	canonical := []Op{OpEq, OpNeq, OpLt, OpLte, OpGt, OpGte, OpIn, OpNin,
		OpContains, OpStartsWith, OpEndsWith, OpRegex,
		OpIsNull, OpNotNull, OpBetween, OpBefore, OpAfter, OpLastNDays, OpNextNDays,
		OpOnOrAfter, OpOnOrBefore}
	for _, op := range canonical {
		def, ok := Registry[op]
		if !ok {
			t.Errorf("Registry missing %q", op)
			continue
		}
		if def.Emit == nil {
			t.Errorf("Registry[%q].Emit is nil", op)
		}
	}
}

func TestCompileCond_Eq(t *testing.T) {
	ab := &ArgBuilder{}
	sql, err := CompileCond(Cond{Field: "status", Op: "eq", Value: json.RawMessage(`"active"`)}, demoSchema, ab)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if sql != `payload ->> 'status' = $1` {
		t.Errorf("sql = %q", sql)
	}
	if got := ab.Values()[0]; got != "active" {
		t.Errorf("arg = %v", got)
	}
}

func TestCompileCond_In_EmptyIsFalse(t *testing.T) {
	ab := &ArgBuilder{}
	sql, err := CompileCond(Cond{Field: "status", Op: "in", Value: json.RawMessage(`[]`)}, demoSchema, ab)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	// (empty value trips inactive check when arity requires values —
	// but IN is arity=array; the emitter returns FALSE directly. We
	// route through CompileCond, not CompileNode, so no inactive skip.)
	if sql != "FALSE" {
		t.Errorf("empty in should be FALSE, got %q", sql)
	}
}

func TestCompileCond_UnknownField(t *testing.T) {
	ab := &ArgBuilder{}
	_, err := CompileCond(Cond{Field: "unknown", Op: "eq", Value: json.RawMessage(`"x"`)}, demoSchema, ab)
	if err == nil {
		t.Error("expected error for unknown field")
	}
}

func TestCompileCond_InjectionAttempts(t *testing.T) {
	// Field-name injection: reject before compile.
	badFields := []string{`status'; DROP TABLE`, `status OR 1=1`, `status --`}
	for _, bad := range badFields {
		ab := &ArgBuilder{}
		_, err := CompileCond(Cond{Field: bad, Op: "eq", Value: json.RawMessage(`"x"`)}, demoSchema, ab)
		if err == nil {
			t.Errorf("injected field %q should have been rejected", bad)
		}
	}
	// Value injection: value ends up as a bound arg (should be quoted).
	ab := &ArgBuilder{}
	sql, err := CompileCond(Cond{Field: "status", Op: "eq", Value: json.RawMessage(`"'; DROP TABLE reports; --"`)}, demoSchema, ab)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(sql, "$1") {
		t.Errorf("value not bound as arg: %q", sql)
	}
	if strings.Contains(sql, "DROP") {
		t.Errorf("value literal leaked into SQL: %q", sql)
	}
}

func TestCompileNode_AndOr(t *testing.T) {
	ab := &ArgBuilder{}
	node := Node{And: []Node{
		{Cond: &Cond{Field: "status", Op: "eq", Value: json.RawMessage(`"a"`)}},
		{Or: []Node{
			{Cond: &Cond{Field: "qty", Op: "gt", Value: json.RawMessage(`5`)}},
			{Cond: &Cond{Field: "qty", Op: "lt", Value: json.RawMessage(`1`)}},
		}},
	}}
	sql, err := CompileNode(node, demoSchema, ab)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	// Verify structure and arg count without depending on exact whitespace.
	if !strings.Contains(sql, " AND ") || !strings.Contains(sql, " OR ") {
		t.Errorf("expected AND/OR joiners: %q", sql)
	}
	if got := len(ab.Values()); got != 3 {
		t.Errorf("arg count = %d, want 3", got)
	}
}

func TestCondIsInactive(t *testing.T) {
	cases := []struct {
		c    Cond
		want bool
	}{
		{Cond{Op: "eq", Value: nil}, true},
		{Cond{Op: "eq", Value: json.RawMessage(``)}, true},
		{Cond{Op: "eq", Value: json.RawMessage(`""`)}, true},
		{Cond{Op: "eq", Value: json.RawMessage(`null`)}, true},
		{Cond{Op: "eq", Value: json.RawMessage(`[]`)}, true},
		{Cond{Op: "eq", Value: json.RawMessage(`"   "`)}, true},
		{Cond{Op: "eq", Value: json.RawMessage(`"active"`)}, false},
		{Cond{Op: "eq", Value: json.RawMessage(`5`)}, false},
		// value-free ops always fire regardless of value payload
		{Cond{Op: "isnull", Value: nil}, false},
		{Cond{Op: "notnull", Value: json.RawMessage(`""`)}, false},
		{Cond{Op: "exists", Value: nil}, false},
	}
	for _, c := range cases {
		if got := CondIsInactive(c.c); got != c.want {
			t.Errorf("CondIsInactive(%+v) = %v, want %v", c.c, got, c.want)
		}
	}
}

func TestRenderColumnPredicate_MultiValueBecomesIn(t *testing.T) {
	ab := &ArgBuilder{}
	p := Predicate{Columns: []PredicateColumn{
		{Field: "status", Values: []json.RawMessage{json.RawMessage(`"a"`), json.RawMessage(`"b"`)}},
	}}
	sql, err := RenderColumnPredicate(p, demoSchema, ab)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(sql, "ANY(") {
		t.Errorf("multi-value should render as ANY: %q", sql)
	}
	if len(ab.Values()) != 1 {
		t.Errorf("array binds as one arg, got %d", len(ab.Values()))
	}
}

func TestRenderColumnPredicate_SingleValueBecomesEq(t *testing.T) {
	ab := &ArgBuilder{}
	p := Predicate{Columns: []PredicateColumn{
		{Field: "status", Values: []json.RawMessage{json.RawMessage(`"active"`)}},
	}}
	sql, err := RenderColumnPredicate(p, demoSchema, ab)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(sql, " = $1") {
		t.Errorf("single-value should render as eq: %q", sql)
	}
}

func TestRenderColumnPredicate_FieldSanitised(t *testing.T) {
	ab := &ArgBuilder{}
	p := Predicate{Columns: []PredicateColumn{
		{Field: "status'; DROP", Values: []json.RawMessage{json.RawMessage(`"x"`)}},
	}}
	if _, err := RenderColumnPredicate(p, demoSchema, ab); err == nil {
		t.Error("bad field should be rejected")
	}
}

func TestRenderColumnPredicate_Empty(t *testing.T) {
	ab := &ArgBuilder{}
	if got, _ := RenderColumnPredicate(Predicate{}, demoSchema, ab); got != "" {
		t.Errorf("empty predicate should render as empty, got %q", got)
	}
	// A predicate with columns but no values also renders empty.
	if got, _ := RenderColumnPredicate(Predicate{Columns: []PredicateColumn{{Field: "status"}}}, demoSchema, ab); got != "" {
		t.Errorf("values-less predicate should render as empty, got %q", got)
	}
}

func TestRenderColumnPredicate_CombinesColumns(t *testing.T) {
	ab := &ArgBuilder{}
	p := Predicate{Columns: []PredicateColumn{
		{Field: "status", Values: []json.RawMessage{json.RawMessage(`"a"`)}},
		{Field: "qty", Op: "gt", Values: []json.RawMessage{json.RawMessage(`5`)}},
	}}
	sql, err := RenderColumnPredicate(p, demoSchema, ab)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(sql, " AND ") {
		t.Errorf("two columns should AND: %q", sql)
	}
}

// Viewer params arrive as strings ("true") even for boolean fields.
func TestScalarArg_BooleanFromString(t *testing.T) {
	for raw, want := range map[string]bool{`true`: true, `"true"`: true, `"false"`: false, `false`: false} {
		got, err := ScalarArg(json.RawMessage(raw), FieldBoolean)
		if err != nil || got != want {
			t.Fatalf("ScalarArg(%s) = %v, %v; want %v", raw, got, err, want)
		}
	}
	if _, err := ScalarArg(json.RawMessage(`"maybe"`), FieldBoolean); err == nil {
		t.Fatal("non-boolean string must still fail")
	}
}

// Whole-day comparisons take the date part only and refuse non-dates.
func TestDayOps(t *testing.T) {
	ab := &ArgBuilder{}
	sql, err := CompileCond(Cond{Field: "created", Op: "onOrBefore", Value: json.RawMessage(`"2026-10-08T23:59:00Z"`)}, demoSchema, ab)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sql, "::date <= $1::date") || ab.Values()[0] != "2026-10-08" {
		t.Fatalf("got %s %v", sql, ab.Values())
	}
	if _, err := CompileCond(Cond{Field: "created", Op: "onOrAfter", Value: json.RawMessage(`"soon"`)}, demoSchema, &ArgBuilder{}); err == nil {
		t.Fatal("non-date must fail")
	}
}
