"""Classify raw SAM masks into semantic classes.

SAM 2 has no domain knowledge — it emits promiscuous masks (whole
building silhouette, background, walls, rooms, individual tiles).
Our job is a fast heuristic pass that tags each candidate mask with
one of five semantic kinds; downstream filters drop BACKGROUND and
UNKNOWN before emission.

Heuristic rules (all in normalized bbox terms so image size doesn't
matter):

  BACKGROUND     mask covers >= 60% of image
  WALL           long + thin + low fill (aspect >= 6, density <= 0.35)
  DOOR           tiny + squarish + arc-like fill (area < 0.5%, aspect 1-3, density 0.2-0.6)
  STAIR          medium rectangle with high internal density
                 (area 0.3-3%, aspect 1.5-4, density >= 0.65)
  ROOM           closed medium-large polygon, moderate density
                 (area 0.5-40%, density >= 0.55)
  UNKNOWN        anything else (dropped)

Door + stair rules match the "small + arc" and "boxed + regular"
patterns that SAM tends to trace on architectural drawings. They are
deliberately CONSERVATIVE — a fine-tuned YOLO (Phase 3.5+) would be
the strict upgrade if verification shows too many misses.

The API is pure functions on VectorizedShape so tests don't need SAM.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum

from shapely.geometry import Polygon

from aiworker.pipeline.vectorize import VectorizedShape


class Kind(StrEnum):
    """Classifier output. Values are the strings the frontend's
    ai-accept.ts already keys on (aisle / area / door / stair)."""

    WALL = "aisle"           # long thin polygons → committed as line shapes
    ROOM = "area"            # closed polygons → committed as polygon shapes
    DOOR = "door"            # small blob → committed as door (jamb line)
    STAIR = "stair"          # medium rectangle → committed as stair
    BACKGROUND = "background"  # dropped
    UNKNOWN = "unknown"        # dropped


@dataclass(frozen=True)
class Classified:
    """A vectorized shape + its semantic tag + an optional human-
    readable label (attached later by the fusion.attach_labels pass
    when Tesseract finds a room name inside the polygon)."""

    shape: VectorizedShape
    kind: Kind
    confidence: float
    label: str = ""


# ---- Threshold constants ----
# Kept as module-level so a Phase 3.5 hyperparameter sweep can grid-
# search these without touching the function body.

_BACKGROUND_AREA_FRAC = 0.60
# Wall aspect lowered 6→4 so short segments (residential interior
# walls run 3-5 m; long-side/short-side aspect ~4-6) still qualify.
# At 6.0 only long exterior runs were caught.
_WALL_ASPECT_RATIO = 4.0
_WALL_MAX_FILL_DENSITY = 0.35

_DOOR_MAX_AREA_FRAC = 0.005      # < 0.5% of image
_DOOR_MIN_AREA_FRAC = 1e-5       # avoid pure noise sneaking in
_DOOR_MIN_ASPECT = 1.0
_DOOR_MAX_ASPECT = 3.0
_DOOR_MIN_FILL = 0.20
# Door fill relaxed 0.60→0.75 so doors drawn as filled rectangles
# (common in modern CAD) qualify alongside the classic arc-swing
# symbol. 0.75 stops rectangles from being mistaken for stair treads.
_DOOR_MAX_FILL = 0.75

_STAIR_MIN_AREA_FRAC = 0.003     # 0.3% (bigger than a door)
_STAIR_MAX_AREA_FRAC = 0.03      # < 3%
_STAIR_MIN_ASPECT = 1.5
_STAIR_MAX_ASPECT = 5.0
_STAIR_MIN_FILL = 0.65           # stair bounding boxes are near-fully filled

# Room min area lowered 0.005→0.001 so small enclosed spaces
# (closets, powder rooms, WICs typically 0.1-0.3% of the image)
# still classify as rooms. Below this SAM masks are usually
# noise (label backgrounds, tiny fragments).
_ROOM_MIN_AREA_FRAC = 0.001
# Room max area raised 0.40→0.60 so a big verandah or garage that
# happens to span half the plan still classifies as a room instead
# of falling through to UNKNOWN.
_ROOM_MAX_AREA_FRAC = 0.60
# Room fill density lowered 0.55→0.35 so L-shaped rooms, octagonal
# rooms with cutaway corners, and thick-walled bathrooms qualify.
# 0.55 was rectilinear-only — a rectangle-with-cut-corner is ~0.83
# but an L-shape is ~0.5 and octagonal-with-fat-walls can be ~0.4.
_ROOM_MIN_FILL_DENSITY = 0.35


def classify_masks(
    shapes: list[VectorizedShape],
    image_width: int,
    image_height: int,
) -> list[Classified]:
    """Tag each vectorized shape with a Kind + heuristic confidence
    score in [0, 1]. Callers filter out BACKGROUND / UNKNOWN before
    emitting the final FeatureCollection."""

    if image_width <= 0 or image_height <= 0:
        return []
    total_area = float(image_width * image_height)
    return [_classify_one(s, total_area) for s in shapes]


def _classify_one(shape: VectorizedShape, image_area: float) -> Classified:
    area_frac = shape.area_pixels / image_area
    if area_frac >= _BACKGROUND_AREA_FRAC:
        return Classified(shape=shape, kind=Kind.BACKGROUND, confidence=0.99)

    aspect = _aspect_ratio(shape.polygon)
    fill_density = _fill_density(shape.polygon)

    # Walls first: long + thin + low fill. Cheapest match to compute
    # and false-negatives here can still land as ROOM below, so
    # ordering doesn't cost recall.
    if aspect >= _WALL_ASPECT_RATIO and fill_density <= _WALL_MAX_FILL_DENSITY:
        conf = min(1.0, 0.5 + (aspect - _WALL_ASPECT_RATIO) / 20.0)
        return Classified(shape=shape, kind=Kind.WALL, confidence=conf)

    # Doors: small + squarish + partially-filled bbox (arc leaves
    # empty space). Deliberately narrow so we don't misclassify a
    # small room or a decorative symbol.
    if (
        _DOOR_MIN_AREA_FRAC <= area_frac <= _DOOR_MAX_AREA_FRAC
        and _DOOR_MIN_ASPECT <= aspect <= _DOOR_MAX_ASPECT
        and _DOOR_MIN_FILL <= fill_density <= _DOOR_MAX_FILL
    ):
        # Confidence: peaks at ~0.3 fill (typical arc), falls off
        # towards 0.6 (getting rectangular = probably not a door).
        conf = 0.6 - abs(fill_density - 0.35)
        return Classified(shape=shape, kind=Kind.DOOR, confidence=max(0.3, conf))

    # Stairs: medium box, well-filled (parallel treads make the
    # bbox appear dense to SAM). This heuristic will miss stairs
    # SAM traces as multiple thin masks — that failure mode is a
    # candidate for Phase 3.5 improvement.
    if (
        _STAIR_MIN_AREA_FRAC <= area_frac <= _STAIR_MAX_AREA_FRAC
        and _STAIR_MIN_ASPECT <= aspect <= _STAIR_MAX_ASPECT
        and fill_density >= _STAIR_MIN_FILL
    ):
        conf = min(1.0, 0.5 + fill_density * 0.4)
        return Classified(shape=shape, kind=Kind.STAIR, confidence=conf)

    # Rooms: sensibly-sized, mostly convex, well-filled.
    if (
        _ROOM_MIN_AREA_FRAC <= area_frac <= _ROOM_MAX_AREA_FRAC
        and fill_density >= _ROOM_MIN_FILL_DENSITY
    ):
        conf = min(1.0, 0.5 + fill_density * 0.5)
        return Classified(shape=shape, kind=Kind.ROOM, confidence=conf)

    return Classified(shape=shape, kind=Kind.UNKNOWN, confidence=0.3)


def with_label(c: Classified, label: str) -> Classified:
    """Return a copy of Classified with `label` set. Used by
    fusion.attach_labels — Classified is frozen so we replace()."""

    return replace(c, label=label)


def _aspect_ratio(polygon: Polygon) -> float:
    """Long side / short side of the axis-aligned bbox. Uses the AA
    bbox (not the minimum-rotated one) because architectural walls
    are almost always drawing-aligned."""

    min_x, min_y, max_x, max_y = polygon.bounds
    w = max(1e-9, max_x - min_x)
    h = max(1e-9, max_y - min_y)
    return max(w, h) / min(w, h)


def _fill_density(polygon: Polygon) -> float:
    """Polygon area / bbox area. 1.0 = perfect rectangle, ~0.5 =
    triangle, ~0.1 = thin diagonal wall segment. Cheap proxy for
    "how rectilinear" a shape is."""

    min_x, min_y, max_x, max_y = polygon.bounds
    bbox = max(1e-9, (max_x - min_x) * (max_y - min_y))
    return polygon.area / bbox
