"""Raster masks -> clean polygon geometry.

Pipeline per mask:
  1. Morphological CLOSE with a small kernel to heal 1-2 pixel gaps
     where SAM's segmentation didn't quite meet at wall corners.
     `cv2.MORPH_CLOSE` = dilate-then-erode: fills holes without
     inflating overall shape.
  2. `cv2.findContours(RETR_EXTERNAL, CHAIN_APPROX_SIMPLE)` — outer
     contours only (we're not tracking holes for MVP), collapsed to
     corner vertices along straight edges.
  3. Shapely `.simplify(tolerance, preserve_topology=True)` on the
     resulting rings. Tolerance is in PIXELS at the SAM output
     resolution; 2 px is our default which produces crisp rectangles
     from what SAM emits as slightly-jagged edges.

Tests: test_vectorize.py builds a synthetic bitmap of two rectangles
and asserts we recover the right count + approximate corner locations.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient


@dataclass(frozen=True)
class VectorizedShape:
    """One polygon in pixel space, with area for downstream area_sqm
    computation. Kept minimal — classification lives elsewhere so this
    stays purely geometric."""

    polygon: Polygon
    area_pixels: float


# Small kernel — big enough to bridge 1-2 pixel gaps at wall corners,
# small enough to not eat thin architectural details. Odd size is
# required by cv2.getStructuringElement for MORPH_ELLIPSE.
_CLOSE_KERNEL = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

# Min area (in pixels²) to keep. SAM emits ~5-10% "junk" masks at
# 1-100 px² — pure noise. 200 px² is a floor-plan doorway at the
# resolutions we run at (2048-4096 wide), so anything smaller is
# almost never a real feature.
_MIN_AREA_PIXELS = 200.0

# Simplification tolerance in pixels. 2 px is a hand-tuned compromise:
# tight enough that a 90° wall corner survives, loose enough that a
# 500-vertex jagged contour collapses to ~20 corners.
_SIMPLIFY_TOLERANCE_PIXELS = 2.0


def masks_to_polygons(masks: list[np.ndarray]) -> list[VectorizedShape]:
    """Convert a list of binary masks (bool or uint8, H×W) into cleaned
    Shapely polygons in pixel coordinates.

    Returns polygons sorted by area DESCENDING so downstream classifier
    heuristics can rely on the "biggest first" order (whole-building
    silhouettes tend to bubble to the top and get filtered out as
    background)."""

    shapes: list[VectorizedShape] = []
    for mask in masks:
        for shape in _mask_to_polygons_one(mask):
            shapes.append(shape)
    shapes.sort(key=lambda s: s.area_pixels, reverse=True)
    return shapes


def long_axis_line(polygon: Polygon) -> tuple[tuple[float, float], tuple[float, float]]:
    """Return the two vertices of the polygon farthest apart — the
    "long axis" of the shape. Used to emit doors/stairs/walls as a
    2-point LineString for the frontend, matching the
    `ai-accept.ts::extractPointPair` contract that already exists on
    the SPA side.

    O(N²) over the exterior ring — fine because the vectorize step
    already ran Shapely `.simplify()` which typically collapses SAM
    contours from hundreds of points down to <20.
    """

    coords = list(polygon.exterior.coords)
    # Drop the closing repeat point if present so we don't consider
    # coords[0] as both endpoints.
    if len(coords) > 1 and coords[0] == coords[-1]:
        coords = coords[:-1]
    if len(coords) < 2:
        # Degenerate: fall back to bbox diagonal so we always emit
        # something usable rather than crashing.
        min_x, min_y, max_x, max_y = polygon.bounds
        return (min_x, min_y), (max_x, max_y)
    best: tuple[tuple[float, float], tuple[float, float]] = (coords[0], coords[1])
    best_d = -1.0
    for i in range(len(coords)):
        xi, yi = coords[i]
        for j in range(i + 1, len(coords)):
            xj, yj = coords[j]
            d = math.hypot(xj - xi, yj - yi)
            if d > best_d:
                best_d = d
                best = ((xi, yi), (xj, yj))
    return best


def _mask_to_polygons_one(mask: np.ndarray) -> list[VectorizedShape]:
    """One raw SAM mask → cleaned polygons. A single SAM mask CAN
    contain multiple disconnected regions (e.g. two identical rooms
    on opposite sides of the plan) — findContours splits them."""

    if mask.ndim != 2:
        return []
    # Normalize to uint8 0/255 for OpenCV.
    if mask.dtype != np.uint8:
        m = (mask.astype(bool).astype(np.uint8)) * 255
    else:
        m = np.where(mask > 0, 255, 0).astype(np.uint8)

    closed = cv2.morphologyEx(m, cv2.MORPH_CLOSE, _CLOSE_KERNEL)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    out: list[VectorizedShape] = []
    for cnt in contours:
        if len(cnt) < 3:
            continue
        # cv2 returns (N, 1, 2); flatten to (N, 2).
        pts = cnt.reshape(-1, 2).astype(float)
        raw = Polygon(pts)
        if not raw.is_valid or raw.is_empty:
            continue
        if raw.area < _MIN_AREA_PIXELS:
            continue
        simplified = raw.simplify(_SIMPLIFY_TOLERANCE_PIXELS, preserve_topology=True)
        if simplified.is_empty or simplified.geom_type != "Polygon":
            continue
        # Consistent winding — GeoJSON right-hand-rule expects outer
        # rings CCW. `orient` with `sign=1.0` returns CCW.
        oriented = orient(simplified, sign=1.0)
        out.append(VectorizedShape(polygon=oriented, area_pixels=oriented.area))
    return out
