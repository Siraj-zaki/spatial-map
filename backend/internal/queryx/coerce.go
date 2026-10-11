package queryx

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

// ScalarArg decodes a JSON value into a Go value pgx can bind. The
// target type drives the decode — a numeric filter on a text column
// still coerces `"5"` to `5.0`, so both `"5"` and `5` work at the
// call site.
func ScalarArg(raw json.RawMessage, t FieldType) (any, error) {
	if len(raw) == 0 {
		return nil, errors.New("missing value")
	}
	switch t {
	case FieldNumber:
		var n float64
		if err := json.Unmarshal(raw, &n); err == nil {
			return n, nil
		}
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			f, err := strconv.ParseFloat(s, 64)
			if err != nil {
				return nil, fmt.Errorf("value not numeric: %s", string(raw))
			}
			return f, nil
		}
		return nil, fmt.Errorf("value not numeric: %s", string(raw))
	case FieldBoolean:
		var b bool
		if err := json.Unmarshal(raw, &b); err == nil {
			return b, nil
		}
		// Viewer params (button groups, dropdowns) send strings.
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			if b, err := strconv.ParseBool(s); err == nil {
				return b, nil
			}
		}
		return nil, fmt.Errorf("value not boolean: %s", string(raw))
	case FieldDate, FieldDatetime:
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return s, nil // pgx casts on the SQL side (::date / ::timestamptz)
		}
		return nil, fmt.Errorf("value not date: %s", string(raw))
	default:
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return s, nil
		}
		return string(raw), nil
	}
}

// ArrayArg decodes a JSON array for `in` / `nin` (and the various
// aliases). Each element is coerced through [ScalarArg] with the
// target type.
func ArrayArg(raw json.RawMessage, t FieldType) ([]any, error) {
	var vals []json.RawMessage
	if err := json.Unmarshal(raw, &vals); err != nil {
		return nil, fmt.Errorf("value must be array: %s", string(raw))
	}
	out := make([]any, 0, len(vals))
	for _, v := range vals {
		x, err := ScalarArg(v, t)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, nil
}

// TextArg extracts a plain string. Used by text-only ops (contains /
// starts / ends / regex) that always operate on the text projection.
func TextArg(raw json.RawMessage) (string, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s, nil
	}
	return "", fmt.Errorf("value must be a string: %s", string(raw))
}

// BetweenArg decodes a 2-element array or `{low, high}` object. The
// object form is present for readability in specs authored by hand.
func BetweenArg(raw json.RawMessage, t FieldType) (any, any, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil {
		if len(arr) != 2 {
			return nil, nil, errors.New("between expects a 2-element array")
		}
		lo, err := ScalarArg(arr[0], t)
		if err != nil {
			return nil, nil, err
		}
		hi, err := ScalarArg(arr[1], t)
		if err != nil {
			return nil, nil, err
		}
		return lo, hi, nil
	}
	var obj struct {
		Low  json.RawMessage `json:"low"`
		High json.RawMessage `json:"high"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, nil, fmt.Errorf("between value shape: %s", string(raw))
	}
	lo, err := ScalarArg(obj.Low, t)
	if err != nil {
		return nil, nil, err
	}
	hi, err := ScalarArg(obj.High, t)
	if err != nil {
		return nil, nil, err
	}
	return lo, hi, nil
}

// IntArg extracts an integer (used by lastNDays / nextNDays). Accepts
// either a JSON number or a numeric string.
func IntArg(raw json.RawMessage) (int, error) {
	var n int
	if err := json.Unmarshal(raw, &n); err == nil {
		return n, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		n, err := strconv.Atoi(s)
		if err != nil {
			return 0, fmt.Errorf("value not integer: %s", string(raw))
		}
		return n, nil
	}
	return 0, fmt.Errorf("value must be integer: %s", string(raw))
}
