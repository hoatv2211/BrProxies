# Account Keeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-only Account Keeper inside BrProxies that imports `account|password|totp_secret` records, maps each account to one persistent profile, generates TOTP locally, changes and verifies passwords sequentially, checkpoints progress, and exports plaintext JSON.

**Architecture:** React owns only redacted UI state. A Rust coordinator owns parsing, DPAPI persistence, password/TOTP generation, profile mapping, job state, output writes, and the child-process lifecycle. A provisioned Node/Patchright worker connects to the existing profile CDP endpoint and performs semantic browser interactions without exporting sessions or bypassing security challenges.

**Tech Stack:** Tauri 2, Rust 2021, Tokio, serde/serde_json, HMAC-SHA1, Windows DPAPI, React 19, TypeScript 5.8, Vitest, Node 18+, Patchright, newline-delimited JSON over stdio.

---

## Execution Notes

- Preserve pre-existing user changes in `src/App.tsx`, `src-tauri/src/lib.rs`, `src-tauri/src/actions.rs`, Android Manager files, `dump.rdb`, and smart-build scripts.
- Do not stage or commit unrelated hunks. Commit checkpoints assume selective staging or a clean follow-up worktree.
- Never copy credentials from chat or screenshots into code, fixtures, tests, docs, or command history.
- Automated tests use synthetic local data only and never contact OpenAI, `2fa.live`, or an email provider.
- Stop on CAPTCHA, device approval, email verification, or an unknown security challenge. No solver or bypass belongs in this feature.

## File Map

**Rust core**

- Create `src-tauri/src/account_keeper_format.rs`: input parsing, masking, Base32, TOTP, password templates, secure generation, and output DTOs.
- Create `src-tauri/src/account_keeper_store.rs`: DPAPI vault, atomic checkpoints, output JSON, and resumable-job reads.
- Create `src-tauri/src/account_keeper_worker.rs`: worker provisioning, Node discovery, stdio protocol, redaction, and child lifecycle.
- Create `src-tauri/src/account_keeper.rs`: job state machine, profile mapping, coordinator, Tauri commands, controls, and events.
- Create `src-tauri/src/dpapi.rs`: shared Windows DPAPI protect/unprotect wrapper.
- Modify `src-tauri/src/store.rs`: Account Keeper config paths.
- Modify `src-tauri/src/cookies.rs`: use the shared DPAPI wrapper without changing Chromium cookie formats.
- Modify `src-tauri/src/lib.rs`: module and Tauri command registration without disturbing current action-plugin edits.
- Modify `src-tauri/Cargo.toml`: make `getrandom` available to the cross-platform module while keeping DPAPI Windows-only.

**Node worker**

- Create `automation/package.json` and `automation/package-lock.json`: isolated Patchright package.
- Create `automation/node-runtime.json`: pinned official Windows x64 Node LTS version and artifact metadata.
- Create `automation/account-keeper-protocol.mjs`: schemas, size limits, URL sanitization, and secret-field rejection.
- Create `automation/account-keeper-flow.mjs`: semantic login, TOTP, manual challenge, password change, logout, and re-login flow.
- Create `automation/account-keeper-worker.mjs`: CDP connection and stdio loop.
- Create `automation/adapters/registry.mjs`: explicit adapter selection.
- Create `automation/adapters/openai-chatgpt-v1.mjs`: fixed ChatGPT/OpenAI origins and semantic page states.
- Create `automation/adapters/fixture-v1.mjs`: synthetic test adapter.
- Create `automation/fixtures/account-keeper-fixture-server.mjs`: reusable loopback fixture with RFC 6238 TOTP and manual-challenge controls.
- Create `automation/tests/account-keeper-protocol.test.mjs`: protocol tests.
- Create `automation/tests/account-keeper-flow.test.mjs`: synthetic page-adapter tests.
- Create `automation/tests/account-keeper-fixture-e2e.test.mjs`: loopback persistent-context CDP tests.
- Create `automation/qa/account-keeper-tauri-qa.mjs`: isolated full-Tauri synthetic workflow QA.
- Create `scripts/prepare-account-keeper-worker.mjs`: stage Node, Patchright, worker files, licenses, and manifest.
- Create `src-tauri/tauri.windows.conf.json`: bundle staged Account Keeper resources.
- Modify `package.json`: add the root `qa:account-keeper-tauri` command.
- Modify `.gitignore`: exclude generated `src-tauri/resources/account-keeper` runtime files.
- Modify `smart launch/smart-build.ps1`: hash the worker package and preparation inputs without disturbing current dirty edits.

**Frontend**

- Create `src/account-keeper/types.ts`: redacted Tauri DTOs and state unions.
- Create `src/account-keeper/model.ts`: pure reducer and UI guards.
- Create `src/account-keeper/model.test.ts`: reducer, revision, and warning-gate tests.
- Create `src/account-keeper/AccountKeeper.tsx`: integrated page plus a DEV-only synthetic QA bridge.
- Create `src/account-keeper/AccountKeeper.css`: dense operational layout.
- Modify `src/App.tsx`: add the `accountKeeper` section, sidebar entry, and view.
- Modify `package.json` and `package-lock.json`: add Vitest and frontend test dependencies.

**Documentation**

- Create `docs/account-keeper.md`: English setup, formats, flow, recovery, security, and troubleshooting.
- Create `docs/account-keeper.vn.md`: Vietnamese usage guide.
- Modify `README.md` and `README.vn.md`: link guides and prerequisites.

### Task 1: Parse Input, Generate TOTP, And Build Passwords

**Files:**
- Create: `src-tauri/src/account_keeper_format.rs`
- Modify: `src-tauri/src/lib.rs:3-18`
- Modify: `src-tauri/Cargo.toml:20-55`
- Test: inline `#[cfg(test)]` module

- [x] **Step 1: Write failing parser tests**

```rust
#[test]
fn parses_password_containing_pipe() {
    let rows = parse_input("owner@example.test|part|two|JBSWY3DPEHPK3PXP\n").unwrap();
    assert_eq!(rows[0].current_password, "part|two");
}

#[test]
fn duplicate_error_redacts_secrets() {
    let error = parse_input("A@x.test|alpha|JBSWY3DPEHPK3PXP\na@x.test|beta|JBSWY3DPEHPK3PXP")
        .unwrap_err().to_string();
    assert!(error.contains("duplicate account"));
    assert!(!error.contains("alpha"));
    assert!(!error.contains("JBSWY3DPEHPK3PXP"));
}
```

- [x] **Step 2: Verify parser RED**

Run `cargo test --manifest-path src-tauri\Cargo.toml account_keeper_format::tests`; expect compilation failure because `parse_input` is missing.

- [x] **Step 3: Implement parser and masking**

Define:

```rust
pub struct ImportedAccount {
    pub line: usize,
    pub account: String,
    pub normalized_account: String,
    pub current_password: String,
    pub totp_secret: String,
}

pub fn parse_input(text: &str) -> anyhow::Result<Vec<ImportedAccount>>;
pub fn normalize_account(value: &str) -> String;
pub fn mask_account(value: &str) -> String;
```

Use the first and last delimiters, preserve password bytes, trim account/secret, skip blank/comment lines, validate non-empty Base32, and reject normalized duplicates without echoing secrets.

- [x] **Step 4: Verify parser GREEN**

Run `cargo test --manifest-path src-tauri\Cargo.toml account_keeper_format::tests`; expect parser, masking, validation, and duplicate tests to pass.

- [x] **Step 5: Write failing template and TOTP tests**

```rust
#[test]
fn template_requires_one_random_placeholder() {
    assert!(PasswordTemplate::parse("BrP@{random:16}!").is_ok());
    assert!(PasswordTemplate::parse("fixed").is_err());
}

#[test]
fn matches_rfc_6238_sha1_vector() {
    assert_eq!(totp_from_bytes_at(b"12345678901234567890", 59, 8).unwrap(), "94287082");
}
```

- [x] **Step 6: Verify template/TOTP RED**

Run the two named tests; expect missing `PasswordTemplate` and `totp_from_bytes_at`.

- [x] **Step 7: Implement secure generation and TOTP**

Define `RandomSource`, `OsRandom`, `PasswordTemplate::parse`, `PasswordTemplate::generate`, `decode_base32`, `totp_now`, and `totp_from_bytes_at`. Move `getrandom = "0.2"` to general dependencies. Use existing HMAC-SHA1, a 30-second counter, six production digits, and RFC test-vector support.

- [x] **Step 8: Verify all format tests GREEN**

Run `cargo test --manifest-path src-tauri\Cargo.toml account_keeper_format::tests`; expect all tests to pass.

- [x] **Step 9: Commit checkpoint intentionally skipped**

Checkpoint intentionally skipped; no commit requested.

### Task 2: Persist Vault, Checkpoints, And Output

**Files:**
- Create: `src-tauri/src/account_keeper_store.rs`
- Create: `src-tauri/src/dpapi.rs`
- Modify: `src-tauri/src/cookies.rs:155-230`
- Modify: `src-tauri/src/store.rs:1-110`
- Modify: `src-tauri/src/lib.rs:3-20`
- Test: inline tests in `account_keeper_store.rs`

- [x] **Step 1: Write failing atomic-write and checkpoint-redaction tests**

```rust
#[test]
fn atomic_json_write_replaces_destination() {
    let path = test_dir("output").join("result.json");
    atomic_write_json(&path, &serde_json::json!({"version": 1})).unwrap();
    atomic_write_json(&path, &serde_json::json!({"version": 2})).unwrap();
    let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(value["version"], 2);
}

#[test]
fn checkpoint_json_contains_no_password_or_totp_fields() {
    let text = serde_json::to_string(&synthetic_checkpoint()).unwrap();
    assert!(!text.contains("password"));
    assert!(!text.contains("totp_secret"));
}
```

- [x] **Step 2: Verify store RED**

Run `cargo test --manifest-path src-tauri\Cargo.toml account_keeper_store::tests`; expect missing store types/functions.

- [x] **Step 3: Add Account Keeper paths and atomic JSON**

Add `account_keeper_dir`, `account_keeper_vault_path`, `account_keeper_jobs_dir`, and `account_keeper_worker_dir` to `store.rs`. Implement `atomic_write_json<T: Serialize>` with a same-directory temp file. On Windows replace with `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`; add the required `Win32_Storage_FileSystem` feature. Never delete the existing destination before the replacement succeeds.

- [x] **Step 4: Write failing Windows DPAPI round-trip test**

```rust
#[test]
#[cfg(windows)]
fn dpapi_vault_round_trips_without_plaintext_on_disk() {
    let path = test_dir("vault").join("vault.bin");
    let vault = VaultFile::single(synthetic_vault_account());
    save_vault_to(&path, &vault).unwrap();
    assert!(!String::from_utf8_lossy(&std::fs::read(&path).unwrap()).contains("synthetic-password"));
    assert_eq!(load_vault_from(&path).unwrap(), vault);
}
```

- [x] **Step 5: Extract shared DPAPI and implement vault models**

Move the private unsafe DPAPI call from `cookies.rs` into `dpapi.rs` as `pub(crate) fn protect` and `unprotect`; keep cookie AES-GCM and Chromium `Local State` behavior unchanged. Define `PasswordState::{Original, Changed, Unknown}`, `VaultAccount`, `VaultFile`, `JobCheckpoint`, `AccountCheckpoint`, `BatchOutput`, and `OutputAccount`. Encrypt the complete Account Keeper vault directly with DPAPI. Non-Windows calls return `Account Keeper is supported on Windows only`.

- [x] **Step 6: Implement public persistence API**

Provide `load_vault`, `save_vault`, `load_job`, `save_job`, `list_jobs`, `write_output`, and test-only path variants. Output records contain the current known password and TOTP secret; checkpoints contain only account keys, profile IDs, states, attempts, timestamps, and errors.

- [x] **Step 7: Verify store GREEN**

Run `cargo test --manifest-path src-tauri\Cargo.toml account_keeper_store::tests`; expect atomic writes, DPAPI, checkpoint redaction, and output-state tests to pass.

- [x] **Step 8: Commit checkpoint intentionally skipped**

Checkpoint intentionally skipped; no commit requested.

### Task 3: Define And Provision The Node Worker

**Files:**
- Create: `automation/package.json`
- Create: `automation/node-runtime.json`
- Create: `automation/account-keeper-protocol.mjs`
- Create: `automation/tests/account-keeper-protocol.test.mjs`
- Create: `src-tauri/src/account_keeper_worker.rs`
- Modify: `src-tauri/src/lib.rs:3-22`

- [x] **Step 1: Write failing Node protocol tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { parseInbound, sanitizeOutbound } from "../account-keeper-protocol.mjs";

test("rejects outbound secret fields", () => {
  assert.throws(() => sanitizeOutbound({ type: "stage", password: "secret" }), /forbidden field/);
});

test("removes query and fragment from manual URL", () => {
  const message = sanitizeOutbound({ type: "manual_required", url: "https://example.test/path?token=x#frag" });
  assert.equal(message.url, "https://example.test/path");
});
```

- [x] **Step 2: Verify protocol RED**

Run `node --test automation/tests/account-keeper-protocol.test.mjs`; expect module-not-found.

- [x] **Step 3: Implement protocol schemas and package metadata**

Create an ESM package with `patchright` pinned to `1.60.1`, already used by the repository's Node SDK lockfile. Implement newline-delimited JSON parsing, protocol version `1`, a 64 KiB line limit, required request IDs, explicit adapter IDs, message-type allowlists, recursive forbidden secret-field checks, and URL origin/pathname sanitization.

- [x] **Step 4: Verify protocol GREEN**

Run `node --test automation/tests/account-keeper-protocol.test.mjs`; expect all protocol tests to pass without installing Patchright because the protocol module has no browser import.

- [x] **Step 5: Write failing Rust provisioner tests**

```rust
#[test]
fn provision_writes_embedded_worker_files() {
    let dir = test_dir("worker");
    provision_worker_to(&dir).unwrap();
    assert!(dir.join("account-keeper-worker.mjs").exists());
    assert!(dir.join("package.json").exists());
}

#[test]
fn redactor_removes_protocol_secrets() {
    assert_eq!(redact_line(r#"{"password":"x","type":"failed"}"#), "[redacted worker message]");
}
```

- [x] **Step 6: Implement worker provisioning and Node discovery**

Resolve bundled resources under `account-keeper/node/node.exe` and `account-keeper/worker/account-keeper-worker.mjs`. In debug builds only, allow a system-Node fallback plus the repository `automation` directory. Reject missing resources with a setup error; never run `npm install` from the installed desktop app.

- [x] **Step 7: Verify Rust worker tests GREEN**

Run `cargo test --manifest-path src-tauri\Cargo.toml account_keeper_worker::tests`; expect provisioning and redaction tests to pass.

- [x] **Step 8: Install and stage isolated worker dependencies**

Run `npm.cmd install --prefix automation` with Patchright/Playwright browser downloads disabled. Add `automation/node-runtime.json` with the verified current Windows x64 Node LTS artifact. Implement `scripts/prepare-account-keeper-worker.mjs` to use `npm ci --omit=dev --ignore-scripts`, stage Patchright and Patchright Core, download from the official Node distribution, verify SHA-256 against `SHASUMS256.txt`, copy Node's license, and write a manifest. Add root scripts `build:account-keeper-worker` and `build:windows`; the Windows Tauri config bundles the generated resources and `.gitignore` excludes them.

- [x] **Step 9: Commit checkpoint intentionally skipped**

Checkpoint intentionally skipped; no commit requested.

### Task 4: Implement The Semantic Browser Flow

**Files:**
- Create: `automation/account-keeper-flow.mjs`
- Create: `automation/account-keeper-worker.mjs`
- Create: `automation/adapters/registry.mjs`
- Create: `automation/adapters/openai-chatgpt-v1.mjs`
- Create: `automation/adapters/fixture-v1.mjs`
- Create: `automation/tests/account-keeper-flow.test.mjs`

- [x] **Step 1: Write failing synthetic flow tests**

Use a fake page adapter that records semantic actions. Cover direct login, TOTP request, password change, normal logout/re-login, CAPTCHA/manual pause, unsupported social login, changed-page refusal, and explicit adapter selection. Assert that no worker result contains cookies, storage, tokens, HTML, form values, accounts, or full URLs.

- [x] **Step 2: Verify flow RED**

Run `npm.cmd test --prefix automation`; expect missing flow exports.

- [x] **Step 3: Implement semantic flow helpers**

Define the adapter contract with `allowedOrigins`, `openLogin`, `classify`, `submitCredentials`, `submitTotp`, `openPasswordChange`, `submitPasswordChange`, `logout`, and `verifySignedIn`. Implement `fixture-v1` first. Implement `openai-chatgpt-v1` for the fixed `chatgpt.com` and `auth.openai.com` origins using roles, labels, autocomplete attributes, and explicit semantic states only. Unknown structure returns `flow_changed`; no coordinate or generic-text guessing.

- [x] **Step 4: Implement the worker stdio loop**

Import `chromium` from Patchright, reject any CDP endpoint not matching `http://127.0.0.1:<valid-port>`, call `chromium.connectOverCDP`, require the existing persistent context, and open the adapter's fixed login URL in a controlled page. Process `start`, `totp_code`, `resume`, and `cancel`; emit only protocol-approved messages. Disconnect the client on terminal state while Rust controls the real profile process.

- [x] **Step 5: Verify flow GREEN**

Run `npm.cmd test --prefix automation`; expect protocol and synthetic flow tests to pass without contacting production services.

- [x] **Step 6: Commit checkpoint intentionally skipped**

Checkpoint intentionally skipped; no commit requested.

### Task 5: Coordinate Jobs, Profiles, Worker Controls, And Events

**Files:**
- Create: `src-tauri/src/account_keeper.rs`
- Modify: `src-tauri/src/lib.rs:3-22,1138-1225`
- Reuse: `src-tauri/src/fingerprints.rs`, `profile.rs`, `launch.rs`, `process.rs`
- Test: inline tests in `account_keeper.rs`

- [x] **Step 1: Write failing state-machine tests**

```rust
#[test]
fn password_submission_then_failed_verification_becomes_critical() {
    let mut state = AccountRunState::new("account-key");
    state.transition(AccountEvent::PasswordAccepted).unwrap();
    state.transition(AccountEvent::VerificationFailed).unwrap();
    assert_eq!(state.stage, AccountStage::Critical);
    assert_eq!(state.password_state, PasswordState::Unknown);
}

#[test]
fn critical_account_stops_the_batch() {
    let mut job = synthetic_job();
    job.accounts[0].stage = AccountStage::Critical;
    assert!(!job.can_process_next());
}
```

- [x] **Step 2: Verify coordinator RED**

Run `cargo test --manifest-path src-tauri\Cargo.toml account_keeper::tests`; expect missing coordinator types.

- [x] **Step 3: Implement state and redacted DTOs**

Define `AccountStage`, `AccountEvent`, `AccountRunState`, `JobControl::{Continue, MarkFailed, Cancel}`, `PreviewRequest`, `StartRequest`, `AccountKeeperPreview`, `JobView`, `AccountView`, and `ProgressEvent`. Keep the transition engine independently constructible behind injected `Clock`, `ProfileRuntime`, `WorkerTransport`, and `EventSink` traits. UI DTOs contain masked accounts, profile IDs, stages, attempts, timestamps, and redacted errors only.

- [x] **Step 4: Implement preview and profile mapping**

`account_keeper_validate_input` reads the selected file and calls `parse_input`; `account_keeper_validate_template` parses only the template. Both return redacted counts/errors. On start, merge imports into the DPAPI vault. Reuse a stored profile ID or select the first Windows fingerprint from `fingerprints::list_all`, build `Value::Object(crate::merge_library_fingerprint(&template.id)?)`, insert the masked `name`, call `crate::save_profile_core(Some(&window), payload, true)`, then call `profile::set_folder(&meta.id, "Account Keeper")` and persist the mapping.

- [x] **Step 5: Implement the background run loop**

Use a process-global Tokio mutex containing only the active job ID and control sender; never hold it across browser launch or worker I/O. Spawn one account at a time. If the profile is already running without CDP, call `Tracker::kill` and poll until its tracker entry disappears before relaunching. Launch with `launch::launch_profile(profile_id, true, false)`, reconcile tracker state if launch returns an error after spawn, require a CDP endpoint, and stop the browser before retrying a CDP timeout. Provision/spawn the worker, answer `totp_required` with `totp_now`, checkpoint credential-sensitive transitions, and emit `account-keeper:progress` through `tauri::Emitter`.

- [x] **Step 6: Implement manual and critical controls**

On `manual_required`, save `WaitingManual`, emit the event, and wait for `Continue`, `MarkFailed`, or `Cancel`. On `password_changed`, persist only `PasswordState::Unknown` in the checkpoint until `verified`. On verification failure, stop the batch, preserve the profile, and require manual recovery.

- [x] **Step 7: Register Tauri commands**

Register module-qualified commands:

```rust
account_keeper::account_keeper_validate_input,
account_keeper::account_keeper_validate_template,
account_keeper::account_keeper_start_batch,
account_keeper::account_keeper_list_jobs,
account_keeper::account_keeper_get_job,
account_keeper::account_keeper_pause_after_current,
account_keeper::account_keeper_cancel_batch,
account_keeper::account_keeper_continue_manual,
account_keeper::account_keeper_mark_failed,
account_keeper::account_keeper_resume_job,
account_keeper::account_keeper_abandon_job,
account_keeper::account_keeper_export_result,
account_keeper::account_keeper_open_profile,
```

- [x] **Step 8: Verify coordinator GREEN**

Run `cargo test --manifest-path src-tauri\Cargo.toml account_keeper::tests`; expect transitions, critical-stop, redaction, profile-map selection, and control tests to pass.

- [x] **Step 9: Commit checkpoint intentionally skipped**

Checkpoint intentionally skipped; no commit requested.

### Task 6: Add The Account Keeper React Screen

**Files:**
- Create: `src/account-keeper/types.ts`
- Create: `src/account-keeper/model.ts`
- Create: `src/account-keeper/model.test.ts`
- Create: `src/account-keeper/AccountKeeper.tsx`
- Create: `src/account-keeper/AccountKeeper.css`
- Modify: `src/App.tsx:1-8,268,780-875`
- Modify: `package.json`, `package-lock.json`

- [x] **Step 1: Install frontend test dependencies**

Run:

```powershell
npm.cmd install --save-dev vitest@2.1.9 jsdom@25.0.1 @testing-library/react@16.1.0 @testing-library/user-event@14.5.2 @testing-library/jest-dom@6.6.3
```

Add `"test": "vitest run"` to scripts and create `vitest.config.ts` with jsdom. Use Tauri's installed `mockIPC` and event mocks in component tests.

- [x] **Step 2: Write failing reducer and guard tests**

```typescript
it("blocks start until plaintext warning is acknowledged", () => {
  expect(canStart(validDraft, false)).toBe(false);
  expect(canStart(validDraft, true)).toBe(true);
});

it("critical progress blocks the next account", () => {
  const state = reduceProgress(initialState, criticalEvent);
  expect(state.batchBlocked).toBe(true);
});
```

- [x] **Step 3: Verify frontend RED**

Run `npm.cmd test -- src/account-keeper/model.test.ts`; expect missing model exports.

- [x] **Step 4: Implement redacted types and reducer**

Define `AccountStage`, `JobStatus`, `InputValidationDto`, `TemplateValidationDto`, `AccountView`, `JobView`, revisioned `ProgressEvent`, `DraftState`, `canStart`, and `reduceProgress`. Ignore stale event revisions. Do not define account, password, current/new password, TOTP, cookie, token, authorization, DOM, response-body, or complete-URL fields in any frontend type.

- [x] **Step 5: Verify model GREEN**

Run `npm.cmd test -- src/account-keeper/model.test.ts`; expect warning, manual, critical, resume, and completion tests to pass.

- [x] **Step 6: Implement AccountKeeper component**

Use Tauri dialogs for input/output paths and pass paths to Rust without reading either file in React. Invoke input/template validation before start, require a plaintext-secret acknowledgment, and receive `confirmModal` as a prop from `App.tsx` to avoid a circular import. Subscribe before loading the initial snapshot; clean up in Strict Mode. Render Start, Pause After Current, Cancel, Continue, Mark Failed, Open Profile, keep-profile toggle, resumable jobs, and a non-dismissible critical blocker.

- [x] **Step 7: Integrate the view without overwriting dirty App changes**

Import the component/CSS, extend `Section` with `accountKeeper`, add a Windows-gated Account Keeper item immediately after Browsers, and render `<AccountKeeper confirm={confirmModal} />`. Preserve current profile-action and Android hunks in `App.tsx`; use tight context patches and no whole-file formatting.

- [x] **Step 8: Verify UI GREEN**

Run `npm.cmd test` and `npm.cmd run build`; expect tests and TypeScript/Vite build to pass.

- [x] **Step 9: Commit checkpoint intentionally skipped**

Checkpoint intentionally skipped; no commit requested.

### Task 7: Write Usage Documentation

**Files:**
- Create: `docs/account-keeper.md`
- Create: `docs/account-keeper.vn.md`
- Modify: `README.md`
- Modify: `README.vn.md`

- [x] **Step 1: Write the English guide**

Document Windows requirements, the bundled worker/runtime, the debug-only system-Node fallback, input grammar, template syntax, output schema, sequential processing, manual challenge workflow, resume/critical recovery, profile mapping, plaintext warnings, and the explicit no-token/no-CAPTCHA-bypass boundary.

- [x] **Step 2: Write the Vietnamese guide**

Mirror the English guide with Vietnamese commands and UI labels. Include synthetic examples only:

```text
owner@example.test|current-password|JBSWY3DPEHPK3PXP
```

- [x] **Step 3: Link both guides from README files**

Add a concise Account Keeper feature bullet and a Usage link without changing unrelated product copy.

- [x] **Step 4: Verify documentation**

Run `rg -n "T[B]D|T[O]DO" docs README.md README.vn.md`; expect no unfinished markers. Run the repository secret scanner separately without recording leaked credential fragments in source files or commands.

- [x] **Step 5: Commit checkpoint intentionally skipped**

Checkpoint intentionally skipped; no commit requested.

### Task 8: Run Full Verification And Manual Fixture QA

**Files:**
- Verify all changed files

- [x] **Step 1: Run focused Rust tests**

```powershell
cargo test --manifest-path src-tauri\Cargo.toml account_keeper_format::tests
cargo test --manifest-path src-tauri\Cargo.toml account_keeper_store::tests
cargo test --manifest-path src-tauri\Cargo.toml account_keeper_worker::tests
cargo test --manifest-path src-tauri\Cargo.toml account_keeper::tests
```

- [x] **Step 2: Run Node and frontend tests**

```powershell
npm.cmd test --prefix automation
npm.cmd test
```

- [x] **Step 3: Run production builds**

```powershell
npm.cmd run build
cargo check --manifest-path src-tauri\Cargo.toml
```

- [x] **Step 4: Run local synthetic workflow QA**

Run `npm.cmd run qa:account-keeper-tauri`. The script starts the fixture auth page and real BrProxies Tauri dev app with an isolated config root, imports a synthetic account, verifies Rust-generated TOTP, manual pause/continue, password change, logout/re-login, atomic output JSON, profile reuse, and resume after restarting the app. Do not use a production account.

Recorded successful evidence:

```json
{"status":"passed","manual_resume":true,"profile_reuse":true,"restart_resume":true}
```

- [x] **Step 5: Audit every acceptance criterion**

Compare current files and test output with all eleven criteria in `docs/superpowers/specs/2026-07-29-account-keeper-design.md`. Treat missing evidence as incomplete work.

- [x] **Step 6: Inspect final scope**

Run `git diff --check`, `git status --short`, and `git diff --stat`. Confirm unrelated existing modifications remain intact and are not included in Account Keeper commits.
