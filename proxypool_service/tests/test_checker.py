import httpx
import pytest

from proxypool_service.checker import check_candidate, check_candidates
from proxypool_service.config import ProxyPoolConfig
from proxypool_service.models import ProxyCandidate


@pytest.mark.asyncio
async def test_check_candidate_returns_https_record(monkeypatch):
    async def fake_get(self, url):
        return httpx.Response(200)

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    record = await check_candidate(ProxyCandidate("1.2.3.4:8080", "unit"), ProxyPoolConfig())

    assert record is not None
    assert record.proxy == "1.2.3.4:8080"
    assert record.supports_https is True
    assert record.latency_ms >= 1


@pytest.mark.asyncio
async def test_check_candidate_returns_http_only_record(monkeypatch):
    async def fake_get(self, url):
        if url.startswith("https://"):
            raise httpx.ConnectError("no tunnel")
        return httpx.Response(200)

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    record = await check_candidate(ProxyCandidate("1.2.3.4:8080", "unit"), ProxyPoolConfig())

    assert record is not None
    assert record.supports_https is False


@pytest.mark.asyncio
async def test_check_candidate_returns_none_when_all_probes_fail(monkeypatch):
    async def fake_get(self, url):
        raise httpx.ConnectError("dead")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    record = await check_candidate(ProxyCandidate("1.2.3.4:8080", "unit"), ProxyPoolConfig())

    assert record is None


@pytest.mark.asyncio
async def test_check_candidates_filters_dead_proxies(monkeypatch):
    async def fake_get(self, url):
        return httpx.Response(200)

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    records = await check_candidates(
        [ProxyCandidate("1.2.3.4:8080", "unit"), ProxyCandidate("5.6.7.8:3128", "unit")],
        ProxyPoolConfig(max_concurrency=1),
    )
    assert [record.proxy for record in records] == ["1.2.3.4:8080", "5.6.7.8:3128"]

