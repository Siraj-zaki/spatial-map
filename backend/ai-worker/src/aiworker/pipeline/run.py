"""Orchestrator: bytes + placement → GeoJSON FeatureCollection.

Pipeline order (Phase 3):

    decode → optional crop → SAM → vectorize → classify → OCR + fusion
        → emit geometry-aware Feature per surviving Classified

Each stage is decoupled — swapping SAM for FloorSAM only touches
segment; changing the classifier heuristic only touches classify;
swapping Tesseract for PaddleOCR only touches ocr.
"""

from __future__ import annotations

import io
import logging
from typing import Any

import numpy as np
from PIL import Image

from aiworker.pipeline.classify import Classified, Kind, classify_masks
from aiworker.pipeline.fusion import attach_labels
from aiworker.pipeline.ocr import extract_labels
from aiworker.pipeline.reproject import ImageCrop, ImageFrame, pixel_to_lnglat
from aiworker.pipeline.segment import generate_masks
from aiworker.pipeline.vectorize import long_axis_line, masks_to_polygons

log = logging.getLogger(__name__)

_PIPELINE_VERSION = "pyworker-phase3.2-sam2-tuned"

# SAM inference on CPU is O(pixels). A 2K plan takes ~2-4 min; a
# 1600-px longest-edge downscale drops that to ~30-60 s with minimal
# recall loss (door / stair symbols are still 8-15 px after resize,
# well above SAM's minimum feature size). Coord reprojection uses the
# ORIGINAL frame — the downscale is purely a SAM-input concern.
_SAM_MAX_EDGE = 1600

# Kinds we actually emit as features. BACKGROUND + UNKNOWN are dropped;
# every kind here has a defined geometry mapping below.
_EMIT_KINDS = {Kind.WALL, Kind.ROOM, Kind.DOOR, Kind.STAIR}

# LineString kinds — walls/doors/stairs collapse to their long axis
# for a 2-point LineString the frontend accepts directly. ROOM stays
# as a full polygon.
_LINE_KINDS = {Kind.WALL, Kind.DOOR, Kind.STAIR}

# Domain-vocabulary remap at the emit boundary. The classifier speaks
# generic CV language (wall / room) because that's what SAM masks
# actually look like; the SPA speaks warehouse-product language
# (aisle / area) because that's what users draw and see in the editor.
# Applied once here so both sides can keep their idioms without an
# adapter layer in the Go handler.
#
# Contract: values MUST match src/lib/ai-client.ts::AIDetectionKind.
# A future kind added here without a matching SPA switch case in
# ai-accept.ts is a silent regression — see the mapping test that
# guards this.
_KIND_TO_SPA: dict[Kind, str] = {
    Kind.WALL: "aisle",
    Kind.ROOM: "area",
    Kind.DOOR: "door",
    Kind.STAIR: "stair",
}


def detect(
    image_bytes: bytes,
    placement: dict[str, Any],
    region: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Full pipeline. Returns a valid GeoJSON FeatureCollection in
    Mapbox lng/lat with per-feature `class`/`label`/`confidence`."""

    frame = _placement_to_frame(placement, region)
    full_image = _decode_image(image_bytes)
    if region is not None:
        full_image = _crop_image(full_image, region)
    # Downscaled copy is SAM-only. OCR + label fusion stay on the
    # original resolution — Tesseract's accuracy on small floor-plan
    # text (10-14 pt at typical scan resolution) collapses below
    # ~1600 px longest edge. Vectorize + classify run on the downscaled
    # frame; polygons are then rescaled back to full-image pixel space
    # before OCR fusion so point-in-polygon matches align with the
    # original text bboxes.
    sam_image = _downscale_for_sam(full_image)
    full_h, full_w = full_image.shape[:2]
    sam_h, sam_w = sam_image.shape[:2]
    scale_x = full_w / sam_w
    scale_y = full_h / sam_h
    log.info(
        "detect: full=%dx%d, sam=%dx%d (scale %.2fx), region=%s",
        full_w, full_h, sam_w, sam_h, scale_x, region,
    )

    masks = generate_masks(sam_image)
    log.info("detect: SAM emitted %d masks", len(masks))
    shapes = masks_to_polygons(masks)
    log.info("detect: vectorized to %d polygons", len(shapes))
    # Rescale polygons to full-image pixel space so classify + OCR
    # fusion both work in the same coordinate frame the caller passed.
    if scale_x != 1.0 or scale_y != 1.0:
        shapes = _rescale_shapes(shapes, scale_x, scale_y)
    classified = classify_masks(shapes, full_w, full_h)

    # OCR runs on the FULL-resolution image (post-crop when region-
    # select was used) — small floor-plan text dies at SAM's downscale.
    # Failure to OCR is non-fatal; attach_labels degrades to a no-op
    # on an empty list.
    ocr_bytes = _reencode_for_ocr(full_image)
    ocr_results = extract_labels(ocr_bytes)
    log.info("detect: OCR extracted %d words", len(ocr_results))
    classified = attach_labels(classified, ocr_results)

    kept = [c for c in classified if c.kind in _EMIT_KINDS]
    log.info(
        "detect: kept %d after classification (dropped %d)",
        len(kept), len(classified) - len(kept),
    )

    detections = [
        _feature_from_classified(c, frame, full_w, full_h, idx=i)
        for i, c in enumerate(kept)
    ]
    # Result shape locked in with the Go side for Phase 4 rewire:
    #   {"detections": [...], "pipeline_version": "..."}
    # `detections` gets stored verbatim in ai_jobs.detections (JSONB);
    # `pipeline_version` goes to the `model` column so telemetry can
    # distinguish detector versions across a corpus of jobs.
    return {
        "detections": detections,
        "pipeline_version": _PIPELINE_VERSION,
    }


def _placement_to_frame(
    placement: dict[str, Any],
    region: dict[str, float] | None,
) -> ImageFrame:
    """Build an ImageFrame from the enqueue payload. If a region is
    set, compose it INTO the frame's crop percentages so the reproject
    math maps the model's [0, 1] UV — which is against the CROPPED
    image WE fed it — back to full lng/lat correctly.

    Mirrors backend/internal/ai/crop.go::AdjustFrameForRegion.
    """

    crop_raw = placement.get("crop") or {}
    crop = ImageCrop(
        top=float(crop_raw.get("top", 0.0)),
        right=float(crop_raw.get("right", 0.0)),
        bottom=float(crop_raw.get("bottom", 0.0)),
        left=float(crop_raw.get("left", 0.0)),
    )
    frame = ImageFrame(
        start_lng=float(placement.get("startLng", 0.0)),
        start_lat=float(placement.get("startLat", 0.0)),
        current_lng=float(placement.get("currentLng", 0.0)),
        current_lat=float(placement.get("currentLat", 0.0)),
        rotation=float(placement.get("rotation", 0.0)),
        crop=crop,
    )
    if region is None:
        return frame
    vis_w = 1.0 - (frame.crop.left + frame.crop.right) / 100.0
    vis_h = 1.0 - (frame.crop.top + frame.crop.bottom) / 100.0
    new_left = frame.crop.left + region["x0"] * vis_w * 100.0
    new_right = frame.crop.right + (1.0 - region["x1"]) * vis_w * 100.0
    new_top = frame.crop.top + region["y0"] * vis_h * 100.0
    new_bottom = frame.crop.bottom + (1.0 - region["y1"]) * vis_h * 100.0
    return ImageFrame(
        start_lng=frame.start_lng,
        start_lat=frame.start_lat,
        current_lng=frame.current_lng,
        current_lat=frame.current_lat,
        rotation=frame.rotation,
        crop=ImageCrop(top=new_top, right=new_right, bottom=new_bottom, left=new_left),
    )


def _decode_image(image_bytes: bytes) -> np.ndarray:
    """PNG/JPEG bytes → HxWx3 uint8 RGB array. Pillow handles the
    format sniffing; SAM only accepts RGB, no alpha."""

    im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    return np.array(im, dtype=np.uint8)


def _rescale_shapes(shapes, scale_x: float, scale_y: float):
    """Multiply every polygon vertex by (scale_x, scale_y) and adjust
    area_pixels accordingly. Used to lift SAM-downscaled polygons back
    to full-image pixel space so classify (which uses area fractions)
    and OCR fusion (which uses point-in-polygon against full-res text
    bboxes) both compute on the same frame. Local import of the
    Shapely helpers keeps run.py's top-level import list minimal."""

    from shapely.affinity import scale as _scale

    from aiworker.pipeline.vectorize import VectorizedShape

    out = []
    area_factor = scale_x * scale_y
    for s in shapes:
        new_poly = _scale(s.polygon, xfact=scale_x, yfact=scale_y, origin=(0, 0))
        out.append(VectorizedShape(polygon=new_poly, area_pixels=s.area_pixels * area_factor))
    return out


def _downscale_for_sam(image: np.ndarray) -> np.ndarray:
    """Shrink long edge to _SAM_MAX_EDGE if the image is bigger.
    Preserves aspect ratio; no-op when the image is already small
    enough. Reprojection uses the ORIGINAL image frame, so the
    downscale never leaks into lng/lat math — only SAM's inference
    cost. LANCZOS gives the best fidelity for line art (crisp walls)."""

    h, w = image.shape[:2]
    long_edge = max(h, w)
    if long_edge <= _SAM_MAX_EDGE:
        return image
    scale = _SAM_MAX_EDGE / long_edge
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    im = Image.fromarray(image, mode="RGB").resize((new_w, new_h), Image.Resampling.LANCZOS)
    return np.array(im, dtype=np.uint8)


def _crop_image(image: np.ndarray, region: dict[str, float]) -> np.ndarray:
    """Crop the source array to the region UV (0..1). Bounds clamped
    to image size — belt-and-suspenders against an off-by-one on the
    frontend clamp yielding a zero-sized crop."""

    h, w = image.shape[:2]
    x0 = max(0, min(w, int(region.get("x0", 0.0) * w)))
    y0 = max(0, min(h, int(region.get("y0", 0.0) * h)))
    x1 = max(x0 + 1, min(w, int(region.get("x1", 1.0) * w)))
    y1 = max(y0 + 1, min(h, int(region.get("y1", 1.0) * h)))
    return image[y0:y1, x0:x1]


def _reencode_for_ocr(image: np.ndarray) -> bytes:
    """Re-encode the (possibly cropped) numpy RGB array back to PNG
    bytes so `ocr.extract_labels` (which loads via PIL from bytes)
    reads the same pixels SAM saw. PNG chosen over JPEG so we don't
    lose fidelity on tiny text edges."""

    buf = io.BytesIO()
    Image.fromarray(image, mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _feature_from_classified(
    c: Classified,
    frame: ImageFrame,
    image_width: int,
    image_height: int,
    idx: int,
) -> dict[str, Any]:
    """Emit ONE detection in the SPA's canonical `AIDetection` shape
    (src/lib/ai-client.ts) so the frontend consumes it directly —
    no Go-side adapter layer to maintain.

    Deliberately NOT a GeoJSON Feature: the SPA already does its own
    GeoJSON build in ai-detection-generator.ts. Emitting the SPA's
    shape is cheaper than translating on the Go side.

    Geometry per kind:
      WALL / DOOR / STAIR    type='line',    coords=2 pts (long axis)
      ROOM                   type='polygon', coords=flat closed ring
    """

    if c.kind in _LINE_KINDS:
        (x0, y0), (x1, y1) = long_axis_line(c.shape.polygon)
        coords = [
            list(pixel_to_lnglat(frame, x0, y0, image_width, image_height)),
            list(pixel_to_lnglat(frame, x1, y1, image_width, image_height)),
        ]
        geometry: dict[str, Any] = {"type": "line", "coords": coords}
    else:  # ROOM → flat polygon ring (SPA closes at render time)
        ring_pixels = list(c.shape.polygon.exterior.coords)
        ring_lnglat = [
            list(pixel_to_lnglat(frame, x, y, image_width, image_height))
            for (x, y) in ring_pixels
        ]
        if ring_lnglat[0] != ring_lnglat[-1]:
            ring_lnglat.append(ring_lnglat[0])
        geometry = {"type": "polygon", "coords": ring_lnglat}

    return {
        "id": f"det-{idx + 1}",
        "kind": _KIND_TO_SPA[c.kind],
        "geometry": geometry,
        "label": c.label,
        "confidence": round(c.confidence, 3),
    }


def detect_from_path(path: str) -> dict[str, Any]:
    """CLI helper for `python -m aiworker.pipeline <path>`. Uses a
    unit-square placement so coords are effectively image UV in
    [0, 1] — sufficient for local debug output where the actual
    world-space transform doesn't matter."""

    with open(path, "rb") as fh:
        raw = fh.read()
    return detect(
        image_bytes=raw,
        placement={
            "startLng": 0.0, "startLat": 0.0,
            "currentLng": 1.0, "currentLat": 1.0,
            "rotation": 0.0,
        },
    )
