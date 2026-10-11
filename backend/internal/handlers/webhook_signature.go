package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Webhook request signing — the same wire format the local Worker checks
// (worker/src/lib/auth-hmac.ts), so a sender signs once for either target:
//
//	X-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
//
// The HMAC is computed over "<t>.<raw body>" with the source's hmacSecret.
// Several v1 entries may be sent while a secret is being rotated; any match
// passes. Requests more than webhookMaxSkew from the server clock are
// rejected so a captured request cannot be replayed later.

const (
	webhookSignatureHeader = "X-Webhook-Signature"
	webhookMaxSkew         = 300 * time.Second
)

var (
	errSignatureMissing  = errors.New("missing or malformed " + webhookSignatureHeader + " (expected t=<unix>,v1=<hex>)")
	errSignatureSkew     = errors.New("signature timestamp is more than 300s from server time")
	errSignatureMismatch = errors.New("signature does not match the request body")
)

// webhookSigning is the part of a webhook stream's endpoint JSON that
// decides verification. RequireSignature is a pointer so an absent field
// (every source saved before verification existed) reads as "required";
// only an explicit false lets an unsigned legacy sender through.
type webhookSigning struct {
	HMACSecret       string `json:"hmacSecret"`
	RequireSignature *bool  `json:"requireSignature"`
}

func webhookSigningFor(endpoint json.RawMessage) webhookSigning {
	var s webhookSigning
	_ = json.Unmarshal(endpoint, &s)
	return s
}

// checkWebhookSignature applies the stream's policy to one request:
//   - no secret configured                → accept (nothing to verify against)
//   - header present                      → must verify, whatever the policy
//   - header absent, requireSignature=false → accept (legacy opt-out)
//   - header absent otherwise             → reject
func checkWebhookSignature(s webhookSigning, header string, body []byte, now time.Time) error {
	if s.HMACSecret == "" {
		return nil
	}
	if header == "" {
		if s.RequireSignature != nil && !*s.RequireSignature {
			return nil
		}
		return errSignatureMissing
	}
	return verifyWebhookSignature(header, body, s.HMACSecret, now)
}

func verifyWebhookSignature(header string, body []byte, secret string, now time.Time) error {
	var ts int64
	var sigs [][]byte
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				return errSignatureMissing
			}
			ts = n
		case "v1":
			b, err := hex.DecodeString(v)
			if err != nil {
				return errSignatureMissing
			}
			sigs = append(sigs, b)
		}
	}
	if ts == 0 || len(sigs) == 0 {
		return errSignatureMissing
	}
	if d := now.Sub(time.Unix(ts, 0)); d > webhookMaxSkew || d < -webhookMaxSkew {
		return errSignatureSkew
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10)))
	mac.Write([]byte{'.'})
	mac.Write(body)
	want := mac.Sum(nil)
	for _, sig := range sigs {
		if hmac.Equal(sig, want) {
			return nil
		}
	}
	return errSignatureMismatch
}
