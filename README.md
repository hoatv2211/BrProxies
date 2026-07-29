# BrProxies

[Tieng Viet](README.vn.md) | [Page](https://hoatv2211.github.io/BrProxies/)

BrProxies is a Windows-first desktop launcher for anti-detect browser profile
management, fingerprint control, proxy testing, local automation, crawler proxy
pooling, and experimental Android instance control.

The project is developed at [hoatv2211/BrProxies](https://github.com/hoatv2211/BrProxies).
The browser runtime is downloaded separately; this repo contains the launcher,
local services, SDKs, MCP server, Chrome extension, and Windows helper scripts.

## Main Screens

| Browsers                                             | Fingerprints                                             |
| ---------------------------------------------------- | -------------------------------------------------------- |
| ![Browsers workspace](docs/screenshots/Browsers.png) | ![Fingerprint editor](docs/screenshots/fingerprints.png) |

| Proxies                                        | ProxyPool                                              |
| ---------------------------------------------- | ------------------------------------------------------ |
| ![Proxy manager](docs/screenshots/proxies.png) | ![ProxyPool workspace](docs/screenshots/proxypool.png) |

## What It Does

- **Browser profiles** - create, clone, pin, tag, organize, and launch isolated
  Chromium profiles.
- **Account Keeper (Windows 10/11 MVP)** - rotate passwords for authorized
  accounts one at a time with persistent profiles, a DPAPI-protected vault, and
  manual recovery controls. [English guide](docs/account-keeper.md) |
  [Tiếng Việt](docs/account-keeper.vn.md).
- **Fingerprints** - edit device identity, screen, WebGL/WebGPU, locale,
  timezone, WebRTC, media devices, geolocation, and noise settings.
- **Proxies** - add HTTP, HTTPS, and SOCKS5 proxies, run TCP/UDP/geo checks,
  and bind proxies to browser profiles.
- **ProxyPool** - collect public proxy candidates, test live ones, store working
  rows in Redis, recheck them, and promote good proxies into the main proxy
  list.
- **Android Manager** - run real Android Studio AVD instances on Windows, open
  the screen with scrcpy, and import currently running ADB devices.
- **Automation API** - expose a local HTTP API on `127.0.0.1:40325` with Bearer
  token auth for browser automation and CDP handoff.
- **MCP server** - bridge BrProxies into AI clients through the local API and
  CDP.
- **SDKs** - standalone Python and Node SDKs for launching the patched browser
  runtime without the desktop app.

## Quick Start On Windows

Helper scripts live in [`smart launch`](smart%20launch/):

```bat
"smart launch\build.bat"        :: smart build web assets + desktop app
"smart launch\build.bat" /full  :: force full dependency/build pass
"smart launch\build.bat" /deps  :: refresh npm + Android Manager deps
"smart launch\run.bat"          :: start Redis, cleanup ProxyPool, run launcher
"smart launch\run-redis.bat"    :: start bundled Windows Redis only
```

Normal build and run:

```bat
"smart launch\build.bat"
"smart launch\run.bat"
```

Release exe:

```text
src-tauri\target\release\brproxies.exe
```

`build.bat` delegates to `smart-build.ps1`. Smart mode caches dependency and
build input hashes under `.brproxies-build-cache`, skips unchanged npm/Python
setup, runs `npm.cmd run tauri build -- --no-bundle`, and auto-closes a running
`brproxies.exe` before rebuilding the release binary.

`run.bat` starts the bundled Windows Redis on `127.0.0.1:6380`, calls
`cleanup-proxypool.ps1` to stop stale ProxyPool Python sidecars, then opens the
app.

## Manual Build

```bash
npm install
npm run build
npm run tauri dev
npm run tauri build
```

On Windows PowerShell, use `npm.cmd` if bare `npm` is not resolved correctly.

## Android Manager

Android support is practical but still newer than the browser workflow. Current
runtime priority:

1. `windows_avd` - real Android Studio AVD on Windows. This is the current
   supported local path.
2. `external_adb` - planned attach/import path for LDPlayer, BlueStacks, MEmu,
   or any emulator already visible through ADB.
3. `redroid` - planned Linux-host path. ReDroid is not Windows-native.

Windows AVD requirements:

- Android Studio installed.
- Android SDK Platform Tools, Emulator, Command-line Tools installed.
- Light system image installed: `system-images;android-35;google_apis;x86_64`.
- Optional but recommended: `scrcpy` for a smoother native control window.

Install the preferred Android image from PowerShell:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
& "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$env:LOCALAPPDATA\Android\Sdk" "system-images;android-35;google_apis;x86_64"
winget install Genymobile.scrcpy
```

Useful checks:

```powershell
adb version
emulator -version
avdmanager list avd
scrcpy --version
```

App flow:

1. Open **Android**.
2. Click **Start manager**. This starts only the Android Manager sidecar.
3. Click **Create device** to create a BrProxies-managed AVD.
4. Click **Start** to boot the AVD and open its screen through scrcpy when
   available.
5. Click **Import devices** to import only devices that are currently running
   and visible in `adb devices -l`.

AVD boot can take 30-70 seconds on cold start. Quick Boot snapshots make later
starts faster. AVD is lighter and cleaner with the `google_apis` image than the
`google_apis_playstore` image, but it is still heavier than browser profiles and
usually not as smooth as LDPlayer for games.

## ProxyPool Workflow

ProxyPool runs as a local Python sidecar. It collects proxies from enabled
public sources, tests whether they work, saves passing records to Redis, and
removes dead proxies during rechecks.

Redis starts automatically when you launch the app with `run.bat`. To start only
Redis for debugging:

```bat
"smart launch\run-redis.bat"
```

Default Redis URL used by the desktop helper:

```text
redis://:madpool@127.0.0.1:6380/0
```

Typical UI flow:

1. Open **ProxyPool** and click **Connect**.
2. Click **Collect now** to crawl enabled sources and save passing proxies.
3. Click **Refresh** or **Check now** to recheck stored proxies.
4. Use **Copy** for a raw proxy string or **Add** to promote a row into the main
   **Proxies** tab. Added rows are removed from Redis.
5. Filter by country or source, select rows, then use **Copy selected**,
   **Add selected**, or **Delete selected**.
6. Use **Clean** to clear all cached ProxyPool IPs from Redis.
7. Use **Add source** for custom text, table, or Geonode JSON proxy lists.

Public free proxy sources are unstable. Empty results can mean the source is
blocked, temporarily down, or all candidates failed live checks.

## ProxyPool API

Default sidecar URL: `http://127.0.0.1:40326`

| Method   | Endpoint                      | Purpose                        |
| -------- | ----------------------------- | ------------------------------ |
| `GET`    | `/health`                     | service and Redis status       |
| `GET`    | `/proxy/random?https=false`   | get one random working proxy   |
| `GET`    | `/proxy/pop?https=false`      | get and remove one proxy       |
| `GET`    | `/proxies?https=false`        | list working proxies           |
| `GET`    | `/count?https=false`          | count working proxies          |
| `DELETE` | `/proxy/{host}:{port}`        | delete a bad proxy             |
| `POST`   | `/clean`                      | clear cached ProxyPool IPs     |
| `GET`    | `/sources`                    | list proxy sources             |
| `POST`   | `/sources`                    | add a custom source            |
| `POST`   | `/jobs/collect`               | queue collect job              |
| `POST`   | `/jobs/check`                 | queue recheck job              |

## Chrome ProxyPool Extension

The repo includes a local Manifest V3 Chrome extension in [`extension/`](extension/).
It connects to `http://127.0.0.1:40326`, lists working proxies, rechecks them,
and applies one proxy to Chrome through `chrome.proxy`.

Local load flow:

1. Run `smart launch\run.bat`.
2. Open **ProxyPool**, click **Connect**, then collect/check until working rows
   exist.
3. Open Chrome `chrome://extensions`, enable **Developer mode**, and click
   **Load unpacked**.
4. Select the repo `extension` folder.
5. Open the extension popup, click **Connect**, then use **Use**, **Rotate**, or
   **Direct**.

## Local Automation API

The launcher can expose a local browser automation API on `127.0.0.1:40325`.
Enable it in Settings, copy the Bearer token, then call endpoints from crawler
code or tools.

Raw schema: [openapi.yaml](openapi.yaml)

## Repository Layout

```text
src/                  React/Vite UI
src-tauri/src/        Tauri Rust backend
android_manager/      Python FastAPI Android Manager sidecar
proxypool_service/    Python FastAPI + Redis proxy pool service
sdks/python/          Python SDK
sdks/node/            Node SDK
mcp/                  MCP server package
extension/            Local Chrome ProxyPool extension
smart launch/         Windows build/run helpers
docs/screenshots/     README and guide screenshots
```

## Validation Screenshots

| fingerprint.com                                                    | Twilio WebRTC                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| ![fingerprint.com result](docs/screenshots/03-fingerprint-com.jpg) | ![Twilio WebRTC result](docs/screenshots/04-twilio-webrtc.jpg) |

| Browserscan                                                | Pixelscan                                              |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| ![Browserscan result](docs/screenshots/05-browserscan.jpg) | ![Pixelscan result](docs/screenshots/06-pixelscan.jpg) |

| Haru bot detection                                                    | reCAPTCHA score                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| ![Haru bot detection result](docs/screenshots/07-haru-bot-detect.jpg) | ![reCAPTCHA score result](docs/screenshots/08-recaptcha-score.jpg) |

## License

Launcher source is MIT licensed. The bundled/downloaded browser runtime may have
separate upstream terms inherited from the original project.
