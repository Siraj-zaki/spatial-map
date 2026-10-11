"""Dramatiq actor for AI Map detection jobs.

Phase 2 wires the actor to the real CV pipeline (SAM 2 → OpenCV →
Shapely → GeoJSON). The wire format stays identical to the Phase 1
stub so the Go side (still on the Ollama path in Phase 2) doesn't have
to change until Phase 4.

Payload shape (locked in for the Phase 1→2 handoff, unchanged):

    {
        "jobId": int,
        "imageUrl": str,       # /files/<key> — resolved via storage.key_from_files_url
        "placement": {
            "startLng": float, "startLat": float,
            "currentLng": float, "currentLat": float,
            "rotation": float,
            "crop": {"top": pct, "right": pct, "bottom": pct, "left": pct} | None,
        },
        "region": {"x0": float, "y0": float, "x1": float, "y1": float} | None,
    }

Return shape: GeoJSON FeatureCollection in Mapbox lng/lat, one Feature
per detected wall / room. Properties carry `class`, `label`,
`confidence`, `area_pixels`.
"""

from __future__ import annotations

import logging
from typing import Any

import dramatiq
from dramatiq.brokers.redis import RedisBroker
from dramatiq.results import Results
from dramatiq.results.backends import RedisBackend

from aiworker.clients.storage import StorageClient, key_from_files_url
from aiworker.config import load_config
from aiworker.pipeline.run import detect

log = logging.getLogger(__name__)

# Broker + result backend at module import. Same rationale as Phase 1:
# fail-loud at enqueue time if Redis is unreachable rather than
# bootlooping the container.
_cfg = load_config()
_backend = RedisBackend(url=_cfg.redis.url)
_broker = RedisBroker(url=_cfg.redis.url)
_broker.add_middleware(Results(backend=_backend))
dramatiq.set_broker(_broker)

# Single shared storage client. The Minio client is thread-safe;
# concurrent actors reuse this instance.
_storage: StorageClient | None = None


def _storage_client() -> StorageClient:
    global _storage
    if _storage is None:
        _storage = StorageClient(_cfg.storage)
    return _storage


@dramatiq.actor(store_results=True, max_retries=1, time_limit=300_000)
def detect_floorplan(job: dict[str, Any]) -> dict[str, Any]:
    """Run detection on a placed floor plan.

    Steps:
      1. Resolve /files/<key> → bucket key → download bytes via MinIO
      2. Run the pipeline (SAM → vectorize → classify → reproject)
      3. Return the resulting FeatureCollection to Dramatiq's result
         backend so /detect/{task_id} can hand it to the Go side

    Errors are re-raised (not swallowed) so Dramatiq marks the message
    failed and /detect/{task_id} returns status='failed' with the
    exception string. The Go side surfaces that to the user as the
    job's `error` field.
    """

    job_id = job.get("jobId")
    image_url = job.get("imageUrl") or ""
    log.info("detect_floorplan: jobId=%s imageUrl=%s", job_id, image_url)

    key = key_from_files_url(image_url)
    if not key:
        raise ValueError(f"detect_floorplan: unparseable imageUrl {image_url!r}")

    image_bytes = _storage_client().get_bytes(key)
    log.info("detect_floorplan: fetched %d bytes for jobId=%s", len(image_bytes), job_id)

    result = detect(
        image_bytes=image_bytes,
        placement=job.get("placement") or {},
        region=job.get("region"),
    )
    log.info(
        "detect_floorplan: done jobId=%s features=%d",
        job_id, len(result.get("features", [])),
    )
    return result
