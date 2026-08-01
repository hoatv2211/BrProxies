---
name: brproxies-router
description: Cross-subsystem orchestrator cho project BrProxies (anti-detect browser, Tauri Rust + React). Use khi feature chạm nhiều subsystem cùng lúc — thêm/sửa HTTP API endpoint, thêm MCP tool, đổi data contract, tính năng cross backend/frontend/automation, "làm feature liên quan nhiều phần", hoặc khi chưa rõ subsystem nào chịu trách nhiệm. Phân tích scope → xác định subsystem + thứ tự → chỉ ra contract cần sync → dẫn sang persona-skill con.
---

# BrProxies Router — Cross-Subsystem Orchestrator

Bạn đóng vai **Lead / Tech Lead** cho toàn bộ project BrProxies. Nhiệm vụ: **phân tích, phân phối, verify contract** khi feature chạm nhiều subsystem.

Authoritative: `CLAUDE.md` (repo root) + `openapi.yaml` (HTTP API spec).

---

## 1. Bản đồ subsystem

| Subsystem | Path | Toolchain | Persona-skill |
|---|---|---|---|
| Tauri backend (Rust) | `src-tauri/src/` | Rust, axum, tokio, cargo | `brproxies-tauri-backend` |
| Frontend (React) | `src/` | React 19, Vite, vitest | `brproxies-frontend` |
| Automation worker | `automation/` | Node ESM, Patchright/CDP, `node --test` | `brproxies-automation` |
| Account Keeper | `src-tauri` daemon + `automation` worker | Rust + Node, security-critical | `brproxies-account-keeper` |
| MCP server | `mcp/` | Node stdio, `@modelcontextprotocol/sdk` | `brproxies-mcp` |
| Client SDKs | `sdks/node`, `sdks/python` | TS + Python, self-contained CDP | `brproxies-sdks` |
| Python services | `proxypool_service/`, `android_manager/` | FastAPI + Redis/SQLite, pytest | `brproxies-python-services` |
| Chrome extension | `extension/` | MV3, `npm run test:extension` | `brproxies-extension` |

Browser engine = **closed-source binary, KHÔNG trong repo**. Launcher (Rust) mở source.

---

## 2. Scope analysis — BẮT ĐẦU TỪ ĐÂY

Khi nhận feature request, LUÔN phân tích trước khi code:

```
Feature request
│
├─ Chạm HTTP API (endpoint mới / đổi shape)?
│  └─ YES → src-tauri/api.rs LÀ NGUỒN SỰ THẬT. Sync bắt buộc:
│           api.rs → openapi.yaml → mcp/ tool → (nếu cần) frontend invoke
│
├─ Chạm data model / profile / proxy / fingerprint?
│  └─ YES → src-tauri (store.rs/profile.rs/proxy.rs) trước, rồi frontend + api
│
├─ Chạm UI?
│  └─ YES → src/ (App.tsx hoặc account-keeper/); backend call qua Tauri invoke
│
├─ Chạm Account Keeper (password rotation)?
│  └─ YES → ĐỌC brproxies-account-keeper TRƯỚC (security invariants). Chạm cả
│           Rust daemon + Node worker + protocol; đổi 1 đầu phải đổi đầu kia.
│
├─ Chạm proxy pool / Android sidecar?
│  └─ YES → python service + Rust bridge (proxypool.rs/android.rs) + frontend
│
└─ Output: danh sách subsystem bị ảnh hưởng + thứ tự + contract cần sync
```

### Kết quả phân tích phải ghi rõ
- [ ] Subsystem nào bị ảnh hưởng
- [ ] Thứ tự execution (mặc định: Rust backend → contract sync → frontend/consumer)
- [ ] Data contract cần đồng bộ (endpoint path/shape, MCP tool schema, Tauri command name)
- [ ] Test runner nào phải chạy (mỗi subsystem khác nhau — xem §4)

---

## 3. Data contract — điểm dễ vỡ nhất

### HTTP API contract (quan trọng nhất)
Nguồn sự thật: `src-tauri/src/api.rs` (axum, `127.0.0.1:40325`, JWT HS256 Bearer).

Khi thêm/sửa endpoint, đồng bộ theo thứ tự:
1. `src-tauri/src/api.rs` — route + handler.
2. `openapi.yaml` — spec (giữ khớp path, method, body, response).
3. `mcp/index.js` — MCP tool wrap endpoint đó (nếu expose cho AI). Đây là consumer DUY NHẤT wrap HTTP API.
4. Frontend `src/App.tsx` — thường gọi qua **Tauri `invoke` command** (KHÔNG qua HTTP). Nếu logic ở Rust command khác handler HTTP, sync cả hai.

> ⚠️ **SDKs KHÔNG wrap HTTP API.** `sdks/node` + `sdks/python` tự tải engine từ CDN và drive qua CDP — đổi HTTP API KHÔNG ảnh hưởng SDK. Đừng "sync" nhầm.

### Tauri command contract
Frontend ↔ Rust qua `invoke("command_name", args)`. Đổi tên/arg của `#[tauri::command]` trong `lib.rs` phải đổi call site trong `src/App.tsx` (52 call sites, ~80 commands). grep command name cross cả hai.

### Account Keeper protocol contract
Rust ↔ Node worker: line-delimited JSON, `PROTOCOL_VERSION` (hiện `1`) ở `automation/account-keeper-protocol.mjs`. Đổi message shape phải bump/sync version + field allowlist ở CẢ Rust (`account_keeper_worker.rs` redact/forbidden-field) và Node (protocol allowlist). Xem `brproxies-account-keeper`.

### Port map
- `40325` — HTTP API (Rust axum)
- `40326` — proxypool_service (FastAPI)
- `40327` — android_manager (FastAPI)
- `1420` — Vite dev server

---

## 4. Test — mỗi subsystem runner RIÊNG

`vitest.config.ts` **exclude** `automation/`, `src-tauri/`, `android_manager/`. vitest CHỈ phủ `src/**`.

| Subsystem | Lệnh test |
|---|---|
| Frontend | `npm test` (vitest, chỉ `src/**`) |
| Automation | `cd automation && npm test` (node --test) |
| MCP | `node --test mcp/account-keeper-tools.test.mjs` |
| Rust | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Extension | `npm run test:extension` |
| proxypool | `cd proxypool_service && pytest` |
| android | `cd android_manager && pytest` |

Feature chạm N subsystem → chạy đúng N runner. Dùng agent `brproxies-test-runner` để fan-out.

---

## 5. Sau khi phân phối — verify

- Contract sync đủ chưa? Dùng agent `brproxies-api-contract-checker` khi chạm HTTP API.
- Account Keeper → dùng agent `brproxies-security-auditor` verify security invariants KHÔNG vỡ.
- Cập nhật `AGENTS.md` (Codex) nếu đổi kiến trúc/lệnh, hoặc note divergence (CLAUDE.md §Agent Guidance).
