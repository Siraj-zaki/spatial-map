package auth

import (
	"errors"
	"strings"
	"unicode"
)

// MinPasswordLength is the floor for accepted passwords. Raised from 8 to
// 12 in the security-hardening pass — the 8-char default let trivial
// passwords like "password" (8) and "12345678" (8) through.
const MinPasswordLength = 12

// commonPasswords rejects the most-abused strings so an attacker can't
// score an account on the first login attempt. Not a full haveibeenpwned
// list — that would require an external dependency or a bundled dataset.
// These are the top offenders that show up in every real leak. Lowercased
// at comparison time; substring matches also caught below to catch
// "Password123!" style variants.
var commonPasswords = map[string]struct{}{
	"password":      {},
	"password1":     {},
	"password12":    {},
	"password123":   {},
	"password1234":  {},
	"passw0rd":      {},
	"12345678":      {},
	"123456789":     {},
	"1234567890":    {},
	"qwertyuiop":    {},
	"qwerty12":      {},
	"qwerty123":     {},
	"qwerty1234":    {},
	"qwertyui":      {},
	"asdfghjkl":     {},
	"letmein12":     {},
	"letmein123":    {},
	"welcome12":     {},
	"welcome123":    {},
	"admin1234":     {},
	"admin12345":    {},
	"administrator": {},
	"changeme":      {},
	"changeme12":    {},
	"changeme123":   {},
	"iloveyou1":     {},
	"iloveyou12":    {},
	"trustno1234":   {},
	"monkey1234":    {},
	"sunshine1":     {},
	"princess1":     {},
	"dragon1234":    {},
	"master1234":    {},
	"football1":     {},
	"baseball1":     {},
	"superman1":     {},
	"batman1234":    {},
	"pokemon12":     {},
	"starwars1":     {},
	"minecraft":     {},
	"iloveyou123":   {},
}

// substringBlocklist rejects any password that CONTAINS one of these
// tokens (case-insensitive). Catches "Password123!" / "MyP@ssword2024" /
// "admin1234!" style variants that beat the exact-match filter.
var substringBlocklist = []string{
	"password",
	"qwerty",
	"letmein",
	"welcome",
	"12345678",
	"iloveyou",
	"admin123",
}

// ValidatePassword returns nil when `pw` is acceptable, or a caller-facing
// error message describing why it isn't. Rules:
//  1. Length ≥ MinPasswordLength.
//  2. Not one of the top-abused literals (see commonPasswords).
//  3. Doesn't contain a blocklisted substring (case-insensitive).
//  4. Character diversity: at least three of {lowercase, uppercase, digit,
//     symbol} — a 12-char all-lowercase string is still weak.
func ValidatePassword(pw string) error {
	if len(pw) < MinPasswordLength {
		return errors.New("password must be at least 12 characters")
	}
	lower := strings.ToLower(pw)
	if _, ok := commonPasswords[lower]; ok {
		return errors.New("password is too common — pick something less predictable")
	}
	for _, needle := range substringBlocklist {
		if strings.Contains(lower, needle) {
			return errors.New("password is too common — pick something less predictable")
		}
	}
	var hasLower, hasUpper, hasDigit, hasSymbol bool
	for _, r := range pw {
		switch {
		case unicode.IsLower(r):
			hasLower = true
		case unicode.IsUpper(r):
			hasUpper = true
		case unicode.IsDigit(r):
			hasDigit = true
		case unicode.IsPunct(r) || unicode.IsSymbol(r) || r == ' ':
			hasSymbol = true
		}
	}
	classes := 0
	for _, ok := range []bool{hasLower, hasUpper, hasDigit, hasSymbol} {
		if ok {
			classes++
		}
	}
	if classes < 3 {
		return errors.New("password must mix at least 3 of: lowercase, uppercase, digits, symbols")
	}
	return nil
}
