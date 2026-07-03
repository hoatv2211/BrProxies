from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlparse

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
    parser_name: str = "custom"
    custom: bool = False

@dataclass(frozen=True, slots=True)
class SourceError:
    id: str
    url: str
    error: str

@dataclass(frozen=True, slots=True)
class CollectReport:
    candidates: list[ProxyCandidate]
    errors: list[SourceError]


def _candidate(host: str, port: str, source: str, country: str = "") -> ProxyCandidate | None:
    host = host.strip()
    port = port.strip()
    country = country.strip().upper()
    if not host or not port.isdigit():
        return None
    return ProxyCandidate(proxy=normalize_proxy(f"{host}:{port}"), source=source, country=country)


def parse_table(body: str, source: str) -> list[ProxyCandidate]:
    soup = BeautifulSoup(body, "lxml")
    candidates: list[ProxyCandidate] = []
    for row in soup.select("table tbody tr"):
        cells = [cell.get_text(strip=True) for cell in row.find_all("td")]
        if len(cells) < 2:
            continue
        country = cells[2] if len(cells) > 2 else ""
        candidate = _candidate(cells[0], cells[1], source, country)
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
        country = str(item.get("country", ""))
        candidate = _candidate(host, port, source, country)
        if candidate is not None:
            candidates.append(candidate)
    return _dedupe(candidates)


PARSERS: dict[str, Parser] = {
    "text": parse_plain_text,
    "plain_text": parse_plain_text,
    "table": parse_table,
    "geonode_json": parse_geonode_json,
}

BUILTIN_SOURCES: dict[str, SourceSpec] = {
    "free_proxy_list": SourceSpec("free_proxy_list", "https://free-proxy-list.net/", parse_table, "table"),
    "ssl_proxies": SourceSpec("ssl_proxies", "https://www.sslproxies.org/", parse_table, "table"),
    "us_proxy": SourceSpec("us_proxy", "https://www.us-proxy.org/", parse_table, "table"),
    "proxy_scrape": SourceSpec(
        "proxy_scrape",
        "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
        parse_plain_text,
        "text",
    ),
    "geonode_free": SourceSpec(
        "geonode_free",
        "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps",
        parse_geonode_json,
        "geonode_json",
    ),
}

def make_custom_source(data: dict[str, str]) -> SourceSpec:
    source_id = str(data.get("id", "")).strip()
    url = str(data.get("url", "")).strip()
    parser_name = str(data.get("parser", "text")).strip() or "text"
    if not re.fullmatch(r"[A-Za-z0-9_-]{2,64}", source_id):
        raise ValueError("source id must be 2-64 chars: letters, numbers, underscore, dash")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("source url must start with http:// or https://")
    parser = PARSERS.get(parser_name)
    if parser is None:
        raise ValueError(f"unsupported parser: {parser_name}")
    return SourceSpec(source_id, url, parser, parser_name, custom=True)

def custom_sources(config: ProxyPoolConfig) -> list[SourceSpec]:
    return [make_custom_source(item) for item in config.custom_sources]

def all_sources(config: ProxyPoolConfig) -> list[SourceSpec]:
    return list(BUILTIN_SOURCES.values()) + custom_sources(config)


def enabled_sources(config: ProxyPoolConfig) -> list[SourceSpec]:
    return [spec for spec in all_sources(config) if spec.id not in config.disabled_sources]


def source_status(config: ProxyPoolConfig) -> list[dict[str, object]]:
    return [
        {
            "id": spec.id,
            "url": spec.url,
            "parser": spec.parser_name,
            "enabled": spec.id not in config.disabled_sources,
            "custom": spec.custom,
        }
        for spec in all_sources(config)
    ]

def add_custom_source(config: ProxyPoolConfig, data: dict[str, str]) -> dict[str, object]:
    spec = make_custom_source(data)
    if spec.id in BUILTIN_SOURCES:
        raise ValueError("source id already used by built-in source")
    config.custom_sources = [item for item in config.custom_sources if item.get("id") != spec.id]
    config.custom_sources.append({"id": spec.id, "url": spec.url, "parser": spec.parser_name})
    return {"id": spec.id, "url": spec.url, "parser": spec.parser_name, "enabled": spec.id not in config.disabled_sources, "custom": True}


async def collect_candidates_with_report(config: ProxyPoolConfig) -> CollectReport:
    timeout = httpx.Timeout(config.timeout_seconds)
    headers = {"User-Agent": "BrProxies-ProxyPool/0.1"}
    candidates: list[ProxyCandidate] = []
    errors: list[SourceError] = []
    async with httpx.AsyncClient(timeout=timeout, headers=headers, follow_redirects=True) as client:
        for spec in enabled_sources(config):
            try:
                response = await client.get(spec.url)
                response.raise_for_status()
                candidates.extend(spec.parser(response.text, spec.id))
            except Exception as exc:
                errors.append(SourceError(id=spec.id, url=spec.url, error=f"{type(exc).__name__}: {exc}"))
    return CollectReport(candidates=_dedupe(candidates), errors=errors)

async def collect_candidates(config: ProxyPoolConfig) -> list[ProxyCandidate]:
    return (await collect_candidates_with_report(config)).candidates


def _dedupe(candidates: list[ProxyCandidate]) -> list[ProxyCandidate]:
    seen: set[str] = set()
    out: list[ProxyCandidate] = []
    for candidate in candidates:
        if candidate.proxy in seen:
            continue
        seen.add(candidate.proxy)
        out.append(candidate)
    return out
