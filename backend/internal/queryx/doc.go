// Package queryx holds the shared query-compilation primitives used by
// both the Report Builder executor (internal/reports) and the
// data-source query endpoint (internal/handlers/data_source_query).
//
// It intentionally exports low-level building blocks — an argument
// builder, JSONB payload accessors, an identifier allow-list, per-op
// SQL emitters, and a filter-tree walker — rather than a monolithic
// "run this query" API, because the two callers wrap the same kernel
// in different request shapes (spec-driven aggregate reports vs.
// row-list filter DSL).
//
// Safety invariants that hold across the whole package:
//
//  1. **Values NEVER touch SQL text.** Every user value goes through
//     [ArgBuilder.Add] and rides as a positional `$N` parameter.
//  2. **Field names are re-checked before interpolation.** Even when
//     the caller has already verified a field against a source schema,
//     [SanitiseField] runs again at every emit site so a compromised
//     schema cannot smuggle SQL fragments through.
//  3. **Only fixed operator identifiers reach the SQL builder.**
//     Operator strings are keys into [Registry]; unknown ops error out
//     before any SQL is built.
//  4. **The kernel emits SELECT-shaped SQL only.** No DDL, no DML.
package queryx
