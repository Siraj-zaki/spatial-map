# ai-worker

Python service that runs the AI Map floor-plan detection pipeline. Consumed
by the Go API through a Redis-backed Dramatiq queue; reads floor-plan images
from the shared `sgv-uploads` MinIO bucket the rest of the platform already
uses.

## Current: Phase 3 (SAM 2 + doors/stairs + OCR labels)

- FastAPI app at `:8100`
- `GET /healthz` — liveness probe used by docker-compose
- `POST /detect` — enqueues a Dramatiq task, returns `{ taskId }`.
  Full pipeline:
    1. **SAM 2** automatic mask generation
    2. **OpenCV** morphological close + `findContours`
    3. **Shapely** simplify + orient
    4. **Heuristic classifier** — walls / rooms / doors / stairs (aspect + area + fill-density rules)
    5. **Tesseract** OCR — per-word bboxes at confidence >= 60
    6. **Point-in-polygon fusion** — attach OCR text to enclosing room polygons in reading order
    7. **Pixel → lng/lat** reprojection
    8. **GeoJSON FeatureCollection** — walls/doors/stairs as `LineString`, rooms as `Polygon`
- `GET /detect/{taskId}` — polls the Dramatiq result backend

### Local CLI for iterating on the pipeline

```bash
uv run python -m aiworker.pipeline /path/to/floorplan.jpg > out.json
# stderr shows the per-class count summary
```

Runs inside the ai-worker container too:

```bash
docker exec sgv-ai-worker \
    python -m aiworker.pipeline /app/samples/mall.jpg > out.json
```

## Dev

Local (with `uv` installed):

```bash
cd backend/ai-worker
uv sync
uv run uvicorn aiworker.main:app --host 0.0.0.0 --port 8100 --reload
```

Docker (via `backend/docker-compose.yml`):

```bash
cd backend
docker compose up ai-worker
```

## Configuration

All env vars use the same `SGV_<SECTION>.<KEY>` convention as the Go
backend. Names are shared where meaningful (`SGV_STORAGE.MINIO_*` points
at the same bucket).

| Env var | Default | Purpose |
|---|---|---|
| `SGV_AI_WORKER.HOST` | `0.0.0.0` | FastAPI bind host |
| `SGV_AI_WORKER.PORT` | `8100` | FastAPI bind port |
| `SGV_REDIS.URL` | `redis://sgv-redis:6379/0` | Dramatiq broker |
| `SGV_STORAGE.MINIO_ENDPOINT` | `sgv-minio:9000` | S3 endpoint (inside docker) |
| `SGV_STORAGE.MINIO_ACCESS_KEY` | `minioadmin` | dev cred |
| `SGV_STORAGE.MINIO_SECRET_KEY` | `minioadmin` | dev cred |
| `SGV_STORAGE.MINIO_BUCKET` | `sgv-uploads` | shared bucket |
| `SGV_STORAGE.MINIO_USE_SSL` | `false` | dev only |

| `SGV_AI_WORKER.SAM_CHECKPOINT` | `/app/models/sam2.1_hiera_base_plus.pt` | SAM 2 checkpoint path |
| `ANTHROPIC_API_KEY` | _(unset)_ | optional, only for the `geometric` review CLI |

Real secrets live in `backend/.env.development.local` (gitignored), same
place the Go backend reads them.

## Model weights

No model weights are committed to this repository. The only checkpoint the
pipeline needs is Meta's public SAM 2.1 `base_plus` checkpoint, which the
`Dockerfile` downloads at build time from `dl.fbaipublicfiles.com`. For a
local (non-Docker) run, download it yourself and point
`SGV_AI_WORKER.SAM_CHECKPOINT` at the file. Door / stair detection is
heuristic — no YOLO or other custom-trained weights are required.

## Phases (see docs/ai-floorplan.md)

- **Phase 1** — this scaffold, fake detection response
- **Phase 2** — real SAM 2/3 segmentation + OpenCV vectorization
- **Phase 3** — heuristic doors/stairs + Tesseract OCR
- **Phase 4** — Go backend cuts over, retires the Ollama pipeline
- **Phase 5** — frontend adapter (types shift from `AIDetection[]` to `GeoJSON.Feature[]`)
