"""Thin minio-py wrapper matching the Go backend's key convention.

Every image the Go side uploads is content-addressed under the
`sgv-uploads` bucket via a key like
`<name>-<sha256[:12]>.<ext>` (see `backend/internal/store/store.go`).
The DB row's `image_url` stores a relative `/files/<key>` path — we
strip the `/files/` prefix here to get the raw bucket key.

Phase 1 only implements the read path (workers download the image
bytes). The write path (uploading the resulting GeoJSON) is Phase 4.
"""

from __future__ import annotations

import logging
from io import BytesIO

from minio import Minio
from minio.error import S3Error

from aiworker.config import StorageConfig

log = logging.getLogger(__name__)


def key_from_files_url(url: str) -> str:
    """Extract the raw bucket key from a `/files/<key>` URL.

    Mirrors `store.KeyFromURL` in Go — same logic, no shared code.
    Returns an empty string for URLs that don't look like our proxy
    path (external images, absolute URLs, etc.) so the caller can
    treat "no key" as "not our object" rather than raising.
    """

    if not url:
        return ""
    idx = url.find("/files/")
    if idx < 0:
        return ""
    key = url[idx + len("/files/") :]
    # Strip any query string; the Go side does the same.
    q = key.find("?")
    if q >= 0:
        key = key[:q]
    return key


class StorageClient:
    """Minio wrapper. Instantiate once per process — the underlying
    client holds a connection pool and is safe to reuse across
    goroutine-equivalent Dramatiq actors."""

    def __init__(self, cfg: StorageConfig) -> None:
        self._cfg = cfg
        self._client = Minio(
            endpoint=cfg.endpoint,
            access_key=cfg.access_key,
            secret_key=cfg.secret_key,
            secure=cfg.use_ssl,
        )

    def get_bytes(self, key: str) -> bytes:
        """Download an object by key. Raises S3Error on missing / auth
        failure — the actor's error handler translates that into a job
        failure the Go side surfaces to the user."""

        response = None
        try:
            response = self._client.get_object(self._cfg.bucket, key)
            buf = BytesIO()
            for chunk in response.stream(64 * 1024):
                buf.write(chunk)
            return buf.getvalue()
        except S3Error as exc:
            log.error(
                "storage.get_bytes failed: bucket=%s key=%s err=%s",
                self._cfg.bucket, key, exc,
            )
            raise
        finally:
            if response is not None:
                response.close()
                response.release_conn()
