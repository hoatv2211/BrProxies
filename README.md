# BrProxies

[Tieng Viet](README.vn.md) | [Project guide](docs/index.html)

BrProxies is a personal desktop launcher for browser profile management,
fingerprint control, proxy testing, local automation, and crawler proxy pooling.
It is developed at [hoatv2211/ShardBrowser](https://github.com/hoatv2211/ShardBrowser)
from the original [ProxyShard/ShardBrowser](https://github.com/ProxyShard/ShardBrowser)
ShardX Launcher codebase.

The upstream project describes ShardX as an anti-detect Chromium launcher with
engine-level fingerprint spoofing, proxy binding, a local HTTP API, MCP support,
and Python/Node SDKs. This fork keeps that profile/proxy workflow and adds a
local Redis-backed ProxyPool sidecar for collecting and rechecking public
proxies before promoting working rows into browser profiles.

## Main Screens

| Browsers | Fingerprints |
|----------|--------------|
| ![Browsers workspace](docs/screenshots/Browsers.png) | ![Fingerprint editor](docs/screenshots/fingerprints.png) |

| Proxies | ProxyPool |
|---------|-----------|
| ![Proxy manager](docs/screenshots/proxies.png) | ![ProxyPool workspace](docs/screenshots/proxypool.png) |

## What It Does

- **Profiles** - create, clone, pin, tag, organize, and launch isolated browser
  profiles.
- **Fingerprints** - edit device identity, screen, WebGL/WebGPU, locale,
  timezone, WebRTC, media devices, geolocation, and noise settings.
- **Proxies** - add HTTP, HTTPS, and SOCKS5 proxies, run TCP/UDP/geo checks, and
  bind proxies to profiles.
- **ProxyPool** - collect public proxy candidates, test live ones, store working
  records in Redis, recheck them, and add good proxies into the main proxy list.
- **Automation API** - expose a local HTTP API on `127.0.0.1:40325` with Bearer
  token auth for profile automation and CDP handoff.
- **MCP server** - export a local MCP bridge for AI clients.
- **SDKs** - Python and Node SDKs live in `sdks/`.

## Validation Screenshots

Screenshots `03` through `08` are refreshed from
[hoatv2211/ShardBrowser](https://github.com/hoatv2211/ShardBrowser/tree/main/docs/screenshots).

| fingerprint.com | Twilio WebRTC |
|-----------------|---------------|
| ![fingerprint.com result](docs/screenshots/03-fingerprint-com.jpg) | ![Twilio WebRTC result](docs/screenshots/04-twilio-webrtc.jpg) |

| Browserscan | Pixelscan |
|-------------|-----------|
| ![Browserscan result](docs/screenshots/05-browserscan.jpg) | ![Pixelscan result](docs/screenshots/06-pixelscan.jpg) |

| Haru bot detection | reCAPTCHA score |
|--------------------|-----------------|
| ![Haru bot detection result](docs/screenshots/07-haru-bot-detect.jpg) | ![reCAPTCHA score result](docs/screenshots/08-recaptcha-score.jpg) |

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
src-tauri\target\release\brproxies.exe
```

`run.bat` also calls `cleanup-proxypool.ps1` to stop stale ProxyPool Python
sidecars before opening the app.

## Manual Build

```bash
npm install
npm run build
npm run tauri dev
npm run tauri build
```

On Windows PowerShell, use `npm.cmd` if bare `npm` is not resolved correctly.

## ProxyPool Workflow

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

Typical UI flow:

1. Open **ProxyPool** and click **Connect**.
2. Click **Collect now** to crawl enabled sources and save passing proxies.
3. Click **Refresh** or **Check now** to recheck stored proxies.
4. Use **Copy** for a raw proxy string or **Add** to promote a row into the main
   **Proxies** tab.
5. Use **Add source** for custom text, table, or Geonode JSON proxy lists.

Public free proxy sources are unstable. Empty results can mean the source is
blocked, temporarily down, or all candidates failed live checks.

## ProxyPool API

Default sidecar URL: `http://127.0.0.1:40326`

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
docs/screenshots/     README and guide screenshots
```

## License

Launcher source is MIT licensed. The bundled/downloaded browser runtime may have
separate upstream terms inherited from the original project.
