# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

BrProxies is an anti-detect browser built with Tauri (Rust + React/TypeScript). It provides browser fingerprint spoofing, SOCKS5 proxy integration with UDP relay, and multiple automation interfaces (HTTP API, MCP server, Python/Node SDKs).

## Build Commands

```bash
# Frontend only
npm run dev          # Vite dev server (hot reload)
npm run build        # TypeScript + Vite production build

# Full Tauri app
npm run tauri dev    # Dev with hot reload (Rust + frontend)
npm run tauri build  # Release build (.msi/.dmg/.AppImage)
```

## Architecture

```
BrProxies/
├── src/              # React/TypeScript frontend (Vite)
├── src-tauri/src/    # Rust backend (Tauri)
│   ├── api.rs        # HTTP REST API (axum, port 40325)
│   ├── launch.rs     # Browser process management
│   ├── profile.rs    # Profile CRUD + user-data-dir
│   ├── proxy.rs      # Proxy management + UDP probe
│   ├── fingerprints.rs # Fingerprint library
│   ├── runtime.rs    # Browser binary download/extract
│   ├── cookies.rs    # Chromium cookie import/export (SQLite + AES/DPAPI)
│   ├── mcp_setup.rs  # MCP server download/bootstrap
│   ├── settings.rs   # App settings + JWT token management
│   └── store.rs      # Persistent JSON store (profiles, proxies, folders)
├── mcp/              # MCP server (Node.js stdio)
├── sdks/
│   ├── node/         # brproxies-sdk (Node.js SDK)
│   └── python/       # brproxies (Python SDK)
├── openapi.yaml      # Local HTTP API spec
└── package.json     # Tauri + React dependencies
```

## Key Technical Details

### Browser Runtime

- First launch downloads patched Chromium + Widevine + 170 fingerprint profiles from CDN
- Stored under: `%APPDATA%\brproxies-launcher\` (win), `~/Library/Application Support/brproxies-launcher/` (mac), `~/.config/brproxies-launcher/` (linux)
- Profiles use isolated `user-data-dir` with persistent cookies

### Local HTTP API

- Runs on `127.0.0.1:40325` (configurable)
- JWT Bearer authentication
- Endpoints: profiles (CRUD + start/stop), proxies, fingerprints, folders, cookies

### Cookie Encryption

- macOS/Linux: Chromium v10 format (AES-128-CBC, fixed OSCrypt key via --use-mock-keychain)
- Windows: AES-256-GCM with DPAPI key from Local State

### MCP Server

- Downloads from GitHub and self-installs (mcp_setup.rs)
- Bridges HTTP API + CDP + patchright (stealth Playwright) for AI automation

## Development Notes

- The browser engine is a closed-source binary, not in this repo
- The launcher (MIT licensed) is open source
- Rust dependencies: axum, serde, tokio, rusqlite, aes/cbc, reqwest (with socks + rustls-tls)
