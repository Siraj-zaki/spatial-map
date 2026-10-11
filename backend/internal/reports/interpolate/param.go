package interpolate

import (
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
)

// ParamKind classifies what a runtime parameter carries. The
// interpolator uses it to decide which sub-field references (`.value`,
// `.start`, `.end`) are legal for a given param.
type ParamKind int

const (
	// KindSingle — one scalar value (dropdown, buttonGroup, textInput).
	// Renders as `$N` bound arg. `.value` and bare `{{param.x}}` both
	// refer to the value.
	KindSingle ParamKind = iota

	// KindMulti — array of scalars (multi-dropdown). Renders as an
	// array-typed `$N` (pgx supports `= ANY($N)`).
	KindMulti

	// KindDate — a single date. Rendered as `$N`; caller casts on the
	// SQL side.
	KindDate

	// KindDateRange — a {start, end} pair. `.start` and `.end` render
	// the respective bound; a bare `{{param.x}}` is a range reference
	// only valid inside a Cond.Value with `between` op.
	KindDateRange

	// KindNumberRange — {low, high} slider. `.start`/`.low` and
	// `.end`/`.high` render the respective bound.
	KindNumberRange

	// KindText — plain string (search input). Same rendering as Single.
	KindText

	// KindPredicate — DimensionGrid selection: the value is a typed
	// [queryx.Predicate] the caller renders via [queryx.RenderColumnPredicate].
	// Bare `{{param.selection}}` inside an `extraFilter` slot emits the
	// rendered fragment inline.
	KindPredicate
)

// ParamValue carries the resolved value of a runtime parameter. The
// zero value is a valid "unset" state — [IsEmpty] returns true.
type ParamValue struct {
	Kind ParamKind

	// Scalar is populated for KindSingle / KindDate / KindText and
	// receives the pgx-ready native value from ScalarArg-style decode.
	Scalar any

	// Array is populated for KindMulti.
	Array []any

	// Range is populated for KindDateRange / KindNumberRange.
	Range struct {
		Start any
		End   any
	}

	// Predicate is populated for KindPredicate. Nil is treated the
	// same as empty.
	Predicate *queryx.Predicate

	// Raw is the caller's original JSON, preserved so [ResolveScalarJSON]
	// can hand it back unchanged in the pass-through case (no template
	// reference) without a round-trip through Go types.
	Raw json.RawMessage
}

// IsEmpty reports whether the param carries anything a query would
// legitimately observe. Empty params cause `[[block]]` collapse and
// mark plain conds as inactive (the "prompt filter" pattern).
func (p ParamValue) IsEmpty() bool {
	switch p.Kind {
	case KindMulti:
		return len(p.Array) == 0
	case KindDateRange, KindNumberRange:
		return p.Range.Start == nil && p.Range.End == nil
	case KindPredicate:
		return p.Predicate == nil || p.Predicate.IsEmpty()
	default:
		return p.Scalar == nil || isEmptyString(p.Scalar)
	}
}

func isEmptyString(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, r := range s {
		if r != ' ' && r != '\t' && r != '\n' && r != '\r' {
			return false
		}
	}
	return true
}

// SubValue returns the value addressed by a sub-field reference
// (`.value`, `.start`, `.end`, `.low`, `.high`). Ok=false when the
// sub-field doesn't apply to this kind.
func (p ParamValue) SubValue(sub string) (any, bool) {
	switch sub {
	case "", "value":
		switch p.Kind {
		case KindMulti:
			return p.Array, true
		case KindDateRange, KindNumberRange:
			// Bare reference to a range is ambiguous. Callers that need a
			// single value must ask for `.start` / `.end` explicitly.
			return nil, false
		case KindPredicate:
			// Bare reference to a predicate is handled by the text
			// interpolator (fragment emit), not here.
			return nil, false
		default:
			return p.Scalar, true
		}
	case "start", "low":
		if p.Kind == KindDateRange || p.Kind == KindNumberRange {
			return p.Range.Start, true
		}
	case "end", "high":
		if p.Kind == KindDateRange || p.Kind == KindNumberRange {
			return p.Range.End, true
		}
	}
	return nil, false
}
