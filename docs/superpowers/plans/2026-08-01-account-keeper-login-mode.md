# Account Keeper Login Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Login GPT" (login-only) operation to Account Keeper that signs in and persists an authenticated profile without rotating the password, and move the default output file into the project's `output/` directory.

**Architecture:** Reuse the existing `verify_credentials` worker operation (already implemented in `automation/account-keeper-flow.mjs`) for login-only jobs. The batch carries an `operation` (`login` | `change_password`); Rust maps `login` → worker `verify_credentials`, skips password generation, and on `Verified` marks the profile a success while keeping `PasswordState::Original`. The frontend gets a mode toggle that hides Template/Output in login mode. No protocol change, no `PROTOCOL_VERSION` bump.

**Tech Stack:** Rust (axum/tokio/serde) backend, React 19 + TypeScript + Vite frontend, Node worker (unchanged). Tests: `cargo test`, `vitest`, `node --test`.

## Global Constraints

- **Security invariants unchanged** (copy verbatim from spec): path-only args; `change_password` still requires `authorize_password_change: true`; redaction, forbidden-field rejection, TOTP boundary, account masking untouched. Login mode never rotates, so it never reaches password submission.
- **No protocol shape change; do NOT bump `PROTOCOL_VERSION`.**
- `operation` is an enum string with exactly two legal values: `"login"` and `"change_password"`. Reject anything else.
- Backward compatibility: existing persisted `JobCheckpoint` files have no `operation` field — deserialize them as `"change_password"` via `#[serde(default = ...)]`.
- `#[serde(deny_unknown_fields)]` stays on `StartRequest`.
- Version bump target after implementation: **v1.0.7** (matches release cadence).
- Run `brproxies-security-auditor` agent after implementation.
- Keep bundle worker in sync: `npm run build:account-keeper-worker` (no worker source changes here, but the version stamp updates).

## File Structure

**Rust (`src-tauri/src/`):**
- `account_keeper.rs` — add `operation` to `StartRequest` + `WorkerStart` mapping; login-specific `Verified` handling; broaden managed-profile filter; add `rotated` to `ManagedProfileView`; change `default_config_for` output path; validate operation.
- `account_keeper_store.rs` — add `operation` field to `JobCheckpoint` with default.
- `account_keeper_daemon.rs` — pass `operation: "change_password"` in its two `StartRequest` constructors (daemon only rotates).
- `account_keeper_agent.rs` — pass `operation: "change_password"` in its `StartRequest` constructor (CLI only rotates).

**Frontend (`src/account-keeper/`):**
- `types.ts` — add `operation` to `DraftState`; add `rotated` to `ManagedProfileView`.
- `model.ts` — `canStart` gates by mode.
- `AccountKeeper.tsx` — mode toggle, conditional Template/Output, payload `operation`, profile badge, normalize `rotated`.
- `model.test.ts` — `canStart` login-mode tests.

---

### Task 1: Rust — `operation` on `StartRequest` + validation

**Files:**
- Modify: `src-tauri/src/account_keeper.rs` (`StartRequest` struct ~272-279; `validate_start_request` ~2219-2237)
- Modify: `src-tauri/src/account_keeper_daemon.rs` (two `StartRequest` literals: ~166-173, ~317-324)
- Modify: `src-tauri/src/account_keeper_agent.rs` (one `StartRequest` literal ~146-153)
- Test: `src-tauri/src/account_keeper.rs` (inline `mod tests`)

**Interfaces:**
- Produces: `StartRequest.operation: String` (values `"login"` | `"change_password"`); `fn account_keeper_batch_operation(request: &StartRequest) -> BatchOperation` where `enum BatchOperation { Login, ChangePassword }`.
- Consumes: nothing from later tasks.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `account_keeper.rs` (near the existing `validate_start_request` tests around line 3685):

```rust
#[test]
fn start_request_rejects_unknown_operation() {
    let request = StartRequest {
        source: InputSource::Inline { text: "a@b.test|pw|".into() },
        output_path: "C:/synthetic/result.json".into(),
        template: "Local-{random:16}".into(),
        adapter_id: "fixture-v1".into(),
        operation: "delete_account".into(),
        keep_profile_running: false,
        pause_after_current: false,
    };
    assert!(validate_start_request(&request).is_err());
}

#[test]
fn start_request_login_operation_skips_template_and_output() {
    let request = StartRequest {
        source: InputSource::Inline { text: "a@b.test|pw|".into() },
        output_path: String::new(),
        template: String::new(),
        adapter_id: "fixture-v1".into(),
        operation: "login".into(),
        keep_profile_running: false,
        pause_after_current: false,
    };
    assert!(validate_start_request(&request).is_ok());
    assert_eq!(account_keeper_batch_operation(&request), BatchOperation::Login);
}

#[test]
fn start_request_change_password_still_requires_template_and_output() {
    let request = StartRequest {
        source: InputSource::Inline { text: "a@b.test|pw|".into() },
        output_path: String::new(),
        template: "Local-{random:16}".into(),
        adapter_id: "fixture-v1".into(),
        operation: "change_password".into(),
        keep_profile_running: false,
        pause_after_current: false,
    };
    assert!(validate_start_request(&request).is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib start_request_`
Expected: FAIL — `StartRequest` has no field `operation`; `account_keeper_batch_operation` / `BatchOperation` not found.

- [ ] **Step 3: Add the field, enum, and validation**

In `StartRequest` (add field, keep `deny_unknown_fields`):

```rust
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    pub source: InputSource,
    pub output_path: String,
    pub template: String,
    pub adapter_id: String,
    #[serde(default = "default_batch_operation")]
    pub operation: String,
    pub keep_profile_running: bool,
    pub pause_after_current: bool,
}

fn default_batch_operation() -> String {
    "change_password".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchOperation {
    Login,
    ChangePassword,
}

pub(crate) fn account_keeper_batch_operation(request: &StartRequest) -> BatchOperation {
    match request.operation.as_str() {
        "login" => BatchOperation::Login,
        _ => BatchOperation::ChangePassword,
    }
}
```

Rewrite `validate_start_request` (line ~2219) so login skips template/output:

```rust
pub(crate) fn validate_start_request(request: &StartRequest) -> Result<()> {
    validate_input_source_shape(&request.source)?;
    if !matches!(request.operation.as_str(), "login" | "change_password") {
        bail!("unsupported Account Keeper operation");
    }
    if !matches!(
        request.adapter_id.as_str(),
        "fixture-v1" | "openai-chatgpt-v1"
    ) {
        bail!("unsupported Account Keeper adapter");
    }
    let operation = account_keeper_batch_operation(request);
    if operation == BatchOperation::ChangePassword {
        if request.output_path.trim().is_empty() {
            bail!("Account Keeper output path is required");
        }
        if let InputSource::File { path } = &request.source {
            if Path::new(path) == Path::new(&request.output_path) {
                bail!("Account Keeper input and output paths must differ");
            }
        }
        PasswordTemplate::parse(&request.template)?;
    } else if let InputSource::File { path } = &request.source {
        // Login mode may still specify an output path; if it does, guard the
        // same input==output collision.
        if !request.output_path.trim().is_empty()
            && Path::new(path) == Path::new(&request.output_path)
        {
            bail!("Account Keeper input and output paths must differ");
        }
    }
    Ok(())
}
```

Add `operation: "change_password".into()` to the three non-UI constructors:
- `account_keeper_daemon.rs:166` (inside `validate_start_request(&StartRequest { ... })`)
- `account_keeper_daemon.rs:317` (`start_queued_job`)
- `account_keeper_agent.rs:146`

Each literal gains the line `operation: "change_password".to_string(),` (or `.into()`) between `adapter_id` and `keep_profile_running`. Also add it to any existing `StartRequest` literal inside `account_keeper.rs` tests that now fails to compile (search for `StartRequest {` — the fixtures at ~3685, ~3697, ~3719, ~3769, ~4556, ~4597 need the field; use `"change_password".into()` unless the test is specifically a login test).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS — all account_keeper tests green (the three new ones plus the existing suite compiling with the new field).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/account_keeper.rs src-tauri/src/account_keeper_daemon.rs src-tauri/src/account_keeper_agent.rs
git commit -m "feat(account-keeper): add operation field to StartRequest with login/change_password validation"
```

---

### Task 2: Rust — persist `operation` on the checkpoint

**Files:**
- Modify: `src-tauri/src/account_keeper_store.rs` (`JobCheckpoint` struct ~65-83)
- Modify: `src-tauri/src/account_keeper.rs` (`merge_imports_and_checkpoint` return literal ~1161-1173; template-parse guard ~1098)
- Test: `src-tauri/src/account_keeper_store.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: `StartRequest.operation` (Task 1).
- Produces: `JobCheckpoint.operation: String` (defaults to `"change_password"` when absent).

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `account_keeper_store.rs`:

```rust
#[test]
fn checkpoint_without_operation_defaults_to_change_password() {
    // A checkpoint JSON persisted before the operation field existed.
    let legacy = serde_json::json!({
        "schema_version": SCHEMA_VERSION,
        "batch_id": "legacy-batch",
        "output_path": "C:/synthetic/result.json",
        "template": "Local-{random:16}",
        "adapter_id": "openai-chatgpt-v1",
        "keep_profile_running": false,
        "pause_after_current": false,
        "status": "queued",
        "updated_at": "@1",
        "accounts": []
    });
    let checkpoint: JobCheckpoint = serde_json::from_value(legacy).unwrap();
    assert_eq!(checkpoint.operation, "change_password");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib checkpoint_without_operation`
Expected: FAIL — `JobCheckpoint` has no field `operation`.

- [ ] **Step 3: Add the field with a default**

In `JobCheckpoint` (`account_keeper_store.rs`), add after `pause_after_current`:

```rust
    #[serde(default = "default_checkpoint_operation")]
    pub operation: String,
```

And add near `default_adapter_id`:

```rust
fn default_checkpoint_operation() -> String {
    "change_password".to_string()
}
```

In `merge_imports_and_checkpoint` (`account_keeper.rs`), (a) only parse the template for change-password, and (b) populate the new field. Change the top guard at line ~1098 from:

```rust
    PasswordTemplate::parse(&request.template)?;
```

to:

```rust
    if account_keeper_batch_operation(request) == BatchOperation::ChangePassword {
        PasswordTemplate::parse(&request.template)?;
    }
```

And in the returned `JobCheckpoint { ... }` literal (~1161), add:

```rust
        operation: request.operation.clone(),
```

between `pause_after_current` and `status`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/account_keeper_store.rs src-tauri/src/account_keeper.rs
git commit -m "feat(account-keeper): persist operation on job checkpoint with legacy default"
```

---

### Task 3: Rust — login worker mapping + login-only Verified

**Files:**
- Modify: `src-tauri/src/account_keeper.rs` (`run_batch` password generation ~2466; `WorkerStart` construction ~2596-2604; `Verified` event handling in the coordinator loop ~2773-2809; `apply_worker_event` Verified arm ~3414-3430; `AccountRunState::transition` Verified arm ~108-116)
- Test: `src-tauri/src/account_keeper.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: `BatchOperation` (Task 1), `JobCheckpoint.operation` (Task 2).
- Produces: login jobs reach `PasswordState::Original` + `last_status == "success"` + `last_verified_at` set on `Verified`; `apply_login_verified(state, vault, now)` helper.

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `account_keeper.rs`:

```rust
#[test]
fn login_verified_marks_success_without_rotating_password() {
    let mut state = AccountRunState::new("account-key");
    // Simulate a login flow that has reached the verification stage.
    state.stage = AccountStage::VerifyingNewPassword;
    let mut vault = VaultAccount {
        account_key: "account-key".into(),
        account: "owner@example.test".into(),
        current_password: "current-password".into(),
        pending_password: None,
        totp_secret: None,
        profile_id: "profile-login".into(),
        password_state: PasswordState::Original,
        last_verified_at: None,
        last_job_id: Some("batch-login".into()),
        last_status: Some("running".into()),
    };
    apply_login_verified(&mut state, &mut vault, "2026-08-01T00:00:00Z").unwrap();
    assert_eq!(state.stage, AccountStage::Success);
    assert_eq!(vault.password_state, PasswordState::Original);
    assert_eq!(vault.current_password, "current-password");
    assert!(vault.pending_password.is_none());
    assert_eq!(vault.last_status.as_deref(), Some("success"));
    assert_eq!(vault.last_verified_at.as_deref(), Some("2026-08-01T00:00:00Z"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib login_verified_marks_success`
Expected: FAIL — `apply_login_verified` not found.

- [ ] **Step 3: Add the login-verified transition, helper, and wiring**

(a) Add a login-verified stage transition to `AccountRunState`. In `AccountRunState::transition` add a new event arm — first extend the `AccountEvent` enum (line ~56) with `LoginVerified`:

```rust
    Verified,
    LoginVerified,
    Failed,
```

Then in `transition` (after the `Verified` arm ~108-116):

```rust
            AccountEvent::LoginVerified => {
                if !is_verification_stage(self.stage) {
                    bail!("Account Keeper login verified event arrived outside verification state");
                }
                self.stage = AccountStage::Success;
                // Login mode does not rotate — password stays Original.
            }
```

(b) Add the helper near `apply_worker_event` (~3379):

```rust
/// Login-only success: the account signed in with its existing credentials.
/// Marks the profile a verified success WITHOUT rotating — password_state stays
/// Original. Separate from the rotation `Verified` path, which asserts a pending
/// password and moves to Changed.
pub fn apply_login_verified(
    state: &mut AccountRunState,
    vault: &mut VaultAccount,
    now: &str,
) -> Result<()> {
    state.transition(AccountEvent::LoginVerified)?;
    vault.pending_password = None;
    vault.password_state = PasswordState::Original;
    vault.last_verified_at = Some(now.to_string());
    vault.last_status = Some("success".to_string());
    Ok(())
}
```

(c) In `run_batch` (~2466), only generate a password for change-password jobs:

```rust
            let pending_password = if checkpoint.operation == "login" {
                String::new()
            } else {
                template.generate(&mut random, &mut used_passwords)?
            };
```

Note: `template` is parsed at `run_batch` top (~2412). Guard that parse the same way so a login job with an empty template does not fail:

```rust
        let template = if checkpoint.operation == "login" {
            None
        } else {
            Some(PasswordTemplate::parse(&checkpoint.template)?)
        };
```

and change the generate call to `template.as_ref().expect("change_password requires template").generate(...)` inside the else branch. (Only the change-password branch touches `template`, so the `expect` is unreachable for login.)

(d) In the `WorkerStart` construction (~2596), map the operation:

```rust
            let worker_operation = if checkpoint.operation == "login" {
                "verify_credentials"
            } else {
                "change_password"
            };
            let start = WorkerStart {
                request_id,
                operation: worker_operation.to_string(),
                adapter_id: checkpoint.adapter_id.clone(),
                cdp_endpoint,
                account: vault.accounts[vault_index].account.clone(),
                current_password: vault.accounts[vault_index].current_password.clone(),
                new_password: pending_password.to_string(),
            };
```

(e) In the coordinator's `WorkerEvent::Verified` arm (~2773), branch on operation. Replace the single `apply_worker_event(... WorkerEvent::Verified ...)` call with:

```rust
                            WorkerEvent::Verified => {
                                if checkpoint.operation == "login" {
                                    apply_login_verified(
                                        &mut state,
                                        &mut vault.accounts[vault_index],
                                        &self.clock.now(),
                                    )?;
                                } else {
                                    apply_worker_event(
                                        &mut state,
                                        &mut vault.accounts[vault_index],
                                        pending_password,
                                        WorkerEvent::Verified,
                                        &self.clock.now(),
                                    )?;
                                }
                                label_account_profile(
                                    self.profiles.as_ref(),
                                    &vault.accounts[vault_index],
                                );
                                checkpoint.status = "running".to_string();
                                record_account_state(
                                    checkpoint,
                                    account_index,
                                    &state,
                                    None,
                                    &self.clock.now(),
                                );
                                persist_snapshot(
                                    checkpoint,
                                    vault,
                                    self.clock.as_ref(),
                                    self.events.as_ref(),
                                )?;
                                if !checkpoint.output_path.trim().is_empty() {
                                    let output = build_output(checkpoint, vault, &self.clock.now())?;
                                    crate::account_keeper_store::write_output(Path::new(&checkpoint.output_path), &output)?;
                                }
                                let _ = session.finish().await;
                                stop_profile_unless_kept(
                                    self.profiles.as_ref(),
                                    &profile_id,
                                    checkpoint.keep_profile_running,
                                ).await;
                                return Ok(AccountOutcome::Success);
                            }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/account_keeper.rs
git commit -m "feat(account-keeper): login jobs verify without rotating, keeping password Original"
```

---

### Task 4: Rust — managed-profile filter + `rotated` flag + output default

**Files:**
- Modify: `src-tauri/src/account_keeper.rs` (`ManagedProfileView` struct ~686-693; managed-profile builder filter+map ~3342-3368; `default_config_for` ~1060-1072; the `defaults_use_valid_template_and_documents_output_path` test ~3500 and `defaults_reject_non_unicode_output_path` ~3519)
- Test: `src-tauri/src/account_keeper.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: login-verified vault accounts (Task 3).
- Produces: `ManagedProfileView.rotated: bool`; `default_config_for` returns `<cwd>/output/account-keeper-result.json`.

- [ ] **Step 1: Write the failing tests**

Find the existing managed-profile test (search `list_managed_profiles` or the function that builds `Vec<ManagedProfileView>` — the builder is near line 3342; there is a test constructing a vault with `PasswordState::Changed` accounts around 3871/3947). Add:

```rust
#[test]
fn managed_profiles_include_login_only_with_rotated_false() {
    let vault = VaultFile {
        schema_version: SCHEMA_VERSION,
        accounts: vec![
            VaultAccount {
                account_key: "rotated-key".into(),
                account: "rot@example.test".into(),
                current_password: "new".into(),
                pending_password: None,
                totp_secret: None,
                profile_id: "profile-rotated".into(),
                password_state: PasswordState::Changed,
                last_verified_at: Some("2026-08-01T02:00:00Z".into()),
                last_job_id: None,
                last_status: Some("success".into()),
            },
            VaultAccount {
                account_key: "login-key".into(),
                account: "log@example.test".into(),
                current_password: "current".into(),
                pending_password: None,
                totp_secret: None,
                profile_id: "profile-login".into(),
                password_state: PasswordState::Original,
                last_verified_at: Some("2026-08-01T01:00:00Z".into()),
                last_job_id: None,
                last_status: Some("success".into()),
            },
        ],
    };
    let running: HashSet<String> = HashSet::new();
    let profiles = build_managed_profiles(&vault, &running, "http://127.0.0.1:40325/");
    assert_eq!(profiles.len(), 2);
    let login = profiles.iter().find(|p| p.profile_id == "profile-login").unwrap();
    assert!(!login.rotated);
    let rotated = profiles.iter().find(|p| p.profile_id == "profile-rotated").unwrap();
    assert!(rotated.rotated);
}

#[test]
fn defaults_output_path_is_in_project_output_dir() {
    let defaults = account_keeper_defaults().unwrap();
    assert!(
        defaults.output_path.replace('\\', "/").ends_with("/output/account-keeper-result.json"),
        "unexpected output path: {}",
        defaults.output_path
    );
}
```

Note: confirm the real name/signature of the managed-profile builder (the function ending at line 3377). If it is not `build_managed_profiles(vault, running, api_base_url)`, adjust the call in the test to match the real name and argument order shown in the source you are editing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib managed_profiles_include_login defaults_output_path_is_in_project`
Expected: FAIL — `rotated` field missing; output path still under Documents.

- [ ] **Step 3: Add `rotated`, broaden the filter, change the default path**

(a) In `ManagedProfileView` (~686), add:

```rust
    pub rotated: bool,
```

(b) In the managed-profile builder (~3346), broaden the filter and set `rotated`:

```rust
        .filter(|account| {
            account.last_status.as_deref() == Some("success")
                && account.last_verified_at.is_some()
        })
        .map(|account| {
            let last_verified_at = account.last_verified_at.clone();
            ManagedProfileView {
                profile_id: account.profile_id.clone(),
                masked_account: mask_account(&account.account),
                status: "success".to_string(),
                rotated: account.password_state == PasswordState::Changed,
                last_verified_at: last_verified_at.clone(),
                running: running.contains(&account.profile_id),
                import_payload: ManagedProfileImportPayload {
                    // ... unchanged ...
                },
            }
        })
```

(c) Rewrite `default_config_for` (~1060) to resolve the project `output/` dir, falling back to the passed directory only via the public wrapper. Change the wrapper `account_keeper_defaults` (~1322) to prefer `current_dir()`:

```rust
fn default_config_for(base_dir: &Path) -> Result<AccountKeeperDefaultsDto> {
    let template = "BrP@{random:16}!".to_string();
    validate_template_value(&template)?;
    let output_path = base_dir.join("output").join("account-keeper-result.json");
    let output_path = output_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Account Keeper output path is not valid Unicode"))?
        .to_owned();
    Ok(AccountKeeperDefaultsDto { template, output_path })
}
```

```rust
pub fn account_keeper_defaults() -> std::result::Result<AccountKeeperDefaultsDto, String> {
    let base_dir = std::env::current_dir()
        .ok()
        .or_else(dirs::document_dir)
        .ok_or_else(|| "Account Keeper base directory is not available".to_string())?;
    default_config_for(&base_dir).map_err(|error| error.to_string())
}
```

(d) Fix the two existing defaults tests (~3500, ~3519) that assert the Documents path. Update `defaults_use_valid_template_and_documents_output_path` to expect `<base>/output/account-keeper-result.json`:

```rust
    let expected_output_path = document_dir.join("output").join("account-keeper-result.json");
```

The non-Unicode test (~3519) still passes a non-Unicode dir into `default_config_for` and expects an error — `join("output").join(...)` on a non-Unicode base is still non-Unicode, so the assertion holds; no change needed unless it fails to compile.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/account_keeper.rs
git commit -m "feat(account-keeper): surface login profiles with rotated flag, default output to project output/"
```

---

### Task 5: Frontend — types + `canStart` mode gating

**Files:**
- Modify: `src/account-keeper/types.ts` (`DraftState` ~104-116; `ManagedProfileView` ~95-102)
- Modify: `src/account-keeper/model.ts` (`canStart` ~41-52)
- Test: `src/account-keeper/model.test.ts`

**Interfaces:**
- Consumes: nothing from later tasks.
- Produces: `DraftState.operation: "login" | "change_password"`; `ManagedProfileView.rotated: boolean`; `canStart` accepts login drafts without template/output.

- [ ] **Step 1: Write the failing tests**

Add to `model.test.ts` (after the existing `canStart` describe block):

```ts
describe("canStart operation modes", () => {
  const loginDraft: DraftState = {
    ...validDraft,
    operation: "login",
    outputPath: "",
    templateText: "",
    templateValidation: null,
  };

  it("allows a login draft with no template or output", () => {
    expect(canStart(loginDraft, [])).toBe(true);
  });

  it("still requires template and output for change_password", () => {
    const changeDraft: DraftState = {
      ...validDraft,
      operation: "change_password",
      outputPath: "",
    };
    expect(canStart(changeDraft, [])).toBe(false);
  });

  it("login draft still requires valid input and acknowledgement", () => {
    expect(canStart({ ...loginDraft, plaintextAcknowledged: false }, [])).toBe(false);
    expect(canStart({ ...loginDraft, inputValidation: null }, [])).toBe(false);
  });
});
```

Also add `operation: "change_password",` to the shared `validDraft` literal (~19) and `rotated: false,` is NOT on drafts — it's on `ManagedProfileView`; update the profile fixture used by `profileImportJson` tests if it constructs `ManagedProfileView` (search `import_payload:` in the test file) to include `rotated: false`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/account-keeper/model.test.ts`
Expected: FAIL — `operation`/`rotated` not on the types; `canStart` returns false for login draft.

- [ ] **Step 3: Update types and `canStart`**

In `types.ts`, add to `DraftState`:

```ts
  operation: "login" | "change_password";
```

and to `ManagedProfileView`:

```ts
  rotated: boolean;
```

In `model.ts`, rewrite `canStart`:

```ts
export function canStart(draft: DraftState, jobs: readonly JobView[]): boolean {
  const source = activeInputSource(draft);
  const hasActiveInput = source.kind === "inline"
    ? source.text.trim().length > 0
    : source.path.trim().length > 0;
  if (!hasActiveInput) return false;
  if (!draft.plaintextAcknowledged) return false;
  if (!draft.inputValidation || draft.inputValidation.validCount < 1) return false;
  if (draft.inputValidationRevision !== draft.inputRevision) return false;
  if (draft.operation === "change_password") {
    if (!draft.outputPath.trim()) return false;
    if (!draft.templateValidation?.valid) return false;
  }
  return !jobs.some((job) => job.batchBlocked || !terminalJobStatuses.has(job.status));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/account-keeper/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/account-keeper/types.ts src/account-keeper/model.ts src/account-keeper/model.test.ts
git commit -m "feat(account-keeper): gate canStart by operation, add operation/rotated to types"
```

---

### Task 6: Frontend — mode toggle, conditional fields, payload, profile badge

**Files:**
- Modify: `src/account-keeper/AccountKeeper.tsx` (`initialDraft` ~53-65; `normalizeManagedProfile` ~212-234; `startBatch` payload ~644-657; the Batch setup panel JSX ~962-1188; the Profiles panel JSX ~1363-1406)
- Modify: `src/account-keeper/AccountKeeper.css` (add badge/toggle styles as needed — reuse existing `account-keeper__source-modes` styling for the mode toggle)
- Test: covered by `AccountKeeper.test.tsx` smoke (extend if it asserts panel fields)

**Interfaces:**
- Consumes: `DraftState.operation`, `ManagedProfileView.rotated` (Task 5).
- Produces: UI wiring only.

- [ ] **Step 1: Add `operation` to `initialDraft` and normalize `rotated`**

In `initialDraft` (~53):

```ts
  operation: "change_password",
```

In `normalizeManagedProfile` (~226 return), add:

```ts
    rotated: asBoolean(record?.rotated),
```

- [ ] **Step 2: Add the mode toggle at the top of Batch setup**

Immediately after the panel-head `</div>` in the Batch setup section (before the Input source field ~971), insert a mode toggle mirroring the source-modes markup:

```tsx
          <div className="account-keeper__field">
            <span className="account-keeper__field-label">Operation</span>
            <div className="account-keeper__source-modes" role="group" aria-label="Operation">
              {([
                ["change_password", "Change pass"],
                ["login", "Login GPT"],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={draft.operation === mode}
                  onClick={() => setDraft((current) => current.operation === mode
                    ? current
                    : { ...current, operation: mode })}
                  disabled={busyAction !== null}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
```

- [ ] **Step 3: Hide Template and Output in login mode**

Wrap the Template field block (~1068-1110) and the Output file field block (~1112-1134) each in `{draft.operation === "change_password" && ( ... )}`. Leave the "Keep profile running" and plaintext-acknowledgement blocks visible in both modes.

- [ ] **Step 4: Mode-aware primary button label and payload**

Change the Start button label (~1168-1170):

```tsx
            <button type="button" className="btn-primary" onClick={() => void startBatch()} disabled={!startEnabled}>
              {draft.operation === "login" ? "Login & Save Profile" : "Start Batch"}
            </button>
```

In `startBatch` (~644), add `operation` to the payload and send empty template/output for login:

```tsx
      {
        request: {
          source: activeInputSource(draft),
          outputPath: draft.operation === "login" ? "" : draft.outputPath,
          template: draft.operation === "login" ? "" : draft.templateText,
          adapterId: qaAdapterId.current,
          operation: draft.operation,
          keepProfileRunning: draft.keepProfileRunning,
          pauseAfterCurrent: false,
        },
      },
```

- [ ] **Step 5: Add the profile badge**

In the Profiles panel, in each profile article (~1366-1369), add a badge after the status span:

```tsx
                    <span className={`account-keeper__status is-${profile.status}`}>{labelFor(profile.status)}</span>
                    <span className={`account-keeper__badge ${profile.rotated ? "is-rotated" : "is-login"}`}>
                      {profile.rotated ? "Rotated" : "Logged in"}
                    </span>
```

Add minimal CSS to `AccountKeeper.css` for `.account-keeper__badge` (reuse the visual language of `.account-keeper__status`; a small pill). Example:

```css
.account-keeper__badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.7rem;
  margin-left: 0.4rem;
}
.account-keeper__badge.is-rotated { background: rgba(129, 140, 248, 0.18); color: #a5b4fc; }
.account-keeper__badge.is-login { background: rgba(52, 211, 153, 0.15); color: #6ee7b7; }
```

- [ ] **Step 6: Run frontend tests + typecheck**

Run: `npx vitest run src/account-keeper/`
Expected: PASS.

Run: `npm run build` (tsc + vite) — or at minimum `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/account-keeper/AccountKeeper.tsx src/account-keeper/AccountKeeper.css
git commit -m "feat(account-keeper): Login GPT mode toggle, conditional fields, profile badge"
```

---

### Task 7: Full verification, security audit, version bump, bundle sync

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (version 1.0.6 → 1.0.7)

- [ ] **Step 1: Run the full Rust suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS (all account_keeper tests).

- [ ] **Step 2: Run the full automation + frontend suites**

Run: `cd automation && npm test` → Expected: PASS (90/90 or more).
Run: `npx vitest run` → Expected: PASS.

- [ ] **Step 3: Security audit**

Dispatch the `brproxies-security-auditor` agent over the changed files. Confirm no invariant regressed (path-only args, authorization gate on change_password, redaction, forbidden fields, TOTP boundary, masking). Address any finding before proceeding.

- [ ] **Step 4: Bump version to 1.0.7**

Edit `package.json`, `src-tauri/tauri.conf.json` `version` to `1.0.7`; `src-tauri/Cargo.toml` `version = "1.0.7"`. Cargo.lock updates on next build.

- [ ] **Step 5: Rebuild worker bundle + Rust lib**

Run: `npm run build:account-keeper-worker` → Expected: "Prepared Account Keeper resources".
Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib` → Expected: clean (updates Cargo.lock to 1.0.7).

- [ ] **Step 6: Commit the release**

```bash
git add -A
git commit -m "Release v1.0.7: Account Keeper Login GPT mode + in-project output default"
```

---

## Self-Review

**Spec coverage:**
- Login-only operation → Tasks 1-3 (StartRequest field, checkpoint persistence, worker mapping + login Verified).
- Login profiles in Profiles panel with badge → Task 4 (filter + `rotated`) + Task 6 (badge UI).
- Output default in project `output/` → Task 4 (`default_config_for`).
- Frontend toggle hides Template/Output → Task 6; `canStart` gating → Task 5.
- Security invariants unchanged → Task 7 audit; login never rotates so no gate weakening (enforced by not generating a password and not calling submitPasswordChange — the `verify_credentials` flow has no password-submit step).
- No protocol change / no version bump → confirmed (worker untouched; `operation` already in `WorkerStart`).
- Backward-compatible checkpoint → Task 2 (`#[serde(default)]`).
- Version bump v1.0.7 → Task 7.

**Placeholder scan:** No TBD/TODO; every code step shows concrete code. One explicit verify note in Task 4 Step 1 asks the implementer to confirm the managed-profile builder's real signature before finalizing the test call — this is a correctness safeguard, not a placeholder, because the exact fn name is at line ~3342 and must match.

**Type consistency:** `BatchOperation` (Task 1) used in Tasks 2-3; `apply_login_verified` (Task 3) matches its test; `ManagedProfileView.rotated` (Task 4 Rust) mirrors `ManagedProfileView.rotated` (Task 5 TS) and normalized in Task 6; `DraftState.operation` values `"login"|"change_password"` consistent across Tasks 5-6 and the Rust validation in Task 1.
