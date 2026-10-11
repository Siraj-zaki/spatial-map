"""Rooms: faces of the wall graph, named by the text inside them.

Walls (with door gaps already bridged) are polygonized; faces that are
too small or are just wall slivers are dropped. Labels come from
Tesseract on a 2× upscale in sparse-text mode, with neighbouring words
joined into phrases.

Open sales floors that are split into departments only by printed labels
(no walls) come back as one face carrying several labels — splitting
those needs the review stage.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import cv2
import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union

from aiworker.geometric.scale import PlanScale
from aiworker.geometric.walls import Wall

log = logging.getLogger(__name__)


@dataclass
class Phrase:
    text: str
    x: float
    y: float
    h: float


@dataclass
class Room:
    polygon: Polygon
    labels: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return " / ".join(self.labels)


def ocr_words(gray: np.ndarray, min_conf: float = 55.0) -> list[list]:
    """Tesseract words as [text, x0, y0, x1, y1] (plan pixels) — sparse-text
    mode on a 2× upscale, which reads small CAD lettering far better than
    the default page mode."""

    try:
        import pytesseract
    except ImportError:  # pragma: no cover
        return []
    big = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    try:
        d = pytesseract.image_to_data(big, config="--psm 11", output_type=pytesseract.Output.DICT)
    except pytesseract.TesseractNotFoundError:
        log.warning("rooms.ocr_words: tesseract not installed")
        return []
    words = []
    for i, t in enumerate(d["text"]):
        t = (t or "").strip()
        try:
            conf = float(d["conf"][i])
        except (TypeError, ValueError):
            continue
        if conf < min_conf or not t:
            continue
        x, y, w, h = (d[k][i] / 2 for k in ("left", "top", "width", "height"))
        words.append([t, x, y, x + w, y + h])
    return words


def text_mask(shape: tuple[int, int], words: list[list], pad: int = 2) -> np.ndarray:
    """Word boxes as a mask, so letter strokes never become walls. Boxes
    taller than a typical label (likely a misread wall run) are skipped."""

    m = np.zeros(shape, np.uint8)
    for _t, x0, y0, x1, y1 in words:
        if (y1 - y0) > 40 or (x1 - x0) > 400:
            continue
        cv2.rectangle(m, (int(x0) - pad, int(y0) - pad), (int(x1) + pad, int(y1) + pad), 1, -1)
    return m


def read_phrases(words: list[list]) -> list[Phrase]:
    """Words → phrases: words on the same line with a small gap, then
    stacked lines that are centred on each other ('STAFF BREAK' / 'ROOM')."""

    words = [list(w) for w in words if len(w[0]) >= 2 and any(ch.isalpha() for ch in w[0])]
    words.sort(key=lambda w: (round(w[2] / 6), w[1]))
    lines: list[list] = []
    for w in words:
        for ln in lines:
            hgt = ln[4] - ln[2]
            if abs(w[2] - ln[2]) < 0.5 * hgt and 0 <= w[1] - ln[3] < 1.2 * hgt:
                ln[0] += " " + w[0]
                ln[3], ln[4] = max(ln[3], w[3]), max(ln[4], w[4])
                break
        else:
            lines.append(list(w))
    lines.sort(key=lambda ln: ln[2])
    phrases: list[list] = []
    for ln in lines:
        hgt = ln[4] - ln[2]
        cx = (ln[1] + ln[3]) / 2
        for p in phrases:
            pcx = (p[1] + p[3]) / 2
            if 0 <= ln[2] - p[4] < 0.8 * hgt and abs(cx - pcx) < 0.6 * max(
                p[3] - p[1], ln[3] - ln[1]
            ):
                p[0] += " " + ln[0]
                p[1], p[3], p[4] = min(p[1], ln[1]), max(p[3], ln[3]), ln[4]
                break
        else:
            phrases.append(list(ln))
    return [Phrase(p[0], (p[1] + p[3]) / 2, (p[2] + p[4]) / 2, p[4] - p[2]) for p in phrases]


def detect_rooms(
    walls: list[Wall], phrases: list[Phrase], inside: np.ndarray, scale: PlanScale
) -> list[Room]:
    ext = scale.px(0.2)  # tiny overshoot so near-miss joints still close
    segs = []
    for w in walls:
        (x0, y0), (x1, y1) = w.endpoints()
        if w.o == "h":
            segs.append(LineString([(x0 - ext, y0), (x1 + ext, y1)]))
        else:
            segs.append(LineString([(x0, y0 - ext), (x1, y1 + ext)]))
    faces = list(polygonize(unary_union(segs)))
    total = float(inside.sum())
    min_area = scale.px(1.5) * scale.px(1.5)
    rooms: list[Room] = []
    for f in faces:
        if f.area < min_area or f.area > 0.9 * total:
            continue
        mrr = f.minimum_rotated_rectangle
        xs, ys = mrr.exterior.coords.xy
        sides = sorted(math.dist((xs[k], ys[k]), (xs[k + 1], ys[k + 1])) for k in range(4))
        if sides[0] < scale.px(0.8):  # wall sliver between double lines
            continue
        c = f.representative_point()
        if not inside[int(c.y), int(c.x)]:
            continue
        rooms.append(Room(f.simplify(1.0)))
    for p in phrases:
        pt = Point(p.x, p.y)
        for r in rooms:
            if r.polygon.contains(pt):
                r.labels.append(p.text)
                break
    return rooms


def detect_rooms_raster(
    walls: list[Wall],
    openings: list[tuple],
    phrases: list[Phrase],
    inside: np.ndarray,
    scale: PlanScale,
) -> list[Room]:
    """Rooms as enclosed free space: paint walls and door openings, close
    joints that miss by less than ~0.6 m, flood the floor inside the
    building. Tolerant of imperfect vector joints, unlike polygonize."""

    canvas = np.zeros(inside.shape, np.uint8)
    th = max(2, scale.ipx(0.2))
    for w in walls:
        (x0, y0), (x1, y1) = w.endpoints()
        cv2.line(canvas, (int(x0), int(y0)), (int(x1), int(y1)), 1, max(th, int(w.t)))
    for v0, v1 in openings:
        cv2.line(canvas, tuple(map(int, v0)), tuple(map(int, v1)), 1, th)
    # Doorway-sized gaps between aligned wall ends close a room even when
    # no swing arc was found (sliding doors, missed arcs, plain openings).
    lo, hi, ctol = scale.px(0.6), scale.px(5.0), scale.px(0.25)
    for u in walls:
        for w in walls:
            if u is w or u.o != w.o or abs(u.c - w.c) > ctol or not (lo <= w.a - u.b <= hi):
                continue
            c = (u.c + w.c) / 2
            p, q = ((u.b, c), (w.a, c)) if u.o == "h" else ((c, u.b), (c, w.a))
            cv2.line(canvas, (int(p[0]), int(p[1])), (int(q[0]), int(q[1])), 1, th)
    _extend_dangling(canvas, walls, th, scale)
    k = scale.ipx(0.6, 3)
    canvas = cv2.morphologyEx(canvas, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    # The building outline closes any gap left in the exterior wall line.
    outline = inside - cv2.erode(inside, np.ones((th, th), np.uint8))
    canvas |= outline
    # Interior = free space the image border cannot reach through walls.
    free = (canvas == 0).astype(np.uint8)
    flood = free.copy()
    mask = np.zeros((free.shape[0] + 2, free.shape[1] + 2), np.uint8)
    for seed in (
        (0, 0),
        (free.shape[1] - 1, 0),
        (0, free.shape[0] - 1),
        (free.shape[1] - 1, free.shape[0] - 1),
    ):
        if flood[seed[1], seed[0]] == 1:
            cv2.floodFill(flood, mask, seed, 2)
    free = ((flood == 1) & (inside > 0)).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(free, 4)
    min_area = scale.px(1.5) * scale.px(1.5)
    total = float(inside.sum())
    rooms: list[Room] = []
    for i in range(1, n):
        if st[i][4] < min_area or st[i][4] > 0.7 * total:
            continue
        m = (lab == i).astype(np.uint8)
        m = cv2.dilate(m, np.ones((th + 2, th + 2), np.uint8))  # grow back to wall centre lines
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cs:
            continue
        c = max(cs, key=cv2.contourArea)
        approx = cv2.approxPolyDP(c, scale.px(0.15), True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        poly = Polygon(approx).buffer(0)
        if poly.is_empty or poly.geom_type != "Polygon":
            continue
        rooms.append(Room(poly))
    for p in phrases:
        pt = Point(p.x, p.y)
        for r in rooms:
            if r.polygon.contains(pt):
                r.labels.append(p.text)
                break
    return rooms


def _extend_dangling(canvas: np.ndarray, walls: list[Wall], th: int, scale: PlanScale) -> None:
    """A wall that stops short of another wall usually ends at a doorway.
    March each free end along its axis up to doorway width (2.2 m) and,
    if it reaches another wall, draw the closure."""

    reach, start = scale.px(2.6), max(th + 2, scale.ipx(0.25))
    h, w = canvas.shape
    for wl in walls:
        for end, sign in ((wl.a, -1), (wl.b, 1)):

            def probe(d: float, wl=wl, end=end, sign=sign) -> tuple[int, int]:
                if wl.o == "h":
                    return int(round(end + sign * d)), int(round(wl.c))
                return int(round(wl.c)), int(round(end + sign * d))

            px, py = probe(start)
            if 0 <= px < w and 0 <= py < h and canvas[py, px]:
                continue  # already touching something
            d = start
            while d <= reach:
                px, py = probe(d)
                if not (0 <= px < w and 0 <= py < h):
                    break
                if canvas[py, px]:
                    cv2.line(canvas, probe(0), (px, py), 1, th)
                    break
                d += 1.0
