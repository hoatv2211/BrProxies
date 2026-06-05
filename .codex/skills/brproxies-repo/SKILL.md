---
name: brproxies-repo
description: Repository onboarding and task workflow for BrProxies. Use when Codex is working inside this repo, especially for Tauri Rust backend changes, React/TypeScript UI changes, ProxyPool service changes, smart launch .bat scripts, SDK docs, README updates, tests, builds, or debugging local launcher/proxy/Redis behavior.
---

# BrProxies Repo

Use this skill as first-pass repo memory. Read the minimum reference needed, then inspect live files before editing.

## Fast Map

- React UI: `src/App.tsx`, `src/App.css`, `src/main.tsx`.
- Tauri backend: `src-tauri/src/*.rs`, commands registered in `src-tauri/src/lib.rs`.
- Local automation API: `src-tauri/src/api.rs`, schema `openapi.yaml`, default `127.0.0.1:40325`.
- Proxy manager: `src-tauri/src/proxy.rs`, UI in `src/App.tsx`.
- ProxyPool sidecar: `proxypool_service/proxypool_service/*.py`, tests in `proxypool_service/tests`.
- ProxyPool Tauri bridge: `src-tauri/src/proxypool.rs`, settings in `src-tauri/src/settings.rs`.
- Windows helper scripts: `smart launch/*.bat`, cleanup helper `cleanup-proxypool.ps1`.
- Docs: `README.md`, `README.vn.md`, ProxyPool spec/plan under `docs/superpowers`.
- SDKs: `sdks/python`, `sdks/node`, MCP server in `mcp`.

For more detail, read `references/repo-map.md`.

## Workflow

1. Run `rg --files` or targeted `rg` first. Prefer local patterns over new abstractions.
2. For UI behavior, inspect `src/App.tsx` state/types/handlers and matching CSS before changing.
3. For Tauri commands, update Rust handler, `invoke_handler!`, TypeScript invoke call, and settings/store structs together.
4. For ProxyPool, keep Python API, scheduler/storage tests, Tauri bridge, and UI table/actions aligned.
5. Preserve user changes in dirty worktree. Never revert unrelated files.
6. Verify with focused commands from `references/commands.md`.

## ProxyPool Rules

- Redis default used by helper scripts: `redis://:madpool@127.0.0.1:6380/0`.
- Sidecar API default: `http://127.0.0.1:40326`.
- UI `Collect now` queues `/jobs/collect`; `Refresh` queues `/jobs/check` and polling reloads table.
- Working proxies must come from stored, checked records. Keep `country`, `https`, `latency_ms`, `source`, `last_checked_at` visible when available.
- Custom sources live in launcher settings as `proxypool_custom_sources`; service accepts `POST /sources`.
- Valid custom source parser values: `text`, `table`, `geonode_json`.

## Command Habits

- On Windows PowerShell use `npm.cmd`, not bare `npm`.
- Build app via `npm.cmd run build`, then `npm.cmd run tauri build` or `smart launch\build.bat`.
- Test ProxyPool with `python -m pytest proxypool_service\tests -q` from repo root.
- Start built app with `smart launch\run.bat`; it calls `cleanup-proxypool.ps1` before launching.

## References

- Read `references/repo-map.md` for architecture, ownership, common edit locations.
- Read `references/commands.md` for build/run/test commands and known warnings.
