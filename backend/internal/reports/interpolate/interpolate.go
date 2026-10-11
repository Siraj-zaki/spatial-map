package interpolate

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
)

// Marker matches `{{ ... }}` — the outer runes are literal double
// braces; whatever the caller allowed inside is captured. The scanner
// is deliberately lenient: whitespace inside, dots for sub-fields,
// and a `?` fallback (deferred but tokenised) are all accepted.
var markerRe = regexp.MustCompile(`\{\{([^{}]+)\}\}`)

// Reference records a single `{{...}}` token the interpolator saw —
// callers use this list to track dependency edges (which queries
// re-run when which params change).
type Reference struct {
	Name string // param name — the segment before the first `.`
	Sub  string // sub-field — everything after the first `.`, or ""
}

// ResolveScalarJSON handles the "one Cond.Value is a template"
// case. If `raw` decodes to a string that is exactly a single
// `{{param.x}}` marker (allowing whitespace), it returns the
// referenced param's JSON encoding; otherwise it returns raw
// unchanged. Callers hand the returned bytes straight to
// [queryx.CompileCond] as if the client had sent a literal value.
//
// The one-token-only rule is deliberate: mixed strings like
// `"prefix-{{param.x}}"` are a text-interpolation smell inside a
// field-value slot, and we refuse them here — the caller can pre-format
// via a query if concatenation is really wanted.
//
// References are appended to the returned slice so callers can build
// dependency graphs without a second parse.
func ResolveScalarJSON(raw json.RawMessage, params map[string]ParamValue) (json.RawMessage, []Reference, error) {
	if len(raw) == 0 {
		return raw, nil, nil
	}
	// Value has to decode as a string to be a template.
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return raw, nil, nil
	}
	// Zero-width chars can smuggle through the outer JSON decode; strip
	// before shape checks so `"{{ ​param.x }}"` isn't mistaken for a
	// mixed template.
	s, _ = stripZeroWidth(s)
	trimmed := strings.TrimSpace(s)
	if !strings.Contains(trimmed, "{{") && !strings.Contains(trimmed, "}}") {
		return raw, nil, nil
	}
	// If it contains `{{` at all, it must be a pure single marker —
	// mixed strings like `"prefix-{{param.x}}"` would need unsafe text
	// concatenation.
	if !strings.HasPrefix(trimmed, "{{") || !strings.HasSuffix(trimmed, "}}") {
		return raw, nil, fmt.Errorf("mixed-text template not allowed in filter value: %q", s)
	}
	inner := strings.TrimSpace(trimmed[2 : len(trimmed)-2])
	// Second `{{` inside means we've got more than one marker — treat
	// that as a text template and refuse.
	if strings.Contains(inner, "{{") || strings.Contains(inner, "}}") {
		return raw, nil, fmt.Errorf("only single-marker templates allowed in filter values: %q", s)
	}
	name, sub := splitRef(inner)
	if name == "" {
		return raw, nil, fmt.Errorf("empty template reference: %q", s)
	}
	ref := Reference{Name: name, Sub: sub}
	p, ok := params[name]
	if !ok {
		// Unknown reference — treat as empty (the executor's inactive
		// filter path will drop it). This mirrors Evidence's behaviour
		// for a reference to an unset input.
		return json.RawMessage(`""`), []Reference{ref}, nil
	}
	val, ok := p.SubValue(sub)
	if !ok {
		return raw, []Reference{ref}, fmt.Errorf("sub-field %q not valid for %q", sub, name)
	}
	if val == nil {
		return json.RawMessage(`""`), []Reference{ref}, nil
	}
	encoded, err := json.Marshal(val)
	if err != nil {
		return raw, []Reference{ref}, fmt.Errorf("re-encode param %q: %w", name, err)
	}
	return encoded, []Reference{ref}, nil
}

// CompileText handles the "SQL text with markers" case — used for
// `queries[].extraFilter`. Substitution rules:
//
//   - `{{param.x}}` for a scalar / date / text param renders as a `$N`
//     bound arg via [queryx.ArgBuilder].
//   - `{{param.x.start}}` / `.end` for a range param renders one bound
//     arg.
//   - `{{param.x}}` for a KindPredicate param renders the fragment
//     produced by [queryx.RenderColumnPredicate] using the given
//     schema. This is the only place a template emits raw SQL text,
//     and the text is server-produced from a typed struct.
//   - `[[ ... block ... ]]` collapses to the empty string when any
//     `{{param.x}}` inside is empty; otherwise the inner tokens are
//     interpolated and the surrounding brackets removed.
//
// Comments and string literals in the template are masked before
// scanning, so a marker mentioned only in a comment does not bind
// args or expand.
func CompileText(template string, params map[string]ParamValue, schema queryx.FieldSet, ab *queryx.ArgBuilder) (string, []Reference, error) {
	cleaned, _ := stripZeroWidth(template)
	masked, comments := maskSqlComments(cleaned)

	// Process `[[ ... ]]` blocks first, working outside-in so a nested
	// empty block only collapses its own bracket pair.
	rendered, blockRefs, err := renderConditionalBlocks(masked, params, schema, ab)
	if err != nil {
		return "", nil, err
	}

	// Now substitute any remaining `{{ ... }}` markers.
	final, markerRefs, err := renderMarkers(rendered, params, schema, ab)
	if err != nil {
		return "", nil, err
	}

	final = restoreSqlComments(final, comments)
	return final, append(blockRefs, markerRefs...), nil
}

// renderConditionalBlocks scans for `[[ ... ]]` pairs and either
// collapses them (any inner marker is empty) or replaces the outer
// brackets with the interpolated body. Nested blocks are supported by
// scanning bracket depth.
func renderConditionalBlocks(sql string, params map[string]ParamValue, schema queryx.FieldSet, ab *queryx.ArgBuilder) (string, []Reference, error) {
	var out strings.Builder
	out.Grow(len(sql))
	var refs []Reference

	i, n := 0, len(sql)
	for i < n {
		if i+1 < n && sql[i] == '[' && sql[i+1] == '[' {
			// Find matching `]]` with depth counting.
			depth := 1
			j := i + 2
			for j+1 < n && depth > 0 {
				if sql[j] == '[' && sql[j+1] == '[' {
					depth++
					j += 2
					continue
				}
				if sql[j] == ']' && sql[j+1] == ']' {
					depth--
					if depth == 0 {
						break
					}
					j += 2
					continue
				}
				j++
			}
			if depth != 0 {
				return "", nil, fmt.Errorf("unbalanced conditional block at position %d", i)
			}
			body := sql[i+2 : j]
			// Recursively render inner blocks first.
			innerRendered, innerRefs, err := renderConditionalBlocks(body, params, schema, ab)
			if err != nil {
				return "", nil, err
			}
			refs = append(refs, innerRefs...)

			// Peek at referenced markers inside the rendered body — if
			// ANY of them refer to an empty param, the whole block is
			// dropped without emitting args.
			if hasEmptyRef(innerRendered, params) {
				// Skip; no output, no args bound (we haven't rendered
				// this body's markers yet).
				i = j + 2
				continue
			}
			// Non-empty: render the markers inside the body and emit.
			resolved, bodyRefs, err := renderMarkers(innerRendered, params, schema, ab)
			if err != nil {
				return "", nil, err
			}
			out.WriteString(resolved)
			refs = append(refs, bodyRefs...)
			i = j + 2
			continue
		}
		out.WriteByte(sql[i])
		i++
	}
	return out.String(), refs, nil
}

// hasEmptyRef returns true if any `{{param.x}}` marker in `text`
// references a param that is empty or missing. Used to decide whether
// a conditional block collapses.
func hasEmptyRef(text string, params map[string]ParamValue) bool {
	for _, m := range markerRe.FindAllStringSubmatch(text, -1) {
		name, _ := splitRef(strings.TrimSpace(m[1]))
		if name == "" {
			continue
		}
		p, ok := params[name]
		if !ok {
			return true
		}
		if p.IsEmpty() {
			return true
		}
	}
	return false
}

// renderMarkers substitutes every `{{ ... }}` in `text` using the
// param map, binding args through the shared ArgBuilder. Predicate
// params render as inline WHERE fragments; scalar / array / range
// params render as `$N`.
func renderMarkers(text string, params map[string]ParamValue, schema queryx.FieldSet, ab *queryx.ArgBuilder) (string, []Reference, error) {
	var refs []Reference
	var lastErr error
	out := markerRe.ReplaceAllStringFunc(text, func(match string) string {
		if lastErr != nil {
			return match
		}
		inner := strings.TrimSpace(match[2 : len(match)-2])
		name, sub := splitRef(inner)
		if name == "" {
			lastErr = fmt.Errorf("empty template reference in %q", match)
			return match
		}
		refs = append(refs, Reference{Name: name, Sub: sub})
		p, ok := params[name]
		if !ok {
			// Missing param — treat as empty string. Callers can
			// prevent the query from firing entirely via the
			// [[block]] mechanism if they want strict behaviour.
			return "''"
		}
		if p.Kind == KindPredicate {
			if sub != "" {
				lastErr = fmt.Errorf("sub-field %q not valid for predicate param %q", sub, name)
				return match
			}
			if p.Predicate == nil || p.Predicate.IsEmpty() {
				return "TRUE"
			}
			fragment, err := queryx.RenderColumnPredicate(*p.Predicate, schema, ab)
			if err != nil {
				lastErr = fmt.Errorf("render predicate %q: %w", name, err)
				return match
			}
			if fragment == "" {
				return "TRUE"
			}
			return fragment
		}
		val, ok := p.SubValue(sub)
		if !ok {
			lastErr = fmt.Errorf("sub-field %q not valid for %q", sub, name)
			return match
		}
		if val == nil {
			return "''"
		}
		return ab.Add(val)
	})
	if lastErr != nil {
		return "", refs, lastErr
	}
	return out, refs, nil
}

// splitRef takes the token body between `{{` and `}}` (already
// whitespace-trimmed) and returns the referenced param name plus any
// sub-field selector. Evidence uses `param.name[.sub]` with a
// mandatory `param.` namespace prefix — we mirror that so a bare
// `{{name}}` (which in Evidence is reserved for query chaining) is
// unambiguously distinguishable.
//
// Recognised shapes:
//
//	param.name              → name=name, sub=""
//	param.range.start       → name=range, sub="start"
//	param.range.start.foo   → name=range, sub="start.foo" (unused today)
//
// Anything without the `param.` prefix returns name="" so the caller
// can surface a helpful error.
func splitRef(inner string) (name, sub string) {
	const prefix = "param."
	if !strings.HasPrefix(inner, prefix) {
		return "", ""
	}
	rest := inner[len(prefix):]
	dot := strings.IndexByte(rest, '.')
	if dot < 0 {
		return rest, ""
	}
	return rest[:dot], rest[dot+1:]
}
