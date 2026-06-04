import fakeredis
import time
from fastapi.testclient import TestClient

from proxypool_service.api import create_app
from proxypool_service.config import ProxyPoolConfig
from proxypool_service.models import ProxyRecord
from proxypool_service.storage import ProxyStorage

class SlowRuntime:
    def __init__(self, _config, _storage):
        self.scheduler = type("Scheduler", (), {"running": False})()
        self.last_collect = None
        self.last_check = None

    async def collect_once(self):
        import asyncio

        await asyncio.sleep(0.2)
        self.last_collect = {"candidates": 1, "saved": 1}
        return self.last_collect

    async def check_once(self):
        import asyncio

        await asyncio.sleep(0.2)
        self.last_check = {"checked": 1, "kept": 1, "removed": 0}
        return self.last_check

    def start_scheduler(self):
        pass

    def stop_scheduler(self):
        pass


def make_client():
    redis = fakeredis.FakeRedis(decode_responses=True)
    cfg = ProxyPoolConfig(disabled_sources={"us_proxy"})
    app = create_app(cfg, redis=redis, start_scheduler=False)
    return TestClient(app), ProxyStorage(redis)


def test_health_count_and_list_endpoints():
    client, storage = make_client()
    storage.save(ProxyRecord(proxy="1.2.3.4:8080", supports_https=True, latency_ms=123, source="unit"))

    health = client.get("/health").json()
    assert health["ok"] is True
    assert health["count"] == 1
    assert health["https_count"] == 1

    assert client.get("/count").json() == {"count": 1}
    assert client.get("/count?https=true").json() == {"count": 1}
    proxies = client.get("/proxies?https=true").json()
    assert proxies[0]["proxy"] == "1.2.3.4:8080"
    assert proxies[0]["https"] == "http://1.2.3.4:8080"


def test_random_pop_and_delete_endpoints():
    client, storage = make_client()
    storage.save(ProxyRecord(proxy="5.6.7.8:3128", supports_https=False, latency_ms=80, source="unit"))

    assert client.get("/proxy/random").json()["proxy"] == "5.6.7.8:3128"
    assert client.delete("/proxy/5.6.7.8:3128").json() == {"proxy": "5.6.7.8:3128", "deleted": True}
    assert client.get("/proxy/random").status_code == 404

    storage.save(ProxyRecord(proxy="9.9.9.9:8000", supports_https=True, latency_ms=40, source="unit"))
    assert client.get("/proxy/pop?https=true").json()["proxy"] == "9.9.9.9:8000"
    assert storage.count() == 0


def test_sources_endpoint_marks_disabled_sources():
    client, _storage = make_client()
    sources = client.get("/sources").json()
    by_id = {source["id"]: source for source in sources}
    assert by_id["us_proxy"]["enabled"] is False
    assert by_id["free_proxy_list"]["enabled"] is True

def test_sources_endpoint_adds_custom_source():
    client, _storage = make_client()

    response = client.post(
        "/sources",
        json={"id": "my_text", "url": "https://example.test/proxies.txt", "parser": "text"},
    )

    assert response.status_code == 201
    by_id = {source["id"]: source for source in client.get("/sources").json()}
    assert by_id["my_text"] == {
        "id": "my_text",
        "url": "https://example.test/proxies.txt",
        "parser": "text",
        "enabled": True,
        "custom": True,
    }

def test_sources_endpoint_rejects_bad_custom_source():
    client, _storage = make_client()

    response = client.post("/sources", json={"id": "bad id", "url": "ftp://x", "parser": "text"})

    assert response.status_code == 400

def test_collect_job_returns_without_waiting_for_scan(monkeypatch):
    monkeypatch.setattr("proxypool_service.api.ProxyPoolRuntime", SlowRuntime)
    redis = fakeredis.FakeRedis(decode_responses=True)
    app = create_app(ProxyPoolConfig(), redis=redis, start_scheduler=False)
    with TestClient(app) as client:
        started = time.perf_counter()
        response = client.post("/jobs/collect")
        elapsed = time.perf_counter() - started

    assert response.status_code == 202
    assert response.json()["status"] == "started"
    assert elapsed < 0.1
