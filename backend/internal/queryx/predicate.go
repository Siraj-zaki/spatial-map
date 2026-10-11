package queryx

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Predicate is a typed structure produced by input components (most
// notably Evidence-style DimensionGrid) that need to embed a WHERE
// fragment inside a query template. The client posts the structure;
// the server renders the fragment with [RenderColumnPredicate]. No
// SQL text ever crosses the wire — that's the whole point.
type Predicate struct {
	// Combine is "AND" (default) or "OR" applied between columns.
	Combine string            `json:"combine,omitempty"`
	Columns []PredicateColumn `json:"columns,omitempty"`
}

// PredicateColumn is one column's contribution to the fragment.
type PredicateColumn struct {
	// Field is the payload key. Sanitised before it touches SQL.
	Field string `json:"field"`
	// Op is the operator (canonical or alias). Defaults to Eq for a
	// single value and In for multiple.
	Op string `json:"op,omitempty"`
	// Values may be a single scalar or an array; the emitter picks
	// eq / in based on shape when Op is empty.
	Values []json.RawMessage `json:"values,omitempty"`
}

// IsEmpty returns true when the predicate would contribute nothing to
// a WHERE clause — used by the interpolation engine to decide whether
// a `[[ {{param.selection}} ]]` block collapses.
func (p Predicate) IsEmpty() bool {
	if p.Combine == "" && len(p.Columns) == 0 {
		return true
	}
	for _, c := range p.Columns {
		if len(c.Values) > 0 {
			return false
		}
	}
	return true
}

// RenderColumnPredicate produces a WHERE fragment from a client-posted
// Predicate. Each column's field passes [SanitiseField]; each value
// rides through [ArgBuilder] as `$N`; the operator resolves through
// [Registry] — everything the free-form filter tree goes through. The
// output is isomorphic to what [CompileNode] would emit for the
// equivalent tree of Ands.
func RenderColumnPredicate(p Predicate, schema FieldSet, ab *ArgBuilder) (string, error) {
	if p.IsEmpty() {
		return "", nil
	}
	combine := "AND"
	if strings.EqualFold(p.Combine, "or") {
		combine = "OR"
	}
	parts := make([]string, 0, len(p.Columns))
	for _, col := range p.Columns {
		fragment, err := renderColumn(col, schema, ab)
		if err != nil {
			return "", err
		}
		if fragment != "" {
			parts = append(parts, fragment)
		}
	}
	if len(parts) == 0 {
		return "", nil
	}
	if len(parts) == 1 {
		return parts[0], nil
	}
	return "(" + strings.Join(parts, " "+combine+" ") + ")", nil
}

func renderColumn(col PredicateColumn, schema FieldSet, ab *ArgBuilder) (string, error) {
	if _, err := SanitiseField(col.Field); err != nil {
		return "", fmt.Errorf("predicate field: %w", err)
	}
	f, ok := schema.ByKey(col.Field)
	if !ok {
		return "", fmt.Errorf("predicate field not in schema: %q", col.Field)
	}
	if len(col.Values) == 0 {
		return "", nil
	}

	// Pick an op if the client didn't supply one: single → eq,
	// multiple → in. Explicit ops flow through the registry as-is.
	opStr := col.Op
	if opStr == "" {
		if len(col.Values) == 1 {
			opStr = string(OpEq)
		} else {
			opStr = string(OpIn)
		}
	}
	op, ok := ResolveOp(opStr)
	if !ok {
		return "", fmt.Errorf("predicate op unknown: %q", col.Op)
	}
	def := Registry[op]

	// Values-shape must match the op's arity. Array ops take the whole
	// values slice; scalar ops take the first (and require exactly one).
	var raw json.RawMessage
	switch def.Arity {
	case ArityArray:
		bytes, err := json.Marshal(col.Values)
		if err != nil {
			return "", err
		}
		raw = bytes
	case ArityScalar:
		if len(col.Values) != 1 {
			return "", fmt.Errorf("predicate op %q expects one value, got %d", op, len(col.Values))
		}
		raw = col.Values[0]
	case ArityRange:
		if len(col.Values) != 2 {
			return "", fmt.Errorf("predicate op %q expects two values, got %d", op, len(col.Values))
		}
		bytes, err := json.Marshal(col.Values)
		if err != nil {
			return "", err
		}
		raw = bytes
	case ArityNone:
		raw = nil
	}
	return def.Emit(f, raw, ab)
}
