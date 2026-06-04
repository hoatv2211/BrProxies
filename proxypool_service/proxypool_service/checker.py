from __future__ import annotations

import asyncio
from time import perf_counter

import httpx

from .config import ProxyPoolConfig
from .models import ProxyCandidate, ProxyRecord


HTTP_TEST_URL = "http://httpbin.org/ip"
HTTPS_TEST_URL = "https://httpbin.org/ip"


async def check_candidate(candidate: ProxyCandidate, config: ProxyPoolConfig) -> ProxyRecord | None:
    proxy_url = f"http://{candidate.proxy}"
    timeout = httpx.Timeout(config.timeout_seconds)
    started = perf_counter()
    try:
        async with httpx.AsyncClient(proxy=proxy_url, timeout=timeout, follow_redirects=False) as client:
            http_ok = await _probe(client, HTTP_TEST_URL)
            https_ok = await _probe(client, HTTPS_TEST_URL)
    except Exception:
        return None
    if not http_ok and not https_ok:
        return None
    latency_ms = max(1, int((perf_counter() - started) * 1000))
    return ProxyRecord(
        proxy=candidate.proxy,
        supports_https=https_ok,
        latency_ms=latency_ms,
        source=candidate.source,
    )


async def check_candidates(candidates: list[ProxyCandidate], config: ProxyPoolConfig) -> list[ProxyRecord]:
    semaphore = asyncio.Semaphore(config.max_concurrency)

    async def run_one(candidate: ProxyCandidate) -> ProxyRecord | None:
        async with semaphore:
            return await check_candidate(candidate, config)

    results = await asyncio.gather(*(run_one(candidate) for candidate in candidates))
    return [record for record in results if record is not None]


async def _probe(client: httpx.AsyncClient, url: str) -> bool:
    try:
        response = await client.get(url)
        return 200 <= response.status_code < 400
    except Exception:
        return False

