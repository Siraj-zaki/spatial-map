// Package interpolate is the safe template engine that lets a v2
// report spec embed runtime parameters into query filter values and
// (in the specific DimensionGrid case) into a WHERE-fragment slot.
//
// It is a hardened Go port of Evidence's
// `core/src/interpolate-query-strings.ts` with a few important
// differences:
//
//   - Scalar `{{param.x}}` references NEVER text-substitute. Instead
//     they resolve to `$N` positional args bound via [queryx.ArgBuilder].
//   - The one fragment-emit path — [queryx.Predicate] via
//     `{{param.selection}}` where selection is a KindPredicate param —
//     is rendered server-side from a typed struct the client posts,
//     with each column going through [queryx.SanitiseField] and each
//     value through [queryx.ArgBuilder.Add]. No SQL text crosses the
//     wire.
//   - `[[ ... conditional block ... ]]` collapses to the empty string
//     when any inner reference is empty (per Evidence's semantics).
//     Empty blocks are removed before per-marker interpolation so no
//     stray positional args get bound.
//   - SQL comments and string literals are masked before scanning so a
//     token that appears only in a comment (or inside a literal) is
//     ignored, matching Evidence's behaviour.
//   - Zero-width characters (U+200B, U+200C, U+200D, U+FEFF) are
//     stripped from the template before parsing — they are a common
//     paste-artifact vector for breaking token detection.
//
// Query chaining (`{{queryName}}` expanding to a subquery) is
// intentionally NOT implemented in phase 1 — the interpolator rejects
// any bare `{{name}}` that doesn't resolve to a declared parameter.
package interpolate
