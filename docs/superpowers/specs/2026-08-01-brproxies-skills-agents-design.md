# BrProxies — Project-Specific Skills & Agents

Date: 2026-08-01
Status: Approved, implementing

## Goal

Bộ skills (persona senior-dev) + agents chuyên biệt cho project BrProxies, theo mô hình
JX workspace (persona per subsystem + 1 router orchestrator). Lưu project-local trong
`.claude/`, commit vào repo.

## Scope

Phủ toàn bộ subsystem. Nội dung viết dựa trên đọc code thực tế từng subsystem
(Cargo.toml, package.json, source chính) — không chỉ CLAUDE.md.

## Deliverables

### Skills — `.claude/skills/<name>/SKILL.md`

| Skill | Phủ | Toolchain |
|---|---|---|
| `brproxies-router` | Orchestrator cross-subsystem | Decision tree, data-contract sync (HTTP API ↔ MCP ↔ SDK ↔ OpenAPI) |
| `brproxies-tauri-backend` | `src-tauri/src/*` | Rust, axum, tokio, JWT, cargo scoped build |
| `brproxies-frontend` | `src/` | React 19 / TS / Vite / vitest |
| `brproxies-automation` | `automation/` | Node worker, Patchright/CDP, adapters, protocol |
| `brproxies-account-keeper` | Rust daemon + Node worker | Security invariants, protocol, TOTP boundary, adapter registry |
| `brproxies-mcp` | `mcp/` | MCP stdio server, bridge HTTP+CDP |
| `brproxies-sdks` | `sdks/node`, `sdks/python` | Client SDK parity vs openapi.yaml |
| `brproxies-python-services` | `proxypool_service/`, `android_manager/` | FastAPI + Redis |
| `brproxies-extension` | `extension/` | Chrome ProxyPool ext, test:extension |

### Agents — `.claude/agents/<name>.md`

| Agent | Dùng khi | Tools |
|---|---|---|
| `brproxies-security-auditor` | Review Account Keeper security invariants | read-only + Grep |
| `brproxies-api-contract-checker` | Verify parity HTTP API ↔ openapi.yaml ↔ SDK ↔ MCP | read-only |
| `brproxies-test-runner` | Fan-out chạy đúng runner mỗi subsystem | Bash + read |

## Skill common structure

Mỗi persona-skill gồm:
1. Frontmatter `name` + `description` (trigger keywords tiếng Việt + tên module/file).
2. Module topology thực tế (path, trách nhiệm từng file/module).
3. Build/test workflow — scoped-first (chạy scope nhỏ trước).
4. Architectural rules (MANDATORY / enforced invariants).
5. Security invariants nơi liên quan.
6. Cross-subsystem contract pointers (link sang skill khác + file contract).

## Key invariants phải encode đúng

- **Account Keeper security** (từ CLAUDE.md, enforced): MCP/API args chỉ nhận local
  input/output *paths* — không account/password/TOTP/cookie/token. Job creation cần
  `authorize_password_change: true`. Redacted status bỏ paths + mọi credential field.
  Protocol layer reject forbidden field names. TOTP secret ở lại Rust; chỉ gửi code
  6 số ngắn hạn khi form hiện đúng.
- **HTTP API**: axum, `127.0.0.1:40325`, JWT Bearer.
- **Cookie encryption**: mac/linux Chromium v10 AES-128-CBC mock-keychain; win AES-256-GCM DPAPI.
- **Test runner tách biệt**: vitest chỉ React (`src/**`); automation dùng `node --test`;
  Rust dùng cargo; extension dùng `npm run test:extension`. vitest.config.ts EXCLUDE
  automation/, src-tauri/, android_manager/.
- **Browser engine** là closed-source binary, KHÔNG trong repo.

## Router responsibility

`brproxies-router` là entry cho feature chạm nhiều subsystem. Phân tích scope →
xác định subsystem bị ảnh hưởng + thứ tự → chỉ ra data contract cần sync → dẫn sang
persona-skill con. Đặc biệt cảnh báo khi thay đổi HTTP API cần đồng bộ:
`api.rs` → `openapi.yaml` → `sdks/*` → `mcp/` tools.

## Non-goals

- Không refactor code project.
- Không tạo skill cho toolchain không tồn tại trong repo.
- Không đụng AGENTS.md (Codex) — chỉ note nếu divergence.
