from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable

import httpx
from bs4 import BeautifulSoup

from .config import ProxyPoolConfig
from .models import ProxyCandidate, normalize_proxy


Parser = Callable[[str, str], list[ProxyCandidate]]


@dataclass(frozen=True, slots=True)
class SourceSpec:
    id: str
    url: str
    parser: Parser


def _candidate(host: str, port: str, source: str) -> ProxyCandidate | None:
    host = host.strip()
    port = port.strip()
    if not host or not port.isdigit():
        return None
    return ProxyCandidate(proxy=normalize_proxy(f"{host}:{port}"), source=source)


def parse_table(body: str, source: str) -> list[ProxyCandidate]:
    soup = BeautifulSoup(body, "lxml")
    candidates: list[ProxyCandidate] = []
    for row in soup.select("table tbody tr"):
        cells = [cell.get_text(strip=True) for cell in row.find_all("td")]
        if len(cells) < 2:
            continue
        candidate = _candidate(cells[0], cells[1], source)
        if candidate is not None:
            candidates.append(candidate)
    return _dedupe(candidates)


def parse_plain_text(body: str, source: str) -> list[ProxyCandidate]:
    candidates = []
    for line in body.splitlines():
        line = normalize_proxy(line)
        if ":" not in line:
            continue
        host, port = line.rsplit(":", 1)
        candidate = _candidate(host, port, source)
        if candidate is not None:
            candidates.append(candidate)
    return _dedupe(candidates)


def parse_geonode_json(body: str, source: str) -> list[ProxyCandidate]:
    payload = json.loads(body)
    rows = payload.get("data", []) if isinstance(payload, dict) else []
    candidates: list[ProxyCandidate] = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        host = str(item.get("ip", ""))
        port = str(item.get("port", ""))
        candidate = _candidate(host, port, source)
        if candidate is not None:
            candidates.append(candidate)
    return _dedupe(candidates)


BUILTIN_SOURCES: dict[str, SourceSpec] = {
    "free_proxy_list": SourceSpec("free_proxy_list", "https://free-proxy-list.net/", parse_table),
    "ssl_proxies": SourceSpec("ssl_proxies", "https://www.sslproxies.org/", parse_table),
    "us_proxy": SourceSpec("us_proxy", "https://www.us-proxy.org/", parse_table),
    "proxy_scrape": SourceSpec(
        "proxy_scrape",
        "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
        parse_plain_text,
    ),
    "geonode_free": SourceSpec(
        "geonode_free",
        "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps",
        parse_geonode_json,
    ),
}


def enabled_sources(config: ProxyPoolConfig) -> list[SourceSpec]:
    return [spec for key, spec in BUILTIN_SOURCES.items() if key not in config.disabled_sources]


def source_status(config: ProxyPoolConfig) -> list[dict[str, object]]:
    return [
        {"id": key, "url": spec.url, "enabled": key not in config.disabled_sources}
        for key, spec in BUILTIN_SOURCES.items()
    ]


async def collect_candidates(config: ProxyPoolConfig) -> list[ProxyCandidate]:
    timeout = httpx.Timeout(config.timeout_seconds)
    headers = {"User-Agent": "ShardX-ProxyPool/0.1"}
    candidates: list[ProxyCandidate] = []
    async with httpx.AsyncClient(timeout=timeout, headers=headers, follow_redirects=True) as client:
        for spec in enabled_sources(config):
            try:
                response = await client.get(spec.url)
                response.raise_for_status()
                candidates.extend(spec.parser(response.text, spec.id))
            except Exception:
                continue
    return _dedupe(candidates)


def _dedupe(candidates: list[ProxyCandidate]) -> list[ProxyCandidate]:
    seen: set[str] = set()
    out: list[ProxyCandidate] = []
    for candidate in candidates:
        if candidate.proxy in seen:
            continue
        seen.add(candidate.proxy)
        out.append(candidate)
    return out

