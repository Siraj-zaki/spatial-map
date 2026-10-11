"""Geometric detector on a synthetic plan with known answers.

The plan is drawn at 5 cm/px: a 20 × 12 m building, an interior wall with
a 0.9 m door (leaf + quarter arc), a 2 × 6-bay shelf unit and a striped
rail block. OCR is skipped (no tesseract needed)."""

from __future__ import annotations

import math

import cv2
import numpy as np

from aiworker.geometric import detect_geometry
from aiworker.geometric.evaluate import evaluate
from aiworker.geometric.review import apply_answers, build_review
from aiworker.geometric.scale import PlanScale

M = 0.05  # metres per pixel
W, H = 520, 360


def px(m: float) -> int:
    return int(round(m / M))


def _plan() -> np.ndarray:
    img = np.full((H, W), 255, np.uint8)
    x0, y0, x1, y1 = px(1), px(1), px(21), px(13)
    cv2.rectangle(img, (x0, y0), (x1, y1), 0, 6)  # exterior, 0.3 m
    wx = px(9)  # interior wall at x = 9 m with a door from y = 5 to 5.9 m
    cv2.line(img, (wx, y0), (wx, px(5)), 0, 4)
    cv2.line(img, (wx, px(5.9)), (wx, y1), 0, 4)
    hinge = (wx, px(5))
    r = px(0.9)
    cv2.line(img, hinge, (wx + r, px(5)), 0, 1)  # open leaf, perpendicular
    cv2.ellipse(img, hinge, (r, r), 0, 0, 90, 0, 1)  # swing arc to the closed tip
    # Shelf unit: 2 columns × 6 bays of 0.8 × 1.0 m cells.
    sx, sy = px(12), px(3)
    for c in range(2):
        for b in range(6):
            cv2.rectangle(
                img,
                (sx + c * px(0.8), sy + b * px(1.0)),
                (sx + (c + 1) * px(0.8), sy + (b + 1) * px(1.0)),
                0,
                1,
            )
    # Rail block: 14 short teeth at 0.3 m pitch on a spine.
    rx, ry = px(16), px(4)
    cv2.line(img, (rx + px(0.9), ry), (rx + px(0.9), ry + px(4.2)), 0, 2)
    for k in range(15):
        y = ry + k * px(0.3)
        cv2.line(img, (rx, y), (rx + px(1.8), y), 0, 1)
    return img


def _placement() -> dict:
    lat = 0.0
    return {
        "startLng": 0.0,
        "startLat": lat + H * M / 111_320.0,
        "currentLng": W * M / 111_320.0,
        "currentLat": lat,
    }


def test_scale_from_placement():
    s = PlanScale.from_placement(_placement(), W, H)
    assert abs(s.mx - M) < 1e-3 and abs(s.my - M) < 1e-3


def test_detects_walls_door_and_fixtures():
    img = _plan()
    det = detect_geometry(cv2.cvtColor(img, cv2.COLOR_GRAY2RGB), _placement(), ocr=False)
    gt = {
        "walls": [
            {
                "pts": [
                    [px(1), px(1)],
                    [px(21), px(1)],
                    [px(21), px(13)],
                    [px(1), px(13)],
                    [px(1), px(1)],
                ]
            },
            {"pts": [[px(9), px(1)], [px(9), px(13)]]},
        ],
        "doors": [{"pts": [[px(9), px(5)], [px(9), px(5.9)]], "kind": "single"}],
        "racks": [
            {"bbox": [px(12), px(3), px(13.6), px(9)]},
            {"bbox": [px(16), px(4), px(17.8), px(8.2)]},
        ],
        "rooms": [],
    }
    score = evaluate(det, gt, det["image"]["m_per_px"])
    assert score["walls"]["recall"] > 0.9, score["walls"]
    assert score["walls"]["precision"] > 0.9, score["walls"]
    assert score["doors"]["tp"] == 1 and score["doors"]["det"] == 1, score["doors"]
    assert score["doors"]["mean_width_err_m"] < 0.15
    assert score["racks"]["tp"] == 2, (score["racks"], det["racks"])
    shelf = next(r for r in det["racks"] if r["kind"] == "shelf")
    assert (shelf["cols"], shelf["rows"]) == (2, 6)
    # Rooms: the interior wall + door split the building in two.
    assert len(det["rooms"]) == 2, [len(r["px"]) for r in det["rooms"]]
    # The door swings into the right-hand room (towards +x).
    door = det["doors"][0]
    assert door["open_px"][0] > px(9)


def test_review_package_and_answers():
    img = _plan()
    det = detect_geometry(cv2.cvtColor(img, cv2.COLOR_GRAY2RGB), _placement(), ocr=False)
    pkg = build_review(cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), det)
    assert pkg.tiles and all(t.png[:4] == b"\x89PNG" for t in pkg.tiles)
    seen = {k for t in pkg.tiles for k in t.ids}
    assert {"walls", "doors", "racks"} <= seen
    n_walls = len(det["walls"])
    long_i = max(range(n_walls), key=lambda i: math.dist(*det["walls"][i]["px"]))
    rack_i = 0
    out = apply_answers(
        det, [{"reject": {"walls": [long_i], "racks": [rack_i]}, "room_names": {"A0": "Stockroom"}}]
    )
    # One vote never removes a long wall; it does remove a rack.
    assert len(out["walls"]) == n_walls
    assert len(out["racks"]) == len(det["racks"]) - 1
    assert out["rooms"][0]["name"] == "Stockroom"
    out2 = apply_answers(det, [{"reject": {"walls": [long_i]}}] * 2)
    assert len(out2["walls"]) == n_walls - 1
