from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .checker import check_candidate, check_candidates
from .config import ProxyPoolConfig
from .models import ProxyCandidate
from .sources import collect_candidates
from .storage import ProxyStorage


class ProxyPoolRuntime:
    def __init__(self, config: ProxyPoolConfig, storage: ProxyStorage):
        self.config = config
        self.storage = storage
        self.scheduler = AsyncIOScheduler()
        self.last_collect: dict[str, int] | None = None
        self.last_check: dict[str, int] | None = None

    async def collect_once(self) -> dict[str, int]:
        candidates = await collect_candidates(self.config)
        records = await check_candidates(candidates, self.config)
        for record in records:
            self.storage.save(record)
        result = {"candidates": len(candidates), "saved": len(records)}
        self.last_collect = result
        return result

    async def check_once(self) -> dict[str, int]:
        records = self.storage.list()
        checked = 0
        removed = 0
        kept = 0
        for old in records:
            checked += 1
            candidate = ProxyCandidate(proxy=old.proxy, source=old.source)
            fresh = await check_candidate(candidate, self.config)
            if fresh is None:
                old.fail_count += 1
                if old.fail_count >= self.config.failure_threshold:
                    self.storage.delete(old.proxy)
                    removed += 1
                else:
                    self.storage.save(old)
                continue
            fresh.fail_count = 0
            self.storage.save(fresh)
            kept += 1
        result = {"checked": checked, "kept": kept, "removed": removed}
        self.last_check = result
        return result

    def start_scheduler(self) -> None:
        if self.scheduler.running:
            return
        self.scheduler.add_job(self.collect_once, "interval", seconds=self.config.collect_interval_seconds, id="collect", replace_existing=True)
        self.scheduler.add_job(self.check_once, "interval", seconds=self.config.check_interval_seconds, id="check", replace_existing=True)
        self.scheduler.start()

    def stop_scheduler(self) -> None:
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)

