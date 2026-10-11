"""Tesseract-based text extraction for room labels.

Tesseract chosen over Moondream 3 / PaddleOCR for this Phase 3 slice:
  - 10 MB apt package, <100 MB memory at runtime
  - CPU-only, no torch dependency
  - Excellent recall on clean, typewritten architectural labels
    (our test set is almost exclusively CAD-style plans with crisp
    black text on white — Tesseract's sweet spot)
  - `image_to_data` returns per-word bounding boxes we can feed
    directly into fusion.attach_labels for point-in-polygon fusion

If verification shows recall issues on decorative fonts or noisy
scans, PaddleOCR is the documented Phase 3.5 escalation path — same
API contract (list of `OCRResult`), swap the impl.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass

from PIL import Image

log = logging.getLogger(__name__)

# Confidence floor: Tesseract emits -1 for whitespace boxes and 0-100
# for actual detections. 60 filters most obvious OCR mistakes
# without dropping legitimate low-contrast labels.
_MIN_CONFIDENCE = 60.0


@dataclass(frozen=True)
class OCRResult:
    """One recognized word (or short phrase) + its pixel bbox.

    Multi-word room names like "OPERATING ROOM 1 F115" typically come
    back as several `OCRResult`s that fusion.attach_labels joins by
    adjacency (same containing polygon → concatenate)."""

    text: str
    center_x: float
    center_y: float
    bbox: tuple[float, float, float, float]  # (x0, y0, x1, y1)
    confidence: float


def extract_labels(image_bytes: bytes, min_confidence: float = _MIN_CONFIDENCE) -> list[OCRResult]:
    """Run Tesseract on the given image bytes and return per-word
    results above the confidence floor. Grayscale + light contrast
    preprocessing (via PIL) is enough for CAD-quality inputs; noisy
    scans would benefit from `cv2.adaptiveThreshold` — deferred to
    a Phase 3.5 improvement once we see real-world recall numbers.

    Late import of `pytesseract` so unit tests that don't need OCR
    (reproject, vectorize, classify) don't force the tesseract
    binary to be installed on the dev machine.
    """

    import pytesseract

    image = Image.open(io.BytesIO(image_bytes)).convert("L")
    try:
        data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
    except pytesseract.TesseractNotFoundError as exc:
        # Reported once; downstream should treat OCR failure as "no
        # labels" rather than failing the whole detection job.
        log.warning("ocr.extract_labels: tesseract binary not found (%s)", exc)
        return []
    return _rows_to_results(data, min_confidence)


def _rows_to_results(data: dict, min_confidence: float) -> list[OCRResult]:
    n = len(data.get("text", []))
    out: list[OCRResult] = []
    for i in range(n):
        text = (data["text"][i] or "").strip()
        if not text:
            continue
        raw_conf = data["conf"][i]
        try:
            conf = float(raw_conf)
        except (TypeError, ValueError):
            continue
        if conf < min_confidence:
            continue
        x = float(data["left"][i])
        y = float(data["top"][i])
        w = float(data["width"][i])
        h = float(data["height"][i])
        out.append(
            OCRResult(
                text=text,
                center_x=x + w / 2.0,
                center_y=y + h / 2.0,
                bbox=(x, y, x + w, y + h),
                confidence=conf,
            )
        )
    return out
