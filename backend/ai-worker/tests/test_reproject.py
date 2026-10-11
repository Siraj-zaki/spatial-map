"""Mirrors backend/internal/ai/coords_test.go::TestUVLngLatRoundTrip
1:1 so any regression in one language is immediately visible from the
other side. Also mirrors the corner-anchor + crop-shrinks-bbox tests
that guard against y-flip and crop-percentage bugs.
"""

from __future__ import annotations

import pytest

from aiworker.pipeline.reproject import ImageCrop, ImageFrame, lnglat_to_uv, uv_to_lnglat

TOLERANCE = 1e-9
UV_SAMPLES = [
    (0, 0), (1, 0), (1, 1), (0, 1),      # corners
    (0.5, 0.5),                          # center
    (0.25, 0.75), (0.9, 0.1),            # off-center
]

CASES = [
    (
        "unrotated no crop, mid-latitude",
        ImageFrame(start_lng=-0.10001, start_lat=51.50000,
                   current_lng=-0.09999, current_lat=51.50002),
    ),
    (
        "rotated 30 CCW, no crop",
        ImageFrame(start_lng=-122.42, start_lat=37.77,
                   current_lng=-122.40, current_lat=37.79,
                   rotation=30),
    ),
    (
        "rotated -45 (CW), 10% margin crop on all sides",
        ImageFrame(start_lng=139.75, start_lat=35.68,
                   current_lng=139.77, current_lat=35.70,
                   rotation=-45,
                   crop=ImageCrop(top=10, right=10, bottom=10, left=10)),
    ),
    (
        "rotated 175, asymmetric crop",
        ImageFrame(start_lng=2.29, start_lat=48.85,
                   current_lng=2.31, current_lat=48.87,
                   rotation=175,
                   crop=ImageCrop(top=5, right=20, bottom=15, left=3)),
    ),
    (
        "reversed start/current, small rotation",
        ImageFrame(start_lng=-73.98, start_lat=40.76,
                   current_lng=-74.00, current_lat=40.74,
                   rotation=7.3),
    ),
]


@pytest.mark.parametrize("name,frame", CASES, ids=[c[0] for c in CASES])
def test_uv_lnglat_round_trip(name: str, frame: ImageFrame) -> None:
    for uv in UV_SAMPLES:
        lng, lat = uv_to_lnglat(frame, uv[0], uv[1])
        u2, v2 = lnglat_to_uv(frame, lng, lat)
        assert abs(u2 - uv[0]) < TOLERANCE, f"{name}: u drift"
        assert abs(v2 - uv[1]) < TOLERANCE, f"{name}: v drift"


def test_known_corners() -> None:
    # Same pinning tests as Go's TestUVToLngLat_KnownCorners — image
    # TOP-LEFT (u=0, v=0) must map to (start_lng, current_lat_max).
    frame = ImageFrame(start_lng=10.0, start_lat=20.0,
                       current_lng=12.0, current_lat=22.0)
    lng, lat = uv_to_lnglat(frame, 0, 0)
    assert abs(lng - 10.0) < TOLERANCE
    assert abs(lat - 22.0) < TOLERANCE

    lng, lat = uv_to_lnglat(frame, 1, 1)
    assert abs(lng - 12.0) < TOLERANCE
    assert abs(lat - 20.0) < TOLERANCE

    lng, lat = uv_to_lnglat(frame, 0.5, 0.5)
    assert abs(lng - 11.0) < TOLERANCE
    assert abs(lat - 21.0) < TOLERANCE


def test_crop_shrinks_bbox() -> None:
    # An inverse that ignored crop would still pass round-trip because
    # both directions would be equally wrong — this test is the anchor
    # against that class of bug.
    frame = ImageFrame(start_lng=0.0, start_lat=0.0,
                       current_lng=100.0, current_lat=100.0,
                       crop=ImageCrop(top=10, right=20, bottom=15, left=5))
    # croppedMinLng=5, croppedMaxLng=80, croppedMinLat=15, croppedMaxLat=90.
    # Top-left (u=0, v=0) → (5, 90).
    lng, lat = uv_to_lnglat(frame, 0, 0)
    assert abs(lng - 5.0) < TOLERANCE
    assert abs(lat - 90.0) < TOLERANCE
    lng, lat = uv_to_lnglat(frame, 1, 1)
    assert abs(lng - 80.0) < TOLERANCE
    assert abs(lat - 15.0) < TOLERANCE
