"""SAM 2 automatic mask generation.

Model is loaded ONCE per process (loading takes ~2-5 s + ~500 MB
resident). The FastAPI lifespan and Dramatiq worker share the same
Python process for Phase 1-2, so a single lazy-loaded singleton
serves both roles.

Parameters are tuned for architectural CAD-style floor plans (crisp
black-on-white line art, ~2000-3000 px wide). Photorealistic renders
(the two Gemini test PNGs) work with these too but with reduced recall
on subtle rooms — fine for MVP, revisit if quality demands.

Heavy imports (torch, sam2) are lazy so the module can be imported by
tests that don't need actual inference (reproject/vectorize tests
still import from `pipeline`, and pytest would blow up on missing
torch during collection otherwise).
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

import numpy as np

log = logging.getLogger(__name__)

# Env var. Baked into the Docker image at /app/models by default; a
# named-volume mount can override this in production if we ever need
# to swap checkpoints without an image rebuild.
_CHECKPOINT_ENV = "SGV_AI_WORKER.SAM_CHECKPOINT"
_DEFAULT_CHECKPOINT = "/app/models/sam2.1_hiera_base_plus.pt"
# Config filename that ships with the `sam2` pip package. base_plus =
# ~155 MB, comfortably faster on CPU than the `large` variant.
_MODEL_CFG = "configs/sam2.1/sam2.1_hiera_b+.yaml"

# Automatic-mask-generation tuning for floor plans. Rationale in
# module docstring; keep in sync with docs/ai-floorplan.md.
#
# SAM 2 on CPU costs O(points_per_side^2 * (1 + 4^crop_n_layers))
# points to score. We downscale inputs to 1600 px longest edge (see
# run._downscale_for_sam) so the *effective* pixel-resolution SAM
# needs to hit small features (doors ~8-15 px, room labels ~10-20 px)
# is already generous — dropping crop_n_layers from 1 to 0 saves the
# expensive 4x sub-crop pass with negligible small-feature loss at
# this resolution. points_per_side 32→24 is a further ~44% cut with
# minimal recall change on rectilinear line-art.
_MASK_GEN_KWARGS: dict[str, Any] = {
    "points_per_side": 24,
    "pred_iou_thresh": 0.86,
    "stability_score_thresh": 0.92,      # SAM 2 default; 0.95 was over-strict
    "crop_n_layers": 1,                  # keep the 2x sub-crop pass for doors
    "min_mask_region_area": 200,         # matches vectorize._MIN_AREA_PIXELS
}


_model_lock = threading.Lock()
_mask_generator = None  # populated by _get_mask_generator on first use


def _get_mask_generator():
    """Lazy singleton. Heavy imports inside so pytest module collection
    stays cheap and reproject/vectorize unit tests don't require torch."""

    global _mask_generator
    if _mask_generator is not None:
        return _mask_generator
    with _model_lock:
        if _mask_generator is not None:
            return _mask_generator
        # Late imports: torch and sam2 together are >1 GB of memory
        # at load time and 2-5 s wall clock.
        import torch  # noqa: F401 — needed by sam2 at import time
        from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
        from sam2.build_sam import build_sam2

        checkpoint = os.environ.get(_CHECKPOINT_ENV, _DEFAULT_CHECKPOINT)
        log.info("segment: loading SAM 2 checkpoint from %s", checkpoint)
        sam = build_sam2(_MODEL_CFG, checkpoint, device="cpu")
        _mask_generator = SAM2AutomaticMaskGenerator(sam, **_MASK_GEN_KWARGS)
        log.info("segment: SAM 2 ready")
        return _mask_generator


def generate_masks(image: np.ndarray) -> list[np.ndarray]:
    """Run SAM 2 automatic mask generation on an RGB image (H, W, 3),
    uint8 0-255. Returns a list of bool masks (H, W) — one per
    detected segment.

    SAM's raw output includes per-mask metadata (score, bbox, area);
    we drop everything but the boolean mask itself because downstream
    vectorize/classify recompute what they need from the mask
    directly. Keeps the type surface small.

    Serialized under `_model_lock`. SAM 2's internal predictor holds
    a `.set_image(...)` state that must be set before `.predict()`;
    two concurrent Dramatiq actors calling `.generate()` on the
    shared singleton race on that state and one raises
    `RuntimeError: An image must be set with .set_image(...) before
    mask prediction.` A queue is strictly better than a corrupted
    result — SAM is fully CPU-bound so parallelism wouldn't win here
    even without the race."""

    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError(f"generate_masks expects HxWx3 RGB uint8, got shape {image.shape}")
    generator = _get_mask_generator()
    with _model_lock:
        raw = generator.generate(image)
    return [entry["segmentation"] for entry in raw]
