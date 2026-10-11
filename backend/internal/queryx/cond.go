package queryx

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Cond is a leaf filter — one field, one operator, optionally one
// value. Serialised as-is in JSON specs.
type Cond struct {
	Field string          `json:"field"`
	Op    string          `json:"op"`
	Value json.RawMessage `json:"value,omitempty"`
}

// Node is one arm of the filter tree. Exactly one of And / Or / Cond
// is populated; all-nil means "match everything".
type Node struct {
	And  []Node `json:"and,omitempty"`
	Or   []Node `json:"or,omitempty"`
	Cond *Cond  `json:"cond,omitempty"`
}

// CompileNode walks the filter tree and emits SQL. Empty branches
// (all-inactive conds, empty groups) collapse to "" so callers can
// safely `AND` the result onto their base WHERE clause.
func CompileNode(n Node, schema FieldSet, ab *ArgBuilder) (string, error) {
	if len(n.And) > 0 {
		return compileGroup(n.And, " AND ", schema, ab)
	}
	if len(n.Or) > 0 {
		return compileGroup(n.Or, " OR ", schema, ab)
	}
	if n.Cond != nil {
		if CondIsInactive(*n.Cond) {
			return "", nil
		}
		return CompileCond(*n.Cond, schema, ab)
	}
	return "", nil
}

func compileGroup(children []Node, joiner string, schema FieldSet, ab *ArgBuilder) (string, error) {
	parts := make([]string, 0, len(children))
	for _, child := range children {
		s, err := CompileNode(child, schema, ab)
		if err != nil {
			return "", err
		}
		if s != "" {
			parts = append(parts, s)
		}
	}
	if len(parts) == 0 {
		return "", nil
	}
	if len(parts) == 1 {
		return parts[0], nil
	}
	return "(" + strings.Join(parts, joiner) + ")", nil
}

// CompileCond emits the SQL for a single leaf condition. The field is
// checked against the schema (allow-list) and re-sanitised before it
// touches SQL text; the value flows through the Op emitter which binds
// it via [ArgBuilder].
func CompileCond(c Cond, schema FieldSet, ab *ArgBuilder) (string, error) {
	if _, err := SanitiseField(c.Field); err != nil {
		return "", fmt.Errorf("filter field: %w", err)
	}
	f, ok := schema.ByKey(c.Field)
	if !ok {
		return "", fmt.Errorf("filter field not in schema: %q", c.Field)
	}
	op, ok := ResolveOp(c.Op)
	if !ok {
		return "", fmt.Errorf("unknown op: %q", c.Op)
	}
	def := Registry[op]
	return def.Emit(f, c.Value, ab)
}

// CondIsInactive reports true when a leaf condition should be silently
// skipped: a value-required operator with a missing / null / empty /
// blank value. The "prompt filter" pattern in the builder relies on
// this — empty slots are treated as "no filter yet".
//
// Value-free ops (isnull / notnull and their aliases) always fire.
func CondIsInactive(c Cond) bool {
	op, ok := ResolveOp(c.Op)
	if ok {
		if def, ok := Registry[op]; ok && def.Arity == ArityNone {
			return false
		}
	}
	raw := bytes.TrimSpace(c.Value)
	if len(raw) == 0 {
		return true
	}
	switch string(raw) {
	case "null", `""`, "[]":
		return true
	}
	// A JSON string that decodes to whitespace-only is also inactive —
	// covers builder inputs that get trimmed to empty on the wire.
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if strings.TrimSpace(s) == "" {
			return true
		}
	}
	return false
}
