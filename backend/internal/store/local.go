package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LocalStore writes objects to a filesystem directory and serves them over HTTP.
type LocalStore struct {
	basePath string
	baseURL  string
}

// NewLocalStore creates a local file-backed object store.
func NewLocalStore(basePath, baseURL string) (*LocalStore, error) {
	if basePath == "" {
		return nil, fmt.Errorf("local store basePath is required")
	}
	if err := os.MkdirAll(basePath, 0o755); err != nil {
		return nil, fmt.Errorf("create store path %q: %w", basePath, err)
	}
	baseURL = strings.TrimSuffix(baseURL, "/")
	return &LocalStore{basePath: basePath, baseURL: baseURL}, nil
}

// Put writes data to a file keyed by a content hash plus a timestamp nonce.
func (s *LocalStore) Put(ctx context.Context, key string, contentType string, data []byte) error {
	if key == "" {
		h := sha256.Sum256(data)
		key = fmt.Sprintf("%s-%d", hex.EncodeToString(h[:8]), time.Now().UnixNano())
	}
	path := filepath.Join(s.basePath, key)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// Write to a temp file and rename for atomicity.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Get reads an object from disk.
func (s *LocalStore) Get(ctx context.Context, key string) (Object, error) {
	path := filepath.Join(s.basePath, key)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Object{}, ErrNotFound
		}
		return Object{}, err
	}
	contentType := http.DetectContentType(data)
	return Object{ContentType: contentType, Data: data}, nil
}

// URL returns the absolute URL for a stored object.
func (s *LocalStore) URL(key string) string {
	return s.baseURL + "/" + key
}

// Delete removes an object from disk. A missing file is not an error so
// callers can safely retry / idempotently reclaim after crashes.
func (s *LocalStore) Delete(ctx context.Context, key string) error {
	if key == "" {
		return nil
	}
	path := filepath.Join(s.basePath, key)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ListObjects walks the base directory and returns every regular file
// relative to basePath, with size + modtime. The atomic-write temp files
// LocalStore leaves behind (`*.tmp`) are excluded so a mid-write file
// can't be reported as an orphan.
func (s *LocalStore) ListObjects(ctx context.Context) ([]ObjectInfo, error) {
	var out []ObjectInfo
	err := filepath.WalkDir(s.basePath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if filepath.Ext(path) == ".tmp" {
			return nil
		}
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(s.basePath, path)
		if err != nil {
			return err
		}
		out = append(out, ObjectInfo{
			Key:        filepath.ToSlash(rel),
			Size:       info.Size(),
			UploadedAt: info.ModTime(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// KeyFromData builds a deterministic storage key from a name and content hash.
func KeyFromData(name string, data []byte) string {
	h := sha256.Sum256(data)
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(filepath.Base(name), ext)
	if base == "" {
		base = "asset"
	}
	return fmt.Sprintf("%s-%s%s", base, hex.EncodeToString(h[:12]), ext)
}

// ReadAll is a small helper that drains a reader.
func ReadAll(r io.Reader) ([]byte, error) {
	return io.ReadAll(r)
}
