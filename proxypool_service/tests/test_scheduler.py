import fakeredis

from proxypool_service.config import ProxyPoolConfig
from proxypool_service.models import ProxyRecord
from proxypool_service.scheduler import ProxyPoolRuntime
from proxypool_service.storage import ProxyStorage


async def test_check_once_preserves_existing_country(monkeypatch):
    async def fake_check(candidate, _config):
        return ProxyRecord(
            proxy=candidate.proxy,
            supports_https=True,
            latency_ms=10,
            source=candidate.source,
            country=candidate.country,
        )

    monkeypatch.setattr("proxypool_service.scheduler.check_candidate", fake_check)
    storage = ProxyStorage(fakeredis.FakeRedis(decode_responses=True))
    storage.save(ProxyRecord(proxy="1.2.3.4:8080", supports_https=True, latency_ms=20, source="unit", country="US"))
    runtime = ProxyPoolRuntime(ProxyPoolConfig(), storage)

    await runtime.check_once()

    assert storage.list()[0].country == "US"
