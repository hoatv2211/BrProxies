# ProxyPool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ProxyPool` sidebar tab that starts a local Python sidecar service, stores validated free proxies in external Redis, and exposes crawler-friendly local API endpoints.

**Architecture:** Implement the proxy pool as a focused Python package under `proxypool_service/`, controlled by new Rust Tauri commands in `src-tauri/src/proxypool.rs`. Add a React page inside existing `src/App.tsx` using current card/table/toast patterns, keeping ProxyPool separate from paid ProxyShard.

**Tech Stack:** Python 3.11+, FastAPI, Uvicorn, APScheduler, redis-py, httpx, BeautifulSoup/lxml, pytest, fakeredis; Tauri 2/Rust; React/TypeScript; Docker Compose with Redis.

---

## File Map

- Create `proxypool_service/pyproject.toml`: Python package metadata, CLI entry point, dev dependencies.
- Create `proxypool_service/proxypool_service/__init__.py`: package marker.
- Create `proxypool_service/proxypool_service/config.py`: config dataclass, defaults, env/file loading.
- Create `proxypool_service/proxypool_service/models.py`: `ProxyCandidate`, `ProxyRecord`, API response models.
- Create `proxypool_service/proxypool_service/storage.py`: Redis adapter.
- Create `proxypool_service/proxypool_service/sources.py`: built-in source registry and parsers.
- Create `proxypool_service/proxypool_service/checker.py`: async proxy validation.
- Create `proxypool_service/proxypool_service/scheduler.py`: collect/check jobs.
- Create `proxypool_service/proxypool_service/api.py`: FastAPI app factory and endpoints.
- Create `proxypool_service/proxypool_service/__main__.py`: CLI commands `serve`, `scheduler`, `sources`.
- Create `proxypool_service/tests/*.py`: Python unit/API tests.
- Create `proxypool_service/Dockerfile`, `proxypool_service/docker-compose.yml`, `proxypool_service/.env.example`.
- Modify `src-tauri/src/store.rs`: add ProxyPool config/log paths.
- Modify `src-tauri/src/settings.rs`: add ProxyPool settings fields with defaults.
- Create `src-tauri/src/proxypool.rs`: sidecar process manager and HTTP helpers.
- Modify `src-tauri/src/lib.rs`: register `proxypool` module and commands.
- Modify `src/App.tsx`: add `ProxyPool` section, types, page, service controls.
- Modify `src/App.css`: add scoped ProxyPool table/status styles only where existing styles are insufficient.
- Modify `.gitignore`: ignore Python venv/cache/build artifacts and ProxyPool logs.

---

### Task 1: Python Package Skeleton And Config

**Files:**
- Create: `proxypool_service/pyproject.toml`
- Create: `proxypool_service/proxypool_service/__init__.py`
- Create: `proxypool_service/proxypool_service/config.py`
- Create: `proxypool_service/tests/test_config.py`

- [ ] **Step 1: Write config tests**

Create `proxypool_service/tests/test_config.py`:

```python
from proxypool_service.config import ProxyPoolConfig, load_config


def test_default_config_values():
    cfg = ProxyPoolConfig()
    assert cfg.host == "127.0.0.1"
    assert cfg.port == 40326
    assert cfg.redis_url == "redis://127.0.0.1:6379/0"
    assert cfg.collect_interval_seconds == 900
    assert cfg.check_interval_seconds == 300
    assert cfg.timeout_seconds == 8.0
    assert cfg.max_concurrency == 50
    assert cfg.failure_threshold == 2
    assert cfg.disabled_sources == set()
    assert cfg.initial_collect is True


def test_load_config_from_json_and_env(tmp_path, monkeypatch):
    path = tmp_path / "proxypool.json"
    path.write_text(
        '{"host":"127.0.0.2","port":41000,"redis_url":"redis://redis:6379/1",'
        '"disabled_sources":["us_proxy"],"initial_collect":false}',
        encoding="utf-8",
    )
    monkeypatch.setenv("PROXYPOOL_PORT", "42000")
    monkeypatch.setenv("PROXYPOOL_DISABLED_SOURCES", "ssl_proxies,geonode_free")
    cfg = load_config(str(path))
    assert cfg.host == "127.0.0.2"
    assert cfg.port == 42000
    assert cfg.redis_url == "redis://redis:6379/1"
    assert cfg.disabled_sources == {"ssl_proxies", "geonode_free"}
    assert cfg.initial_collect is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxypool_service; python -m pytest tests/test_config.py -v`

Expected: FAIL because package/config module does not exist.

- [ ] **Step 3: Add package metadata**

Create `proxypool_service/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=69", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "shardx-proxypool-service"
version = "0.1.0"
description = "Local free public proxy pool service for ShardX Launcher"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115,<1",
  "uvicorn[standard]>=0.30,<1",
  "apscheduler>=3.10,<4",
  "redis>=5,<6",
  "httpx>=0.27,<1",
  "beautifulsoup4>=4.12,<5",
  "lxml>=5,<6",
  "pydantic>=2,<3",
  "python-dotenv>=1,<2",
]

[project.optional-dependencies]
dev = [
  "pytest>=8,<9",
  "pytest-asyncio>=0.23,<1",
  "fakeredis>=2.23,<3",
  "respx>=0.21,<1",
]

[project.scripts]
shardx-proxypool = "proxypool_service.__main__:main"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

Create `proxypool_service/proxypool_service/__init__.py`:

```python
__all__ = ["__version__"]
__version__ = "0.1.0"
```

- [ ] **Step 4: Add config implementation**

Create `proxypool_service/proxypool_service/config.py`:

```python
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _split_csv(value: str | None) -> set[str]:
    if not value:
        return set()
    return {part.strip() for part in value.split(",") if part.strip()}


@dataclass(slots=True)
class ProxyPoolConfig:
    host: str = "127.0.0.1"
    port: int = 40326
    redis_url: str = "redis://127.0.0.1:6379/0"
    disabled_sources: set[str] = field(default_factory=set)
    collect_interval_seconds: int = 900
    check_interval_seconds: int = 300
    timeout_seconds: float = 8.0
    max_concurrency: int = 50
    failure_threshold: int = 2
    initial_collect: bool = True

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> "ProxyPoolConfig":
        disabled = data.get("disabled_sources", [])
        if isinstance(disabled, str):
            disabled_sources = _split_csv(disabled)
        else:
            disabled_sources = {str(item) for item in disabled}
        return cls(
            host=str(data.get("host", cls.host)),
            port=int(data.get("port", cls.port)),
            redis_url=str(data.get("redis_url", cls.redis_url)),
            disabled_sources=disabled_sources,
            collect_interval_seconds=int(data.get("collect_interval_seconds", cls.collect_interval_seconds)),
            check_interval_seconds=int(data.get("check_interval_seconds", cls.check_interval_seconds)),
            timeout_seconds=float(data.get("timeout_seconds", cls.timeout_seconds)),
            max_concurrency=int(data.get("max_concurrency", cls.max_concurrency)),
            failure_threshold=int(data.get("failure_threshold", cls.failure_threshold)),
            initial_collect=bool(data.get("initial_collect", cls.initial_collect)),
        )


def load_config(path: str | None = None) -> ProxyPoolConfig:
    data: dict[str, Any] = {}
    if path:
        cfg_path = Path(path)
        if cfg_path.exists():
            data.update(json.loads(cfg_path.read_text(encoding="utf-8")))

    env_map = {
        "PROXYPOOL_HOST": "host",
        "PROXYPOOL_PORT": "port",
        "PROXYPOOL_REDIS_URL": "redis_url",
        "PROXYPOOL_DISABLED_SOURCES": "disabled_sources",
        "PROXYPOOL_COLLECT_INTERVAL_SECONDS": "collect_interval_seconds",
        "PROXYPOOL_CHECK_INTERVAL_SECONDS": "check_interval_seconds",
        "PROXYPOOL_TIMEOUT_SECONDS": "timeout_seconds",
        "PROXYPOOL_MAX_CONCURRENCY": "max_concurrency",
        "PROXYPOOL_FAILURE_THRESHOLD": "failure_threshold",
        "PROXYPOOL_INITIAL_COLLECT": "initial_collect",
    }
    for env_name, field_name in env_map.items():
        value = os.getenv(env_name)
        if value is not None:
            if field_name == "initial_collect":
                data[field_name] = value.lower() in {"1", "true", "yes", "on"}
            else:
                data[field_name] = value
    return ProxyPoolConfig.from_mapping(data)
```

- [ ] **Step 5: Run config tests**

Run: `cd proxypool_service; python -m pytest tests/test_config.py -v`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add proxypool_service/pyproject.toml proxypool_service/proxypool_service/__init__.py proxypool_service/proxypool_service/config.py proxypool_service/tests/test_config.py
git commit -m "Add ProxyPool service config"
```

---

### Task 2: Models And Redis Storage

**Files:**
- Create: `proxypool_service/proxypool_service/models.py`
- Create: `proxypool_service/proxypool_service/storage.py`
- Create: `proxypool_service/tests/test_storage.py`

- [ ] **Step 1: Write storage tests**

Create `proxypool_service/tests/test_storage.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxypool_service; python -m pytest tests/test_storage.py -v`

Expected: FAIL because models/storage modules do not exist.

- [ ] **Step 3: Add models**

Create `proxypool_service/proxypool_service/models.py`:

```python
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
```

- [ ] **Step 4: Add Redis storage**

Create `proxypool_service/proxypool_service/storage.py`:

```python
from __future__ import annotations

from redis import Redis

from .models import ProxyRecord


ALL_KEY = "proxypool:all"
HTTPS_KEY = "proxypool:https"
META_PREFIX = "proxypool:meta:"


class ProxyStorage:
    def __init__(self, redis: Redis):
        self.redis = redis

    def _meta_key(self, proxy: str) -> str:
        return f"{META_PREFIX}{proxy}"

    def save(self, record: ProxyRecord) -> None:
        pipe = self.redis.pipeline()
        pipe.sadd(ALL_KEY, record.proxy)
        if record.supports_https:
            pipe.sadd(HTTPS_KEY, record.proxy)
        else:
            pipe.srem(HTTPS_KEY, record.proxy)
        pipe.hset(self._meta_key(record.proxy), mapping=record.to_hash())
        pipe.execute()

    def get(self, proxy: str) -> ProxyRecord | None:
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
        pipe = self.redis.pipeline()
        pipe.srem(ALL_KEY, proxy)
        pipe.srem(HTTPS_KEY, proxy)
        pipe.delete(self._meta_key(proxy))
        removed_all, _removed_https, _removed_meta = pipe.execute()
        return bool(removed_all)
```

- [ ] **Step 5: Run storage tests**

Run: `cd proxypool_service; python -m pytest tests/test_storage.py -v`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add proxypool_service/proxypool_service/models.py proxypool_service/proxypool_service/storage.py proxypool_service/tests/test_storage.py
git commit -m "Add ProxyPool Redis storage"
```

---

### Task 3: Collectors And Checker

**Files:**
- Create: `proxypool_service/proxypool_service/sources.py`
- Create: `proxypool_service/proxypool_service/checker.py`
- Create: `proxypool_service/tests/test_sources.py`
- Create: `proxypool_service/tests/test_checker.py`

- [ ] **Step 1: Write source parser tests**

Create tests that parse fixed HTML/text/JSON fixtures without network. Assert source IDs `free_proxy_list`, `ssl_proxies`, `us_proxy`, `proxy_scrape`, `geonode_free` exist and disabled sources are excluded.

- [ ] **Step 2: Implement `sources.py`**

Implement source registry with `SourceSpec(id, url, parser)` and parsers:

```python
BUILTIN_SOURCES = {
    "free_proxy_list": SourceSpec("free_proxy_list", "https://free-proxy-list.net/", parse_table),
    "ssl_proxies": SourceSpec("ssl_proxies", "https://www.sslproxies.org/", parse_table),
    "us_proxy": SourceSpec("us_proxy", "https://www.us-proxy.org/", parse_table),
    "proxy_scrape": SourceSpec("proxy_scrape", "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all", parse_plain_text),
    "geonode_free": SourceSpec("geonode_free", "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps", parse_geonode_json),
}
```

Use `httpx.AsyncClient` with service timeout. Return `ProxyCandidate(proxy="host:port", source=id)` with duplicates removed.

- [ ] **Step 3: Write checker tests**

Use `respx` or monkeypatch `httpx.AsyncClient.get` to assert:

- successful HTTP target returns `ProxyRecord` with `supports_https=False`.
- successful HTTPS target returns `supports_https=True`.
- failed candidate returns `None`.

- [ ] **Step 4: Implement `checker.py`**

Use `asyncio.Semaphore(max_concurrency)`. For each candidate, create proxy URL `http://host:port`. Check `http://httpbin.org/ip` first, then `https://httpbin.org/ip`; use elapsed time for latency. A candidate is valid if HTTP or HTTPS succeeds; `supports_https=True` only if HTTPS succeeds.

- [ ] **Step 5: Run collector/checker tests**

Run: `cd proxypool_service; python -m pytest tests/test_sources.py tests/test_checker.py -v`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add proxypool_service/proxypool_service/sources.py proxypool_service/proxypool_service/checker.py proxypool_service/tests/test_sources.py proxypool_service/tests/test_checker.py
git commit -m "Add ProxyPool collectors and checker"
```

---

### Task 4: Scheduler And FastAPI

**Files:**
- Create: `proxypool_service/proxypool_service/scheduler.py`
- Create: `proxypool_service/proxypool_service/api.py`
- Create: `proxypool_service/proxypool_service/__main__.py`
- Create: `proxypool_service/tests/test_api.py`

- [ ] **Step 1: Write API tests**

Create `test_api.py` with FastAPI `TestClient`, fake Redis, and seeded storage. Verify `/health`, `/count`, `/proxies`, `/proxy/random`, `/proxy/pop`, `DELETE /proxy/{proxy}`, `/sources`.

- [ ] **Step 2: Implement scheduler jobs**

Implement `ProxyPoolRuntime` with methods:

```python
async def collect_once(self) -> dict[str, int]
async def check_once(self) -> dict[str, int]
def start_scheduler(self) -> None
def stop_scheduler(self) -> None
```

`collect_once` fetches candidates from enabled sources, validates them, saves good records. `check_once` revalidates current Redis records and deletes records whose failure count reaches threshold.

- [ ] **Step 3: Implement API app factory**

Implement `create_app(config: ProxyPoolConfig, redis: Redis | None = None) -> FastAPI`. Convert `ProxyRecord` to JSON using:

```python
{
    "proxy": record.proxy,
    "http": record.http_url,
    "https": record.https_url,
    "supports_https": record.supports_https,
    "latency_ms": record.latency_ms,
    "source": record.source,
    "last_checked": record.last_checked,
    "fail_count": record.fail_count,
}
```

- [ ] **Step 4: Implement CLI**

`python -m proxypool_service serve --config path` starts Uvicorn. `scheduler` aliases `serve` because scheduler runs with API. `sources --config path` prints enabled/disabled source IDs.

- [ ] **Step 5: Run API tests**

Run: `cd proxypool_service; python -m pytest tests/test_api.py -v`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add proxypool_service/proxypool_service/scheduler.py proxypool_service/proxypool_service/api.py proxypool_service/proxypool_service/__main__.py proxypool_service/tests/test_api.py
git commit -m "Add ProxyPool API and scheduler"
```

---

### Task 5: Rust Sidecar Commands

**Files:**
- Modify: `src-tauri/src/store.rs`
- Modify: `src-tauri/src/settings.rs`
- Create: `src-tauri/src/proxypool.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add settings fields**

Extend `Settings` with defaults:

```rust
#[serde(default = "default_proxypool_host")]
pub proxypool_host: String,
#[serde(default = "default_proxypool_port")]
pub proxypool_port: u16,
#[serde(default = "default_proxypool_redis_url")]
pub proxypool_redis_url: String,
#[serde(default)]
pub proxypool_disabled_sources: Vec<String>,
#[serde(default = "default_proxypool_collect_interval")]
pub proxypool_collect_interval_seconds: u64,
#[serde(default = "default_proxypool_check_interval")]
pub proxypool_check_interval_seconds: u64,
#[serde(default = "default_proxypool_timeout")]
pub proxypool_timeout_seconds: f64,
#[serde(default = "default_proxypool_concurrency")]
pub proxypool_max_concurrency: u64,
```

Add defaults matching spec. Update `load()` default settings literal.

- [ ] **Step 2: Add store paths**

Add:

```rust
pub fn proxypool_dir() -> Result<PathBuf> {
    let p = config_root()?.join("proxypool");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn proxypool_config_path() -> Result<PathBuf> {
    Ok(proxypool_dir()?.join("config.json"))
}
```

- [ ] **Step 3: Implement process manager**

Create `proxypool.rs` with global `OnceLock<Mutex<Option<Child>>>`. Commands:

```rust
#[tauri::command]
pub async fn proxypool_start() -> Result<ProxyPoolStatus, String>
#[tauri::command]
pub async fn proxypool_stop() -> Result<ProxyPoolStatus, String>
#[tauri::command]
pub async fn proxypool_status() -> Result<ProxyPoolStatus, String>
#[tauri::command]
pub async fn proxypool_health() -> Result<serde_json::Value, String>
#[tauri::command]
pub async fn proxypool_get(path: String) -> Result<serde_json::Value, String>
#[tauri::command]
pub async fn proxypool_delete(proxy: String) -> Result<serde_json::Value, String>
#[tauri::command]
pub async fn proxypool_post(path: String) -> Result<serde_json::Value, String>
```

Write config JSON from settings before spawn. Spawn `python -m proxypool_service serve --config <path>` with `current_dir` set to repo root in dev and `CREATE_NO_WINDOW` on Windows. Health helpers call `http://host:port` with `reqwest`.

- [ ] **Step 4: Register commands**

In `lib.rs`, add `mod proxypool;` and include commands in `tauri::generate_handler!`.

- [ ] **Step 5: Build Rust**

Run: `cd src-tauri; cargo check`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src-tauri/src/store.rs src-tauri/src/settings.rs src-tauri/src/proxypool.rs src-tauri/src/lib.rs
git commit -m "Add ProxyPool sidecar controls"
```

---

### Task 6: React ProxyPool Tab

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Extend frontend types**

Change `Section` to include `"proxypool"`. Extend `Settings` type with ProxyPool fields matching Rust names. Add `ProxyPoolStatus` and `ProxyPoolRecord` types near existing backend types.

- [ ] **Step 2: Add sidebar item**

In `Sidebar`, add `ProxyPool` under `WORKSPACE` with icon using existing inline `Icon` pattern.

- [ ] **Step 3: Add page route**

Add `{section === "proxypool" && <ProxyPoolView />}` near existing section render list.

- [ ] **Step 4: Implement `ProxyPoolView`**

Use existing `Topbar`, `CopyField`, `Field`, `NumField`, `CSSelect`, `toast`, and card styles. Implement functions:

```ts
const refresh = async () => {
  const [settings, status, health, proxies] = await Promise.allSettled([
    invoke<Settings>("settings_get"),
    invoke<ProxyPoolStatus>("proxypool_status"),
    invoke<any>("proxypool_health"),
    invoke<any>("proxypool_get", { path: `/proxies${httpsOnly ? "?https=true" : ""}` }),
  ]);
};
```

Buttons call `proxypool_start`, `proxypool_stop`, `proxypool_post({ path: "/jobs/collect" })`, `proxypool_post({ path: "/jobs/check" })`, and `proxypool_delete({ proxy })`.

- [ ] **Step 5: Save config**

Use `settings_save` with whole settings object, same as `SettingsView`. Disabled sources are edited as comma-separated text and saved as string array.

- [ ] **Step 6: Add minimal CSS**

Add scoped classes: `.pp-page`, `.pp-controls`, `.pp-config-grid`, `.pp-table`, `.pp-source-list`. Reuse existing colors and cards.

- [ ] **Step 7: Build frontend**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/App.tsx src/App.css
git commit -m "Add ProxyPool workspace tab"
```

---

### Task 7: Docker, Docs, Gitignore

**Files:**
- Create: `proxypool_service/Dockerfile`
- Create: `proxypool_service/docker-compose.yml`
- Create: `proxypool_service/.env.example`
- Create: `proxypool_service/README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Add Dockerfile**

Use `python:3.12-slim`, install package, expose `40326`, run `shardx-proxypool serve`.

- [ ] **Step 2: Add compose**

Compose services:

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
  proxypool:
    build: .
    env_file: .env.example
    environment:
      PROXYPOOL_REDIS_URL: redis://redis:6379/0
    ports:
      - "40326:40326"
    depends_on:
      - redis
```

- [ ] **Step 3: Add README**

Document local Python install, Redis requirement, CLI commands, API endpoints, and Docker Compose.

- [ ] **Step 4: Update gitignore**

Ignore `proxypool_service/.venv/`, `.pytest_cache/`, `__pycache__/`, `*.egg-info/`, and local logs.

- [ ] **Step 5: Commit**

Run:

```bash
git add proxypool_service/Dockerfile proxypool_service/docker-compose.yml proxypool_service/.env.example proxypool_service/README.md .gitignore
git commit -m "Add ProxyPool Docker support"
```

---

### Task 8: Final Verification

**Files:**
- Modify only if verification reveals defects.

- [ ] **Step 1: Run Python tests**

Run: `cd proxypool_service; python -m pytest -v`

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Run Rust build check**

Run: `cd src-tauri; cargo check`

Expected: PASS.

- [ ] **Step 4: Run sidecar smoke if Redis exists**

If local Redis is available, run:

```bash
cd proxypool_service
python -m proxypool_service serve --config ../path/to/test-config.json
```

Then verify `GET http://127.0.0.1:40326/health` and `GET http://127.0.0.1:40326/count` return JSON.

- [ ] **Step 5: Review git diff**

Run: `git status --short` and `git diff --stat HEAD`.

Expected: only intended ProxyPool files plus pre-existing user dirty files remain.

---

## Self-Review

Spec coverage:

- UI tab and controls: Task 6.
- Python sidecar service: Tasks 1-4.
- Redis storage: Task 2.
- Collection/check/scheduler: Tasks 3-4.
- API endpoints: Task 4.
- Tauri process control: Task 5.
- Docker Compose: Task 7.
- Testing/verification: Tasks 1-4 and 8.

No placeholders remain. Names are consistent across Python, Rust, and TypeScript: `proxypool_*` for Tauri commands/settings, `/proxy/*` and `/proxies` for service API, default port `40326`.
