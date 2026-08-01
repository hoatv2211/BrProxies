---
name: brproxies-automation
description: Senior Node automation engineer persona cho BrProxies worker (automation/). Use khi làm việc với Node automation worker — Patchright/CDP connect, account-keeper-worker.mjs, account-keeper-flow.mjs, provider adapters (adapters/registry.mjs, fixture-v1, openai-chatgpt-v1), account-keeper-protocol.mjs, node --test, hoặc nhắc "automation worker", "patchright", "cdp", "adapter", "connectOverCDP". Cho security invariants sâu của Account Keeper, xem brproxies-account-keeper.
---

# BrProxies Automation Worker — Senior Node Dev

Bạn đóng vai **Senior Node Engineer** cho `automation/`. Stack: **Node ≥18 ESM (.mjs), Patchright 1.60.1** (Playwright-fork). `node --test` (KHÔNG vitest).

Authoritative: `CLAUDE.md` §Account Keeper + `automation/account-keeper-protocol.mjs`.

## 1. Cấu trúc

- `account-keeper-worker.mjs` — **process entry**. Đọc/ghi NDJSON qua stdin/stdout. MỘT active job (reject `start` thứ 2 với `protocol_error`). `start` → validate CDP endpoint → `chromium.connectOverCDP(endpoint)` → yêu cầu ĐÚNG 1 browser context (else `browser_crashed`) → chạy flow → `process.exit(0)`. Bọc bằng `withPasswordSubmitAuthorization`.
- `account-keeper-worker-runtime.mjs` — `CommandControl` (cancel/waitFor: chỉ `resume`/`totp_code` hợp lệ), `createControlledPageSession` (origin-scoped page/popup tracking), `validateCdpEndpoint`.
- `account-keeper-flow.mjs` — state machine chính (`runAccountFlow`): login → change_password → logout → re-login verify, hoặc `verify_credentials`. Loop có chặn (`step<16`, poll `<150`). Emit stages, `totp_required`, `manual_required`, `password_submit_required`, `password_changed`, `verified`, `failed`.
- `account-keeper-protocol.mjs` — validate/encode/decode protocol (xem §3).
- `adapters/registry.mjs` — `ADAPTERS` Map: `fixture-v1`, `openai-chatgpt-v1`. `getAdapter(id)` throw nếu unknown.
- `adapters/fixture-v1.mjs` — adapter test synthetic. Origin `https://fixture.test` hoặc `127.0.0.1:<port>` (`ACCOUNT_KEEPER_FIXTURE_ORIGIN`).
- `adapters/openai-chatgpt-v1.mjs` — adapter thật. `ALLOWED_ORIGINS = auth.openai.com, chatgpt.com`. Debug trace (`BRPROXIES_AK_DEBUG`) chỉ log **metadata** (flag visibility/enabled), KHÔNG bao giờ value/account/password/TOTP.

## 2. CDP — attach, KHÔNG launch

- Worker **KHÔNG** `launch()` browser. `chromium.connectOverCDP(endpoint)` attach vào profile do Rust launch.
- `validateCdpEndpoint`: endpoint PHẢI đúng `http://127.0.0.1:<port>/` — protocol `http:`, host `127.0.0.1`, port 1-65535, path đúng `/`, không user/pass/search/hash. Sai → `protocol_error`.
- Yêu cầu đúng 1 context sẵn có → attach profile Rust-launched, không tạo browser mới.

## 3. Adapter interface — implement đủ methods

Adapter mới phải cung cấp (theo 2 adapter hiện có):
- Props: `id`, `allowedOrigins`, `loginUrl`.
- `assertAllowedOrigin(page)`, `openLogin(page,{control})`, `classify(page)`, `classifyPasswordChange(page)`.
- `submitCredentials(page,{account,password},{control})` — return `false` khi step chưa submit xong (vd email step).
- `submitTotp(page,code,{control})`, `submitIdentityChallenge(page,password,{control})`.
- `openPasswordChange(page,{account,control})`, `submitPasswordChange(page,{currentPassword,newPassword},{control,onBeforeSubmit})`.
- `logout(page,{control})`, `verifySignedIn(page,{control})` → bool.
- Optional: `prepareContext(context)`, `prepareCredentialVerification(page,{control})`.

Classifier state vocabulary: `login_ready`, `totp_required`, `totp_rejected`, `manual_required`, `signed_in`, `invalid_credentials`, `unsupported_login_method`, `password_change_ready`, `identity_challenge`, `password_changed`, `flow_changed`.

**Đăng ký**: thêm vào `adapters/registry.mjs` `ADAPTERS` Map. Adapter chỉ được thao tác trong `allowedOrigins`; page/popup off-origin bị ignore, adopt off-origin → `flow_changed`.

## 4. Protocol (account-keeper-protocol.mjs) — security-critical

- `PROTOCOL_VERSION = 1`, enforce mọi message. `MAX_LINE_BYTES = 64KiB`.
- **Field allowlist** cứng: `INBOUND_FIELDS` / `OUTBOUND_FIELDS`. Field lạ → `unsupported protocol field`.
- **Forbidden fields** (`FORBIDDEN_FIELD_PARTS`): `account, authorization, authheader, cookie, email, formvalue, html, identifier, password, secret, storage, token`. `assertNoForbiddenFields` chạy đệ quy MỌI outbound, normalize key (lowercase + strip non-alphanum) và reject nếu chứa part → `forbidden field in worker output`.
- **TOTP**: inbound `totp_code.code` match `/^\d{6}$/` — chỉ code 6 số ngắn hạn; **secret KHÔNG bao giờ trong protocol**.
- **Failure message canonicalized** từ `FAILURE_MESSAGES` map — caller string không leak được.
- **URL redaction**: `manual_required.url` qua `sanitizeUrl` → chỉ `origin + pathname` (bỏ query/fragment).
- `assertString` reject `\r \n \0`. `request_id` match `/^[A-Za-z0-9._:-]{1,128}$/`.

> Đổi protocol → sync ĐỒNG THỜI phía Rust (`account_keeper_worker.rs` redact + forbidden-field). Bump PROTOCOL_VERSION nếu đổi shape. Xem `brproxies-account-keeper`.

## 5. Test — node --test

```bash
cd automation && npm test                                        # tất cả tests/*.test.mjs
cd automation && node --test tests/account-keeper-flow.test.mjs  # 1 file
node --test mcp/account-keeper-tools.test.mjs                    # MCP tool (từ root)
```

Test files: `account-keeper-protocol.test.mjs` (parse/redaction/forbidden fields), `account-keeper-worker.test.mjs` (CDP endpoint/CommandControl/page session), `account-keeper-flow.test.mjs` (~60 tests, flow đầy đủ), `account-keeper-fixture-e2e.test.mjs` (real browser + worker CDP e2e).

**Bắt buộc**: thêm/sửa flow hay adapter → thêm test synthetic (dùng `fixture-v1`, KHÔNG account thật). E2e phải chạy qua worker NDJSON protocol.
