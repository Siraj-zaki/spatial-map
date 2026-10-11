package api

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// FormatTime returns an RFC3339 string for a pgtype.Timestamptz.
func FormatTime(t pgtype.Timestamptz) string {
	if !t.Valid {
		return ""
	}
	return t.Time.Format(time.RFC3339)
}
