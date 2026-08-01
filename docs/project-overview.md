# BrProxies — Project Overview

> **Bản đồ kiến trúc đọc-hiểu-nhanh** cho developer/agent. Đây **không** phải hướng dẫn sử dụng
> (xem [README.md](../README.md) cho phần đó) mà là bản đồ subsystem + luồng dữ liệu + điểm vào.

BrProxies là một anti-detect browser xây trên **Tauri** (Rust backend + React/TypeScript frontend):
spoof fingerprint trình duyệt, tích hợp proxy SOCKS5 kèm UDP relay, nhiều giao diện automation
(HTTP API, MCP server, SDK Node/Python), và subsystem **Account Keeper** để xoay mật khẩu cho
tài khoản được uỷ quyền.

Repo là **monorepo đa toolchain**. Mỗi subsystem có package/toolchain riêng — không dùng chung
một trình test hay build.

---

## 1. Subsystem × Toolchain × Vai trò

| Subsystem | Thư mục | Toolchain | Vai trò |
|-----------|---------|-----------|---------|
| Rust backend | `src-tauri/` | Cargo · axum · tokio · rusqlite | HTTP API, launch browser, profile, proxy, cookies, Account Keeper daemon |
| Frontend | `src/` | React 19 · Vite · TypeScript | UI ứng dụng |
| Automation worker | `automation/` | Node ≥18 · Patchright/CDP | Account Keeper worker + provider adapters |
| MCP server | `mcp/` | Node (stdio) | Bridge HTTP API + CDP + Patchright cho MCP client |
| SDKs | `sdks/node/`, `sdks/python/` | Node / Python | Thư viện client gọi HTTP API |
| ProxyPool | `proxypool_service/` | Python FastAPI + Redis | Dịch vụ proxy pool |
| Android Manager | `android_manager/` | Python FastAPI | Sidecar quản lý Android |
| Extension | `extension/` | Chrome MV3 | Chrome ProxyPool extension |
| Build helpers | `smart launch/`, `redis/`, `scripts/` | .bat / .ps1 / .mjs | Build + bundled Redis (Windows) |

---

## 2. Cây thư mục (top-level + `src-tauri/src/`)

```
BrProxies/
├── src/                      # Frontend React 19 / Vite / TS
├── src-tauri/                # Rust backend (Tauri)
│   └── src/
│       ├── main.rs                    # Tauri entry
│       ├── lib.rs                     # Library root (brproxies_launcher_lib)
│       ├── api.rs                     # HTTP REST API (axum, 127.0.0.1:40325, JWT Bearer)
│       ├── launch.rs                  # Quản lý tiến trình browser
│       ├── profile.rs                 # CRUD profile + isolated user-data-dir
│       ├── proxy.rs                   # Quản lý proxy + UDP probe
│       ├── proxypool.rs               # Tích hợp ProxyPool service
│       ├── fingerprints.rs            # Thư viện fingerprint
│       ├── runtime.rs                 # Tải/giải nén browser binary
│       ├── cookies.rs                 # Import/export cookie Chromium (SQLite + AES/DPAPI)
│       ├── dpapi.rs                   # Windows DPAPI (bảo vệ file state)
│       ├── store.rs                   # JSON store bền vững (profiles, proxies, folders)
│       ├── settings.rs                # App settings + quản lý JWT token
│       ├── mcp_setup.rs               # Tải/bootstrap MCP server
│       ├── actions.rs                 # Hành động UI/automation
│       ├── process.rs / psapi.rs      # Tiện ích tiến trình (Windows)
│       ├── android.rs                 # Cầu nối Android Manager
│       ├── sms5sim.rs                 # Tích hợp SMS provider
│       ├── account_keeper.rs          # Account Keeper: core
│       ├── account_keeper_daemon.rs   # Daemon in-process: FIFO queue, 1 job
│       ├── account_keeper_store.rs    # Lưu request (file DPAPI-protected)
│       ├── account_keeper_worker.rs   # Cầu nối tới Node worker
│       ├── account_keeper_agent.rs    # Logic CLI agent
│       ├── account_keeper_format.rs   # Định dạng input/output
│       └── bin/
│           └── account-keeper-agent.rs   # CLI entry độc lập
├── automation/               # Node Account Keeper worker (Patchright/CDP)
│   └── adapters/             # fixture-v1.mjs, openai-chatgpt-v1.mjs, registry.mjs
├── mcp/                      # MCP server (Node stdio)
├── sdks/node/, sdks/python/  # SDK client
├── proxypool_service/        # Python FastAPI + Redis
├── android_manager/          # Python FastAPI sidecar
├── extension/                # Chrome ProxyPool extension
├── smart launch/             # Build/run scripts (.bat, .ps1) — README phụ thuộc
├── redis/                    # Bundled Windows Redis (exe + conf)
├── scripts/                  # Helper scripts (prepare worker, validator)
├── docs/                     # Tài liệu (account-keeper.md, file này)
├── public/                   # Static assets frontend
└── openapi.yaml              # Spec HTTP API local
```

---

## 3. Account Keeper — Data-flow

Windows-only. Một account + một worker tại một thời điểm; một profile bền vững cho mỗi
account đã normalize. Job state sống sót cả khi đóng MCP client.

```
  MCP client / HTTP API
        │  (chỉ truyền PATH input/output, không truyền credential)
        ▼
  ┌─────────────────────────────────────────┐
  │  Rust daemon (account_keeper_daemon.rs)  │
  │  • FIFO queue, 1 active job              │
  │  • request lưu file DPAPI-protected      │
  │  • TOTP secret Ở LẠI Rust                │
  └─────────────────────────────────────────┘
        │  launch profile (isolated user-data-dir)
        ▼
  ┌─────────────────────────────────────────┐
  │  Browser (Chromium patched)             │
  └─────────────────────────────────────────┘
        ▲  kết nối qua CDP (KHÔNG mở Playwright browser riêng)
        │
  ┌─────────────────────────────────────────┐
  │  Node worker (automation/)              │
  │  • giao thức JSON line-delimited        │
  │    (account-keeper-protocol.mjs)        │
  │  • adapter theo provider (registry.mjs) │
  └─────────────────────────────────────────┘
        │
        ▼
  Provider adapter:  fixture-v1  |  openai-chatgpt-v1
```

**Ranh giới bảo mật (enforced — đừng phá):**

- MCP/API arguments **chỉ nhận path input/output local** — không bao giờ nhận account, password,
  TOTP secret, cookie, hay token.
- Tạo job đòi hỏi `authorize_password_change: true`.
- Status response redacted: bỏ path + mọi field credential.
- Protocol layer **từ chối** các tên field bị cấm.
- **TOTP secret ở lại Rust**; chỉ một mã 6 số ngắn hạn được gửi cho worker khi form kỳ vọng hiển thị.
- File state bảo vệ bằng **DPAPI** (Windows).

Không giải CAPTCHA / device approval / email verification (surfaces `waiting_manual` để hoàn
tất thủ công qua `account_keeper_continue_job`); không hỗ trợ social login; không export session/token.

---

## 4. Entry points & Commands (tra cứu nhanh)

> Tổng hợp từ [CLAUDE.md](../CLAUDE.md). Lưu ý caveat về phạm vi test.

| Mục đích | Lệnh |
|----------|------|
| Frontend dev (hot reload) | `npm run dev` |
| Frontend build | `npm run build` (tsc + Vite) |
| Tauri dev (Rust + frontend) | `npm run tauri dev` |
| Tauri release build | `npm run tauri build` · alias `npm run build:windows` |
| **Test frontend/React** (vitest, **chỉ `src/**`**) | `npm test` |
| Test một file frontend | `npx vitest run src/path/File.test.tsx` |
| Validate Chrome extension | `npm run test:extension` |
| **Test automation worker** (Node built-in, **không phải vitest**) | `cd automation && npm test` |
| Test một file worker | `cd automation && node --test tests/<file>.test.mjs` |
| Test MCP tools | `node --test mcp/account-keeper-tools.test.mjs` |
| Account Keeper CLI agent | `npm run account-keeper:agent -- --input <file> [--output <file>] [--dry-run]` |
| QA harness Account Keeper | `npm run qa:account-keeper-tauri` |
| Bundle Node worker vào resources | `npm run build:account-keeper-worker` |

> ⚠️ **Caveat test:** `vitest.config.ts` **loại trừ** `automation/`, `src-tauri/`, `android_manager/`.
> Vitest **chỉ** phủ React code. Các subsystem khác có runner riêng: `node --test` (automation/mcp),
> `cargo` (Rust), `pytest` (Python), validator (extension).

**Cổng mặc định** (từ `settings.rs`): HTTP API `40325`, ProxyPool + Android Manager có cổng riêng.
API bind `127.0.0.1`, mọi endpoint trừ `/health` cần Bearer JWT (HS256).

---

## 5. Artifact vs Source — tránh nhầm lẫn

Các thứ dưới đây **sinh lúc runtime/build**, KHÔNG phải source, KHÔNG commit (đã `.gitignore`):

| Đối tượng | Loại | Ghi chú |
|-----------|------|---------|
| `dump.rdb`, `*.rdb` | Redis snapshot | Sinh bởi bundled Redis khi chạy |
| `target-codex-check/`, `src-tauri/target/` | Rust build | Có thể ~1GB; tự sinh lại |
| `.brproxies-build-cache/` | Build cache | Xoá an toàn |
| `dist/`, `sdks/node/dist/` | Frontend/SDK build output | |
| `node_modules/`, `mcp/node_modules/`, `automation/node_modules/` | Dependencies | Cần cho dev |
| `account-keeper-input.txt`, `account-keeper-result.json` | Runtime I/O | **Không bao giờ** commit — có thể chứa credential |
| `src-tauri/resources/account-keeper/` | Worker bundle | Sinh bởi `build:account-keeper-worker` |
| `*.venv/`, `__pycache__/`, `*.egg-info/` | Python | |

**Trông "bẩn" nhưng LÀ source — phải giữ** (build workflow phụ thuộc trực tiếp):

- `smart launch/` — `build.bat`, `run.bat`, `run-redis.bat`, `smart-build.ps1` (README hướng dẫn dùng).
- `cleanup-proxypool.ps1` — được `run.bat` gọi để dừng ProxyPool sidecar.
- `redis/*.exe` + `redis/*.conf` — bundled Redis cho ProxyPool trên Windows; `run-redis.bat` khởi động.

---

## 6. Tài liệu liên quan

- [README.md](../README.md) / [README.vn.md](../README.vn.md) — hướng dẫn cài đặt & sử dụng.
- [CLAUDE.md](../CLAUDE.md) — hướng dẫn cho AI agent (kiến trúc, commands, invariants).
- [AGENTS.md](../AGENTS.md) — bản mirror cho Codex (có thể lệch phiên bản với CLAUDE.md).
- [docs/account-keeper.md](account-keeper.md) — chi tiết workflow Account Keeper.
- [openapi.yaml](../openapi.yaml) — spec HTTP API local.
