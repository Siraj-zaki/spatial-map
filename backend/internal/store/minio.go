package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// MinIOStore persists objects in an S3-compatible bucket (MinIO). Files are
// served back through the API's /files/{key} proxy so the DB continues to
// hold same-origin relative URLs — no presigned-URL refresh dance on the
// frontend, no MinIO endpoint leaked to the browser.
//
// Bucket layout is a single shared bucket. Tenant isolation is enforced at
// the DB layer (as with LocalStore); MinIO holds the bytes, nothing about
// who owns them. If per-tenant buckets are needed later, prefix keys with
// `t{tenantID}/` at call sites — the interface accepts arbitrary strings.
type MinIOStore struct {
	client  *minio.Client
	bucket  string
	baseURL string
}

// MinIOConfig captures the credentials + endpoint needed to reach a MinIO
// (or any S3-compatible) service.
type MinIOConfig struct {
	Endpoint  string // host[:port], no scheme
	AccessKey string
	SecretKey string
	Bucket    string
	Region    string // optional; defaults to "us-east-1" server-side
	UseSSL    bool
}

// NewMinIOStore connects to MinIO, ensures the bucket exists, and returns a
// ready-to-use store. Failing here is fatal — callers should crash rather
// than silently fall back to broken storage.
func NewMinIOStore(cfg MinIOConfig, baseURL string) (*MinIOStore, error) {
	if cfg.Endpoint == "" {
		return nil, errors.New("minio store: endpoint is required")
	}
	if cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, errors.New("minio store: access key and secret key are required")
	}
	if cfg.Bucket == "" {
		return nil, errors.New("minio store: bucket is required")
	}

	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("minio store: connect: %w", err)
	}

	// Idempotent bucket create. BucketExists is one round-trip; the extra
	// call is worth it for a clear error on startup vs. a mysterious 500
	// the first time someone uploads a file.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	if err != nil {
		return nil, fmt.Errorf("minio store: check bucket %q: %w", cfg.Bucket, err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{Region: cfg.Region}); err != nil {
			return nil, fmt.Errorf("minio store: create bucket %q: %w", cfg.Bucket, err)
		}
	}

	return &MinIOStore{
		client:  client,
		bucket:  cfg.Bucket,
		baseURL: strings.TrimSuffix(baseURL, "/"),
	}, nil
}

// Put uploads bytes to the bucket under the given key.
func (s *MinIOStore) Put(ctx context.Context, key string, contentType string, data []byte) error {
	if key == "" {
		return errors.New("minio store: key is required")
	}
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	_, err := s.client.PutObject(
		ctx,
		s.bucket,
		key,
		bytes.NewReader(data),
		int64(len(data)),
		minio.PutObjectOptions{ContentType: contentType},
	)
	if err != nil {
		return fmt.Errorf("minio store: put %q: %w", key, err)
	}
	return nil
}

// Get fetches an object by key. Returns ErrNotFound when the object is
// missing so wrapping stores (FallbackStore) can distinguish "not there"
// from "transport error".
func (s *MinIOStore) Get(ctx context.Context, key string) (Object, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return Object{}, fmt.Errorf("minio store: get %q: %w", key, err)
	}
	defer obj.Close()

	data, err := io.ReadAll(obj)
	if err != nil {
		if isMinIONotFound(err) {
			return Object{}, ErrNotFound
		}
		return Object{}, fmt.Errorf("minio store: read %q: %w", key, err)
	}

	stat, err := obj.Stat()
	contentType := ""
	if err == nil {
		contentType = stat.ContentType
	}
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	return Object{ContentType: contentType, Data: data}, nil
}

// URL returns the same-origin proxy URL. The DB always stores relative
// paths — the actual MinIO endpoint is never exposed to the browser.
func (s *MinIOStore) URL(key string) string {
	return s.baseURL + "/" + key
}

// Delete removes an object from the bucket. Missing keys are treated as
// success so retries after a partial failure are safe.
func (s *MinIOStore) Delete(ctx context.Context, key string) error {
	if key == "" {
		return nil
	}
	err := s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
	if err != nil && !isMinIONotFound(err) {
		return fmt.Errorf("minio store: delete %q: %w", key, err)
	}
	return nil
}

// ListObjects streams every object in the bucket. Recursive so it picks
// up any keys with slashes (currently unused, but future tenant-prefix
// layouts would produce them). Size + LastModified come back on the same
// LIST call — no extra HEAD per object.
func (s *MinIOStore) ListObjects(ctx context.Context) ([]ObjectInfo, error) {
	var out []ObjectInfo
	for obj := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Recursive: true}) {
		if obj.Err != nil {
			return nil, fmt.Errorf("minio store: list: %w", obj.Err)
		}
		out = append(out, ObjectInfo{
			Key:        obj.Key,
			Size:       obj.Size,
			UploadedAt: obj.LastModified,
		})
	}
	return out, nil
}

// isMinIONotFound checks whether an error from GetObject/Stat corresponds
// to a missing object. The MinIO SDK surfaces this as an ErrorResponse
// with Code "NoSuchKey", but during a Read() the initial 404 is delayed
// until the body is drained.
func isMinIONotFound(err error) bool {
	if err == nil {
		return false
	}
	var errResp minio.ErrorResponse
	if errors.As(err, &errResp) {
		return errResp.Code == "NoSuchKey" || errResp.StatusCode == http.StatusNotFound
	}
	return false
}
