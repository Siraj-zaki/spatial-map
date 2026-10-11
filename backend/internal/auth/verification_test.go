package auth

import (
	"testing"
	"time"
)

// TestVerificationToken_IssuedAtRoundTrips covers what password reset's
// single-use check relies on: the issue time survives the round trip.
func TestVerificationToken_IssuedAtRoundTrips(t *testing.T) {
	before := time.Now().Unix()
	tok, err := IssueVerificationToken("secret", "A@Example.com", "password_reset", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	email, issued, err := ParseVerificationTokenIssued("secret", tok, "password_reset")
	if err != nil {
		t.Fatal(err)
	}
	if email != "a@example.com" {
		t.Fatalf("email = %q, want normalised a@example.com", email)
	}
	if issued.Unix() < before || issued.Unix() > time.Now().Unix() {
		t.Fatalf("issued = %v, want within the test's run", issued)
	}
}

// TestVerificationToken_ScopeIsolation stops a signup token from being
// replayed against password reset and vice versa.
func TestVerificationToken_ScopeIsolation(t *testing.T) {
	tok, err := IssueVerificationToken("secret", "a@example.com", "signup", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ParseVerificationTokenIssued("secret", tok, "password_reset"); err == nil {
		t.Fatal("a signup-scoped token must not parse as a password_reset token")
	}
}
