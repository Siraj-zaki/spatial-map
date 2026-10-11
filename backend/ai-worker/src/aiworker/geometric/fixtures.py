"""Fixtures: shelf units (outlined boxes split into bays) and striped
rail / gondola blocks.

Runs before wall detection: fixture outlines are as thick as walls on
many plans, so they are found first and masked out of the wall search.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from aiworker.geometric.scale import PlanScale


@dataclass
class Fixture:
    """Axis-aligned fixture in plan pixels. `kind` is 'shelf' (narrow bays),
    'table' (deep bays — display tables, cases) or 'rail' (striped block).
    `cols` × `rows` is the bay grid (cols across x, rows down y)."""

    kind: str
    x0: float
    y0: float
    x1: float
    y1: float
    cols: int
    rows: int
    score: float

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return (self.x0, self.y0, self.x1, self.y1)


def _count_lines(starts: list[float], tol: float) -> int:
    """Number of distinct values in `starts` (cells sharing a column or
    row start within `tol` count once)."""

    if not starts:
        return 0
    s = sorted(starts)
    n = 1
    for a, b in zip(s, s[1:], strict=False):
        if b - a > tol:
            n += 1
    return n


def detect_bay_fixtures(ink: np.ndarray, inside: np.ndarray, scale: PlanScale) -> list[Fixture]:
    """Shelf units and display tables: groups of small, rectangular,
    fully enclosed white cells.

    Cell limits (metres) keep the right things out:
      - short side ≥ 0.5 m rejects stair and escalator treads
      - short side ≤ 1.6 m and long side ≤ 4 m reject rooms, stalls,
        fitting-room cubicles
    A fixture needs at least two cells; single boxes are usually
    furniture symbols, not racks."""

    white = (1 - ink).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(white, 4)
    lo, hi_short, hi_long = scale.px(0.5), scale.px(1.6), scale.px(4.0)
    cells = np.zeros_like(ink)
    boxes: dict[int, tuple[int, int, int, int]] = {}
    for i in range(1, n):
        x, y, w, h, a = st[i]
        short, long_ = min(w, h), max(w, h)
        if short < lo or short > hi_short or long_ > hi_long:
            continue
        if a < 0.75 * w * h:  # not a clean rectangle
            continue
        cx, cy = x + w // 2, y + h // 2
        if not inside[cy, cx]:
            continue
        cells[lab == i] = 1
        boxes[i] = (x, y, w, h)
    # Neighbouring cells of one unit are separated by a single stroke.
    gap = scale.ipx(0.25, 3)
    grouped = cv2.dilate(cells, np.ones((gap, gap), np.uint8))
    m, glab, gst, _ = cv2.connectedComponentsWithStats(grouped, 8)
    members: dict[int, list[tuple[int, int, int, int]]] = {}
    for x, y, w, h in boxes.values():
        g = glab[y + h // 2, x + w // 2]
        members.setdefault(int(g), []).append((x, y, w, h))
    out: list[Fixture] = []
    tol = scale.px(0.2)
    for cs in members.values():
        if len(cs) < 2:
            continue
        x0 = min(c[0] for c in cs) - 1
        y0 = min(c[1] for c in cs) - 1
        x1 = max(c[0] + c[2] for c in cs) + 1
        y1 = max(c[1] + c[3] for c in cs) + 1
        cols = _count_lines([c[0] for c in cs], tol)
        rows = _count_lines([c[1] for c in cs], tol)
        # Cells should tile the box; sparse groups are clusters of symbols.
        fill = sum(c[2] * c[3] for c in cs) / max(1.0, (x1 - x0) * (y1 - y0))
        if fill < 0.55:
            continue
        depth = min(np.median([min(c[2], c[3]) for c in cs]), 99999)
        kind = "shelf" if depth <= scale.px(1.0) else "table"
        out.append(
            Fixture(
                kind, float(x0), float(y0), float(x1), float(y1), cols, rows, round(float(fill), 2)
            )
        )
    return out


def detect_rail_blocks(ink: np.ndarray, inside: np.ndarray, scale: PlanScale) -> list[Fixture]:
    """Striped blocks — clothing rails, gondola shelving drawn as many
    short parallel strokes ("comb" symbols). A stripe is a short straight
    stroke (0.6–3 m); a block is ≥ 5 stripes stacked at a tight pitch with
    matching lengths. The block's box is the union of its stripes, so the
    spine and end caps fall inside it (and are masked from walls)."""

    out: list[Fixture] = []
    k_short, k_long = scale.ipx(0.6, 5), scale.ipx(3.0, 20)
    pitch = scale.px(0.6)
    for o in ("h", "v"):
        ks = (1, k_short) if o == "h" else (k_short, 1)
        kl = (1, k_long) if o == "h" else (k_long, 1)
        stripes = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones(ks, np.uint8))
        longs = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones(kl, np.uint8))
        stripes = stripes & (1 - longs) & inside
        n, _, st, _ = cv2.connectedComponentsWithStats(stripes, 4)
        segs = []
        for i in range(1, n):
            x, y, w, h, _a = st[i]
            thick = h if o == "h" else w
            if thick > scale.px(0.2):
                continue
            segs.append((x, y, w, h))
        # Group stripes: same span (start/end within 0.3 m), stacked at ≤ pitch.
        segs.sort(key=lambda r: (r[1], r[0]) if o == "h" else (r[0], r[1]))
        groups: list[list[tuple[int, int, int, int]]] = []
        tol = scale.px(0.6)  # comb symbols alternate long and short teeth
        for r in segs:
            a0, a1 = (r[0], r[0] + r[2]) if o == "h" else (r[1], r[1] + r[3])
            pos = r[1] if o == "h" else r[0]
            for g in groups:
                q = g[-1]
                b0, b1 = (q[0], q[0] + q[2]) if o == "h" else (q[1], q[1] + q[3])
                qpos = q[1] if o == "h" else q[0]
                if 0 < pos - qpos <= pitch and abs(a0 - b0) <= tol and abs(a1 - b1) <= tol:
                    g.append(r)
                    break
            else:
                groups.append([r])
        for g in groups:
            if len(g) < 5:
                continue
            x0 = min(r[0] for r in g)
            y0 = min(r[1] for r in g)
            x1 = max(r[0] + r[2] for r in g)
            y1 = max(r[1] + r[3] for r in g)
            long_m = max(x1 - x0, y1 - y0) * scale.m
            along = max(1, round(long_m / 1.4))
            across = 2 if min(x1 - x0, y1 - y0) * scale.m >= 1.2 else 1
            cols, rows = (across, along) if (y1 - y0) >= (x1 - x0) else (along, across)
            out.append(
                Fixture(
                    "rail",
                    float(x0),
                    float(y0),
                    float(x1),
                    float(y1),
                    cols,
                    rows,
                    round(min(1.0, len(g) / 20), 2),
                )
            )
    return _merge_overlapping(out, scale.px(0.35))


def _merge_overlapping(fs: list[Fixture], gap: float = 1.0) -> list[Fixture]:
    """Comb symbols split by their spine come back as two groups side by
    side; join boxes that intersect or sit within `gap` of each other."""

    changed = True
    while changed:
        changed = False
        for i, a in enumerate(fs):
            for j in range(i + 1, len(fs)):
                b = fs[j]
                if (
                    a.x0 <= b.x1 + gap
                    and b.x0 <= a.x1 + gap
                    and a.y0 <= b.y1 + gap
                    and b.y0 <= a.y1 + gap
                ):
                    fs[i] = Fixture(
                        "rail",
                        min(a.x0, b.x0),
                        min(a.y0, b.y0),
                        max(a.x1, b.x1),
                        max(a.y1, b.y1),
                        max(a.cols, b.cols),
                        max(a.rows, b.rows),
                        max(a.score, b.score),
                    )
                    del fs[j]
                    changed = True
                    break
            if changed:
                break
    return fs


def _iou(a: tuple, b: tuple) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def _dedupe(fs: list[Fixture]) -> list[Fixture]:
    out: list[Fixture] = []
    for f in sorted(fs, key=lambda f: -(f.x1 - f.x0) * (f.y1 - f.y0)):
        if any(_iou(f.bbox, g.bbox) > 0.3 for g in out):
            continue
        out.append(f)
    return out


def merge_back_to_back(fs: list[Fixture], scale: PlanScale) -> list[Fixture]:
    """A double-sided gondola is drawn as two bay columns either side of a
    spine; join halves that share their extent and almost touch."""

    tol, gap = scale.px(0.3), scale.px(0.4)
    changed = True
    while changed:
        changed = False
        for i, a in enumerate(fs):
            for j, b in enumerate(fs):
                if i >= j or a.kind != b.kind:
                    continue
                side = (
                    abs(a.y0 - b.y0) <= tol
                    and abs(a.y1 - b.y1) <= tol
                    and -tol <= max(b.x0 - a.x1, a.x0 - b.x1) <= gap
                )
                stack = (
                    abs(a.x0 - b.x0) <= tol
                    and abs(a.x1 - b.x1) <= tol
                    and -tol <= max(b.y0 - a.y1, a.y0 - b.y1) <= gap
                )
                if side or stack:
                    fs[i] = Fixture(
                        a.kind,
                        min(a.x0, b.x0),
                        min(a.y0, b.y0),
                        max(a.x1, b.x1),
                        max(a.y1, b.y1),
                        a.cols + b.cols if side else max(a.cols, b.cols),
                        max(a.rows, b.rows) if side else a.rows + b.rows,
                        round((a.score + b.score) / 2, 2),
                    )
                    del fs[j]
                    changed = True
                    break
            if changed:
                break
    return fs


def detect_fixtures(ink: np.ndarray, inside: np.ndarray, scale: PlanScale) -> list[Fixture]:
    bays = merge_back_to_back(detect_bay_fixtures(ink, inside, scale), scale)
    rails = [
        r
        for r in detect_rail_blocks(ink, inside, scale)
        if not any(_iou(r.bbox, b.bbox) > 0.2 for b in bays)
    ]
    return bays + rails


def fixture_mask(shape: tuple[int, int], fixtures: list[Fixture], pad: int) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    for f in fixtures:
        cv2.rectangle(
            m, (int(f.x0) - pad, int(f.y0) - pad), (int(f.x1) + pad, int(f.y1) + pad), 1, -1
        )
    return m
