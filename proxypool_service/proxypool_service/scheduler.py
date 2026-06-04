from __future__ import annotations

import logging
import asyncio

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .checker import check_candidate
from .config import ProxyPoolConfig
from .models import ProxyCandidate
from .sources import collect_candidates_with_report
from .storage import ProxyStorage

logger = logging.getLogger("proxypool_service")


class ProxyPoolRuntime:
    def __init__(self, config: ProxyPoolConfig, storage: ProxyStorage):
        self.config = config
        self.storage = storage
        self.scheduler = AsyncIOScheduler()
        self.last_collect: dict[str, object] | None = None
        self.last_check: dict[str, int] | None = None

    async def collect_once(self) -> dict[str, int]:
        logger.info("ProxyPool collect started")
        report = await collect_candidates_with_report(self.config)
        candidates = report.candidates
        for err in report.errors:
            logger.warning("ProxyPool source failed: %s %s", err.id, err.error)
        logger.info("ProxyPool collected %s candidates", len(candidates))
        saved = 0
        checked = 0

        semaphore = asyncio.Semaphore(self.config.max_concurrency)

        async def run_one(candidate: ProxyCandidate):
            async with semaphore:
                return await check_candidate(candidate, self.config)

        tasks = [asyncio.create_task(run_one(candidate)) for candidate in candidates]
        for task in asyncio.as_completed(tasks):
            checked += 1
            record = await task
            if record is None:
                continue
            self.storage.save(record)
            saved += 1
            logger.info("ProxyPool saved working proxy %s (%s/%s checked)", record.proxy, checked, len(candidates))
            self.last_collect = {
                "candidates": len(candidates),
                "checked": checked,
                "saved": saved,
                "source_errors": [{"id": err.id, "url": err.url, "error": err.error} for err in report.errors],
            }
        logger.info("ProxyPool checked %s candidates, %s working", len(candidates), saved)
        result = {
            "candidates": len(candidates),
            "checked": checked,
            "saved": saved,
            "source_errors": [{"id": err.id, "url": err.url, "error": err.error} for err in report.errors],
        }
        self.last_collect = result
        logger.info("ProxyPool collect finished: %s", result)
        return result

    async def check_once(self) -> dict[str, int]:
        logger.info("ProxyPool recheck started")
        records = self.storage.list()
        checked = 0
        removed = 0
        kept = 0
        for old in records:
            checked += 1
            candidate = ProxyCandidate(proxy=old.proxy, source=old.source, country=old.country)
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
        logger.info("ProxyPool recheck finished: %s", result)
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
