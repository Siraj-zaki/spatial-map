"""Score detections against a ground-truth layout (both in plan pixels).

Ground-truth JSON (one plan):
    {"walls": [{"pts": [[x, y], ...]}], "doors": [{"pts": [[x, y], [x, y]], "kind": ...}],
     "racks": [{"bbox": [x0, y0, x1, y1]}], "rooms": [{"pts": [[x, y], ...], "name": ...}]}

Metrics
  walls  length-based: recall = share of GT wall length near a detected
         wall, precision = share of detected length near GT; "near" is
         0.25 m + half the detected wall's thickness
  doors  greedy match by opening midpoint (≤ 0.8 m); width error; kind accuracy
  racks  greedy match by bbox IoU ≥ 0.5
  rooms  greedy match by polygon IoU ≥ 0.5
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union


def _samples(lines: list[list[list[float]]], step: float) -> np.ndarray:
    pts = []
    for ln in lines:
        for a, b in zip(ln, ln[1:], strict=False):
            L = math.dist(a, b)
            n = max(1, int(L / step))
            for k in range(n):
                t = (k + 0.5) / n
                pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return np.array(pts) if pts else np.zeros((0, 2))


def _near(
    points: np.ndarray, lines: list[list[list[float]]], tol: float | list[float]
) -> np.ndarray:
    if len(points) == 0:
        return np.zeros(0, bool)
    tols = tol if isinstance(tol, list) else [tol] * len(lines)
    geom = unary_union(
        [LineString(ln).buffer(t) for ln, t in zip(lines, tols, strict=True) if len(ln) >= 2]
    )
    from shapely import contains_xy

    return contains_xy(geom, points[:, 0], points[:, 1])


def _f1(p: float, r: float) -> float:
    return 2 * p * r / (p + r) if p + r else 0.0


def evaluate(det: dict[str, Any], gt: dict[str, Any], m_per_px: float) -> dict[str, Any]:
    px = lambda metres: metres / m_per_px  # noqa: E731
    out: dict[str, Any] = {}

    gl = [w["pts"] for w in gt.get("walls", [])]
    dl = [w["px"] for w in det.get("walls", [])]
    step, tol = px(0.25), px(0.35)
    # Tolerance grows with the detected wall's thickness: a ground-truth
    # line may follow either face of a thick wall, the detector its centre.
    dtol = [px(0.25 + w.get("thickness_m", 0.0) / 2) for w in det.get("walls", [])]
    gs, ds = _samples(gl, step), _samples(dl, step)
    rec = float(_near(gs, dl, dtol).mean()) if len(gs) and dl else 0.0
    # Length-weighted: share of all detected wall samples that lie near GT.
    near_d = (
        [_near(_samples([ln], step), gl, t) for ln, t in zip(dl, dtol, strict=True)] if gl else []
    )
    total = sum(len(n) for n in near_d)
    prec = sum(int(n.sum()) for n in near_d) / total if total else 0.0
    out["walls"] = {
        "precision": round(prec, 3),
        "recall": round(rec, 3),
        "f1": round(_f1(prec, rec), 3),
        "gt_length_m": round(len(gs) * 0.25, 1),
        "det_length_m": round(len(ds) * 0.25, 1),
    }

    gd = gt.get("doors", [])
    dd = list(det.get("doors", []))
    mid = lambda p: ((p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2)  # noqa: E731
    used: set[int] = set()
    matched, werr, kinds = [], [], 0
    for g in gd:
        gm, best, bi = mid(g["pts"]), px(0.8), -1
        for i, d in enumerate(dd):
            if i in used:
                continue
            dist = math.dist(gm, mid(d["px"]))
            if dist < best:
                best, bi = dist, i
        if bi >= 0:
            used.add(bi)
            d = dd[bi]
            matched.append(g)
            werr.append(abs(math.dist(*d["px"]) - math.dist(*g["pts"])) * m_per_px)
            kinds += int((g.get("kind") or "single") == d["kind"])
    tp = len(matched)
    p = tp / len(dd) if dd else 0.0
    r = tp / len(gd) if gd else 0.0
    out["doors"] = {
        "precision": round(p, 3),
        "recall": round(r, 3),
        "f1": round(_f1(p, r), 3),
        "gt": len(gd),
        "det": len(dd),
        "tp": tp,
        "mean_width_err_m": round(float(np.mean(werr)), 2) if werr else None,
        "kind_accuracy": round(kinds / tp, 3) if tp else None,
    }

    out["racks"] = _match_polys(
        [box(*g["bbox"]) for g in gt.get("racks", [])],
        [box(*d["bbox_px"]) for d in det.get("racks", [])],
    )
    gr = [Polygon(g["pts"]) for g in gt.get("rooms", []) if len(g["pts"]) >= 3]
    dr = [Polygon(d["px"]) for d in det.get("rooms", []) if len(d["px"]) >= 3]
    out["rooms"] = _match_polys([g.buffer(0) for g in gr], [d.buffer(0) for d in dr])
    # Enclosed rooms only: GT rooms whose outline is ≥ 75% on GT walls.
    # Open-floor departments separated only by printed labels can't be
    # found from geometry; they are reported separately so the number
    # above isn't read as a detector failure.
    if gl and gr:
        enclosed = []
        for g in gr:
            ring = [list(c) for c in g.exterior.coords]
            pts = _samples([ring], step)
            if len(pts) and _near(pts, gl, tol).mean() >= 0.75:
                enclosed.append(g.buffer(0))
        out["rooms_enclosed"] = _match_polys(enclosed, [d.buffer(0) for d in dr])
    return out


def _match_polys(gt: list, det: list, thr: float = 0.5) -> dict[str, Any]:
    used: set[int] = set()
    tp, ious = 0, []
    for g in gt:
        best, bi = thr, -1
        for i, d in enumerate(det):
            if i in used or not g.intersects(d):
                continue
            inter = g.intersection(d).area
            iou = inter / (g.area + d.area - inter) if inter else 0.0
            if iou >= best:
                best, bi = iou, i
        if bi >= 0:
            used.add(bi)
            tp += 1
            ious.append(best)
    p = tp / len(det) if det else 0.0
    r = tp / len(gt) if gt else 0.0
    return {
        "precision": round(p, 3),
        "recall": round(r, 3),
        "f1": round(_f1(p, r), 3),
        "gt": len(gt),
        "det": len(det),
        "tp": tp,
        "mean_iou": round(float(np.mean(ious)), 3) if ious else None,
    }
