package queryx

import "strings"

// PayloadAccessor turns a field into the JSONB extraction expression
// appropriate for the target type. Text uses the `->>` operator; the
// numeric / boolean / date / datetime paths cast the text extract.
//
// The `as` parameter is separate from `f.Type` so callers that need a
// text comparison against a numeric field (e.g. `contains`) can request
// the text projection without changing the underlying schema.
func PayloadAccessor(f Field, as FieldType) string {
	base := "payload ->> " + PgLit(f.Key)
	switch as {
	case FieldNumber:
		return "(" + base + ")::numeric"
	case FieldBoolean:
		return "(" + base + ")::boolean"
	case FieldDate:
		return "(" + base + ")::date"
	case FieldDatetime:
		return "(" + base + ")::timestamptz"
	default:
		return base
	}
}

// TextAccessor is a convenience for the common case: the text
// projection of a field regardless of its declared type.
func TextAccessor(f Field) string {
	return PayloadAccessor(f, FieldText)
}

// NativeAccessor is the accessor cast to the field's declared type —
// used by ordering, aggregation, and value-comparison operators that
// want the "natural" projection.
func NativeAccessor(f Field) string {
	return PayloadAccessor(f, f.Type)
}

// PgLit renders a Postgres single-quoted string literal. Used ONLY for
// identifier-like values (field keys) that have already passed
// [SanitiseField] — never for user-supplied values (those ride through
// [ArgBuilder] as `$N`).
func PgLit(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
