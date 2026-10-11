"""Synthetic tests for fusion.attach_labels — no OCR / SAM needed."""

from __future__ import annotations

from shapely.geometry import Polygon

from aiworker.pipeline.classify import Classified, Kind
from aiworker.pipeline.fusion import _join_reading_order, attach_labels
from aiworker.pipeline.ocr import OCRResult
from aiworker.pipeline.vectorize import VectorizedShape


def _room(x0: float, y0: float, x1: float, y1: float) -> Classified:
    p = Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
    return Classified(
        shape=VectorizedShape(polygon=p, area_pixels=p.area),
        kind=Kind.ROOM,
        confidence=0.9,
    )


def _ocr(text: str, cx: float, cy: float, confidence: float = 85.0) -> OCRResult:
    # bbox is centered on (cx, cy) with an arbitrary 20x10 box.
    return OCRResult(
        text=text,
        center_x=cx,
        center_y=cy,
        bbox=(cx - 10, cy - 5, cx + 10, cy + 5),
        confidence=confidence,
    )


def test_label_inside_room_attaches() -> None:
    rooms = [_room(0, 0, 100, 100)]
    ocr = [_ocr("KITCHEN", 50, 50)]
    out = attach_labels(rooms, ocr)
    assert out[0].label == "KITCHEN"


def test_label_outside_room_ignored() -> None:
    rooms = [_room(0, 0, 100, 100)]
    ocr = [_ocr("HALLWAY", 500, 500)]
    out = attach_labels(rooms, ocr)
    assert out[0].label == ""


def test_multi_word_label_joins_reading_order() -> None:
    rooms = [_room(0, 0, 400, 200)]
    # Two words on one line, then a code on the line below —
    # matches a typical facility label like "OPERATING ROOM\nF115".
    ocr = [
        _ocr("OPERATING", 100, 50),
        _ocr("ROOM", 200, 50),
        _ocr("F115", 150, 120),
    ]
    out = attach_labels(rooms, ocr)
    assert out[0].label == "OPERATING ROOM F115"


def test_non_room_kinds_pass_through() -> None:
    p = Polygon([(0, 0), (100, 0), (100, 10), (0, 10)])
    wall = Classified(
        shape=VectorizedShape(polygon=p, area_pixels=p.area),
        kind=Kind.WALL,
        confidence=0.7,
    )
    ocr = [_ocr("WALL A", 50, 5)]
    out = attach_labels([wall], ocr)
    assert out[0].label == ""  # walls never get labels
    assert out[0].kind == Kind.WALL


def test_empty_ocr_is_no_op() -> None:
    rooms = [_room(0, 0, 50, 50)]
    out = attach_labels(rooms, [])
    assert out == rooms


def test_join_reading_order_two_lines() -> None:
    """Direct test of the helper — sanity-check the band grouping."""
    words = [
        _ocr("HELLO", 30, 20),
        _ocr("WORLD", 100, 20),
        _ocr("LINE2", 50, 80),
    ]
    joined = _join_reading_order(words)
    assert joined == "HELLO WORLD LINE2"
