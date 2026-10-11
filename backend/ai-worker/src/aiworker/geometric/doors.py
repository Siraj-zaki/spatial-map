"""Doors: quarter-circle swing arcs hinged on a wall.

A drafted door is a leaf line plus an arc of radius = leaf width. We
remove straight strokes so only curves remain, fit a circle to each
curve, and keep it when the drafting convention holds:

  - radius 0.6–2.4 m and a clean fit
  - the arc sweeps 55–120°
  - the circle centre (hinge) sits on a detected wall
  - one arc end lies on that wall's line (the closed position) and the
    other stands off it (the open position, which gives the swing side)

Mirrored arcs whose tips meet become a double door.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from aiworker.geometric.scale import PlanScale
from aiworker.geometric.walls import Wall


@dataclass
class Door:
    kind: str  # 'single' | 'double'
    v0: tuple[float, float]  # hinge (single) or first hinge (double)
    v1: tuple[float, float]  # closed tip (single) or second hinge (double)
    open_pt: tuple[float, float]  # a point on the swing side
    wall: int  # index into the wall list
    score: float


def _fit_circle(pts: np.ndarray) -> tuple[float, float, float, float]:
    A = np.c_[2 * pts, np.ones(len(pts))]
    b = (pts**2).sum(1)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = sol[0], sol[1]
    r = math.sqrt(max(sol[2] + cx * cx + cy * cy, 0.0))
    res = float(np.abs(np.hypot(pts[:, 0] - cx, pts[:, 1] - cy) - r).mean())
    return float(cx), float(cy), r, res


def _nearest_wall(
    p: tuple[float, float], walls: list[Wall]
) -> tuple[float, int, tuple[float, float]]:
    best = (math.inf, -1, p)
    for i, w in enumerate(walls):
        q = (min(max(p[0], w.a), w.b), w.c) if w.o == "h" else (w.c, min(max(p[1], w.a), w.b))
        d = math.dist(p, q)
        if d < best[0]:
            best = (d, i, q)
    return best


def _ink_along(ink: np.ndarray, a: tuple[float, float], b: tuple[float, float]) -> float:
    """Share of samples on the middle 70% of segment a→b with ink within 2 px."""

    n = max(8, int(math.dist(a, b)))
    hits = 0
    total = 0
    for k in range(n):
        t = 0.15 + 0.7 * k / (n - 1)
        x = a[0] + (b[0] - a[0]) * t
        y = a[1] + (b[1] - a[1]) * t
        xi, yi = int(round(x)), int(round(y))
        if 0 < xi < ink.shape[1] - 1 and 0 < yi < ink.shape[0] - 1:
            hits += int(ink[yi - 2 : yi + 3, xi - 2 : xi + 3].max())
            total += 1
    return hits / total if total else 0.0


def _door_wall(
    hinge: tuple[float, float], end: tuple[float, float], walls: list, tol: float
) -> tuple[float, int] | None:
    """Best wall for a door whose closed tip is `end`: the wall runs in the
    hinge→tip direction, passes the hinge (the hinge sits at the jamb, i.e.
    a wall end) and continues BEHIND it — a leaf stroke only runs forward.
    Returns (score, wall index); lower is better."""

    o = "h" if abs(end[0] - hinge[0]) >= abs(end[1] - hinge[1]) else "v"
    best = None
    for i, w in enumerate(walls):
        if w is None or w.o != o:
            continue
        across = abs(hinge[1] - w.c) if o == "h" else abs(hinge[0] - w.c)
        along = hinge[0] if o == "h" else hinge[1]
        if across > tol or not (w.a - tol <= along <= w.b + tol):
            continue
        gap = max(0.0, w.a - along, along - w.b)
        tip = end[0] if o == "h" else end[1]
        behind = (along - w.a) if tip > along else (w.b - along)
        if behind < tol * 0.5:
            continue
        score = across + gap
        if best is None or score < best[0]:
            best = (score, i)
    return best


def _arcs(pts: np.ndarray, r_lo: float, r_hi: float):
    """Circles in one curve component. A clean single arc is fitted
    directly; merged arcs (two leaves touching) are peeled off with
    RANSAC, up to three circles."""

    cx, cy, r, res = _fit_circle(pts)
    if r_lo <= r <= r_hi and res <= max(1.6, 0.06 * r):
        yield pts, (cx, cy, r, res)
        return
    rng = np.random.default_rng(7)
    rest = pts
    for _ in range(3):
        if len(rest) < 12:
            return
        best = None
        for _t in range(200):
            s3 = rest[rng.choice(len(rest), 3, replace=False)]
            try:
                c = _fit_circle(s3)
            except np.linalg.LinAlgError:
                continue
            if not (r_lo <= c[2] <= r_hi):
                continue
            d = np.abs(np.hypot(rest[:, 0] - c[0], rest[:, 1] - c[1]) - c[2])
            inl = d < 1.3
            if best is None or inl.sum() > best[1].sum():
                best = (c, inl)
        if best is None or best[1].sum() < 0.35 * (math.pi / 2) * best[0][2]:
            return
        sub = rest[best[1]]
        yield sub, _fit_circle(sub)
        rest = rest[~best[1]]


def _is_leaf(w: Wall, hinge: tuple[float, float], ends: tuple, r: float, tol: float) -> bool:
    if abs(w.length - r) > 0.35 * r:
        return False
    p, q = w.endpoints()
    for e in ends:
        if (math.dist(p, hinge) < tol and math.dist(q, e) < tol) or (
            math.dist(q, hinge) < tol and math.dist(p, e) < tol
        ):
            return True
    return False


def _arc_to_door(pts, cx, cy, r, res, ink, walls, leaf_walls, scale) -> dict | None:
    if not (scale.px(0.6) <= r <= scale.px(2.4)) or res > max(1.6, 0.06 * r):
        return None
    ang = np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx)
    mid = math.atan2(float(np.sin(ang).mean()), float(np.cos(ang).mean()))
    rel = (ang - mid + math.pi) % (2 * math.pi) - math.pi
    span = math.degrees(float(rel.max() - rel.min()))
    if not (55 <= span <= 120):
        return None
    e1 = (cx + r * math.cos(mid + rel.min()), cy + r * math.sin(mid + rel.min()))
    e2 = (cx + r * math.cos(mid + rel.max()), cy + r * math.sin(mid + rel.max()))
    hinge0 = (cx, cy)
    leaves = {k for k, w in enumerate(walls) if _is_leaf(w, hinge0, (e1, e2), r, scale.px(0.5))}
    leaf_walls |= leaves
    cand = [w if k not in leaves else None for k, w in enumerate(walls)]
    tol = scale.px(0.5)
    p1, p2 = _door_wall(hinge0, e1, cand, tol), _door_wall(hinge0, e2, cand, tol)
    if p1 and p2:
        # Both directions have a wall: the open leaf is drawn as a line,
        # the closed position is the (emptier) opening.
        i1, i2 = _ink_along(ink, hinge0, e1), _ink_along(ink, hinge0, e2)
        if abs(i1 - i2) >= 0.15:
            pick = (p1, e1, e2) if i1 < i2 else (p2, e2, e1)
        else:
            pick = (p1, e1, e2) if p1[0] <= p2[0] else (p2, e2, e1)
    elif p1 or p2:
        pick = (p1, e1, e2) if p1 else (p2, e2, e1)
    else:
        return None
    (_score, wi), closed, opened = pick
    wall = walls[wi]
    if _off_line(opened, wall) < 0.7 * r:
        return None
    hinge = (cx, wall.c) if wall.o == "h" else (wall.c, cy)
    # Width = radius (the leaf length). The arc's own end points are
    # clipped where it runs nearly straight, so they under-measure.
    if wall.o == "h":
        tip = (cx + math.copysign(r, closed[0] - cx), wall.c)
    else:
        tip = (wall.c, cy + math.copysign(r, closed[1] - cy))
    return dict(hinge=hinge, tip=tip, open=opened, wall=wi, r=r, res=res, span=span)


def _off_line(p: tuple[float, float], w: Wall) -> float:
    return abs(p[1] - w.c) if w.o == "h" else abs(p[0] - w.c)


def detect_doors(
    ink: np.ndarray, walls: list[Wall], scale: PlanScale
) -> tuple[list[Door], set[int]]:
    """Returns the doors and the indices of 'walls' that are really door
    leaves (a straight stroke from the hinge to an arc end)."""

    k = scale.ipx(0.5, 5)
    straight = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((1, k), np.uint8)) | cv2.morphologyEx(
        ink, cv2.MORPH_OPEN, np.ones((k, 1), np.uint8)
    )
    curvy = ink & (1 - straight)
    n, lab, st, _ = cv2.connectedComponentsWithStats(curvy, 8)
    r_lo, r_hi = scale.px(0.6), scale.px(2.4)
    singles: list[dict] = []
    leaf_walls: set[int] = set()
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a < 10 or max(w, h) < scale.px(0.5) or max(w, h) > scale.px(3.6):
            continue
        ys, xs = np.nonzero(lab[y : y + h, x : x + w] == i)
        pts = np.stack([xs + x, ys + y], 1).astype(float)
        for sub, (cx, cy, r, res) in _arcs(pts, r_lo, r_hi):
            s1 = _arc_to_door(sub, cx, cy, r, res, ink, walls, leaf_walls, scale)
            if s1:
                singles.append(s1)

    doors: list[Door] = []
    used: set[int] = set()
    for i, s in enumerate(singles):
        if i in used:
            continue
        for j in range(i + 1, len(singles)):
            t = singles[j]
            ws, wt = walls[s["wall"]], walls[t["wall"]]
            if j in used or ws.o != wt.o or abs(ws.c - wt.c) > scale.px(0.3):
                continue
            same_side = _side(s, walls) * _side(t, walls) > 0
            if (
                math.dist(s["tip"], t["tip"]) < scale.px(0.6)
                and abs(s["r"] - t["r"]) < scale.px(0.35)
                and same_side
            ):
                doors.append(
                    Door("double", s["hinge"], t["hinge"], s["open"], s["wall"], _score(s, t))
                )
                used |= {i, j}
                break
        else:
            doors.append(Door("single", s["hinge"], s["tip"], s["open"], s["wall"], _score(s)))
            used.add(i)
    return _dedupe(doors, scale), leaf_walls


def _side(s: dict, walls: list[Wall]) -> float:
    w = walls[s["wall"]]
    return (s["open"][1] - w.c) if w.o == "h" else (s["open"][0] - w.c)


def _score(*arcs: dict) -> float:
    fit = sum(max(0.0, 1.0 - a["res"] / 2.0) for a in arcs) / len(arcs)
    sweep = sum(max(0.0, 1.0 - abs(a["span"] - 90.0) / 45.0) for a in arcs) / len(arcs)
    return round(0.5 * fit + 0.5 * sweep, 3)


def _mid(d: Door) -> tuple[float, float]:
    return ((d.v0[0] + d.v1[0]) / 2, (d.v0[1] + d.v1[1]) / 2)


def _dedupe(doors: list[Door], scale: PlanScale) -> list[Door]:
    out: list[Door] = []
    for d in sorted(doors, key=lambda d: (d.kind != "double", -d.score)):
        m = _mid(d)
        clash = False
        for o in out:
            if math.dist(m, _mid(o)) < scale.px(0.6):
                clash = True
            elif (
                o.kind == "double"
                and d.kind == "single"
                and o.wall == d.wall
                and math.dist(m, _mid(o)) < math.dist(o.v0, o.v1) / 2 + scale.px(0.1)
            ):
                clash = True  # one leaf of an already-found double
        if not clash:
            out.append(d)
    return out
