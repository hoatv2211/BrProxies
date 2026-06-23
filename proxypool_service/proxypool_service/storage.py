from __future__ import annotations

from redis import Redis

from .models import ProxyRecord, normalize_proxy


ALL_KEY = "proxypool:all"
HTTPS_KEY = "proxypool:https"
META_PREFIX = "proxypool:meta:"


class ProxyStorage:
    def __init__(self, redis: Redis):
        self.redis = redis

    def _meta_key(self, proxy: str) -> str:
        return f"{META_PREFIX}{normalize_proxy(proxy)}"

    def ping(self) -> bool:
        return bool(self.redis.ping())

    def save(self, record: ProxyRecord) -> None:
        pipe = self.redis.pipeline()
        pipe.sadd(ALL_KEY, record.proxy)
        if record.supports_https:
            pipe.sadd(HTTPS_KEY, record.proxy)
        else:
            pipe.srem(HTTPS_KEY, record.proxy)
        hash_items = [item for pair in record.to_hash().items() for item in pair]
        pipe.execute_command("HMSET", self._meta_key(record.proxy), *hash_items)
        pipe.execute()

    def get(self, proxy: str) -> ProxyRecord | None:
        proxy = normalize_proxy(proxy)
        data = self.redis.hgetall(self._meta_key(proxy))
        if not data:
            return None
        data.setdefault("proxy", proxy)
        return ProxyRecord.from_hash(data)

    def list(self, https: bool = False) -> list[ProxyRecord]:
        key = HTTPS_KEY if https else ALL_KEY
        proxies = sorted(self.redis.smembers(key))
        records: list[ProxyRecord] = []
        for proxy in proxies:
            record = self.get(proxy)
            if record is not None:
                records.append(record)
        return records

    def count(self, https: bool = False) -> int:
        return int(self.redis.scard(HTTPS_KEY if https else ALL_KEY))

    def random(self, https: bool = False) -> ProxyRecord | None:
        proxy = self.redis.srandmember(HTTPS_KEY if https else ALL_KEY)
        return self.get(proxy) if proxy else None

    def pop(self, https: bool = False) -> ProxyRecord | None:
        record = self.random(https=https)
        if record is not None:
            self.delete(record.proxy)
        return record

    def delete(self, proxy: str) -> bool:
        proxy = normalize_proxy(proxy)
        pipe = self.redis.pipeline()
        pipe.srem(ALL_KEY, proxy)
        pipe.srem(HTTPS_KEY, proxy)
        pipe.delete(self._meta_key(proxy))
        removed_all, _removed_https, _removed_meta = pipe.execute()
        return bool(removed_all)

    def clean(self) -> dict[str, int]:
        all_proxies = set(self.redis.smembers(ALL_KEY))
        https_proxies = set(self.redis.smembers(HTTPS_KEY))
        meta_keys = set(self.redis.scan_iter(f"{META_PREFIX}*"))
        proxy_count = len(all_proxies | https_proxies | {key[len(META_PREFIX):] for key in meta_keys})

        set_keys = [key for key in (ALL_KEY, HTTPS_KEY) if self.redis.exists(key)]
        keys = [*set_keys, *sorted(meta_keys)]
        if keys:
            self.redis.delete(*keys)

        return {
            "proxies": proxy_count,
            "meta": len(meta_keys),
            "keys": len(keys),
            "removed": proxy_count,
        }
