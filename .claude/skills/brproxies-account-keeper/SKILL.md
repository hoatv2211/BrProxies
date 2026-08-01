---
name: brproxies-account-keeper
description: Security-critical persona cho subsystem Account Keeper của BrProxies (rotation password trên account được ủy quyền). BẮT BUỘC dùng khi chạm account_keeper*.rs, account_keeper_daemon, account-keeper-agent, automation worker flow, adapter password change, MCP account_keeper_* tools, protocol forbidden-field, TOTP handling, DPAPI vault, hoặc nhắc "account keeper", "password rotation", "rotate password", "TOTP", "authorize_password_change". Đọc TRƯỚC khi sửa bất kỳ phần nào — có security invariants enforced không được phá.
---

# BrProxies Account Keeper — Security-Critical

Subsystem Windows-only rotate password trên account **operator-owned / được ủy quyền**. Chạm CẢ Rust daemon và Node worker — đổi 1 đầu phải đồng bộ đầu kia.

Authoritative: `CLAUDE.md` §Account Keeper + `docs/account-keeper.md`.

## 0. SECURITY INVARIANTS — enforced, KHÔNG được phá

Trước bất kỳ thay đổi nào, đảm bảo GIỮ NGUYÊN:

1. **Path-only args**: MCP/API/CLI chỉ nhận local input/output **path** — KHÔNG account, password, TOTP secret, cookie, token inline. `CreateJobRequest` (Rust) + `account_keeper_create_job` (MCP) chỉ có `input_path`/`output_path`/`template`. CLI agent chỉ `--input/--output/--template/--timeout-seconds/--close-profile/--dry-run`.
2. **Authorization gate**: job creation yêu cầu `authorize_password_change: true`. MCP schema là `z.literal(true)` — chỉ nhận `true`. Rust yêu cầu `== true`.
3. **Deny unknown fields**: `CreateJobRequest`/`StartRequest`/`InputSource`/`PreviewRequest` đều `#[serde(deny_unknown_fields)]`. Field credential inline (vd `password`) bị reject (có test).
4. **Redaction**: worker output qua `account_keeper_worker::redact_line` — reject line >64KiB, non-JSON, chứa forbidden field, hoặc failure message non-canonical → `"[redacted worker message]"`.
5. **Forbidden fields** (cả Rust `is_forbidden_field` và Node `FORBIDDEN_FIELD_PARTS`): `account, authorization, authheader, cookie, email, formvalue, html, identifier, password, secret, storage, token`. Normalize alphanumeric + substring match.
6. **Redacted views omit secrets**: `DaemonJobView` bỏ `input_path`/`output_path`/`template`. MCP `redactJob` whitelist chỉ `JOB_FIELDS` (id, status, batch_id, stage, error_code, account_count, has_last_verified_at, created_at, updated_at). `AgentSummary` bỏ identity/secret.
7. **TOTP boundary**: secret ở LẠI Rust (DPAPI vault). Chỉ gửi code 6 số ngắn hạn khi form đúng đang hiện. Protocol `totp_code.code` match `/^\d{6}$/`. Secret KHÔNG bao giờ vào protocol/log.
8. **Password submit authorization**: worker emit `password_submit_required` và CHỜ operator command `submit_password` trước khi gõ password mới (`withPasswordSubmitAuthorization`). Sau authorize, mark `credentialState.unknown=true` → cancel/crash báo `credential_state_unknown`, không đoán.
9. **Account masking**: DTO chỉ expose `masked_account` (`f***@domain`). `mask_account` ở `account_keeper_format.rs`.
10. **Scope refusal**: KHÔNG solve CAPTCHA/device-approval/email-verify (→ `waiting_manual`, chờ `account_keeper_continue_job`). KHÔNG social login. KHÔNG export session/token.

Sau khi sửa → chạy agent `brproxies-security-auditor` verify các invariant trên.

## 1. Kiến trúc — Rust ↔ Node

```
MCP client / API / CLI  ──path only──▶  Rust daemon (account_keeper_daemon.rs)
                                          │ FIFO queue, 1 active job
                                          │ DPAPI-protected state file
                                          ▼
                        Rust launch profile (Chromium + CDP)
                                          │ CDP endpoint http://127.0.0.1:<port>/
                                          ▼
                        Node worker (automation/) ──connectOverCDP──▶ profile
                        line-delimited JSON, PROTOCOL_VERSION=1
```

### Rust side (`src-tauri/src/`)
- `account_keeper.rs` (~4686 dòng) — engine: job/batch state machine, orchestrate worker, TOTP/password flow, validation. Input cap `ACCOUNT_KEEPER_INPUT_LIMIT = 16 MiB`.
- `account_keeper_daemon.rs` — FIFO `VecDeque<DaemonJob>`; `next_queued_job` chỉ trả job queued khi KHÔNG có job `running`/`waiting_manual`/`recovery_required` (one active). `start()` spawn 1 task, tick 500ms. Restart → mark active job `recovery_required`, `resume_job` re-attach. State qua `dpapi::protect`/`unprotect`, zero buffer sau dùng.
- `account_keeper_worker.rs` — embed Node resource; `redact_line` + forbidden-field reject; ghi worker file.
- `account_keeper_format.rs` — parse/normalize account, `mask_account`, password template, TOTP (`totp_now` = base32 decode + HMAC-SHA1 HOTP, window 30s).
- `account_keeper_store.rs` — DPAPI vault + checkpoint (`PasswordState`, `VaultFile`, `BatchOutput`), schema v1.
- `account_keeper_agent.rs` + `bin/account-keeper-agent.rs` — CLI entry, path-only, dry-run, exit 0/1/2.

### Node side (`automation/`) → xem `brproxies-automation`
Worker + flow + protocol + adapters. TOTP chỉ nhận code 6 số; password submit cần authorize.

## 2. Protocol contract (dễ vỡ)

Đổi message shape → sync ĐỒNG THỜI:
- Node `account-keeper-protocol.mjs`: `INBOUND_FIELDS`/`OUTBOUND_FIELDS` allowlist + `PROTOCOL_VERSION`.
- Rust `account_keeper_worker.rs`: `redact_line` / forbidden-field / canonical failure message.

Bump `PROTOCOL_VERSION` khi đổi shape. Thêm field mới → cân nhắc nó KHÔNG được là (hoặc chứa) forbidden part.

## 3. Test — cả hai phía

```bash
# Rust
cargo test --manifest-path src-tauri/Cargo.toml            # daemon/agent/format/worker-redactor

# Node worker
cd automation && npm test
cd automation && node --test tests/account-keeper-flow.test.mjs

# MCP tool redaction
node --test mcp/account-keeper-tools.test.mjs

# QA harness end-to-end
npm run qa:account-keeper-tauri

# CLI agent (dry-run an toàn)
npm run account-keeper:agent -- --input <file> --dry-run
```

Test hiện có assert: FIFO one-active-slot, reject inline credential field, view omit secret path, TOTP không lộ base32, manual URL redaction, canonical failure, MCP redaction (`must-not-leak`, `C:/secret/input.txt` vắng mặt). **Thêm test cho mọi thay đổi security-touching** — dùng `fixture-v1`, account synthetic.

## 4. Khi thêm adapter provider mới

1. Implement adapter interface (xem `brproxies-automation` §3), đăng ký `adapters/registry.mjs`.
2. `allowedOrigins` chặt — chỉ origin provider.
3. Debug trace (nếu có) chỉ log metadata, KHÔNG value.
4. Thêm flow test synthetic + (nếu được) e2e.
5. KHÔNG mở rộng protocol để mang credential — giữ path-only + TOTP-code-only.
