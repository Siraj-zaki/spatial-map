"""Pixel (x, y) → Mapbox (lng, lat).

Straight port of backend/internal/ai/coords.go::UVToLngLat. Same math,
same y-down convention, same crop-percentages composition, same
equirectangular rotation approximation. Kept in Python purely for
locality (the CV pipeline runs here, so the reprojection lives here);
the Go side keeps its own copy as a boundary-check for the API surface.

Parity is verified by test_reproject.py which mirrors the Go
TestUVLngLatRoundTrip cases 1:1.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class ImageCrop:
    """Percentages 0..100 — matches src/lib/shapes.ts::ImageCrop and
    the Go ai.ImageCrop struct. All zeros = no crop."""

    top: float = 0.0
    right: float = 0.0
    bottom: float = 0.0
    left: float = 0.0


@dataclass(frozen=True)
class ImageFrame:
    """Everything the reprojection needs to know about the placed image.

    Populated by the Go handler from the images row before enqueue.
    Rotation is degrees CCW (turf.transformRotate convention), applied
    around the FULL bbox center (matching imageCroppedCorners in
    src/lib/image-generators.ts — the crop shrinks the visible
    rectangle but does NOT move the pivot).
    """

    start_lng: float
    start_lat: float
    current_lng: float
    current_lat: float
    rotation: float = 0.0
    crop: ImageCrop = ImageCrop()


def _minmax(a: float, b: float) -> tuple[float, float]:
    return (a, b) if a <= b else (b, a)


def _rotate_around(
    lng: float, lat: float, c_lng: float, c_lat: float, degrees: float
) -> tuple[float, float]:
    """Equirectangular-approximation rotation of (lng, lat) around
    (c_lng, c_lat) by `degrees` CCW. Sub-millimeter accuracy at
    floor-plan scales (<1 km spans); matches the Go side's
    coords.go::rotateAround."""

    rad = math.radians(degrees)
    cos_r = math.cos(rad)
    sin_r = math.sin(rad)
    cos_lat = math.cos(math.radians(c_lat)) or 1e-9
    x = (lng - c_lng) * cos_lat
    y = lat - c_lat
    x_r = x * cos_r - y * sin_r
    y_r = x * sin_r + y * cos_r
    return c_lng + x_r / cos_lat, c_lat + y_r


def uv_to_lnglat(frame: ImageFrame, u: float, v: float) -> tuple[float, float]:
    """UV coord (normalized [0,1], y-down) → Mapbox (lng, lat).

    Contract: (u, v) is against the CROPPED image (what SAM actually
    sees when we've cropped a region), NOT the full source. When no
    crop is set, cropped == full, so the common case still works.
    """

    min_lng, max_lng = _minmax(frame.start_lng, frame.current_lng)
    min_lat, max_lat = _minmax(frame.start_lat, frame.current_lat)

    width = max_lng - min_lng
    height = max_lat - min_lat
    cropped_min_lng = min_lng + width * frame.crop.left / 100
    cropped_max_lng = max_lng - width * frame.crop.right / 100
    cropped_min_lat = min_lat + height * frame.crop.bottom / 100
    cropped_max_lat = max_lat - height * frame.crop.top / 100

    # v=0 is TOP (max lat), v=1 is BOTTOM (min lat).
    raw_lng = cropped_min_lng + u * (cropped_max_lng - cropped_min_lng)
    raw_lat = cropped_max_lat - v * (cropped_max_lat - cropped_min_lat)

    if abs(frame.rotation) < 1e-9:
        return raw_lng, raw_lat
    c_lng = (min_lng + max_lng) / 2
    c_lat = (min_lat + max_lat) / 2
    return _rotate_around(raw_lng, raw_lat, c_lng, c_lat, frame.rotation)


def lnglat_to_uv(frame: ImageFrame, lng: float, lat: float) -> tuple[float, float]:
    """Inverse of uv_to_lnglat. Used only by the round-trip test."""

    min_lng, max_lng = _minmax(frame.start_lng, frame.current_lng)
    min_lat, max_lat = _minmax(frame.start_lat, frame.current_lat)

    if abs(frame.rotation) >= 1e-9:
        c_lng = (min_lng + max_lng) / 2
        c_lat = (min_lat + max_lat) / 2
        lng, lat = _rotate_around(lng, lat, c_lng, c_lat, -frame.rotation)

    width = max_lng - min_lng
    height = max_lat - min_lat
    cropped_min_lng = min_lng + width * frame.crop.left / 100
    cropped_max_lng = max_lng - width * frame.crop.right / 100
    cropped_min_lat = min_lat + height * frame.crop.bottom / 100
    cropped_max_lat = max_lat - height * frame.crop.top / 100

    denom_x = cropped_max_lng - cropped_min_lng
    denom_y = cropped_max_lat - cropped_min_lat
    if denom_x <= 0 or denom_y <= 0:
        return 0.0, 0.0
    u = (lng - cropped_min_lng) / denom_x
    v = (cropped_max_lat - lat) / denom_y
    return u, v


def pixel_to_lnglat(
    frame: ImageFrame,
    x: float,
    y: float,
    image_width: int,
    image_height: int,
) -> tuple[float, float]:
    """Convenience wrapper: pixel (x, y) at a known image size →
    (lng, lat) via uv_to_lnglat. This is the entry point run.py uses
    for every contour vertex."""

    if image_width <= 0 or image_height <= 0:
        return frame.start_lng, frame.start_lat
    return uv_to_lnglat(frame, x / image_width, y / image_height)
