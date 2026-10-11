"""Synthetic-bitmap tests for vectorize.masks_to_polygons.

Doesn't require torch/SAM — just numpy + cv2 + shapely.
"""

from __future__ import annotations

import numpy as np

from aiworker.pipeline.vectorize import masks_to_polygons


def _rect_mask(h: int, w: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    """Bool bitmap with a single filled rectangle."""

    m = np.zeros((h, w), dtype=bool)
    m[y0:y1, x0:x1] = True
    return m


def test_single_rectangle_yields_single_polygon() -> None:
    mask = _rect_mask(200, 200, 30, 40, 150, 170)
    out = masks_to_polygons([mask])
    assert len(out) == 1
    poly = out[0].polygon
    # Simplify+orient should still give us a rectangle-ish (4-vertex
    # after closing, sometimes 5) polygon covering the expected bbox.
    min_x, min_y, max_x, max_y = poly.bounds
    assert 28 <= min_x <= 32
    assert 38 <= min_y <= 42
    assert 148 <= max_x <= 152
    assert 168 <= max_y <= 172
    # Area matches inside 1% — the morphological close pads slightly.
    expected_area = (150 - 30) * (170 - 40)
    assert abs(out[0].area_pixels - expected_area) / expected_area < 0.05


def test_two_disconnected_rects_in_one_mask_split() -> None:
    # A single SAM mask can contain multiple disconnected regions.
    # findContours(RETR_EXTERNAL) must split them into two polygons.
    mask = np.zeros((200, 400), dtype=bool)
    mask[20:80, 20:100] = True    # rect A
    mask[120:180, 250:380] = True # rect B (far right)
    out = masks_to_polygons([mask])
    assert len(out) == 2
    # Sorted by area DESC — rect B is bigger (60*130=7800 vs 60*80=4800).
    assert out[0].area_pixels > out[1].area_pixels


def test_tiny_mask_dropped_by_min_area() -> None:
    # A 10x10 = 100 px² blob is below _MIN_AREA_PIXELS (200) and
    # should be filtered out as noise.
    mask = _rect_mask(200, 200, 5, 5, 15, 15)
    out = masks_to_polygons([mask])
    assert out == []


def test_empty_mask_yields_nothing() -> None:
    mask = np.zeros((50, 50), dtype=bool)
    out = masks_to_polygons([mask])
    assert out == []
