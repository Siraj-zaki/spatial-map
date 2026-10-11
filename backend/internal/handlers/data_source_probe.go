package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
)

// RestTestRequest is the body for POST /api/v1/data-sources/test-rest.
// Mirrors the SPA's RestSourceConfig shape so the test uses the same
// settings the user is about to save.
type RestTestRequest struct {
	URL            string            `json:"url" validate:"required"`
	Method         string            `json:"method"`
	AuthMode       string            `json:"authMode"`
	APIKey         string            `json:"apiKey"`
	BearerToken    string            `json:"bearerToken"`
	Headers        map[string]string `json:"headers"`
	Body           string            `json:"body"`
	ResponseFormat string            `json:"responseFormat"`
	RootPath       string            `json:"rootPath"`
}

// RestTestResponse is the result of a server-side fetch + parse probe.
type RestTestResponse struct {
	OK          bool                `json:"ok"`
	Status      int                 `json:"status"`
	StatusText  string              `json:"statusText"`
	ContentType string              `json:"contentType"`
	Bytes       int                 `json:"bytes"`
	Kind        string              `json:"kind"`
	Columns     []string            `json:"columns"`
	SampleRows  []map[string]string `json:"sampleRows"`
	RowRead     int                 `json:"rowRead"`
	Errors      []string            `json:"errors"`
	FetchError  string              `json:"fetchError,omitempty"`
	ParseError  string              `json:"parseError,omitempty"`
}

const restTestTimeout = 30 * time.Second
const restTestMaxBytes = 10 * 1024 * 1024

// testRestSource fetches the configured URL server-side, parses the
// response with the same import-pipeline parsers, and returns the
// detected columns + sample rows. This catches config errors the
// browser-side HEAD/GET probe can't — wrong responseFormat, malformed
// JSON rootPath, auth header missing, CSV with quoted newlines, etc.
//
// The handler doesn't need the DB pool — it's a pure fetch + parse.
// Tenant-scoping is enforced by the router middleware (auth header).
func testRestSource(w http.ResponseWriter, r *http.Request) {
	var req RestTestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.BadRequest(w, fmt.Sprintf("invalid request body: %v", err))
		return
	}
	if err := api.ValidateStruct(req); err != nil {
		api.BadRequest(w, err.Error())
		return
	}
	if req.URL == "" {
		api.BadRequest(w, "url is required")
		return
	}

	resp := RestTestResponse{
		OK:     false,
		Errors: []string{},
	}

	method := strings.ToUpper(req.Method)
	if method == "" {
		method = "GET"
	}
	if method != "GET" && method != "POST" {
		api.BadRequest(w, "method must be GET or POST")
		return
	}

	httpReq, err := http.NewRequestWithContext(r.Context(), method, req.URL, nil)
	if err != nil {
		api.BadRequest(w, fmt.Sprintf("invalid URL: %v", err))
		return
	}
	if req.Body != "" && method == "POST" {
		httpReq.Body = io.NopCloser(strings.NewReader(req.Body))
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	switch strings.ToLower(req.AuthMode) {
	case "apikey":
		if req.APIKey != "" {
			httpReq.Header.Set("X-Api-Key", req.APIKey)
		}
	case "bearer":
		if req.BearerToken != "" {
			httpReq.Header.Set("Authorization", "Bearer "+req.BearerToken)
		}
	}

	client := &http.Client{Timeout: restTestTimeout}
	res, err := client.Do(httpReq)
	if err != nil {
		resp.FetchError = err.Error()
		api.JSON(w, http.StatusOK, resp)
		return
	}
	defer res.Body.Close()

	resp.Status = res.StatusCode
	resp.StatusText = res.Status
	resp.ContentType = res.Header.Get("Content-Type")

	bodyBytes, err := io.ReadAll(io.LimitReader(res.Body, restTestMaxBytes+1))
	if err != nil {
		resp.FetchError = fmt.Sprintf("read body: %v", err)
		api.JSON(w, http.StatusOK, resp)
		return
	}
	resp.Bytes = len(bodyBytes)
	if resp.Bytes > restTestMaxBytes {
		resp.FetchError = fmt.Sprintf("response too large: %d bytes (max %d)", resp.Bytes, restTestMaxBytes)
		api.JSON(w, http.StatusOK, resp)
		return
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		resp.FetchError = fmt.Sprintf("HTTP %d %s", res.StatusCode, res.Status)
		api.JSON(w, http.StatusOK, resp)
		return
	}

	kind := pickRestKind(resp.ContentType, req.ResponseFormat)
	resp.Kind = kind

	columns, rows, parseErrors, perr := parseImportFile(bytes.NewReader(bodyBytes), "rest."+kind, kind, "", req.RootPath)
	if perr != nil {
		resp.ParseError = perr.Error()
		api.JSON(w, http.StatusOK, resp)
		return
	}
	resp.Columns = columns
	resp.SampleRows = rows
	if len(rows) > 5 {
		resp.SampleRows = rows[:5]
	}
	resp.RowRead = len(rows)
	resp.Errors = parseErrors
	resp.OK = true

	api.JSON(w, http.StatusOK, resp)
}

func pickRestKind(contentType, hint string) string {
	if hint != "" {
		return hint
	}
	ct := strings.ToLower(contentType)
	if strings.Contains(ct, "geo+json") {
		return "geojson"
	}
	if strings.Contains(ct, "json") {
		return "json"
	}
	if strings.Contains(ct, "csv") || strings.Contains(ct, "tab-separated") {
		return "csv"
	}
	return "json"
}
