# BrProxies ProxyPool Service

Local free public proxy pool service for BrProxies. It collects public proxies, checks which ones work, stores good proxies in Redis, rechecks them on a schedule, and exposes a crawler-friendly HTTP API.

## Requirements

- Python 3.11+
- Redis reachable from the service

## Local Run

```powershell
python -m pip install -e .[dev]
python -m proxypool_service sources
python -m proxypool_service serve
```

Default API: `http://127.0.0.1:40326`

Standalone service default Redis: `redis://127.0.0.1:6379/0`

When started by BrProxies `smart launch\run.bat`, the desktop helper starts the
bundled Windows Redis on:

```text
redis://:madpool@127.0.0.1:6380/0
```

## Config

The desktop app writes a JSON config file and starts the service with:

```powershell
python -m proxypool_service serve --config <path>
```

For day-to-day desktop use, prefer launching BrProxies through:

```bat
"smart launch\run.bat"
```

That script starts Redis, cleans stale ProxyPool sidecars, and opens the app.

Docker and shell usage can override config with environment variables:

- `PROXYPOOL_HOST`
- `PROXYPOOL_PORT`
- `PROXYPOOL_REDIS_URL`
- `PROXYPOOL_DISABLED_SOURCES`
- `PROXYPOOL_COLLECT_INTERVAL_SECONDS`
- `PROXYPOOL_CHECK_INTERVAL_SECONDS`
- `PROXYPOOL_TIMEOUT_SECONDS`
- `PROXYPOOL_MAX_CONCURRENCY`
- `PROXYPOOL_FAILURE_THRESHOLD`
- `PROXYPOOL_INITIAL_COLLECT`

Disable sources as comma-separated IDs, for example:

```text
PROXYPOOL_DISABLED_SOURCES=us_proxy,ssl_proxies
```

## API

```text
GET /health
GET /proxy/random?https=true
GET /proxy/pop?https=true
GET /proxies?https=true
GET /count?https=true
DELETE /proxy/{proxy}
GET /sources
POST /sources
POST /clean
POST /jobs/collect
POST /jobs/check
```

`/proxy/random` keeps the proxy in Redis. `/proxy/pop` returns one proxy and removes it. `https=true` filters to proxies that passed an HTTPS request through an HTTP proxy tunnel.

## Docker Compose

```powershell
docker compose up --build
```

Then verify:

```powershell
curl http://127.0.0.1:40326/health
curl http://127.0.0.1:40326/count
```
