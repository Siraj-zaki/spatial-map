package handlers_test

import (
	"testing"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/stretchr/testify/require"
)

// A `kind='table'` data source has no mirror stream, so the SPA posts
// streamId 0 and the handler maps that to NULL (migration 0034). Guard the
// paired `required_without` tags that let it through: they must still reject
// a config bound to neither a stream nor a source.
func TestDataLinkConfigRequestStreamOrSource(t *testing.T) {
	sourceID := int64(42)
	base := func() handlers.DataLinkConfigRequest {
		return handlers.DataLinkConfigRequest{
			ZoneID:     1,
			Name:       "layer",
			TargetKind: "bins",
			RenderMode: "point-at-coord",
		}
	}

	t.Run("source only", func(t *testing.T) {
		req := base()
		req.SourceID = &sourceID
		require.NoError(t, api.ValidateStruct(req))
	})

	t.Run("stream only", func(t *testing.T) {
		req := base()
		req.StreamID = 7
		require.NoError(t, api.ValidateStruct(req))
	})

	t.Run("both", func(t *testing.T) {
		req := base()
		req.StreamID = 7
		req.SourceID = &sourceID
		require.NoError(t, api.ValidateStruct(req))
	})

	t.Run("neither", func(t *testing.T) {
		require.Error(t, api.ValidateStruct(base()))
	})
}
