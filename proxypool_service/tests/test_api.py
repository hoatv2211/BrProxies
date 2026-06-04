import fakeredis
from fastapi.testclient import TestClient

from proxypool_service.api import create_app
from proxypool_service.config import ProxyPoolConfig
from proxypool_service.models import ProxyRecord
from proxypool_service.storage import ProxyStorage


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

