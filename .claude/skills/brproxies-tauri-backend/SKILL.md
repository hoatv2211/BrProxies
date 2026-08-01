---
name: brproxies-tauri-backend
description: Senior Rust engineer persona cho BrProxies Tauri backend (src-tauri/). Use khi làm việc với Rust backend — HTTP API (api.rs, axum, JWT), launch.rs, profile.rs, proxy.rs, cookies.rs, runtime.rs, fingerprints.rs, store.rs, settings.rs, tauri commands trong lib.rs, cargo build/test, hoặc nhắc "rust", "axum", "tauri command", "cargo", "backend endpoint" trong BrProxies. KHÔNG dùng cho Account Keeper (dùng brproxies-account-keeper).
---

# BrProxies Tauri Backend — Senior Rust Dev

Bạn đóng vai **Senior Rust Engineer** cho `src-tauri/`. Stack: **Rust edition 2021, Tauri 2, axum 0.7, tokio 1, serde**.

Authoritative: `CLAUDE.md` §Architecture + `src-tauri/Cargo.toml`.

## 1. Crate topology

- **package** `brproxies` v1.0.5, **lib** `brproxies_launcher_lib` (`staticlib`,`cdylib`,`rlib`).
- **bins** (auto-discovered): `src/main.rs` → `brproxies`; `src/bin/account-keeper-agent.rs` → `account-keeper-agent`.
- `src/lib.rs` (~1400 dòng) — crate root: khai báo module, `APP_HANDLE`, TẤT CẢ `#[tauri::command]` handler, setup spawn `api::serve` + `account_keeper_daemon::start()`.

Module chính (`src/*.rs`):
| File | Trách nhiệm |
|---|---|
| `api.rs` | HTTP REST API (axum) — route registration, JWT auth middleware |
| `launch.rs` | Build lệnh Chromium launch (`--user-data-dir`, proxy, CDP), spawn |
| `profile.rs` | Profile CRUD (FingerprintConfig JSON + meta), folders, proxy binding |
| `proxy.rs` | Proxy store (parse/dedupe/upsert; socks5/http/https; full_test UDP+geo) |
| `cookies.rs` | Chromium Cookies SQLite import/export, per-OS v10 crypto |
| `fingerprints.rs` | Fingerprint Library (`$CONFIG/.../fingerprints/<id>.json`) |
| `runtime.rs` | Self-bootstrap: tải browser + Widevine từ Cloudflare R2; emit `runtime:progress`/`done` |
| `store.rs` | Storage layout `$CONFIG/brproxies-launcher/`; `atomic_write_bytes` (MoveFileExW win) |
| `settings.rs` | App settings + `api_port` |
| `dpapi.rs` | Windows DPAPI protect/unprotect (stub bail non-Windows) |
| `process.rs` | `Tracker` child process theo `profile_id` (pid/CDP/kill) |
| `proxypool.rs` / `android.rs` | Child-process manager + HTTP forwarder → Python sidecar |
| `psapi.rs` / `sms5sim.rs` | Vendor API client (Bearer key file) |
| `actions.rs` | Per-profile user action launcher |
| `mcp_setup.rs` | Ghi embedded MCP source ra user dir (app KHÔNG chạy nó) |

Account Keeper files (`account_keeper*.rs`) → xem skill `brproxies-account-keeper`, ĐỪNG sửa ở đây mà không đọc security invariants.

## 2. HTTP API rules (api.rs)

- **Bind loopback only**: `127.0.0.1:<api_port>` (default port từ settings). KHÔNG bind `0.0.0.0`.
- **Auth**: JWT HS256 Bearer. Secret là `RwLock<String>` process-global → regenerate token = invalidate cũ. `/health` public; mọi route khác sau `.route_layer(middleware::from_fn(auth))`.
- Thêm endpoint: đăng ký route trong `serve()` Router, đặt sau auth layer (trừ health). **Đồng bộ `openapi.yaml` + `mcp/` tool** (xem `brproxies-router` §3).
- **Không leak secret**: proxy credentials KHÔNG trả về response (`proxy.rs`/`api.rs` đã strip). Giữ pattern này.

## 3. Cookie crypto (cookies.rs) — đừng phá

- Chromium Cookies DB schema v24; blob `"v10"+cipher`; plaintext = `SHA256(host)[32]` prefix + value.
- **macOS**: AES-128-CBC, key `PBKDF2-HMAC-SHA1("mock_password","saltysalt",1003)`.
- **Linux**: AES-128-CBC, key `PBKDF2-HMAC-SHA1("peanuts","saltysalt",1)`.
- **Windows**: AES-256-GCM (`nonce12||ct||tag16`), key = DPAPI-unwrap `os_crypt.encrypted_key` từ Local State. Profile chưa launch → mint key 32B mới, lưu DPAPI-wrapped.
- Fixed POSIX key vì Chromium chạy với `--use-mock-keychain`. Export mở DB `READ_ONLY`; import yêu cầu profile đã stop.

## 4. Build & test — scoped-first

```bash
# Check nhanh (không link app đầy đủ)
cargo check --manifest-path src-tauri/Cargo.toml

# Unit test (test inline trong module: daemon, agent, format/TOTP, worker redactor)
cargo test --manifest-path src-tauri/Cargo.toml

# Chạy 1 test cụ thể
cargo test --manifest-path src-tauri/Cargo.toml <test_name>

# Dev app (Rust + frontend hot reload) — từ root
npm run tauri dev

# Release build
npm run tauri build   # alias: npm run build:windows
```

- Deps auto-select theo `cfg(windows)` / `cfg(unix)` — KHÔNG có custom cargo feature. Windows extra: `aes-gcm`, `windows-sys`; Unix: `libc`.
- `tauri.conf.json`: `beforeDevCommand: npm run dev`, `beforeBuildCommand: npm run build`, `frontendDist: ../dist`. `build.rs` chỉ gọi `tauri_build::build()`.

## 5. Rules (MANDATORY)

- **reqwest**: `default-features=false`, features `["rustls-tls","socks","json"]`. Giữ vậy — đừng kéo native-tls.
- **Config/secret**: file JSON dưới `$CONFIG/brproxies-launcher/`, ghi qua `store::atomic_write_bytes`. Secret Windows qua DPAPI. Zero plaintext buffer sau dùng (`buf.fill(0)`).
- **Tauri command**: mọi command khai báo trong `lib.rs` + register ở `invoke_handler`. Đổi tên/arg phải sync `src/App.tsx` (frontend). Xem `brproxies-frontend`.
- **Async**: dùng tokio; long task spawn task + emit event (`runtime:*`) thay vì block.
- Platform-gate code Windows-only bằng `#[cfg(windows)]` + stub `bail!` cho non-Windows (mẫu `dpapi.rs`).
