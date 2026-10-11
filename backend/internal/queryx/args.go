package queryx

import "strconv"

// ArgBuilder collects positional arguments while emitting `$N`
// placeholders that reference them. The single point of truth for
// argument numbering across a compile — passing the same builder to
// every emitter guarantees positional indices line up.
//
// Zero value is ready to use.
type ArgBuilder struct {
	args []any
}

// Add records a value and returns the `$N` placeholder that references
// it. Every user-supplied value must flow through here — the compiler
// never inlines values into SQL text.
func (a *ArgBuilder) Add(v any) string {
	a.args = append(a.args, v)
	return "$" + strconv.Itoa(len(a.args))
}

// Values returns the accumulated positional arguments in the order pgx
// expects. The returned slice aliases the builder's internal storage;
// callers that intend to reuse the builder must copy.
func (a *ArgBuilder) Values() []any {
	return a.args
}

// Len reports how many arguments have been recorded so far. Useful for
// callers that pre-seed slots (tenant / source) and need to know where
// their own args start.
func (a *ArgBuilder) Len() int {
	return len(a.args)
}
