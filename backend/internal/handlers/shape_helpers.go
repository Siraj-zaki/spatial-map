package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"reflect"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/jackc/pgx/v5/pgtype"
)

func defaultJSONObject(v json.RawMessage) json.RawMessage {
	if len(v) == 0 {
		return json.RawMessage("{}")
	}
	return v
}

func defaultJSONArray(v json.RawMessage) json.RawMessage {
	if len(v) == 0 {
		return json.RawMessage("[]")
	}
	return v
}

type BaseShapeResponse struct {
	ID          int64           `json:"id"`
	TenantID    int64           `json:"tenantId"`
	Name        string          `json:"name"`
	Vertices    json.RawMessage `json:"vertices,omitempty"`
	Rotation    float64         `json:"rotation"`
	Config      json.RawMessage `json:"config,omitempty"`
	ZoneID      *int64          `json:"zoneId,omitempty"`
	FloorPlanID *int64          `json:"floorPlanId,omitempty"`
	Unit        string          `json:"unit"`
	Visible     bool            `json:"visible"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func baseShapeResponse(id, tenantID int64, name string, vertices json.RawMessage, rotation float64, config json.RawMessage, zoneID, floorPlanID pgtype.Int8, unit string, visible bool, createdAt, updatedAt pgtype.Timestamptz) BaseShapeResponse {
	resp := BaseShapeResponse{
		ID:        id,
		TenantID:  tenantID,
		Name:      name,
		Vertices:  vertices,
		Rotation:  rotation,
		Config:    config,
		Unit:      unit,
		Visible:   visible,
		CreatedAt: api.FormatTime(createdAt),
		UpdatedAt: api.FormatTime(updatedAt),
	}
	setInt64Ptr(&resp.ZoneID, zoneID)
	setInt64Ptr(&resp.FloorPlanID, floorPlanID)
	return resp
}

func setInt64Ptr(dst **int64, src pgtype.Int8) {
	if src.Valid {
		v := src.Int64
		*dst = &v
	}
}

func setFloatPtr(dst **float64, src pgtype.Float8) {
	if src.Valid {
		v := src.Float64
		*dst = &v
	}
}

func setFloatParam(dst *pgtype.Float8, src *float64) {
	if src != nil {
		dst.Valid = true
		dst.Float64 = *src
	}
}

// base64Decode wraps stdlib base64 decoding for data URL parsing.
func base64Decode(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

// dataReader wraps a byte slice as an io.Reader for image.DecodeConfig.
func dataReader(data []byte) io.Reader {
	return bytes.NewReader(data)
}

// entityID extracts an int64 "ID" field from a struct or pointer via reflection.
func entityID(v any) int64 {
	if v == nil {
		return 0
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Ptr {
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Struct {
		return 0
	}
	f := rv.FieldByName("ID")
	if !f.IsValid() || !f.CanInt() {
		return 0
	}
	return f.Int()
}

// sseEntityKind maps the singular internal names used by shape_crud helpers to
// the plural, hyphenated entity kinds consumed by the SPA's SSE listener.
func sseEntityKind(name string) string {
	switch name {
	case "polygon":
		return "polygons"
	case "circle":
		return "circles"
	case "line":
		return "lines"
	case "route":
		return "routes"
	case "marker":
		return "markers"
	case "image":
		return "images"
	case "model":
		return "models"
	case "image-plane", "image_plane":
		return "image-planes"
	case "text_label":
		return "text-labels"
	case "attribute_definition":
		return "attribute-definitions"
	case "style_rule":
		return "style-rules"
	case "entity_reference":
		return "references"
	case "user_model":
		return "user-models"
	case "connection":
		return "connections"
	case "data_source":
		return "data-sources"
	case "stream":
		return "streams"
	case "import_job":
		return "import-jobs"
	case "correlation_rule":
		return "correlation-rules"
	case "alert":
		return "alerts"
	case "data_link_config":
		return "data-link-configs"
	}
	return name + "s"
}
