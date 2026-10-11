"""Orchestrator: image + placement → geometric detections.

ink / building mask → fixtures → walls → doors → bridge door gaps
    → rooms (+ OCR names) → reproject to lng/lat
"""

from __future__ import annotations

import io
import logging
from typing import Any

import cv2
import numpy as np
from PIL import Image

from aiworker.geometric.doors import Door, detect_doors
from aiworker.geometric.fixtures import Fixture, detect_fixtures, fixture_mask
from aiworker.geometric.raster import building_mask, ink_mask
from aiworker.geometric.rooms import Room, detect_rooms_raster, ocr_words, read_phrases, text_mask
from aiworker.geometric.scale import PlanScale
from aiworker.geometric.walls import Wall, bridge_door_gaps, detect_walls
from aiworker.pipeline.reproject import ImageFrame, pixel_to_lnglat

log = logging.getLogger(__name__)

PIPELINE_VERSION = "geometric-0.1"


def detect_geometry(
    image: bytes | np.ndarray, placement: dict[str, Any], ocr: bool = True
) -> dict[str, Any]:
    gray = _to_gray(image)
    h, w = gray.shape
    scale = PlanScale.from_placement(placement, w, h)
    ink = ink_mask(gray)
    inside = building_mask(ink, close_px=scale.ipx(2.5, 11), wall_thick=max(2, scale.ipx(0.15)))
    inside_pad = cv2.dilate(inside, np.ones((scale.ipx(1.0, 5),) * 2, np.uint8))

    words = ocr_words(gray) if ocr else []
    phrases = read_phrases(words)
    ink_walls = ink & (1 - text_mask(ink.shape, words))

    fixtures = detect_fixtures(ink, inside, scale)
    blocked = fixture_mask(ink.shape, fixtures, pad=scale.ipx(0.12))
    walls = detect_walls(ink_walls, inside_pad, blocked, scale)
    doors, leaves = detect_doors(ink, walls, scale)
    walls = [w for k, w in enumerate(walls) if k not in leaves]
    walls = bridge_door_gaps(walls, [(d.v0, d.v1) for d in doors], scale)
    doors = _reattach(doors, walls)
    rooms = detect_rooms_raster(walls, [(d.v0, d.v1) for d in doors], phrases, inside, scale)
    log.info(
        "geometric: %d fixtures, %d walls, %d doors, %d rooms (%.3f m/px)",
        len(fixtures),
        len(walls),
        len(doors),
        len(rooms),
        scale.m,
    )
    return _emit(fixtures, walls, doors, rooms, placement, w, h, scale)


def _to_gray(image: bytes | np.ndarray) -> np.ndarray:
    if isinstance(image, np.ndarray):
        return image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    return np.array(Image.open(io.BytesIO(image)).convert("L"), dtype=np.uint8)


def _reattach(doors: list[Door], walls: list[Wall]) -> list[Door]:
    """Wall indices change when gaps are bridged; point each door at the
    wall its hinge now lies on."""

    from aiworker.geometric.doors import _nearest_wall

    for d in doors:
        d.wall = _nearest_wall(d.v0, walls)[1]
    return doors


def _emit(
    fixtures: list[Fixture],
    walls: list[Wall],
    doors: list[Door],
    rooms: list[Room],
    placement: dict[str, Any],
    w: int,
    h: int,
    scale: PlanScale,
) -> dict[str, Any]:
    frame = ImageFrame(
        start_lng=float(placement.get("startLng", 0.0)),
        start_lat=float(placement.get("startLat", 0.0)),
        current_lng=float(placement.get("currentLng", 1.0)),
        current_lat=float(placement.get("currentLat", 1.0)),
        rotation=float(placement.get("rotation", 0.0)),
    )
    ll = lambda p: list(pixel_to_lnglat(frame, p[0], p[1], w, h))  # noqa: E731
    r2 = lambda v: round(float(v), 2)  # noqa: E731
    return {
        "pipeline_version": PIPELINE_VERSION,
        "image": {"w": w, "h": h, "m_per_px": round(scale.m, 5)},
        "walls": [
            {
                "px": [[r2(c) for c in p] for p in wl.endpoints()],
                "thickness_m": round(wl.t * scale.m, 3),
                "lnglat": [ll(p) for p in wl.endpoints()],
            }
            for wl in walls
        ],
        "doors": [
            {
                "kind": d.kind,
                "px": [[r2(c) for c in d.v0], [r2(c) for c in d.v1]],
                "open_px": [r2(c) for c in d.open_pt],
                "wall": d.wall,
                "width_m": round(
                    float(np.hypot(d.v1[0] - d.v0[0], d.v1[1] - d.v0[1])) * scale.m, 2
                ),
                "lnglat": [ll(d.v0), ll(d.v1)],
                "score": d.score,
            }
            for d in doors
        ],
        "racks": [
            {
                "kind": f.kind,
                "bbox_px": [r2(v) for v in f.bbox],
                "cols": f.cols,
                "rows": f.rows,
                "lnglat": [ll((f.x0, f.y0)), ll((f.x1, f.y1))],
                "score": f.score,
            }
            for f in fixtures
        ],
        "rooms": [
            {
                "px": [[r2(x), r2(y)] for x, y in r.polygon.exterior.coords],
                "labels": r.labels,
                "lnglat": [ll(p) for p in r.polygon.exterior.coords],
            }
            for r in rooms
        ],
    }
