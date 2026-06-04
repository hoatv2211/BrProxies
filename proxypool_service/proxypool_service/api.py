from __future__ import annotations

import asyncio

from fastapi import FastAPI, HTTPException, Query
from redis import Redis

from .config import ProxyPoolConfig
from .models import record_to_response, normalize_proxy
from .scheduler import ProxyPoolRuntime
from .sources import source_status
from .storage import ProxyStorage


def create_app(config: ProxyPoolConfig, redis: Redis | None = None, start_scheduler: bool = True) -> FastAPI:
    redis_client = redis or Redis.from_url(config.redis_url, decode_responses=True)
    storage = ProxyStorage(redis_client)
    runtime = ProxyPoolRuntime(config, storage)
    app = FastAPI(title="ShardX ProxyPool", version="0.1.0")
    app.state.config = config
    app.state.storage = storage
    app.state.runtime = runtime

    @app.on_event("startup")
    async def on_startup() -> None:
        if start_scheduler:
            runtime.start_scheduler()
            if config.initial_collect:
                asyncio.create_task(runtime.collect_once())

    @app.on_event("shutdown")
    async def on_shutdown() -> None:
        runtime.stop_scheduler()

    @app.get("/health")
    def health() -> dict[str, object]:
        redis_ok = False
        error = None
        try:
            redis_ok = storage.ping()
        except Exception as exc:
            error = str(exc)
        return {
            "ok": redis_ok,
            "redis": "connected" if redis_ok else "error",
            "error": error,
            "count": storage.count() if redis_ok else 0,
            "https_count": storage.count(https=True) if redis_ok else 0,
            "scheduler_running": runtime.scheduler.running,
            "last_collect": runtime.last_collect,
            "last_check": runtime.last_check,
        }

    @app.get("/proxy/random")
    def random_proxy(https: bool = Query(False)) -> dict[str, object]:
        record = storage.random(https=https)
        if record is None:
            raise HTTPException(status_code=404, detail="no proxy available")
        return record_to_response(record)

    @app.get("/proxy/pop")
    def pop_proxy(https: bool = Query(False)) -> dict[str, object]:
        record = storage.pop(https=https)
        if record is None:
            raise HTTPException(status_code=404, detail="no proxy available")
        return record_to_response(record)

    @app.get("/proxies")
    def proxies(https: bool = Query(False)) -> list[dict[str, object]]:
        return [record_to_response(record) for record in storage.list(https=https)]

    @app.get("/count")
    def count(https: bool = Query(False)) -> dict[str, int]:
        return {"count": storage.count(https=https)}

    @app.delete("/proxy/{proxy:path}")
    def delete_proxy(proxy: str) -> dict[str, object]:
        normalized = normalize_proxy(proxy)
        return {"proxy": normalized, "deleted": storage.delete(normalized)}

    @app.get("/sources")
    def sources() -> list[dict[str, object]]:
        return source_status(config)

    @app.post("/jobs/collect")
    async def collect_job() -> dict[str, int]:
        return await runtime.collect_once()

    @app.post("/jobs/check")
    async def check_job() -> dict[str, int]:
        return await runtime.check_once()

    return app

