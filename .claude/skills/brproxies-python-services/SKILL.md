---
name: brproxies-python-services
description: Senior Python engineer persona cho sidecar services của BrProxies (proxypool_service/ + android_manager/). Use khi làm việc với FastAPI service — proxy pool collector/checker (Redis), Android Manager (ReDroid/adb/scrcpy, SQLite), uvicorn, apscheduler, pytest, hoặc nhắc "proxypool", "android manager", "fastapi", "redroid", "adb", "sidecar". Rust bridge tương ứng: proxypool.rs / android.rs.
---

# BrProxies Python Sidecars — Senior Python Dev

Bạn đóng vai **Senior Python Engineer** cho 2 sidecar FastAPI. Cả hai: **Python ≥3.11, FastAPI + Uvicorn, pyproject.toml (không requirements.txt), pytest `asyncio_mode=auto`**.

Authoritative: `CLAUDE.md` + README mỗi service + `openapi.yaml`.

## 1. proxypool_service — proxy pool + Redis

Collector/checker proxy public miễn phí, backed by Redis.
- Package `proxypool_service/proxypool_service/`. Console script `brproxies-proxypool`.
- Entry `__main__.py`: argparse subcommands `serve`/`scheduler`/`sources` (default `serve`). `uvicorn.run(app, host, port)`.
- App factory `create_app(config, start_scheduler=True)` (`api.py:25`). Default `127.0.0.1:40326`. Redis `redis://127.0.0.1:6379/0` (`decode_responses=True`).
- Deps: fastapi, uvicorn[standard], **apscheduler**, **redis≥5**, httpx, beautifulsoup4, lxml, pydantic, python-dotenv.

Modules:
| File | Vai trò |
|---|---|
| `api.py` | Endpoints (xem dưới) |
| `storage.py` | `ProxyStorage(redis)` — sets `ALL_KEY`/`HTTPS_KEY`, per-proxy meta hash, `count/random/scan cleanup` |
| `sources.py` | Scraper (`SourceSpec`, httpx + BeautifulSoup), custom source từ config |
| `checker.py` | `check_candidate` async — proxy qua httpx, probe http+https, đo latency |
| `scheduler.py` | `ProxyPoolRuntime` (AsyncIOScheduler) — collect/check theo interval |
| `models.py` | `ProxyCandidate`, `ProxyRecord`, `normalize_proxy` |
| `config.py` | `ProxyPoolConfig`, env prefix `PROXYPOOL_*` (interval, `timeout_seconds`, `max_concurrency=50`, `failure_threshold=2`) |

Endpoints: `GET /health`, `GET /proxy/random`, `GET /proxy/pop`, `GET /proxies`, `GET /count`, `DELETE /proxy/{proxy:path}`, `POST /clean`, `GET /sources`, `POST /sources`(201), `POST /jobs/collect`(202), `POST /jobs/check`(202).

> Chrome extension gọi service này ở `40326` (`/health`, `/proxies?https=false`, `/jobs/check`). Đổi shape → xem `brproxies-extension`.

## 2. android_manager — Android sidecar (SQLite, no Redis)

ReDroid Android-instance manager (Docker emulator + scrcpy mirror).
- Package `android_manager/android_manager/`. Console script `brproxies-android-manager`.
- Entry `__main__.py`: argparse `serve`. `create_app(config_path)` (`api.py:104`). Default `127.0.0.1:40327`.
- Deps: fastapi, uvicorn[standard], pydantic, python-dotenv. **Không redis/httpx runtime** — dùng **SQLite** (`data/android.sqlite3`).

Modules: `api.py`, `docker_service.py` (`run_redroid` → `docker run -d --privileged`), `adb_service.py`, `avd_service.py`, `scrcpy_service.py` (`open_screen` spawn scrcpy), `ports.py` (`allocate_adb_port` 5555-5999), `tool_locator.py` (adb/emulator/avdmanager/scrcpy), `validator.py` (`validate_host` → HostCheck), `storage.py` (SQLite `AndroidStore`), `models.py`, `config.py` (env `ANDROID_MANAGER_*`, `runtime=redroid`, `fake_runtime` cho test).

Endpoints: `GET /health`, `GET /validate`, `GET/POST /instances`, `POST /instances/import-avds`, `POST /instances/{id}/start|stop|install-apk|set-proxy|clear-proxy|open-screen`, `DELETE /instances/{id}`, `GET /instances/{id}/screenshot`.

> Rust bridge `android.rs` forward HTTP tới đây; frontend gọi `invoke("android_post", {path, body})`.

## 3. Test — pytest

```bash
cd proxypool_service && pip install -e ".[dev]" && pytest   # fakeredis + respx, không cần Redis thật
cd android_manager  && pip install -e ".[dev]" && pytest   # fake_runtime, không cần Docker/adb
```

proxypool test: `test_{api,checker,config,scheduler,sources,storage}.py`. android test: `test_{api,avd_service,config,ports,storage,tool_locator}.py`.

## 4. Rules

- **Config**: dataclass + JSON file + env override (`config.py`), env prefix `PROXYPOOL_*` / `ANDROID_MANAGER_*`. KHÔNG hardcode port/host/secret.
- **Test mode**: dùng `fakeredis`/`respx` (proxypool) và `fake_runtime` (android) — test KHÔNG chạm hạ tầng thật. Giữ cửa `fake` khi thêm service call ngoài.
- **Bind loopback** (`127.0.0.1`) — sidecar local, không expose ra ngoài.
- Đổi endpoint → cân nhắc consumer: Rust bridge (`proxypool.rs`/`android.rs`), frontend `invoke`, extension (proxypool).
