"""Detection pipeline: image bytes + placement -> GeoJSON FeatureCollection.

Modules composed top-down:
    run.detect(bytes, placement, region?)   orchestrator entry point
      |-> segment.generate_masks(image)      SAM 2 automatic mask generation
      |-> classify.classify_masks(masks)     heuristic {wall, room, ...}
      |-> vectorize.masks_to_polygons(...)   OpenCV contours + Shapely simplify
      |-> reproject.pixel_to_lnglat(...)     per-vertex projection to Mapbox coords
      \\-> GeoJSON.FeatureCollection

Each stage is independently testable — the coord math + vectorization
paths have unit tests that don't need torch/SAM loaded. The full-stack
verification (docker exec ai-worker python -m aiworker.pipeline <path>)
is the runtime gate.
"""
