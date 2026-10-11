# syntax=docker/dockerfile:1.7
# Multi-stage build. Phase 2 adds CPU-only PyTorch + SAM 2 checkpoint.
# The CPU wheel pin in pyproject.toml [tool.uv.sources] keeps the
# torch install ~200 MB instead of the ~8 GB the default CUDA wheels
# would drag in. Combined with a slim runtime base + non-root user,
# the final image lands around 2.5 GB (mostly torch + SAM checkpoint).

# ---- Builder ----------------------------------------------------------
FROM python:3.12-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:0.4.30 /uv /usr/local/bin/uv

# System libs. curl for the checkpoint download step below; ca-certs
# for HTTPS. Everything else Python ships via wheels.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency resolution first so a code-only change doesn't reinstall
# torch. `--no-dev` strips pytest/ruff from the runtime venv. README.md
# is copied because pyproject.toml declares it as the readme — hatchling
# validates its presence during `uv sync`.
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# SAM 2 checkpoint — base_plus variant (~155 MB). Baked into the image
# so the container starts serving instantly on boot with no
# first-request download stall. If we ever need `large` (~900 MB) for
# accuracy, this URL + the SGV_AI_WORKER.SAM_CHECKPOINT override in
# segment.py are the swap points.
RUN mkdir -p /app/models && \
    curl -fsSL -o /app/models/sam2.1_hiera_base_plus.pt \
    https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt

# Source last (cheapest layer to invalidate).
COPY src ./src

# ---- Runtime ----------------------------------------------------------
FROM python:3.12-slim

# Runtime system libs:
#   - ca-certificates + curl: HTTPS + healthcheck
#   - libgl1 + libglib2: opencv-python-headless needs the low-level
#     libGL runtime for cv2.findContours() + morphology, even though
#     the "headless" variant excludes GUI framebuffer symbols
#   - tesseract-ocr + tesseract-ocr-eng: Phase 3 OCR. English
#     traineddata is ~5 MB; the runtime engine itself is ~10 MB.
#     pytesseract shells out to the `tesseract` binary — no way
#     around the apt install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    libgl1 libglib2.0-0 \
    tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/src /app/src
COPY --from=builder /app/models /app/models
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app/src" \
    PYTHONUNBUFFERED=1

# Non-root user, same convention as backend/Dockerfile.
RUN groupadd -r sgv && useradd -r -g sgv sgv \
    && chown -R sgv:sgv /app
USER sgv

EXPOSE 8100

CMD ["uvicorn", "aiworker.main:app", "--host", "0.0.0.0", "--port", "8100"]
