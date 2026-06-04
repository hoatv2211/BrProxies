# ShardBrowser

[Tieng Viet](README.vn.md)

Personal ShardBrowser launcher for browser profile management, proxy testing,
local automation, and crawler proxy pooling.

This project is developed as a personal fork at
[hoatv2211/ShardBrowser](https://github.com/hoatv2211/ShardBrowser). Source was
originally taken from [ProxyShard/ShardBrowser](https://github.com/ProxyShard/ShardBrowser).

## Features

- **Profiles** - create, clone, pin, tag, and launch isolated browser profiles.
- **Fingerprints** - edit device, screen, WebGL/WebGPU, locale, timezone,
  WebRTC, media devices, and noise settings.
- **Proxies** - add HTTP, HTTPS, and SOCKS5 proxies, test TCP/UDP/geo, and bind
  proxies to profiles.
- **ProxyPool** - collect free public proxies, check live ones, store working
  proxies in Redis, recheck them, and add them into the main proxy list.
- **Automation API** - local HTTP API on `127.0.0.1:40325` with Bearer token
  auth for profile automation and CDP handoff.
- **MCP server** - downloadable MCP bridge for AI clients.
- **SDKs** - Python and Node SDKs in `sdks/`.

## Quick Start On Windows

Helper scripts live in [`smart launch`](smart%20launch/):

```bat
"smart launch\build.bat"        :: build web assets + desktop app
"smart launch\run.bat"          :: run the built launcher
"smart launch\build-redis.bat"  :: pull Redis Docker image
"smart launch\run-redis.bat"    :: start Redis for ProxyPool
```

Build and run:

```bat
"smart launch\build.bat"
"smart launch\run.bat"
```

Release exe:

```text
src-tauri\target\release\shardx-launcher.exe
```

`run.bat` also runs `cleanup-proxypool.ps1` to stop stale ProxyPool Python
sidecars before opening the app.

## Manual Build

```bash
npm install
npm run build
npm run tauri dev
npm run tauri build
```

On Windows PowerShell, use `npm.cmd` if bare `npm` is not resolved correctly.

## ProxyPool

ProxyPool runs as a local Python sidecar. It collects proxies from enabled
public sources, tests whether they work, saves passing records to Redis, and
removes dead proxies during rechecks.

Start Redis when you want persistence:

```bat
"smart launch\build-redis.bat"
"smart launch\run-redis.bat"
```

Default Redis URL:

```text
redis://:madpool@127.0.0.1:6380/0
```

ProxyPool UI actions:

- **Connect** - start/connect to the local ProxyPool service.
- **Collect now** - fetch candidates and save passing proxies.
- **Check now / Refresh** - recheck stored proxies and refresh the table.
- **Copy** - copy a working proxy.
- **Add** - add a working proxy into the main **Proxies** tab.
- **Delete** - remove a bad proxy from the pool.
- **Add source** - add a custom scraping source for future collection.

ProxyPool API:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/health` | service and Redis status |
| `GET` | `/proxy/random?https=false` | get one random working proxy |
| `GET` | `/proxy/pop?https=false` | get and remove one proxy |
| `GET` | `/proxies?https=false` | list working proxies |
| `GET` | `/count?https=false` | count working proxies |
| `DELETE` | `/proxy/{host}:{port}` | delete a bad proxy |
| `GET` | `/sources` | list proxy sources |
| `POST` | `/sources` | add a custom source |
| `POST` | `/jobs/collect` | queue collect job |
| `POST` | `/jobs/check` | queue recheck job |

Example:

```bash
curl "http://127.0.0.1:40326/proxy/random?https=false"
```

Public free proxy sources are unstable. Empty results can mean the source is
blocked, temporarily down, or all candidates failed the live check.

## Local Automation API

The launcher can expose a local API on `127.0.0.1:40325`. Enable it in
Settings, copy the Bearer token, then call endpoints from crawler code or tools.

Raw schema: [openapi.yaml](openapi.yaml)

## Repository Layout

```text
src/                  React/Vite UI
src-tauri/src/        Tauri Rust backend
proxypool_service/    Python FastAPI + Redis proxy pool service
sdks/python/          Python SDK
sdks/node/            Node SDK
mcp/                  MCP server package
smart launch/         Windows build/run helpers
```

## License

Launcher source is MIT licensed. The bundled/downloaded browser runtime may have
separate upstream terms inherited from the original project.
