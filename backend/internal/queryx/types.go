package queryx

// FieldType is the coarse classification the compiler uses to decide
// how to cast a JSONB payload accessor. Anything unknown is treated as
// text; casts happen at the SQL-side (`::numeric`, `::timestamptz`)
// which accept string input from pgx bindings just fine.
type FieldType string

const (
	FieldText     FieldType = "text"
	FieldNumber   FieldType = "number"
	FieldBoolean  FieldType = "boolean"
	FieldDate     FieldType = "date"
	FieldDatetime FieldType = "datetime"
)

// Field is one column in a source's schema. Names must pass
// [SanitiseField] before they can ride into any query.
type Field struct {
	Key   string
	Label string
	Type  FieldType
}

// FieldSet is the source's field allow-list — the schema the compiler
// checks against before it agrees to compile a filter or metric.
// Callers hand us a snapshot; we don't touch it.
type FieldSet []Field

// ByKey returns the first field with a matching Key. Ok is false when
// nothing matches — the compiler treats that as a schema-mismatch 400.
func (fs FieldSet) ByKey(key string) (Field, bool) {
	for _, f := range fs {
		if f.Key == key {
			return f, true
		}
	}
	return Field{}, false
}
