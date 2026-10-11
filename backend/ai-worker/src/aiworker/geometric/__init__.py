"""Geometric floor-plan detector — deterministic CV on drafting conventions.

Where the SAM pipeline (`aiworker.pipeline`) segments *regions*, this
package measures *strokes*, because that is where a line drawing keeps
its information:

  - walls   thick straight strokes (single or double-lined)
  - doors   a quarter-circle swing arc hinged on a wall
  - racks   outlined boxes divided into equal bays, or striped rail blocks
  - rooms   faces of the wall graph once door gaps are bridged

Every threshold is expressed in METRES and converted with the plan's own
scale (`PlanScale`), so the same detector works at any drawing scale.

Stages run in dependency order — fixtures first (so their outlines are
not mistaken for walls), then walls, then doors (only accepted on walls),
then rooms (from walls + doors). Output is geometry in plan pixels plus
lng/lat, meant to be reviewed before it becomes shapes.

Entry points:
  detect_geometry(image, placement)        → dict of detections
  python -m aiworker.geometric <image> [--gt gt.json] [--overlay out.png]
"""

from aiworker.geometric.run import detect_geometry

__all__ = ["detect_geometry"]
