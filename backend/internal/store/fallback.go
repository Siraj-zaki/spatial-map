package store

import (
	"context"
	"errors"
	"log/slog"
)

// FallbackStore composes two ObjectStores for zero-data-loss cutovers.
//
// Writes go only to `primary`. Reads try `primary` first; on ErrNotFound
// they fall through to `secondary`. This lets us flip storage from local
// disk to MinIO before the bulk-migration script has finished — legacy
// files keep serving from disk, new uploads land in MinIO, and once
// migrate-storage has copied everything the secondary can be dropped.
//
// URL always resolves through the primary because all URLs are relative
// `/files/<key>` proxied through the API's Get handler — the URL doesn't
// depend on which backend actually holds the bytes.
type FallbackStore struct {
	primary   ObjectStore
	secondary ObjectStore
}

// NewFallbackStore wires primary + secondary. Both must be non-nil.
func NewFallbackStore(primary, secondary ObjectStore) *FallbackStore {
	return &FallbackStore{primary: primary, secondary: secondary}
}

// Put writes only to the primary. We do NOT dual-write: if we mirrored
// every upload to disk, the "local disk still around" period would grow
// forever and the whole point of MinIO (offloaded storage) would be
// defeated.
func (s *FallbackStore) Put(ctx context.Context, key string, contentType string, data []byte) error {
	return s.primary.Put(ctx, key, contentType, data)
}

// Get tries primary → secondary. A hit on the secondary is logged at
// info level so operators can see how much legacy traffic still needs
// migrating.
func (s *FallbackStore) Get(ctx context.Context, key string) (Object, error) {
	obj, err := s.primary.Get(ctx, key)
	if err == nil {
		return obj, nil
	}
	if !errors.Is(err, ErrNotFound) {
		// Real transport error on the primary — don't silently mask it
		// with a secondary hit; that would let a MinIO outage look like
		// nothing was wrong for anyone whose files happen to still be
		// on disk.
		return Object{}, err
	}
	obj, secondaryErr := s.secondary.Get(ctx, key)
	if secondaryErr == nil {
		slog.InfoContext(ctx, "storage fallback: served from secondary (run migrate-storage to backfill)", "key", key)
		return obj, nil
	}
	// Prefer surfacing the original ErrNotFound so /files/{key} returns 404.
	if errors.Is(secondaryErr, ErrNotFound) {
		return Object{}, ErrNotFound
	}
	return Object{}, secondaryErr
}

// URL delegates to the primary — same-origin proxy URL either way.
func (s *FallbackStore) URL(key string) string {
	return s.primary.URL(key)
}

// Delete removes the object from BOTH backends. During cutover a legacy
// file may still exist on the local disk secondary; skipping the
// secondary would leave a stale copy that the fallback path would keep
// serving even after the "delete". Errors from either side are joined
// and returned together.
func (s *FallbackStore) Delete(ctx context.Context, key string) error {
	pErr := s.primary.Delete(ctx, key)
	sErr := s.secondary.Delete(ctx, key)
	return errors.Join(pErr, sErr)
}

// ListObjects returns the deduped union of both backends' objects so
// cleanup-orphans catches orphans on either side during the cutover
// window. Primary wins on collision (its metadata is authoritative once
// migrate-storage has run).
func (s *FallbackStore) ListObjects(ctx context.Context) ([]ObjectInfo, error) {
	pObjs, pErr := s.primary.ListObjects(ctx)
	sObjs, sErr := s.secondary.ListObjects(ctx)
	if pErr != nil && sErr != nil {
		return nil, errors.Join(pErr, sErr)
	}
	seen := make(map[string]struct{}, len(pObjs)+len(sObjs))
	merged := make([]ObjectInfo, 0, len(pObjs)+len(sObjs))
	for _, o := range pObjs {
		if _, ok := seen[o.Key]; ok {
			continue
		}
		seen[o.Key] = struct{}{}
		merged = append(merged, o)
	}
	for _, o := range sObjs {
		if _, ok := seen[o.Key]; ok {
			continue
		}
		seen[o.Key] = struct{}{}
		merged = append(merged, o)
	}
	return merged, nil
}

// Primary exposes the underlying primary store. Used by migrate-storage to
// write directly to MinIO without going through the fallback wrapper.
func (s *FallbackStore) Primary() ObjectStore { return s.primary }

// Secondary exposes the underlying secondary store. Used by migrate-storage
// to enumerate legacy files on disk.
func (s *FallbackStore) Secondary() ObjectStore { return s.secondary }
