import fakeredis

from proxypool_service.models import ProxyRecord
from proxypool_service.storage import ProxyStorage


def test_save_list_count_random_and_delete_proxy():
    redis = fakeredis.FakeRedis(decode_responses=True)
    storage = ProxyStorage(redis)
    record = ProxyRecord(proxy="1.2.3.4:8080", supports_https=True, latency_ms=123, source="unit")

    storage.save(record)

    assert storage.count() == 1
    assert storage.count(https=True) == 1
    assert storage.list(https=True)[0].proxy == "1.2.3.4:8080"
    assert storage.random(https=True).proxy == "1.2.3.4:8080"

    assert storage.delete("1.2.3.4:8080") is True
    assert storage.count() == 0
    assert storage.random() is None


def test_pop_removes_proxy_from_all_sets():
    redis = fakeredis.FakeRedis(decode_responses=True)
    storage = ProxyStorage(redis)
    storage.save(ProxyRecord(proxy="5.6.7.8:3128", supports_https=True, latency_ms=80, source="unit"))

    popped = storage.pop(https=True)

    assert popped is not None
    assert popped.proxy == "5.6.7.8:3128"
    assert storage.count() == 0
    assert storage.count(https=True) == 0


def test_normalizes_url_forms_on_delete():
    redis = fakeredis.FakeRedis(decode_responses=True)
    storage = ProxyStorage(redis)
    storage.save(ProxyRecord(proxy="http://8.8.8.8:8080/", supports_https=False, latency_ms=55, source="unit"))

    assert storage.count() == 1
    assert storage.delete("http://8.8.8.8:8080") is True
    assert storage.count() == 0

def test_clean_removes_cached_proxy_entries():
    redis = fakeredis.FakeRedis(decode_responses=True)
    storage = ProxyStorage(redis)
    storage.save(ProxyRecord(proxy="1.2.3.4:8080", supports_https=True, latency_ms=55, source="unit"))
    redis.sadd("proxypool:all", "2.2.2.2:8080")
    redis.sadd("proxypool:https", "2.2.2.2:8080")
    redis.hset("proxypool:meta:3.3.3.3:8080", mapping={"proxy": "3.3.3.3:8080"})

    result = storage.clean()

    assert result == {"proxies": 3, "meta": 2, "keys": 4, "removed": 3}
    assert storage.count() == 0
    assert storage.count(https=True) == 0
    assert storage.get("1.2.3.4:8080") is None
    assert redis.exists("proxypool:meta:3.3.3.3:8080") == 0
