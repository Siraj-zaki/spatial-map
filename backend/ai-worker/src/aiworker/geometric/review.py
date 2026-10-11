"""Review stage: a vision model JUDGES candidates; it never draws them.

The geometric detectors produce exact geometry. What they can't do is
tell a wall from a shelf back, or name a department. This stage renders
zoomed crops with each candidate drawn and numbered, and asks structured
questions whose answers are picks and names only — never coordinates
(vision models are unreliable at coordinates; see docs/ai-floorplan.md).

    build_review(image, detections) → ReviewPackage (crops + questions)
    apply_answers(detections, answers) → filtered / named detections
    ask_model(package)               → answers (needs ANTHROPIC_API_KEY)

Without an API key the package is still useful: the same crops and
questions drive the human review dialog.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

log = logging.getLogger(__name__)

TILE_M = 30.0  # crop size in metres
MODEL = os.environ.get("AIWORKER_REVIEW_MODEL", "claude-sonnet-5")

QUESTION = """You are checking a draft digitisation of an architectural floor plan.
The crop shows the original drawing with draft detections drawn on it:
  red numbered lines   = candidate WALLS
  green numbered lines = candidate DOORS (line = opening, thin line = swing side)
  blue numbered boxes  = candidate RACKS / fixtures
  purple numbered areas = candidate ROOMS
Answer ONLY with JSON:
{"reject": {"walls": [ids], "doors": [ids], "racks": [ids]},
 "room_names": {"<room id>": "<name as printed, or a short description>"},
 "missing": ["short description of any wall, door or rack in the drawing that has no candidate"]}
Reject a candidate only if it is clearly wrong (e.g. a shelf edge, counter, desk or
escalator side marked as a wall; a furniture curve marked as a door; stair treads or
text marked as a rack). Thick double-line exterior walls and stair / lift enclosures
ARE walls. Do not invent coordinates."""


@dataclass
class Tile:
    id: str
    box: tuple[int, int, int, int]  # x0, y0, x1, y1 in plan pixels
    png: bytes
    ids: dict[str, list[int]] = field(default_factory=dict)


@dataclass
class ReviewPackage:
    tiles: list[Tile]
    question: str = QUESTION

    def to_dir(self, path: str) -> None:
        os.makedirs(path, exist_ok=True)
        index = []
        for t in self.tiles:
            with open(os.path.join(path, f"{t.id}.png"), "wb") as fh:
                fh.write(t.png)
            index.append({"tile": t.id, "box": t.box, "ids": t.ids})
        with open(os.path.join(path, "questions.json"), "w") as fh:
            json.dump({"question": self.question, "tiles": index}, fh, indent=1)


def _bbox_of(points: list[list[float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def build_review(image_bgr: np.ndarray, det: dict[str, Any]) -> ReviewPackage:
    """Tile the building into ~30 m crops (with overlap) and draw every
    candidate that touches a tile, numbered by its index in `det`."""

    m = det["image"]["m_per_px"]
    tile = int(TILE_M / m)
    step = int(tile * 0.8)
    items: list[tuple[str, int, tuple[float, float, float, float]]] = []
    for i, w in enumerate(det["walls"]):
        items.append(("walls", i, _bbox_of(w["px"])))
    for i, d in enumerate(det["doors"]):
        items.append(("doors", i, _bbox_of(d["px"] + [d["open_px"]])))
    for i, r in enumerate(det["racks"]):
        items.append(("racks", i, tuple(r["bbox_px"])))
    for i, r in enumerate(det["rooms"]):
        items.append(("rooms", i, _bbox_of(r["px"])))
    if not items:
        return ReviewPackage([])
    x_lo = int(min(b[0] for _, _, b in items))
    y_lo = int(min(b[1] for _, _, b in items))
    x_hi = int(max(b[2] for _, _, b in items))
    y_hi = int(max(b[3] for _, _, b in items))
    h, w = image_bgr.shape[:2]
    tiles: list[Tile] = []
    for ty in range(max(0, y_lo), min(h, y_hi) + 1, step):
        for tx in range(max(0, x_lo), min(w, x_hi) + 1, step):
            box = (tx, ty, min(w, tx + tile), min(h, ty + tile))
            inside = [(k, i) for k, i, b in items if _centre_in(b, box)]
            if not any(k != "rooms" for k, _ in inside):
                continue
            ids: dict[str, list[int]] = {}
            for k, i in inside:
                ids.setdefault(k, []).append(i)
            tiles.append(Tile(f"t{len(tiles):03d}", box, _render(image_bgr, det, box, ids), ids))
    return ReviewPackage(tiles)


def _centre_in(b: tuple, box: tuple) -> bool:
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return box[0] <= cx < box[2] and box[1] <= cy < box[3]


def _render(img: np.ndarray, det: dict[str, Any], box: tuple, ids: dict[str, list[int]]) -> bytes:
    x0, y0, x1, y1 = box
    crop = img[y0:y1, x0:x1].copy()
    scale = 1024 / max(1, max(x1 - x0, y1 - y0))
    crop = cv2.resize(
        crop,
        None,
        fx=scale,
        fy=scale,
        interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC,
    )
    P = lambda p: (int((p[0] - x0) * scale), int((p[1] - y0) * scale))  # noqa: E731
    ov = crop.copy()
    for i in ids.get("rooms", []):
        cv2.fillPoly(
            ov, [np.array([P(p) for p in det["rooms"][i]["px"]], np.int32)], (220, 160, 230)
        )
    crop = cv2.addWeighted(ov, 0.3, crop, 0.7, 0)

    H, W = crop.shape[:2]

    def label(text: str, at: tuple[int, int], color: tuple[int, int, int]) -> None:
        # Keep the whole label inside the crop: a clipped "W177" reads as
        # "W17" and gets the wrong candidate rejected.
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        x = min(max(2, at[0] + 3), W - tw - 2)
        y = min(max(th + 2, at[1] - 3), H - 3)
        cv2.putText(crop, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 3)
        cv2.putText(crop, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

    for i in ids.get("racks", []):
        b = det["racks"][i]["bbox_px"]
        cv2.rectangle(crop, P(b[:2]), P(b[2:]), (230, 90, 0), 2)
        label(f"R{i}", P(b[:2]), (230, 90, 0))
    for i in ids.get("walls", []):
        a, b = det["walls"][i]["px"]
        cv2.line(crop, P(a), P(b), (0, 0, 220), 2)
        mid = P(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))
        label(f"W{i}", mid, (0, 0, 220))
    for i in ids.get("doors", []):
        d = det["doors"][i]
        cv2.line(crop, P(d["px"][0]), P(d["px"][1]), (0, 160, 0), 4)
        cv2.line(crop, P(d["px"][0]), P(d["open_px"]), (0, 160, 0), 1)
        label(f"D{i}", P(d["px"][0]), (0, 120, 0))
    for i in ids.get("rooms", []):
        pts = np.array(det["rooms"][i]["px"])
        c = P(pts.mean(0))
        label(f"A{i}", c, (140, 0, 140))
    ok, png = cv2.imencode(".png", crop)
    return png.tobytes() if ok else b""


def ask_model(pkg: ReviewPackage, api_key: str | None = None) -> list[dict[str, Any]]:
    """Send each tile to the Anthropic Messages API and parse the JSON
    answer. Returns one answer dict per tile (empty list without a key)."""

    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        log.info("review.ask_model: no ANTHROPIC_API_KEY; returning the package for human review")
        return []
    import httpx

    answers = []
    with httpx.Client(timeout=120) as client:
        for t in pkg.tiles:
            body = {
                "model": MODEL,
                "max_tokens": 1500,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": base64.b64encode(t.png).decode(),
                                },
                            },
                            {
                                "type": "text",
                                "text": pkg.question
                                + f"\nCandidates in this crop: {json.dumps(t.ids)}",
                            },
                        ],
                    }
                ],
            }
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                json=body,
                headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
            )
            r.raise_for_status()
            text = "".join(c.get("text", "") for c in r.json().get("content", []))
            answers.append({"tile": t.id, **_parse_json(text)})
    return answers


def _parse_json(text: str) -> dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}


LONG_WALL_M = 6.0


def apply_answers(
    det: dict[str, Any], answers: list[dict[str, Any]], min_votes: int = 1, long_wall_votes: int = 2
) -> dict[str, Any]:
    """Drop candidates rejected in at least `min_votes` tiles; attach room
    names (first non-empty answer wins). Walls longer than LONG_WALL_M are
    rarely false and costly to lose, so they need `long_wall_votes`
    independent rejections (from overlapping tiles or repeated asks)."""

    votes: dict[str, dict[int, int]] = {"walls": {}, "doors": {}, "racks": {}}
    names: dict[int, str] = {}
    missing: list[str] = []
    for a in answers:
        for kind, ids in (a.get("reject") or {}).items():
            if kind in votes:
                for i in ids:
                    votes[kind][int(i)] = votes[kind].get(int(i), 0) + 1
        for rid, name in (a.get("room_names") or {}).items():
            try:
                names.setdefault(int(str(rid).lstrip("A")), str(name))
            except ValueError:
                continue
        missing.extend(a.get("missing") or [])
    out = dict(det)
    m = det["image"]["m_per_px"]

    def needed(kind: str, item: dict) -> int:
        if kind == "walls":
            (x0, y0), (x1, y1) = item["px"]
            if ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 * m >= LONG_WALL_M:
                return max(min_votes, long_wall_votes)
        return min_votes

    for kind in votes:
        out[kind] = [x for i, x in enumerate(det[kind]) if votes[kind].get(i, 0) < needed(kind, x)]
    rooms = []
    for i, r in enumerate(det["rooms"]):
        r = dict(r)
        if i in names:
            r["name"] = names[i]
        rooms.append(r)
    out["rooms"] = rooms
    out["review_missing"] = missing
    return out
