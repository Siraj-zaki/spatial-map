"""Text → room fusion via point-in-polygon.

Tesseract emits per-word bboxes; a room name like "OPERATING ROOM 1
F115" comes back as several `OCRResult`s. For each ROOM-classified
polygon, we:
  1. Find every OCR result whose center point falls inside it.
  2. Sort them left-to-right, top-to-bottom (reading order).
  3. Join into a single label string, drop it into `Classified.label`.

Only ROOM shapes get labels — walls / doors / stairs never carry
readable text on a plan. Other kinds pass through unchanged.
"""

from __future__ import annotations

import logging

from shapely.geometry import Point

from aiworker.pipeline.classify import Classified, Kind, with_label
from aiworker.pipeline.ocr import OCRResult

log = logging.getLogger(__name__)


def attach_labels(
    classified: list[Classified],
    ocr_results: list[OCRResult],
) -> list[Classified]:
    """Return a new list where every ROOM shape that contains one or
    more OCR results has its `label` populated. Non-ROOM shapes are
    passed through unchanged."""

    if not ocr_results:
        return classified
    out: list[Classified] = []
    for c in classified:
        if c.kind != Kind.ROOM:
            out.append(c)
            continue
        inside = [r for r in ocr_results if _contains(c, r)]
        if not inside:
            out.append(c)
            continue
        out.append(with_label(c, _join_reading_order(inside)))
    return out


def _contains(c: Classified, r: OCRResult) -> bool:
    """Cheap point-in-polygon check on the OCR bbox center. Ignoring
    partial-bbox overlaps is intentional — a label whose center
    lands outside the room is almost always outside the room (a
    corridor sign, a legend entry). The rare "long label straddling
    two rooms" case is a Phase 3.5 problem worth measuring first."""

    try:
        return c.shape.polygon.contains(Point(r.center_x, r.center_y))
    except Exception:  # noqa: BLE001 — shapely raises on invalid geoms
        return False


def _join_reading_order(results: list[OCRResult]) -> str:
    """Reading-order join. Group results by rough vertical band
    (labels that share a horizontal line) then sort within each band
    left-to-right, and concatenate bands top-to-bottom.

    Rough band grouping: if the vertical center-to-center distance
    to the previous entry is < half the average text height, treat
    it as the same line. Cheap heuristic; good enough for the 1-3
    line labels typical of architectural rooms.
    """

    if not results:
        return ""
    # Sort by y then x so subsequent grouping walks reading order.
    sorted_r = sorted(results, key=lambda r: (r.center_y, r.center_x))
    heights = [(r.bbox[3] - r.bbox[1]) for r in sorted_r]
    avg_h = sum(heights) / len(heights) if heights else 10.0
    band_threshold = max(4.0, avg_h * 0.5)

    lines: list[list[OCRResult]] = [[sorted_r[0]]]
    for r in sorted_r[1:]:
        prev = lines[-1][-1]
        if abs(r.center_y - prev.center_y) <= band_threshold:
            lines[-1].append(r)
        else:
            lines.append([r])
    # Sort each line left-to-right, then flatten with newlines
    # collapsed to spaces (frontend renders a single label string).
    return " ".join(
        " ".join(word.text for word in sorted(line, key=lambda r: r.center_x))
        for line in lines
    ).strip()
