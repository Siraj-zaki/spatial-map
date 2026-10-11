"""Raster helpers: ink mask, building envelope, axis-aligned stroke runs."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


def ink_mask(gray: np.ndarray, threshold: int = 140) -> np.ndarray:
    """1 where the drawing has ink. Scans with a grey paper tone get an
    Otsu threshold, capped so light hatching never counts as a stroke."""

    otsu, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    t = min(threshold, int(otsu)) if otsu > 60 else threshold
    return (gray < t).astype(np.uint8)


def building_mask(ink: np.ndarray, close_px: int, wall_thick: int = 3) -> np.ndarray:
    """Filled outline of the building. Built from THICK strokes only, so
    hairline grid lines, dimension chains and title-block rules — which
    often frame the whole sheet — can't extend it. The largest filled
    region of the closed thick-stroke drawing is the building."""

    thick = cv2.erode(ink, np.ones((wall_thick, wall_thick), np.uint8))
    thick = cv2.dilate(thick, np.ones((wall_thick, wall_thick), np.uint8))
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (close_px, close_px))
    closed = cv2.morphologyEx(thick, cv2.MORPH_CLOSE, k)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    mask = np.zeros_like(ink)
    if contours:
        big = max(contours, key=cv2.contourArea)
        cv2.drawContours(mask, [big], -1, 1, thickness=-1)
    return mask


@dataclass
class Run:
    """An axis-aligned stroke: `o` 'h' or 'v', centre line `c`, extent
    [a, b] along the axis, thickness `t` (all pixels)."""

    o: str
    c: float
    a: float
    b: float
    t: float

    @property
    def length(self) -> float:
        return self.b - self.a

    def endpoints(self) -> tuple[tuple[float, float], tuple[float, float]]:
        if self.o == "h":
            return (self.a, self.c), (self.b, self.c)
        return (self.c, self.a), (self.c, self.b)


def stroke_runs(ink: np.ndarray, min_len: int, min_thick: int) -> list[Run]:
    """Straight horizontal / vertical strokes at least `min_thick` px thick
    and `min_len` px long. Erosion across the stroke drops hairlines
    (dimension lines, hatching, text); opening along it drops anything
    short (letters, furniture symbols)."""

    out: list[Run] = []
    for o in ("h", "v"):
        across = (min_thick, 1) if o == "h" else (1, min_thick)
        along = (1, min_len) if o == "h" else (min_len, 1)
        m = cv2.erode(ink, np.ones(across, np.uint8))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones(along, np.uint8))
        m = cv2.dilate(m, np.ones(across, np.uint8))
        n, _, st, _ = cv2.connectedComponentsWithStats(m, 8)
        for i in range(1, n):
            x, y, w, h, _a = st[i]
            if o == "h":
                out.append(Run("h", y + h / 2, float(x), float(x + w), float(h)))
            else:
                out.append(Run("v", x + w / 2, float(y), float(y + h), float(w)))
    return out
