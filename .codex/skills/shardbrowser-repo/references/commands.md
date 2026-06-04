# Commands

Run from repo root unless noted.

## Frontend

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run dev
```

## Tauri

```powershell
npm.cmd run tauri dev
npm.cmd run tauri build
```

Windows helper scripts:

```bat
"smart launch\build.bat"
"smart launch\run.bat"
```

Release exe path:

```text
src-tauri\target\release\shardx-launcher.exe
```

## ProxyPool Service

```powershell
python -m pytest proxypool_service\tests -q
python -m proxypool_service serve --config <config.json>
python -m proxypool_service sources --config <config.json>
```

If import fails, run from inside `proxypool_service` or ensure package is installed/editable. Existing helper sidecar starts with current dir set to `proxypool_service`.

Redis helpers:

```bat
"smart launch\build-redis.bat"
"smart launch\run-redis.bat"
```

Default Redis URL:

```text
redis://:madpool@127.0.0.1:6380/0
```

## Cleanup

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File cleanup-proxypool.ps1
```

Use this when ProxyPool sidecar says connected then `Unknown`/request error, or old Python holds port `40326`.

## Expected Old Warnings

- Python/APScheduler may warn that `pkg_resources` is deprecated. Dependency pins `setuptools<81`.
- Rust may warn about unused Windows import in `launch.rs` or unused runtime constant. Treat as existing warning unless touched.

## Verification Sets

Small UI-only change:

```powershell
npm.cmd run build
```

ProxyPool Python change:

```powershell
python -m pytest proxypool_service\tests -q
```

Cross-boundary ProxyPool UI/Tauri/Python change:

```powershell
python -m pytest proxypool_service\tests -q
npm.cmd run build
```

Release/script change:

```powershell
cmd.exe /c "smart launch\build.bat"
```
