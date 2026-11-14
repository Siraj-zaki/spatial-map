// Package handlers — tables_helpers.go
//
// Small helpers shared between the authed tables.go handlers and the
// public table_rows_public.go handlers: random plaintext-token
// generation and the wire shape for `data_source_row_events`.
package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
)

// generateTokenRandom returns `n` random bytes as a lowercase hex
// string. Used to mint plaintext API tokens — `n=32` gives 256 bits
// of entropy, plenty for a per-table write credential. We use
// `crypto/rand` (not `math/rand`) so the output is unpredictable
// enough to be a credential.
func generateTokenRandom(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand should never fail on a sane host. If it does,
		// panic is preferable to a predictable credential — the
		// caller's database would be writable by anyone with the
		// deterministic fallback.
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// dataSourceRowEventResponse — wire shape for a `data_source_row_event`.
// `payload` is the full row snapshot at each event (not a diff),
// matching `entity_events` semantics; the frontend renders it as a
// timeline + computes field-level diffs between consecutive snapshots.
// `authTokenId` is included so the manage-tokens view can show "last
// used by token N" without a second query.
type dataSourceRowEventResponse struct {
	ID          int64           `json:"id"`
	SourceID    int64           `json:"sourceId"`
	EntityKey   string          `json:"entityKey"`
	Operation   string          `json:"operation"`
	TS          string          `json:"ts"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	SourceIP    string          `json:"sourceIp,omitempty"`
	AuthTokenID *int64          `json:"authTokenId,omitempty"`
}

func toDataSourceRowEventResponse(row db.DataSourceRowEvent, public bool) dataSourceRowEventResponse {
	resp := dataSourceRowEventResponse{
		ID:        row.ID,
		SourceID:  row.SourceID,
		EntityKey: row.EntityKey,
		Operation: row.Operation,
		TS:        api.FormatTime(row.Ts),
		Payload:   row.Payload,
	}
	if public {
		return resp
	}
	if row.SourceIp.Valid {
		resp.SourceIP = row.SourceIp.String
	}
	if row.AuthTokenID.Valid {
		v := row.AuthTokenID.Int64
		resp.AuthTokenID = &v
	}
	return resp
}
