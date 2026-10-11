package interpolate

import "strings"

// Zero-width Unicode code points that have no legitimate use inside
// SQL or template markup but sneak in via paste from chat apps, AI
// assistants, or rich-text editors. Even one of these between two `{`
// bytes makes the literal `{{` substring no longer match, producing a
// confusing "unbalanced template brackets" error on valid input.
// Stripped at parse time only.
const (
	zwSpace         rune = 0x200B // Zero Width Space
	zwNonJoiner     rune = 0x200C // Zero Width Non-Joiner
	zwJoiner        rune = 0x200D // Zero Width Joiner
	zwByteOrderMark rune = 0xFEFF // BOM / Zero Width No-Break Space
)

func isZeroWidth(r rune) bool {
	switch r {
	case zwSpace, zwNonJoiner, zwJoiner, zwByteOrderMark:
		return true
	}
	return false
}

// stripZeroWidth removes zero-width chars from the input. Returns the
// cleaned string plus how many were stripped, for telemetry.
func stripZeroWidth(s string) (string, int) {
	if !containsZeroWidth(s) {
		return s, 0
	}
	stripped := 0
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if isZeroWidth(r) {
			stripped++
			continue
		}
		b.WriteRune(r)
	}
	return b.String(), stripped
}

func containsZeroWidth(s string) bool {
	for _, r := range s {
		if isZeroWidth(r) {
			return true
		}
	}
	return false
}

// maskSqlComments replaces SQL comment bodies with opaque placeholder
// tokens so template scanning ignores anything inside them. A token
// mentioned only in a comment is documentation, not a live reference;
// substituting it can rewrite comment prose or emit invalid SQL.
//
// The scanner is string-literal / quoted-identifier aware, so a `--`
// inside a literal (`WHERE note LIKE '%--%'`) is NOT mistaken for a
// comment. Comments are restored verbatim by [restoreSqlComments]
// once interpolation is done, so this is invisible in the final SQL.
func maskSqlComments(sql string) (masked string, comments []string) {
	var out strings.Builder
	out.Grow(len(sql))
	push := func(text string) string {
		token := " \x00c" + itoa(len(comments)) + "\x00 "
		comments = append(comments, text)
		return token
	}
	i, n := 0, len(sql)
	for i < n {
		c := sql[i]

		// String literal or quoted identifier — copy verbatim through
		// its close. Postgres uses '' as an escape for a single quote
		// inside a literal; treat "" the same way inside identifiers.
		if c == '\'' || c == '"' || c == '`' {
			quote := c
			out.WriteByte(c)
			i++
			for i < n {
				out.WriteByte(sql[i])
				if sql[i] == quote {
					if i+1 < n && sql[i+1] == quote {
						out.WriteByte(sql[i+1])
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}
			continue
		}

		// Line comment: `--` to end of line (newline stays outside the mask).
		if c == '-' && i+1 < n && sql[i+1] == '-' {
			j := i
			for j < n && sql[j] != '\n' {
				j++
			}
			out.WriteString(push(sql[i:j]))
			i = j
			continue
		}

		// Block comment: `/* ... */`, non-nested.
		if c == '/' && i+1 < n && sql[i+1] == '*' {
			j := i + 2
			for j < n {
				if sql[j] == '*' && j+1 < n && sql[j+1] == '/' {
					break
				}
				j++
			}
			if j < n {
				j += 2
			} else {
				j = n
			}
			out.WriteString(push(sql[i:j]))
			i = j
			continue
		}

		out.WriteByte(c)
		i++
	}
	return out.String(), comments
}

// restoreSqlComments replaces the masking tokens with the original
// comment bodies. `$` sequences inside a comment (e.g. `$1`) survive
// verbatim — we use a plain string replace, no regex.
func restoreSqlComments(sql string, comments []string) string {
	for k, c := range comments {
		token := " \x00c" + itoa(k) + "\x00 "
		sql = strings.Replace(sql, token, c, 1)
	}
	return sql
}

// itoa is a tiny non-allocating decimal formatter for small ints. Kept
// local because strconv.Itoa on tokens shows up in the mask hot path.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
