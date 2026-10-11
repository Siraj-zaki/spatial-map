"""Env-driven configuration.

Reads the same `SGV_<SECTION>.<KEY>` env-var convention the Go backend
uses (see `backend/internal/config/config.go`). Python doesn't share
bash's dot-notation restriction — `os.environ.get("SGV_STORAGE.MINIO_ENDPOINT")`
returns the value fine when the process was launched with it in-scope
(docker-compose, `env "K=V" cmd`, or the Go binary's own dotenv loader
that ships alongside).

Every setting has a docker-network default that "just works" when the
worker is brought up via `docker compose up ai-worker`. Overrides for
local `uv run` dev live in the caller's shell.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class StorageConfig:
    """Points at the same MinIO bucket the Go backend uses. Reusing the
    exact env var names + defaults means a single .env keeps both
    services aligned."""

    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    use_ssl: bool


@dataclass(frozen=True)
class RedisConfig:
    """Redis is the Dramatiq broker. Single URL is enough — no
    per-connection tuning needed at Phase 1 scale."""

    url: str


@dataclass(frozen=True)
class WorkerConfig:
    """FastAPI bind + graceful-shutdown knobs. Kept minimal on purpose
    — every extra field is another thing that can drift out of sync
    with the Go side's expectations."""

    host: str
    port: int


@dataclass(frozen=True)
class Config:
    storage: StorageConfig
    redis: RedisConfig
    worker: WorkerConfig


def _env(key: str, default: str) -> str:
    """os.environ.get with a required default. Kept as a helper so the
    config module stays declarative — one line per setting, no
    conditionals sprinkled around."""

    value = os.environ.get(key, default)
    return value if value is not None else default


def _bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"true", "1", "yes", "on"}


def load_config() -> Config:
    """Snapshot the environment once at process boot. Called from
    `main.py` before FastAPI starts routing so a bad config fails the
    container's healthcheck immediately rather than 500ing on the first
    real request."""

    return Config(
        storage=StorageConfig(
            # `sgv-minio:9000` is the docker-compose service DNS name +
            # port. Overridden to `localhost:9000` for `uv run` dev.
            endpoint=_env("SGV_STORAGE.MINIO_ENDPOINT", "sgv-minio:9000"),
            access_key=_env("SGV_STORAGE.MINIO_ACCESS_KEY", "minioadmin"),
            secret_key=_env("SGV_STORAGE.MINIO_SECRET_KEY", "minioadmin"),
            bucket=_env("SGV_STORAGE.MINIO_BUCKET", "sgv-uploads"),
            use_ssl=_bool("SGV_STORAGE.MINIO_USE_SSL", False),
        ),
        redis=RedisConfig(
            url=_env("SGV_REDIS.URL", "redis://sgv-redis:6379/0"),
        ),
        worker=WorkerConfig(
            host=_env("SGV_AI_WORKER.HOST", "0.0.0.0"),
            port=int(_env("SGV_AI_WORKER.PORT", "8100")),
        ),
    )
