# Repo Map

## Product Shape

ShardBrowser is ShardX Launcher: Tauri 2 desktop app with React/TypeScript UI and Rust backend. It manages anti-detect browser profiles, proxies, fingerprints, cookies, local HTTP automation API, MCP bootstrap, SDK docs, and a Python ProxyPool sidecar.

## Frontend

- `src/App.tsx`: main app state, tabs, forms, tables, Tauri `invoke` calls.
- `src/App.css`: app layout and component styling. Keep operational UI dense and scan-friendly.
- `src/main.tsx`: React mount.
- `package.json`: Vite, React 19, Tauri CLI scripts.

When adding a tab or control, update the `Section` union, nav rendering, state/types, handlers, and CSS together.

## Tauri Backend

- `src-tauri/src/lib.rs`: module list, Tauri command functions, `invoke_handler!`, app setup, local API startup.
- `src-tauri/src/settings.rs`: persisted settings. Add serde fields here when UI needs persistent config.
- `src-tauri/src/store.rs`: app data directories and JSON store paths.
- `src-tauri/src/profile.rs`: profile CRUD, folders, pinning, clone/import.
- `src-tauri/src/launch.rs`: browser subprocess launch, profile runtime args, proxy/fingerprint binding.
- `src-tauri/src/process.rs`: running profile tracker.
- `src-tauri/src/proxy.rs`: proxy parse/save/test/geo/UDP probe/history.
- `src-tauri/src/fingerprints.rs`: fingerprint library load/import/delete.
- `src-tauri/src/runtime.rs`: patched Chromium/Widevine/fingerprint downloads.
- `src-tauri/src/cookies.rs`: Chromium cookie import/export.
- `src-tauri/src/api.rs`: axum local automation API, default port `40325`.
- `src-tauri/src/proxypool.rs`: starts/stops Python sidecar and proxies UI requests to sidecar API.

When adding a Tauri command, register it in `invoke_handler!` and keep TypeScript call shape in sync.

## ProxyPool Service

- `proxypool_service/proxypool_service/config.py`: env/JSON config and defaults.
- `sources.py`: built-in sources, custom source validation, parsers.
- `checker.py`: async proxy connectivity checks.
- `storage.py`: Redis persistence.
- `scheduler.py`: collect/check jobs, APScheduler runtime.
- `api.py`: FastAPI endpoints.
- `models.py`: proxy records and response normalization.
- `__main__.py`: CLI: `serve`, `scheduler`, `sources`.
- `tests/`: pytest/fakeredis/respx coverage.

Common ProxyPool endpoints:

- `GET /health`
- `GET /proxy/random?https=false`
- `GET /proxy/pop?https=false`
- `GET /proxies?https=false`
- `GET /count?https=false`
- `DELETE /proxy/{host}:{port}`
- `GET /sources`
- `POST /sources`
- `POST /jobs/collect`
- `POST /jobs/check`

## Smart Launch Scripts

- `smart launch/build.bat`: build frontend and Tauri release.
- `smart launch/run.bat`: run built `src-tauri\target\release\shardx-launcher.exe` after cleanup.
- `smart launch/build-redis.bat`: pull/build Redis dependency for ProxyPool.
- `smart launch/run-redis.bat`: run Redis container on port `6380` with password `madpool`.
- `cleanup-proxypool.ps1`: kill stale Python sidecar processes holding ProxyPool API.

Use quoted paths for `smart launch\*.bat` because folder name contains a space.

## Docs And SDKs

- `README.md`: English docs.
- `README.vn.md`: Vietnamese docs.
- `openapi.yaml`: automation API schema.
- `mcp/`: Node MCP server package.
- `sdks/python/`: Python SDK package.
- `sdks/node/`: Node SDK package.

Docs are user-facing. Keep English and Vietnamese aligned when changing setup or ProxyPool behavior.
