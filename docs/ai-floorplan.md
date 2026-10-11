# AI Map — Floor Plan Detection

Feature: the **AI Map** tool (letter `A`, Sparkles icon) sends a placed
floor plan image to an in-house Python detection service and returns
draft aisles / areas / doors / stairs for the user to review + accept.
Shipped beta 2026-08 on an Ollama Cloud VLM; rewritten 2026-08 to a
hybrid CV+ML pipeline (SAM 2 + Tesseract + OpenCV + Shapely) after the
VLM path proved unusable for warehouse plans.

This doc covers what a future engineer needs to touch the feature:
architecture, pipeline stages, coord math, guards, and pitfalls. Route
+ endpoint reference lives in `ARCHITECTURE.md §6.4 "AI floor plan detection"`.

---

## Why a CV pipeline, not a VLM

The 2026 landscape at rewrite time:

- **VLMs (Qwen3-VL, Gemma 4, Kimi 2.7 via Ollama Cloud)** — zero-shot
  on any imagery but bbox coord accuracy tops out around 45%
  (GroundingME benchmark). On real warehouse plans the numbers were
  worse: doors 3→34 across a 6-plan corpus with an aggressively
  prompt-engineered v2; interior doors regularly missed; aisle recall
  never crossed 30%.
- **Hybrid CV+ML (CubiCasa / Maket / VectoSolve)** — U-Net for walls,
  Mask R-CNN for doors, OCR for labels. Trained on *residential*
  plans; not portable to warehouses. But the **shape** of the pipeline
  is portable: segment → vectorize → classify → OCR-fuse.
- **Foundation segmenters (SAM 2)** — class-agnostic, work on any
  imagery zero-shot, produce clean masks at wall-thickness resolution.
  Not a floor-plan model, but a floor plan is just an image and the
  classifier that comes next is where our domain knowledge lives.

Choice: **SAM 2 for segmentation, heuristic classifier for kind,
Tesseract for labels, Shapely for geometry.** Framed as **draft** —
users review + accept each detection through the same review dialog the
VLM version used.

---

## Architecture

```
Frontend (React)              Backend Go (dispatcher)          Python ai-worker
─────────────────             ──────────────────────           ────────────────
[click floor plan] ─POST /detect─► handler.StartDetection
   (or drag for region)                │
                                       ├── Guards: tenant, flag, rate, cap, ownership
                                       ├── INSERT ai_jobs (status='pending')
   ◄──── 202 { jobId } ────            ├── SSE broadcast (ai-jobs)
                                       └── go runDetectionJob(…)
                                              │
                                              ├── MarkAIJobRunning + SSE
                                              │
                                              ├─── POST /detect ───────► FastAPI /detect
                                              │  (aiworker.Client)          │
                                              │                             ├── Dramatiq enqueue
                                              │  ◄─── 202 {taskId} ────     │
                                              │                             │
                                              ├── SetAIJobWorkerTaskID      ▼
                                              │                       [background actor]
                                              │                             │
                                              │  ┌──── poll every 3s ────►  ├── pipeline.detect(...)
                                              │  │  GET /detect/{taskId}    │  ├── MinIO GET /files/<key>
                                              │  │                          │  ├── decode + optional crop
                                              │  │  ◄─── {status: ...} ─    │  ├── SAM 2 auto-mask
                                              │  │                          │  ├── vectorize → Shapely
                                              │  │                          │  ├── classify (heuristic)
                                              │  │                          │  ├── Tesseract OCR + fusion
                                              │  │                          │  └── reproject → lng/lat
                                              │  │  ◄── {status:done,       ◄──┘
                                              │  │       result:{...}}
                                              │  │
                                              │  └─── CompleteAIJob(detections JSONB)
                                              │
                                              └── SSE broadcast (ai-jobs)

   ◄──── SSE(ai-jobs) ────                                      MinIO (shared)
   fetch /jobs/{jobId}                                          ────────────
   render detections in                                         sgv-uploads bucket
   AIDetectionReviewDialog                                      (api + worker both
                                                                have credentials)
```

**Key architectural choices:**

- **Go is a dispatcher, not a detector.** Handler is a thin proxy over
  `aiworker.Client` (`backend/internal/aiworker/client.go`). Enqueue →
  Poll → hand JSON to sqlc. Zero pixel bytes cross the Go process.
- **Python actor runs off-process.** Dramatiq (Redis broker) so the
  worker restarts cleanly if a job OOMs from a giant blueprint without
  taking the FastAPI process with it.
- **MinIO is the shared drop.** Both services have the same credentials;
  the worker fetches `/files/<key>` directly from the bucket instead of
  round-tripping bytes through the Go API.
- **Detections are passed through as `json.RawMessage`.** Python emits
  the exact `AIDetection` shape the SPA consumes (`src/lib/ai-client.ts`).
  A Phase-7 pipeline upgrade that adds a property is a zero-Go-change
  deploy — only the SPA-side generator/overlay needs the field.
- **Poll, not webhook.** MVP-simple, matches the existing `polling/`
  package's shape. A future webhook path would replace `Poll` with a
  small SSE-style push endpoint on the Go side.

Key insight: **once accepted, an AI detection is a normal shape row**.
Undo, SSE, multi-tenant scoping, layer visibility, style-rules — all
work for free. The AI layer is an ephemeral draft overlay that hands
off to the persistent spatial-store shapes.

---

## Python pipeline stages

Every stage lives under `backend/ai-worker/src/aiworker/pipeline/`.
Stages are decoupled: swapping SAM 2 for FloorSAM only touches
`segment.py`; swapping Tesseract for PaddleOCR only touches `ocr.py`.

| Stage | File | What it does |
|---|---|---|
| Decode + optional crop | `run.py` | PNG/JPEG bytes → HxWx3 uint8 RGB. Region-select clips the array before SAM sees it. |
| Segment | `segment.py` | SAM 2 automatic mask generator over the whole image. Class-agnostic; every visually distinct region becomes a boolean mask. |
| Vectorize | `vectorize.py` | Each mask → OpenCV morphological close → `findContours` → Shapely polygon → simplify (~0.5% of perimeter). Filters micro-fragments. |
| Classify | `classify.py` | Heuristic per-shape kind assignment (`Kind` enum: `WALL`/`ROOM`/`DOOR`/`STAIR`/`BACKGROUND`/`UNKNOWN`). Aspect ratio + area + compactness thresholds. |
| OCR | `ocr.py` | Tesseract via `pytesseract` on the (possibly cropped) image, RGB → bytes → words + bboxes. |
| Fusion | `fusion.py` | Point-in-polygon match: each OCR word attaches to the classified shape whose polygon contains its centroid. Provides room labels like `WET LAB 1 G109`. |
| Reproject | `reproject.py` | Pixel `(x, y)` → Mapbox `[lng, lat]` using the same forward math the SPA uses to render placed images. Mirrors `src/lib/image-generators.ts::imageUVToLngLat`. |
| Emit | `run.py::_feature_from_classified` | Assemble the SPA-shape detection object. Line kinds collapse to their long axis; ROOM stays as a polygon ring. Kind gets remapped through `_KIND_TO_SPA` (see next section). |

The whole thing runs synchronously inside the Dramatiq actor
(`backend/ai-worker/src/aiworker/main.py`). Result payload is stored on
the task, returned via GET `/detect/{taskId}` when the Go side polls.

Pipeline version tag: `_PIPELINE_VERSION` in `run.py` ("pyworker-phase3-sam2+tesseract"
at time of writing). Included in every result payload for support triage.

---

## Kind vocabulary boundary

The Python classifier speaks generic CV language; the SPA speaks
warehouse-product language. `run.py::_KIND_TO_SPA` translates once at
the emit boundary so both sides keep their idioms:

| Python `Kind` | SPA `AIDetectionKind` | Written as |
|---|---|---|
| `WALL` | `aisle` | `apiDb.lines.add` (aisles in this project ARE lines — see i18n `layerLine: "Aisles / lines"`; walls in a warehouse plan are the rack rows that define aisles) |
| `ROOM` | `area` | `apiDb.polygons.add` (`role` unset — tenant's `roleVocabulary` drives the picker) |
| `DOOR` | `door` | `apiDb.doors.add` (two jamb anchors from line endpoints) |
| `STAIR` | `stair` | `apiDb.stairs.add` (two anchors bottom→top; `stairType='straight'`) |

`BACKGROUND` and `UNKNOWN` never leave the classifier — filtered by
`_EMIT_KINDS` in `run.py`.

`backend/ai-worker/tests/test_run_emit.py` guards this contract with
three tests: every emit kind has a SPA mapping, every mapped value is
in the SPA union, and all four product-vocabulary kinds are covered.
Adding a new `Kind` without a matching entry fails these tests loud
instead of silently returning `undefined` at SPA accept time.

Racks and text-labels are still **not** in v1 (see "Deferred" below).

---

## Coordinate math

The Python pipeline computes shapes in **pixel space** (SAM's native
coordinate system). Reprojection to Mapbox lng/lat happens once at
emit time in `backend/ai-worker/src/aiworker/pipeline/reproject.py::pixel_to_lnglat`.

The forward math mirrors the SPA-side `src/lib/image-generators.ts::imageUVToLngLat`
that renders placed images:

1. **Pixel → normalized UV.** `u = x / image_width`, `v = y / image_height`
   (y-down, PIL/OpenCV convention).
2. **Apply crop.** `placement.crop` is `{top,right,bottom,left}` in
   **percentages** (0–100, not fractions). The visible rectangle is:
   ```
   croppedMinLng = minLng + width * crop.left / 100
   croppedMaxLng = maxLng - width * crop.right / 100
   croppedMinLat = minLat + height * crop.bottom / 100
   croppedMaxLat = maxLat - height * crop.top / 100
   ```
3. **Interpolate.** `u` across the cropped bbox; `v` **flipped**:
   `v=0` maps to `maxLat` (image TOP), `v=1` maps to `minLat` (BOTTOM).
4. **Rotate.** Around the **FULL** bbox center (matches turf's
   `transformRotate` pivot). Equirectangular approximation scaled by
   `cos(centerLat)`; sub-millimeter accuracy at floor-plan scales.

Round-trip tests in `backend/ai-worker/tests/test_reproject.py` confirm
< 1e-9 drift over the corner cases. The SPA's own round-trip test in
`src/lib/image-generators.test.ts` guards the JS-side inverse.

---

## Region-select

Users can drag a rectangle on top of a placed image (while the AI Map
tool is active) to constrain detection to that region. The Python
worker crops the image bytes to the region BEFORE running SAM 2 —
smaller frames mean more pixels per feature and fewer irrelevant masks
to classify.

**Frontend drag UX** (`src/routes/create-grids/index.tsx`):
- Mousedown captures start point via a ref while `activeTool === 'ai-map'`.
- The existing `handleImageClickDispatch` compares the click's `offset`
  to the ref's saved position: `distPx > 10` → region drag, else → whole-image click.
- Region UV computed via `imageLngLatToUV` for both endpoints, clamped
  to `[0, 1]`; zero-area regions fall back to whole-image.
- `useAIMapTool.startForImage(id, region?)` accepts the optional region.

**Wire format** (`aiworker.Region` in Go, `Region` pydantic in Python):
```json
{ "x0": 0.2, "y0": 0.3, "x1": 0.7, "y1": 0.8 }
```

**Worker-side crop** (`run.py::_crop_image` + `_placement_to_frame`):
The array is sliced to the region UV, and the region is composed INTO
the frame's crop percentages so the reprojection math still maps the
pipeline's pixel coords back to full-image world coords. A trivial
region (whole image) falls through as a no-op crop.

---

## Guards on the detect endpoint

Ordered cheapest-first, so a burst of denials doesn't touch the DB:

1. **Tenant present** (401 without) — normal middleware.
2. **Feature configured server-wide** (`cfg.Worker.BaseURL` non-empty) —
   503 otherwise. Set via `SGV_AI_WORKER.URL`; empty means the operator
   isn't running the worker in this deployment.
3. **Per-tenant hourly rate limit** — `api.KeyedLimiter` keyed by
   `"tenant:{id}"`. `SGV_AI_WORKER.HOURLY_RATE_PER_TENANT` (default 20)
   with burst `SGV_AI_WORKER.HOURLY_BURST_PER_TENANT` (default 3), idle
   TTL 4h.
4. **Per-tenant opt-in flag** — `app_settings` key
   `ai_floorplan_enabled:tenant:{id}` = `"true"`. Missing row = false
   (privacy default: opt-in, not opt-out).
5. **Monthly cap** — `CountAIJobsThisMonth < SGV_AI_WORKER.MONTHLY_CAP_PER_TENANT`
   (default 200).
6. **Image ownership** — 404 if the image row isn't scoped to the
   caller's tenant.

Only then does the row get inserted and the goroutine spawned.

---

## Async detector lifecycle

`runDetectionJob` in `backend/internal/handlers/ai_floorplan.go`:

- **Detached context**: `context.Background()` + `Worker.PollMaxDuration + 15s`.
  The HTTP request context is canceled as soon as the client gets its
  `jobId` — we need our own budget for the DB writes even when the
  worker runs long.
- **Terminal-state guarantee**: a `defer` writes `FailAIJob` on panic
  so a row never sticks at `running` forever.
- **Every transition broadcasts SSE**. Frontend re-fetches the row on
  each event — the row is source of truth, the SSE is just a nudge.
- **Region passthrough**: `job.RegionBbox` (persisted as JSONB on the
  ai_jobs row) is unmarshaled into `aiworker.Region` and forwarded on
  the enqueue request. All crop math happens Python-side.
- **Worker task correlation**: after `Enqueue` returns, the task id is
  written to `ai_jobs.worker_task_id` via `SetAIJobWorkerTaskID` so
  support can grep a lost worker log back to a Go job row.
- **Poll**: `Worker.Poll` loops `GET /detect/{taskId}` every
  `PollInterval` (default 3s) until `status ∈ {done, failed}` or
  `PollMaxDuration` (default 300s). `ErrTaskFailed` is a sentinel the
  handler distinguishes from network/decode errors when writing the
  failure message to `ai_jobs.error`.

The Python `pipeline_version` string is embedded in every result
payload but not promoted to its own column — logged from Go on success
so it shows up in the operator's slog for triage. `ai_jobs.model` is
stamped `"python-cv"` at creation time.

---

## Configuration

Everything lives under `SGV_AI_WORKER.*`:

| Key | Default | What it does |
|---|---|---|
| `URL` | `http://ai-worker:8100` | Points the Go API at the Python worker. Empty = feature disabled (503 on `/detect`). |
| `REQUEST_TIMEOUT` | `30s` | Per-HTTP-call ceiling for both enqueue POST and each poll GET. |
| `POLL_INTERVAL` | `3s` | Pace of `GET /detect/{taskId}` polls. |
| `POLL_MAX_DURATION` | `300s` | Absolute wall-clock ceiling for a single job's polling; matches the Python Dramatiq `time_limit`. |
| `MONTHLY_CAP_PER_TENANT` | `200` | Job-count cap per calendar month per tenant. |
| `HOURLY_RATE_PER_TENANT` | `20` | Jobs/hour per tenant (KeyedLimiter). |
| `HOURLY_BURST_PER_TENANT` | `3` | Back-to-back allowance before rate kicks in. |

Also required: `SGV_REDIS.URL` (Dramatiq broker, worker-side only) and
`SGV_STORAGE.MINIO_*` (both services need the same bucket credentials
so the worker can `GET /files/<key>` directly).

Per-tenant opt-in is orthogonal: `app_settings` key
`ai_floorplan_enabled:tenant:{id}` = `"true"`.

---

## Testing checkpoints

- **Python pipeline** — `cd backend/ai-worker && uv run pytest` covers
  vectorize (4 cases, synthetic bitmaps), reproject round-trip (7
  cases), fusion (6), OCR (2), the run.py → SPA kind-mapping contract
  (3), and the healthz endpoint. Runs offline; no SAM checkpoint or
  Tesseract binary needed for the covered slice.
- **Go handler + client** — `go test ./internal/aiworker/... ./internal/handlers/...`
  covers the Enqueue → Poll → decode flow against an `httptest.Server`
  (4 client tests) and the full handler surface with a real DB (see
  `handlers/ai_floorplan_test.go` if present).
- **End-to-end** — `docker compose up` brings up postgres + minio +
  redis + ai-worker + api. Opt a tenant in via `app_settings`, upload
  a placed floor plan, click the AI Map tool. Proves SSE + DB +
  MinIO fetch + pipeline + coord transform + review dialog.

**No mock mode.** The old `SGV_AI.API_KEY=mock` short-circuit is gone
— an offline dev path would need a stub HTTP server matching the
worker's `/detect` contract. `SGV_AI_WORKER.URL=` (empty) is the
kill-switch equivalent and 503s the endpoint cleanly.

---

## Common pitfalls

- **Crop is percentages, not fractions.** `placement.crop.left = 10`
  means 10% of width, NOT 0.10. Both the Python `_placement_to_frame`
  and the SPA `imageUVToLngLat` divide by 100. Getting this wrong
  silently misaligns every detection.
- **`entity="ai-jobs"` must NOT be in `useSSE.ts`'s `VALID_KINDS`.** It
  falls through to `subscribeExternalSSE` where `useAIMapTool` listens.
- **AI overlay lives OUTSIDE the layer-order fragment.** Mounted next
  to `SecondaryLayers`, not inside `OverlayStack`. A warehouse re-order
  remounts the layer fragment; mid-review that would tear down the
  preview.
- **Accept action bypasses `createLocal`.** It calls `apiDb.<kind>.add`
  directly (matching the magic-wall batch pattern). `createLocal` is
  per-shape and serial via the store's flush queue; bulk-accept-20
  would be 20 serial POSTs.
- **`ai_jobs` FKs are `ON DELETE CASCADE`.** Deleting a tenant or image
  nukes all its jobs.
- **Cancel doesn't kill the worker task.** The endpoint flips the DB
  row's `status='canceled'`, but the Dramatiq actor runs to completion
  and the Go goroutine keeps polling until `PollMaxDuration`. Wasted
  CPU still spent.
- **Adding a new Python `Kind` without a `_KIND_TO_SPA` entry is a
  silent SPA regression.** The frontend accept switch is exhaustive
  and returns `undefined` for unknown kinds. `test_run_emit.py` fails
  loud if you forget; run pytest before shipping.
- **The worker MUST be able to reach MinIO with the same bucket the
  API writes to.** In `docker-compose.yml`, both services get
  `SGV_STORAGE.MINIO_*=...`. In `make dev` (Go on host, worker in
  compose), the worker's endpoint is the compose-network hostname; the
  Go side uses the host-mapped port.
- **`SGV_AI_WORKER.POLL_MAX_DURATION` must match or exceed the Python
  Dramatiq `time_limit`.** Otherwise the Go side gives up before the
  worker does, leaving orphaned tasks that eventually complete into
  the void.

---

## Geometric detector (prototype, 2026-10)

`backend/ai-worker/src/aiworker/geometric/` — a second detector that
measures **strokes** instead of segmenting regions. SAM 2 finds blobs;
a line drawing keeps its meaning in line thickness, straight runs, arcs
and enclosed bay boxes, which SAM merges or splits. Not wired into the
Dramatiq actor yet; run it from the CLI.

Stages (dependency order, every threshold in metres via `PlanScale`):

| Stage | File | Rule |
|---|---|---|
| Ink + building mask | `raster.py` | Building = largest closed region of **thick** strokes (hairline grid / dimension lines can't extend it) |
| Fixtures | `fixtures.py` | Shelf units = groups of ≥ 2 enclosed rectangular cells (0.5–1.6 m), halves of back-to-back gondolas merged; rails = ≥ 5 short parallel strokes at ≤ 0.6 m pitch |
| Walls | `walls.py` | Axis-aligned strokes ≥ 0.15 m thick outside fixtures and OCR text boxes; double lines merged; collinear pieces joined; ends snapped to L / T joints |
| Doors | `doors.py` | Curves left after removing straight strokes → circle fit (RANSAC peels merged arcs); radius 0.6–2.4 m, sweep 55–120°, hinge on a wall that continues **behind** it; width = radius; mirrored pairs → double door; leaf strokes removed from walls |
| Rooms | `rooms.py` | Raster: walls + door openings + doorway closures (collinear gaps, dangling ends extended ≤ 2.6 m) → enclosed free space; named by Tesseract `--psm 11` phrases |
| Review | `review.py` | 30 m crops with numbered candidates → a vision model answers JSON picks / names only (never coordinates). Without `ANTHROPIC_API_KEY` the package is for human review |
| Score | `evaluate.py` | Against a ground-truth layout: walls by length (tolerance 0.25 m + half the wall thickness), doors by midpoint ≤ 0.8 m, racks / rooms by IoU ≥ 0.5; `rooms_enclosed` counts only GT rooms bounded by walls |

```
cd backend/ai-worker
PYTHONPATH=src .venv/bin/python -m aiworker.geometric plan.jpg \
    --placement '{"startLng":…,"startLat":…,"currentLng":…,"currentLat":…}' \
    --gt gt.json --overlay overlay.png --out det.json --review review_dir/
```

Ground truth comes from a hand-built facility: export its `lines` /
`doors` / `grids` / `polygons` for one `floor_plan_id` and project lng/lat
into image pixels with the image's corners. Tenant plans and their ground
truth are customer data — keep them out of the repo.

Baseline on the 2026-10 retail store (2 floors, scored against the
hand-built layout):

| | Walls F1 | Doors F1 | Racks F1 | Enclosed rooms F1 |
|---|---|---|---|---|
| Ground floor, detectors only | 0.75 | 0.63 | 0.67 | 0.43 |
| First floor, detectors only | 0.74 | 0.74 | 0.73 | 0.43 |
| First floor + review (one pass) | 0.78 | 0.74 | 0.86 | 0.43 (24 of 29 named) |

Review lessons:
- **Labels must sit fully inside the crop.** A clipped "W177" reads as "W17", and the wrong wall gets rejected.
- **Long walls (≥ 6 m) need two rejections** (`apply_answers(long_wall_votes=2)`). A single reviewer mistaking a thick exterior wall for a duplicate line cost 5 % wall recall.
- **Open-floor departments separated only by printed labels** can't come from geometry. They need the review step to split a face by its labels.

## Deferred to v2

- **Racks** — need a rack-specific classifier or template match;
  deferred until we have accuracy telemetry from v1's four kinds.
- **Text labels as first-class detections** — OCR already runs for
  fusion; a separate review flow that lets users accept a label as
  a text-label shape is a small add.
- **Auto-tile for very large plans** — huge blueprints (>2048px on
  either edge) produce too many small SAM masks for the classifier
  thresholds to work well; splitting into overlapping tiles + merging
  would help.
- **Per-job cancel that kills the worker task** — current cancel is
  best-effort (DB row flip only; worker + Go poller run to completion).
- **Webhook instead of poll** — trades one poll loop for a small SSE
  push endpoint on the Go side. Nice-to-have, not blocking.
- **Fine-tune the classifier heuristics from telemetry** — accumulated
  `ai_jobs.accepted_ids` vs `rejected_ids` per kind is the training
  signal for a v2 model or tuned thresholds.
