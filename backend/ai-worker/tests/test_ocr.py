"""Smoke test for the Tesseract OCR wrapper.

Uses `pytest.importorskip("pytesseract")` + a runtime skip when the
`tesseract` binary is missing so the test suite still passes on a
dev machine without the OCR binary installed (Docker builds always
have it via apt).
"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

pytesseract = pytest.importorskip("pytesseract")


def _synthetic_label_image(text: str, size: tuple[int, int] = (600, 200)) -> bytes:
    """Draw a single high-contrast label as a PNG. Simple enough that
    a stock Tesseract install with English traineddata should pick
    the text out with high confidence."""

    img = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(img)
    # Pillow's default bitmap font is small but always available —
    # good enough for a smoke test. `size=` needs a TTF, which isn't
    # portable, so we stay with the default.
    draw.text((30, 60), text, fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _tesseract_available() -> bool:
    try:
        pytesseract.get_tesseract_version()
        return True
    except pytesseract.TesseractNotFoundError:
        return False


@pytest.mark.skipif(not _tesseract_available(), reason="tesseract binary not installed")
def test_extract_labels_finds_known_text() -> None:
    from aiworker.pipeline.ocr import extract_labels

    png = _synthetic_label_image("RECEPTION 101")
    # Lower the confidence floor for the synthetic bitmap font —
    # Tesseract is less certain on the default PIL font than on
    # real anti-aliased architectural labels.
    results = extract_labels(png, min_confidence=30.0)
    assert results, "expected at least one OCR result"
    joined = " ".join(r.text for r in results).upper()
    assert "RECEPTION" in joined or "101" in joined


def test_extract_labels_returns_empty_on_solid_white() -> None:
    from aiworker.pipeline.ocr import extract_labels

    img = Image.new("RGB", (200, 100), "white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    # No skip guard: a missing binary makes extract_labels return []
    # via its own warning-then-empty path — identical output to a
    # blank image with a real binary. Either way, no results.
    assert extract_labels(buf.getvalue()) == []
