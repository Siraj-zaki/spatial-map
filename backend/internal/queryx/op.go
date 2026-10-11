package queryx

import (
	"encoding/json"
	"fmt"
)

// Op is the canonical operator identifier. Anything outside
// [Registry] is rejected before any SQL is built.
type Op string

// Canonical operator vocabulary. Aliases (below) resolve into these.
const (
	OpEq         Op = "eq"
	OpNeq        Op = "neq"
	OpLt         Op = "lt"
	OpLte        Op = "lte"
	OpGt         Op = "gt"
	OpGte        Op = "gte"
	OpIn         Op = "in"
	OpNin        Op = "nin"
	OpContains   Op = "contains"
	OpStartsWith Op = "startsWith"
	OpEndsWith   Op = "endsWith"
	OpRegex      Op = "regex"
	OpIsNull     Op = "isnull"
	OpNotNull    Op = "notnull"
	OpBetween    Op = "between"
	OpBefore     Op = "before"
	OpAfter      Op = "after"
	OpLastNDays  Op = "lastNDays"
	OpNextNDays  Op = "nextNDays"
	// OpOnOrAfter / OpOnOrBefore compare whole calendar days: a date
	// range "Oct 1 – Oct 8" from a viewer filter includes all of Oct 8,
	// which a plain `<=` against a timestamp would cut off at midnight.
	OpOnOrAfter  Op = "onOrAfter"
	OpOnOrBefore Op = "onOrBefore"
)

// opAliases maps legacy / alternate spellings onto canonical ops. The
// two former callers spelled a few ops differently — Evidence's
// `startsWith` vs the reports executor's `starts`, `notIn` vs `nin`,
// `exists`/`missing` vs `notnull`/`isnull`. Callers keep sending the
// spelling they use today; the resolver normalises on the way in.
var opAliases = map[Op]Op{
	"starts":  OpStartsWith,
	"ends":    OpEndsWith,
	"notIn":   OpNin,
	"exists":  OpNotNull, // "value is present and non-empty"
	"missing": OpIsNull,  // "value is absent or empty"
}

// ResolveOp normalises alias spellings and returns the canonical Op.
// Ok is false when the string is neither canonical nor an alias.
func ResolveOp(s string) (Op, bool) {
	op := Op(s)
	if _, ok := Registry[op]; ok {
		return op, true
	}
	if canonical, ok := opAliases[op]; ok {
		return canonical, true
	}
	return "", false
}

// Arity describes what shape of value an op expects.
type Arity int

const (
	ArityNone   Arity = iota // isnull / notnull
	ArityScalar              // eq / gt / contains / regex / lastNDays / ...
	ArityArray               // in / nin
	ArityRange               // between
)

// OpDef describes one operator: the value shape it expects and the
// emitter that turns it into a SQL fragment.
type OpDef struct {
	Arity Arity
	// Emit produces a WHERE-clause fragment. The field has already
	// been validated against the source schema by the caller; the
	// emitter still calls [SanitiseField] via [PayloadAccessor].
	Emit func(f Field, value json.RawMessage, ab *ArgBuilder) (string, error)
}

// Registry is the single source of truth for what operators exist.
// Both the reports executor and data_source_query index into it. If
// you add an op here, both callers get it for free.
var Registry = map[Op]OpDef{
	OpEq: {
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			val, err := ScalarArg(v, f.Type)
			if err != nil {
				return "", err
			}
			return NativeAccessor(f) + " = " + ab.Add(val), nil
		},
	},
	OpNeq: {
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			val, err := ScalarArg(v, f.Type)
			if err != nil {
				return "", err
			}
			return "(" + NativeAccessor(f) + " IS DISTINCT FROM " + ab.Add(val) + ")", nil
		},
	},
	OpLt:  ordered("<"),
	OpLte: ordered("<="),
	OpGt:  ordered(">"),
	OpGte: ordered(">="),
	OpIn: {
		Arity: ArityArray,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			vals, err := ArrayArg(v, f.Type)
			if err != nil {
				return "", err
			}
			if len(vals) == 0 {
				return "FALSE", nil
			}
			return NativeAccessor(f) + " = ANY(" + ab.Add(vals) + ")", nil
		},
	},
	OpNin: {
		Arity: ArityArray,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			vals, err := ArrayArg(v, f.Type)
			if err != nil {
				return "", err
			}
			if len(vals) == 0 {
				return "TRUE", nil
			}
			return "NOT (" + NativeAccessor(f) + " = ANY(" + ab.Add(vals) + "))", nil
		},
	},
	OpContains:   likeOp("%", "%"),
	OpStartsWith: likeOp("", "%"),
	OpEndsWith:   likeOp("%", ""),
	OpRegex: {
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			s, err := TextArg(v)
			if err != nil {
				return "", err
			}
			return TextAccessor(f) + " ~ " + ab.Add(s), nil
		},
	},
	OpIsNull: {
		Arity: ArityNone,
		Emit: func(f Field, _ json.RawMessage, _ *ArgBuilder) (string, error) {
			// A key is "missing" if it isn't in the payload OR its text
			// projection is empty — matches the semantics both former
			// callers implemented.
			return "((payload ? " + PgLit(f.Key) + ") IS NOT TRUE OR " + TextAccessor(f) + " = '')", nil
		},
	},
	OpNotNull: {
		Arity: ArityNone,
		Emit: func(f Field, _ json.RawMessage, _ *ArgBuilder) (string, error) {
			return "((payload ? " + PgLit(f.Key) + ") IS TRUE AND " + TextAccessor(f) + " <> '')", nil
		},
	},
	OpBetween: {
		Arity: ArityRange,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			lo, hi, err := BetweenArg(v, f.Type)
			if err != nil {
				return "", err
			}
			return "(" + NativeAccessor(f) + " BETWEEN " + ab.Add(lo) + " AND " + ab.Add(hi) + ")", nil
		},
	},
	OpBefore: {
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			val, err := ScalarArg(v, coerceTemporalType(f.Type))
			if err != nil {
				return "", err
			}
			return PayloadAccessor(f, FieldDatetime) + " < " + ab.Add(val) + "::timestamptz", nil
		},
	},
	OpAfter: {
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			val, err := ScalarArg(v, coerceTemporalType(f.Type))
			if err != nil {
				return "", err
			}
			return PayloadAccessor(f, FieldDatetime) + " > " + ab.Add(val) + "::timestamptz", nil
		},
	},
	OpOnOrAfter:  dayOp(">="),
	OpOnOrBefore: dayOp("<="),
	OpLastNDays: {
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			days, err := IntArg(v)
			if err != nil {
				return "", err
			}
			if days < 0 {
				return "", fmt.Errorf("lastNDays requires non-negative integer")
			}
			ts := PayloadAccessor(f, FieldDatetime)
			interval := fmt.Sprintf("%d days", days)
			return "(" + ts + " >= now() - " + ab.Add(interval) + "::interval AND " + ts + " <= now())", nil
		},
	},
	OpNextNDays: {
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			days, err := IntArg(v)
			if err != nil {
				return "", err
			}
			if days < 0 {
				return "", fmt.Errorf("nextNDays requires non-negative integer")
			}
			ts := PayloadAccessor(f, FieldDatetime)
			interval := fmt.Sprintf("%d days", days)
			return "(" + ts + " <= now() + " + ab.Add(interval) + "::interval AND " + ts + " >= now())", nil
		},
	},
}

// dayOp compares the field's calendar day with a date value.
func dayOp(sqlOp string) OpDef {
	return OpDef{
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			s, err := TextArg(v)
			if err != nil {
				return "", err
			}
			if len(s) < 10 {
				return "", fmt.Errorf("expected a date (YYYY-MM-DD): %q", s)
			}
			return "(" + PayloadAccessor(f, FieldDatetime) + ")::date " + sqlOp + " " + ab.Add(s[:10]) + "::date", nil
		},
	}
}

// ordered returns a comparison-op emitter for `<`, `<=`, `>`, `>=`.
func ordered(sqlOp string) OpDef {
	return OpDef{
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			val, err := ScalarArg(v, f.Type)
			if err != nil {
				return "", err
			}
			return NativeAccessor(f) + " " + sqlOp + " " + ab.Add(val), nil
		},
	}
}

// likeOp returns an ILIKE-based emitter with the given pre/post wildcards.
func likeOp(pre, post string) OpDef {
	return OpDef{
		Arity: ArityScalar,
		Emit: func(f Field, v json.RawMessage, ab *ArgBuilder) (string, error) {
			s, err := TextArg(v)
			if err != nil {
				return "", err
			}
			return TextAccessor(f) + " ILIKE " + ab.Add(pre+s+post), nil
		},
	}
}

// coerceTemporalType picks a sensible scalar-decode target for
// temporal comparison ops. Text fields ride as plain strings and are
// cast on the SQL side by the emitter.
func coerceTemporalType(t FieldType) FieldType {
	switch t {
	case FieldDate, FieldDatetime:
		return t
	default:
		return FieldText
	}
}
