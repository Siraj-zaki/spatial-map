package queryx

import (
	"errors"
	"fmt"
	"regexp"
)

// identifierRe is the canonical allow-list for anything that will be
// interpolated into SQL text unquoted (identifiers, JSONB keys). Length
// cap is 128 — the union of the two former callers (executor.go used
// 64, data_source_query.go used 128); the wider bound covers user-defined
// table field keys without loosening what characters are allowed.
var identifierRe = regexp.MustCompile(`^[a-zA-Z0-9_\-\.]{1,128}$`)

// SanitiseField enforces the identifier allow-list. Returns the field
// unchanged on success. Called at every SQL emit site — never trust an
// upstream check, even one that just happened.
func SanitiseField(field string) (string, error) {
	if field == "" {
		return "", errors.New("empty field")
	}
	if !identifierRe.MatchString(field) {
		// Report the first offending rune so the client can highlight it.
		for _, r := range field {
			if !isAllowedIdentifierRune(r) {
				return "", fmt.Errorf("invalid character %q in field", r)
			}
		}
		return "", fmt.Errorf("field %q not a valid identifier", field)
	}
	return field, nil
}

// IsValidIdentifier reports whether s matches the allow-list. Prefer
// [SanitiseField] when you need to surface *why* the check failed.
func IsValidIdentifier(s string) bool {
	return identifierRe.MatchString(s)
}

func isAllowedIdentifierRune(r rune) bool {
	return (r >= 'a' && r <= 'z') ||
		(r >= 'A' && r <= 'Z') ||
		(r >= '0' && r <= '9') ||
		r == '_' || r == '-' || r == '.'
}
