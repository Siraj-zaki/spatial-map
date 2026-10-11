package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Verification tokens are minted between the "email OTP verified" step and
// "password chosen" step of signup. They are structurally similar to the
// login JWT but carry a distinct `scope` claim ("signup", "password_reset",
// …) so a stolen mid-flow token cannot be replayed as a session token.
//
// We keep this file separate from jwt.go to make the two token types
// obviously distinct at the call site.

type verificationClaims struct {
	Email    string `json:"email"`
	Scope    string `json:"scope"`
	IssuedAt int64  `json:"iat"`
	Expires  int64  `json:"exp"`
}

var verificationHeader = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"SGV-VER"}`))

// IssueVerificationToken signs a short-lived token that proves the caller
// controls `email` and has passed the `scope` step (e.g. email OTP). The
// scope tag is checked by ParseVerificationToken so a token issued for one
// flow cannot be replayed against another.
func IssueVerificationToken(secret, email, scope string, lifetime time.Duration) (string, error) {
	if secret == "" {
		return "", ErrSecretMissing
	}
	if lifetime <= 0 {
		lifetime = 15 * time.Minute
	}
	now := time.Now()
	claims := verificationClaims{
		Email:    strings.ToLower(strings.TrimSpace(email)),
		Scope:    scope,
		IssuedAt: now.Unix(),
		Expires:  now.Add(lifetime).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := verificationHeader + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signingInput))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return signingInput + "." + sig, nil
}

// ParseVerificationToken verifies the HMAC + expiry + scope and returns the
// email the token was issued for. Returns "" on any failure.
func ParseVerificationToken(secret, token, expectedScope string) (string, error) {
	email, _, err := ParseVerificationTokenIssued(secret, token, expectedScope)
	return email, err
}

// ParseVerificationTokenIssued is ParseVerificationToken plus the issue
// time, which lets a flow make its token single-use (password reset rejects
// a token issued before the password it would replace was last changed).
func ParseVerificationTokenIssued(secret, token, expectedScope string) (string, time.Time, error) {
	if secret == "" {
		return "", time.Time{}, ErrSecretMissing
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", time.Time{}, ErrTokenMalformed
	}
	signingInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signingInput))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(parts[2])) != 1 {
		return "", time.Time{}, ErrTokenSignature
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", time.Time{}, ErrTokenMalformed
	}
	var claims verificationClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", time.Time{}, ErrTokenMalformed
	}
	if claims.Scope != expectedScope {
		return "", time.Time{}, errors.New("verification token: scope mismatch")
	}
	if time.Now().Unix() > claims.Expires {
		return "", time.Time{}, ErrTokenExpired
	}
	return claims.Email, time.Unix(claims.IssuedAt, 0), nil
}
