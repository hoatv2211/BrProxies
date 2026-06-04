from __future__ import annotations

from dataclasses import dataclass
from time import time


@dataclass(slots=True, frozen=True)
class ProxyCandidate:
    proxy: str
    source: str


@dataclass(slots=True)
class ProxyRecord:
    proxy: str
    supports_https: bool
    latency_ms: int
    source: str
    last_checked: float = 0.0
    fail_count: int = 0

    def __post_init__(self) -> None:
        self.proxy = normalize_proxy(self.proxy)
        if self.last_checked == 0.0:
            self.last_checked = time()

    @property
    def http_url(self) -> str:
        return f"http://{self.proxy}"

    @property
    def https_url(self) -> str | None:
        return f"http://{self.proxy}" if self.supports_https else None

    def to_hash(self) -> dict[str, str]:
        return {
            "proxy": self.proxy,
            "supports_https": "1" if self.supports_https else "0",
            "latency_ms": str(int(self.latency_ms)),
            "source": self.source,
            "last_checked": str(float(self.last_checked)),
            "fail_count": str(int(self.fail_count)),
        }

    @classmethod
    def from_hash(cls, data: dict[str, str]) -> "ProxyRecord":
        return cls(
            proxy=data["proxy"],
            supports_https=data.get("supports_https") == "1",
            latency_ms=int(float(data.get("latency_ms", "0"))),
            source=data.get("source", "unknown"),
            last_checked=float(data.get("last_checked", "0") or 0),
            fail_count=int(data.get("fail_count", "0") or 0),
        )


def normalize_proxy(value: str) -> str:
    proxy = value.strip()
    if "://" in proxy:
        proxy = proxy.split("://", 1)[1]
    proxy = proxy.rstrip("/")
    return proxy


def record_to_response(record: ProxyRecord) -> dict[str, object]:
    return {
        "proxy": record.proxy,
        "http": record.http_url,
        "https": record.https_url,
        "supports_https": record.supports_https,
        "latency_ms": record.latency_ms,
        "source": record.source,
        "last_checked": record.last_checked,
        "fail_count": record.fail_count,
    }

