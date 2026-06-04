# ProxyPool Integration Design

Date: 2026-06-04

## Goal

Add a first-class `ProxyPool` workspace tab to ShardX Launcher. The feature runs a local Python proxy pool service in the background, collects free public proxies from a small enabled source set, validates them, stores working proxies in an external Redis instance, and exposes a local API for crawler code.

The feature must not replace or blur the existing paid `ProxyShard` workflow. `ProxyPool` is a separate free public proxy pool with separate UI, config, state, and API.

## User Experience

Add `ProxyPool` to the left sidebar under `WORKSPACE`, separate from `Proxies` and `ProxyShard`.

The `ProxyPool` page shows:

- Service status: stopped, starting, running, errored.
- Redis status: connected, disconnected, error message.
- Live proxy count, HTTPS-capable count, last collection time, last check time.
- Start, stop, restart, refresh, collect now, and check now actions.
- Local API endpoint display, defaulting to `127.0.0.1:40326`.
- Proxy table with proxy address, scheme support, latency, source, last checked, fail count, and delete action.
- Filters for all proxies or HTTPS-capable proxies.
- Config controls for host, port, Redis URL, disabled sources, collect interval, check interval, request timeout, and checker concurrency.

Config is stored locally with the rest of ShardX settings. Secrets are not required for the proxy pool itself. Redis credentials, if present in the Redis URL, stay local.

## Architecture

Use a Python sidecar service launched by the Tauri backend.

In development, Tauri starts the service with:

```text
python -m proxypool_service
```

The service receives config through a generated JSON config file path passed by the Tauri backend. Environment variables may override individual fields for Docker usage. The Tauri backend owns process lifecycle: start, stop, restart, status, and logs. If the service crashes, the UI shows the error and allows restart. V1 keeps restart user-driven to avoid tight crash loops.

The Python service contains:

- FastAPI API server.
- APScheduler jobs for collecting and checking.
- Redis storage adapter using `redis-py`.
- Proxy collectors using `httpx` plus structured HTML parsing.
- Proxy checker using `httpx` with concurrency limits and timeouts.
- Config loader with environment variables and optional `.env` support.

External Redis is required. The app does not launch Redis in V1. Docker Compose support is still provided for users who want to run the service and Redis outside the desktop app.

## Local API

The service exposes these endpoints:

```text
GET /health
GET /proxy/random?https=true
GET /proxy/pop?https=true
GET /proxies?https=true
GET /count?https=true
DELETE /proxy/{proxy}
GET /sources
POST /jobs/collect
POST /jobs/check
```

Behavior:

- `GET /proxy/random` returns one random working proxy and keeps it in Redis.
- `GET /proxy/pop` returns one random working proxy and removes it from Redis.
- `GET /proxies` lists all working proxies, optionally filtered to HTTPS-capable proxies.
- `GET /count` returns total working proxy count, optionally filtered to HTTPS-capable proxies.
- `DELETE /proxy/{proxy}` removes a bad proxy reported by crawler code.
- `GET /sources` lists enabled and disabled proxy sources.
- Manual job endpoints trigger one collection or check pass without waiting for the scheduler.

Responses use JSON. For crawler convenience, random and pop endpoints include both raw proxy string and URL forms:

```json
{
  "proxy": "1.2.3.4:8080",
  "http": "http://1.2.3.4:8080",
  "https": "http://1.2.3.4:8080",
  "latency_ms": 742,
  "source": "free_proxy_list"
}
```

## Redis Model

Redis stores working proxies plus metadata.

Keys:

- `proxypool:all`: set of all working proxy strings.
- `proxypool:https`: set of HTTPS-capable proxy strings.
- `proxypool:meta:{proxy}`: hash with source, latency, last_checked, fail_count, supports_https.

Checker removes dead proxies after configurable repeated failures. Default failure threshold is 2 consecutive failures. Passing a check resets fail count and updates latency and last checked time.

## Collection Sources

V1 uses a small default set of public sources to reduce parser churn. Each source is implemented behind a common interface:

```text
name -> list[ProxyCandidate]
```

Default source IDs:

- `free_proxy_list`: table parser for `free-proxy-list.net`.
- `ssl_proxies`: table parser for `sslproxies.org`.
- `us_proxy`: table parser for `us-proxy.org`.
- `proxy_scrape`: plain text parser for ProxyScrape free proxy endpoint.
- `geonode_free`: JSON parser for Geonode free proxy list endpoint.

Each source can be disabled by name. V1 avoids sources that require CAPTCHA, login, or browser-only JavaScript.

## Scheduling

Default scheduler settings:

- Collect interval: 15 minutes.
- Check interval: 5 minutes.
- Request timeout: 8 seconds.
- Checker concurrency: 50.
- Failure threshold: 2.

On service start, scheduler starts automatically. The service also performs an initial lightweight health check against Redis. Initial collection can be manual or automatic; V1 should make this configurable, defaulting to automatic initial collection so the pool becomes useful quickly.

## Docker Support

Add Docker artifacts for users who prefer not to launch from the desktop app:

- `proxypool_service/Dockerfile`
- `proxypool_service/docker-compose.yml`
- `.env.example`

Compose runs Redis plus the proxy pool service. The desktop app can still connect to an external Redis and can point at its own sidecar API; Docker is optional.

## Error Handling

The service must tolerate dead sources, malformed rows, network timeouts, Redis connection failures, and proxy check failures.

- Collector source failures are logged and do not fail the whole collection job.
- Redis unavailable makes health fail and job writes fail, but the API server stays up so UI can report status.
- Invalid config prevents service start and returns a clear process error to the UI.
- API endpoints return structured error JSON with useful messages.

## Testing

Python service tests cover:

- Config loading and disabled source parsing.
- Redis storage adapter behavior using fakeredis or a test Redis.
- Collector parser fixtures for each built-in source.
- Checker success/failure behavior with mocked HTTP responses.
- FastAPI endpoints with a test client.

Tauri/UI tests or focused checks cover:

- Sidebar shows `ProxyPool`.
- Page can render stopped, running, and error states.
- UI calls service control commands and API endpoints correctly.

Manual verification covers:

- Start app, configure Redis URL, start ProxyPool service.
- Trigger collection and check jobs.
- Fetch random proxy and delete bad proxy through local API.
- Run Docker Compose version and confirm `/health` and `/count` work.

## Open Implementation Notes

- Use `127.0.0.1:40326` as default sidecar API address to avoid conflicting with existing ShardX Automation API at `127.0.0.1:40325`.
- Keep `ProxyPool` isolated from existing `ProxyShard` paid API code.
- Do not commit user-specific Redis URLs, API keys, logs, generated databases, or virtual environments.
- Respect current dirty worktree and avoid touching unrelated files.
