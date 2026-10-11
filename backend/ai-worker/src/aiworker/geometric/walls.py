"""Walls: thick straight strokes → clean centre-line segments.

1. Axis-aligned stroke runs (raster.stroke_runs), inside the building,
   outside fixtures.
2. Double-lined walls (two parallel strokes a wall-thickness apart) merge
   into one centre line whose thickness is the spread.
3. Collinear pieces split by columns or junction blobs join up.
4. Short leftovers that touch nothing are dropped.
5. Ends snap onto the perpendicular wall they nearly meet (L / T joints).

Door gaps are bridged later (`bridge_door_gaps`), once doors confirm them.
Diagonal walls are not detected yet — the corpus is orthogonal.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

from aiworker.geometric.raster import Run, stroke_runs
from aiworker.geometric.scale import PlanScale


@dataclass
class Wall:
    o: str  # 'h' | 'v'
    c: float  # centre line (y for 'h', x for 'v')
    a: float  # start along the axis
    b: float  # end along the axis
    t: float  # thickness, px

    @property
    def length(self) -> float:
        return self.b - self.a

    def endpoints(self) -> tuple[tuple[float, float], tuple[float, float]]:
        return Run(self.o, self.c, self.a, self.b, self.t).endpoints()


def _frac_in(mask: np.ndarray, r: Run, step: float = 2.0) -> float:
    (x0, y0), (x1, y1) = r.endpoints()
    n = max(2, int(r.length / step))
    xs = np.clip(np.linspace(x0, x1, n).round().astype(int), 0, mask.shape[1] - 1)
    ys = np.clip(np.linspace(y0, y1, n).round().astype(int), 0, mask.shape[0] - 1)
    return float(mask[ys, xs].mean())


def _merge_parallel(runs: list[Run], max_spread: float) -> list[Wall]:
    """Pair strokes of a double-lined wall. Two runs merge when they are
    parallel, within `max_spread` of each other and overlap along most of
    the shorter one."""

    walls = [Wall(r.o, r.c, r.a, r.b, r.t) for r in runs]
    changed = True
    while changed:
        changed = False
        walls.sort(key=lambda w: (w.o, w.c))
        out: list[Wall] = []
        used = [False] * len(walls)
        for i, w in enumerate(walls):
            if used[i]:
                continue
            for j in range(i + 1, len(walls)):
                v = walls[j]
                if used[j] or v.o != w.o:
                    continue
                if v.c - w.c > max_spread:
                    break
                ov = min(w.b, v.b) - max(w.a, v.a)
                if ov < 0.6 * min(w.length, v.length):
                    continue
                lo = min(w.c - w.t / 2, v.c - v.t / 2)
                hi = max(w.c + w.t / 2, v.c + v.t / 2)
                w = Wall(w.o, (lo + hi) / 2, min(w.a, v.a), max(w.b, v.b), hi - lo)
                used[j] = True
                changed = True
            out.append(w)
        walls = out
    return walls


def _join_collinear(walls: list[Wall], c_tol: float, gap: float) -> list[Wall]:
    changed = True
    while changed:
        changed = False
        walls.sort(key=lambda w: (w.o, w.a))
        out: list[Wall] = []
        for w in walls:
            for k, u in enumerate(out):
                if u.o == w.o and abs(u.c - w.c) <= c_tol and w.a - u.b <= gap and u.a - w.b <= gap:
                    L1, L2 = u.length, w.length
                    out[k] = Wall(
                        u.o,
                        (u.c * L1 + w.c * L2) / max(L1 + L2, 1e-6),
                        min(u.a, w.a),
                        max(u.b, w.b),
                        max(u.t, w.t),
                    )
                    changed = True
                    break
            else:
                out.append(w)
        walls = out
    return walls


def _snap(walls: list[Wall], tol: float) -> list[Wall]:
    """Extend or trim each end onto a perpendicular wall it nearly meets."""

    out = []
    for w in walls:
        a, b = w.a, w.b
        for p in walls:
            if p.o == w.o:
                continue
            # p crosses w's axis at position p.c; w must lie within p's extent.
            if not (p.a - tol <= w.c <= p.b + tol):
                continue
            if abs(a - p.c) <= tol:
                a = p.c
            if abs(b - p.c) <= tol:
                b = p.c
        out.append(replace(w, a=min(a, b), b=max(a, b)))
    return out


def _touches(w: Wall, others: list[Wall], tol: float) -> bool:
    for p in others:
        if p is w:
            continue
        if p.o == w.o:
            if abs(p.c - w.c) <= tol and (abs(p.a - w.b) <= tol or abs(w.a - p.b) <= tol):
                return True
            continue
        if p.a - tol <= w.c <= p.b + tol and (w.a - tol <= p.c <= w.b + tol):
            return True
    return False


def detect_walls(
    ink: np.ndarray, inside: np.ndarray, blocked: np.ndarray, scale: PlanScale
) -> list[Wall]:
    """`inside`: building mask; `blocked`: fixture mask (strokes mostly
    inside it are fixture outlines, not walls)."""

    min_thick = max(2, scale.ipx(0.15))
    runs = stroke_runs(ink, min_len=scale.ipx(0.4, 5), min_thick=min_thick)
    runs = [r for r in runs if _frac_in(inside, r) > 0.8 and _frac_in(blocked, r) < 0.5]
    walls = _merge_parallel(runs, max_spread=scale.px(0.45))
    walls = _join_collinear(walls, c_tol=scale.px(0.15), gap=scale.px(0.35))
    walls = _snap(walls, tol=scale.px(0.4))
    walls = _join_collinear(walls, c_tol=scale.px(0.15), gap=scale.px(0.05))
    keep = []
    for w in walls:
        if w.length >= scale.px(1.2) or (
            w.length >= scale.px(0.35) and _touches(w, walls, scale.px(0.3))
        ):
            keep.append(w)
    return keep


def bridge_door_gaps(
    walls: list[Wall],
    openings: list[tuple[tuple[float, float], tuple[float, float]]],
    scale: PlanScale,
) -> list[Wall]:
    """Join two collinear walls across a gap that a detected door spans,
    so the wall is continuous and the door cuts its opening (the way the
    editor models doors). `openings` are door (v0, v1) pairs in pixels."""

    tol_c = scale.px(0.25)
    changed = True
    while changed:
        changed = False
        for i, u in enumerate(walls):
            for j, w in enumerate(walls):
                if i == j or u.o != w.o or abs(u.c - w.c) > tol_c or not (u.b <= w.a):
                    continue
                g0, g1 = u.b, w.a
                if g1 - g0 > scale.px(4.0):
                    continue
                for v0, v1 in openings:
                    if u.o == "h":
                        across = abs((v0[1] + v1[1]) / 2 - u.c)
                        lo, hi = sorted((v0[0], v1[0]))
                    else:
                        across = abs((v0[0] + v1[0]) / 2 - u.c)
                        lo, hi = sorted((v0[1], v1[1]))
                    if across > scale.px(0.4):
                        continue
                    cover = max(0.0, min(hi, g1) - max(lo, g0))
                    if (
                        cover >= 0.6 * (g1 - g0)
                        or (g1 - g0) <= (hi - lo) + scale.px(0.4)
                        and cover > 0
                    ):
                        walls[i] = Wall(u.o, (u.c + w.c) / 2, u.a, w.b, max(u.t, w.t))
                        del walls[j]
                        changed = True
                        break
                if changed:
                    break
            if changed:
                break
    return walls
