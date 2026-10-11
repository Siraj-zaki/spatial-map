"""Smoke test that the FastAPI app boots and /healthz answers.

Deliberately does NOT test the Dramatiq path — the actor talks to
Redis, which isn't guaranteed to be up in a plain pytest run. The
end-to-end wire (Go enqueue → Python worker → result back) is
verified in Phase 4's integration tests, running inside the compose
stack.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from aiworker import __version__
from aiworker.main import app


def test_healthz_returns_ok_and_version() -> None:
    with TestClient(app) as client:
        response = client.get("/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == __version__
