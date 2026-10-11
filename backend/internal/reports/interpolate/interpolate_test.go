package interpolate

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
)

var demoSchema = queryx.FieldSet{
	{Key: "status", Type: queryx.FieldText},
	{Key: "qty", Type: queryx.FieldNumber},
}

// ---------- ResolveScalarJSON

func TestResolveScalarJSON_PassThrough(t *testing.T) {
	raw := json.RawMessage(`"active"`)
	out, refs, err := ResolveScalarJSON(raw, nil)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if string(out) != string(raw) {
		t.Errorf("expected pass-through, got %s", out)
	}
	if len(refs) != 0 {
		t.Errorf("no refs expected, got %d", len(refs))
	}
}

func TestResolveScalarJSON_SingleMarker(t *testing.T) {
	raw := json.RawMessage(`"{{param.x}}"`)
	params := map[string]ParamValue{
		"x": {Kind: KindSingle, Scalar: "active"},
	}
	out, refs, err := ResolveScalarJSON(raw, params)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if string(out) != `"active"` {
		t.Errorf("expected quoted resolved value, got %s", out)
	}
	if len(refs) != 1 || refs[0].Name != "x" {
		t.Errorf("expected one ref to x, got %+v", refs)
	}
}

func TestResolveScalarJSON_SubField(t *testing.T) {
	raw := json.RawMessage(`"{{ param.range.start }}"`)
	params := map[string]ParamValue{
		"range": {Kind: KindDateRange, Range: struct{ Start, End any }{Start: "2026-01-01", End: "2026-06-30"}},
	}
	out, refs, err := ResolveScalarJSON(raw, params)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if string(out) != `"2026-01-01"` {
		t.Errorf("expected .start value, got %s", out)
	}
	if len(refs) != 1 || refs[0].Name != "range" || refs[0].Sub != "start" {
		t.Errorf("expected ref name=range sub=start, got %+v", refs)
	}
}

func TestResolveScalarJSON_MissingParamIsEmpty(t *testing.T) {
	raw := json.RawMessage(`"{{param.absent}}"`)
	out, refs, err := ResolveScalarJSON(raw, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if string(out) != `""` {
		t.Errorf("missing param should render as empty string, got %s", out)
	}
	if len(refs) != 1 {
		t.Errorf("expected ref recorded even when missing, got %d", len(refs))
	}
}

func TestResolveScalarJSON_RejectsMixedTemplate(t *testing.T) {
	// A template with prefix text is refused — text concatenation would
	// bypass the arg-binding safety model.
	raw := json.RawMessage(`"prefix-{{param.x}}"`)
	_, _, err := ResolveScalarJSON(raw, nil)
	if err == nil {
		t.Error("expected error for mixed-text template in value slot")
	}
	raw = json.RawMessage(`"{{param.x}}{{param.y}}"`)
	_, _, err = ResolveScalarJSON(raw, nil)
	if err == nil {
		t.Error("expected error for two markers in value slot")
	}
}

// ---------- CompileText

func TestCompileText_ScalarSubst(t *testing.T) {
	ab := &queryx.ArgBuilder{}
	params := map[string]ParamValue{
		"status": {Kind: KindSingle, Scalar: "active"},
	}
	out, _, err := CompileText("WHERE status = {{param.status}}", params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(out, " = $1") {
		t.Errorf("expected $1 binding, got %q", out)
	}
	if len(ab.Values()) != 1 || ab.Values()[0] != "active" {
		t.Errorf("expected 1 arg 'active', got %#v", ab.Values())
	}
}

func TestCompileText_InjectionAttempt(t *testing.T) {
	// A malicious param value must ride as a bound arg, not text.
	ab := &queryx.ArgBuilder{}
	params := map[string]ParamValue{
		"status": {Kind: KindSingle, Scalar: "'; DROP TABLE reports; --"},
	}
	out, _, err := CompileText("WHERE status = {{param.status}}", params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if strings.Contains(out, "DROP") {
		t.Errorf("value literal leaked into SQL: %q", out)
	}
	if !strings.Contains(out, "$1") {
		t.Errorf("expected $1 placeholder, got %q", out)
	}
}

func TestCompileText_CommentMasking(t *testing.T) {
	// A token mentioned only inside a `--` comment must NOT interpolate.
	ab := &queryx.ArgBuilder{}
	params := map[string]ParamValue{"x": {Kind: KindSingle, Scalar: "hello"}}
	template := "SELECT 1 -- see {{param.x}}\nFROM t"
	out, _, err := CompileText(template, params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if strings.Contains(out, "$1") {
		t.Errorf("comment-only reference should not have bound an arg: %q", out)
	}
	if len(ab.Values()) != 0 {
		t.Errorf("no args should be bound, got %d", len(ab.Values()))
	}
	if !strings.Contains(out, "-- see {{param.x}}") {
		t.Errorf("comment body should be preserved verbatim, got %q", out)
	}
}

func TestCompileText_BlockCommentMasking(t *testing.T) {
	ab := &queryx.ArgBuilder{}
	params := map[string]ParamValue{"x": {Kind: KindSingle, Scalar: "hello"}}
	template := "SELECT /* {{param.x}} */ 1"
	out, _, err := CompileText(template, params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if strings.Contains(out, "$1") {
		t.Errorf("block-comment reference should not have bound: %q", out)
	}
}

func TestCompileText_ZeroWidthSmuggling(t *testing.T) {
	ab := &queryx.ArgBuilder{}
	// Insert a ZWSP inside the marker name — should be stripped so the
	// reference resolves normally.
	tpl := "SELECT {{param.​x}}"
	params := map[string]ParamValue{"x": {Kind: KindSingle, Scalar: "hello"}}
	out, refs, err := CompileText(tpl, params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(out, "$1") {
		t.Errorf("expected marker to resolve after zw strip: %q", out)
	}
	if len(refs) != 1 || refs[0].Name != "x" {
		t.Errorf("expected ref to x, got %+v", refs)
	}
}

func TestCompileText_ConditionalBlockCollapses(t *testing.T) {
	ab := &queryx.ArgBuilder{}
	params := map[string]ParamValue{}
	template := "WHERE 1=1 [[ AND status = {{param.status}} ]]"
	out, _, err := CompileText(template, params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if strings.Contains(out, "AND status") {
		t.Errorf("block with missing param should have collapsed: %q", out)
	}
	if len(ab.Values()) != 0 {
		t.Errorf("collapsed block should not have bound args, got %d", len(ab.Values()))
	}
}

func TestCompileText_ConditionalBlockRenders(t *testing.T) {
	ab := &queryx.ArgBuilder{}
	params := map[string]ParamValue{"status": {Kind: KindSingle, Scalar: "active"}}
	template := "WHERE 1=1 [[ AND status = {{param.status}} ]]"
	out, _, err := CompileText(template, params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(out, "AND status = $1") {
		t.Errorf("block with resolved param should render: %q", out)
	}
	if len(ab.Values()) != 1 {
		t.Errorf("expected 1 arg, got %d", len(ab.Values()))
	}
}

func TestCompileText_NestedBlocks(t *testing.T) {
	ab := &queryx.ArgBuilder{}
	params := map[string]ParamValue{"a": {Kind: KindSingle, Scalar: "ok"}}
	// Inner block collapses because b is missing; outer would render
	// but its body ends up empty, which is still legal SQL.
	template := "SELECT 1 [[ WHERE a = {{param.a}} [[ AND b = {{param.b}} ]] ]]"
	out, _, err := CompileText(template, params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(out, "WHERE a = $1") {
		t.Errorf("outer block should render: %q", out)
	}
	if strings.Contains(out, "AND b") {
		t.Errorf("inner block should have collapsed: %q", out)
	}
}

func TestCompileText_PredicateFragment(t *testing.T) {
	ab := &queryx.ArgBuilder{}
	pred := queryx.Predicate{Columns: []queryx.PredicateColumn{
		{Field: "status", Values: []json.RawMessage{json.RawMessage(`"active"`)}},
	}}
	params := map[string]ParamValue{"sel": {Kind: KindPredicate, Predicate: &pred}}
	out, _, err := CompileText("WHERE {{param.sel}}", params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(out, " = $1") {
		t.Errorf("predicate should have rendered with bound arg: %q", out)
	}
	if len(ab.Values()) != 1 || ab.Values()[0] != "active" {
		t.Errorf("expected 1 arg 'active', got %#v", ab.Values())
	}
}

func TestCompileText_PredicateEmpty(t *testing.T) {
	ab := &queryx.ArgBuilder{}
	params := map[string]ParamValue{"sel": {Kind: KindPredicate, Predicate: nil}}
	out, _, err := CompileText("WHERE {{param.sel}}", params, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(out, "TRUE") {
		t.Errorf("empty predicate should render as TRUE, got %q", out)
	}
}

func TestCompileText_MissingParamRendersEmpty(t *testing.T) {
	ab := &queryx.ArgBuilder{}
	out, _, err := CompileText("SELECT {{param.unknown}}", nil, demoSchema, ab)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(out, "''") {
		t.Errorf("missing param should render as '', got %q", out)
	}
}

func TestParamValue_IsEmpty(t *testing.T) {
	cases := []struct {
		p    ParamValue
		want bool
	}{
		{ParamValue{Kind: KindSingle}, true},
		{ParamValue{Kind: KindSingle, Scalar: "x"}, false},
		{ParamValue{Kind: KindSingle, Scalar: "   "}, true},
		{ParamValue{Kind: KindMulti}, true},
		{ParamValue{Kind: KindMulti, Array: []any{"a"}}, false},
		{ParamValue{Kind: KindDateRange}, true},
		{ParamValue{Kind: KindDateRange, Range: struct{ Start, End any }{Start: "2026-01-01"}}, false},
		{ParamValue{Kind: KindPredicate}, true},
	}
	for _, c := range cases {
		if got := c.p.IsEmpty(); got != c.want {
			t.Errorf("IsEmpty(%+v) = %v, want %v", c.p, got, c.want)
		}
	}
}

func TestStripZeroWidth(t *testing.T) {
	in := "he​llo‌"
	out, n := stripZeroWidth(in)
	if out != "hello" {
		t.Errorf("out = %q", out)
	}
	if n != 2 {
		t.Errorf("stripped = %d", n)
	}
	// no-op path
	out2, n2 := stripZeroWidth("plain")
	if out2 != "plain" || n2 != 0 {
		t.Errorf("no-op broken: %q %d", out2, n2)
	}
}

func TestMaskSqlComments(t *testing.T) {
	sql := "SELECT 1 -- ok\nFROM t /* block */ WHERE '--' = '/*'"
	masked, comments := maskSqlComments(sql)
	if strings.Contains(masked, "-- ok") {
		t.Errorf("line comment should be masked: %q", masked)
	}
	if strings.Contains(masked, "/* block */") {
		t.Errorf("block comment should be masked: %q", masked)
	}
	if !strings.Contains(masked, "'--'") {
		t.Errorf("string literal containing -- should be preserved: %q", masked)
	}
	if len(comments) != 2 {
		t.Errorf("expected 2 comments captured, got %d: %v", len(comments), comments)
	}
	restored := restoreSqlComments(masked, comments)
	if restored != sql {
		t.Errorf("round-trip broken\n want: %q\n got:  %q", sql, restored)
	}
}
