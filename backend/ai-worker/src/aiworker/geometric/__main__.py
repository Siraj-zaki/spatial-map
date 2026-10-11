"""CLI: `python -m aiworker.geometric <image> [options]`

--placement JSON   image placement (startLng/startLat/currentLng/currentLat);
                   defaults to 5 cm/px when omitted
--gt FILE          ground-truth JSON → prints scores (see evaluate.py)
--overlay FILE     PNG with detections drawn over the plan
--out FILE         write detections JSON (default: stdout summary only)
--no-ocr           skip room-name OCR
--review DIR       write the review package (numbered crops + questions);
                   with ANTHROPIC_API_KEY set, also asks the model and
                   scores the reviewed result
"""

from __future__ import annotations

import argparse
import json
import sys

import cv2
import numpy as np

from aiworker.geometric.evaluate import evaluate
from aiworker.geometric.run import detect_geometry


def draw_overlay(path_in: str, det: dict, path_out: str, gt: dict | None = None) -> None:
    img = cv2.imread(path_in)
    ov = img.copy()
    for r in det["rooms"]:
        cv2.fillPoly(ov, [np.array(r["px"], np.int32)], (120, 200, 255))
    img = cv2.addWeighted(ov, 0.25, img, 0.75, 0)
    if gt:  # ground truth faintly underneath, for spotting misses
        for w in gt.get("walls", []):
            cv2.polylines(img, [np.array(w["pts"], np.int32)], False, (0, 200, 255), 7)
    for f in det["racks"]:
        x0, y0, x1, y1 = map(int, f["bbox_px"])
        cv2.rectangle(
            img, (x0, y0), (x1, y1), (200, 0, 160) if f["kind"] == "rail" else (255, 80, 0), 2
        )
    for w in det["walls"]:
        (a, b) = w["px"]
        cv2.line(img, tuple(map(int, a)), tuple(map(int, b)), (0, 0, 230), 3)
    for d in det["doors"]:
        a, b = (tuple(map(int, p)) for p in d["px"])
        cv2.line(img, a, b, (0, 170, 0), 6)
        cv2.line(img, a, tuple(map(int, d["open_px"])), (0, 170, 0), 2)
    for r in det["rooms"]:
        if r["labels"]:
            xs, ys = zip(*r["px"], strict=True)
            cv2.putText(
                img,
                r["labels"][0][:22],
                (int(np.mean(xs)) - 40, int(np.mean(ys))),
                0,
                0.5,
                (90, 0, 90),
                2,
            )
    cv2.imwrite(path_out, img)


def _load(path: str):
    with open(path) as fh:
        return json.load(fh)


def _dump(obj, path: str) -> None:
    with open(path, "w") as fh:
        json.dump(obj, fh, indent=1)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="python -m aiworker.geometric")
    ap.add_argument("image")
    ap.add_argument("--placement")
    ap.add_argument("--gt")
    ap.add_argument("--overlay")
    ap.add_argument("--out")
    ap.add_argument("--no-ocr", action="store_true")
    ap.add_argument("--review")
    a = ap.parse_args(argv[1:])
    gt = _load(a.gt) if a.gt else None
    placement = json.loads(a.placement) if a.placement else {}
    if not placement and gt and "image" in gt:
        (sx, sy), (cx, cy) = gt["image"]["start"], gt["image"]["current"]
        placement = {"startLng": sx, "startLat": sy, "currentLng": cx, "currentLat": cy}
    with open(a.image, "rb") as fh:
        det = detect_geometry(fh.read(), placement, ocr=not a.no_ocr)
    counts = {k: len(det[k]) for k in ("walls", "doors", "racks", "rooms")}
    print(f"# {a.image}: {counts}  ({det['image']['m_per_px']} m/px)", file=sys.stderr)
    if a.out:
        _dump(det, a.out)
    if a.overlay:
        draw_overlay(a.image, det, a.overlay, gt)
    if a.review:
        from aiworker.geometric.review import apply_answers, ask_model, build_review

        pkg = build_review(cv2.imread(a.image), det)
        pkg.to_dir(a.review)
        print(f"# review package: {len(pkg.tiles)} crops in {a.review}", file=sys.stderr)
        answers = ask_model(pkg)
        if answers:
            _dump(answers, f"{a.review}/answers.json")
            det = apply_answers(det, answers)
    if gt:
        print(json.dumps(evaluate(det, gt, det["image"]["m_per_px"]), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
