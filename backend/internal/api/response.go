package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"time"
)

// Response is the standard JSON envelope for API responses.
type Response struct {
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
	// Code is a stable machine-readable reason for an error. Set only by
	// endpoints whose clients branch on the failure (the /auth/* flows):
	// the SPA maps it to a translated message, so `Error` stays an English
	// hint for logs and curl users and is never shown verbatim.
	Code string `json:"code,omitempty"`
}

// JSON writes a JSON response with the given status code.
func JSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Response{Data: data})
}

// Error writes a JSON error response.
func Error(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Response{Error: message})
}

// ErrorCode writes a JSON error response carrying a machine-readable code
// alongside the human-readable message. See Response.Code.
func ErrorCode(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Response{Error: message, Code: code})
}

// CodeRateLimited is the Response.Code every throttled request carries.
const CodeRateLimited = "rate_limited"

// TooManyRequests writes a 429 with a Retry-After header (whole seconds,
// at least 1) so clients can count down to the next allowed attempt
// instead of guessing.
func TooManyRequests(w http.ResponseWriter, retryAfter time.Duration, message string) {
	secs := int(math.Ceil(retryAfter.Seconds()))
	if secs < 1 {
		secs = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	ErrorCode(w, http.StatusTooManyRequests, CodeRateLimited, message)
}

// BadRequest writes a 400 response.
func BadRequest(w http.ResponseWriter, message string) {
	Error(w, http.StatusBadRequest, message)
}

// NotFound writes a 404 response.
func NotFound(w http.ResponseWriter, message string) {
	Error(w, http.StatusNotFound, message)
}

// InternalError writes a 500 response and logs the error so server logs
// surface the actual cause (the client message stays opaque on purpose).
func InternalError(w http.ResponseWriter, r *http.Request, err error) {
	slog.ErrorContext(r.Context(), "internal server error",
		"path", r.URL.Path,
		"method", r.Method,
		"error", err,
	)
	Error(w, http.StatusInternalServerError, "internal server error")
}

// DecodeBody parses the request body into dst.
func DecodeBody(r *http.Request, dst any) error {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		return fmt.Errorf("decode body: %w", err)
	}
	return nil
}

// IDParam parses a chi URL parameter as an int64.
func IDParam(r *http.Request, key string) (int64, error) {
	v := r.PathValue(key)
	if v == "" {
		return 0, errors.New("missing id parameter")
	}
	id, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid id: %w", err)
	}
	return id, nil
}

// IntQuery parses an integer query parameter.
func IntQuery(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// Int64Query parses an int64 query parameter.
func Int64Query(r *http.Request, key string, def int64) int64 {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}
