"""Plan scale: metres per pixel, from the image's placement on the map."""

from __future__ import annotations

import math
from dataclasses import dataclass

METERS_PER_DEG_LAT = 111_320.0


@dataclass(frozen=True)
class PlanScale:
    """Metres per pixel along x and y. Detectors ask for lengths in metres
    via `px()` so thresholds hold at any drawing scale."""

    mx: float
    my: float

    @property
    def m(self) -> float:
        return (self.mx + self.my) / 2

    def px(self, metres: float) -> float:
        return metres / self.m

    def ipx(self, metres: float, minimum: int = 1) -> int:
        return max(minimum, int(round(self.px(metres))))

    @staticmethod
    def from_placement(placement: dict, width: int, height: int) -> PlanScale:
        """`placement` uses the images-row convention: startLng/startLat
        and currentLng/currentLat are opposite corners of the unrotated
        image. Falls back to 5 cm/px (a typical 1:500 scan) when absent."""

        try:
            sx, sy = float(placement["startLng"]), float(placement["startLat"])
            cx, cy = float(placement["currentLng"]), float(placement["currentLat"])
        except (KeyError, TypeError, ValueError):
            return PlanScale(0.05, 0.05)
        mid = math.radians((sy + cy) / 2)
        wm = abs(cx - sx) * METERS_PER_DEG_LAT * math.cos(mid)
        hm = abs(cy - sy) * METERS_PER_DEG_LAT
        if wm <= 0 or hm <= 0:
            return PlanScale(0.05, 0.05)
        return PlanScale(wm / width, hm / height)
