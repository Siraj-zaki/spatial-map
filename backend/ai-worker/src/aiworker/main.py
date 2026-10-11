"""FastAPI entry point for the ai-worker service.

Two roles run in the same process for Phase 1:
  1. HTTP surface (`GET /healthz`, `POST /detect`, `GET /detect/{task_id}`).
  2. Dramatiq consumer worker — spawned in a background thread on
     startup so the same container both accepts jobs and executes
     them. This is intentional for Phase 1: fewer moving parts to
     debug + docker-compose stays a single service. If we ever need to
     scale detection independently of the HTTP surface, split by
     running two docker-compose services from the same image with
     different `CMD` overrides.
"""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from typing import Any

import dramatiq
from dramatiq.worker import Worker
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from aiworker import __version__
from aiworker.config import Config, load_config
from aiworker.tasks import detect_floorplan

log = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

CONFIG: Config = load_config()


# ---- Request / response schemas ----------------------------------------


class Placement(BaseModel):
    """Image placement on the Mapbox map. Mirrors the fields the Go
    backend reads from the `images` row before enqueue."""

    startLng: float
    startLat: float
    currentLng: float
    currentLat: float
    rotation: float = 0.0
    # Crop is `{top, right, bottom, left}` in percentages 0..100 or null.
    crop: dict[str, float] | None = None


class Region(BaseModel):
    """User-drawn detection region in image UV [0, 1] (y-down)."""

    x0: float
    y0: float
    x1: float
    y1: float


class DetectRequest(BaseModel):
    jobId: int = Field(gt=0)
    imageUrl: str = Field(min_length=1)
    placement: Placement
    region: Region | None = None


class DetectResponse(BaseModel):
    taskId: str


class TaskStatusResponse(BaseModel):
    taskId: str
    status: str            # "pending" | "done" | "failed"
    result: dict[str, Any] | None = None
    error: str | None = None


# ---- Lifespan: start the in-process Dramatiq worker --------------------


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Start a Dramatiq consumer in a background thread on FastAPI
    startup so this single process both queues and executes jobs.
    Stopped cleanly on shutdown to drain any in-flight work."""

    broker = dramatiq.get_broker()
    worker = Worker(broker, worker_timeout=1000)
    # `Worker` internally runs its own thread pool for actors, but the
    # supervisor loop needs to run somewhere. Threading it lets uvicorn
    # keep the main event loop free for HTTP.
    t = threading.Thread(target=worker.start, daemon=True, name="dramatiq-worker")
    t.start()
    log.info("ai-worker %s ready", __version__)
    try:
        yield
    finally:
        log.info("ai-worker shutting down, stopping dramatiq worker")
        worker.stop()


app = FastAPI(
    title="sgv-ai-worker",
    version=__version__,
    lifespan=lifespan,
)


# ---- Routes ------------------------------------------------------------


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe used by docker-compose healthcheck. Stays cheap:
    no Redis / MinIO checks here — an ML-heavy container can be slow
    to load models, and forcing a full-stack probe on every /healthz
    would cause flaky container restarts."""

    return {"status": "ok", "version": __version__}


@app.post("/detect", response_model=DetectResponse, status_code=202)
def detect(req: DetectRequest) -> DetectResponse:
    """Enqueue a detection job. Returns the Dramatiq message id — the
    Go side polls /detect/{task_id} for status + result rather than
    speaking Dramatiq wire protocol directly."""

    message = detect_floorplan.send(req.model_dump())
    return DetectResponse(taskId=message.message_id)


@app.get("/detect/{task_id}", response_model=TaskStatusResponse)
def detect_status(task_id: str) -> TaskStatusResponse:
    """Poll a detection job. Result stays in the Dramatiq result
    backend (Redis, 1 h TTL) until the Go side has copied the payload
    into `ai_jobs.detections`."""

    # Dramatiq's result API is per-message-id. We reconstruct a
    # lightweight Message shell to query the backend.
    from dramatiq import Message  # local import: keeps startup fast

    msg = Message(
        queue_name=detect_floorplan.queue_name,
        actor_name=detect_floorplan.actor_name,
        args=(),
        kwargs={},
        options={},
        message_id=task_id,
        message_timestamp=0,
    )
    try:
        result = msg.get_result(backend=None, block=False, timeout=100)
    except dramatiq.results.errors.ResultMissing:
        return TaskStatusResponse(taskId=task_id, status="pending")
    except dramatiq.results.errors.ResultFailure as e:
        return TaskStatusResponse(taskId=task_id, status="failed", error=str(e))
    except Exception as e:  # noqa: BLE001 — any other failure is unexpected
        raise HTTPException(status_code=500, detail=f"result lookup failed: {e}") from e
    return TaskStatusResponse(taskId=task_id, status="done", result=result)
