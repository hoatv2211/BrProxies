# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BrProxies is an anti-detect browser built with Tauri (Rust + React/TypeScript). It provides browser fingerprint spoofing, SOCKS5 proxy integration with UDP relay, multiple automation interfaces (HTTP API, MCP server, Python/Node SDKs), and an Account Keeper subsystem for authorized password rotation.

## Commands

```bash
# Frontend
npm run dev              # Vite dev server (hot reload)
npm run build            # tsc + Vite production build

# Full Tauri app
npm run tauri dev        # Dev with hot reload (Rust + frontend)
npm run tauri build      # Release build (.msi/.dmg/.AppImage) — alias: npm run build:windows

# Tests
npm test                 # Frontend/React unit tests (vitest, src/**/*.test.{ts,tsx} only)
npm run test:extension   # Validate the Chrome ProxyPool extension
npx vitest run src/path/to/File.test.tsx   # Run a single frontend test file

# Automation worker (Account Keeper) — Node's built-in test runner, not vitest
cd automation && node --test tests/account-keeper-flow.test.mjs   # single file
cd automation && npm test                                          # all tests/*.test.mjs
node --test mcp/account-keeper-tools.test.mjs                      # MCP tool tests

# Account Keeper CLI agent (Rust bin) + QA harness
npm run account-keeper:agent -- --input <file> [--output <file>] [--dry-run]
npm run qa:account-keeper-tauri
npm run build:account-keeper-worker   # bundle the Node worker into src-tauri resources
```

Note: `vitest.config.ts` **excludes** `automation/`, `src-tauri/`, and `android_manager/`. Those subsystems have their own runners — vitest covers React code only.

## Architecture

Rust backend (`src-tauri/src/`):

- `api.rs` — HTTP REST API (axum, `127.0.0.1:40325`, JWT Bearer auth)
- `launch.rs` — browser process management
- `profile.rs` — profile CRUD + isolated `user-data-dir`
- `proxy.rs` — proxy management + UDP probe
- `fingerprints.rs` — fingerprint library
- `runtime.rs` — browser binary download/extract
- `cookies.rs` — Chromium cookie import/export (SQLite + AES/DPAPI)
- `mcp_setup.rs` — MCP server download/bootstrap
- `settings.rs` — app settings + JWT token management
- `store.rs` — persistent JSON store (profiles, proxies, folders)
- `account_keeper.rs` / `account_keeper_daemon.rs` — see below
- `bin/account-keeper-agent.rs` — standalone CLI entry (uses `brproxies_launcher_lib::account_keeper_agent`)

Other subsystems (each has its own package/toolchain):

- `src/` — React 19 / TypeScript / Vite frontend
- `automation/` — Node.js Account Keeper worker (Patchright/CDP); provider adapters in `automation/adapters/`
- `mcp/` — MCP server (Node stdio), bridges HTTP API + CDP + Patchright
- `sdks/node/`, `sdks/python/` — client SDKs
- `proxypool_service/` — Python FastAPI + Redis proxy pool
- `android_manager/` — Python FastAPI Android Manager sidecar
- `extension/` — Chrome ProxyPool extension
- `openapi.yaml` — local HTTP API spec

## Key Technical Details

### Browser Runtime

- First launch downloads patched Chromium + Widevine + 170 fingerprint profiles from CDN
- Stored under: `%APPDATA%\brproxies-launcher\` (win), `~/Library/Application Support/brproxies-launcher/` (mac), `~/.config/brproxies-launcher/` (linux)
- Profiles use isolated `user-data-dir` with persistent cookies
- The browser engine is a **closed-source binary, not in this repo**. The launcher (MIT) is open source.

### Cookie Encryption

- macOS/Linux: Chromium v10 format (AES-128-CBC, fixed OSCrypt key via `--use-mock-keychain`)
- Windows: AES-256-GCM with DPAPI key from Local State

### Account Keeper

Windows-only workflow for rotating passwords on operator-owned/authorized accounts (see `docs/account-keeper.md`). One account and one worker at a time; one persistent profile per normalized account.

- The built app runs an **in-process daemon** (`account_keeper_daemon.rs`): FIFO queue, one active job, requests stored in a DPAPI-protected file. Job state survives closing the MCP client.
- Rust launches the profile; the Node worker (`automation/`) connects over **CDP** — it does not launch a separate Playwright browser.
- Rust–worker communication is a line-delimited JSON protocol (`automation/account-keeper-protocol.mjs`, `PROTOCOL_VERSION`). Provider adapters registered in `automation/adapters/registry.mjs` (`fixture-v1`, `openai-chatgpt-v1`).
- TOTP secrets stay in Rust; only a short-lived 6-digit code is sent to the worker when the expected form is visible.
- **Security invariants (enforced, don't break):** MCP/API arguments take local input/output *paths* only — never accounts, passwords, TOTP secrets, cookies, or tokens. Job creation requires `authorize_password_change: true`. Redacted status responses omit paths and all credential fields. The protocol layer rejects forbidden field names.
- Does not solve CAPTCHA/device approval/email verification (surfaces `waiting_manual` for manual completion via `account_keeper_continue_job`), does not support social login, does not export sessions/tokens.

## Agent Guidance Files

`AGENTS.md` (Codex) currently mirrors the *older* version of this file. When changing architecture or commands, keep `AGENTS.md` in sync or note the divergence.

Rust deps: axum, serde, tokio, rusqlite, aes/cbc, reqwest (socks + rustls-tls). Node ≥18 for `automation/` and `mcp/`.
