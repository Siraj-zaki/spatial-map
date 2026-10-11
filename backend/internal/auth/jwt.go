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

// DefaultTokenLifetime is the JWT validity window. Seven days, no refresh —
// the simplest token model that still gives users a "remember me" feel without
// having to build a refresh-token flow up front.
const DefaultTokenLifetime = 7 * 24 * time.Hour

// Claims is the JSON payload carried by signed tokens. The current tenant is
// deliberately NOT in the token — users can switch tenants without re-issuing,
// and tenant membership is verified server-side on each request.
type Claims struct {
	UserID   int64  `json:"uid"`
	Email    string `json:"email"`
	IssuedAt int64  `json:"iat"`
	Expires  int64  `json:"exp"`
}

var (
	// ErrTokenMalformed is returned when the token does not have three parts
	// separated by '.', or any part is not valid base64.
	ErrTokenMalformed = errors.New("token malformed")
	// ErrTokenSignature is returned when the HMAC does not match.
	ErrTokenSignature = errors.New("token signature invalid")
	// ErrTokenExpired is returned when the expiry has passed.
	ErrTokenExpired = errors.New("token expired")
	// ErrSecretMissing is returned when no signing secret is configured.
	ErrSecretMissing = errors.New("jwt secret not configured")
)

// jwtHeader is the constant header for HS256-signed tokens. Pre-encoded so we
// don't redo the base64 work on every issue.
var jwtHeader = b64encode([]byte(`{"alg":"HS256","typ":"JWT"}`))

// IssueToken signs a new token for the given user.
func IssueToken(secret string, userID int64, email string, lifetime time.Duration) (string, error) {
	if secret == "" {
		return "", ErrSecretMissing
	}
	if lifetime <= 0 {
		lifetime = DefaultTokenLifetime
	}
	now := time.Now()
	claims := Claims{
		UserID:   userID,
		Email:    email,
		IssuedAt: now.Unix(),
		Expires:  now.Add(lifetime).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encodedPayload := b64encode(payload)
	signingInput := jwtHeader + "." + encodedPayload
	sig := sign(signingInput, secret)
	return signingInput + "." + sig, nil
}

// ParseToken verifies the signature + expiry and returns the claims.
func ParseToken(secret, token string) (*Claims, error) {
	if secret == "" {
		return nil, ErrSecretMissing
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrTokenMalformed
	}
	signingInput := parts[0] + "." + parts[1]
	expected := sign(signingInput, secret)
	// Constant-time compare to prevent timing attacks.
	if subtle.ConstantTimeCompare([]byte(expected), []byte(parts[2])) != 1 {
		return nil, ErrTokenSignature
	}
	payload, err := b64decode(parts[1])
	if err != nil {
		return nil, ErrTokenMalformed
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, ErrTokenMalformed
	}
	if time.Now().Unix() > claims.Expires {
		return nil, ErrTokenExpired
	}
	return &claims, nil
}

func sign(input, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(input))
	return b64encode(mac.Sum(nil))
}

func b64encode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func b64decode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}
