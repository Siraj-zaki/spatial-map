"""CLI: `python -m aiworker.pipeline <image path>`.

Runs the full pipeline on a local file and prints the raw result JSON
to stdout. No Go / Dramatiq / MinIO needed — pure smoke test for
iterating on the pipeline itself.

Example:

    docker exec sgv-ai-worker \\
        python -m aiworker.pipeline /app/samples/mall.jpg > out.json
"""

from __future__ import annotations

import json
import sys

from aiworker.pipeline.run import detect_from_path


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: python -m aiworker.pipeline <image path>", file=sys.stderr)
        return 2
    result = detect_from_path(argv[1])
    print(json.dumps(result, indent=2))
    detections = result.get("detections", [])
    by_kind: dict[str, int] = {}
    for det in detections:
        kind = det.get("kind", "?")
        by_kind[kind] = by_kind.get(kind, 0) + 1
    print(
        f"\n# {len(detections)} detections "
        f"({', '.join(f'{k}={v}' for k, v in sorted(by_kind.items()))})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
