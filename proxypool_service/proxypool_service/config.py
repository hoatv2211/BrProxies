from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _split_csv(value: str | None) -> set[str]:
    if not value:
        return set()
    return {part.strip() for part in value.split(",") if part.strip()}


@dataclass(slots=True)
class ProxyPoolConfig:
    host: str = "127.0.0.1"
    port: int = 40326
    redis_url: str = "redis://127.0.0.1:6379/0"
    disabled_sources: set[str] = field(default_factory=set)
    collect_interval_seconds: int = 900
    check_interval_seconds: int = 300
    timeout_seconds: float = 8.0
    max_concurrency: int = 50
    failure_threshold: int = 2
    initial_collect: bool = True

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> "ProxyPoolConfig":
        disabled = data.get("disabled_sources", [])
        if isinstance(disabled, str):
            disabled_sources = _split_csv(disabled)
        else:
            disabled_sources = {str(item) for item in disabled}
        return cls(
            host=str(data.get("host", "127.0.0.1")),
            port=int(data.get("port", 40326)),
            redis_url=str(data.get("redis_url", "redis://127.0.0.1:6379/0")),
            disabled_sources=disabled_sources,
            collect_interval_seconds=int(data.get("collect_interval_seconds", 900)),
            check_interval_seconds=int(data.get("check_interval_seconds", 300)),
            timeout_seconds=float(data.get("timeout_seconds", 8.0)),
            max_concurrency=int(data.get("max_concurrency", 50)),
            failure_threshold=int(data.get("failure_threshold", 2)),
            initial_collect=bool(data.get("initial_collect", True)),
        )


def load_config(path: str | None = None) -> ProxyPoolConfig:
    data: dict[str, Any] = {}
    if path:
        cfg_path = Path(path)
        if cfg_path.exists():
            data.update(json.loads(cfg_path.read_text(encoding="utf-8")))

    env_map = {
        "PROXYPOOL_HOST": "host",
        "PROXYPOOL_PORT": "port",
        "PROXYPOOL_REDIS_URL": "redis_url",
        "PROXYPOOL_DISABLED_SOURCES": "disabled_sources",
        "PROXYPOOL_COLLECT_INTERVAL_SECONDS": "collect_interval_seconds",
        "PROXYPOOL_CHECK_INTERVAL_SECONDS": "check_interval_seconds",
        "PROXYPOOL_TIMEOUT_SECONDS": "timeout_seconds",
        "PROXYPOOL_MAX_CONCURRENCY": "max_concurrency",
        "PROXYPOOL_FAILURE_THRESHOLD": "failure_threshold",
        "PROXYPOOL_INITIAL_COLLECT": "initial_collect",
    }
    for env_name, field_name in env_map.items():
        value = os.getenv(env_name)
        if value is not None:
            if field_name == "initial_collect":
                data[field_name] = value.lower() in {"1", "true", "yes", "on"}
            else:
                data[field_name] = value
    return ProxyPoolConfig.from_mapping(data)

